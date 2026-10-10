-- BUDGET1: one monthly AI budget per account (issue #84, owner decision of 8 October 2026). Hourly request quotas and
-- the separate stylist/cleanup/try-on spending limits no longer apply. Every AI purpose already writes private.ai_usage,
-- so the one budget is the existing shared sum: current UTC month's charges plus any reserved/held row of an earlier
-- month. No new table, column, RPC name or grant; historical migration bodies are unchanged. Classification:
--   NON-ADDITIVE (same-signature function replacement): public.ai_status, stylist_status, enhance_status, tryon_status,
--     ai_set_consent and the three feature consent functions, ai_claim_analysis's admission (private.ai_begin_owner), stylist_claim,
--     enhance_claim, tryon_claim, the two probe authorisations, tryon_bootstrap, stylist_direct_allocation,
--     both probe-permission helpers and the admin spending readers/setters (v1 fails closed, v2 is header-selected);
--   NON-ADDITIVE (constraints): the feature-limit <= shared checks, their clamp triggers and the not-null demands on the
--     retired limit columns of the three *_settings checks are dropped. The retired columns stay as inert history.
-- The budget contract is selected by the request header X-Stillroom-AI-Budget-Contract: 2 (PostgREST exposes it as
-- request.headers). Without it, or with any other value: status reads fail closed with no limit values, enabling consent
-- and every admin write refuse before any change, and withdrawal still works. Money is enforced by the claims
-- unconditionally. Physical provider capacity (the shared deployment's slots) is BUSY, not a quota.
begin;

alter table private.ai_controls
  drop constraint ai_controls_stylist_allowance,
  drop constraint ai_controls_enhance_allowance,
  drop constraint ai_controls_tryon_allowance,
  drop constraint ai_controls_stylist_settings,
  drop constraint ai_controls_enhance_settings,
  drop constraint ai_controls_tryon_settings;
drop trigger ai_controls_enhance_clamp on private.ai_controls;
drop trigger ai_controls_tryon_clamp on private.ai_controls;
alter table private.ai_controls
  add constraint ai_controls_stylist_settings check (not stylist_activated or (stylist_notice_revision is not null
    and stylist_manifest_id is not null and stylist_max_request_micro is not null)),
  add constraint ai_controls_enhance_settings check (not enhance_activated or (enhance_notice_revision is not null
    and enhance_manifest_id is not null and enhance_max_request_micro is not null)),
  add constraint ai_controls_tryon_settings check (not tryon_activated or (tryon_notice_revision is not null
    and tryon_manifest_id is not null and tryon_max_request_micro is not null));

create function private.ai_budget_contract() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-stillroom-ai-budget-contract','')='2';
$$;

-- The one sum: current-month charges plus open reservations/holds of any month, across every purpose.
create function private.ai_budget_used(p_owner uuid,p_now timestamptz) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(accounted_micro) filter (where period=to_char(p_now at time zone 'UTC','YYYY-MM')
    or charge_state in ('reserved','held')),0) from private.ai_usage where owner_id=p_owner;
$$;

create function private.ai_budget_json(p_allowance bigint,p_used numeric) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('monthlyAllowanceMicro',p_allowance::text,'usedMicro',p_used::text,
    'remainingMicro',greatest(p_allowance::numeric-p_used,0)::text,'warning',p_used*5>=p_allowance::numeric*4);
$$;

revoke all on function private.ai_budget_contract(),private.ai_budget_used(uuid,timestamptz),
  private.ai_budget_json(bigint,numeric) from public,anon,authenticated,service_role;

-- Analysis admission (reached by ai_begin_request and by ai_claim_analysis): the hourly count is gone.
create or replace function private.ai_begin_owner(p_owner_id uuid,p_request_id uuid,p_draft_id uuid,p_generation integer,p_image_sha256 text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  v_now timestamptz; v_period text; v_code text; v_used numeric;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if p_request_id is null or p_draft_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_draft_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_generation is null or p_generation<1 or p_image_sha256 is null
    or p_image_sha256!~'^[0-9a-f]{64}$' then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if found then
    select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
    if not found then return jsonb_build_object('code','TERMINAL'); end if;
    if r.expires_at<=v_now then
      perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
      return jsonb_build_object('code','TERMINAL');
    end if;
    if r.draft_id<>p_draft_id or r.generation<>p_generation or r.image_sha256<>p_image_sha256
      or r.model_id is distinct from c.model_id or r.prompt_version is distinct from c.prompt_version
      or r.notice_revision is distinct from c.notice_revision then return jsonb_build_object('code','CONFLICT'); end if;
    v_code := private.ai_permission(p,c);
    if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
    return jsonb_build_object('code','OK','status',r.status,'replayed',true);
  end if;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  perform private.ai_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_requests where owner_id=p.owner_id and draft_id=p_draft_id
    and status in ('reserved','dispatched')) then return jsonb_build_object('code','ACTIVE_DRAFT'); end if;
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if v_used+c.max_request_micro::numeric>c.monthly_allowance_micro then return jsonb_build_object('code','ALLOWANCE'); end if;
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state)
    values(p.owner_id,p_request_id,v_period,v_now,c.max_request_micro,c.max_request_micro,'reserved');
  insert into private.ai_requests(owner_id,request_id,draft_id,generation,image_sha256,model_id,prompt_version,
    notice_revision,status,created_at,expires_at)
    values(p.owner_id,p_request_id,p_draft_id,p_generation,p_image_sha256,c.model_id,c.prompt_version,
      c.notice_revision,'reserved',v_now,v_now+make_interval(secs=>c.result_ttl_seconds));
  return jsonb_build_object('code','OK','status','reserved','replayed',false);
