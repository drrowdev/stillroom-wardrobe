-- ST1a: inactive stylist-chat backend (blueprint 20, ADR24; plan rev2 R1-R8 with binding amendments D1-D6).
-- Additive columns, a new manifest row and new functions only; no existing function body changes. Behaviour-changing:
-- stylist rows share private.ai_usage, so tagging's unchanged admission counts them in its monthly sum and hourly count.
-- Nothing is activated here: every owner keeps stylist_activated=false. 20260928090100 adds the inactive expiry job.
begin;

alter table private.ai_usage
  add column purpose text not null default 'analysis' check (purpose in ('analysis','stylist'));
create index ai_usage_stylist_held on private.ai_usage(owner_id,dispatched_at)
  where purpose='stylist' and charge_state='held';

alter table private.ai_usage_evidence
  add column stylist_code text check (stylist_code in ('OK','FAILED','FILTERED','NOT_DISPATCHED','EXPIRED')),
  add column settlement_origin text check (settlement_origin in ('provisional_expiry','observed','terminal_anomaly','non_dispatch')),
  add column settlement_digest text check (settlement_digest ~ '^[0-9a-f]{64}$'),
  add constraint ai_usage_evidence_stylist_pair check ((stylist_code is null) = (settlement_origin is null)),
  add constraint ai_usage_evidence_stylist_digest check
    ((settlement_origin in ('observed','terminal_anomaly','non_dispatch')) is not distinct from (settlement_digest is not null)
      or (settlement_origin is null and settlement_digest is null));

alter table private.ai_controls
  add column stylist_activated boolean not null default false,
  add column stylist_notice_revision integer check (stylist_notice_revision between 1 and 2147483647),
  add column stylist_manifest_id text references private.ai_execution_manifests(id),
  add column stylist_max_request_micro bigint check (stylist_max_request_micro > 0),
  add column stylist_monthly_allowance_micro bigint check (stylist_monthly_allowance_micro > 0),
  add column stylist_max_requests_per_hour integer check (stylist_max_requests_per_hour between 1 and 1000),
  add column stylist_consent_revision integer check (stylist_consent_revision between 1 and 2147483647),
  add column stylist_consented_at timestamptz,
  add constraint ai_controls_stylist_settings check (not stylist_activated or (stylist_notice_revision is not null
    and stylist_manifest_id is not null and stylist_max_request_micro is not null
    and stylist_monthly_allowance_micro is not null and stylist_max_requests_per_hour is not null)),
  add constraint ai_controls_stylist_consent_pair check ((stylist_consent_revision is null) = (stylist_consented_at is null)),
  add constraint ai_controls_stylist_allowance check (stylist_monthly_allowance_micro is null
    or stylist_monthly_allowance_micro <= monthly_allowance_micro);

-- Applicable tariff: Terra ShortCo USD 2.20/13.20 per million (input far below 272k tokens). The reservation values
-- the 24,000/1,200 envelope at LongCo 4.40/19.80 as a conservative allowance valuation, not an invoice ceiling.
insert into private.ai_execution_manifests values (
  'azure-eu-terra-stylist-v1','gpt-5.6-terra-2026-07-09',1,
  '6914bd8af3f9f95f6a6c5be55bacf711354d1a077d89aeea6e46d64612ad3659',
  '003b745ceaca59678e2f274104fe7b0d3d2c34a181e1e9102df76c232d78409a',
  '16d79575eb9d2673ce1d500ba16ff3f14c61f7fa0f2f6c4f54a755f20b184441',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-21T00:00:00Z',
  'INACTIVE stylist text chat on existing DEV/TEST eval-terra-20260709; expected snapshot gpt-5.6-terra-2026-07-09. Applicable tariff ShortCo USD2.20 input/13.20 output per1M (retail API SwedenCentral/USD, product DZH318Z0T9WD). Reservation 129360 micro values the 24000 input/1200 output envelope at LongCo 4.40/19.80 as a conservative allowance valuation; input envelope is an operational estimate over the bounded 20000-byte messages plus schema/framing, enforced by anomaly shutdown. Enum/number/boolean item fields only; no photos or item text. Explicit cache mode without breakpoints; store:false is not zero retention. Exact-route probe and paid activation remain owner gates.',
  'USD',220,1320,24000,1200,129360,0,0,262144,8192,25,'2026-12-01T00:00:00Z'
);

