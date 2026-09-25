import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source checks only. The CI database, security and deletion-rehearsal jobs prove the behaviour.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const NAME = '20260925120000_account_deletion.sql';
const SCHEDULE = '20260925120100_deletion_receipt_purge_schedule.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const between = (sql: string, start: string, end: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  return sql.slice(from, sql.indexOf(end, from));
};

describe('account deletion migration', () => {
  it('checks every owner-keyed table before marking rows removed', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    const owned = new Set<string>();
    for (const name of names) {
      for (const match of (await read(name)).matchAll(/create table ((?:public|private)\.\w+)\s*\(([\s\S]*?)\n\);/g)) {
        if (/\bowner_id\b/.test(match[2]!)) owned.add(match[1]!);
      }
    }
    owned.delete('private.deletion_jobs');
    const absent = between(await read(NAME), 'create function private.deletion_owner_rows_absent', '$$;\n');
    const checked = new Set([...absent.matchAll(/from ((?:public|private)\.\w+) where owner_id=p_owner/g)].map((match) => match[1]!));
    expect([...checked].sort()).toEqual([...owned].sort());
  });

  it('moves to `rows` before deleting, checks absence, then moves to `auth`, with no exception handler', async () => {
    const block = between(await read(NAME), "elsif p_action='storage_removed' then", 'else -- auth_removed');
    const at = (text: string) => block.indexOf(text);
    expect(at("message='Remove files first'")).toBeLessThan(at("set stage='rows'"));
    expect(at("set stage='rows'")).toBeLessThan(at('delete from private.item_deletion_claims'));
    expect(at('delete from private.item_deletion_claims')).toBeLessThan(at('delete from public.items'));
    expect(at('delete from public.profiles')).toBeLessThan(at('private.deletion_owner_rows_absent'));
    expect(at('private.deletion_owner_rows_absent')).toBeLessThan(at("set stage='auth'"));
    expect(block).not.toMatch(/\bexception\s+when\b/);
    expect(block).toContain('a.enabled');
  });

  it('locks the admission row before the job and binds mutations to the admission generation', async () => {
    const body = between(await read(NAME), 'create function public.deletion_control', '$$;\n');
    expect(body.indexOf('from private.approved_accounts where admission_no=n for no key update'))
      .toBeLessThan(body.indexOf('from private.deletion_jobs where owner_id=p_owner_id for update'));
    expect(body.match(/delete from private\.approved_accounts\s+where admission_no=j\.admission_no and generation=j\.admission_generation and user_id is null/g))
      .toHaveLength(2);
    expect(body).not.toMatch(/email/);
    expect(body).toContain("j.lease_id=p_op and j.lease_until>now()");
    expect(body).toContain("if j.attempts>=10 then raise exception using errcode='P0001',message='Retry limit'");
    const reconcile = between(body, "if p_action='reconcile' then", "if p_action='grant' then");
    expect(reconcile).not.toContain('attempts');
    expect(reconcile).toContain('exists(select 1 from auth.users where id=p_owner_id)');
  });

  it('replaces the old control, grants only the service role and keeps private helpers private', async () => {
    const sql = await read(NAME);
    expect(sql).toContain('drop function public.deletion_control(uuid,text,text);');
    expect(sql).toContain('revoke all on function public.deletion_control(uuid,text,uuid,text) from public,anon,authenticated;\n'
      + 'grant execute on function public.deletion_control(uuid,text,uuid,text) to service_role;');
    expect(sql).toContain('revoke all on function public.purge_deletion_receipts() from public,anon,authenticated;\n'
      + 'grant execute on function public.purge_deletion_receipts() to service_role;');
    expect(sql).toMatch(/revoke all on function private\.rotate_admission_generation\(\),private\.deletion_receipt\(private\.deletion_jobs\),\n {2}private\.deletion_owner_rows_absent\(uuid\),private\.release_deleted_admission\(\)\n {2}from public,anon,authenticated,service_role;/);
    expect(sql.match(/\bgrant execute\b/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\bimmutable\b/i);
    expect(sql).toContain("interval '7 days'");
  });

  it('exposes only a parameterless, read-only status of the caller\'s own job to signed-in owners', async () => {
    const sql = await read(NAME);
    const body = between(sql, 'create function public.deletion_status', '$$;\n');
    expect(body).toContain('language sql stable security definer');
    expect(body).toContain('public.deletion_status() returns jsonb');
    expect(body).toContain('j.owner_id=u.uid');
    expect(body).toContain('auth.uid()');
    expect(body).not.toMatch(/\b(?:insert|update|delete)\b|p_owner|email|admission/);
    expect(sql).toContain('revoke all on function public.deletion_status() from public,anon;\n'
      + 'grant execute on function public.deletion_status() to authenticated;');
  });

  it('releases admission only inside the Auth delete and only for the recorded generation', async () => {
    const sql = await read(NAME);
    expect(sql).toContain('create trigger stillroom_release_admission before delete on auth.users\nfor each row execute function private.release_deleted_admission();');
    const body = between(sql, 'create function private.release_deleted_admission', '$$;\n');
    expect(body).toContain("j.stage='auth'");
    expect(body).toContain('j.admission_generation=a.generation');
    // Q2: the Auth delete waits for a held admission row, bounded by a function-local lock timeout.
    expect(body).toContain("set search_path = '' set lock_timeout = '5s' as $$");
    expect(body).toContain('from private.approved_accounts where user_id=old.id for update;');
    expect(body).not.toMatch(/nowait/i);
  });

  it('lets the frozen-owner Storage exception apply only to the service role at `storage` for a disabled, bound owner', async () => {
    const branch = between(await read(NAME), '-- P6c:', "  if tg_op='DELETE' then object := old;");
    for (const condition of ["tg_op='DELETE'", "'role','')='service_role'", "storage.allow_only_operation('storage.object.delete')",
      "fj.stage='storage'", 'fa.enabled=false', 'fa.user_id=fu', 'fj.admission_generation=fa.generation']) {
      expect(branch, condition).toContain(condition);
    }
    expect(branch.indexOf('from private.approved_accounts where admission_no=fn for share nowait'))
      .toBeLessThan(branch.indexOf('from private.deletion_jobs where owner_id=fu for share nowait'));
  });
});

describe('deletion receipt purge schedule', () => {
  it('schedules one fixed, inactive daily purge after the guards', async () => {
    const sql = await read(SCHEDULE);
    expect(sql.match(/cron\.schedule\('/g)).toHaveLength(1);
    expect(sql).toContain("cron.schedule('stillroom-deletion-receipt-purge', '17 3 * * *', 'select public.purge_deletion_receipts()')");
    expect(sql).toMatch(/active := false/);
    expect(sql).not.toMatch(/active\s*:=\s*true/);
    const schedule = sql.indexOf('perform cron.alter_job(');
    for (const guard of ["if current_user <> 'postgres' or current_database() <> 'postgres' then",
      "if exists (select 1 from cron.job where jobname = 'stillroom-deletion-receipt-purge') then"]) {
      expect(sql.indexOf(guard), guard).toBeGreaterThan(-1);
      expect(sql.indexOf(guard), guard).toBeLessThan(schedule);
    }
    for (const forbidden of ['create extension', 'grant ', 'revoke ', 'drop ', 'create or replace']) {
      expect(sql.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