end;
$$;

-- Analysis consent: 20260909180000's body with one added gate. Enabling needs the budget contract header and refuses before
-- any change without it; withdrawal never needs it. Signature and replies are otherwise identical.
create or replace function public.ai_set_consent(p_enabled boolean,p_notice_revision integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is true and not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if p_enabled is null or p_expected_version is null or p_expected_version<1
    or (p_enabled and (p_notice_revision is null or p_notice_revision<1))
    or (not p_enabled and p_notice_revision is not null) then return jsonb_build_object('code','INVALID_INPUT'); end if;
  if p.version<>p_expected_version or p.version=9223372036854775807 then return jsonb_build_object('code','CONFLICT'); end if;
  if p_enabled then
    if c.owner_id is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if not c.activated then return jsonb_build_object('code','INACTIVE'); end if;
    if c.notice_revision<>p_notice_revision then return jsonb_build_object('code','CONSENT_REQUIRED'); end if;
  end if;
  update public.profiles set ai_enabled=p_enabled,ai_notice_revision=p_notice_revision,
    ai_consented_at=case when p_enabled then v_now else null end where owner_id=p.owner_id returning * into p;
  return jsonb_build_object('code','OK','profileVersion',p.version::text);
end;
$$;

-- Owner status. SAVE1's photoModelNoticeUntilMs (status-version header 2) is kept in both representations.
create or replace function public.ai_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz; v_period text;
  v_used numeric; v_count bigint; v_policy jsonb; v_result jsonb; v_notice timestamptz; v_consent jsonb;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  perform private.ai_expire(p.owner_id,v_now,100);
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  v_used := private.ai_budget_used(p.owner_id,v_now);
  v_consent := jsonb_build_object('enabled',p.ai_enabled,'noticeRevision',p.ai_notice_revision,
    'consentedAt',p.ai_consented_at,'profileVersion',p.version::text);
  if not private.ai_budget_contract() then
    select count(*) into v_count from private.ai_usage where owner_id=p.owner_id and created_at>v_now-interval '1 hour';
    v_result := jsonb_build_object('code','UNAVAILABLE','period',v_period,
      'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,'consent',v_consent,'policy',null,
      'usage',jsonb_build_object('accountedMicro',v_used::text,'requestsLastHour',v_count,
        'warning',coalesce(v_used*5>=c.monthly_allowance_micro::numeric*4,false)));
  else
    if c.owner_id is not null then
      v_policy := jsonb_build_object('activated',c.activated,'noticeRevision',c.notice_revision,
        'modelId',c.model_id,'promptVersion',c.prompt_version,'maxRequestMicro',c.max_request_micro::text,
        'resultTtlSeconds',c.result_ttl_seconds);
      if c.model_id='gpt-5.6-terra-2026-07-09' then
        v_policy := v_policy||jsonb_build_object('executionManifestId',c.execution_manifest_id);
      end if;
    end if;
    v_result := jsonb_build_object('code',private.ai_permission(p,c),'period',v_period,
      'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,'consent',v_consent,'policy',v_policy,
      'budget',case when c.owner_id is null then null else private.ai_budget_json(c.monthly_allowance_micro,v_used) end);
  end if;
  if nullif(current_setting('request.headers',true),'')::jsonb->>'x-stillroom-ai-status-version'='2' then
    select max(coalesce(u.dispatched_at,u.created_at))+interval '7 days' into v_notice
      from private.ai_usage u join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and u.purpose='analysis'
        and e.manifest_id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2')
        and e.model_observation='response_unrecognised_model';
    v_result := v_result||jsonb_build_object('photoModelNoticeUntilMs',
      case when v_notice>v_now then floor(extract(epoch from v_notice)*1000)::bigint end);
  end if;
  return v_result;
end;
$$;

-- Stylist.
create or replace function public.stylist_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_used numeric; v_policy jsonb := null;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.stylist_expire(p.owner_id,v_now,100); end if;
  if not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if c.owner_id is not null and c.stylist_manifest_id is not null then
    v_policy := jsonb_build_object('activated',c.stylist_activated,'noticeRevision',c.stylist_notice_revision,
      'manifestId',c.stylist_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.stylist_manifest_id),
      'maxRequestMicro',c.stylist_max_request_micro::text);
  end if;
  return jsonb_build_object('code',private.stylist_permission(p,c),'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.stylist_consent_revision is not null,'noticeRevision',c.stylist_consent_revision,
      'consentedAt',c.stylist_consented_at),
    'policy',v_policy,
    'budget',case when c.owner_id is null then null else private.ai_budget_json(c.monthly_allowance_micro,v_used) end);
end;
$$;