create function private.stylist_permission(p_profile public.profiles,p_controls private.ai_controls) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.stylist_manifest_id is null then 'UNCONFIGURED'
    when not p_controls.stylist_activated then 'INACTIVE'
    when p_controls.stylist_consent_revision is distinct from p_controls.stylist_notice_revision then 'CONSENT_REQUIRED'
    else 'OK' end;
$$;

-- Stylist-specific Azure usage validator (H2). The tagging normalisers stay unchanged. Reasoning is counted inside
-- output; any cache counter above zero, a missing or unrecognised model or a non-ordinary control is bad.
create function private.stylist_azure_usage(p_usage jsonb,m private.ai_execution_manifests,
  out valid boolean,out bad boolean,out estimate bigint,out over boolean,out model text,out control text)
language plpgsql immutable set search_path = '' as $$
declare k text; n numeric;
  keys constant text[] := array['modelObservation','controlObservation','input','output','total','reasoning','cacheRead','cacheWrite'];
begin
  valid := true; bad := false; estimate := null; over := false; model := null; control := null;
  if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(convert_to(p_usage::text,'UTF8'))>2048
    or not(p_usage ?& keys) or p_usage-keys<>'{}'::jsonb
    or jsonb_typeof(p_usage->'modelObservation')<>'string' or jsonb_typeof(p_usage->'controlObservation')<>'string'
    or p_usage->>'modelObservation' not in ('not_observed','response_missing_model','response_unrecognised_model','expected_snapshot','model_family','deployment_alias')
    or p_usage->>'controlObservation' not in ('ordinary','cache_read','cache_write','cache_read_write','contradictory') then
    valid := false; return;
  end if;
  model := p_usage->>'modelObservation'; control := p_usage->>'controlObservation';
  if model='not_observed' then valid := false; end if;
  bad := model in ('response_missing_model','response_unrecognised_model') or control<>'ordinary';
  foreach k in array keys[3:8] loop
    if jsonb_typeof(p_usage->k) is distinct from 'number' then valid := false;
    else
      n := (p_usage->>k)::numeric;
      if n<0 or n>9007199254740991 or n<>trunc(n) then valid := false;
      elsif k in ('cacheRead','cacheWrite') and n>0 then bad := true; end if;
    end if;
  end loop;
  if valid then
    valid := (p_usage->>'input')::numeric+(p_usage->>'output')::numeric=(p_usage->>'total')::numeric
      and (p_usage->>'reasoning')::numeric<=(p_usage->>'output')::numeric
      and (p_usage->>'cacheRead')::numeric<=(p_usage->>'input')::numeric;
  end if;
  if valid then
    estimate := ceil(((p_usage->>'input')::numeric*m.input_rate_hundredths
      +(p_usage->>'output')::numeric*m.output_rate_hundredths)/100)::bigint;
    over := (p_usage->>'input')::numeric>m.input_envelope or (p_usage->>'output')::numeric>m.output_envelope;
  end if;
end;
$$;

