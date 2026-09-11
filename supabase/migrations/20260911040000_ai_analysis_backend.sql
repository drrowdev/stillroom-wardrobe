-- I29 B1 source only. No owner activation, inventory/media write or paid-call authorization.
begin;

create table private.ai_execution_manifests (
  id text primary key,
  model_id text not null,
  prompt_version integer not null,
  prompt_sha256 text not null,
  schema_sha256 text not null,
  settings_sha256 text not null,
  product text not null,
  host text not null,
  api_version text not null,
  region text not null,
  traffic text not null,
  tariff_url text not null,
  tariff_retrieved_at timestamptz not null,
  tariff_description text not null,
  currency text not null check (currency='USD'),
  input_rate_hundredths integer not null,
  output_rate_hundredths integer not null,
  input_envelope bigint not null,
  output_envelope bigint not null,
  reservation_micro bigint not null,
  maximum_image_bytes integer not null,
  maximum_side integer not null,
  maximum_response_bytes integer not null,
  maximum_result_bytes integer not null,
  request_seconds integer not null,
  review_expires_at timestamptz not null
);
insert into private.ai_execution_manifests values (
  'google-eu-3.8-v1','gemini-3.8-flash',1,
  'bbd7acbbff2934bddd34c25cdbd2a956bccb222eedeaa02ecd1f323f55c5a2ee',
  '15827988e5af84c0a76c95927030059c75df3ca533ba3c979b97fafbb81a6118',
  '4783c04e6e0a7fcc9710201c76921914f4364a5d4698b1113eea8a18dd23b078',
  'Google Cloud Gemini Enterprise Agent Platform','aiplatform.eu.rep.googleapis.com','v1','eu','ON_DEMAND',
  'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing',
  '2026-09-11T04:17:01.6988801Z',
  'Standard Non-global 3.8 Flash; both <=200K and >200K contexts. Full uncached text/image/video/audio input; text response plus reasoning output. Through 2026-12-31: USD 0.825/4.125 per million. Announced 2027-01-01: 1.65/8.25; higher pair used without credits, priority or cache discounts. Reservation is allowance arithmetic, NOT a proven invoice ceiling: exact-route total generated bound including thoughts and actual returned model version remain paid-activation prerequisites.',
  'USD',165,825,1048576,65536,2270823,512000,1600,262144,8192,20,'2027-01-01T00:00:00Z'
);
create function private.ai_manifest_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='42501',message='Not available';
end;
$$;
create trigger ai_manifest_immutable before update or delete on private.ai_execution_manifests
for each row execute function private.ai_manifest_immutable();
alter table private.ai_execution_manifests enable row level security;
revoke all on private.ai_execution_manifests from public,anon,authenticated,service_role;
revoke all on function private.ai_manifest_immutable() from public,anon,authenticated,service_role;

alter table private.ai_controls add column execution_manifest_id text references private.ai_execution_manifests(id);
alter table private.ai_usage drop constraint ai_usage_charge_state_check;
alter table private.ai_usage add constraint ai_usage_charge_state_check
  check (charge_state in ('reserved','held','settled','released','estimated'));

create table private.ai_usage_evidence (
  owner_id uuid not null,
  request_id uuid not null,
  manifest_id text not null references private.ai_execution_manifests(id),
  normalized_usage jsonb,
  estimated_micro bigint check (estimated_micro >= 0),
  anomaly boolean not null default false,
  primary key(owner_id,request_id),
  foreign key(owner_id,request_id) references private.ai_usage(owner_id,request_id) on delete cascade,
  check ((normalized_usage is null)=(estimated_micro is null)),
  check (normalized_usage is null or (jsonb_typeof(normalized_usage)='object'
    and octet_length(convert_to(normalized_usage::text,'UTF8'))<=2048))
);
create table private.ai_analysis_attestations (
  owner_id uuid not null,
  request_id uuid not null,
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  byte_count integer not null check (byte_count between 1 and 512000),
  width integer not null check (width between 1 and 1600),
  height integer not null check (height between 1 and 1600),
  manifest_id text not null references private.ai_execution_manifests(id),
  claimed_at timestamptz not null,
  dispatch_before timestamptz not null,
  primary key(owner_id,request_id),
  foreign key(owner_id,request_id) references private.ai_requests(owner_id,request_id) on delete cascade,
  check (dispatch_before>claimed_at and dispatch_before<=claimed_at+interval '20 seconds')
);
alter table private.ai_usage_evidence enable row level security;
alter table private.ai_analysis_attestations enable row level security;
revoke all on private.ai_usage_evidence,private.ai_analysis_attestations from public,anon,authenticated,service_role;