create or replace function public.stylist_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  if p_enabled and not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.stylist_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.stylist_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set stylist_consent_revision=p_notice_revision,stylist_consented_at=clock_timestamp(),updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  else
    update private.ai_controls set stylist_consent_revision=null,stylist_consented_at=null,updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  end if;
  return public.stylist_status();
end;
$$;

-- RAIN1's claim (20261009090000) without the hourly and stylist-money terms: only the shared sum decides.
create or replace function public.stylist_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  v_used numeric; v_period text; v_items jsonb;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  v_code := private.stylist_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null then return jsonb_build_object('code','INVALID_INPUT','claimed',false); end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id not in ('azure-eu-terra-stylist-v1','azure-eu-terra-stylist-v2') or m.review_expires_at<=v_now then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.stylist_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.stylist_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.stylist_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if v_used+c.stylist_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  select coalesce(jsonb_agg(x.j order by x.id),'[]'::jsonb) into v_items from (
    select i.id,jsonb_build_object('id',i.id,'category',i.category,'colours',to_jsonb(i.colours),'pattern',i.pattern,
      'sleeve_length',i.sleeve_length,'garment_length',i.garment_length,'seasons',to_jsonb(i.seasons),'formality',i.formality,
      'warmth',case when i.field_provenance->'warmth'->>'kind'='user' then i.warmth end,
      'min_temp',case when i.field_provenance->'min_temp'->>'kind'='user' then i.min_temp end,
      'max_temp',case when i.field_provenance->'max_temp'->>'kind'='user' then i.max_temp end,
      'rain_rating',case when i.field_provenance->'rain_rating'->>'kind'='user' then i.rain_rating end,
      'windproof',case when i.field_provenance->'windproof'->>'kind'='user' then i.windproof end,
      'upper_coverage',i.upper_coverage,
      'lower_coverage',case when i.field_provenance->'lower_coverage'->>'kind' in ('user','ai_observed') then i.lower_coverage end,
      'favourite',i.favourite) j
    from public.items i
    where i.owner_id=p.owner_id and i.deleted_at is null and i.lifecycle='active' and i.availability='ready'
      and not i.exclude_suggestions
      and exists(select 1 from public.item_images im where im.owner_id=i.owner_id and im.item_id=i.id
        and im.state='ready' and im.retired_at is null)
      and not exists(select 1 from private.item_deletion_claims d where d.owner_id=i.owner_id and d.item_id=i.id)
      and not private.image_change_fenced(i.owner_id,i.id)
    order by i.id limit 500) x;
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,purpose)
    values(p.owner_id,p_request_id,v_period,v_now,c.stylist_max_request_micro,c.stylist_max_request_micro,'held',v_now,'stylist');
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation)
    values(p.owner_id,p_request_id,m.id,'not_observed');
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '5 seconds')*1000)::bigint,'items',v_items);
end;
$$;

-- The operator's direct-call allocation still lowers the one budget by the allocated amount under the admission locks;
-- it no longer reads or clamps a stylist sub-limit.
create or replace function public.stylist_direct_allocation(p_owner_id uuid,p_allocation_micro bigint,p_expected_total_micro bigint) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare c private.ai_controls; v_used numeric; v_new bigint;
begin
  if p_owner_id is null or p_allocation_micro is null or p_allocation_micro<=0 or p_expected_total_micro is null then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  perform 1 from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if c.monthly_allowance_micro<>p_expected_total_micro then return jsonb_build_object('code','CONFLICT'); end if;
  v_new := c.monthly_allowance_micro-p_allocation_micro;
  v_used := private.ai_budget_used(p_owner_id,clock_timestamp());
  if v_new<=0 or v_new<c.max_request_micro or v_used>v_new then
    return jsonb_build_object('code','DEFER','usedMicro',v_used::text,'newTotalMicro',v_new::text);
  end if;
  update private.ai_controls set monthly_allowance_micro=v_new,updated_at=clock_timestamp() where owner_id=p_owner_id;
  return jsonb_build_object('code','OK','previousTotalMicro',c.monthly_allowance_micro::text,'newTotalMicro',v_new::text);
end;
$$;

-- Photo cleanup (enhancement).
create or replace function private.enhance_probe_permission(p_profile public.profiles,p_controls private.ai_controls,
  p_auth private.enhancement_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.enhance_manifest_id is null or p_controls.enhance_max_request_micro is null then 'UNCONFIGURED'
    when p_auth.id is null or p_auth.owner_id<>p_profile.owner_id or p_auth.stopped_at is not null
      or p_auth.expires_at<=p_now or p_auth.manifest_id<>p_controls.enhance_manifest_id then 'INACTIVE'
    else 'OK' end;
$$;

create or replace function public.enhance_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_used numeric; v_policy jsonb := null;
  v_available boolean := false;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.enhance_expire(p.owner_id,v_now,100); end if;
  if not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if c.owner_id is not null and c.enhance_manifest_id is not null then
    select k.dispatch_enabled into v_available from private.provider_deployments d
      join private.provider_capacity k on k.deployment_key=d.deployment_key where d.manifest_id=c.enhance_manifest_id;
    v_policy := jsonb_build_object('activated',c.enhance_activated,'noticeRevision',c.enhance_notice_revision,
      'manifestId',c.enhance_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.enhance_manifest_id),
      'maxRequestMicro',c.enhance_max_request_micro::text,'providerAvailable',coalesce(v_available,false));
  end if;
  return jsonb_build_object('code',private.enhance_permission(p,c),'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.enhance_consent_revision is not null,'noticeRevision',c.enhance_consent_revision,
      'consentedAt',c.enhance_consented_at),
    'policy',v_policy,
    'budget',case when c.owner_id is null then null else private.ai_budget_json(c.monthly_allowance_micro,v_used) end);
