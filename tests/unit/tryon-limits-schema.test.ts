import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// TRYON-LIMITS1 source pins: six garments, results kept until deleted, the v2 manifest and notice revision 3. The CI preservation
// and security jobs prove the migration applies and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261101200000_tryon_limits.sql';
const V1 = "'azure-global-image25-sunburst-tryon-v1'";
const V2 = "'azure-global-image25-sunburst-tryon-v2'";

const fn = (sql: string, name: string) => {
  const match = new RegExp(`^create (or replace )?function ${name.replace('.', '\\.')}\\(`, 'm').exec(sql);
  expect(match, name).not.toBeNull();
  const from = match!.index;
  const to = sql.indexOf('\n$$;', from);
  expect(to, name).toBeGreaterThan(from);
  return sql.slice(from, to + 4).replace('create or replace function', 'create function');
};
// The lines that differ between two bodies (as multisets of trimmed lines).
const changed = (before: string, after: string) => {
  const count = (text: string) => {
    const lines = new Map<string, number>();
    for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) lines.set(line, (lines.get(line) ?? 0) + 1);
    return lines;
  };
  const a = count(before), b = count(after);
  const side = (from: Map<string, number>, other: Map<string, number>) => [...from].flatMap(([line, n]) => Array(Math.max(0, n - (other.get(line) ?? 0))).fill(line) as string[]);
  return { removed: side(a, b), added: side(b, a) };
};

