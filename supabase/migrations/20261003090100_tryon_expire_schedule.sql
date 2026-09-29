-- Try-on expiry and cleanup every fifteen minutes (VTO-1, plan rev4 §5.2 and §7.5). Adds one ACTIVE job and nothing
-- else: it only expires held try-on accounting, ends chains past 30 minutes and deletes expired results, orphaned slots,
-- old terminal chains and old probe authorisations. It never dispatches. pg_cron comes from 20260925090000.
do $$
begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'try-on expiry schedule: unexpected role or database';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension
      where extname = 'pg_cron' and extnamespace = 'pg_catalog'::regnamespace) then
    raise exception 'try-on expiry schedule: pg_cron is missing or in an unexpected schema';
  end if;
  if pg_catalog.current_setting('cron.database_name', true) is distinct from current_database()
    or not pg_catalog.has_schema_privilege('cron', 'USAGE')
    or not pg_catalog.has_function_privilege('cron.schedule(text,text,text)', 'EXECUTE')
    or not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
    raise exception 'try-on expiry schedule: pg_cron permissions or database are not as expected';
  end if;
  -- Application roles must not reach the scheduler, directly or through inherited membership.
  if pg_catalog.has_schema_privilege('anon', 'cron', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'cron', 'CREATE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'USAGE')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'CREATE') then
    raise exception 'try-on expiry schedule: application roles can reach the cron schema';
  end if;
  if exists (select 1 from cron.job where jobname = 'stillroom-tryon-expire') then
    raise exception 'try-on expiry schedule: job already exists';
  end if;
  perform cron.schedule('stillroom-tryon-expire', '*/15 * * * *', 'select public.tryon_expire_due(500)');
end;
$$;