end;
$$;

create or replace function public.enhance_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  if p_enabled and not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.enhance_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.enhance_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set enhance_consent_revision=p_notice_revision,enhance_consented_at=clock_timestamp(),updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  else
    update private.ai_controls set enhance_consent_revision=null,enhance_consented_at=null,updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  end if;
  return public.enhance_status();
end;
$$;

-- 20261002090000's claim without the hourly and cleanup-money terms. A full shared deployment is BUSY.
create or replace function public.enhance_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_input_sha256 text,p_probe_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.enhancement_probe_authorisations; k private.provider_capacity;
  m private.ai_execution_manifests; v_now timestamptz; v_code text; v_used numeric; v_period text; v_slot uuid;
  v_calls bigint; v_spent numeric;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if p_probe_id is not null then
      select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id for update nowait;
    end if;
    select x.* into k from private.provider_capacity x join private.provider_deployments d on d.deployment_key=x.deployment_key
      where d.manifest_id=p_manifest_id for update of x;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  perform private.enhance_expire(p.owner_id,v_now,100);
  if p_probe_id is not null then
    select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id;
  end if;
  v_code := case when p_probe_id is null then private.enhance_permission(p,c) else private.enhance_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null or p_input_sha256 is null or p_input_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-cleanup-v1' or m.review_expires_at<=v_now or k.deployment_key is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.enhance_manifest_id<>m.id or (a.id is not null and a.deployment_key<>k.deployment_key) then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if c.enhance_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if v_used+c.enhance_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.enhance_probe_id=a.id;
    if v_calls>=a.max_calls or v_spent+c.enhance_max_request_micro>a.allocation_micro then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','BUSY','claimed',false);
  end if;
  v_slot := gen_random_uuid();
  insert into private.provider_slots(slot_id,deployment_key,held_until)
    values(v_slot,k.deployment_key,v_now+interval '5 seconds'+make_interval(secs=>k.window_seconds));
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,
      purpose,provider_slot_id)
    values(p.owner_id,p_request_id,v_period,v_now,c.enhance_max_request_micro,c.enhance_max_request_micro,'held',v_now,
      'enhancement',v_slot);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,enhance_input_sha256,enhance_probe_id)
    values(p.owner_id,p_request_id,m.id,'not_observed',p_input_sha256,a.id);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '5 seconds')*1000)::bigint,'requestSeconds',m.request_seconds);
end;
$$;

