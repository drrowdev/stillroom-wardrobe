import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source checks only; the CI database job proves the migrations apply and the job stays inactive.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const JOB = "cron.schedule('stillroom-stylist-expire', '*/5 * * * *', 'select public.stylist_expire_due(500)')";

describe('stylist expiry schedule migration (ST1a, M1)', () => {
  it('schedules exactly one fixed, bounded, inactive job after its guards', async () => {
    const sql = await read('20260928090100_stylist_expire_schedule.sql');
    expect(sql.match(/cron\.schedule\('/g)).toHaveLength(1);
    expect(sql).toContain(`perform cron.alter_job(\n    ${JOB},\n    active := false);`);
    expect(sql).not.toMatch(/active\s*:=\s*true|cron\.(unschedule|schedule_in_database)\b|\bgrant\b|\brevoke\b|create extension/);
    const schedule = sql.indexOf('perform cron.alter_job(');
    for (const guard of ["if current_user <> 'postgres' or current_database() <> 'postgres' then",
      "extnamespace = 'pg_catalog'::regnamespace", "has_schema_privilege('anon', 'cron', 'USAGE')",
      "has_schema_privilege('authenticated', 'cron', 'CREATE')",
      "if exists (select 1 from cron.job where jobname = 'stillroom-stylist-expire') then"]) {
      expect(sql.indexOf(guard), guard).toBeGreaterThan(-1);
      expect(sql.indexOf(guard), guard).toBeLessThan(schedule);
    }
  });

  it('keeps the scheduled expiry bounded and callable only by the database owner', async () => {
    const sql = await read('20260928090000_stylist_chat.sql');
    const body = sql.slice(sql.indexOf('create function public.stylist_expire_due('), sql.indexOf('create function public.stylist_direct_allocation('));
    expect(body).toMatch(/p_limit is null or p_limit<1 or p_limit>1000/);
    expect(sql).toContain('public.stylist_expire_due(integer),public.stylist_direct_allocation(uuid,bigint,bigint)\n  from public,anon,authenticated,service_role;');
    expect(sql).not.toMatch(/grant execute on function[^;]*stylist_expire_due/);
    expect(sql).not.toMatch(/grant execute on function[^;]*stylist_direct_allocation/);
  });
});
