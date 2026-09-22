-- I29-AZ1 inactive DEV/TEST source profile. No owner activation or hosted authority.
begin;

insert into private.ai_execution_manifests values (
  'azure-eu-terra-devtest-v1','gpt-5.6-terra-2026-07-09',1,
  'fd0218f1e71b7902af437cb58f17c724883c78f3d76d085ca8bbb1cea0eb25ff',
  '84d87dca033cc587c6cae54cc8a0a2936f3dabefa0ab18fb4c3ee03467cc8ff1',
  '8a4eef8a47549d57d2466148efee37ebaeed57beb6a046c5a464e977da15eb88',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices','2026-09-21T00:00:00Z',
  'INACTIVE existing DEV/TEST eval-terra-20260709; expected snapshot gpt-5.6-terra-2026-07-09. Retail API SwedenCentral/USD Consumption effective 2026-08-01, product DZH318Z0T9WD: short input SKU 0XHQ meter 7206b6ce-1886-52e3-ae31-7d71b2472bd4 USD2.20; short output 0X47/334d9cd3-5352-5a2a-a321-ae65324ac12e USD13.20; long input 0XB6/7a3d6586-3a9e-52fb-b0fc-7788e224874e USD4.40; long output 0X33/64220ec3-9ca1-585b-a4b9-87bbbbbec3aa USD19.80 per1M. Higher ordinary rates used; no cache/unknown-billing guarantee. Input is documented model maximum; output2048 requested including reasoning, not invoice ceiling. Explicit cache mode without breakpoints; store:false is not zero retention. Live deployment/counters/controls remain an activation gate. Notice2 selected entries SHA256606487b1c973f49c739dfac8ca8c15bcad33d190fdbcc83147cdd60112c51d24, not whole rendered notice.',
  'USD',440,1980,922000,2048,4097351,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'
);

alter table private.ai_usage_evidence
  add column model_observation text check (model_observation in (
    'not_observed','response_missing_model','response_unrecognised_model','expected_snapshot','model_family','deployment_alias')),
  add column control_observation text check (control_observation in (
    'ordinary','cache_read','cache_write','cache_read_write','contradictory')),
  add column claim_identity jsonb check (claim_identity is null or (
    jsonb_typeof(claim_identity)='object' and octet_length(convert_to(claim_identity::text,'UTF8'))<=1024));
alter table private.item_attribution_history
  add column manifest_id text references private.ai_execution_manifests(id);

create or replace function public.ai_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz; v_period text;
  v_used numeric; v_count bigint; v_code text; v_policy jsonb;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_now := clock_timestamp();
  if not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  perform private.ai_expire(p.owner_id,v_now,100);
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  select coalesce(sum(accounted_micro) filter (where period=v_period or charge_state in ('reserved','held')),0),
    count(*) filter (where created_at>v_now-interval '1 hour') into v_used,v_count
    from private.ai_usage where owner_id=p.owner_id;
  v_code := private.ai_permission(p,c);
  if c.owner_id is not null then
    v_policy := jsonb_build_object('activated',c.activated,'noticeRevision',c.notice_revision,
      'modelId',c.model_id,'promptVersion',c.prompt_version,'maxRequestMicro',c.max_request_micro::text,
      'monthlyAllowanceMicro',c.monthly_allowance_micro::text,'maxRequestsPerHour',c.max_requests_per_hour,
      'resultTtlSeconds',c.result_ttl_seconds);
    if c.model_id='gpt-5.6-terra-2026-07-09' then
      v_policy := v_policy||jsonb_build_object('executionManifestId',c.execution_manifest_id);
    end if;
  end if;
  return jsonb_build_object('code',v_code,'period',v_period,'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',p.ai_enabled,'noticeRevision',p.ai_notice_revision,
      'consentedAt',p.ai_consented_at,'profileVersion',p.version::text),'policy',v_policy,
    'usage',jsonb_build_object('accountedMicro',v_used::text,'requestsLastHour',v_count,
      'warning',coalesce(v_used*5>=c.monthly_allowance_micro::numeric*4,false)));
end;
$$;

