import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AZURE_PROMPT, AZURE_SCHEMA, AZURE_SETTINGS } from '../../supabase/functions/analyze-clothing/azure-openai';
import { AZURE_PROMPT_V4, AZURE_SCHEMA_V4, AZURE_SPEC_V4, normalizeGarmentType } from '../../supabase/functions/analyze-clothing/azure-v4';
import { AZURE_PROFILES, AZURE_SETTINGS_V3, AZURE_SETTINGS_V4, azureProfileFor } from '../../supabase/functions/analyze-clothing/azure-profiles';
import { validFacts } from '../../supabase/functions/analyze-clothing/protocol';
import { garmentTypes, garmentTypesByCategory } from '../../src/domain/garment-types';
import { categories } from '../../src/domain/wardrobe';
import { observedAiFields, aiFields } from '../../src/domain/ai-analysis';
import { switchControlsSql, switchManifestSql } from '../../scripts/budget2-controls-switch.mjs';

// CAPS1a: the CI preservation rehearsal proves the migrations apply and behave; these checks keep every replaced body equal to the exact
// current active definition plus the one stated delta, pin the check and helper to the shared type table, and pin the v4 manifest row to
// the Edge profile.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const M1 = '20261113090000_garment_type.sql';
const M2 = '20261113090100_garment_type_manifest.sql';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

type Target = { fn: string; from: string; replaces: [string, string][]; header?: 'create function' };
const OBSERVED_OLD = "array['category','subcategory','colours',";
const OBSERVED_NEW = "array['category','garment_type','subcategory','colours',";
const M1_TARGETS: Target[] = [
  { fn: 'private.item_save_fingerprint', from: '20260910070000_checked_item_save.sql', header: 'create function', replaces: [[
    "'item',to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at'],",
    "'item',to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at']-case when p_item.garment_type is null then 'garment_type' else '' end,"]] },
  { fn: 'private.item_save_value_hash', from: '20260911200000_checked_ai_item_save.sql', header: 'create function', replaces: [[
    "(to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at'])::text",
    "(to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at']-case when p_item.garment_type is null then 'garment_type' else '' end)::text"]] },
  { fn: 'private.ai_valid_facts', from: '20260924100000_garment_colours.sql', replaces: [
    ["observed constant text[] := array['category','subcategory',", "observed constant text[] := array['category','garment_type','subcategory',"],
    ["    elsif k in ('category','pattern','sleeve_length','garment_length') then", "    elsif k in ('category','garment_type','pattern','sleeve_length','garment_length') then"],
    ["        when 'category' then array['top','bottom','one_piece','footwear','layer','outerwear','accessory']\n",
      `        when 'category' then array['top','bottom','one_piece','footwear','layer','outerwear','accessory']\n        when 'garment_type' then array[${list(garmentTypes)}]\n`],
    ["      if jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(allowed) then return false; end if;\n",
      "      if jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(allowed) then return false; end if;\n"
      + "      if k='garment_type' and not private.garment_type_allowed(p_facts->'fields'->>'category',v#>>'{}') then return false; end if;\n"]] },
  { fn: 'private.item_field_provenance', from: '20260922020000_checked_image_changes.sql', replaces: [["'title','category','subcategory',", "'title','category','garment_type','subcategory',"]] },
  { fn: 'private.reserve_item_save', from: '20260924100000_garment_colours.sql', replaces: [
    ["'title','category','subcategory',", "'title','category','garment_type','subcategory',"],
    ["or not (p_item ?& (fields||settings||array['id','field_provenance']))", "or not (p_item ?& (array_remove(fields,'garment_type')||settings||array['id','field_provenance']))"],
    ["  if jsonb_typeof(p_item->'id')<>'string' or p_item->>'id' !~",
      "  if p_item->>'garment_type' is not null and not private.garment_type_allowed(p_item->>'category',p_item->>'garment_type') then\n"
      + "    raise exception using errcode='22023',message='Invalid input';\n  end if;\n  if jsonb_typeof(p_item->'id')<>'string' or p_item->>'id' !~"],
    ['pattern,sleeve_length,garment_length,\n    brand,', 'pattern,sleeve_length,garment_length,garment_type,\n    brand,'],
    ['i.pattern,i.sleeve_length,i.garment_length,\n', 'i.pattern,i.sleeve_length,i.garment_length,i.garment_type,\n']] },
  { fn: 'private.image_change_intent', from: '20260924100000_garment_colours.sql', replaces: [[
    "    or target.garment_length not in ('cropped','short','regular','long') then",
    "    or target.garment_length not in ('cropped','short','regular','long')\n    or not private.garment_type_allowed(target.category,target.garment_type) then"]] },
  { fn: 'public.complete_image_change', from: '20260922020000_checked_image_changes.sql', header: 'create function', replaces: [[
    'garment_length=target.garment_length,\n    brand=target.brand', 'garment_length=target.garment_length,garment_type=target.garment_type,\n    brand=target.brand']] },
  { fn: 'private.reserve_analyzed_item_save_v10', from: '20261101080000_persistent_ai_availability.sql', replaces: [[OBSERVED_OLD, OBSERVED_NEW]] },
  { fn: 'private.reserve_image_change', from: '20261101080000_persistent_ai_availability.sql', replaces: [[OBSERVED_OLD, OBSERVED_NEW]] },
  { fn: 'public.reserve_restored_item_save', from: '20260925110000_restore_item_save.sql', header: 'create function', replaces: [[
    "observed constant text[] := array['category','subcategory',", "observed constant text[] := array['category','garment_type','subcategory',"]] },
];

