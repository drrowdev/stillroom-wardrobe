-- COL1 Azure v2 manifest: new colour enum and prompt. v1 unchanged; no controls, consent or allowance change.
begin;

insert into private.ai_execution_manifests values (
  'azure-eu-terra-devtest-v2','gpt-5.6-terra-2026-07-09',2,
  'f936938355042f9620fad74b3da848e1045bb76461a4a6e98a1f2ed8080cec46',
  '36ab5116df2cfce8443c5db0a9a0747e15f8d018e7463b8c2296d98568503d6e',
  '6713706fb27792e2771f1fd2d0e4586a5ce1d61fb8ecbfa8dfd88f89db504827',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices','2026-09-21T00:00:00Z',
  'v2 of azure-eu-terra-devtest-v1: colour vocabulary and prompt only (24 Sep 2026); tariff evidence not re-retrieved. INACTIVE existing DEV/TEST eval-terra-20260709; expected snapshot gpt-5.6-terra-2026-07-09. Retail API SwedenCentral/USD Consumption effective 2026-08-01, product DZH318Z0T9WD: short input SKU 0XHQ meter 7206b6ce-1886-52e3-ae31-7d71b2472bd4 USD2.20; short output 0X47/334d9cd3-5352-5a2a-a321-ae65324ac12e USD13.20; long input 0XB6/7a3d6586-3a9e-52fb-b0fc-7788e224874e USD4.40; long output 0X33/64220ec3-9ca1-585b-a4b9-87bbbbbec3aa USD19.80 per1M. Higher ordinary rates used; no cache/unknown-billing guarantee. Input is documented model maximum; output2048 requested including reasoning, not invoice ceiling. Explicit cache mode without breakpoints; store:false is not zero retention. Live deployment/counters/controls remain an activation gate. Notice2 selected entries SHA256606487b1c973f49c739dfac8ca8c15bcad33d190fdbcc83147cdd60112c51d24, not whole rendered notice.',
  'USD',440,1980,922000,2048,4097351,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'
);

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
  select * into m from private.ai_execution_manifests where id=p_manifest_id and id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2');
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
        and m.id=c.execution_manifest_id and m.id in ('google-eu-3.8-v1','azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2')
        and m.model_id=r.model_id and m.prompt_version=r.prompt_version and p_now<m.review_expires_at
        and (m.id='google-eu-3.8-v1' or c.notice_revision=2));
$$;

create or replace function public.ai_finish_analysis(p_owner_id uuid,p_request_id uuid,p_manifest_id text,
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
  if e.manifest_id not in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2') or p_code is null or p_code not in ('SUCCESS','FAILED','USAGE_ONLY') then
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
        case when a.manifest_id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2') then a.manifest_id else null end);
  end if;
  update private.item_save_attempts set state='completed',completed_at=clock_timestamp() where owner_id=p_owner_id and item_id=p_item_id;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

commit;
