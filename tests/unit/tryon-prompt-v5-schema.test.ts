import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TRYON_PARAMETERS, TRYON_PROMPTS, TRYON_SETTINGS } from '../../src/domain/tryon';

// TRYON-PROMPT3 source pins: the v5 manifest adds the hem-length wording, and outerwear is no longer drawn. It is installed inert (the
// claim admits v3, v4 and v5; only v5 trims the outerwear step); the owner's guarded switch moves the accounts. The CI preservation job
// proves the migration and the switch against the real schema; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261111090000_tryon_prompt_v5.sql';
const PREVIOUS = '20261109110000_tryon_prompt_v4.sql';
const V3 = "'azure-global-image25-sunburst-tryon-v3'";
const V4 = "'azure-global-image25-sunburst-tryon-v4'";
const V5 = "'azure-global-image25-sunburst-tryon-v5'";
const PIN34 = `m.id not in (${V3},${V4})`;
const PIN345 = `m.id not in (${V3},${V4},${V5})`;
const ANCHOR = "    v_n := jsonb_array_length(v_steps);\n    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;";
const DRAWN = `    v_steps := private.tryon_drawn_steps(m.id,v_steps);\n${ANCHOR}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const fn = (sql: string, name: string) => {
  const match = new RegExp(`^create (or replace )?function ${name.replace('.', '\\.')}\\(`, 'm').exec(sql);
  expect(match, name).not.toBeNull();
  const from = match!.index;
  const to = sql.indexOf('\n$$;', from);
  expect(to, name).toBeGreaterThan(from);
  return sql.slice(from, to + 4);
};
const code = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const REPLACED = ['public.tryon_claim', 'public.tryon_bootstrap'];

describe('TRYON-PROMPT3 migration', () => {
  it('is one LF transaction directly after the v4 migration, adds one private helper and replaces exactly the claim and the bootstrap', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-PROMPT3')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(MAIN)).toBe(names.indexOf(PREVIOUS) + 1);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(REPLACED);
    expect([...sql.matchAll(/^create function ([a-z_0-9.]+)\(/gm)].map((match) => match[1])).toEqual(['private.tryon_drawn_steps']);
    expect(code(sql)).not.toMatch(/\bdrop (function|table|trigger|index|column)\b|\bgrant\b|\btruncate\b|disable trigger|\bdelete from\b|\balter table\b/);
    expect(code(sql).match(/\brevoke\b[^;]*;/g)).toEqual(['revoke all on function private.tryon_drawn_steps(text,jsonb) from public,anon,authenticated,service_role;']);
  });

  for (const name of REPLACED) {
    it(`restates ${name} as its latest (v4) definition with only the stated delta`, async () => {
      const after = fn(await read(MAIN), name);
      const before = fn(await read(PREVIOUS), name);
      expect(before.split(PIN34)).toHaveLength(2);
      const expected = name === 'public.tryon_claim'
        ? (expect(before.split(ANCHOR)).toHaveLength(2), before.replace(PIN34, () => PIN345).replace(ANCHOR, () => DRAWN))
        : before.replace(PIN34, () => PIN345);
      expect(after).toBe(expected);
      expect(after).not.toContain(`${PIN34}`);
      expect(after.split('\n').slice(0, 2).join('\n')).toBe(before.split('\n').slice(0, 2).join('\n'));
    });
  }

  it('selects, trims and counts in that order: the drawn steps are what the step count, the allowance check and the frozen chain use', async () => {
    const claim = fn(await read(MAIN), 'public.tryon_claim');
    expect(claim.split('private.tryon_drawn_steps(m.id,v_steps)')).toHaveLength(2);
    const order = ['private.tryon_select_steps(', 'private.tryon_select_idea_steps(', 'private.tryon_drawn_steps(m.id,v_steps)',
      'v_n := jsonb_array_length(v_steps);', "'NO_GARMENTS'", 'v_used+v_n*v_r>c.monthly_allowance_micro', 'insert into private.tryon_chains'];
    const at = order.map((part) => claim.indexOf(part));
    for (const [index, position] of at.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The manifest is known when the steps are trimmed; a frozen chain is never trimmed again.
    expect(claim.indexOf('select * into m from private.ai_execution_manifests')).toBeLessThan(at[2]!);
    expect(claim).toContain('    v_steps := t.steps;');
  });

  it('adds a helper that drops only the outerwear slot, only for v5, keeps the order, and is callable by no API role', async () => {
    const sql = await read(MAIN);
    const helper = fn(sql, 'private.tryon_drawn_steps');
    expect(helper).toContain('create function private.tryon_drawn_steps(p_manifest_id text,p_steps jsonb) returns jsonb\nlanguage sql immutable set search_path = \'\' as $$');
    expect(helper).toContain(`when p_manifest_id=${V5}`);
    expect(helper).toContain("jsonb_agg(s.step order by s.n) from jsonb_array_elements(p_steps) with ordinality s(step,n)");
    expect(helper).toContain("where s.step->>'slot'<>'outerwear'");
    expect(helper).toContain("'[]'::jsonb");
    expect(helper).toContain('else p_steps end;');
    expect(helper).not.toMatch(/security definer|\bv4\b|tryon-v4|tryon-v3/);
    expect(sql).toContain('revoke all on function private.tryon_drawn_steps(text,jsonb) from public,anon,authenticated,service_role;');
    expect(sql).toContain("has_function_privilege('service_role','private.tryon_drawn_steps(text,jsonb)','EXECUTE')");
    // No other function in the migration touches the plan or the step order.
    expect(code(sql).replace(/create or replace function[\s\S]*?\n\$\$;/g, '').match(/\boutfit_items\b|tryon_select/g)).toBeNull();
  });

  it('adds only the v5 manifest and its deployment row and writes no account, consent, notice, result, chain or photo row', async () => {
    const sql = await read(MAIN);
    const text = code(sql);
    const outside = text.replace(/create (or replace )?function[\s\S]*?\n\$\$;/g, '');
    expect(sql).toContain(`insert into private.provider_deployments\n  select ${V5},deployment_key from private.provider_deployments\n  where manifest_id=${V4};`);
    expect(outside.match(/\b(insert into|update|delete from) [a-z_.]+/g)).toEqual([
      'insert into private.ai_execution_manifests', 'insert into private.provider_deployments']);
    expect(outside).not.toMatch(/ai_controls set|tryon_consent|tryon_notice_revision\s*=|tryon_person_photo|session_replication_role/);
    expect(text).not.toMatch(/\block table\b/);
    expect(text).not.toContain('drain');
  });

  it('pins the v5 manifest row: new prompt and settings hashes, the unchanged parameter hash and the v4 envelope', async () => {
    const sql = await read(MAIN);
    for (const hash of [sha(JSON.stringify(TRYON_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`${V5},'gpt-image-2.5-sunburst',5,`);
    const row = (text: string) => /insert into private\.ai_execution_manifests values \(([\s\S]*?)\n\);/.exec(text)![1]!.split('\n').map((line) => line.trim()).filter(Boolean);
    const [v5, v4] = [row(sql), row(await read(PREVIOUS))];
    expect(v5).toHaveLength(v4.length);
    expect(v5.flatMap((line, index) => (line === v4[index] ? [] : [index]))).toEqual([0, 1, 3, 7]);
    for (const index of [2, 4, 5, 6, 8]) expect(v5[index]).toBe(v4[index]);
    // The description is a SQL string literal: every apostrophe inside it must be doubled.
    expect(v5[7]!.replace(/^'/, '').replace(/',$/, '').replaceAll("''", '')).not.toContain("'");
    expect(v5[7]).toContain('outerwear is an optional piece of an outfit and is never drawn');
    expect(v5[7]).toContain('pullovers stay closed');
  });

  it('checks its own preconditions before any write, and its postconditions after the last function', async () => {
    const sql = await read(MAIN);
    expect(sql.indexOf('TRYON-PROMPT3 precondition')).toBeGreaterThan(-1);
    expect(sql.indexOf('TRYON-PROMPT3 precondition')).toBeLessThan(sql.indexOf('insert into private.ai_execution_manifests'));
    for (const key of ['rows', 'controls', 'claim', 'bootstrap']) expect(sql).toContain(`set_config('tryon_prompt3.${key}'`);
    for (const message of ['an earlier manifest changed', 'an account\'\'s controls changed', 'differs from the installed body beyond the stated delta',
      'v5 is not on the shared deployment key', 'private.tryon_drawn_steps does not behave as stated', 'does not select the garments of a new chain exactly once']) {
      expect(sql).toContain(message);
    }
    expect(sql.indexOf('TRYON-PROMPT3 postcondition')).toBeGreaterThan(sql.lastIndexOf('create or replace function'));
    expect(sql.trimEnd().endsWith('end;\n$$;\n\ncommit;')).toBe(true);
  });

  it('registers the helper in the isolation audit catalog as a private internal function (the audit rejects any unregistered private function)', async () => {
    // @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
    const catalog = await import('../../scripts/isolation-catalog.mjs');
    const created = [...(await read(MAIN)).matchAll(/^create function private\.([a-z_0-9]+)\(([^)]*)\)/gm)].map((match) => `${match[1]}(${match[2]!.split(',')
      .map((argument) => argument.trim().split(/\s+/)[1]).join(', ')})`);
    expect(created).toEqual(['tryon_drawn_steps(text, jsonb)']);
    for (const signature of created) expect(catalog.PRIVATE_INTERNAL as string[], signature).toContain(signature);
  });

  it('leaves the guarded switch algorithm to the v4 pins: the placeholders and the single write are unchanged', async () => {
    const sql = await readFile(new URL('../../docs/tryon-manifest-switch.sql', import.meta.url), 'utf8');
    expect(sql).toContain("v_from constant text := '<from>';");
    expect(sql).toContain("v_to constant text := '<to>';");
    expect(sql).toContain('update private.ai_controls set tryon_manifest_id=v_to,updated_at=clock_timestamp()');
  });
});