const sqlBody = (sql: string, name: string, header?: 'create function') => {
  const start = `${header ?? 'create or replace function'} ${name}(`;
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  expect(sql.indexOf(start, from + 1), `${start} once`).toBe(-1);
  const to = sql.indexOf('\n$$;\n', from);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to + 5);
};
const once = (text: string, find: string) => { expect(text.split(find), find).toHaveLength(2); };
const countOf = (text: string, find: string) => text.split(find).length - 1;

describe('garment type migration M1 (CAPS1a)', () => {
  it('is one LF transaction that refuses while a checked save is pending, adds the column, check and helper, and writes no data', async () => {
    const sql = await read(M1);
    expect(sql.startsWith('-- CAPS1a')).toBe(true);
    expect(sql).not.toContain('\r');
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql.indexOf('lock table public.items in access exclusive mode;')).toBeLessThan(sql.indexOf('do $pre$'));
    expect(sql.indexOf('do $pre$')).toBeLessThan(sql.indexOf('alter table public.items add column garment_type text;'));
    const pre = sql.slice(sql.indexOf('do $pre$'), sql.indexOf('$pre$;'));
    for (const needle of ["state='reserved'", 'private.item_save_attempts', 'private.image_change_attempts', "raise exception 'garment type: a checked item save"]) {
      expect(pre).toContain(needle);
    }
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').replace(/\$pre\$[\s\S]*?\$pre\$/g, '');
    expect(topLevel).not.toMatch(/\b(insert|update|delete|truncate|drop|grant)\b/i);
    expect(topLevel.match(/\balter table\b/g)).toHaveLength(2);
    expect(topLevel).toContain('revoke all on function private.garment_type_allowed(text,text) from public,anon,authenticated;');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.slice(0, names.indexOf(M1)).every((name) => name < M1)).toBe(true);
    expect(names.indexOf(M1)).toBeGreaterThan(names.indexOf('20261111090000_tryon_prompt_v5.sql'));
    expect([...sql.matchAll(/create (?:or replace )?function ([a-z_0-9.]+)\(/g)].map((match) => match[1]))
      .toEqual(['private.garment_type_allowed', ...M1_TARGETS.map((target) => target.fn)]);
  });

  it('pins the check and the helper to the shared table, one row per category', async () => {
    const sql = await read(M1);
    const check = sql.slice(sql.indexOf('add constraint items_garment_type_pair'), sql.indexOf(');', sql.indexOf('add constraint items_garment_type_pair')));
    const helper = sqlBody(sql, 'private.garment_type_allowed', 'create function');
    for (const category of categories) {
      const codes = garmentTypesByCategory[category];
      expect(check).toContain(`when '${category}' then garment_type in (${list(codes)})`);
      expect(helper).toContain(`when '${category}' then p_type in (${list(codes)})`);
    }
    expect(countOf(check, ' when ')).toBe(categories.length);
    expect(check).toContain('else false end');
    expect(helper).toContain('language sql immutable set search_path');
    expect(sql).toContain(`when 'garment_type' then array[${list(garmentTypes)}]`);
    // The catalog must know the helper is a private internal function with no API grant.
    expect(await readFile(new URL('../../scripts/isolation-catalog.mjs', import.meta.url), 'utf8')).toContain("'garment_type_allowed(text, text)'");
  });

  for (const target of M1_TARGETS) {
    it(`reproduces the active ${target.fn} plus its one stated delta`, async () => {
      const [sql, from] = await Promise.all([read(M1), read(target.from)]);
      let before = sqlBody(from, target.fn, target.header);
      if (target.header) before = before.replace(`${target.header} ${target.fn}(`, `create or replace function ${target.fn}(`);
      for (const [find, replacement] of target.replaces) { once(before, find); before = before.replace(find, () => replacement); }
      expect(sqlBody(sql, target.fn)).toBe(before);
    });
    it(`has no migration between its source and M1 redefining ${target.fn}`, async () => {
      const defines = new RegExp(`create (or replace )?function ${target.fn.replace('.', '\\.')}\\(`);
      const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql') && name > target.from && name < M1).sort();
      for (const name of names) expect(await read(name), name).not.toMatch(defines);
    });
  }

  it('leaves a null garment_type out of both whole-row hashes, so a hash frozen before the column is unchanged', async () => {
    const sql = await read(M1);
    for (const fn of ['private.item_save_fingerprint', 'private.item_save_value_hash']) {
      expect(sqlBody(sql, fn)).toContain("-case when p_item.garment_type is null then 'garment_type' else '' end");
    }
  });
});

