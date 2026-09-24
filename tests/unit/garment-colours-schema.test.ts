import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { colours } from '../../src/domain/preferences';
import { AZURE_PROMPT, AZURE_SCHEMA, AZURE_SETTINGS } from '../../supabase/functions/analyze-clothing/azure-openai';

// Source reconstruction, not live PostgreSQL proof: each replaced body equals its latest predecessor
// with exactly one reviewed substitution.
const read = (name: string) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const V1 = "'azure-eu-terra-devtest-v1'", V2 = "'azure-eu-terra-devtest-v2'", BOTH = `(${V1},${V2})`;
const OLD = "'black','white','grey','navy','blue','green','olive','beige','brown','red','yellow','orange','pink','purple'";
const NEW = colours.map((code) => `'${code}'`).join(',');
const M1 = '20260924100000_garment_colours.sql', M2 = '20260924100100_azure_colour_manifest.sql';
const AZ = '20260921193000_azure_terra_analysis.sql';

function extract(source: string, name: string) {
  const starts = [...source.matchAll(new RegExp(`^create (or replace )?function ${name.replace('.', '\\.')}\\(`, 'gm'))];
  expect(starts, name).toHaveLength(1);
  const start = starts[0]!.index, end = source.indexOf('\n$$;\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 4).replace(/^create function /, 'create or replace function ');
}
function substitute(body: string, from: string, to: string) {
  expect(body.split(from).length - 1, from).toBe(1);
  return body.replace(from, to);
}
// Remove comments, quoted strings and dollar-quoted bodies before top-level DML checks.
const topLevel = (sql: string) => sql.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').replace(/'(?:[^']|'')*'/g, "''")
  .replace(/--[^\n]*/g, '');

describe('COL1 colour migration (T-SQL1)', () => {
  it('uses the shared 21-code order with every earlier code retained', () => {
    expect(colours).toEqual(['black', 'white', 'cream', 'grey', 'navy', 'blue', 'light_blue', 'teal', 'green', 'olive',
      'khaki', 'beige', 'brown', 'burgundy', 'red', 'yellow', 'orange', 'pink', 'purple', 'gold', 'silver']);
    for (const code of OLD.replaceAll("'", '').split(',')) expect(colours).toContain(code);
  });
  it('rebuilds M1 byte-for-byte from the three latest validator bodies', async () => {
    const [controls, analyzed, images, m1] = await Promise.all([read('20260909180000_ai_request_controls.sql'),
      read('20260911200000_checked_ai_item_save.sql'), read('20260922020000_checked_image_changes.sql'), read(M1)]);
    const expected = ['-- COL1 garment colours: widen code checks only. No data change; existing values stay valid.',
      'begin;', '',
      substitute(extract(controls, 'private.ai_valid_facts'), OLD, NEW), '',
      substitute(extract(analyzed, 'private.reserve_item_save'), OLD, NEW), '',
      substitute(extract(images, 'private.image_change_intent'), OLD, NEW), '',
      'commit;', ''].join('\n');
    expect(m1).toBe(expected);
    expect(m1).not.toContain('\r');
    expect(m1.split(`${NEW},'unknown'`)).toHaveLength(3);
    expect(m1).toContain(`when 'colours' then array[${NEW}]`);
    expect(Buffer.byteLength(m1)).toBeLessThanOrEqual(29668);
  });
  it('rebuilds M2 byte-for-byte: one v2 manifest row and four v1-or-v2 acceptance edits', async () => {
    const [az, m2] = await Promise.all([read(AZ), read(M2)]);
    const start = az.indexOf('insert into private.ai_execution_manifests values (');
    const v1 = az.slice(start, az.indexOf('\n);\n', start) + 3);
    let row = substitute(v1, `${V1},'gpt-5.6-terra-2026-07-09',1,`, `${V2},'gpt-5.6-terra-2026-07-09',2,`);
    row = substitute(row, 'fd0218f1e71b7902af437cb58f17c724883c78f3d76d085ca8bbb1cea0eb25ff', sha256(AZURE_PROMPT));
    row = substitute(row, '84d87dca033cc587c6cae54cc8a0a2936f3dabefa0ab18fb4c3ee03467cc8ff1', sha256(JSON.stringify(AZURE_SCHEMA)));
    row = substitute(row, '8a4eef8a47549d57d2466148efee37ebaeed57beb6a046c5a464e977da15eb88', sha256(JSON.stringify(AZURE_SETTINGS)));
    row = substitute(row, "  'INACTIVE existing DEV/TEST", "  'v2 of azure-eu-terra-devtest-v1: colour vocabulary and prompt only (24 Sep 2026); tariff evidence not re-retrieved. INACTIVE existing DEV/TEST");
    const expected = ['-- COL1 Azure v2 manifest: new colour enum and prompt. v1 unchanged; no controls, consent or allowance change.',
      'begin;', '', row, '',
      substitute(extract(az, 'public.ai_claim_analysis'), `and id=${V1};`, `and id in ${BOTH};`), '',
      substitute(extract(az, 'private.ai_analysis_permitted'), `m.id in ('google-eu-3.8-v1',${V1})`, `m.id in ('google-eu-3.8-v1',${V1},${V2})`), '',
      substitute(extract(az, 'public.ai_finish_analysis'), `if e.manifest_id<>${V1} or`, `if e.manifest_id not in ${BOTH} or`), '',
      substitute(extract(az, 'public.complete_analyzed_item_save'), `case when a.manifest_id=${V1} then`, `case when a.manifest_id in ${BOTH} then`), '',
      'commit;', ''].join('\n');
    expect(m2).toBe(expected);
    expect(m2).not.toContain('\r');
    expect(row).toContain("'2026-10-21T00:00:00Z'");
    expect(row.slice(row.indexOf("'USD',"))).toBe(v1.slice(v1.indexOf("'USD',")));
    expect(Buffer.byteLength(m2)).toBeLessThanOrEqual(29668);
  });
});

describe('COL1 top-level statements (T-SQL2)', () => {
  it('adds no data change beyond the single v2 manifest insert', async () => {
    for (const [name, inserts] of [[M1, 0], [M2, 1]] as const) {
      const sql = topLevel(await read(name));
      expect(sql.match(/\binsert into\b/gi) ?? [], name).toHaveLength(inserts);
      expect(sql, name).not.toMatch(/\b(?:update|delete|truncate|alter table|drop|grant|revoke|create table|create trigger)\b/i);
      expect(sql.match(/\bcreate or replace function\b/g), name).toHaveLength(name === M1 ? 3 : 4);
    }
    const m2 = await read(M2);
    expect(m2.match(/azure-eu-terra-devtest-v2/g)).toHaveLength(5);
    expect(m2).toContain("insert into private.ai_execution_manifests values (\n  'azure-eu-terra-devtest-v2','gpt-5.6-terra-2026-07-09',2,");
  });
});
