-- Scheduled purge of expired AI results. Adds the pg_cron extension (only if absent) and one INACTIVE job.
-- It adds extension/config objects and new inactive job metadata without modifying pre-existing application
-- data or objects. Hosted activation is a separate owner-approved operator step.
do $$
declare
  v_existed boolean;
begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'ai purge schedule: unexpected role or database';
  end if;
  select true into v_existed from pg_catalog.pg_extension where extname = 'pg_cron';
  v_existed := coalesce(v_existed, false);
  if v_existed and not exists (select 1 from pg_catalog.pg_extension
      where extname = 'pg_cron' and extnamespace = 'pg_catalog'::regnamespace) then
    raise exception 'ai purge schedule: pg_cron is installed in an unexpected schema';
  end if;
  if not v_existed then
    create extension pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;
  end if;
  if pg_catalog.current_setting('cron.database_name', true) is distinct from current_database()
    or not pg_catalog.has_schema_privilege('cron', 'USAGE')
    or not pg_catalog.has_function_privilege('cron.schedule(text,text,text)', 'EXECUTE')
    or not pg_catalog.has_function_privilege('cron.alter_job(bigint,text,text,text,text,boolean)', 'EXECUTE')
    or not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
    raise exception 'ai purge schedule: pg_cron permissions or database are not as expected';
  end if;
  -- Application roles must not reach the scheduler, directly or through inherited membership.
  if pg_catalog.has_schema_privilege('anon', 'cron', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'cron', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'USAGE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'CREATE') then
    raise exception 'ai purge schedule: application roles can reach the cron schema';
  end if;
  if exists (select 1 from cron.job where jobname = 'stillroom-ai-purge-expired') then
    raise exception 'ai purge schedule: job already exists';
  end if;
  perform cron.alter_job(
    cron.schedule('stillroom-ai-purge-expired', '*/15 * * * *', 'select public.ai_purge_expired(500)'),
    active := false);
end;
$$;