describe('garment type migration M2 (CAPS1a)', () => {
  const OLD_LIST = "'azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3')";
  const NEW_LIST = "'azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3','azure-eu-terra-devtest-v4')";
  const SRC = '20261101090000_unreserved_analysis_manifest.sql';
  const FINISH: [string, string][] = [[OLD_LIST, NEW_LIST],
    ["  select * into m from private.ai_execution_manifests where id=e.manifest_id;\n",
      "  select * into m from private.ai_execution_manifests where id=e.manifest_id;\n  -- v4 (prompt 3) carries garment_type as a 15th field; v1 to v3 stay exactly 14.\n  if m.id='azure-eu-terra-devtest-v4' then v_fields := array_append(v_fields,'garment_type'); end if;\n"],
    ["    if e.manifest_id<>'azure-eu-terra-devtest-v3' then\n", "    if e.manifest_id not in ('azure-eu-terra-devtest-v3','azure-eu-terra-devtest-v4') then\n"]];
  const TARGETS: { fn: string; replaces: [string, string][] }[] = [
    { fn: 'public.ai_claim_analysis', replaces: [[OLD_LIST, NEW_LIST]] },
    { fn: 'private.ai_analysis_permitted', replaces: [[OLD_LIST, NEW_LIST]] },
    { fn: 'public.ai_finish_analysis', replaces: FINISH },
    { fn: 'public.ai_status', replaces: [[OLD_LIST, NEW_LIST]] },
    { fn: 'public.complete_analyzed_item_save', replaces: [[OLD_LIST, NEW_LIST]] },
  ];

  it('is one LF transaction that only inserts the v4 manifest and replaces the five analysis functions', async () => {
    const sql = await read(M2);
    expect(sql.startsWith('-- CAPS1a')).toBe(true);
    expect(sql).not.toContain('\r');
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(TARGETS.map((target) => target.fn));
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bcreate function\b|\bdrop\b|\balter\b|\bgrant\b|\brevoke\b|\btruncate\b/);
    const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
    expect(topLevel).not.toMatch(/\b(update|delete)\b/);
    expect(topLevel.match(/insert into /g)).toHaveLength(1);
    expect(topLevel.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(M2)).toBe(names.indexOf(M1) + 1);
  });

  for (const target of TARGETS) {
    it(`reproduces the active ${target.fn} plus its stated deltas`, async () => {
      const [sql, from] = await Promise.all([read(M2), read(SRC)]);
      let before = sqlBody(from, target.fn);
      for (const [find, replacement] of target.replaces) { once(before, find); before = before.replace(find, () => replacement); }
      expect(sqlBody(sql, target.fn)).toBe(before);
    });
    it(`has no migration between BUDGET2 and M2 redefining ${target.fn}`, async () => {
      const defines = new RegExp(`create (or replace )?function ${target.fn.replace('.', '\\.')}\\(`);
      const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql') && name > SRC && name < M2).sort();
      for (const name of names) expect(await read(name), name).not.toMatch(defines);
    });
  }

  it('adds the v4 manifest as v3 with only the prompt version, three digests and the description changed', async () => {
    const [sql, v3sql] = await Promise.all([read(M2), read(SRC)]);
    const row = (text: string) => { const from = text.indexOf('insert into private.ai_execution_manifests values ('); return text.slice(from, text.indexOf('\n);\n', from)); };
    const [v4, v3] = [row(sql), row(v3sql)];
    const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
    const [oldLines, newLines] = [lines(v3), lines(v4)];
    expect(newLines).toHaveLength(oldLines.length);
    expect(digest(AZURE_PROMPT_V4)).toBe('bba797156a82abdbd73e11ef3a4ec288c6b32089559b813a6e372ac10a091dda');
    expect(digest(JSON.stringify(AZURE_SCHEMA_V4))).toBe('d5040738103d55776224239c022e444286628ffff96c68c1667efc03d219dede');
    expect(digest(JSON.stringify(AZURE_SETTINGS_V4))).toBe('beef517a4f64595d1ad4ebc3073eb894a964f55e12b909cb25d60b52b9116af0');
    expect(v4).toContain("'azure-eu-terra-devtest-v4','gpt-5.6-terra-2026-07-09',3,");
    for (const hash of [digest(AZURE_PROMPT_V4), digest(JSON.stringify(AZURE_SCHEMA_V4)), digest(JSON.stringify(AZURE_SETTINGS_V4))]) expect(v4).toContain(`'${hash}'`);
    for (const hash of [digest(AZURE_PROMPT), digest(JSON.stringify(AZURE_SCHEMA)), digest(JSON.stringify(AZURE_SETTINGS_V3))]) expect(v4).not.toContain(hash);
    // The numeric tail is v3's exactly: same rates, envelope, one-micro reservation, limits and date.
    expect(newLines.at(-1)).toBe(oldLines.at(-1));
    expect(newLines.at(-1)).toBe("'USD',440,1980,16384,2048,1,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'");
    const differing = newLines.map((line, index) => [line, oldLines[index]]).filter(([x, y]) => x !== y).length;
    expect(differing).toBe(5); // id and prompt version, three digests, description
  });

  it('pins the Edge profile to the row: same model, controls, notice and limits; one more prompt, schema and prompt version', () => {
    expect(AZURE_SETTINGS_V4.bodyControls).toEqual(AZURE_SETTINGS.bodyControls);
    expect(AZURE_SETTINGS_V4.messages).toEqual(AZURE_SETTINGS.messages);
    expect(AZURE_SETTINGS_V4.noticeRevision).toBe(2);
    expect(AZURE_SETTINGS_V4.limits).toEqual(AZURE_SETTINGS_V3.limits);
    expect(AZURE_SETTINGS_V4.metering).toEqual(AZURE_SETTINGS_V3.metering);
    expect(Object.keys(AZURE_SETTINGS_V4)).toEqual(Object.keys(AZURE_SETTINGS));
    const flat = (value: unknown, path = ''): [string, unknown][] => typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, inner]) => flat(inner, `${path}.${key}`)) : [[path, value]];
    const changed = flat(AZURE_SETTINGS_V4).filter(([key, value]) => JSON.stringify(flat(AZURE_SETTINGS_V3).find(([other]) => other === key)?.[1]) !== JSON.stringify(value));
    expect(changed.map(([key]) => key).sort()).toEqual(['.profileId', '.promptVersion']);
    expect(azureProfileFor('azure-eu-terra-devtest-v4')).toMatchObject({ promptVersion: 3, reservationMicro: '1', spec: AZURE_SPEC_V4 });
    expect(AZURE_PROFILES.find((profile) => profile.manifestId === 'azure-eu-terra-devtest-v3')?.spec).not.toBe(AZURE_SPEC_V4);
  });
});

