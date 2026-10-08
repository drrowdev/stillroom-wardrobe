-- SAVE1: a photo-analysis reply with a missing or unrecognised model name fails only that photo.
-- It no longer switches photo AI off for the whole account. Cache/contradictory control observations and
-- token-envelope overruns still do. Usage for such a reply is still estimated and kept; it is never free.
--   * public.ai_finish_analysis: both model observations leave v_bad; a live request with either closes FAILED
--     (no facts stored) after the terminal/expiry checks, so a reply without a verifiable model is never ready.
--   * public.ai_status: unchanged legacy JSON unless the caller sends the request header
--     X-Stillroom-AI-Status-Version: 2, which adds photoModelNoticeUntilMs (number or null): an owner-only,
--     request-based notice window of seven days from the request's immutable coalesce(dispatched_at,created_at)
--     for Azure photo analysis whose reply carried an unrecognised model. The header only selects the
--     representation. No new table, column, grant, RPC or data rewrite; installed migrations are unchanged.
begin;

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
  v_bad := v_control<>'ordinary';
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
  elsif p_code='FAILED' or v_model in ('response_missing_model','response_unrecognised_model') then
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

create or replace function public.ai_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz; v_period text;
  v_used numeric; v_count bigint; v_code text; v_policy jsonb; v_result jsonb; v_notice timestamptz;
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
  v_result := jsonb_build_object('code',v_code,'period',v_period,'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',p.ai_enabled,'noticeRevision',p.ai_notice_revision,
      'consentedAt',p.ai_consented_at,'profileVersion',p.version::text),'policy',v_policy,
    'usage',jsonb_build_object('accountedMicro',v_used::text,'requestsLastHour',v_count,
      'warning',coalesce(v_used*5>=c.monthly_allowance_micro::numeric*4,false)));
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

commit;
