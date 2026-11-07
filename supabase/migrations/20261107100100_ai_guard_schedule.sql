-- AI-GUARD1 spending guard sweep every minute. Adds one INACTIVE job and nothing else. The guard enforces nothing until the owner
-- activates it, after the migration, the five Edge functions and Pages are live. pg_cron comes from 20260925090000. Hosted
-- activation is a separate owner-approved step. Best effort: a missed minute only delays a pause by a minute.
do $$
begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'ai guard schedule: unexpected role or database';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension
      where extname = 'pg_cron' and extnamespace = 'pg_catalog'::regnamespace) then
    raise exception 'ai guard schedule: pg_cron is missing or in an unexpected schema';
  end if;
  if pg_catalog.current_setting('cron.database_name', true) is distinct from current_database()
    or not pg_catalog.has_schema_privilege('cron', 'USAGE')
    or not pg_catalog.has_function_privilege('cron.schedule(text,text,text)', 'EXECUTE')
    or not pg_catalog.has_function_privilege('cron.alter_job(bigint,text,text,text,text,boolean)', 'EXECUTE')
    or not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
    raise exception 'ai guard schedule: pg_cron permissions or database are not as expected';
  end if;
  -- Application roles must not reach the scheduler, directly or through inherited membership.
  if pg_catalog.has_schema_privilege('anon', 'cron', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'cron', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'USAGE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'CREATE') then
    raise exception 'ai guard schedule: application roles can reach the cron schema';
  end if;
  if exists (select 1 from cron.job where jobname = 'stillroom-ai-guard') then
    raise exception 'ai guard schedule: job already exists';
  end if;
  perform cron.alter_job(
    cron.schedule('stillroom-ai-guard', '* * * * *', 'select public.ai_guard_sweep(500)'),
    active := false);
end;
$$;