create or replace function public.ai_claim_analysis(p_owner_id uuid,p_request_id uuid,p_draft_id uuid,p_generation integer,
  p_image_sha256 text,p_byte_count integer,p_width integer,p_height integer,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests;
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
  select * into m from private.ai_execution_manifests where id=p_manifest_id and id='azure-eu-terra-devtest-v1';
  if not found or v_now>=m.review_expires_at or c.execution_manifest_id is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.execution_manifest_id<>m.id or c.model_id<>m.model_id or c.prompt_version<>m.prompt_version or c.notice_revision<>2 then
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
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,claim_identity)
    values(p.owner_id,p_request_id,m.id,'not_observed',jsonb_build_object('draftId',p_draft_id,'generation',p_generation,
      'imageSha256',p_image_sha256,'bytes',p_byte_count,'width',p_width,'height',p_height));
  insert into private.ai_analysis_attestations values(p.owner_id,p_request_id,p_image_sha256,
    p_byte_count,p_width,p_height,m.id,v_now,v_deadline);
  update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'resultExpiresAtMs',floor(extract(epoch from r.expires_at)*1000)::bigint,
    'dispatchBeforeMs',floor(extract(epoch from v_deadline)*1000)::bigint);
end;
$$;

create or replace function private.ai_analysis_permitted(p public.profiles,c private.ai_controls,r private.ai_requests,p_now timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select private.ai_permission(p,c)='OK' and r.model_id=c.model_id and r.prompt_version=c.prompt_version
    and r.notice_revision=c.notice_revision and exists(
      select 1 from private.ai_analysis_attestations a join private.ai_execution_manifests m on m.id=a.manifest_id
      where a.owner_id=p.owner_id and a.request_id=r.request_id and a.image_sha256=r.image_sha256
        and m.id=c.execution_manifest_id and m.id in ('google-eu-3.8-v1','azure-eu-terra-devtest-v1')
        and m.model_id=r.model_id and m.prompt_version=r.prompt_version and p_now<m.review_expires_at
        and (m.id='google-eu-3.8-v1' or c.notice_revision=2));
$$;

alter function public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) set schema private;
alter function private.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) rename to ai_finish_google_legacy;
alter function private.ai_finish_google_legacy(uuid,uuid,text,jsonb,jsonb,text) security invoker;
revoke all on function private.ai_finish_google_legacy(uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;

create function public.ai_finish_analysis(p_owner_id uuid,p_request_id uuid,p_manifest_id text,
  p_facts jsonb,p_usage jsonb,p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests;
  e private.ai_usage_evidence; m private.ai_execution_manifests; v_now timestamptz;
  k text; n numeric; v_estimate bigint; v_valid boolean := true; v_bad boolean; v_anomaly boolean := false;
  v_model text; v_control text; v_result jsonb; v_reason text; v_fields text[] := array[
    'category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label',
    'upper_coverage','lower_coverage','material','seasons','formality','style_tags'];
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','stored',false,'accounting',null); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  v_now := clock_timestamp();
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into e from private.ai_usage_evidence where owner_id=p.owner_id and request_id=p_request_id for update;
  if not found or p_manifest_id is distinct from e.manifest_id then
    return jsonb_build_object('code','UNAVAILABLE','stored',false,'accounting',null);
  end if;
  if e.manifest_id='google-eu-3.8-v1' then
    return private.ai_finish_google_legacy(p_owner_id,p_request_id,p_manifest_id,p_facts,p_usage,p_code);
  end if;
  if e.manifest_id<>'azure-eu-terra-devtest-v1' or p_code is null or p_code not in ('SUCCESS','FAILED','USAGE_ONLY') then
    return jsonb_build_object('code','INVALID_INPUT','stored',false,'accounting',private.ai_accounting(u));
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(convert_to(p_usage::text,'UTF8'))>2048
    or not(p_usage ?& array['modelObservation','controlObservation','input','output','total','reasoning','cacheRead','cacheWrite'])
    or p_usage-array['modelObservation','controlObservation','input','output','total','reasoning','cacheRead','cacheWrite']<>'{}'::jsonb
    or jsonb_typeof(p_usage->'modelObservation')<>'string' or jsonb_typeof(p_usage->'controlObservation')<>'string'
    or p_usage->>'modelObservation' not in ('not_observed','response_missing_model','response_unrecognised_model','expected_snapshot','model_family','deployment_alias')
    or p_usage->>'controlObservation' not in ('ordinary','cache_read','cache_write','cache_read_write','contradictory') then
    return jsonb_build_object('code','INVALID_INPUT','stored',false,'accounting',private.ai_accounting(u));
  end if;
  v_model := p_usage->>'modelObservation'; v_control := p_usage->>'controlObservation';
  if (e.anomaly and e.normalized_usage is null)
    or (e.model_observation is not null and e.model_observation<>'not_observed' and e.model_observation<>v_model)
    or (e.control_observation is not null and e.control_observation<>v_control)
    or (e.normalized_usage is not null and e.normalized_usage<>p_usage) then
    return jsonb_build_object('code','USAGE_CONFLICT','stored',false,'accounting',private.ai_accounting(u));
  end if;
  v_bad := v_model in ('response_missing_model','response_unrecognised_model') or v_control<>'ordinary';
  foreach k in array array['input','output','total','reasoning','cacheRead','cacheWrite'] loop
    if jsonb_typeof(p_usage->k) is distinct from 'number' then v_valid := false;
    else
      n := (p_usage->>k)::numeric;
      if n<0 or n>9007199254740991 or n<>trunc(n) then v_valid := false; end if;
      if k in ('cacheRead','cacheWrite') and n>0 and n<=9007199254740991 and n=trunc(n) then v_bad := true; end if;
    end if;
  end loop;
  if v_valid then
    v_valid := (p_usage->>'input')::numeric+(p_usage->>'output')::numeric=(p_usage->>'total')::numeric
      and (p_usage->>'total')::numeric<=9007199254740991
      and (p_usage->>'reasoning')::numeric<=(p_usage->>'output')::numeric
      and (p_usage->>'cacheRead')::numeric<=(p_usage->>'input')::numeric;
  end if;
  update private.ai_usage_evidence set model_observation=v_model,control_observation=v_control
    where owner_id=p.owner_id and request_id=p_request_id;
  if v_bad then
    update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;
    update private.ai_usage_evidence set anomaly=true where owner_id=p.owner_id and request_id=p_request_id;
    perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now);
    return jsonb_build_object('code','USAGE_ANOMALY','stored',false,'accounting',private.ai_accounting(u));
  end if;
  if not v_valid or v_model='not_observed' then
    perform private.ai_close(p.owner_id,p_request_id,'FAILED',v_now);
    return jsonb_build_object('code','INVALID_USAGE','stored',false,'accounting',private.ai_accounting(u));
  end if;
  v_estimate := ceil(((p_usage->>'input')::numeric*m.input_rate_hundredths
    +(p_usage->>'output')::numeric*m.output_rate_hundredths)/100)::bigint;
  v_anomaly := (p_usage->>'input')::numeric>m.input_envelope or (p_usage->>'output')::numeric>m.output_envelope;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=v_estimate,anomaly=v_anomaly
    where owner_id=p.owner_id and request_id=p_request_id;
  if u.charge_state<>'settled' then
    update private.ai_usage set accounted_micro=v_estimate,charge_state='estimated'
      where owner_id=p.owner_id and request_id=p_request_id returning * into u;
  end if;
  if v_anomaly then
    update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;
    perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now); v_reason := 'USAGE_ANOMALY';
  elsif r.request_id is null or p_code='USAGE_ONLY' then v_reason := 'TERMINAL';
  elsif r.expires_at<=v_now then
    perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now); v_reason := 'EXPIRED';
  elsif p_code='FAILED' then
    perform private.ai_close(p.owner_id,p_request_id,'FAILED',v_now); v_reason := 'FAILED';
  elsif not private.ai_analysis_permitted(p,c,r,v_now) then
    perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now); v_reason := 'UNAVAILABLE';
  elsif not private.ai_valid_facts(p_facts) or not coalesce(p_facts->'fields' ?& v_fields,false)
    or (p_facts->'fields')-v_fields<>'{}'::jsonb then
    if r.status<>'ready' then perform private.ai_close(p.owner_id,p_request_id,'INVALID_FACTS',v_now); end if;
    v_reason := 'INVALID_FACTS';
  else
    v_result := private.ai_settle_core(p_owner_id,p_request_id,p_facts,null,'SUCCESS');
    v_reason := v_result->>'code';
  end if;
  return jsonb_build_object('code',v_reason,'stored',coalesce((v_result->>'stored')::boolean,false),
    'accounting',private.ai_accounting(u));
