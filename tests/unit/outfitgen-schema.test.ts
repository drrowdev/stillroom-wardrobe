import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const body = (sql: string, header: RegExp) => {
  const start = sql.search(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start), close = sql.indexOf('$$', open + 2);
  // The last existence test closes the statement; ignore that terminator so appended tests compare cleanly.
  return sql.slice(open + 2, close).split('\n').map((line) => line.trim().replace(/\)\);$/, ')')).filter(Boolean);
};
// Every old line stays, in order; whatever was added is returned.
const additions = (before: string[], after: string[]) => {
  const added: string[] = [];
  let index = 0;
  for (const line of after) { if (before[index] === line) index++; else added.push(line); }
  expect(index).toBe(before.length);
  return added;
};

describe('outfit generation migration (source proofs; the SQL itself runs in the CI rehearsal)', () => {
  it('is additive except for three named replacements, and replaces each with its latest body plus additions only', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    expect([...sql.matchAll(/create or replace function ([a-z0-9_.]+)\(/g)].map((match) => match[1])).toEqual(['private.admin_account_v3', 'private.deletion_owner_rows_absent']);
    const guard = additions(body(await read('20261011100000_tryon_person_photo.sql'), /create or replace function private\.deletion_owner_rows_absent/),
      body(sql, /create or replace function private\.deletion_owner_rows_absent/));
    expect(guard).toEqual(['or exists(select 1 from public.suggested_outfits where owner_id=p_owner)',
      'or exists(select 1 from private.outfit_assessed_items where owner_id=p_owner)',
      'or exists(select 1 from private.outfitgen_requests where owner_id=p_owner)']);
    const admin = body(sql, /create or replace function private\.admin_account_v3/);
    const old = body(await read('20261010090000_shared_ai_budget.sql'), /create function private\.admin_account_v3/);
    expect(additions(old, admin).join(' ')).toMatch(/outfitGen[\s\S]*outfitgen[\s\S]*outfitGen/);
    expect(additions(old, admin).join(' ')).not.toMatch(/tryOn|stylist|enhancement/);
  });

  it('adds the purpose, the controls, the immutable manifest and no activation, consent or usage row', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    expect(sql).toContain("check (purpose in ('analysis','stylist','enhancement','try_on','outfitgen'))");
    expect(sql).toContain('add column outfitgen_activated boolean not null default false');
    expect(sql).toContain("'azure-eu-terra-outfitgen-v1','gpt-5.6-terra-2026-07-09',1,");
    expect(sql).not.toMatch(/insert into private\.ai_controls\b/);
    expect(sql).not.toMatch(/update private\.ai_controls set outfitgen_activated=true/);
    expect(sql).not.toMatch(/pg_cron|cron\./);
  });

  it('keeps suggestions read-only for the owner and every write behind a definer function', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    expect(sql).toContain('alter table public.suggested_outfits enable row level security;');
    expect(sql).toContain('grant select on public.suggested_outfits to authenticated;');
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*suggested_outfits/);
    expect(sql).toContain('private.is_approved() and owner_id=(select auth.uid())');
    expect(sql).toContain('foreign key(owner_id,kept_outfit_id) references public.outfits(owner_id,id) on delete set null(kept_outfit_id)');
    expect(sql).toContain('foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade');
    expect(sql).toContain('owner_id uuid not null references public.profiles(owner_id) on delete cascade');
    for (const table of ['private.outfit_assessed_items', 'private.outfitgen_requests']) expect(sql).toContain(`alter table ${table} enable row level security;`);
    expect(sql).toContain('grant execute on function public.outfitgen_status(),public.outfitgen_set_consent(boolean,integer),public.outfitgen_list(),');
    expect(sql).toContain('grant execute on function public.outfitgen_plan(uuid),public.outfitgen_assess(uuid,uuid[]),');
    expect(sql).not.toMatch(/grant execute on function public\.outfitgen_(plan|claim|finish|assess|expire_due)[^;]*to authenticated/);
    expect(sql).toMatch(/revoke all on function public\.outfitgen_status\(\)[\s\S]*outfitgen_expire_due\(integer\) from public,anon,authenticated,service_role;/);
  });

  it('serialises one live batch per owner, freezes the claimed signatures and caps pending suggestions across the whole batch', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    expect(sql).toContain("and dispatched_at>v_now-interval '6 minutes') then return jsonb_build_object('code','BUSY','claimed',false); end if;");
    expect(sql).toContain('insert into private.outfitgen_requests(owner_id,request_id,mode,signatures,target_items)');
    expect(sql).toContain('select 40-count(*) into v_room from public.suggested_outfits');
    expect(sql).toContain('if v_room<=0 then continue; end if;');
    expect(sql).toContain('if not v_sig=any(q.signatures) or v_sig=any(v_seen) then continue; end if;');
    expect(sql).toContain("exception when others then null;");
  });

  it('keeps accounting out of reach of suggestion failures and never frees an uncertain charge', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    const finish = sql.slice(sql.indexOf('create function public.outfitgen_finish'), sql.indexOf('-- Owner list'));
    expect(finish).toContain('v_recorded := private.outfitgen_record(p_owner_id,p_request_id,p_results,p_assessed,m);');
    expect(finish).toMatch(/exception when others then\s+v_recorded := jsonb_build_object\('suggested',0,'declined',0,'assessed',0,'failed',true\);/);
    expect(finish).not.toContain("charge_state='released'");
    expect(finish).not.toContain('accounted_micro=0');
    // A FAILED or FILTERED reply with no usable metering keeps the reservation and leaves the feature on.
    const unmetered = finish.slice(finish.indexOf('if p_usage is null then'), finish.indexOf('select * into m from'));
    expect(unmetered).toContain("closed_reason='FAILED'");
    expect(unmetered).not.toContain('outfitgen_activated=false');
    expect(finish).toContain('update private.ai_controls set outfitgen_activated=false');
  });

  it('rechecks eligibility, bans and duplicates before Keep creates the outfit, and Undo restores only an unchanged vote', async () => {
    const sql = await read('20261106090000_outfit_generation.sql');
    const keep = sql.slice(sql.indexOf('create function public.outfitgen_keep'), sql.indexOf('-- Remove: permanent'));
    expect(keep.indexOf('outfitgen_valid_set')).toBeGreaterThan(0);
    expect(keep.indexOf('outfitgen_valid_set')).toBeLessThan(keep.indexOf('public.save_outfit('));
    expect(keep.indexOf('outfitgen_signature(array(')).toBeLessThan(keep.indexOf('public.save_outfit('));
    const undo = sql.slice(sql.indexOf('create function public.outfitgen_undo_remove'));
    expect(undo).toContain('f.vote=-1 and f.created_at is not distinct from s.vote_set_at');
    const valid = sql.slice(sql.indexOf('create function private.outfitgen_valid_set'), sql.indexOf('-- Already judged'));
    for (const rule of ['public.combination_rules', 'public.suggestion_feedback', 'c.f=1', 'outfitgen_eligible']) expect(valid).toContain(rule);
  });

  it('keeps the schedule migration inactive and names the job', async () => {
    const sql = await read('20261106090100_outfitgen_expire_schedule.sql');
    expect(sql).toContain("'stillroom-outfitgen-expire', '*/5 * * * *', 'select public.outfitgen_expire_due(500)'");
    expect(sql).toContain('active := false');
  });
});
