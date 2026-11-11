import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TRYON_PARAMETERS } from '../../src/domain/tryon';
import { TRYON_V4_PROMPTS, TRYON_V4_SETTINGS } from '../fixtures/tryon-v4-frozen';

// TRYON-PROMPT2 source pins: the v4 manifest changes only the layer and outerwear wording and is installed inert (the claim admits v3 and
// v4); the owner's guarded switch moves the accounts. The CI preservation job proves the migration and the switch against the real schema;
// these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261109110000_tryon_prompt_v4.sql';
const PREVIOUS = '20261109100000_outfitgen_judge_v2.sql';
const V3_MIGRATION = '20261102090000_tryon_prompt_v3.sql';
const V3 = "'azure-global-image25-sunburst-tryon-v3'";
const V4 = "'azure-global-image25-sunburst-tryon-v4'";
const PIN3 = `m.id<>${V3}`;
const PIN34 = `m.id not in (${V3},${V4})`;
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

describe('TRYON-PROMPT2 migration', () => {
  it('is one LF transaction directly after the previous migration and replaces exactly the two functions that pin the manifest', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-PROMPT2')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(MAIN)).toBe(names.indexOf(PREVIOUS) + 1);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(REPLACED);
    expect(code(sql)).not.toMatch(/\bcreate function\b|\bdrop (function|table|trigger|index|column)\b|\bgrant\b|\brevoke\b|\btruncate\b|disable trigger|\bdelete from\b|\balter table\b/);
  });

  for (const name of REPLACED) {
    it(`restates ${name} as its latest definition with only the manifest pin widened to v3 or v4`, async () => {
      const after = fn(await read(MAIN), name);
      const before = fn(await read(V3_MIGRATION), name);
      expect(before.split(PIN3)).toHaveLength(2);
      expect(after).toBe(before.replace(PIN3, () => PIN34));
      expect(after).not.toContain(PIN3);
      expect(after.split('\n').slice(0, 2).join('\n')).toBe(before.split('\n').slice(0, 2).join('\n'));
    });
  }

  it('replaces the latest definitions: nothing between the v3 migration and this one redefines either function or names a try-on manifest', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    const between = names.slice(names.indexOf(V3_MIGRATION) + 1, names.indexOf(MAIN));
    expect(between.length).toBeGreaterThan(0);
    for (const name of between) {
      const sql = code(await read(name));
      expect(sql, name).not.toMatch(/function public\.tryon_(claim|bootstrap)\(/);
      expect(sql, name).not.toContain('sunburst-tryon-v');
    }
    const v3 = await read(V3_MIGRATION);
    const bodies = [...v3.matchAll(/^create or replace function ([a-z_0-9.]+)\(/gm)].map((match) => match[1]!);
    expect(bodies.filter((name) => fn(v3, name).includes(V3)).sort()).toEqual([...REPLACED].sort());
  });

  it('adds only the v4 manifest and its deployment row and writes no account, consent, notice, result, chain or photo row', async () => {
    const sql = await read(MAIN);
    const text = code(sql);
    const outside = text.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
    expect(sql).toContain(`insert into private.provider_deployments\n  select ${V4},deployment_key from private.provider_deployments\n  where manifest_id=${V3};`);
    expect(outside.match(/\b(insert into|update|delete from) [a-z_.]+/g)).toEqual([
      'insert into private.ai_execution_manifests', 'insert into private.provider_deployments']);
    expect(outside).not.toMatch(/ai_controls set|tryon_consent|tryon_notice_revision\s*=|tryon_person_photo|session_replication_role/);
    // Nothing is moved, so there is no drain and no admission lock: the claim still admits v3.
    expect(text).not.toMatch(/\block table\b/);
    expect(code(sql)).not.toContain('drain');
  });

  it('pins the v4 manifest row: new prompt and settings hashes, the unchanged parameter hash and the v3 envelope', async () => {
    const sql = await read(MAIN);
    for (const hash of [sha(JSON.stringify(TRYON_V4_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V4_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`${V4},'gpt-image-2.5-sunburst',4,`);
    const row = (text: string) => /insert into private\.ai_execution_manifests values \(([\s\S]*?)\n\);/.exec(text)![1]!.split('\n').map((line) => line.trim()).filter(Boolean);
    const [v4, v3] = [row(sql), row(await read(V3_MIGRATION))];
    expect(v4).toHaveLength(v3.length);
    expect(v4.flatMap((line, index) => (line === v3[index] ? [] : [index]))).toEqual([0, 1, 3, 7]);
    for (const index of [2, 4, 5, 6, 8]) expect(v4[index]).toBe(v3[index]);
    expect(v4[7]).toContain('pullovers stay closed');
    // The description is a SQL string literal: every apostrophe inside it must be doubled.
    expect(v4[7]!.replace(/^'/, '').replace(/',$/, '').replaceAll("''", '')).not.toContain("'");
    expect(v4[7]).toContain('coats photographed fastened included');
    expect(v4[7]).not.toContain('Layers and outerwear with a front opening are shown open');
  });

  it('checks its own preconditions before any write, and its postconditions after the last function', async () => {
    const sql = await read(MAIN);
    expect(sql.indexOf('TRYON-PROMPT2 precondition')).toBeGreaterThan(-1);
    expect(sql.indexOf('TRYON-PROMPT2 precondition')).toBeLessThan(sql.indexOf('insert into private.ai_execution_manifests'));
    for (const key of ['rows', 'controls', 'claim', 'bootstrap']) expect(sql).toContain(`set_config('tryon_prompt2.${key}'`);
    for (const message of ['an earlier manifest changed', 'an account\'\'s controls changed', 'differs from the installed body beyond the manifest pin',
      'v4 is not on the shared deployment key']) expect(sql).toContain(message);
    expect(sql.indexOf('TRYON-PROMPT2 postcondition')).toBeGreaterThan(sql.lastIndexOf('create or replace function'));
    expect(sql.trimEnd().endsWith('end;\n$$;\n\ncommit;')).toBe(true);
  });
});

describe('TRYON-PROMPT2 guarded manifest switch (docs/tryon-manifest-switch.sql)', () => {
  const file = () => readFile(new URL('../../docs/tryon-manifest-switch.sql', import.meta.url), 'utf8');

  it('is one LF transaction with the two placeholders and writes only tryon_manifest_id of the collected ids', async () => {
    const sql = await file();
    expect(sql).not.toContain('\r');
    expect(sql).toContain('\nbegin;\nset local lock_timeout = \'10s\';\ndo $$\n');
    expect(sql.trimEnd().endsWith('$$;\ncommit;')).toBe(true);
    expect(sql).toContain("v_from constant text := '<from>';");
    expect(sql).toContain("v_to constant text := '<to>';");
    const text = code(sql);
    expect(text.match(/\b(update private\.[a-z_]+|insert into|delete from)\b/g)).toEqual(['update private.ai_controls']);
    expect(text).toContain('update private.ai_controls set tryon_manifest_id=v_to,updated_at=clock_timestamp()\n    where owner_id=any(v_ids) and tryon_manifest_id=v_from;');
    expect(text).not.toMatch(/tryon_consent|tryon_notice_revision|tryon_max_request|tryon_monthly|tryon_max_requests/);
  });

  it('states the configuration freeze and the recovery path, and asserts the row count and the unchanged configured set', async () => {
    const sql = await file();
    expect(sql).toContain('CONFIGURATION FREEZE');
    expect(sql).toContain('tryon_bootstrap');
    expect(sql).toContain('not a global admission barrier');
    expect(sql).toContain('docs/tryon-manifest-recover-owner.sql');
    const text = code(sql);
    for (const part of ['get diagnostics v_rows = row_count;', 'if v_rows<>v_n then', 'the set of configured accounts changed during the switch',
      "(select count(*) from private.ai_controls where tryon_manifest_id is not null)<>v_n"]) expect(text, part).toContain(part);
    expect(text.indexOf('get diagnostics v_rows = row_count;')).toBeGreaterThan(text.indexOf('update private.ai_controls'));
    expect(text.indexOf('the set of configured accounts changed')).toBeGreaterThan(text.indexOf('get diagnostics v_rows = row_count;'));
  });

  it('collects the configured ids once, then locks each account in the claim\'s order (profile, then controls) in owner order, before any write', async () => {
    const text = code(await file());
    const order = ["select coalesce(array_agg(owner_id order by owner_id),'{}'::uuid[]) into v_ids from private.ai_controls where tryon_manifest_id is not null;",
      'foreach o in array v_ids loop',
      'perform 1 from public.profiles where owner_id=o for update;', 'select * into c from private.ai_controls where owner_id=o for update;',
      'c.tryon_manifest_id is distinct from v_from', "from private.tryon_chains where owner_id=o and state='running'",
      "purpose='try_on' and charge_state in ('reserved','held')", "from private.tryon_results where owner_id=o and state='reserved'",
      'update private.ai_controls'];
    const at = order.map((part) => text.indexOf(part));
    for (const [index, position] of at.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text.indexOf('is not installed')).toBeLessThan(at[0]!);
    expect(text).not.toMatch(/\bnowait\b|\bskip locked\b|lock table/);
  });

  it('refuses without changing anything: wrong installed manifest, work still running, no configured account, uninstalled target', async () => {
    const text = code(await file());
    for (const message of ['is not installed', 'is on % and not %', 'try-on work is still running, held or reserved', 'no configured account']) {
      expect(text).toContain(message);
    }
    expect(text.match(/raise exception/g)!.length).toBeGreaterThanOrEqual(7);
  });
});

describe('TRYON-PROMPT2 per-owner recovery (docs/tryon-manifest-recover-owner.sql)', () => {
  const file = () => readFile(new URL('../../docs/tryon-manifest-recover-owner.sql', import.meta.url), 'utf8');

  it('moves exactly one account, in the claim\'s lock order, with the same refusals, and writes only tryon_manifest_id', async () => {
    const sql = await file();
    expect(sql).not.toContain('\r');
    expect(sql).toContain('needs its own owner authorisation');
    expect(sql).toContain("v_owner constant uuid := '<owner>';");
    expect(sql).toContain("v_from constant text := '<from>';");
    expect(sql).toContain("v_to constant text := '<to>';");
    expect(sql.trimEnd().endsWith('$$;\ncommit;')).toBe(true);
    const text = code(sql);
    expect(text.match(/\b(update private\.[a-z_]+|insert into|delete from)\b/g)).toEqual(['update private.ai_controls']);
    expect(text).toContain('where owner_id=v_owner and tryon_manifest_id=v_from;');
    expect(text).toContain('if v_rows<>1 then');
    const order = ['is not installed', 'perform 1 from public.profiles where owner_id=v_owner for update;',
      'select * into c from private.ai_controls where owner_id=v_owner for update;', "from private.tryon_chains where owner_id=v_owner and state='running'",
      "purpose='try_on' and charge_state in ('reserved','held')", "from private.tryon_results where owner_id=v_owner and state='reserved'",
      'update private.ai_controls'];
    const at = order.map((part) => text.indexOf(part));
    for (const [index, position] of at.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).not.toMatch(/tryon_consent|tryon_notice_revision|tryon_max_request|tryon_monthly|tryon_max_requests|\bnowait\b|lock table/);
  });
});