end;
$$;
revoke all on function public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) to service_role;

create or replace function public.reserve_analyzed_item_save(p_item jsonb,p_image jsonb,p_claim jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid; i public.items; a private.ai_item_save_attempts;
  p public.profiles; c private.ai_controls; r private.ai_requests; u private.ai_usage;
  proof private.ai_analysis_attestations; m private.ai_execution_manifests; e private.ai_usage_evidence;
  k text; v jsonb; kind text; derived jsonb := '{}'; result record; v_refuse boolean := false;
begin
  -- This serializes absence tests with every same-owner reservation and consent change.
  v_owner := private.item_save_owner();
  if p_item is null or p_image is null or jsonb_typeof(p_item)<>'object' or jsonb_typeof(p_image)<>'object'
    or jsonb_typeof(p_item->'field_provenance') is distinct from 'object'
    or octet_length(convert_to(p_item::text,'UTF8'))>32768 or octet_length(convert_to(p_image::text,'UTF8'))>2048
    or coalesce(p_item->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_image->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if p_claim is not null and (jsonb_typeof(p_claim)<>'object' or octet_length(convert_to(p_claim::text,'UTF8'))>8192
    or not(p_claim ?& array['requestId','draftId','generation','imageSha256','fields'])
    or p_claim-array['requestId','draftId','generation','imageSha256','fields']<>'{}'::jsonb
    or jsonb_typeof(p_claim->'fields')<>'object'
    or coalesce(p_claim->>'requestId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_claim->>'draftId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_claim->'generation') is distinct from 'number'
    or coalesce(p_claim->>'imageSha256','')!~'^[0-9a-f]{64}$'
    or p_claim->'imageSha256' is distinct from p_image->'main_sha256') then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  i := jsonb_populate_record(null::public.items,p_item||jsonb_build_object('owner_id',v_owner,'version',1));
  select * into a from private.ai_item_save_attempts where owner_id=v_owner and item_id=i.id for update nowait;
  if found then
    if a.cancelled or a.claim_hash is distinct from encode(sha256(convert_to(p_claim::text,'UTF8')),'hex') then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return query select * from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
    return;
  end if;
  if exists(select 1 from private.item_save_used_ids x where x.owner_id=v_owner
    and (x.item_id=i.id or x.image_id=(p_image->>'id')::uuid)) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if p_claim is not null then
    if exists(select 1 from private.ai_save_used_receipts x where x.owner_id=v_owner
      and (x.request_id=(p_claim->>'requestId')::uuid or x.item_id=i.id or x.image_id=(p_image->>'id')::uuid)) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    select * into p from public.profiles where owner_id=v_owner;
    select * into c from private.ai_controls where owner_id=v_owner for update nowait;
    select * into u from private.ai_usage where owner_id=v_owner and request_id=(p_claim->>'requestId')::uuid for update nowait;
    if not found or u.dispatched_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
    select * into r from private.ai_requests where owner_id=v_owner and request_id=u.request_id for update nowait;
    if not found then
      if u.closed_reason is null or u.closed_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
      select * into e from private.ai_usage_evidence where owner_id=v_owner and request_id=u.request_id;
      if not found or e.claim_identity is null or e.claim_identity is distinct from jsonb_build_object(
        'draftId',p_claim->'draftId','generation',p_claim->'generation','imageSha256',p_claim->'imageSha256',
        'bytes',p_image->'main_bytes','width',p_image->'width','height',p_image->'height') then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      v_refuse := true;
    else
      if p_claim->'requestId' is distinct from to_jsonb(r.request_id)
        or p_claim->'draftId' is distinct from to_jsonb(r.draft_id)
        or p_claim->'generation' is distinct from to_jsonb(r.generation)
        or p_claim->'imageSha256' is distinct from to_jsonb(r.image_sha256) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      select * into proof from private.ai_analysis_attestations where owner_id=v_owner and request_id=r.request_id for share nowait;
      if not found or p_image->'main_sha256' is distinct from to_jsonb(proof.image_sha256)
        or p_image->'main_bytes' is distinct from to_jsonb(proof.byte_count)
        or p_image->'width' is distinct from to_jsonb(proof.width)
        or p_image->'height' is distinct from to_jsonb(proof.height) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      select * into m from private.ai_execution_manifests where id=proof.manifest_id;
      if not found then raise exception using errcode='22023',message='Request conflict'; end if;
      update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
        'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
        where owner_id=v_owner and request_id=u.request_id and claim_identity is null;
      v_refuse := r.expires_at<=clock_timestamp() or not private.ai_analysis_permitted(p,c,r,clock_timestamp())
        or m.id is distinct from c.execution_manifest_id or m.review_expires_at<=clock_timestamp();
      if not v_refuse and (r.status<>'ready' or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts)) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    end if;
    if v_refuse then
      -- Return, do not raise: the terminal usage identity and close must commit with this ACK.
      perform private.ai_close(v_owner,u.request_id,'UNAVAILABLE',clock_timestamp());
      return query select jsonb_build_object('id',i.id,'owner_id',v_owner),
        jsonb_build_object('id',(p_image->>'id')::uuid,'item_id',i.id,'owner_id',v_owner),
        null::text,'analysis_unavailable'::text;
      return;
    end if;
    for k,v in select key,value from jsonb_each(p_claim->'fields') loop
      kind := case when k=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
        when k=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
        then 'ai_observed' else null end;
      if kind is null or jsonb_typeof(v)<>'object' or v is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->k)
        or r.facts->'fields'->k is null or r.facts->'fields'->k in ('null'::jsonb,'[]'::jsonb)
        or p_item->k is distinct from r.facts->'fields'->k
        or p_item->'field_provenance'->k is distinct from jsonb_build_object('kind',kind,'revision',1) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      derived := derived||jsonb_build_object(k,jsonb_build_object('kind',kind,'revision',1));
    end loop;
    insert into private.ai_save_used_receipts values(v_owner,r.request_id,i.id,(p_image->>'id')::uuid);
  end if;
  for k,v in select key,value from jsonb_each(i.field_provenance) loop
    if v->>'kind' in ('ai_observed','ai_estimated') and v is distinct from derived->k then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  insert into private.ai_item_save_context values(v_owner,i.id,private.item_save_value_hash(i));
  select * into result from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
  delete from private.ai_item_save_context where owner_id=v_owner and item_id=i.id;
  insert into private.ai_item_save_attempts values(v_owner,i.id,encode(sha256(convert_to(p_claim::text,'UTF8')),'hex'),
    m.id,m.model_id,m.prompt_version,proof.image_sha256,proof.byte_count,proof.width,proof.height,derived,false);
  return query select result.item,result.image,result.fingerprint,result.state;