describe('the v4 analysis prompt and schema (CAPS1a)', () => {
  it('changes the v2 prompt only by 14 -> 15 keys and one garment type sentence; the earlier prompts and schemas are untouched', () => {
    expect(digest(AZURE_PROMPT)).toBe('f936938355042f9620fad74b3da848e1045bb76461a4a6e98a1f2ed8080cec46');
    expect(digest(JSON.stringify(AZURE_SCHEMA))).toBe('36ab5116df2cfce8443c5db0a9a0747e15f8d018e7463b8c2296d98568503d6e');
    expect(/^[\x20-\x7e]*$/.test(AZURE_PROMPT_V4)).toBe(true);
    expect(Buffer.byteLength(AZURE_PROMPT_V4)).toBe(2454);
    expect(AZURE_PROMPT_V4.normalize('NFC')).toBe(AZURE_PROMPT_V4);
    const without = AZURE_PROMPT_V4.replace(/Garment type: .*? Do not infer warmth/, 'Do not infer warmth').replaceAll('15 field keys', '14 field keys');
    expect(without).toBe(AZURE_PROMPT);
    for (const [category, codes] of Object.entries(garmentTypesByCategory)) expect(AZURE_PROMPT_V4).toContain(`${category}: ${codes.join(', ')}`);
    expect(AZURE_PROMPT_V4).toContain('or null when unsure or when none fits');
  });

  it('adds exactly one closed property to the schema: the 32 codes or null, 15 required keys', () => {
    const fields = AZURE_SCHEMA_V4.properties.fields;
    expect(fields.required).toHaveLength(15);
    expect([...fields.required].sort()).toEqual([...AZURE_SCHEMA.properties.fields.required, 'garment_type'].sort());
    expect(Object.keys(fields.properties).sort()).toEqual([...fields.required].sort());
    expect(fields.properties.garment_type).toEqual({ type: ['string', 'null'], enum: [...garmentTypes, null] });
    const rest: Record<string, unknown> = { ...fields.properties };
    delete rest.garment_type;
    expect(rest).toEqual(AZURE_SCHEMA.properties.fields.properties);
    expect(AZURE_SCHEMA_V4.properties.outcome).toEqual(AZURE_SCHEMA.properties.outcome);
    expect(fields.additionalProperties).toBe(false);
    expect(new Set(aiFields).size).toBe(15);
    expect(observedAiFields).toContain('garment_type');
  });

  it('accepts a type only for its category in the shared validator, and drops a mismatched pairing to null before it is stored', () => {
    const facts = (category: unknown, garmentType: unknown) => ({ outcome: 'ready', fields: { category, garment_type: garmentType } });
    expect(validFacts(facts('top', 'shirt'))).toBe(true);
    expect(validFacts(facts('top', null))).toBe(true);
    expect(validFacts(facts('top', 'poncho'))).toBe(false);
    expect(validFacts(facts('top', 5))).toBe(false);
    expect(normalizeGarmentType(facts('top', 'shirt'))).toEqual(facts('top', 'shirt'));
    expect(normalizeGarmentType(facts('outerwear', 'vest'))).toEqual(facts('outerwear', 'vest'));
    expect(normalizeGarmentType(facts('top', 'jeans'))).toEqual(facts('top', null));
    expect(normalizeGarmentType(facts(null, 'shirt'))).toEqual(facts(null, null));
    expect(normalizeGarmentType(facts('top', null))).toEqual(facts('top', null));
    const unclear = { outcome: 'unclear', fields: { category: null, garment_type: null } };
    expect(normalizeGarmentType(unclear)).toEqual(unclear);
  });
});

