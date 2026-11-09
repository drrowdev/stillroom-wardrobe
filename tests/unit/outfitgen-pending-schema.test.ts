import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const FORWARD = '20261109090000_outfitgen_pending_100.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');

// Each replaced function, the migration that held its latest body before this one, and the single cap line that changes.
const FUNCTIONS = [
  { name: 'public.outfitgen_claim', before: '20261108100000_outfitgen_call_limits.sql',
    oldCap: "where owner_id=p.owner_id and state='suggested')>=40", newCap: "where owner_id=p.owner_id and state='suggested')>=100" },
  { name: 'public.outfitgen_undo_remove', before: '20261107090000_outfitgen_undo_capacity.sql',
    oldCap: "where owner_id=v_owner and state='suggested')>=40", newCap: "where owner_id=v_owner and state='suggested')>=100" },
  { name: 'public.outfitgen_plan', before: '20261106090000_outfit_generation.sql',
    oldCap: "'pendingRoom',greatest(0,40-(select count(*)", newCap: "'pendingRoom',greatest(0,100-(select count(*)" },
  { name: 'private.outfitgen_record', before: '20261106090000_outfit_generation.sql',
    oldCap: 'select 40-count(*) into v_room', newCap: 'select 100-count(*) into v_room' },
] as const;

// From the function name through the closing $$ (signature, attributes and body).
const definition = (sql: string, name: string) => {
  const start = sql.indexOf(`function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start), close = sql.indexOf('$$', open + 2);
  return sql.slice(start, close + 2);
};
const count = (text: string, part: string) => text.split(part).length - 1;

describe('pending cap of 100 (OUTFITGEN-PENDING100; source proofs, the SQL itself runs in the CI rehearsal)', () => {
  for (const entry of FUNCTIONS) {
    it(`${entry.name} is its latest body with only the cap literal changed`, async () => {
      const before = definition(await read(entry.before), entry.name);
      const after = definition(await read(FORWARD), entry.name);
      expect(count(before, entry.oldCap)).toBe(1);
      expect(count(after, entry.newCap)).toBe(1);
      expect(after).not.toContain(entry.oldCap);
      // Signature, attributes, locks, every check, every insert and the response shape are identical.
      expect(after.replace(entry.newCap, entry.oldCap)).toBe(before);
    });
  }

  it('keeps the attributes that carry the owner, the security and the grants', async () => {
    const sql = await read(FORWARD);
    for (const entry of FUNCTIONS) {
      const before = definition(await read(entry.before), entry.name);
      const after = definition(sql, entry.name);
      const header = (text: string) => text.slice(0, text.indexOf('$$'));
      expect(header(after)).toBe(header(before));
      expect(header(after)).toContain('security definer set search_path');
    }
  });

  it('replaces exactly these four functions, was the latest definition of each until the judge migration and changes nothing else', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql') && name <= FORWARD).sort();
    expect(names.at(-1)).toBe(FORWARD);
    const sql = await read(FORWARD);
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code.trimStart().startsWith('begin;')).toBe(true);
    expect(code.trimEnd().endsWith('commit;')).toBe(true);
    expect([...code.matchAll(/^(create|alter|drop|grant|revoke|insert|update|delete)\b/gim)].map((match) => match[1]!.toLowerCase()))
      .toEqual(['create', 'create', 'create', 'create']);
    expect([...code.matchAll(/^create or replace function ([a-z_.]+)\(/gm)].map((match) => match[1])).toEqual([
      'public.outfitgen_plan', 'public.outfitgen_claim', 'private.outfitgen_record', 'public.outfitgen_undo_remove']);
    expect(code.match(/\$\$/g)).toHaveLength(8);
    expect(sql).not.toMatch(/\$mig\$|\$w\$|\r|cron\./);
    // The judge migration (OUTFITGEN-QUALITY1) later replaces the claim and the plan; the other two stay as this migration left them.
    const later: Record<string, string> = { 'public.outfitgen_claim': '20261109100000_outfitgen_judge_v2.sql', 'public.outfitgen_plan': '20261109100000_outfitgen_judge_v2.sql' };
    for (const entry of FUNCTIONS) {
      let last = '';
      for (const name of (await readdir(DIR)).filter((file) => file.endsWith('.sql')).sort()) if ((await read(name)).includes(`function ${entry.name}(`)) last = name;
      expect(last, entry.name).toBe(later[entry.name] ?? FORWARD);
    }
  });

  it('leaves the earlier migrations, which hold the cap of 40 as history, untouched', async () => {
    expect(definition(await read('20261108100000_outfitgen_call_limits.sql'), 'public.outfitgen_claim')).toContain(FUNCTIONS[0].oldCap);
    expect(definition(await read('20261107090000_outfitgen_undo_capacity.sql'), 'public.outfitgen_undo_remove')).toContain(FUNCTIONS[1].oldCap);
    const original = await read('20261106090000_outfit_generation.sql');
    expect(definition(original, 'public.outfitgen_plan')).toContain(FUNCTIONS[2].oldCap);
    expect(definition(original, 'private.outfitgen_record')).toContain(FUNCTIONS[3].oldCap);
  });
});
