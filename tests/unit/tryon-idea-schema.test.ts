import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for TRYON-IDEA1 (20261011090000). The integration and security jobs prove the behaviour; these checks keep the
// replaced claim equal to the reviewed BUDGET1 body plus only the named edits, and keep the rest of try-on untouched.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261011090000_tryon_idea.sql';
const BUDGET = '20261010090000_shared_ai_budget.sql';
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');
const body = (sql: string, head: string) => {
  const from = sql.indexOf(head);
  expect(from, head).toBeGreaterThan(-1);
  expect(sql.indexOf(head, from + 1), head).toBe(-1);
  const to = sql.indexOf('\n$$;', from);
  expect(to, head).toBeGreaterThan(from);
  return sql.slice(from, to + 4);
};
const once = (text: string, from: string, to: string) => {
  expect(text.split(from).length - 1, from).toBe(1);
  return text.replace(from, to);
};

const EDITS: [string, string][] = [
  ['create function public.tryon_claim(', 'create or replace function public.tryon_claim('],
  ['  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid,p_item_ids uuid[] default null) returns jsonb',
    '  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid) returns jsonb'],
  [`    or (t.chain_id is null and p_step<>1)
    or (p_step=1 and (p_outfit_id is null) = (p_item_ids is null))
    or (p_step=1 and t.chain_id is not null and (p_outfit_id is distinct from t.outfit_id
      or p_item_ids is distinct from t.idea_item_ids))
    or (p_step>1 and (p_item_ids is not null or (p_outfit_id is not null and p_outfit_id is distinct from t.outfit_id)))
    or (p_item_ids is not null and (coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 8
      or array_position(p_item_ids,null) is not null
      or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids))) then
`, `    or (t.chain_id is null and (p_step<>1 or p_outfit_id is null))
    or (t.chain_id is not null and p_outfit_id is not null and p_outfit_id<>t.outfit_id) then
`],
  [`    if p_item_ids is null then
      if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
    else
      if (select count(*) from public.items where owner_id=p.owner_id and id=any(p_item_ids))<>cardinality(p_item_ids) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_idea_steps(p.owner_id,p_item_ids);
    end if;
`, `    if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
      return jsonb_build_object('code','NOT_FOUND','claimed',false);
    end if;
    v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
`],
  [`    insert into private.tryon_chains(owner_id,chain_id,outfit_id,idea_item_ids,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,p_item_ids,v_steps,`, `    insert into private.tryon_chains(owner_id,chain_id,outfit_id,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,v_steps,`],
];