describe('the guarded manifest switch between v3 and v4 (CAPS1a)', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  it('keeps the BUDGET2 switch text byte for byte and adds a separate explicit one', () => {
    expect(switchControlsSql(owner, 'forward')).not.toContain('prompt_version=');
    expect(switchControlsSql(owner, 'forward')).toContain('c.prompt_version<>2');
    expect(switchControlsSql(owner, 'rollback')).toContain("max_request_micro=4097351");
    expect(switchControlsSql(owner, 'rollback')).not.toContain('target manifest');
  });
  it('v3 -> v4 needs the exact v3 row and an installed v4, writes the manifest, amount and prompt version, and nothing else', () => {
    const forward = switchManifestSql(owner, 'v3', 'v4'), back = switchManifestSql(owner, 'v4', 'v3');
    expect(forward).toContain("c.execution_manifest_id is distinct from 'azure-eu-terra-devtest-v3' or c.max_request_micro<>1\n    or c.prompt_version<>2");
    expect(back).toContain("c.execution_manifest_id is distinct from 'azure-eu-terra-devtest-v4' or c.max_request_micro<>1\n    or c.prompt_version<>3");
    expect(forward).toContain("where id='azure-eu-terra-devtest-v4' and prompt_version=3");
    expect(back).toContain("where id='azure-eu-terra-devtest-v3' and prompt_version=2");
    expect(forward).toContain("update private.ai_controls set execution_manifest_id='azure-eu-terra-devtest-v4',max_request_micro=1,prompt_version=3,");
    expect(back).toContain("update private.ai_controls set execution_manifest_id='azure-eu-terra-devtest-v3',max_request_micro=1,prompt_version=2,");
    for (const text of [forward, back]) {
      expect(text.match(/update private\.ai_controls/g)).toHaveLength(1);
      expect(text).not.toMatch(/activated|notice_revision=|monthly_allowance|consent|ai_enabled/);
      // The same quiescence guards, in the same order, and the BUDGET3 exemption, as the BUDGET2 switch.
      const guards = ['frozen analysed Save', 'unsaved ready analysis', 'request of this account is still alive', 'reserved or held charge exists'];
      let at = 0;
      for (const guard of guards) { const next = text.indexOf(guard, at); expect(next, guard).toBeGreaterThan(at); at = next; }
      expect(text).toContain("e.manifest_id='azure-eu-terra-devtest-v2' and e.anomaly and e.normalized_usage is null");
      expect(text.indexOf('target manifest is not installed')).toBeLessThan(text.indexOf('v_now := clock_timestamp();'));
    }
  });
  it('accepts only v3 and v4 in two different directions and a canonical owner id', () => {
    for (const [from, to] of [['v3', 'v3'], ['v4', 'v4'], ['v2', 'v3'], ['v3', 'v2'], ['v4', 'v5']] as const) {
      expect(() => switchManifestSql(owner, from as 'v3', to as 'v3')).toThrow();
    }
    expect(() => switchManifestSql('not-an-owner', 'v3', 'v4')).toThrow();
    expect(() => switchManifestSql(`${owner}'; drop table x; --`, 'v3', 'v4')).toThrow();
  });
});

