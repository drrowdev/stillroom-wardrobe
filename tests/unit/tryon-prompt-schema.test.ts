import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TRYON_PARAMETERS, TRYON_PROMPTS, TRYON_SETTINGS } from '../../src/domain/tryon';

// TRYON-PROMPT1 source pins: the v3 manifest changes only the layer and outerwear wording. The CI preservation and security jobs prove
// the migration applies and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261102090000_tryon_prompt_v3.sql';
const V2 = "'azure-global-image25-sunburst-tryon-v2'";
const V3 = "'azure-global-image25-sunburst-tryon-v3'";
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

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
const code = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

// Every replaced function: its previous latest definition and the only line change the migration may make to it.
const REPLACED = ['public.tryon_claim', 'public.tryon_bootstrap'];
const PREVIOUS = '20261101200000_tryon_limits.sql';

describe('TRYON-PROMPT1 migration', () => {
  it('is one LF transaction, the last migration, and replaces exactly the two functions that name the manifest', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-PROMPT1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(MAIN)).toBeGreaterThan(names.indexOf(PREVIOUS));
    expect(names.indexOf(MAIN)).toBe(names.indexOf(PREVIOUS) + 1);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(REPLACED);
    expect(code(sql)).not.toMatch(/\bcreate function\b|\bdrop (function|table|trigger|index|column)\b|\bgrant\b|\brevoke\b|\btruncate\b|disable trigger|\bdelete from\b|\balter table\b/);
  });

  for (const name of REPLACED) {
    it(`restates ${name} as its latest definition with only the manifest literal changed`, async () => {
      const after = fn(await read(MAIN), name);
      const before = fn(await read(PREVIOUS), name);
      const { removed, added } = changed(before, after);
      expect(removed.length, name).toBeGreaterThan(0);
      expect(removed.length).toBe(added.length);
      for (const line of removed) expect(line, name).toContain(V2);
      for (const line of added) expect(line, name).toContain(V3);
      expect(added.map((line) => line.replace(V3, V2)).sort()).toEqual(removed.slice().sort());
      // The header of the function (signature, security definer, empty search_path, lock_timeout) is restated unchanged.
      expect(after.split('\n').slice(0, 2).join('\n')).toBe(before.split('\n').slice(0, 2).join('\n'));
      expect(after).not.toContain(V2);
      // Exact equality: the body is the previous body byte for byte with only the manifest literal replaced (the SQL postcondition
      // proves the same on the installed body).
      expect(after).toBe(before.replaceAll(V2, V3));
    });
  }

  it('does not replace any other function that names a try-on manifest in its latest definition', async () => {
    const latest = await read(PREVIOUS);
    const bodies = [...latest.matchAll(/^create or replace function ([a-z_0-9.]+)\(/gm)].map((match) => match[1]!);
    const naming = bodies.filter((name) => fn(latest, name).includes(V2));
    expect(naming.sort()).toEqual([...REPLACED].sort());
  });

  it('adds only the v3 manifest, on the shared deployment key, and moves configured accounts without writing notice or consent', async () => {
    const sql = await read(MAIN);
    const text = code(sql);
    const outside = text.replace(/create or replace function[\s\S]*?\n\$\$;/g, '');
    expect(text.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(sql).toContain(`insert into private.provider_deployments\n  select ${V3},deployment_key from private.provider_deployments\n  where manifest_id=${V2};`);
    expect(sql).toContain(`update private.ai_controls set tryon_manifest_id=${V3},updated_at=clock_timestamp()\n  where tryon_manifest_id=${V2};`);
    expect(outside.match(/\b(insert into|update) [a-z_.]+/g)).toEqual([
      'insert into private.ai_execution_manifests', 'insert into private.provider_deployments', 'update private.ai_controls']);
    // Neither the notice revision nor consent nor the photo guard is touched: no re-consent, the saved reference photo stays.
    expect(outside).not.toMatch(/tryon_consent_revision\s*=|tryon_consented_at\s*=|tryon_notice_revision\s*=|tryon_person_photo/);
    expect(outside).not.toContain('session_replication_role');
    expect(text).toMatch(/set_config\('tryon_prompt1\.v2_row'/);
  });

  it('pins the v3 manifest row: new prompt and settings hashes, the unchanged parameter hash and the v2 envelope', async () => {
    const sql = await read(MAIN);
    for (const hash of [sha(JSON.stringify(TRYON_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`${V3},'gpt-image-2.5-sunburst',3,`);
    expect(sql).toContain("'USD',800,3000,15000,8000,360000,512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'");
    const limits = await read(PREVIOUS);
    const row = (text: string) => /insert into private\.ai_execution_manifests values \(([\s\S]*?)\n\);/.exec(text)![1]!.split('\n').map((line) => line.trim()).filter(Boolean);
    const [v3, v2] = [row(sql), row(limits)];
    expect(v3).toHaveLength(v2.length);
    const differing = v3.flatMap((line, index) => (line === v2[index] ? [] : [index]));
    expect(differing).toEqual([0, 1, 3, 7]);
    expect(v3[2]).toBe(v2[2]);
    expect(v3[4]).toBe(v2[4]);
    expect(v3[8]).toBe(v2[8]);
    expect(v3[7]).toContain('Layers and outerwear with a front opening are shown open or unfastened.');
  });

  it('checks its own preconditions, including a drain guard, and postconditions', async () => {
    const sql = await read(MAIN);
    expect(sql.indexOf('TRYON-PROMPT1 precondition')).toBeGreaterThan(-1);
    expect(sql.indexOf('TRYON-PROMPT1 precondition')).toBeLessThan(sql.indexOf('insert into private.ai_execution_manifests'));
    expect(sql).toContain('a try-on is still running; drain first');
    // The drain check is atomic with the cutover: the admission lock comes first (a mode that conflicts with select ... for update),
    // then the chains, then the usage, all before the check and every write, in one consistent order.
    const lockC = sql.indexOf('lock table private.ai_controls in exclusive mode;');
    const lockH = sql.indexOf('lock table private.tryon_chains in exclusive mode;');
    const lockU = sql.indexOf('lock table private.ai_usage in exclusive mode;');
    expect(lockC).toBeGreaterThan(sql.indexOf("set local lock_timeout = '5s';"));
    expect(lockH).toBeGreaterThan(lockC);
    expect(lockU).toBeGreaterThan(lockH);
    expect(sql).not.toMatch(/share row exclusive/);
    expect(lockU).toBeLessThan(sql.indexOf("exists(select 1 from private.tryon_chains where state='running')"));
    expect(lockU).toBeLessThan(sql.indexOf('insert into private.ai_execution_manifests'));
    expect(sql.indexOf("exists(select 1 from private.tryon_chains where state='running')")).toBeLessThan(sql.indexOf('insert into private.ai_execution_manifests'));
    expect(sql).toContain("exists(select 1 from private.ai_usage where purpose='try_on' and charge_state in ('reserved','held'))");
    expect(sql).toContain("set_config('tryon_prompt1.claim'");
    expect(sql).toContain("set_config('tryon_prompt1.bootstrap'");
    expect(sql).toContain('a replaced function differs from the installed body beyond the manifest literal');
    expect(sql.indexOf('TRYON-PROMPT1 postcondition')).toBeGreaterThan(sql.lastIndexOf('create or replace function'));
    expect(sql.trimEnd().endsWith('end;\n$$;\n\ncommit;')).toBe(true);
  });
});
