import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AI_GUARD_SQLSTATE, guardRefusal, parseAiGuardResume, parseAiGuardStatus } from '../../src/domain/ai-guard';
import { messages } from '../../src/i18n/all';

const migration = (name: string) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MAIN = '20261107100000_ai_guard.sql';
const SCHEDULE = '20261107100100_ai_guard_schedule.sql';

describe('AI-GUARD1 replies', () => {
  it('recognises only the guard SQLSTATE in a failed reply', () => {
    const body = { code: 'AG001', message: 'AI spending guard is paused', details: null, hint: null };
    expect(AI_GUARD_SQLSTATE).toBe('AG001');
    expect(guardRefusal(false, body)).toBe(true);
    expect(guardRefusal(true, body)).toBe(false);
    for (const other of [{ code: 'P0001' }, { code: 'ALLOWANCE' }, { code: 'ag001' }, null, 'AG001', ['AG001'], {}]) expect(guardRefusal(false, other)).toBe(false);
  });
  it('reads the closed status and resume replies and nothing else', () => {
    expect(parseAiGuardStatus({ code: 'OK', paused: false })).toEqual({ paused: false });
    const paused = { code: 'OK', paused: true, pausedAtMs: 1_790_000_000_000, spentMicro: '26138140', limitMicro: '25000000' };
    expect(parseAiGuardStatus(paused)).toEqual({ paused: true, pausedAtMs: 1_790_000_000_000, spentMicro: '26138140', limitMicro: '25000000' });
    expect(parseAiGuardStatus({ code: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
    for (const bad of [null, {}, { code: 'OK' }, { code: 'OK', paused: 'yes' }, { ...paused, extra: 1 }, { ...paused, spentMicro: '-1' },
      { ...paused, limitMicro: 25 }, { ...paused, pausedAtMs: 1.5 }, { code: 'BUSY' }, { code: 'OK', paused: false, pausedAtMs: 1 }]) {
      expect(parseAiGuardStatus(bad)).toBeNull();
    }
    expect(parseAiGuardResume({ code: 'OK', replayed: false })).toBe('OK');
    expect(parseAiGuardResume({ code: 'OK', replayed: true })).toBe('OK');
    expect(parseAiGuardResume({ code: 'BUSY' })).toBe('BUSY');
    expect(parseAiGuardResume({ code: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
    for (const bad of [null, {}, { code: 'OK' }, { code: 'OK', replayed: 1 }, { code: 'NOPE' }]) expect(parseAiGuardResume(bad)).toBeNull();
  });
  it('has the owner-facing words in all three languages', () => {
    for (const key of ['aiGuard.title', 'aiGuard.body', 'aiGuard.amounts', 'aiGuard.resume', 'aiGuard.resumeFailed', 'aiGuard.paused'] as const) {
      for (const language of ['en', 'fi', 'sv'] as const) expect(messages[key][language].length, `${key} ${language}`).toBeGreaterThan(5);
    }
  });
});

describe('AI-GUARD1 migration source', () => {
  it('adds columns, one insert trigger and three functions, and replaces no admission, settlement or consent body', async () => {
    const sql = await migration(MAIN);
    expect(sql.startsWith('-- AI-GUARD1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    // The hosted install runs the inner SQL with execute inside a DO block: no dollar-quote tag of the wrapper may appear.
    expect(sql).not.toMatch(/\$mig\$|\$w\$/);
    expect(sql).not.toMatch(/create or replace function/);
    expect(sql).not.toMatch(/drop function|drop trigger|alter function/);
    expect(sql.match(/create function /g)).toHaveLength(4);
    for (const column of ['ai_guard_hour_micro bigint', 'ai_guard_paused_at timestamptz', 'ai_guard_limit_micro bigint',
      'ai_guard_window_micro bigint', 'ai_guard_resumed_at timestamptz']) expect(sql).toContain(`add column ${column}`);
    expect(sql).toContain('create trigger ai_usage_pause_guard before insert on private.ai_usage');
    expect(sql).toContain("for each row when (new.charge_state in ('reserved','held')) execute function private.ai_guard_enforce();");
    expect(sql).toContain("raise exception using errcode='AG001',message='AI spending guard is paused';");
    // Only the owner's own two calls are reachable by a session; the sweep and the trigger function by nobody.
    expect(sql).toContain('revoke all on function private.ai_guard_enforce(),public.ai_guard_sweep(integer),public.ai_guard_status_v1(),public.ai_guard_resume_v1()\n  from public,anon,authenticated,service_role;');
    expect(sql).toContain('grant execute on function public.ai_guard_status_v1(),public.ai_guard_resume_v1() to authenticated;');
    expect(sql.match(/grant execute/g)).toHaveLength(1);
  });
  it('measures every purpose over 60 minutes against half the monthly allowance unless the owner set another amount', async () => {
    const sql = await migration(MAIN);
    expect(sql).toContain("v_now-interval '60 minutes'");
    expect(sql).toContain('coalesce(k.ai_guard_hour_micro,k.monthly_allowance_micro/2)');
    expect(sql).toContain("coalesce(k.ai_guard_resumed_at,'-infinity'::timestamptz)");
    expect(sql).toContain('for update skip locked');
    expect(sql).not.toMatch(/where [^;]*purpose\s*=/);
    // Resume restarts the window and never changes consent, activation or limits.
    const resume = sql.slice(sql.indexOf('create function public.ai_guard_resume_v1'));
    expect(resume).toContain('ai_guard_resumed_at=clock_timestamp()');
    expect(resume).not.toMatch(/activated|consent|allowance/);
  });
  it('creates the sweep job inactive, every minute, and nothing else', async () => {
    const sql = await migration(SCHEDULE);
    expect(sql).toContain("cron.schedule('stillroom-ai-guard', '* * * * *', 'select public.ai_guard_sweep(500)'),\n    active := false);");
    expect(sql).toContain("pg_extension\n      where extname = 'pg_cron'");
    expect(sql.match(/cron\.schedule\('/g)).toHaveLength(1);
  });
});