describe('the owner-reviewed backfill file (CAPS1a)', () => {
  const file = () => readFile(new URL('../../docs/garment-type-backfill.sql', import.meta.url), 'utf8');
  const parts = async () => {
    const text = await file();
    const one = text.indexOf('-- == PART 1'), two = text.indexOf('-- == PART 2');
    return { text, header: text.slice(0, one), part1: text.slice(one, two), part2: text.slice(two) };
  };
  const functionOf = (part: string) => part.slice(part.indexOf('create function pg_temp.caps_type'), part.indexOf('$f$;', part.indexOf('create function pg_temp.caps_type')) + 4);
  const rules = (part: string) => [...functionOf(part).matchAll(/\((\d+),'([a-z_]+)','([a-z_]+)','(.*)'\)(?:,|\n)/g)]
    .map((match) => ({ ord: Number(match[1]), category: match[2]!, type: match[3]!, re: match[4]! }));
  // PostgreSQL \m and \M (word start and end) as Unicode-aware look-arounds; the pattern text is otherwise shared.
  const emulate = (re: string) => new RegExp(re.replaceAll('\\m', '(?<![\\p{L}\\p{N}_])').replaceAll('\\M', '(?![\\p{L}\\p{N}_])'), 'u');
  const typeOf = async (category: string, title: string, style: string | null = null) => {
    const found = rules((await parts()).part1).filter((rule) => rule.category === category && emulate(rule.re).test(`${title} ${style ?? ''}`.toLowerCase()))
      .sort((a, b) => a.ord - b.ord)[0];
    return found?.type ?? null;
  };

  it('is LF, ends part 1 with a rollback, keeps placeholders out of comments, and has the same rules in both parts', async () => {
    const { text, header, part1, part2 } = await parts();
    expect(text).not.toContain('\r');
    expect(part1).toContain('begin;');
    expect(part1.trimEnd().endsWith('rollback;')).toBe(true);
    expect(part1).not.toMatch(/\b(update|insert|delete)\b[^;]*\bpublic\./i);
    expect(functionOf(part1)).toBe(functionOf(part2));
    expect(functionOf(part1).length).toBeGreaterThan(1000);
    const comments = text.split('\n').filter((line) => line.trimStart().startsWith('--')).join('\n');
    expect(comments).not.toMatch(/<owner>|<reviewed>/);
    expect(header).not.toMatch(/<owner>|<reviewed>/);
    expect(part1.match(/<owner>/g)).toHaveLength(2);
    expect(part2.match(/<owner>/g)).toHaveLength(1);
    expect(part2.match(/<reviewed>/g)).toHaveLength(1);
    expect(part2.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('only proposes types its own category allows, one rule list per category in a fixed order', async () => {
    const found = rules((await parts()).part1);
    expect(found.length).toBeGreaterThan(30);
    for (const rule of found) {
      expect((garmentTypesByCategory as Record<string, readonly string[]>)[rule.category], `${rule.category}/${rule.type}`).toContain(rule.type);
    }
    for (const category of categories) {
      const own = found.filter((rule) => rule.category === category);
      expect(own.length, category).toBeGreaterThan(0);
      expect(own.map((rule) => rule.ord)).toEqual(own.map((_, index) => index + 1));
    }
    expect(new Set(found.map((rule) => `${rule.category}/${rule.type}`)).size).toBe(found.length);
  });

  it.each([
    ['bottom', 'Black jeans shorts', 'shorts'], ['bottom', 'Blue distressed straight-leg jeans', 'jeans'], ['bottom', 'Blue shorts', 'shorts'],
    ['bottom', 'Brown corduroy trousers', 'trousers'], ['bottom', 'Grey drawstring sweat shorts', 'shorts'], ['bottom', 'Grey slim-fit cuffed chinos', 'chinos'],
    ['bottom', 'Khaki chino trousers', 'chinos'], ['bottom', 'Khaki straight-leg trousers', 'trousers'],
    ['footwear', 'Black knit lace-up sneakers', 'sneakers'], ['footwear', 'Grey low-top running sneakers', 'sneakers'], ['footwear', 'White shoes', 'shoes'],
    ['layer', 'Black hoodie', 'hoodie'], ['layer', 'Black sweatshirt', 'sweatshirt'], ['layer', 'Burgundy flannel', 'overshirt'], ['layer', 'Navy single-breasted blazer', 'blazer'],
    ['outerwear', 'Black bomber jacket', 'bomber'], ['outerwear', 'Black puffer vest', 'vest'], ['outerwear', 'Black running jacket', 'jacket'],
    ['outerwear', 'Black shell jacket', 'shell'], ['outerwear', 'Black technical shell jacket', 'shell'], ['outerwear', 'Grey single-breasted overcoat', 'coat'],
    ['outerwear', 'Khaki stand-collar wool-blend coat', 'coat'], ['outerwear', 'Navy down vest', 'vest'], ['outerwear', 'Navy light down jacket', 'puffer'],
    ['outerwear', 'Olive hybrid jacket', 'jacket'], ['outerwear', 'Olive overshirt', 'overshirt'],
    ['top', 'Beige short-sleeve knit polo shirt', 'polo'], ['top', 'Black polo shirt', 'polo'], ['top', 'Black T-shirt', 't_shirt'], ['top', 'Navy T-shirt with Seagull', 't_shirt'],
    ['top', 'Burgundy long-sleeve button-down shirt', 'shirt'], ['top', 'Khaki short-sleeve quarter-zip polo shirt', 'polo'],
    ['top', 'Light blue long-sleeve button-up shirt', 'shirt'], ['top', 'Navy short-sleeve half-zip polo shirt', 'polo'],
    ['top', 'Musta T-paita', 't_shirt'], ['outerwear', 'Musta kuoritakki', 'shell'], ['bottom', 'Mörkblå jeans', 'jeans'], ['layer', 'Grå huvtröja', 'hoodie'],
    ['top', 'Black top', null], ['top', 'Synthetic mystery piece', null], ['top', 'Teesside print', null], ['bottom', 'Black shirt', null], ['footwear', 'Shorts', null],
  ] as const)('reads %s "%s" as %s (a name that says nothing clear stays not set)', async (category, title, expected) => {
    expect(await typeOf(category, title)).toBe(expected);
  });

  it('writes only garment_type, only through the reviewed, unchanged, eligible rows, with the triggers left on', async () => {
    const { part2 } = await parts();
    const update = part2.slice(part2.indexOf('update public.items i set'), part2.indexOf('pg_temp.caps_type(i.category', part2.indexOf('update public.items i set')));
    for (const needle of ['set garment_type=e->>', 'i.version=(e->>', 'i.deleted_at is null', 'i.garment_type is null',
      "coalesce(i.field_provenance->'garment_type'->>'kind','unknown')<>'user'", "m.state='ready'", "s.state='reserved'", "c.state='reserved'",
      'private.item_deletion_claims', 'private.image_change_fenced', 'i.owner_id=v_owner']) expect(update, needle).toContain(needle);
    expect(part2).toContain('is not distinct from e->>');
    expect(part2.match(/\bupdate public\./g)).toHaveLength(1);
    expect(part2).not.toMatch(/disable trigger|session_replication_role|alter table|insert into|delete from/i);
    expect(part2).toContain('for update;');
  });
});