// Every replaced function: its previous latest definition and the only line changes the migration may make to it.
const REPLACED: { fn: string; from: string; allowed: RegExp }[] = [
  { fn: 'private.tryon_select_steps', from: '20261003090000_try_on.sql', allowed: /^v_slots := array\[/ },
  { fn: 'private.tryon_select_idea_steps', from: '20261011090000_tryon_idea.sql', allowed: /^v_slots := array\[/ },
  { fn: 'private.tryon_purge_overdue', from: '20261003090000_try_on.sql', allowed: /^(select exists|or exists)\(select 1 from private\./ },
  { fn: 'public.tryon_claim', from: '20261101080000_persistent_ai_availability.sql',
    allowed: /sunburst-tryon-v[12]|p_step not between 1 and [36]|tryon_results where owner_id=p\.owner_id|expires_at>v_now\)\)>=20|>=200 then/ },
  { fn: 'public.tryon_status', from: '20261010090000_shared_ai_budget.sql',
    allowed: /tryon_results where owner_id=p\.owner_id|expires_at>v_now\);|'maxSteps'/ },
  { fn: 'public.tryon_results_v1', from: '20261011090000_tryon_idea.sql', allowed: /^declare v_now|^declare v_ideas|expiresAtMs|completedAtMs|expires_at>v_now|^where r\.owner_id=auth\.uid\(\) and r\.state='ready'/ },
  { fn: 'public.tryon_result_image_v1', from: '20261011090000_tryon_idea.sql', allowed: /^declare v bytea|expires_at>v_now|^where r\.owner_id=auth\.uid\(\) and r\.result_id/ },
  { fn: 'public.tryon_chain_status', from: '20261003090000_try_on.sql', allowed: /^and state='ready'/ },
  { fn: 'public.tryon_cancel', from: '20261004090000_tryon_stop_before_claim.sql', allowed: /^and state='ready'/ },
  { fn: 'public.tryon_finish', from: '20261005090000_provider_refusal.sql',
    allowed: /^v_active boolean; v_result uuid|v_until|expires_at|'deleted',v_result is null|^-- A committed final picture|^-- result is reported|^-- reported, never|^-- result slot|^-- No resurrection|^select result_id|^where owner_id=p_owner_id and chain_id=u\.tryon_chain_id|^update private\.tryon_results set state='ready'/ },
  { fn: 'public.tryon_expire_due', from: '20261004090000_tryon_stop_before_claim.sql',
    allowed: /v_r|tryon_results where ctid in|state='ready' and expires_at|resultsPurged|^get diagnostics v_r|^declare v_now|^return jsonb_build_object\('code','OK','expired'/ },
  { fn: 'public.tryon_purge_health', from: '20261003090000_try_on.sql', allowed: /overdueResults|^and expires_at<clock_timestamp/ },
  { fn: 'public.tryon_probe_authorise', from: '20261010090000_shared_ai_budget.sql', allowed: /p_max_calls not between 1 and [56]/ },
  { fn: 'public.tryon_bootstrap', from: '20261010090000_shared_ai_budget.sql', allowed: /sunburst-tryon-v[12]/ },
  { fn: 'public.tryon_person_photo_put_v1', from: '20261011100000_tryon_person_photo.sql',
    allowed: /^if c\.tryon_notice_revision/ },
];

describe('TRYON-LIMITS1 migration', () => {
  it('is one LF transaction after the availability migration and replaces exactly the reviewed functions', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-LIMITS1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(MAIN)).toBeGreaterThan(names.indexOf('20261101080000_persistent_ai_availability.sql'));
    expect(names).toContain(MAIN);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(REPLACED.map((entry) => entry.fn));
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bcreate function\b|\bdrop (function|table|trigger|index)\b|\bgrant\b|\brevoke\b|\btruncate\b|disable trigger/);
  });

  for (const entry of REPLACED) {
    it(`restates ${entry.fn} as its latest definition with only the reviewed line changes`, async () => {
      const after = fn(await read(MAIN), entry.fn);
      const before = fn(await read(entry.from), entry.fn);
      const { removed, added } = changed(before, after);
      expect(removed.length + added.length, entry.fn).toBeGreaterThan(0);
      for (const line of [...removed, ...added]) expect(line, `${entry.fn}: ${line}`).toMatch(entry.allowed);
      // The header of the function (signature, security definer, empty search_path, lock_timeout) is restated unchanged.
      expect(after.split('\n').slice(0, 2).join('\n')).toBe(before.split('\n').slice(0, 2).join('\n'));
    });
  }

  it('never deletes a result: the only delete from tryon_results is the orphaned reserved slot in the maintenance job', async () => {
    const sql = await read(MAIN);
    const deletes = [...sql.matchAll(/delete from private\.tryon_results/g)];
    expect(deletes).toHaveLength(1);
    const due = fn(sql, 'public.tryon_expire_due');
    expect(due).toContain("delete from private.tryon_results r where ctid in (select x.ctid from private.tryon_results x\n    where x.state='reserved'");
    // Top-level statements (outside any function body) do not delete or update results at all.
    const outside = sql.replace(/create or replace function[\s\S]*?\n\$\$;/g, '').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(outside).not.toMatch(/delete from private\.tryon_results|update private\.tryon_results|truncate/);
    expect(sql).not.toMatch(/delete from private\.tryon_results[^;]*expires_at|where state='ready' and expires_at/);
  });

  it('drops the result expiry column and restates the state check without it, keeping every row', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain('drop column expires_at,');
    expect(sql).toContain("add constraint tryon_results_ready check ((state='ready') = (jpeg is not null) and (jpeg is null) = (completed_at is null))");
    expect(sql).toContain('add constraint tryon_results_item_count check (cardinality(item_ids) between 1 and 6)');
    for (const name of ['tryon_results_expiry']) expect(sql).not.toContain(`drop index ${name}`);
    // No replaced body still reads a result's expiry.
    for (const entry of REPLACED) {
      const body = fn(sql, entry.fn);
      expect(body.match(/r\.expires_at|\bv_until\b|tryon_results[^;]*expires_at/g) ?? [], entry.fn).toEqual([]);
    }
    for (const name of ['expiresAtMs']) {
      for (const target of ['public.tryon_results_v1', 'public.tryon_finish', 'public.tryon_result_image_v1']) {
        expect(fn(sql, target), target).not.toContain(name);
      }
    }
    // Stop and chain status still report the chain's own 30-minute expiry.
    expect(fn(sql, 'public.tryon_chain_status')).toContain("'expiresAtMs',floor(extract(epoch from t.expires_at)*1000)::bigint");
  });

  it('allows six steps, 200 stored or reserved results and six probe calls, with named bounds', async () => {
    const sql = await read(MAIN);
    for (const text of ['add constraint tryon_chains_steps_count check (jsonb_typeof(steps)=\'array\' and jsonb_array_length(steps) between 1 and 6)',
      'add constraint tryon_chains_next_step check (next_step between 1 and 7)',
      'add constraint tryon_attempts_step_range check (step between 1 and 6)',
      'add constraint ai_usage_tryon_step_range check (tryon_step between 1 and 6)',
      'add constraint tryon_probe_authorisations_calls check (max_calls between 1 and 6)']) expect(sql).toContain(text);
    const claim = fn(sql, 'public.tryon_claim');
    expect(claim).toContain('p_step not between 1 and 6');
    expect(claim).toContain('if (select count(*) from private.tryon_results where owner_id=p.owner_id)>=200 then');
    expect(claim).toContain("return jsonb_build_object('code','RESULTS_FULL','claimed',false)");
    const status = fn(sql, 'public.tryon_status');
    expect(status).toContain("'maxSteps',6,'maxResults',200,'providerAvailable'");
    expect(status).not.toContain('resultDays');
    expect(fn(sql, 'public.tryon_probe_authorise')).toContain('p_max_calls not between 1 and 6');
  });

  it('selects one garment per slot in the SQL copy of the app order', async () => {
    const sql = await read(MAIN);
    for (const name of ['private.tryon_select_steps', 'private.tryon_select_idea_steps']) {
      const body = fn(sql, name);
      expect(body).toContain("v_slots := array['one_piece','layer','outerwear','footwear','accessory'];");
      expect(body).toContain("v_slots := array['top','bottom','layer','outerwear','footwear','accessory'];");
      expect(body).toContain('limit 1) as step');
    }
  });

  it('adds only the v2 manifest, on the v1 deployment key, and moves configured accounts without writing consent', async () => {
    const sql = await read(MAIN);
    expect(sql.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(sql).toContain(`insert into private.provider_deployments\n  select ${V2},deployment_key from private.provider_deployments\n  where manifest_id=${V1};`);
    expect(sql).toContain(`update private.ai_controls set tryon_manifest_id=${V2},tryon_notice_revision=3,\n  updated_at=clock_timestamp() where tryon_manifest_id=${V1};`);
    const outside = sql.replace(/create or replace function[\s\S]*?\n\$\$;/g, '').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(outside.match(/update private\.ai_controls/g)).toHaveLength(1);
    expect(sql).not.toMatch(/tryon_consent_revision\s*=|tryon_consented_at\s*=/);
    // D1: no trigger carve-out. The existing guard removes a saved photo whose consent no longer equals the notice.
    expect(sql).not.toMatch(/tryon_person_photo_guard|disable trigger|set_config/);
    for (const name of ['public.tryon_claim', 'public.tryon_bootstrap']) {
      const body = fn(sql, name);
      expect(body).toContain(`m.id<>${V2}`);
      expect(body).not.toContain(V1);
    }
  });

  it('lets the reference photo be saved from notice revision 2 on, with consent equal to the notice', async () => {
    const put = fn(await read(MAIN), 'public.tryon_person_photo_put_v1');
    expect(put).toContain('if c.tryon_notice_revision<2 or c.tryon_consent_revision is distinct from c.tryon_notice_revision then');
    expect(put).not.toContain('is distinct from 2');
  });

  it('stops the maintenance job and the new-chain safeguard from looking at result age', async () => {
    const sql = await read(MAIN);
    const due = fn(sql, 'public.tryon_expire_due');
    expect(due).not.toMatch(/state='ready'/);
    expect(due).toContain("where x.state='reserved' and not exists(select 1 from private.tryon_chains t");
    expect(due).toContain("from private.tryon_chains where ctid in (select ctid from private.tryon_chains\n    where state<>'running' and ended_at<=v_now-interval '1 day'");
    const overdue = fn(sql, 'private.tryon_purge_overdue');
    expect(overdue).not.toContain('tryon_results');
    expect(overdue).toContain("charge_state='held'");
    expect(fn(sql, 'public.tryon_purge_health')).not.toContain('overdueResults');
  });

  it('checks its own preconditions and postconditions', async () => {
    const sql = await read(MAIN);
    expect(sql.indexOf('TRYON-LIMITS1 precondition')).toBeGreaterThan(-1);
    expect(sql.indexOf('TRYON-LIMITS1 precondition')).toBeLessThan(sql.indexOf('drop column expires_at'));
    expect(sql.indexOf('TRYON-LIMITS1 postcondition')).toBeGreaterThan(sql.lastIndexOf('create or replace function'));
    expect(sql.trimEnd().endsWith('end;\n$$;\n\ncommit;')).toBe(true);
  });
});
