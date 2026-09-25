import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source checks only; the CI database job proves the migration applies and the job is inactive.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const NAME = '20260925090000_ai_purge_schedule.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const JOB = "cron.schedule('stillroom-ai-purge-expired', '*/15 * * * *', 'select public.ai_purge_expired(500)')";
const statements = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''").toLowerCase();

describe('scheduled AI purge migration', () => {
  it('is the fourteenth of eighteen migrations, followed by the ID conflicts, restore and account deletion migrations', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names).toHaveLength(18);
    expect(names.slice(-5)).toEqual([NAME, '20260925100000_uniform_id_conflicts.sql', '20260925110000_restore_item_save.sql',
      '20260925120000_account_deletion.sql', '20260925120100_deletion_receipt_purge_schedule.sql']);
  });

  it('schedules exactly one fixed, bounded, inactive job', async () => {
    const sql = await read(NAME);
    expect(sql.match(/cron\.schedule\('/g)).toHaveLength(1);
    expect(sql).toContain(`perform cron.alter_job(\n    ${JOB},\n    active := false);`);
    expect(sql).not.toMatch(/active\s*:=\s*true/);
    expect(sql).not.toMatch(/cron\.(unschedule|schedule_in_database)\b/);
  });

  it('refuses unexpected role, database, extension state, permissions and an existing job before scheduling', async () => {
    const sql = await read(NAME), at = (text: string) => sql.indexOf(text), schedule = at('perform cron.alter_job(');
    const guards = [
      "if current_user <> 'postgres' or current_database() <> 'postgres' then",
      "extnamespace = 'pg_catalog'::regnamespace",
      "current_setting('cron.database_name', true) is distinct from current_database()",
      "has_function_privilege('cron.schedule(text,text,text)', 'EXECUTE')",
      "has_function_privilege('cron.alter_job(bigint,text,text,text,text,boolean)', 'EXECUTE')",
      "has_schema_privilege('anon', 'cron', 'USAGE')", "has_schema_privilege('anon', 'cron', 'CREATE')",
      "has_schema_privilege('authenticated', 'cron', 'USAGE')", "has_schema_privilege('authenticated', 'cron', 'CREATE')",
      "if exists (select 1 from cron.job where jobname = 'stillroom-ai-purge-expired') then",
    ];
    for (const guard of guards) {
      expect(at(guard), guard).toBeGreaterThan(-1);
      expect(at(guard), guard).toBeLessThan(schedule);
    }
    expect(sql.split('raise exception').length - 1).toBe(5);
  });

  it('only grants pg_cron defaults to postgres when it creates the extension', async () => {
    const sql = statements(await read(NAME));
    expect(sql).toContain("if not v_existed then\n    create extension pg_cron with schema pg_catalog;\n"
      + '    grant usage on schema cron to postgres;\n    grant all privileges on all tables in schema cron to postgres;\n  end if;');
    expect(sql.match(/\bgrant\b/g)).toHaveLength(2);
    expect(sql.match(/\bcreate\b/g)).toHaveLength(1);
    for (const forbidden of ['revoke', 'insert', 'update', 'delete', 'truncate', 'drop', 'alter table', 'alter function',
      'alter default', 'create or replace', 'security definer', 'set role', 'owner to']) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves ai_purge_expired defined and granted only by the controls migration', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql'));
    const sources = await Promise.all(names.map(async (name) => [name, await read(name)] as const));
    const defining = sources.filter(([, sql]) => /function public\.ai_purge_expired\(/.test(sql)).map(([name]) => name);
    const granting = sources.filter(([, sql]) => /(grant|revoke)[^;]*public\.ai_purge_expired/i.test(sql)).map(([name]) => name);
    expect(defining).toEqual(['20260909180000_ai_request_controls.sql']);
    expect(granting).toEqual(['20260909180000_ai_request_controls.sql']);
    const controls = sources.find(([name]) => name === defining[0])![1];
    expect(controls).toMatch(/grant execute on function public\.ai_mark_dispatched\(uuid,uuid\),[^;]*\n {2}public\.ai_purge_expired\(integer\) to service_role;/);
    expect(controls).toContain("if p_limit is null or p_limit not between 1 and 1000 then return jsonb_build_object('code','INVALID_INPUT');");
  });
});