-- On-ledger probe authorisation: it must fit the one budget now and is charged on the normal ledger with no extra
-- subtraction. No cleanup sub-limit is read.
create or replace function public.enhance_probe_authorise(p_id uuid,p_owner_id uuid,p_manifest_id text,p_max_calls integer,
  p_allocation_micro bigint,p_approval_ref text,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.enhancement_probe_authorisations; v_used numeric; v_key text;
  v_now timestamptz := clock_timestamp();
begin
  if p_id is null or p_owner_id is null or p_manifest_id is null or p_max_calls is null or p_max_calls not between 1 and 6
    or p_allocation_micro is null or p_allocation_micro<=0 or p_approval_ref is null
    or p_approval_ref !~ '^[A-Za-z0-9._:/#-]{1,200}$' or p_expires_at is null then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  perform 1 from private.approved_accounts where user_id=p_owner_id for share;
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id for update;
  select * into a from private.enhancement_probe_authorisations where id=p_id or approval_ref=p_approval_ref
    order by (id=p_id) desc limit 1 for update;
  if found then
    if a.id=p_id and a.owner_id=p_owner_id and a.manifest_id=p_manifest_id and a.max_calls=p_max_calls
      and a.allocation_micro=p_allocation_micro and a.approval_ref=p_approval_ref and a.expires_at=p_expires_at then
      return jsonb_build_object('code','OK','replayed',true,'id',a.id,'deploymentKey',a.deployment_key);
    end if;
    return jsonb_build_object('code','CONFLICT');
  end if;
  if not private.ai_owner_approved(p_owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if c.owner_id is null or not c.activated or c.enhance_manifest_id is distinct from p_manifest_id or c.enhance_max_request_micro is null then
    return jsonb_build_object('code','UNCONFIGURED');
  end if;
  select deployment_key into v_key from private.provider_deployments where manifest_id=p_manifest_id;
  if v_key is null or p_expires_at<=v_now or p_expires_at>v_now+interval '7 days'
    or p_allocation_micro<c.enhance_max_request_micro then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  v_used := private.ai_budget_used(p_owner_id,v_now);
  if v_used+p_allocation_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','DEFER','totalMicro',v_used::text);
  end if;
  insert into private.enhancement_probe_authorisations(id,owner_id,deployment_key,manifest_id,max_calls,allocation_micro,
      approval_ref,expires_at,created_at)
    values(p_id,p_owner_id,v_key,p_manifest_id,p_max_calls,p_allocation_micro,p_approval_ref,p_expires_at,v_now);
  return jsonb_build_object('code','OK','replayed',false,'id',p_id,'deploymentKey',v_key);
end;
$$;

-- Try-on.
create or replace function private.tryon_probe_permission(p_profile public.profiles,p_controls private.ai_controls,
  p_auth private.tryon_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.tryon_manifest_id is null or p_controls.tryon_max_request_micro is null then 'UNCONFIGURED'
    when not exists(select 1 from private.ai_execution_manifests m where m.id=p_controls.tryon_manifest_id
      and m.review_expires_at>p_now) then 'UNCONFIGURED'
    when p_auth.id is null or p_auth.owner_id<>p_profile.owner_id or p_auth.stopped_at is not null
      or p_auth.expires_at<=p_now or p_auth.manifest_id<>p_controls.tryon_manifest_id
      or p_auth.deployment_key is distinct from (select d.deployment_key from private.provider_deployments d
        where d.manifest_id=p_controls.tryon_manifest_id) then 'INACTIVE'
    when p_controls.tryon_activated and p_controls.tryon_consent_revision is not distinct from p_controls.tryon_notice_revision
      then 'INACTIVE'
    else 'OK' end;
$$;

create or replace function public.tryon_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_used numeric; v_policy jsonb := null;
  v_available boolean := false; v_results bigint; v_code text;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.tryon_expire_owner(p.owner_id,v_now,100); end if;
  if not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  select count(*) into v_results from private.tryon_results where owner_id=p.owner_id
    and (state='reserved' or expires_at>v_now);
  if c.owner_id is not null and c.tryon_manifest_id is not null then
    select k.dispatch_enabled into v_available from private.provider_deployments d
      join private.provider_capacity k on k.deployment_key=d.deployment_key where d.manifest_id=c.tryon_manifest_id;
    v_policy := jsonb_build_object('activated',c.tryon_activated,'noticeRevision',c.tryon_notice_revision,
      'manifestId',c.tryon_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.tryon_manifest_id),
      'maxRequestMicro',c.tryon_max_request_micro::text,
      'maxSteps',3,'maxResults',20,'resultDays',7,'providerAvailable',coalesce(v_available,false));
  end if;
  v_code := private.tryon_permission(p,c,v_now);
  return jsonb_build_object('code',v_code,'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.tryon_consent_revision is not null,'noticeRevision',c.tryon_consent_revision,
      'consentedAt',c.tryon_consented_at),
    'policy',v_policy,'results',v_results,
    'budget',case when c.owner_id is null then null else private.ai_budget_json(c.monthly_allowance_micro,v_used) end);
end;
$$;

-- Withdrawal is unchanged and always accepted, and it still ends every running chain in the same transaction.
create or replace function public.tryon_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_chain uuid;
begin
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  if p_enabled and not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.tryon_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.tryon_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set tryon_consent_revision=p_notice_revision,tryon_consented_at=v_now,updated_at=v_now
      where owner_id=p.owner_id;
  else
    for v_chain in select chain_id from private.tryon_chains where owner_id=p.owner_id and state='running'
      order by chain_id for update
    loop
      perform private.tryon_end_chain(p.owner_id,v_chain,'withdrawn','WITHDRAWN',v_now);
    end loop;
    update private.ai_controls set tryon_consent_revision=null,tryon_consented_at=null,updated_at=v_now
      where owner_id=p.owner_id;
  end if;
  return public.tryon_status();
end;
$$;

-- 20261004090000's claim without the hourly and try-on-money terms. The first-chain precheck still needs the whole
-- chain to fit the one budget now; each step re-checks and holds atomically, so another feature may use the remaining
-- money between steps and a later step then refuses without a provider call. A full shared deployment is BUSY.
create or replace function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; t private.tryon_chains;
  k private.provider_capacity; m private.ai_execution_manifests; v_now timestamptz; v_code text; v_used numeric; v_slot uuid;
  v_steps jsonb; v_step jsonb; v_n integer; v_r bigint; v_calls bigint; v_spent numeric; v_path text; v_new boolean;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if p_probe_id is not null then
      select * into a from private.tryon_probe_authorisations where id=p_probe_id and owner_id=p_owner_id for update nowait;
    end if;
    if p_chain_id is not null then
      select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=p_chain_id for update nowait;
    end if;
    select x.* into k from private.provider_capacity x join private.provider_deployments d on d.deployment_key=x.deployment_key
      where d.manifest_id=p_manifest_id for update of x;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  perform private.tryon_expire_owner(p.owner_id,v_now,100);
  if p_probe_id is not null then
    select * into a from private.tryon_probe_authorisations where id=p_probe_id and owner_id=p_owner_id;
  end if;
  if p_chain_id is not null then
    select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=p_chain_id;
  end if;
  v_code := case when p_probe_id is null then private.tryon_permission(p,c,v_now)
    else private.tryon_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~uuid_re or p_chain_id is null or p_chain_id::text!~uuid_re
    or p_step is null or p_step not between 1 and 3 or p_manifest_id is null
    or (p_step=1 and p_person_sha256 is not null)
    or (p_step>1 and (p_person_sha256 is null or p_person_sha256 !~ '^[0-9a-f]{64}$'))
    or (t.chain_id is null and (p_step<>1 or p_outfit_id is null))
    or (t.chain_id is not null and p_outfit_id is not null and p_outfit_id<>t.outfit_id) then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v1' or m.review_expires_at<=v_now or k.deployment_key is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.tryon_manifest_id<>m.id or (a.id is not null and a.deployment_key<>k.deployment_key) then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  v_r := c.tryon_max_request_micro;
  if v_r<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.tryon_probe_id=a.id;
  end if;
  v_new := t.chain_id is null;
  if v_new then
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED','claimed',false);
    end if;
    if exists(select 1 from private.tryon_results where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','TERMINAL','claimed',false);
    end if;
    if private.tryon_purge_overdue(v_now) then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
      return jsonb_build_object('code','NOT_FOUND','claimed',false);
    end if;
    v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
    v_n := jsonb_array_length(v_steps);
    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;
    if (select count(*) from private.tryon_results where owner_id=p.owner_id
        and (state='reserved' or expires_at>v_now))>=20 then
      return jsonb_build_object('code','RESULTS_FULL','claimed',false);
    end if;
    if v_used+v_n*v_r>c.monthly_allowance_micro then
      return jsonb_build_object('code','ALLOWANCE','claimed',false);
    end if;
    if a.id is not null and (v_calls+v_n>a.max_calls or v_spent+v_n*v_r>a.allocation_micro) then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
  else
    if t.state<>'running' then
      return jsonb_build_object('code',case t.state when 'withdrawn' then 'WITHDRAWN' when 'cancelled' then 'CANCELLED'
        when 'expired' then 'EXPIRED' when 'stale' then 'CHAIN_MISMATCH' else 'TERMINAL' end,'claimed',false);
    end if;
    if t.next_step<>p_step or (p_step>1 and p_person_sha256 is distinct from t.last_output_sha256) then
      return jsonb_build_object('code','CONFLICT','claimed',false);
    end if;
    if t.active_request_id is not null then return jsonb_build_object('code','BUSY','claimed',false); end if;
    v_steps := t.steps;
    v_n := jsonb_array_length(v_steps);
  end if;
  if p_step>v_n then return jsonb_build_object('code','CONFLICT','claimed',false); end if;
  v_step := v_steps->(p_step-1);
  if not private.tryon_garment_current(p.owner_id,(v_step->>'itemId')::uuid,(v_step->>'imageId')::uuid,
      v_step->>'mainSha256',(v_step->>'bytes')::integer) then
    if not v_new then perform private.tryon_end_chain(p.owner_id,t.chain_id,'stale','CHAIN_MISMATCH',v_now); end if;
    return jsonb_build_object('code','CHAIN_MISMATCH','claimed',false);
  end if;
  if v_used+v_r>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null and (v_calls>=a.max_calls or v_spent+v_r>a.allocation_micro) then
    return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','BUSY','claimed',false);
  end if;
  select main_path into v_path from public.item_images where owner_id=p.owner_id and id=(v_step->>'imageId')::uuid;
  if v_new then
    insert into private.tryon_chains(owner_id,chain_id,outfit_id,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,v_steps,'running',1,gen_random_uuid(),v_now,v_now+interval '30 minutes')
      returning * into t;
    insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,created_at)
      values(p.owner_id,t.result_id,t.chain_id,t.outfit_id,'reserved',
        (select array_agg((x->>'itemId')::uuid order by n) from jsonb_array_elements(v_steps) with ordinality q(x,n)),v_now);
  end if;
  insert into private.tryon_attempts(owner_id,request_id,chain_id,step,state,dispatch_before,created_at)
    values(p.owner_id,p_request_id,t.chain_id,p_step,'claimed',v_now+interval '15 seconds',v_now);
  update private.tryon_chains set active_request_id=p_request_id where owner_id=p.owner_id and chain_id=t.chain_id;
  v_slot := gen_random_uuid();
  insert into private.provider_slots(slot_id,deployment_key,held_until)
    values(v_slot,k.deployment_key,v_now+interval '20 seconds'+make_interval(secs=>k.window_seconds));
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,
      purpose,provider_slot_id,tryon_chain_id,tryon_step)
    values(p.owner_id,p_request_id,to_char(v_now at time zone 'UTC','YYYY-MM'),v_now,v_r,v_r,'held',v_now,
      'try_on',v_slot,t.chain_id,p_step);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,tryon_dispatch_before,tryon_probe_id)
    values(p.owner_id,p_request_id,m.id,'not_observed',v_now+interval '15 seconds',a.id);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,'chainId',t.chain_id,'step',p_step,'steps',v_n,
    'last',p_step=v_n,'slot',v_step->>'slot',
    'garment',jsonb_build_object('path',v_path,'mainSha256',v_step->>'mainSha256','bytes',(v_step->>'bytes')::integer),
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '15 seconds')*1000)::bigint,
    'requestSeconds',m.request_seconds,'reservationMicro',v_r::text);
