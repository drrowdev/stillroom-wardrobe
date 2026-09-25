-- Daily purge of completed account-deletion receipts older than seven days. Adds one INACTIVE job and
-- nothing else. pg_cron comes from 20260925090000. Hosted activation is a separate owner-approved step.
do $$
begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'deletion receipt purge schedule: unexpected role or database';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension
      where extname = 'pg_cron' and extnamespace = 'pg_catalog'::regnamespace) then
    raise exception 'deletion receipt purge schedule: pg_cron is missing or in an unexpected schema';
  end if;
  if pg_catalog.current_setting('cron.database_name', true) is distinct from current_database()
    or not pg_catalog.has_schema_privilege('cron', 'USAGE')
    or not pg_catalog.has_function_privilege('cron.schedule(text,text,text)', 'EXECUTE')
    or not pg_catalog.has_function_privilege('cron.alter_job(bigint,text,text,text,text,boolean)', 'EXECUTE')
    or not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
    raise exception 'deletion receipt purge schedule: pg_cron permissions or database are not as expected';
  end if;
  -- Application roles must not reach the scheduler, directly or through inherited membership.
  if pg_catalog.has_schema_privilege('anon', 'cron', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'cron', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'USAGE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'CREATE') then
    raise exception 'deletion receipt purge schedule: application roles can reach the cron schema';
  end if;
  if exists (select 1 from cron.job where jobname = 'stillroom-deletion-receipt-purge') then
    raise exception 'deletion receipt purge schedule: job already exists';
  end if;
  perform cron.alter_job(
    cron.schedule('stillroom-deletion-receipt-purge', '17 3 * * *', 'select public.purge_deletion_receipts()'),
    active := false);
end;
$$;