exception
  when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow then raise exception using errcode='22023',message='Invalid input';
end;
$$;

create or replace function public.complete_analyzed_item_save(p_owner_id uuid,p_item_id uuid,p_image_id uuid,p_fingerprint text,p_objects jsonb)
returns void language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare current jsonb; a private.ai_item_save_attempts;
begin
  current := private.analyzed_item_save_current(p_owner_id,p_item_id,p_image_id,p_fingerprint);
  if p_objects is distinct from current->'objects' then raise exception using errcode='22023',message='Request conflict'; end if;
  if current->>'state'='completed' then return; end if;
  perform 1 from public.item_images where owner_id=p_owner_id and item_id=p_item_id and state='ready' for update nowait;
  if found then raise exception using errcode='22023',message='Request conflict'; end if;
  update public.item_images set state='ready' where owner_id=p_owner_id and item_id=p_item_id and id=p_image_id and state='pending';
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into a from private.ai_item_save_attempts where owner_id=p_owner_id and item_id=p_item_id;
  if a.fields<>'{}'::jsonb then
    insert into private.item_attribution_history(owner_id,item_id,source_image_id,image_sha256,model_id,prompt_version,fields,manifest_id)
      values(p_owner_id,p_item_id,p_image_id,a.image_sha256,a.model_id,a.prompt_version,a.fields,
        case when a.manifest_id='azure-eu-terra-devtest-v1' then a.manifest_id else null end);
  end if;
  update private.item_save_attempts set state='completed',completed_at=clock_timestamp() where owner_id=p_owner_id and item_id=p_item_id;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create or replace function public.item_attribution_history(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() or not exists(
    select 1 from public.items where owner_id=auth.uid() and id=p_item_id and deleted_at is null) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(h)-array['owner_id','item_id','manifest_id'])
    from private.item_attribution_history h where owner_id=auth.uid() and item_id=p_item_id),'[]'::jsonb);
end;
$$;
commit;
