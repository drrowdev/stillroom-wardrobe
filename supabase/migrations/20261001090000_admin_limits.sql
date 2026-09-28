-- AD1a: one operator-designated admin sees each account's AI limits and app-recorded AI spending and sets its AI
-- limits (issue #109; plan rev2 with the coordinator's binding notes; ADR27). A narrow exception to account
-- independence: no email, user ID, profile, wardrobe, image, chat, consent or audit data leaves these functions.
-- Requires M8 (20260929090000/20260929090100): it reads the enhancement columns and probe authorisations.
-- Classification:
--   additive: two private tables, three authenticated RPCs and private helpers; no existing writer changes;
--   NON-ADDITIVE: deletion_owner_rows_absent gains the two new tables (the rows stage is unchanged: its profile delete
--     cascades the admin row and target audit rows and anonymises the actor before the absence check).
-- Lock order (extends BG2b-1): both approved accounts (share nowait, ascending admission_no) -> app_admins (share) ->
--   target profile (update) -> actor profile (key share) -> target ai_controls (update). Claims take approved account
--   (share) -> profile -> ai_controls, so they either finish first or read the new limits.
begin;

-- The single admin. Written only by the runbook's operator SQL; no function inserts, updates or deletes it.
create table private.app_admins (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null unique references public.profiles(owner_id) on delete cascade,
  admission_no smallint not null check (admission_no in (1,2)),
  admission_generation uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.app_admins enable row level security;
revoke all on private.app_admins from public,anon,authenticated,service_role;

-- The operator step cannot bind a stale invitation: the row must name the current, enabled admission generation.
create function private.app_admin_binding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from private.approved_accounts s where s.admission_no=new.admission_no
    and s.generation=new.admission_generation and s.user_id=new.owner_id and s.enabled) then
    raise exception using errcode='23514',message='Admin binding not available';
  end if;
  return new;
end;
$$;
create trigger app_admins_binding before insert or update on private.app_admins
for each row execute function private.app_admin_binding();

-- Append-only operator record of limit changes. The reason is a fixed label, never free text; the limits hold only
-- the nine numeric fields. Target rows go with the target account; the actor is anonymised when the admin is deleted.
create table private.ai_limit_audit (
  id uuid primary key,
  created_at timestamptz not null,
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  target_admission_no smallint not null check (target_admission_no in (1,2)),
  actor_owner_id uuid references public.profiles(owner_id) on delete set null,
  old_limits jsonb not null check (jsonb_typeof(old_limits)='object'),
  new_limits jsonb not null check (jsonb_typeof(new_limits)='object'),
  reason_code text check (reason_code in ('RAISE','LOWER','PAUSE','RESTORE','CORRECTION'))
);
create index ai_limit_audit_owner on private.ai_limit_audit(owner_id);
create index ai_limit_audit_actor on private.ai_limit_audit(actor_owner_id);
alter table private.ai_limit_audit enable row level security;
revoke all on private.ai_limit_audit from public,anon,authenticated,service_role;

-- Only the profile foreign-key actions may change audit rows: a cascade delete once the target profile is gone, and
-- the actor set-null once the actor profile is gone with every other column unchanged.
create function private.ai_limit_audit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' then
    if pg_trigger_depth()>1 and not exists(select 1 from public.profiles where owner_id=old.owner_id) then
      return old;
    end if;
  elsif tg_op='UPDATE' then
    if pg_trigger_depth()>1 and old.actor_owner_id is not null and new.actor_owner_id is null
      and (to_jsonb(new)-'actor_owner_id')=(to_jsonb(old)-'actor_owner_id')
      and not exists(select 1 from public.profiles where owner_id=old.actor_owner_id) then
      return new;
    end if;
  end if;
  raise exception using errcode='42501',message='Audit rows are append-only';
end;
$$;
create trigger ai_limit_audit_guard before update or delete on private.ai_limit_audit
for each row execute function private.ai_limit_audit_guard();
create trigger ai_limit_audit_truncate before truncate on private.ai_limit_audit
for each statement execute function private.ai_limit_audit_guard();

-- The caller alone: the current, enabled, non-deleting admin at its bound admission generation, or null.
create function private.admin_authority() returns uuid
language sql stable set search_path = '' as $$
  select a.owner_id from private.app_admins a
  join private.approved_accounts s on s.admission_no=a.admission_no and s.generation=a.admission_generation
    and s.user_id=a.owner_id and s.enabled
  where a.owner_id=(select auth.uid())
    and exists(select 1 from public.profiles p where p.owner_id=a.owner_id)
    and not exists(select 1 from private.deletion_jobs j where j.owner_id=a.owner_id);
$$;

-- An opaque write guard, not a credential: it changes on every re-invitation.
create function private.admin_account_version(p_admission_no smallint,p_generation uuid) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_admission_no::text||':'||p_generation::text,'UTF8')),'hex');
$$;

