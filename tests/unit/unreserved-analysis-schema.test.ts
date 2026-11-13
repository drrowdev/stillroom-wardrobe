import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AZURE_PROMPT, AZURE_SCHEMA, AZURE_SETTINGS } from '../../supabase/functions/analyze-clothing/azure-openai';
import { AZURE_SETTINGS_V3, AZURE_PROFILES, azureProfileFor } from '../../supabase/functions/analyze-clothing/azure-profiles';
import { APP_LIMIT_MICRO } from '../../src/domain/admin-limits';

// BUDGET2: the CI integration and preservation jobs prove the migration applies and behaves; these checks keep each replaced
// body equal to the exact current active definition except the manifest id list (and the ceiling constant), and pin the new
// immutable manifest row to the Edge profile.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261101090000_unreserved_analysis_manifest.sql';
const OLD_LIST = "'azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2')";
const NEW_LIST = "'azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3')";
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// The one behaviour change in the finish body: a v3 envelope overrun no longer deactivates the control (v1 and v2 still do).
const ANOMALY_OLD = "  if v_anomaly then\n    update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;\n    perform private.ai_close(";
const ANOMALY_NEW = "  if v_anomaly then\n    -- v3 (BUDGET2): an envelope overrun is recorded and fails only this photo; v1 and v2 still deactivate the control.\n"
  + "    if e.manifest_id<>'azure-eu-terra-devtest-v3' then\n      update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;\n    end if;\n    perform private.ai_close(";

type Target = { fn: string; from: string; start: string; replaces: [string, string][]; rename?: [string, string] };
const TARGETS: Target[] = [
  { fn: 'public.ai_claim_analysis', from: '20261101080000_persistent_ai_availability.sql',
    start: 'create or replace function public.ai_claim_analysis(', replaces: [[OLD_LIST, NEW_LIST]] },
  { fn: 'private.ai_analysis_permitted', from: '20261101080000_persistent_ai_availability.sql',
    start: 'create or replace function private.ai_analysis_permitted(', replaces: [[OLD_LIST, NEW_LIST]] },
  { fn: 'public.ai_finish_analysis', from: '20261008080000_analysis_model_identity.sql',
    start: 'create or replace function public.ai_finish_analysis(', replaces: [[OLD_LIST, NEW_LIST], [ANOMALY_OLD, ANOMALY_NEW]] },
  { fn: 'public.ai_status', from: '20261010090000_shared_ai_budget.sql',
    start: 'create or replace function public.ai_status()', replaces: [[OLD_LIST, NEW_LIST]] },
  { fn: 'public.complete_analyzed_item_save', from: '20260924100100_azure_colour_manifest.sql',
    start: 'create or replace function public.complete_analyzed_item_save(', replaces: [[OLD_LIST, NEW_LIST]] },
  { fn: 'private.admin_set_budget', from: '20261010090000_shared_ai_budget.sql', start: 'create function private.admin_set_budget(',
    rename: ['create function private.admin_set_budget(', 'create or replace function private.admin_set_budget('],
    replaces: [['v_new>50000000', 'v_new>200000000']] },
];
const sqlBody = (sql: string, start: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  expect(sql.indexOf(start, from + 1), `${start} once`).toBe(-1);
  const to = sql.indexOf('\n$$;\n', from);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to + 5);
};
const once = (text: string, find: string) => { expect(text.split(find), find).toHaveLength(2); };

