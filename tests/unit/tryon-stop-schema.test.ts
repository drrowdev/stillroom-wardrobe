import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for VTO-3a (plan rev3, approved by 001cb8ee). The integration and security jobs prove the behaviour;
// these checks keep each replaced body equal to the reviewed VTO-1 body plus only the named insertions.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261004090000_tryon_stop_before_claim.sql';
const BASE = '20261003090000_try_on.sql';
const body = (sql: string, head: string) => {
  const from = sql.indexOf(head);
  expect(from, head).toBeGreaterThan(-1);
  expect(sql.indexOf(head, from + 1), head).toBe(-1);
  const to = sql.indexOf('\n$$;', from);
  expect(to, head).toBeGreaterThan(from);
  return sql.slice(from, to + 4);
};
const once = (text: string, from: string, to: string) => {
  expect(text.split(from).length - 1, from).toBe(1);
  return text.replace(from, to);
};

const CANCEL_OLD = "  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;\n  if t.state='running' then";
const CANCEL_NEW = `  if not found then
    -- VTO-3a: Stop can arrive before the first step has claimed. The marker makes that claim refuse; a repeat Stop
    -- reuses it. At most 60 new markers an hour per owner; over that, Stop is UNAVAILABLE and writes nothing.
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED');
    end if;
    if (select count(*) from private.tryon_chain_stops where owner_id=p.owner_id
        and created_at>v_now-interval '1 hour')>=60 then
      return jsonb_build_object('code','UNAVAILABLE');
    end if;
    insert into private.tryon_chain_stops(owner_id,chain_id,created_at) values(p.owner_id,p_chain_id,v_now);
    return jsonb_build_object('code','CANCELLED');
  end if;
  if t.state='running' then`;
const CLAIM_CHECK = `    -- VTO-3a: a chain stopped before this claim is never created: no usage, slot, chain, attempt or result.
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED','claimed',false);
    end if;
`;
const EXPIRE_PURGE = `  delete from private.tryon_chain_stops where ctid in (select ctid from private.tryon_chain_stops
    where created_at<=v_now-interval '1 day' order by created_at limit p_limit);
  get diagnostics v_s = row_count;
`;

const REPLACED: [string, string, [string, string][]][] = [
  ['public.tryon_cancel', 'create function public.tryon_cancel(', [[CANCEL_NEW, CANCEL_OLD]]],
  ['public.tryon_claim', 'create function public.tryon_claim(', [[`  if v_new then\n${CLAIM_CHECK}`, '  if v_new then\n']]],
  ['public.tryon_expire_due', 'create function public.tryon_expire_due(', [
    ['  v_a integer; v_s integer;\nbegin', '  v_a integer;\nbegin'],
    [`  get diagnostics v_a = row_count;\n${EXPIRE_PURGE}`, '  get diagnostics v_a = row_count;\n'],
    ["'probesPurged',v_a,'stopsPurged',v_s);", "'probesPurged',v_a);"]]],
  ['public.tryon_discard_transient', 'create function public.tryon_discard_transient(', [
    ['v_c integer; v_s integer; n integer := 0;', 'v_c integer; n integer := 0;'],
    ['  delete from private.tryon_chain_stops;\n  get diagnostics v_s = row_count;\n', ''],
    ["'chainsDeleted',v_c,'stopsDeleted',v_s,'expired',n);", "'chainsDeleted',v_c,'expired',n);"]]],
  ['private.deletion_owner_rows_absent', 'create or replace function private.deletion_owner_rows_absent(', [
    ['\n    or exists(select 1 from private.tryon_chain_stops where owner_id=p_owner));', ');']]],
];

describe('try-on Stop before claim migration (VTO-3a)', () => {
  it('is one LF transaction, the last migration, with no drop', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- VTO-3a')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.at(-1)).toBe(MAIN);
    expect(names.at(-2)).toBe('20261003090100_tryon_expire_schedule.sql');
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/\bexport_manifest\b/);
  });

  it('adds one private marker table with RLS, no grants and the owner cascade', async () => {
    const sql = await read(MAIN);
    const start = sql.indexOf('create table private.tryon_chain_stops (');
    const table = sql.slice(start, sql.indexOf('\n);', start));
    expect(sql).toContain(`create table private.tryon_chain_stops (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  chain_id uuid not null,
  created_at timestamptz not null,
  primary key(owner_id,chain_id)
);`);
    expect(table).not.toMatch(/person|body|outfit|jpeg|sha256/);
    expect(sql).toContain('alter table private.tryon_chain_stops enable row level security;');
    expect(sql).toContain('revoke all on private.tryon_chain_stops from public,anon,authenticated,service_role;');
    expect([...sql.matchAll(/create table ([a-z_.]+)/g)].map((match) => match[1])).toEqual(['private.tryon_chain_stops']);
  });

  it('replaces exactly five functions, each the reviewed body plus only the named insertions', async () => {
    const sql = await read(MAIN);
    const base = await read(BASE);
    expect([...sql.matchAll(/create (?:or replace )?function ([a-z_.]+)\(/g)].map((match) => match[1]))
      .toEqual(REPLACED.map(([name]) => name));
    expect(sql).not.toMatch(/(?<!or replace )\bcreate function\b/);
    for (const [name, head, insertions] of REPLACED) {
      let restored = body(sql, `create or replace function ${name}(`);
      for (const [now, before] of insertions) restored = once(restored, now, before);
      expect(restored.replace('create or replace function ', 'create function '), name)
        .toBe(body(base, head).replace('create or replace function ', 'create function '));
      expect(restored, name).not.toContain('tryon_chain_stops');
    }
  });

  it('checks the marker first in the new-chain branch, before any row is written', async () => {
    const claim = body(await read(MAIN), 'create or replace function public.tryon_claim(');
    const branch = claim.indexOf('  if v_new then\n');
    const check = claim.indexOf('from private.tryon_chain_stops', branch);
    expect(check).toBeGreaterThan(branch);
    expect(claim.indexOf('  if v_new then\n')).toBe(claim.lastIndexOf('  if v_new then\n', check));
    const firstInsert = claim.search(/\binsert into\b/);
    expect(check).toBeLessThan(firstInsert);
    expect(claim.slice(branch, check)).not.toMatch(/\b(insert|update|delete|perform)\b/);
    expect(claim).toContain('for update nowait');
  });

  it('caps new markers, reuses an existing one and never replies NOT_FOUND for a missing chain', async () => {
    const cancel = body(await read(MAIN), 'create or replace function public.tryon_cancel(');
    const branch = cancel.slice(cancel.indexOf('  if not found then\n    -- VTO-3a'), cancel.indexOf("  if t.state='running' then"));
    expect(branch.indexOf('if exists(')).toBeLessThan(branch.indexOf('>=60 then'));
    expect(branch.indexOf('>=60 then')).toBeLessThan(branch.indexOf('insert into private.tryon_chain_stops'));
    expect(branch).not.toContain('NOT_FOUND');
    expect(cancel.match(/'NOT_FOUND'/g)).toHaveLength(1);
    expect(cancel).toContain("if p_chain_id is null then return jsonb_build_object('code','NOT_FOUND'); end if;");
    expect(cancel).toContain("select * into p from public.profiles where owner_id=auth.uid() for update;");
  });
});
