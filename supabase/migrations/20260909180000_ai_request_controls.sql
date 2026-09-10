-- I29e source-only controls. No policy activation, provider, inventory write or scheduler.
begin;

alter table public.profiles
  add column ai_enabled boolean not null default false,
  add column ai_notice_revision integer check (ai_notice_revision between 1 and 2147483647),
  add column ai_consented_at timestamptz,
  add constraint ai_consent_pair check ((ai_notice_revision is null) = (ai_consented_at is null)),
  add constraint ai_enabled_consent check (not ai_enabled or ai_notice_revision is not null);
revoke update on public.profiles from authenticated;
grant update(owner_id,display_name,ui_language,timezone,currency,weather_enabled,weather_city,
  latitude,longitude,created_at,updated_at,version) on public.profiles to authenticated;

create table private.ai_controls (
  owner_id uuid primary key references public.profiles(owner_id) on delete cascade,
  activated boolean not null default false,
  notice_revision integer not null check (notice_revision between 1 and 2147483647),
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  prompt_version integer not null check (prompt_version between 1 and 2147483647),
  max_request_micro bigint not null check (max_request_micro > 0),
  monthly_allowance_micro bigint not null check (monthly_allowance_micro > 0),
  max_requests_per_hour integer not null check (max_requests_per_hour between 1 and 1000),
  result_ttl_seconds integer not null check (result_ttl_seconds between 1 and 86400),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table private.ai_usage (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  request_id uuid not null,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null,
  reserved_micro bigint not null check (reserved_micro > 0),
  accounted_micro bigint not null check (accounted_micro >= 0),
  charge_state text not null check (charge_state in ('reserved','held','settled','released')),
  dispatched_at timestamptz,
  closed_reason text check (closed_reason in ('DISCARDED','EXPIRED','FAILED','UNAVAILABLE','INVALID_FACTS')),
  closed_at timestamptz,
  primary key(owner_id,request_id),
  check ((closed_reason is null) = (closed_at is null)),
  check (charge_state <> 'reserved' or dispatched_at is null),
  check (charge_state <> 'held' or dispatched_at is not null),
  check (charge_state not in ('reserved','held') or accounted_micro = reserved_micro),
  check (charge_state <> 'released' or (accounted_micro = 0 and dispatched_at is null))
);
create index ai_usage_owner_created on private.ai_usage(owner_id,created_at);
create table private.ai_requests (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  request_id uuid not null,
  draft_id uuid not null,
  generation integer not null check (generation between 1 and 2147483647),
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  prompt_version integer not null check (prompt_version between 1 and 2147483647),
  notice_revision integer not null check (notice_revision between 1 and 2147483647),
  status text not null check (status in ('reserved','dispatched','ready')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  facts jsonb,
  primary key(owner_id,request_id),
  foreign key(owner_id,request_id) references private.ai_usage(owner_id,request_id) on delete cascade,
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  check ((status = 'ready') = (facts is not null)),
  check (facts is null or octet_length(convert_to(facts::text,'UTF8')) <= 8192)
);
create unique index ai_request_active_draft on private.ai_requests(owner_id,draft_id)
  where status in ('reserved','dispatched');
create index ai_request_expiry on private.ai_requests(expires_at,owner_id);
alter table private.ai_controls enable row level security;
alter table private.ai_usage enable row level security;
alter table private.ai_requests enable row level security;
revoke all on private.ai_controls,private.ai_usage,private.ai_requests from public,anon,authenticated;

create function private.ai_owner_approved(p_owner uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists(select 1 from private.approved_accounts a where a.user_id=p_owner and a.enabled);
$$;

create function private.ai_permission(p_profile public.profiles,p_controls private.ai_controls) returns text
language sql stable set search_path = '' as $$
  select case
    when not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null then 'UNCONFIGURED'
    when not p_controls.activated then 'INACTIVE'
    when not p_profile.ai_enabled or p_profile.ai_notice_revision is distinct from p_controls.notice_revision
      then 'CONSENT_REQUIRED'
    else 'OK' end;
$$;

create function private.ai_valid_facts(p_facts jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  observed constant text[] := array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'];
  estimated constant text[] := array['material','seasons','formality','style_tags'];
  k text; v jsonb; e jsonb; n numeric; lim integer; allowed text[];
  whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_facts is null or jsonb_typeof(p_facts)<>'object'
    or octet_length(convert_to(p_facts::text,'UTF8'))>8192 then return false; end if;
  if not (p_facts ?& array['outcome','fields']) or p_facts-array['outcome','fields']<>'{}'::jsonb
    or jsonb_typeof(p_facts->'outcome')<>'string' or p_facts->>'outcome' not in ('ready','unclear')
    or jsonb_typeof(p_facts->'fields')<>'object' then return false; end if;
  for k,v in select key,value from jsonb_each(p_facts->'fields') loop
    if not k=any(observed||estimated) then return false; end if;
    if k in ('colours','seasons','style_tags') then
      if jsonb_typeof(v)<>'array' then return false; end if;
      lim := case k when 'colours' then 3 when 'seasons' then 4 else 8 end;
      if jsonb_array_length(v)>lim
        or (select count(*)<>count(distinct value) from jsonb_array_elements(v)) then return false; end if;
      allowed := case k
        when 'colours' then array['black','white','grey','navy','blue','green','olive','beige','brown','red','yellow','orange','pink','purple']
        when 'seasons' then array['spring','summer','autumn','winter'] else null end;
      for e in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(e)<>'string' then return false; end if;
        if k='style_tags' then
          if char_length(e#>>'{}')>40 or btrim(e#>>'{}',whitespace)='' then return false; end if;
        elsif not (e#>>'{}')=any(allowed) then return false; end if;
      end loop;
    elsif v='null'::jsonb then null;
    elsif k in ('formality','upper_coverage','lower_coverage') then
      if jsonb_typeof(v)<>'number' then return false; end if;
      n := (v#>>'{}')::numeric;
      lim := case k when 'formality' then 4 else 2 end;
      if n<>trunc(n) or n<0 or n>lim then return false; end if;
    elsif k in ('category','pattern','sleeve_length','garment_length') then
      allowed := case k
        when 'category' then array['top','bottom','one_piece','footwear','layer','outerwear','accessory']
        when 'pattern' then array['solid','striped','checked','dotted','floral','graphic','abstract','animal','other']
        when 'sleeve_length' then array['sleeveless','short','elbow','three_quarter','long']
        else array['cropped','short','regular','long'] end;
      if jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(allowed) then return false; end if;
    else
      lim := case k when 'subcategory' then 60 when 'brand' then 100 when 'size_label' then 50 else 200 end;
      if jsonb_typeof(v)<>'string' or char_length(v#>>'{}')>lim
        or btrim(v#>>'{}',whitespace)='' then return false; end if;
    end if;
    if p_facts->>'outcome'='unclear' and v<>'null'::jsonb and v<>'[]'::jsonb then return false; end if;
  end loop;
  return true;
end;
$$;
alter table private.ai_requests add constraint ai_request_facts check (facts is null or private.ai_valid_facts(facts));

create function private.ai_result(p_request private.ai_requests,p_facts jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('schemaVersion',1,'requestId',p_request.request_id,
    'draftId',p_request.draft_id,'generation',p_request.generation,'imageSha256',p_request.image_sha256,
    'modelId',p_request.model_id,'promptVersion',p_request.prompt_version,
    'createdAtMs',floor(extract(epoch from p_request.created_at)*1000)::bigint,
    'expiresAtMs',floor(extract(epoch from p_request.expires_at)*1000)::bigint,'facts',p_facts);
$$;

-- Call only after profile -> controls locks. Ledger precedes the full request.
create function private.ai_close(p_owner uuid,p_request uuid,p_reason text,p_now timestamptz) returns boolean
language plpgsql set search_path = '' as $$
declare v_removed boolean;
begin
  perform 1 from private.ai_usage where owner_id=p_owner and request_id=p_request for update;
  delete from private.ai_requests where owner_id=p_owner and request_id=p_request;
  v_removed := found;
  if v_removed then
    update private.ai_usage set
      accounted_micro=case when charge_state='reserved' and dispatched_at is null then 0 else accounted_micro end,
      charge_state=case when charge_state='reserved' and dispatched_at is null then 'released' else charge_state end,
      closed_reason=p_reason,closed_at=p_now
      where owner_id=p_owner and request_id=p_request;
  end if;
  return v_removed;
end;
$$;

create function private.ai_expire(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select request_id from private.ai_requests where owner_id=p_owner and expires_at<=p_now
    order by expires_at,request_id limit p_limit loop
    if private.ai_close(p_owner,r.request_id,'EXPIRED',p_now) then n := n+1; end if;
  end loop;
  return n;
end;
$$;

create function public.ai_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; v_now timestamptz; v_period text;
  v_used numeric; v_count bigint; v_code text;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  perform private.ai_expire(p.owner_id,v_now,100);
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  select coalesce(sum(accounted_micro) filter (where period=v_period or charge_state in ('reserved','held')),0),
    count(*) filter (where created_at>v_now-interval '1 hour')
    into v_used,v_count from private.ai_usage where owner_id=p.owner_id;
  v_code := private.ai_permission(p,c);
  return jsonb_build_object('code',v_code,'period',v_period,'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',p.ai_enabled,'noticeRevision',p.ai_notice_revision,
      'consentedAt',p.ai_consented_at,'profileVersion',p.version::text),
    'policy',case when c.owner_id is null then null else jsonb_build_object('activated',c.activated,
      'noticeRevision',c.notice_revision,'modelId',c.model_id,'promptVersion',c.prompt_version,
      'maxRequestMicro',c.max_request_micro::text,'monthlyAllowanceMicro',c.monthly_allowance_micro::text,
      'maxRequestsPerHour',c.max_requests_per_hour,'resultTtlSeconds',c.result_ttl_seconds) end,
    'usage',jsonb_build_object('accountedMicro',v_used::text,'requestsLastHour',v_count,
      'warning',coalesce(v_used*5>=c.monthly_allowance_micro::numeric*4,false)));
end;
$$;

create function public.ai_set_consent(p_enabled boolean,p_notice_revision integer,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
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

create function public.ai_begin_request(p_request_id uuid,p_draft_id uuid,p_generation integer,p_image_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  v_now timestamptz; v_period text; v_code text; v_used numeric; v_count bigint;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
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

create function public.ai_request_control(p_request_id uuid,p_action text) returns jsonb
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
  return jsonb_build_object('code','OK','status',r.status,'result',
    case when r.status='ready' and u.dispatched_at is not null then private.ai_result(r,r.facts) else null end);
end;
$$;

create function public.ai_mark_dispatched(p_owner_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests; v_now timestamptz; v_code text;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_now := clock_timestamp();
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','TERMINAL','claimed',false); end if;
  if r.expires_at<=v_now then
    perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
    return jsonb_build_object('code','EXPIRED','claimed',false);
  end if;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if r.model_id<>c.model_id or r.prompt_version<>c.prompt_version or r.notice_revision<>c.notice_revision then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if u.dispatched_at is not null or u.charge_state<>'reserved' or r.status<>'reserved' then
    return jsonb_build_object('code','ALREADY_CLAIMED','claimed',false);
  end if;
  update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code','OK','claimed',true);
end;
$$;

create function public.ai_settle_request(p_owner_id uuid,p_request_id uuid,p_facts jsonb,p_billed_micro bigint,p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  v_now timestamptz; v_reason text; v_stored boolean := false; v_anomaly boolean := false;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','stored',false); end if;
  v_now := clock_timestamp();
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if p_request_id is null or p_code is null or p_code not in ('SUCCESS','FAILED','BILLING_ONLY')
    or p_billed_micro<0 then return jsonb_build_object('code','INVALID_INPUT','stored',false); end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','stored',false); end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  if p_billed_micro is not null then
    if u.charge_state='settled' and u.accounted_micro<>p_billed_micro then
      return jsonb_build_object('code','BILLING_CONFLICT','stored',false);
    end if;
    v_anomaly := u.dispatched_at is null;
    update private.ai_usage set accounted_micro=p_billed_micro,charge_state='settled'
      where owner_id=p.owner_id and request_id=p_request_id returning * into u;
  end if;
  -- Once accounting is reconciled, content rejection must not roll it back.
  if r.request_id is null then v_reason := 'TERMINAL';
  elsif r.expires_at<=v_now then
    perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
    v_reason := 'EXPIRED';
  elsif p_code='BILLING_ONLY' then v_reason := 'BILLING_ONLY';
  elsif p_code='FAILED' then
    perform private.ai_close(p.owner_id,p_request_id,'FAILED',v_now);
    v_reason := 'FAILED';
  elsif u.dispatched_at is null or r.status not in ('dispatched','ready') then v_reason := 'NOT_DISPATCHED';
  elsif private.ai_permission(p,c)<>'OK' or r.model_id is distinct from c.model_id
    or r.prompt_version is distinct from c.prompt_version or r.notice_revision is distinct from c.notice_revision then
    perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now);
    v_reason := 'UNAVAILABLE';
  elsif not private.ai_valid_facts(p_facts)
    or octet_length(convert_to(private.ai_result(r,p_facts)::text,'UTF8'))>8192 then
    if r.status<>'ready' then perform private.ai_close(p.owner_id,p_request_id,'INVALID_FACTS',v_now); end if;
    v_reason := 'INVALID_FACTS';
  elsif r.status='ready' and r.facts is distinct from p_facts then v_reason := 'FACTS_CONFLICT';
  else
    update private.ai_requests set status='ready',facts=p_facts where owner_id=p.owner_id and request_id=p_request_id;
    v_stored := true; v_reason := 'READY';
  end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code',v_reason,'stored',v_stored,'chargeState',u.charge_state,
    'accountedMicro',u.accounted_micro::text,'undispatchedCharge',v_anomaly);
end;
$$;

create function public.ai_purge_expired(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p record; v_now timestamptz; n integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  for p in select pr.owner_id from public.profiles pr
    where exists(select 1 from private.ai_requests r where r.owner_id=pr.owner_id and r.expires_at<=clock_timestamp())
    order by pr.owner_id for update of pr skip locked loop
    v_now := clock_timestamp();
    perform 1 from private.ai_controls where owner_id=p.owner_id for update;
    n := n+private.ai_expire(p.owner_id,v_now,p_limit-n);
    exit when n>=p_limit;
  end loop;
  return jsonb_build_object('code','OK','removed',n);
end;
$$;

revoke all on function private.ai_owner_approved(uuid),private.ai_permission(public.profiles,private.ai_controls),
  private.ai_valid_facts(jsonb),private.ai_result(private.ai_requests,jsonb),
  private.ai_close(uuid,uuid,text,timestamptz),private.ai_expire(uuid,timestamptz,integer) from public,anon,authenticated,service_role;
revoke all on function public.ai_status(),public.ai_set_consent(boolean,integer,bigint),
  public.ai_begin_request(uuid,uuid,integer,text),public.ai_request_control(uuid,text),
  public.ai_mark_dispatched(uuid,uuid),public.ai_settle_request(uuid,uuid,jsonb,bigint,text),
  public.ai_purge_expired(integer) from public,anon,authenticated,service_role;
grant execute on function public.ai_status(),public.ai_set_consent(boolean,integer,bigint),
  public.ai_begin_request(uuid,uuid,integer,text),public.ai_request_control(uuid,text) to authenticated;
grant execute on function public.ai_mark_dispatched(uuid,uuid),public.ai_settle_request(uuid,uuid,jsonb,bigint,text),
  public.ai_purge_expired(integer) to service_role;

-- Still a raw v2 snapshot, not proof of completed Save; exclude active consent.
create or replace function public.export_manifest(p_export_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when private.is_approved() then jsonb_build_object(
    'schema_version',2,'export_id',p_export_id,'owner_id',auth.uid(),'created_at',statement_timestamp(),
    'tables',jsonb_build_object(
      'profiles',(select coalesce(jsonb_agg(to_jsonb(t)-array['ai_enabled','ai_notice_revision','ai_consented_at']),'[]') from public.profiles t where owner_id=auth.uid()),
      'style_preferences',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.style_preferences t where owner_id=auth.uid()),
      'items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.items t where owner_id=auth.uid()),
      'item_images',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.item_images t where owner_id=auth.uid()),
      'outfits',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfits t where owner_id=auth.uid()),
      'outfit_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfit_items t where owner_id=auth.uid()),
      'wear_events',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_events t where owner_id=auth.uid()),
      'wear_event_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_event_items t where owner_id=auth.uid()),
      'combination_rules',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.combination_rules t where owner_id=auth.uid()),
      'suggestion_feedback',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.suggestion_feedback t where owner_id=auth.uid())
    )) else null end;
$$;
commit;