-- Complete legacy admission, now with an inaccessible explicit-owner entry.
create function private.ai_begin_owner(p_owner_id uuid,p_request_id uuid,p_draft_id uuid,p_generation integer,p_image_sha256 text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  v_now timestamptz; v_period text; v_code text; v_used numeric; v_count bigint;
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
  select coalesce(sum(accounted_micro) filter (where period=v_period or charge_state in ('reserved','held')),0),
    count(*) filter (where created_at>v_now-interval '1 hour')
    into v_used,v_count from private.ai_usage where owner_id=p.owner_id;
  if v_count>=c.max_requests_per_hour then return jsonb_build_object('code','RATE_LIMIT'); end if;
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
create or replace function public.ai_begin_request(p_request_id uuid,p_draft_id uuid,p_generation integer,p_image_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.ai_begin_owner(auth.uid(),p_request_id,p_draft_id,p_generation,p_image_sha256);
end;
$$;

create function public.ai_claim_analysis(p_owner_id uuid,p_request_id uuid,p_draft_id uuid,p_generation integer,
  p_image_sha256 text,p_byte_count integer,p_width integer,p_height integer,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; m private.ai_execution_manifests;
  u private.ai_usage; r private.ai_requests; a private.ai_analysis_attestations;
  v_now timestamptz; v_code text; v_result jsonb; v_deadline timestamptz;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_now := clock_timestamp();
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_draft_id is null
    or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_draft_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_generation is null or p_generation<1 or p_image_sha256 is null or p_image_sha256!~'^[0-9a-f]{64}$'
    or p_byte_count is null or p_byte_count not between 1 and 512000
    or p_width is null or p_width not between 1 and 1600 or p_height is null or p_height not between 1 and 1600 then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id and id='google-eu-3.8-v1';
  if not found or v_now>=m.review_expires_at or c.execution_manifest_id is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.execution_manifest_id<>m.id or c.model_id<>m.model_id or c.prompt_version<>m.prompt_version then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if c.max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if found then
    select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
    if not found then return jsonb_build_object('code','TERMINAL','claimed',false); end if;
    if r.expires_at<=v_now then
      perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
      return jsonb_build_object('code','TERMINAL','claimed',false);
    end if;
    select * into a from private.ai_analysis_attestations where owner_id=p.owner_id and request_id=p_request_id;
    if not found or a.manifest_id<>m.id or a.image_sha256<>p_image_sha256 or a.byte_count<>p_byte_count
      or a.width<>p_width or a.height<>p_height or r.draft_id<>p_draft_id or r.generation<>p_generation
      or r.model_id<>c.model_id or r.prompt_version<>c.prompt_version or r.notice_revision<>c.notice_revision then
      return jsonb_build_object('code','CONFLICT','claimed',false);
    end if;
    return jsonb_build_object('code','ALREADY_CLAIMED','claimed',false);
  end if;
  v_result := private.ai_begin_owner(p.owner_id,p_request_id,p_draft_id,p_generation,p_image_sha256);
  if v_result->>'code'<>'OK' then return jsonb_build_object('code',v_result->>'code','claimed',false); end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id;
  v_now := clock_timestamp();
  v_deadline := least(v_now+interval '20 seconds',r.expires_at);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id) values(p.owner_id,p_request_id,m.id);
  insert into private.ai_analysis_attestations values(p.owner_id,p_request_id,p_image_sha256,
    p_byte_count,p_width,p_height,m.id,v_now,v_deadline);
  update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'resultExpiresAtMs',floor(extract(epoch from r.expires_at)*1000)::bigint,
    'dispatchBeforeMs',floor(extract(epoch from v_deadline)*1000)::bigint);
end;
$$;

create function private.ai_analysis_permitted(p public.profiles,c private.ai_controls,r private.ai_requests,p_now timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select private.ai_permission(p,c)='OK' and r.model_id=c.model_id and r.prompt_version=c.prompt_version
    and r.notice_revision=c.notice_revision and exists(
      select 1 from private.ai_analysis_attestations a join private.ai_execution_manifests m on m.id=a.manifest_id
      where a.owner_id=p.owner_id and a.request_id=r.request_id and a.image_sha256=r.image_sha256
        and m.id=c.execution_manifest_id and m.id='google-eu-3.8-v1'
        and m.model_id=r.model_id and m.prompt_version=r.prompt_version and p_now<m.review_expires_at);
$$;
create function private.ai_accounting(u private.ai_usage) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('basis',case u.charge_state when 'settled' then 'confirmed' when 'estimated' then 'estimated' else 'held' end,
    'amountMicro',u.accounted_micro::text,'currency','USD');
$$;

-- Retain the old settlement body exactly as the common internal operation.
alter function public.ai_settle_request(uuid,uuid,jsonb,bigint,text) set schema private;
alter function private.ai_settle_request(uuid,uuid,jsonb,bigint,text) rename to ai_settle_core;
alter function private.ai_settle_core(uuid,uuid,jsonb,bigint,text) security invoker;
create function public.ai_settle_request(p_owner_id uuid,p_request_id uuid,p_facts jsonb,p_billed_micro bigint,p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where owner_id=p_owner_id for update;
  if p_code in ('SUCCESS','FAILED') and exists(select 1 from private.ai_usage_evidence
    where owner_id=p_owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','UNAVAILABLE','stored',false);
  end if;
  return private.ai_settle_core(p_owner_id,p_request_id,p_facts,p_billed_micro,p_code);
end;
$$;

create function private.ai_normal_usage(p_usage jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; n numeric;
begin
  if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(convert_to(p_usage::text,'UTF8'))>2048
    or not(p_usage ?& array['modelVersion','trafficType','promptTokenCount','totalTokenCount'])
    or p_usage-array['modelVersion','trafficType','promptTokenCount','totalTokenCount','candidatesTokenCount',
      'thoughtsTokenCount','toolUsePromptTokenCount','cachedContentTokenCount']<>'{}'::jsonb
    or p_usage->>'modelVersion' is distinct from 'gemini-3.8-flash'
    or p_usage->>'trafficType' is distinct from 'ON_DEMAND' then return null; end if;
  for k,v in select key,value from jsonb_each(p_usage-array['modelVersion','trafficType']) loop
    if jsonb_typeof(v)<>'number' then return null; end if;
    n := (v#>>'{}')::numeric;
    if n<0 or n>9007199254740991 or n<>trunc(n) then return null; end if;
  end loop;
  if (p_usage->>'totalTokenCount')::numeric<(p_usage->>'promptTokenCount')::numeric
    or coalesce((p_usage->>'cachedContentTokenCount')::numeric,0)>(p_usage->>'promptTokenCount')::numeric
    or coalesce((p_usage->>'candidatesTokenCount')::numeric,0)+coalesce((p_usage->>'thoughtsTokenCount')::numeric,0)
      +coalesce((p_usage->>'toolUsePromptTokenCount')::numeric,0)
      >(p_usage->>'totalTokenCount')::numeric-(p_usage->>'promptTokenCount')::numeric then return null; end if;
  return p_usage;
end;
$$;

create function public.ai_finish_analysis(p_owner_id uuid,p_request_id uuid,p_manifest_id text,
  p_facts jsonb,p_usage jsonb,p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  e private.ai_usage_evidence; m private.ai_execution_manifests;
  v_now timestamptz; v_usage jsonb; v_estimate bigint; v_anomaly boolean := false; v_result jsonb; v_reason text;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','stored',false,'accounting',null); end if;
  v_now := clock_timestamp();
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if p_request_id is null or p_code is null or p_code not in ('SUCCESS','FAILED','USAGE_ONLY') then
    return jsonb_build_object('code','INVALID_INPUT','stored',false,'accounting',null);
  end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into e from private.ai_usage_evidence where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found or p_manifest_id is distinct from e.manifest_id then
    return jsonb_build_object('code','UNAVAILABLE','stored',false,'accounting',null);
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  v_usage := private.ai_normal_usage(p_usage);
  if v_usage is not null then
    if e.normalized_usage is not null and e.normalized_usage<>v_usage then
      return jsonb_build_object('code','USAGE_CONFLICT','stored',false,'accounting',private.ai_accounting(u));
    end if;
    v_estimate := ceil(((v_usage->>'promptTokenCount')::numeric*m.input_rate_hundredths
      +((v_usage->>'totalTokenCount')::numeric-(v_usage->>'promptTokenCount')::numeric)*m.output_rate_hundredths)/100)::bigint;
    v_anomaly := (v_usage->>'promptTokenCount')::numeric>m.input_envelope
      or (v_usage->>'totalTokenCount')::numeric-(v_usage->>'promptTokenCount')::numeric>m.output_envelope;
    update private.ai_usage_evidence set normalized_usage=v_usage,estimated_micro=v_estimate,anomaly=v_anomaly
      where owner_id=p.owner_id and request_id=p_request_id;
    if u.charge_state<>'settled' then
      update private.ai_usage set accounted_micro=v_estimate,charge_state='estimated'
        where owner_id=p.owner_id and request_id=p_request_id returning * into u;
    end if;
    if v_anomaly then
      update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;
    end if;
  end if;
  if r.request_id is null then v_reason := 'TERMINAL';
  elsif r.expires_at<=v_now then
    perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
    v_reason := 'EXPIRED';
  elsif p_code='USAGE_ONLY' then v_reason := 'TERMINAL';
  elsif p_code='FAILED' then
    perform private.ai_close(p.owner_id,p_request_id,'FAILED',v_now);
    v_reason := 'FAILED';
  elsif not private.ai_analysis_permitted(p,c,r,v_now) or v_anomaly then
    perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now);
    v_reason := 'UNAVAILABLE';
  else
    v_result := private.ai_settle_core(p_owner_id,p_request_id,p_facts,null,'SUCCESS');
    v_reason := v_result->>'code';
  end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code',case when v_anomaly then 'USAGE_ANOMALY' else v_reason end,
    'stored',coalesce((v_result->>'stored')::boolean,false),'accounting',private.ai_accounting(u));
end;
$$;

create or replace function public.ai_request_control(p_request_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests; v_now timestamptz; v_code text;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if p_request_id is null or p_action is null or p_action not in ('status','discard') then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','TERMINAL','reason',u.closed_reason); end if;
  if r.expires_at<=v_now then
    perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
    return jsonb_build_object('code','TERMINAL','reason','EXPIRED');
  end if;
  if p_action='discard' then
    perform private.ai_close(p.owner_id,p_request_id,'DISCARDED',v_now);
    return jsonb_build_object('code','TERMINAL','reason','DISCARDED');
  end if;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  if r.model_id<>c.model_id or r.prompt_version<>c.prompt_version or r.notice_revision<>c.notice_revision then
    return jsonb_build_object('code','CONFIG_CHANGED');
  end if;
  if exists(select 1 from private.ai_usage_evidence where owner_id=p.owner_id and request_id=p_request_id)
    and not private.ai_analysis_permitted(p,c,r,v_now) then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
  return jsonb_build_object('code','OK','status',r.status,'result',
    case when r.status='ready' and u.dispatched_at is not null then private.ai_result(r,r.facts) else null end);
end;
$$;

create function public.ai_analysis_status(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; u private.ai_usage;
begin
  perform 1 from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(auth.uid()) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if not exists(select 1 from private.ai_usage_evidence where owner_id=auth.uid() and request_id=p_request_id) then
    return jsonb_build_object('code','UNAVAILABLE');
  end if;
  v_result := public.ai_request_control(p_request_id,'status');
  if v_result->>'code'<>'OK' then return v_result; end if;
  select * into u from private.ai_usage where owner_id=auth.uid() and request_id=p_request_id;
  return v_result||jsonb_build_object('accounting',private.ai_accounting(u));
end;
$$;

revoke all on function private.ai_begin_owner(uuid,uuid,uuid,integer,text),
  private.ai_analysis_permitted(public.profiles,private.ai_controls,private.ai_requests,timestamptz),
  private.ai_accounting(private.ai_usage),private.ai_settle_core(uuid,uuid,jsonb,bigint,text),
  private.ai_normal_usage(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.ai_begin_request(uuid,uuid,integer,text),public.ai_request_control(uuid,text),
  public.ai_settle_request(uuid,uuid,jsonb,bigint,text),
  public.ai_claim_analysis(uuid,uuid,uuid,integer,text,integer,integer,integer,text),
  public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text),public.ai_analysis_status(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.ai_begin_request(uuid,uuid,integer,text),public.ai_request_control(uuid,text),
  public.ai_analysis_status(uuid) to authenticated;
grant execute on function public.ai_settle_request(uuid,uuid,jsonb,bigint,text),
  public.ai_claim_analysis(uuid,uuid,uuid,integer,text,integer,integer,integer,text),
  public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) to service_role;
commit;
