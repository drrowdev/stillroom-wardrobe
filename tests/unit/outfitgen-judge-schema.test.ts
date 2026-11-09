import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OUTFITGEN_V1_PROMPT, OUTFITGEN_V1_SCHEMA_JSON, OUTFITGEN_V1_SETTINGS_JSON } from '../fixtures/outfitgen-v1-frozen';
import { OUTFITGEN_LIMITS, OUTFITGEN_MANIFEST, OUTFITGEN_MANIFEST_V1, OUTFITGEN_MODEL, OUTFITGEN_PROMPT, OUTFITGEN_PROMPT_VERSION,
  OUTFITGEN_RESERVATION_MICRO, OUTFITGEN_SCHEMA, OUTFITGEN_SETTINGS } from '../../src/domain/outfitgen';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const FORWARD = '20261109100000_outfitgen_judge_v2.sql';
const BEFORE = '20261109090000_outfitgen_pending_100.sql';
const ORIGINAL = '20261106090000_outfit_generation.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const definition = (sql: string, name: string) => {
  const start = sql.indexOf(`function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start), close = sql.indexOf('$$', open + 2);
  return sql.slice(start, close + 2);
};
const count = (text: string, part: string) => text.split(part).length - 1;
const header = (text: string) => text.slice(0, text.indexOf('$$'));

const CLAIM_PIN = { from: "m.id<>'azure-eu-terra-outfitgen-v1' then", to: "m.id not in ('azure-eu-terra-outfitgen-v1','azure-eu-terra-outfitgen-v2') then" };
const SEEN_BLOCK = `  select coalesce(jsonb_agg(jsonb_build_array(q.state,q.base,q.garments) order by q.state desc,q.created_at desc,q.id),'[]'::jsonb) into v_seen from (
    select s.state,s.created_at,s.id,
      coalesce((select jsonb_agg(i.id order by i.id) from public.items i where i.owner_id=s.owner_id and i.id=any(s.item_ids)
        and i.category in ('top','bottom','one_piece')),'[]'::jsonb) base,
      coalesce((select jsonb_agg(i.id order by i.id) from public.items i where i.owner_id=s.owner_id and i.id=any(s.item_ids)
        and i.category<>'footwear'),'[]'::jsonb) garments
    from public.suggested_outfits s where s.owner_id=p_owner_id and (s.state='suggested' or s.id in (
      select k.id from public.suggested_outfits k where k.owner_id=p_owner_id and k.state='kept' order by k.created_at desc,k.id limit 200))) q;
`;
const PLAN_EDITS = [
  { from: 'v_disliked jsonb; v_known jsonb;\n', to: 'v_disliked jsonb; v_known jsonb; v_seen jsonb;\n' },
  { from: '    limit 20000) k;\n', to: `    limit 20000) k;\n${SEEN_BLOCK}` },
  { from: "'known',v_known,\n", to: "'known',v_known,'seen',v_seen,\n" },
];

describe('judge manifest v2 pins (OUTFITGEN-QUALITY1; source proofs, the SQL itself runs in the CI rehearsal)', () => {
  it('keeps the frozen v1 prompt, schema and settings bytes pinned to the original manifest row', async () => {
    const sql = await read(ORIGINAL);
    for (const value of [hash(OUTFITGEN_V1_PROMPT), hash(OUTFITGEN_V1_SCHEMA_JSON), hash(OUTFITGEN_V1_SETTINGS_JSON)]) expect(sql).toContain(`'${value}'`);
    expect(sql).toContain(`'${OUTFITGEN_MANIFEST_V1}','${OUTFITGEN_MODEL}',1,`);
    expect(OUTFITGEN_PROMPT).not.toBe(OUTFITGEN_V1_PROMPT);
  });

  it('records the live prompt, schema and settings hashes in the v2 manifest row, and nothing else of the row changed from v1', async () => {
    const sql = await read(FORWARD), original = await read(ORIGINAL);
    for (const value of [hash(OUTFITGEN_PROMPT), hash(JSON.stringify(OUTFITGEN_SCHEMA)), hash(JSON.stringify(OUTFITGEN_SETTINGS))]) expect(sql).toContain(`'${value}'`);
    expect(OUTFITGEN_MANIFEST).toBe('azure-eu-terra-outfitgen-v2');
    expect(OUTFITGEN_PROMPT_VERSION).toBe(2);
    expect(OUTFITGEN_SETTINGS).toMatchObject({ profileId: OUTFITGEN_MANIFEST, promptVersion: 2, schemaVersion: 2 });
    expect(sql).toContain(`'${OUTFITGEN_MANIFEST}','${OUTFITGEN_MODEL}',2,`);
    // The tariff, envelope, reservation, limits and review date are the v1 row's, character for character.
    const tail = (text: string) => /\n {2}('USD',[^\n]+)\n\);/.exec(text.slice(text.indexOf('insert into private.ai_execution_manifests')))?.[1];
    expect(tail(sql)).toBeDefined();
    expect(tail(sql)).toBe(tail(original));
    expect(tail(sql)).toContain(`,${OUTFITGEN_RESERVATION_MICRO},512000,1600,262144,32768,${OUTFITGEN_LIMITS.requestMs / 1000},`);
    const middle = (text: string) => /'Azure OpenAI',[^\n]+\n {2}'https:[^\n]+\n {2}'2026[^\n]+\n/.exec(text)?.[0];
    expect(middle(sql)).toBeDefined();
    expect(middle(sql)).toBe(middle(original));
  });

  it('keeps the quality bar and the notice revision where they were, so nobody consents again', () => {
    expect(OUTFITGEN_SETTINGS.noticeRevision).toBe(2);
    expect(OUTFITGEN_SETTINGS.limits.scoreBar).toBe(8);
    expect(OUTFITGEN_SETTINGS.metering.reservationMicro).toBe('373402');
  });
});

describe('judge migration (source proofs)', () => {
  it('is the latest claim body with only the manifest pin changed to v1-or-v2', async () => {
    const before = definition(await read(BEFORE), 'public.outfitgen_claim');
    const after = definition(await read(FORWARD), 'public.outfitgen_claim');
    expect(count(before, CLAIM_PIN.from)).toBe(1);
    expect(count(after, CLAIM_PIN.to)).toBe(1);
    expect(after).not.toContain(CLAIM_PIN.from);
    expect(after.replace(CLAIM_PIN.to, CLAIM_PIN.from)).toBe(before);
    expect(header(after)).toBe(header(before));
    expect(header(after)).toContain('security definer set search_path');
  });

  it('is the latest plan body with only the seen key added, and the key is read-only and bounded', async () => {
    const before = definition(await read(BEFORE), 'public.outfitgen_plan');
    const after = definition(await read(FORWARD), 'public.outfitgen_plan');
    let reverted = after;
    for (const edit of PLAN_EDITS) {
      expect(count(before, edit.from), edit.from).toBe(1);
      expect(count(after, edit.to), edit.to).toBe(1);
      reverted = reverted.replace(edit.to, edit.from);
    }
    expect(reverted).toBe(before);
    expect(header(after)).toBe(header(before));
    // Every waiting suggestion, whatever the kept bound; kept ones newest 200 (best effort); each as its base and its garments except shoes,
    // read from public.items so no candidate-pool truncation can hide a garment. Removed sets are already in `disliked`.
    expect(SEEN_BLOCK).toContain("s.state='suggested' or s.id in (");
    expect(SEEN_BLOCK).toContain("k.state='kept' order by k.created_at desc,k.id limit 200");
    expect(SEEN_BLOCK).toContain("i.category in ('top','bottom','one_piece')");
    expect(SEEN_BLOCK).toContain("i.category<>'footwear'");
    expect(SEEN_BLOCK).not.toContain("'removed'");
    expect(SEEN_BLOCK).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it('replaces exactly these two functions, adds exactly one manifest row, and writes no controls, consent or other state', async () => {
    const sql = await read(FORWARD);
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code.trimStart().startsWith('begin;')).toBe(true);
    expect(code.trimEnd().endsWith('commit;')).toBe(true);
    expect([...code.matchAll(/^(create|alter|drop|grant|revoke|insert|update|delete)\b/gim)].map((match) => match[1]!.toLowerCase()))
      .toEqual(['insert', 'create', 'create']);
    expect([...code.matchAll(/^create or replace function ([a-z_.]+)\(/gm)].map((match) => match[1])).toEqual(['public.outfitgen_claim', 'public.outfitgen_plan']);
    expect(code.match(/^insert into ([a-z_.]+)/gm)).toEqual(['insert into private.ai_execution_manifests']);
    // Neither the account controls nor consent are written; the migration only reads them for its own proof.
    expect(code).not.toMatch(/\b(update|delete from|insert into) +private\.ai_controls/i);
    expect(sql).not.toMatch(/\$mig\$|\$w\$|\r|cron\./);
    for (const name of ['public.outfitgen_claim', 'public.outfitgen_plan']) {
      let last = '';
      for (const file of (await readdir(DIR)).filter((entry) => entry.endsWith('.sql')).sort()) if ((await read(file)).includes(`function ${name}(`)) last = file;
      expect(last, name).toBe(FORWARD);
    }
  });

  it('proves its own result inside the transaction: the installed bodies, the controls and the v1 row', async () => {
    const sql = await read(FORWARD);
    for (const part of ["outfitgen_quality1.claim", "outfitgen_quality1.plan", "outfitgen_quality1.controls", "outfitgen_quality1.v1_row",
      'is distinct from current_setting', "azure-eu-terra-outfitgen-v2' and prompt_version=2", 'v2 differs from v1 beyond the stated columns']) expect(sql).toContain(part);
    expect(sql.indexOf("set_config('outfitgen_quality1.claim'")).toBeLessThan(sql.indexOf('create or replace function public.outfitgen_claim('));
    expect(sql.indexOf('create or replace function public.outfitgen_plan(')).toBeLessThan(sql.indexOf('postcondition: the claim differs'));
  });

  it('leaves the earlier definitions in place as history', async () => {
    expect(definition(await read(BEFORE), 'public.outfitgen_claim')).toContain("m.id<>'azure-eu-terra-outfitgen-v1'");
    expect(definition(await read(ORIGINAL), 'public.outfitgen_plan')).not.toContain('v_seen');
  });
});

describe('guarded manifest switch (docs/outfitgen-manifest-switch.sql)', () => {
  const guard = () => readFile(new URL('../../docs/outfitgen-manifest-switch.sql', import.meta.url), 'utf8');
  it('is one transaction that takes the claim\'s locks in the claim\'s order, validates, refuses held work and only then writes the manifest', async () => {
    const sql = await guard();
    expect(sql).not.toMatch(/\r/);
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code.trimStart().startsWith('begin;')).toBe(true);
    expect(code.trimEnd().endsWith('commit;')).toBe(true);
    expect(code).toContain("set local lock_timeout = '10s';");
    const order = ['from public.profiles where owner_id=v_owner for update', 'from private.ai_controls where owner_id=v_owner for update',
      'c.outfitgen_manifest_id is distinct from v_from', "from private.ai_execution_manifests where id=v_to", "charge_state in ('reserved','held')",
      'update private.ai_controls set outfitgen_manifest_id=v_to'].map((part) => code.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The claim takes the profile row and then the controls row: the same order, so the two never wait on each other in a cycle.
    const claim = definition(await read(FORWARD), 'public.outfitgen_claim');
    expect(claim.indexOf('from public.profiles where owner_id=p_owner_id for update nowait')).toBeLessThan(claim.indexOf('from private.ai_controls where owner_id=p_owner_id for update nowait'));
    expect(code.match(/^\s*update /gm)).toHaveLength(1);
    expect(sql.match(/'<(owner|from|to)>'/g)).toHaveLength(3);
    expect(code).not.toMatch(/consent|notice_revision|reserved_micro/);
  });
});

describe('re-judge reset (docs/outfitgen-rejudge-reset.sql, OUTFITGEN-QUALITY2)', () => {
  const reset = () => readFile(new URL('../../docs/outfitgen-rejudge-reset.sql', import.meta.url), 'utf8');
  it('is one transaction in the claim\'s lock order that refuses held work and then deletes only the owner\'s declined rows of the installed version and the assessed markers', async () => {
    const sql = await reset();
    expect(sql).not.toMatch(/\r/);
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    const script = code.slice(0, code.indexOf('commit;') + 'commit;'.length);
    expect(script.trimStart().startsWith('begin;')).toBe(true);
    expect(code).toContain("set local lock_timeout = '10s';");
    const order = ['from public.profiles where owner_id=v_owner for update', 'from private.ai_controls where owner_id=v_owner for update',
      'from private.ai_execution_manifests m where m.id=c.outfitgen_manifest_id', "charge_state in ('reserved','held')",
      "delete from public.suggested_outfits where owner_id=v_owner and state='declined' and prompt_version=v_version and score>=v_min",
      'delete from private.outfit_assessed_items where owner_id=v_owner'].map((part) => code.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script.match(/^\s*(delete|update|insert) /gm)).toHaveLength(2);
    expect(script).not.toMatch(/consent|ai_controls\s+set|ai_usage\s+set|state in \('suggested'|state='(suggested|kept|removed)'/);
    expect(sql.match(/<min_score>/g)?.length).toBeGreaterThanOrEqual(1);
    // The read-back after the commit is counts only: no titles, reasons or ids are selected.
    const readBack = code.slice(code.indexOf('commit;'));
    expect(readBack).not.toMatch(/title|reason|item_ids|\bid\b/);
  });
});