-- Provisional expiry (M1): a held stylist row two minutes after dispatch is estimated at its reservation. A later
-- valid finish may replace the estimate; missing metering is never zero.
create function private.stylist_expire(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  with due as (
    select request_id from private.ai_usage
      where owner_id=p_owner and purpose='stylist' and charge_state='held' and dispatched_at<=p_now-interval '2 minutes'
      order by dispatched_at,request_id limit least(greatest(coalesce(p_limit,0),0),100) for update
  ), closed as (
    update private.ai_usage u set charge_state='estimated',accounted_micro=u.reserved_micro,closed_reason='EXPIRED',closed_at=p_now
      from due where u.owner_id=p_owner and u.request_id=due.request_id returning u.request_id
  )
  update private.ai_usage_evidence e set anomaly=true,stylist_code='EXPIRED',settlement_origin='provisional_expiry'
    from closed where e.owner_id=p_owner and e.request_id=closed.request_id and e.settlement_origin is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function private.stylist_usage(p_owner uuid,p_now timestamptz,
  out stylist_micro numeric,out total_micro numeric,out stylist_hour bigint,out total_hour bigint)
language sql stable set search_path = '' as $$
  select coalesce(sum(accounted_micro) filter (where purpose='stylist' and (period=to_char(p_now at time zone 'UTC','YYYY-MM')
      or charge_state in ('reserved','held'))),0),
    coalesce(sum(accounted_micro) filter (where period=to_char(p_now at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held')),0),
    count(*) filter (where purpose='stylist' and created_at>p_now-interval '1 hour'),
    count(*) filter (where created_at>p_now-interval '1 hour')
  from private.ai_usage where owner_id=p_owner;
$$;

create function public.stylist_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); s record; v_policy jsonb := null;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.stylist_expire(p.owner_id,v_now,100); end if;
  select * into s from private.stylist_usage(p.owner_id,v_now);
  if c.owner_id is not null and c.stylist_manifest_id is not null then
    v_policy := jsonb_build_object('activated',c.stylist_activated,'noticeRevision',c.stylist_notice_revision,
      'manifestId',c.stylist_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.stylist_manifest_id),
      'maxRequestMicro',c.stylist_max_request_micro::text,'stylistAllowanceMicro',c.stylist_monthly_allowance_micro::text,
      'totalAllowanceMicro',c.monthly_allowance_micro::text,'maxRequestsPerHour',c.stylist_max_requests_per_hour);
  end if;
  return jsonb_build_object('code',private.stylist_permission(p,c),'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.stylist_consent_revision is not null,'noticeRevision',c.stylist_consent_revision,
      'consentedAt',c.stylist_consented_at),
    'policy',v_policy,
    'usage',jsonb_build_object('stylistMicro',s.stylist_micro::text,'totalMicro',s.total_micro::text,'stylistLastHour',s.stylist_hour,
      'warning',v_policy is not null and (s.stylist_micro>=0.8*c.stylist_monthly_allowance_micro or s.total_micro>=0.8*c.monthly_allowance_micro)));
end;
$$;

create function public.stylist_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
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

-- Claim (R1/R2/R4/D6): the verified owner comes only from the Edge function's /auth/v1/user check. Lock order matches
-- checked item and image writers: approved account (share, nowait) -> profile -> controls. The account freeze takes the
-- approved-account row for no key update, so a claim and a freeze never overlap. Context stays inside Postgres until
-- every item is proven saved: current ready image, no Trash, no deletion claim and no active deletion fence.
create function public.stylist_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  s record; v_period text; v_items jsonb;
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
  if not found or m.id<>'azure-eu-terra-stylist-v1' or m.review_expires_at<=v_now then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.stylist_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.stylist_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.stylist_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  select * into s from private.stylist_usage(p.owner_id,v_now);
  if s.stylist_hour>=c.stylist_max_requests_per_hour or s.total_hour>=c.max_requests_per_hour then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  if s.stylist_micro+c.stylist_max_request_micro>c.stylist_monthly_allowance_micro
    or s.total_micro+c.stylist_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  select coalesce(jsonb_agg(x.j order by x.id),'[]'::jsonb) into v_items from (
    select i.id,jsonb_build_object('id',i.id,'category',i.category,'colours',to_jsonb(i.colours),'pattern',i.pattern,
      'sleeve_length',i.sleeve_length,'garment_length',i.garment_length,'seasons',to_jsonb(i.seasons),'formality',i.formality,
      'warmth',i.warmth,'min_temp',i.min_temp,'max_temp',i.max_temp,'rain_rating',i.rain_rating,'windproof',i.windproof,
      'upper_coverage',i.upper_coverage,'lower_coverage',i.lower_coverage,'favourite',i.favourite) j
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

-- Finish (D2): idempotent, purpose-checked and conflict-safe. Precedence: invalid usage, then a bad model/control
-- observation, then an envelope overrun, then a valid settlement. Content is released only when this returns OK.
create function private.stylist_replay(e private.ai_usage_evidence,u private.ai_usage,p public.profiles,c private.ai_controls)
returns text language sql stable set search_path = '' as $$
  select case
    when e.settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.stylist_code in ('FAILED','FILTERED') then e.stylist_code
    when c.stylist_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    else private.stylist_permission(p,c) end;
$$;

create function public.stylist_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence; m private.ai_execution_manifests;
  v_now timestamptz; v_digest text; o record; v_code text; v_accounted bigint;
begin
  begin
    perform 1 from private.approved_accounts where user_id=p_owner_id for share;
    select * into p from public.profiles where owner_id=p_owner_id for update;
    if not found then return jsonb_build_object('code','UNAVAILABLE','accounting',null); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update;
    select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id for update;
    select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id for update;
  exception when lock_not_available then return jsonb_build_object('code','BUSY','accounting',null);
  end;
  if u.owner_id is null or u.purpose<>'stylist' or e.owner_id is null then
    return jsonb_build_object('code','INVALID_INPUT','accounting',null);
  end if;
  if p_code is null or p_code not in ('OK','FAILED','FILTERED','NOT_DISPATCHED') or (p_code='NOT_DISPATCHED')<>(p_usage is null) then
    return jsonb_build_object('code','INVALID_INPUT','accounting',private.ai_accounting(u));
  end if;
  v_now := clock_timestamp();
  v_digest := encode(sha256(convert_to(jsonb_build_object('code',p_code,'usage',p_usage)::text,'UTF8')),'hex');
  if e.settlement_origin in ('observed','terminal_anomaly','non_dispatch') then
    if e.settlement_digest<>v_digest then return jsonb_build_object('code','USAGE_CONFLICT','accounting',private.ai_accounting(u)); end if;
    return jsonb_build_object('code',private.stylist_replay(e,u,p,c),'replayed',true,'accounting',private.ai_accounting(u));
  end if;
  if p_code='NOT_DISPATCHED' then
    if u.charge_state='held' then
      update private.ai_usage set charge_state='estimated',closed_reason='UNAVAILABLE',closed_at=v_now
        where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    end if;
    update private.ai_usage_evidence set stylist_code='NOT_DISPATCHED',settlement_origin='non_dispatch',settlement_digest=v_digest,anomaly=false
      where owner_id=p_owner_id and request_id=p_request_id;
    return jsonb_build_object('code','NOT_DISPATCHED','accounting',private.ai_accounting(u));
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  select * into o from private.stylist_azure_usage(p_usage,m);
  if not o.valid or o.bad or o.over then
    v_accounted := case when not o.valid then u.reserved_micro when o.bad then greatest(o.estimate,u.reserved_micro) else o.estimate end;
    update private.ai_usage set charge_state='estimated',accounted_micro=v_accounted,
      closed_reason=coalesce(closed_reason,case when not o.valid then 'FAILED' else 'UNAVAILABLE' end),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set normalized_usage=case when o.valid then p_usage end,estimated_micro=case when o.valid then o.estimate end,
      anomaly=true,model_observation=coalesce(o.model,model_observation),control_observation=o.control,stylist_code=p_code,
      settlement_origin='terminal_anomaly',settlement_digest=v_digest
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.ai_controls set stylist_activated=false,updated_at=v_now where owner_id=p_owner_id;
    return jsonb_build_object('code',case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end,'accounting',private.ai_accounting(u));
  end if;
  v_code := case when u.closed_reason='EXPIRED' then 'EXPIRED' when p_code in ('FAILED','FILTERED') then p_code
    when c.stylist_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE' else private.stylist_permission(p,c) end;
  update private.ai_usage set charge_state='estimated',accounted_micro=o.estimate,
    closed_reason=case when closed_reason is not null then closed_reason when v_code='OK' then null
      when v_code in ('FAILED','FILTERED') then 'FAILED' else 'UNAVAILABLE' end,
    closed_at=case when closed_at is not null then closed_at when v_code='OK' then null else v_now end
    where owner_id=p_owner_id and request_id=p_request_id returning * into u;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=o.estimate,anomaly=false,model_observation=o.model,
    control_observation=o.control,stylist_code=p_code,settlement_origin='observed',settlement_digest=v_digest
    where owner_id=p_owner_id and request_id=p_request_id;
  return jsonb_build_object('code',v_code,'accounting',private.ai_accounting(u));
end;
$$;

-- Scheduled expiry (M1), independent of later stylist or tagging use. Owners are taken skip-locked in profile order.
create function public.stylist_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_left integer;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  v_left := p_limit;
  for v_owner in
    select pr.owner_id from public.profiles pr
      where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id and u.purpose='stylist'
        and u.charge_state='held' and u.dispatched_at<=v_now-interval '2 minutes')
      order by pr.owner_id limit p_limit for update of pr skip locked
  loop
    exit when v_left<=0;
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.stylist_expire(v_owner,v_now,least(v_left,100));
    v_left := p_limit-n;
  end loop;
  return jsonb_build_object('code','OK','expired',n);
end;
$$;

-- Direct-call allocation (D1): before any off-ledger ST0 or probe call, the operator lowers the owner's shared
-- monthly allowance by the allocated USD operational amount, under the admission locks. Guarded by the expected
-- previous total, so a rerun cannot subtract twice.
create function public.stylist_direct_allocation(p_owner_id uuid,p_allocation_micro bigint,p_expected_total_micro bigint) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare c private.ai_controls; s record; v_new bigint;
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
  select * into s from private.stylist_usage(p_owner_id,clock_timestamp());
  if v_new<=0 or v_new<c.max_request_micro or s.total_micro>v_new then
    return jsonb_build_object('code','DEFER','usedMicro',s.total_micro::text,'newTotalMicro',v_new::text);
  end if;
  update private.ai_controls set monthly_allowance_micro=v_new,
    stylist_monthly_allowance_micro=case when stylist_monthly_allowance_micro>v_new then v_new else stylist_monthly_allowance_micro end,
    updated_at=clock_timestamp() where owner_id=p_owner_id;
  return jsonb_build_object('code','OK','previousTotalMicro',c.monthly_allowance_micro::text,'newTotalMicro',v_new::text);
end;
$$;

revoke all on function private.stylist_permission(public.profiles,private.ai_controls),
  private.stylist_azure_usage(jsonb,private.ai_execution_manifests),private.stylist_expire(uuid,timestamptz,integer),
  private.stylist_usage(uuid,timestamptz),
  private.stylist_replay(private.ai_usage_evidence,private.ai_usage,public.profiles,private.ai_controls)
  from public,anon,authenticated,service_role;
revoke all on function public.stylist_status(),public.stylist_set_consent(boolean,integer),
  public.stylist_claim(uuid,uuid,text),public.stylist_finish(uuid,uuid,text,jsonb),
  public.stylist_expire_due(integer),public.stylist_direct_allocation(uuid,bigint,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.stylist_status(),public.stylist_set_consent(boolean,integer) to authenticated;
grant execute on function public.stylist_claim(uuid,uuid,text),public.stylist_finish(uuid,uuid,text,jsonb) to service_role;

commit;