describe('try-on idea migration (TRYON-IDEA1)', () => {
  it('is one LF transaction directly after the shared budget migration and replaces only the claim and the two reads', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-IDEA1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    const at = names.indexOf(MAIN);
    expect(at).toBeGreaterThan(0);
    expect(names[at - 1]).toBe(BUDGET);
    expect([...code(sql).matchAll(/create (?:or replace )?function ([a-z0-9_.]+)\(/g)].map((match) => match[1]))
      .toEqual(['private.tryon_select_idea_steps', 'private.tryon_results_contract', 'public.tryon_results_v1',
        'public.tryon_result_image_v1', 'public.tryon_claim']);
    // The claim is the only dropped function, and it is dropped restrict; nothing is granted to the API roles.
    expect([...code(sql).matchAll(/\bdrop\s+function\s+([^;]+);/gi)].map((match) => match[1]))
      .toEqual(['public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid) restrict']);
    expect(sql).not.toMatch(/grant execute[^;]*\sto\s[^;]*\b(?:anon|authenticated|public)\b/i);
    expect(sql).toContain('grant execute on function public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[]) to service_role;');
    expect(sql).toContain('revoke all on function private.tryon_select_idea_steps(uuid,uuid[]) from public,anon,authenticated,service_role;');
    expect(sql).not.toMatch(/create table/i);
  });

  it('makes the outfit optional and gives an idea chain its own identity, without touching existing rows', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain('alter table private.tryon_chains alter column outfit_id drop not null;');
    expect(sql).toContain('alter table private.tryon_results alter column outfit_id drop not null;');
    expect(sql).toContain('add column idea_item_ids uuid[]');
    expect(sql).toContain('check ((outfit_id is null) = (idea_item_ids is not null)');
    // Outside function bodies and DO blocks, no existing try-on row is rewritten.
    const statements = code(sql).replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(statements).not.toMatch(/\b(?:update|delete)\b[^;]*private\.tryon_/i);
    // The outfit keys and their cascade are the originals: only the not-null requirement goes.
    expect(statements).not.toMatch(/foreign key|references public\.outfits/i);
  });

  it('keeps the claim equal to the BUDGET1 body plus only the idea edits', async () => {
    const sql = await read(MAIN);
    let restored = body(sql, 'create function public.tryon_claim(');
    for (const [now, before] of EDITS) restored = once(restored, now, before);
    expect(restored).toBe(body(await read(BUDGET), 'create or replace function public.tryon_claim('));
  });

  it('selects an idea like an outfit, in the listed order, from this owner\'s own items only', async () => {
    const helper = body(await read(MAIN), 'create function private.tryon_select_idea_steps(');
    expect(helper).toContain('from unnest(p_items) with ordinality u(id,n) join public.items i on i.owner_id=p_owner and i.id=u.id');
    expect(helper).toContain("i.category=s.slot and i.lifecycle='active' and i.deleted_at is null");
    expect(helper).toContain('order by u.n limit 1');
    expect(helper).toContain("v_slots := array['one_piece','footwear'];");
    expect(helper).toContain("v_slots := array['top','bottom','footwear'];");
    expect(helper).not.toMatch(/outfit/);
  });

  it('returns a result without an outfit only to a request that opts in, so an older cached client keeps its list', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain(`->>'x-stillroom-tryon-results-contract','')='2'`);
    expect(sql).toContain('revoke all on function private.tryon_results_contract() from public,anon,authenticated,service_role;');
    for (const name of ['tryon_results_v1', 'tryon_result_image_v1']) {
      const text = body(sql, `create or replace function public.${name}(`);
      expect(text, name).toContain('v_ideas boolean := private.tryon_results_contract();');
      expect(text, name).toContain('((r.outfit_id is null and v_ideas) or exists(select 1 from public.outfits o where o.owner_id=r.owner_id');
      expect(text, name).toContain('o.deleted_at is null');
      expect(text, name).toContain('r.owner_id=auth.uid()');
      expect(text, name).toContain("r.state='ready' and r.expires_at>v_now");
      expect(text, name).toContain('language plpgsql stable security definer set search_path');
    }
    // Deleting by id is not header-gated: the delete function is not replaced.
    expect(code(sql)).not.toContain('tryon_delete_result');
  });

  it('keeps the claim identity rules: one subject on step 1, both fields compared on a retry, neither after step 1', async () => {
    const claim = body(await read(MAIN), 'create function public.tryon_claim(');
    expect(claim).toContain('(p_step=1 and (p_outfit_id is null) = (p_item_ids is null))');
    expect(claim).toContain('(p_step=1 and t.chain_id is not null and (p_outfit_id is distinct from t.outfit_id\n      or p_item_ids is distinct from t.idea_item_ids))');
    expect(claim).toContain('(p_step>1 and (p_item_ids is not null or (p_outfit_id is not null and p_outfit_id is distinct from t.outfit_id)))');
    // One money implementation: the budget precheck, per-step re-check and holds are the single shared body.
    expect(claim.match(/private\.ai_budget_used\(/g)).toHaveLength(1);
    expect(claim.match(/insert into private\.ai_usage\(/g)).toHaveLength(1);
  });

  it('checks its postconditions and keeps the old signature from surviving', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain("to_regprocedure('public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)') is not null");
    expect(sql).toContain("pg_get_expr(p.proargdefaults,0) is distinct from 'NULL::uuid[]'");
    expect(sql).toContain("(select count(*) from pg_catalog.pg_proc where proname='tryon_claim' and pronamespace='public'::regnamespace)<>1");
    expect(sql).toContain("perform set_config('tryon_idea.claim_owner',p.proowner::regrole::text,true);");
    expect(sql).toContain("p.proowner::regrole::text is distinct from current_setting('tryon_idea.claim_owner')");
    expect(sql).toContain('has_function_privilege(\'anon\',f,\'EXECUTE\') or has_function_privilege(\'authenticated\',f,\'EXECUTE\')');
    expect(sql).toContain("conname='tryon_chains_idea_items' and convalidated");
    expect(sql).toContain('TRYON-IDEA1 precondition');
    expect(sql).toContain('TRYON-IDEA1 postcondition');
  });
});