end;
$$;

create or replace function public.tryon_probe_authorise(p_id uuid,p_owner_id uuid,p_manifest_id text,p_max_calls integer,
  p_allocation_micro bigint,p_approval_ref text,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; v_used numeric; v_key text;
  v_now timestamptz := clock_timestamp();
begin
  if p_id is null or p_owner_id is null or p_manifest_id is null or p_max_calls is null or p_max_calls not between 1 and 5
    or p_allocation_micro is null or p_allocation_micro<=0 or p_approval_ref is null
    or p_approval_ref !~ '^[A-Za-z0-9._:/#-]{1,200}$' or p_expires_at is null then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  perform 1 from private.approved_accounts where user_id=p_owner_id for share;
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id for update;
  select * into a from private.tryon_probe_authorisations where id=p_id or approval_ref=p_approval_ref
    order by (id=p_id) desc limit 1 for update;
  if found then
    if a.id=p_id and a.owner_id=p_owner_id and a.manifest_id=p_manifest_id and a.max_calls=p_max_calls
      and a.allocation_micro=p_allocation_micro and a.approval_ref=p_approval_ref and a.expires_at=p_expires_at then
      return jsonb_build_object('code','OK','replayed',true,'id',a.id,'deploymentKey',a.deployment_key);
    end if;
    return jsonb_build_object('code','CONFLICT');
  end if;
  if not private.ai_owner_approved(p_owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if c.owner_id is null or not c.activated or c.tryon_manifest_id is distinct from p_manifest_id or c.tryon_max_request_micro is null then
    return jsonb_build_object('code','UNCONFIGURED');
  end if;
  select deployment_key into v_key from private.provider_deployments where manifest_id=p_manifest_id;
  if v_key is null or p_expires_at<=v_now or p_expires_at>v_now+interval '7 days'
    or p_allocation_micro<c.tryon_max_request_micro then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  v_used := private.ai_budget_used(p_owner_id,v_now);
  if v_used+p_allocation_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','DEFER','totalMicro',v_used::text);
  end if;
  insert into private.tryon_probe_authorisations(id,owner_id,deployment_key,manifest_id,max_calls,allocation_micro,
      approval_ref,expires_at,created_at)
    values(p_id,p_owner_id,v_key,p_manifest_id,p_max_calls,p_allocation_micro,p_approval_ref,p_expires_at,v_now);
  return jsonb_build_object('code','OK','replayed',false,'id',p_id,'deploymentKey',v_key);
end;
$$;

-- The retired amount and hourly arguments are optional history: when given they are stored and compared on replay but
-- never constrain the one budget.
create or replace function public.tryon_bootstrap(p_owner_id uuid,p_manifest_id text,p_notice_revision integer,
  p_max_request_micro bigint,p_monthly_allowance_micro bigint,p_max_requests_per_hour integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare c private.ai_controls; m private.ai_execution_manifests;
begin
  if p_owner_id is null or p_manifest_id is null or p_notice_revision is null or p_notice_revision<1
    or p_max_request_micro is null or p_max_request_micro<=0
    or (p_monthly_allowance_micro is not null and p_monthly_allowance_micro<=0)
    or (p_max_requests_per_hour is not null and p_max_requests_per_hour not between 1 and 1000) then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  perform 1 from private.approved_accounts where user_id=p_owner_id for share;
  perform 1 from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v1' then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if c.tryon_manifest_id is not null or c.tryon_notice_revision is not null or c.tryon_max_request_micro is not null
    or c.tryon_monthly_allowance_micro is not null or c.tryon_max_requests_per_hour is not null then
    if c.tryon_manifest_id=p_manifest_id and c.tryon_notice_revision=p_notice_revision
      and c.tryon_max_request_micro=p_max_request_micro
      and c.tryon_monthly_allowance_micro is not distinct from p_monthly_allowance_micro
      and c.tryon_max_requests_per_hour is not distinct from p_max_requests_per_hour then
      return jsonb_build_object('code','OK','replayed',true);
    end if;
    return jsonb_build_object('code','CONFLICT');
  end if;
  if p_max_request_micro<m.reservation_micro then
    return jsonb_build_object('code','INVALID_LIMITS');
  end if;
  update private.ai_controls set tryon_manifest_id=p_manifest_id,tryon_notice_revision=p_notice_revision,
    tryon_max_request_micro=p_max_request_micro,tryon_monthly_allowance_micro=p_monthly_allowance_micro,
    tryon_max_requests_per_hour=p_max_requests_per_hour,updated_at=clock_timestamp()
    where owner_id=p_owner_id;
  return jsonb_build_object('code','OK','replayed',false);
end;
$$;

-- Admin. The v1 reader and setter fail closed: they cannot show or change the retired limits.
create or replace function public.admin_ai_spending(p_months integer default 6) returns jsonb
language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return jsonb_build_object('code','UNAVAILABLE');
end;
$$;

create or replace function public.admin_set_ai_limits(p_admission_no smallint,p_account_version text,p_expected jsonb,
  p_limits jsonb,p_reason_code text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return jsonb_build_object('code','UNAVAILABLE');
end;
$$;

-- One account as the admin may see it under the budget contract: admission number, enabled, the one budget amount,
-- activation flags, spending by purpose, current consumption and aggregate open probe allocations. Nothing else.
create function private.admin_account_v3(a private.approved_accounts,p_now timestamptz,p_months text[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := private.admin_account_v2(a,p_now,p_months); c private.ai_controls; k text; cur jsonb := '{}'::jsonb;
begin
  select * into c from private.ai_controls where owner_id=a.user_id;
  v := jsonb_set(v,'{limits}',case when c.owner_id is null then 'null'::jsonb
    else jsonb_build_object('monthlyAllowanceMicro',c.monthly_allowance_micro::text) end);
  foreach k in array array['shared','analysis','stylist','enhancement','tryOn'] loop
    cur := cur||jsonb_build_object(k,jsonb_build_object('usedMicro',v#>>array['current',k,'usedMicro']));
  end loop;
  return jsonb_set(v,'{current}',jsonb_build_object('period',v#>>'{current,period}')||cur);
end;
$$;

create or replace function public.admin_ai_spending_v2(p_months integer default 6) returns jsonb
language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_months text[];
begin
  if private.admin_authority() is null or not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_months is null or p_months<1 or p_months>12 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select array_agg(to_char(date_trunc('month',v_now at time zone 'UTC')-make_interval(months=>g),'YYYY-MM') order by g)
    into v_months from generate_series(0,p_months-1) g;
  return jsonb_build_object('code','OK','asOf',floor(extract(epoch from v_now)*1000)::bigint,'months',to_jsonb(v_months),
    'accounts',coalesce((select jsonb_agg(private.admin_account_v3(a,v_now,v_months) order by a.admission_no)
      from private.approved_accounts a
      where a.user_id is not null and exists(select 1 from public.profiles p where p.owner_id=a.user_id)),'[]'::jsonb));
end;
$$;

create function private.admin_budget_shape(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p is not null and jsonb_typeof(p)='object' and (select count(*) from jsonb_object_keys(p))=1
    and jsonb_typeof(p->'monthlyAllowanceMicro')='string'
    and (p->>'monthlyAllowanceMicro') ~ '^(0|[1-9][0-9]{0,11})$',false);
$$;

-- Sets one account's monthly budget, and only that: never activation, consent, notice, manifest, usage, holds or the
-- retired limit columns. Same authority, lock order, account version, expected-value check and audit as AD1. Any positive
-- amount up to the USD 50 app ceiling is accepted, including one below current usage.
create function private.admin_set_budget(p_admission_no smallint,p_account_version text,p_expected jsonb,p_limits jsonb,
  p_reason_code text) returns jsonb
language plpgsql volatile set search_path = '' set lock_timeout = '2s' as $$
declare v_actor uuid := private.admin_authority(); v_actor_no smallint; t private.approved_accounts; c private.ai_controls;
  v_current jsonb; v_saved jsonb; v_new numeric; v_used numeric;
begin
  if v_actor is null or not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_admission_no is null or p_admission_no not in (1,2) or p_account_version is null
    or p_account_version !~ '^[0-9a-f]{64}$' or not private.admin_budget_shape(p_expected)
    or not private.admin_budget_shape(p_limits)
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
  v_current := jsonb_build_object('monthlyAllowanceMicro',c.monthly_allowance_micro::text);
  if p_expected<>v_current then return jsonb_build_object('code','CONFLICT','limits',v_current); end if;
  v_new := (p_limits->>'monthlyAllowanceMicro')::numeric;
  if v_new<=0 then
    return jsonb_build_object('code','INVALID_LIMITS','field','monthlyAllowanceMicro','reason','NOT_POSITIVE');
  end if;
  if v_new>50000000 then
    return jsonb_build_object('code','INVALID_LIMITS','field','monthlyAllowanceMicro','reason','APP_LIMIT');
  end if;
  if p_limits=v_current then return jsonb_build_object('code','UNCHANGED','limits',v_current); end if;
  update private.ai_controls set monthly_allowance_micro=v_new::bigint,updated_at=clock_timestamp()
    where owner_id=t.user_id returning * into c;
  v_saved := jsonb_build_object('monthlyAllowanceMicro',c.monthly_allowance_micro::text);
  if v_saved<>p_limits then raise exception using errcode='P0001',message='Limit write changed'; end if;
  insert into private.ai_limit_audit(id,created_at,owner_id,target_admission_no,actor_owner_id,old_limits,new_limits,reason_code)
    values(gen_random_uuid(),clock_timestamp(),t.user_id,t.admission_no,v_actor,v_current,v_saved,p_reason_code);
  v_used := private.ai_budget_used(t.user_id,clock_timestamp());
  return jsonb_build_object('code','OK','limits',v_saved,'belowUse',v_used>c.monthly_allowance_micro::numeric);
end;
$$;

create or replace function public.admin_set_ai_limits_v2(p_admission_no smallint,p_account_version text,p_expected jsonb,
  p_limits jsonb,p_reason_code text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return private.admin_set_budget(p_admission_no,p_account_version,p_expected,p_limits,p_reason_code);
end;
$$;

revoke all on function private.admin_account_v3(private.approved_accounts,timestamptz,text[]),
  private.admin_budget_shape(jsonb),private.admin_set_budget(smallint,text,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;

commit;