describe('unreserved analysis manifest migration (BUDGET2)', () => {
  it('is one LF transaction after every earlier migration and only replaces the six active functions', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- BUDGET2')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.slice(0, names.indexOf(MAIN)).every((name) => name < MAIN)).toBe(true);
    expect(names.indexOf(MAIN)).toBeGreaterThan(names.indexOf('20261101080000_persistent_ai_availability.sql'));
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(TARGETS.map((t) => t.fn));
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bcreate function\b|\bdrop\b|\balter\b|\bgrant\b|\brevoke\b|\btruncate\b/);
    // Outside the function bodies the migration only inserts the manifest row: no controls, usage or consent row is written.
    const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
    expect(topLevel).not.toMatch(/\b(update|delete)\b/);
    expect(topLevel.match(/insert into /g)).toHaveLength(1);
    expect(topLevel.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(code.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
  });

  for (const target of TARGETS) {
    it(`reproduces the active ${target.fn} except the manifest list`, async () => {
      const [sql, from] = await Promise.all([read(MAIN), read(target.from)]);
      let before = sqlBody(from, target.start);
      if (target.rename) before = before.replace(target.rename[0], target.rename[1]);
      for (const [find, replacement] of target.replaces) { once(before, find); before = before.replace(find, replacement); }
      expect(sqlBody(sql, target.rename?.[1] ?? target.start)).toBe(before);
    });

    it(`has no migration between its source and this one redefining ${target.fn}`, async () => {
      const defines = new RegExp(`create (or replace )?function ${target.fn.replace('.', '\\.')}\\(`);
      const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql') && name > target.from && name < MAIN).sort();
      for (const name of names) expect(await read(name), name).not.toMatch(defines);
    });
  }

  it('adds the v3 manifest as v2 with only the request envelope, reservation, digest and description changed', async () => {
    const sql = await read(MAIN), v2 = await read('20260924100100_azure_colour_manifest.sql');
    const row = (text: string) => {
      const from = text.indexOf('insert into private.ai_execution_manifests values (');
      return text.slice(from, text.indexOf('\n);\n', from));
    };
    const v3 = row(sql), old = row(v2);
    const values = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
    const [oldLines, newLines] = [values(old), values(v3)];
    expect(newLines).toHaveLength(oldLines.length);
    const settings = digest(JSON.stringify(AZURE_SETTINGS_V3));
    expect(settings).toBe('67fd5bae409fb317702d89780ce8dcc1b80ccd4d6b690942b43faa7989d459bf');
    // Same prompt and schema digests as v2 (prompt version 2 is unchanged); only the settings digest differs.
    expect(v3).toContain(`'${digest(AZURE_PROMPT)}'`); expect(v3).toContain(`'${digest(JSON.stringify(AZURE_SCHEMA))}'`);
    expect(v3).toContain(`'${settings}'`); expect(v3).not.toContain(digest(JSON.stringify(AZURE_SETTINGS)));
    expect(v3).toContain("'azure-eu-terra-devtest-v3','gpt-5.6-terra-2026-07-09',2,");
    // The numeric tail: rates unchanged, input envelope 16,384, output 2,048, the smallest reservation (1) and v2's limits and date.
    expect(newLines.at(-1)).toBe("'USD',440,1980,16384,2048,1,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'");
    expect(oldLines.at(-1)).toBe("'USD',440,1980,922000,2048,4097351,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'");
    const differing = newLines.map((line, index) => [line, oldLines[index]]).filter(([x, y]) => x !== y).length;
    expect(differing).toBe(4); // id line, settings digest, description, numeric tail
  });

  it('pins the Edge profile to the row: same request bytes, three settings values, reservation 1', () => {
    expect(AZURE_SETTINGS_V3.bodyControls).toEqual(AZURE_SETTINGS.bodyControls);
    expect(AZURE_SETTINGS_V3.messages).toEqual(AZURE_SETTINGS.messages);
    expect(AZURE_SETTINGS_V3.responseFormat).toEqual(AZURE_SETTINGS.responseFormat);
    expect(AZURE_SETTINGS_V3.promptVersion).toBe(AZURE_SETTINGS.promptVersion);
    const flat = (value: unknown, path = ''): [string, unknown][] => typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, inner]) => flat(inner, `${path}.${key}`)) : [[path, value]];
    const changed = flat(AZURE_SETTINGS_V3).filter(([key, value]) => JSON.stringify(flat(AZURE_SETTINGS).find(([other]) => other === key)?.[1]) !== JSON.stringify(value));
    expect(changed.map(([key]) => key).sort()).toEqual(['.limits.inputTokens', '.metering.reservationMicro', '.profileId']);
    expect(Object.keys(AZURE_SETTINGS_V3)).toEqual(Object.keys(AZURE_SETTINGS));
    expect(AZURE_PROFILES.map((p) => [p.manifestId, p.promptVersion, p.reservationMicro])).toEqual([
      ['azure-eu-terra-devtest-v2', 2, '4097351'], ['azure-eu-terra-devtest-v3', 2, '1'], ['azure-eu-terra-devtest-v4', 3, '1']]);
    expect(azureProfileFor('azure-eu-terra-devtest-v1')).toBeNull();
    expect(azureProfileFor('azure-eu-terra-devtest-v5')).toBeNull();
    expect(azureProfileFor(undefined)).toBeNull();
  });

  it('keeps the ceiling in the database and the app at USD 200', async () => {
    const sql = await read(MAIN);
    expect(APP_LIMIT_MICRO).toBe(200_000_000n);
    expect(sqlBody(sql, 'create or replace function private.admin_set_budget(')).toContain(`if v_new>${APP_LIMIT_MICRO} then`);
  });

  it('documents why one micro-USD is the smallest hold the schema allows', async () => {
    const [controls, backend] = await Promise.all([read('20260909180000_ai_request_controls.sql'), read('20260911040000_ai_analysis_backend.sql')]);
    expect(controls).toContain('max_request_micro bigint not null check (max_request_micro > 0)');
    expect(controls).toContain('reserved_micro bigint not null check (reserved_micro > 0)');
    expect(controls).toContain("check (charge_state not in ('reserved','held') or accounted_micro = reserved_micro)");
    expect(backend).not.toMatch(/reservation_micro bigint not null check/);
    // Envelope valuation of v3 is far above one micro: the hold is a placeholder, not an upper bound (documented consequence).
    expect(Math.ceil((16384 * 440 + 2048 * 1980) / 100)).toBe(112640);
  });
});