-- The nine limits. Micro-USD amounts are exact decimal strings; maxRequestMicro under shared is the tagging reservation.
create function private.admin_limits(c private.ai_controls) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'shared',jsonb_build_object('monthlyAllowanceMicro',c.monthly_allowance_micro::text,
      'maxRequestMicro',c.max_request_micro::text,'maxRequestsPerHour',c.max_requests_per_hour),
    'stylist',jsonb_build_object('monthlyAllowanceMicro',c.stylist_monthly_allowance_micro::text,
      'maxRequestMicro',c.stylist_max_request_micro::text,'maxRequestsPerHour',c.stylist_max_requests_per_hour),
    'enhancement',jsonb_build_object('monthlyAllowanceMicro',c.enhance_monthly_allowance_micro::text,
      'maxRequestMicro',c.enhance_max_request_micro::text,'maxRequestsPerHour',c.enhance_max_requests_per_hour));
$$;

-- Exact keys; micro strings of at most 12 digits without leading zeros (no bigint overflow); integer hourly caps.
create function private.admin_limits_shape(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare f text; k text; v jsonb;
begin
  if p is null or jsonb_typeof(p)<>'object' then return false; end if;
  if not p ?& array['shared','stylist','enhancement'] or (select count(*) from jsonb_object_keys(p))<>3 then return false; end if;
  foreach f in array array['shared','stylist','enhancement'] loop
    if jsonb_typeof(p->f)<>'object' then return false; end if;
    if not (p->f) ?& array['monthlyAllowanceMicro','maxRequestMicro','maxRequestsPerHour']
      or (select count(*) from jsonb_object_keys(p->f))<>3 then return false; end if;
    foreach k in array array['monthlyAllowanceMicro','maxRequestMicro'] loop
      v := p->f->k;
      if jsonb_typeof(v)='string' then
        if not (v#>>'{}') ~ '^(0|[1-9][0-9]{0,11})$' then return false; end if;
      elsif jsonb_typeof(v)<>'null' then return false;
      end if;
    end loop;
    v := p->f->'maxRequestsPerHour';
    if jsonb_typeof(v)='number' then
      if not v::text ~ '^-?[0-9]{1,9}$' then return false; end if;
    elsif jsonb_typeof(v)<>'null' then return false;
    end if;
  end loop;
  return true;
end;
$$;

-- History by the usage row's own UTC period: a hold appears only in its own month. Released rows are excluded.
create function private.admin_month(p_owner uuid,p_period text,p_purpose text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'confirmedMicro',coalesce(sum(accounted_micro) filter (where charge_state='settled'),0)::text,
    'estimatedMicro',coalesce(sum(accounted_micro) filter (where charge_state='estimated'),0)::text,
    'reservedMicro',coalesce(sum(accounted_micro) filter (where charge_state in ('reserved','held')),0)::text,
    'totalMicro',coalesce(sum(accounted_micro) filter (where charge_state in ('settled','estimated','reserved','held')),0)::text,
    'requests',count(*) filter (where charge_state<>'released'))
  from private.ai_usage where owner_id=p_owner and period=p_period and purpose=p_purpose;
$$;

-- One account as the admin may see it (ADR27): admission number, enabled, limits, activation flags, spending,
-- current consumption and aggregate open probe allocations. Nothing else.
create function private.admin_account(a private.approved_accounts,p_now timestamptz,p_months text[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare c private.ai_controls; s record; e record; v_period text := to_char(p_now at time zone 'UTC','YYYY-MM');
  v_analysis numeric; v_analysis_hour bigint; v_probe jsonb;
begin
  select * into c from private.ai_controls where owner_id=a.user_id;
  select * into s from private.stylist_usage(a.user_id,p_now);
  select * into e from private.enhance_usage(a.user_id,p_now);
  select coalesce(sum(accounted_micro) filter (where purpose='analysis' and (period=v_period or charge_state in ('reserved','held'))),0),
    count(*) filter (where purpose='analysis' and created_at>p_now-interval '1 hour')
    into v_analysis,v_analysis_hour from private.ai_usage where owner_id=a.user_id;
  select jsonb_build_object('count',count(*),'allocationMicro',coalesce(sum(allocation_micro),0)::text,
    'maxCalls',coalesce(sum(max_calls),0))
    into v_probe from private.enhancement_probe_authorisations
    where owner_id=a.user_id and stopped_at is null and expires_at>p_now;
  return jsonb_build_object('admissionNo',a.admission_no,'enabled',a.enabled,
    'accountVersion',private.admin_account_version(a.admission_no,a.generation),
    'features',jsonb_build_object(
      'analysis',jsonb_build_object('configured',c.owner_id is not null,'activated',coalesce(c.activated,false)),
      'stylist',jsonb_build_object('configured',c.stylist_monthly_allowance_micro is not null,
        'activated',coalesce(c.stylist_activated,false)),
      'enhancement',jsonb_build_object('configured',c.enhance_monthly_allowance_micro is not null,
        'activated',coalesce(c.enhance_activated,false))),
    'limits',case when c.owner_id is null then null else private.admin_limits(c) end,
    'history',(select jsonb_agg(jsonb_build_object('month',m.period,
        'analysis',private.admin_month(a.user_id,m.period,'analysis'),
        'stylist',private.admin_month(a.user_id,m.period,'stylist'),
        'enhancement',private.admin_month(a.user_id,m.period,'enhancement'),
        'tryOn',jsonb_build_object('available',false)) order by m.n)
      from unnest(p_months) with ordinality m(period,n)),
    'current',jsonb_build_object('period',v_period,
      'shared',jsonb_build_object('usedMicro',s.total_micro::text,'lastHour',s.total_hour),
      'analysis',jsonb_build_object('usedMicro',v_analysis::text,'lastHour',v_analysis_hour),
      'stylist',jsonb_build_object('usedMicro',s.stylist_micro::text,'lastHour',s.stylist_hour),
      'enhancement',jsonb_build_object('usedMicro',e.enhance_micro::text,'lastHour',e.enhance_hour)),
    'openAllocations',jsonb_build_object('enhancementProbe',v_probe));
end;
$$;

-- Every non-admin caller gets the same fixed refusal from all three RPCs, before any input or target work.
create function public.admin_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code',case when private.admin_authority() is null then 'UNAVAILABLE' else 'OK' end);
$$;

-- App-recorded spending estimates only: direct operator calls leave no ledger row and are never inferred here.
create function public.admin_ai_spending(p_months integer default 6) returns jsonb
language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_months text[];
begin
  if private.admin_authority() is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_months is null or p_months<1 or p_months>12 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select array_agg(to_char(date_trunc('month',v_now at time zone 'UTC')-make_interval(months=>g),'YYYY-MM') order by g)
    into v_months from generate_series(0,p_months-1) g;
  return jsonb_build_object('code','OK','asOf',floor(extract(epoch from v_now)*1000)::bigint,'months',to_jsonb(v_months),
    'accounts',coalesce((select jsonb_agg(private.admin_account(a,v_now,v_months) order by a.admission_no)
      from private.approved_accounts a
      where a.user_id is not null and exists(select 1 from public.profiles p where p.owner_id=a.user_id)),'[]'::jsonb));
end;
$$;

-- Sets one account's nine limits. Never touches activation, consent, notice, manifest or usage. Constraints are all
-- checked before the UPDATE and nothing is clamped: the stored values must equal the request or the call fails.
create function public.admin_set_ai_limits(p_admission_no smallint,p_account_version text,p_expected jsonb,p_limits jsonb,
  p_reason_code text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_actor uuid := private.admin_authority(); v_actor_no smallint; t private.approved_accounts; c private.ai_controls;
  v_current jsonb; v_saved jsonb; f text; k text; v_monthly numeric; v_request numeric; v_hour numeric; v_shared numeric;
  v_manifest text; v_reservation bigint; s record; e record; v_below boolean;
begin
  -- Caller-only authorisation, before any target lookup, lock or detailed validation.
  if v_actor is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_admission_no is null or p_admission_no not in (1,2) or p_account_version is null
    or p_account_version !~ '^[0-9a-f]{64}$' or not private.admin_limits_shape(p_expected)
    or not private.admin_limits_shape(p_limits)
    or (p_reason_code is not null and p_reason_code not in ('RAISE','LOWER','PAUSE','RESTORE','CORRECTION')) then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  begin
    select admission_no into v_actor_no from private.app_admins where owner_id=v_actor;
    perform 1 from private.approved_accounts where admission_no in (v_actor_no,p_admission_no)
      order by admission_no for share nowait;
    perform 1 from private.app_admins where singleton for share;
    if private.admin_authority() is distinct from v_actor then return jsonb_build_object('code','UNAVAILABLE'); end if;
    select * into t from private.approved_accounts where admission_no=p_admission_no;
    if not found or not t.enabled or t.user_id is null
      or exists(select 1 from private.deletion_jobs where owner_id=t.user_id) then
      return jsonb_build_object('code','UNAVAILABLE');
    end if;
    -- Recomputed from the locked admission row, never trusted from the caller.
    if private.admin_account_version(t.admission_no,t.generation)<>p_account_version then
      return jsonb_build_object('code','CONFLICT');
    end if;
    perform 1 from public.profiles where owner_id=t.user_id for update;
    if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
    perform 1 from public.profiles where owner_id=v_actor for key share;
    select * into c from private.ai_controls where owner_id=t.user_id for update;
    if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  exception when lock_not_available then return jsonb_build_object('code','CONFLICT');
  end;
  v_current := private.admin_limits(c);
  if p_expected<>v_current then return jsonb_build_object('code','CONFLICT','limits',v_current); end if;
  v_shared := (p_limits->'shared'->>'monthlyAllowanceMicro')::numeric;
  foreach f in array array['shared','stylist','enhancement'] loop
    -- A configured value cannot be removed and an unconfigured one cannot be added here.
    foreach k in array array['monthlyAllowanceMicro','maxRequestMicro','maxRequestsPerHour'] loop
      if (jsonb_typeof(p_limits->f->k)='null')<>(jsonb_typeof(v_current->f->k)='null') then
        return jsonb_build_object('code','INVALID_LIMITS','field',f||'.'||k,'reason','REQUIRED');
      end if;
    end loop;
    v_monthly := (p_limits->f->>'monthlyAllowanceMicro')::numeric;
    v_request := (p_limits->f->>'maxRequestMicro')::numeric;
    v_hour := (p_limits->f->>'maxRequestsPerHour')::numeric;
    if v_monthly<=0 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.monthlyAllowanceMicro','reason','NOT_POSITIVE');
    end if;
    if v_request<=0 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','NOT_POSITIVE');
    end if;
    if v_hour<1 or v_hour>1000 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestsPerHour','reason','RANGE');
    end if;
    if f='shared' and v_monthly>50000000 then
      return jsonb_build_object('code','INVALID_LIMITS','field','shared.monthlyAllowanceMicro','reason','APP_LIMIT');
    end if;
    if v_request>v_monthly then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','ABOVE_MONTHLY');
    end if;
    if f<>'shared' and v_monthly>v_shared then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.monthlyAllowanceMicro','reason','ABOVE_SHARED');
    end if;
    -- Every proposed per-request value, changed or not, must cover the active manifest's reservation: a value below it
    -- would leave the feature silently unusable.
    v_manifest := case f when 'shared' then c.execution_manifest_id when 'stylist' then c.stylist_manifest_id
      else c.enhance_manifest_id end;
    if v_request is not null and v_manifest is not null then
      select reservation_micro into v_reservation from private.ai_execution_manifests where id=v_manifest;
      if v_request<v_reservation then
        return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','BELOW_RESERVATION');
      end if;
    end if;
  end loop;
  if p_limits=v_current then return jsonb_build_object('code','UNCHANGED','limits',v_current); end if;
  update private.ai_controls set
    monthly_allowance_micro=(p_limits->'shared'->>'monthlyAllowanceMicro')::bigint,
    max_request_micro=(p_limits->'shared'->>'maxRequestMicro')::bigint,
    max_requests_per_hour=(p_limits->'shared'->>'maxRequestsPerHour')::integer,
    stylist_monthly_allowance_micro=(p_limits->'stylist'->>'monthlyAllowanceMicro')::bigint,
    stylist_max_request_micro=(p_limits->'stylist'->>'maxRequestMicro')::bigint,
    stylist_max_requests_per_hour=(p_limits->'stylist'->>'maxRequestsPerHour')::integer,
    enhance_monthly_allowance_micro=(p_limits->'enhancement'->>'monthlyAllowanceMicro')::bigint,
    enhance_max_request_micro=(p_limits->'enhancement'->>'maxRequestMicro')::bigint,
    enhance_max_requests_per_hour=(p_limits->'enhancement'->>'maxRequestsPerHour')::integer,
    updated_at=clock_timestamp()
    where owner_id=t.user_id returning * into c;
  v_saved := private.admin_limits(c);
  if v_saved<>p_limits then raise exception using errcode='P0001',message='Limit write changed'; end if;
  select * into s from private.stylist_usage(t.user_id,clock_timestamp());
  select * into e from private.enhance_usage(t.user_id,clock_timestamp());
  v_below := s.total_micro>c.monthly_allowance_micro or coalesce(s.stylist_micro>c.stylist_monthly_allowance_micro,false)
    or coalesce(e.enhance_micro>c.enhance_monthly_allowance_micro,false);
  insert into private.ai_limit_audit(id,created_at,owner_id,target_admission_no,actor_owner_id,old_limits,new_limits,reason_code)
    values(gen_random_uuid(),clock_timestamp(),t.user_id,t.admission_no,v_actor,v_current,v_saved,p_reason_code);
  return jsonb_build_object('code','OK','limits',v_saved,'belowUse',v_below);
end;
$$;

-- Every owner-keyed table, now including the admin row and both audit columns. The rows stage deletes the profile
-- first, so the admin row and target audit rows cascade and the actor is set null before this check runs.
create or replace function private.deletion_owner_rows_absent(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not (
    exists(select 1 from public.profiles where owner_id=p_owner)
    or exists(select 1 from public.style_preferences where owner_id=p_owner)
    or exists(select 1 from public.items where owner_id=p_owner)
    or exists(select 1 from public.item_images where owner_id=p_owner)
    or exists(select 1 from public.outfits where owner_id=p_owner)
    or exists(select 1 from public.outfit_items where owner_id=p_owner)
    or exists(select 1 from public.wear_events where owner_id=p_owner)
    or exists(select 1 from public.wear_event_items where owner_id=p_owner)
    or exists(select 1 from public.combination_rules where owner_id=p_owner)
    or exists(select 1 from public.suggestion_feedback where owner_id=p_owner)
    or exists(select 1 from private.ai_controls where owner_id=p_owner)
    or exists(select 1 from private.ai_usage where owner_id=p_owner)
    or exists(select 1 from private.ai_requests where owner_id=p_owner)
    or exists(select 1 from private.ai_usage_evidence where owner_id=p_owner)
    or exists(select 1 from private.ai_analysis_attestations where owner_id=p_owner)
    or exists(select 1 from private.item_save_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_save_used_receipts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_context where owner_id=p_owner)
    or exists(select 1 from private.item_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.item_image_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_claims where owner_id=p_owner)
    or exists(select 1 from private.image_change_attempts where owner_id=p_owner)
    or exists(select 1 from private.image_change_context where owner_id=p_owner)
    or exists(select 1 from private.image_change_history where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_operations where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_targets where owner_id=p_owner)
    or exists(select 1 from private.imported_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.image_enhancements where owner_id=p_owner)
    or exists(select 1 from private.enhancement_outputs where owner_id=p_owner)
    or exists(select 1 from private.image_provenance where owner_id=p_owner)
    or exists(select 1 from private.image_enhancement_bindings where owner_id=p_owner)
    or exists(select 1 from private.restore_image_markers where owner_id=p_owner)
    or exists(select 1 from private.enhancement_probe_authorisations where owner_id=p_owner)
    or exists(select 1 from private.app_admins where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where actor_owner_id=p_owner));
$$;

revoke all on function private.app_admin_binding(),private.ai_limit_audit_guard(),private.admin_authority(),
  private.admin_account_version(smallint,uuid),private.admin_limits(private.ai_controls),private.admin_limits_shape(jsonb),
  private.admin_month(uuid,text,text),private.admin_account(private.approved_accounts,timestamptz,text[])
  from public,anon,authenticated,service_role;
revoke all on function public.admin_status(),public.admin_ai_spending(integer),
  public.admin_set_ai_limits(smallint,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_status(),public.admin_ai_spending(integer),
  public.admin_set_ai_limits(smallint,text,jsonb,jsonb,text) to authenticated;

commit;
