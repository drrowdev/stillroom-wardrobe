-- BUDGET2: no per-photo hold for photo analysis, and a USD 200 ceiling for the one monthly budget (owner decision of 1 November 2026).
-- Photo analysis held the whole worst-case request (4,097,351 micro-USD, a 922,000-token envelope) against the budget before
-- every call, although a real photo costs under a cent. Manifest azure-eu-terra-devtest-v3 is v2 with only its request envelope
-- (16,384 input tokens, an anomaly threshold) and its reservation changed. The reservation is 1 micro-USD: a placeholder, not a
-- monetary hold. ai_controls.max_request_micro and ai_usage.reserved_micro both require a value above zero, and a reserved or
-- held row must account exactly its reservation, so 1 is the smallest the schema allows. The account's controls name the
-- manifest and the amount, so nothing changes for any account until its controls row is switched separately.
--   * The monthly budget is a recorded-usage ADMISSION ALLOWANCE, not a hard actual-spend ceiling: a new analysis is admitted
--     while recorded use (charges plus every reserved or held row) plus 1 is within the allowance, and finishing records the
--     real cost. N analyses outstanding at once can pass the allowance by N times their actual cost (up to 112,639 micro-USD
--     each within the envelope). A reply beyond the envelope, lost or invalid metering, and a request whose cost is unknown
--     (it keeps only its 1-micro placeholder) are not bounded by that.
--   * ai_finish_analysis for v3: a valid reply beyond the envelope (input above 16,384 or output above 2,048 tokens) keeps the
--     anomaly flag, the unclamped estimate and the per-photo failure, but no longer switches the control off. v1 and v2 keep
--     their deactivation, and every other shutdown (non-ordinary or contradictory controls, positive cache counters) is unchanged.
--   * Prompt, schema, model, notice revision (2) and the notice hash are unchanged, so no consent is asked again.
--   * Functions replaced with their exact current bodies, changing only the manifest id lists so that v3 is accepted (v1 and v2
--     stay accepted) and, in public.ai_finish_analysis, the v3 anomaly rule: public.ai_claim_analysis,
--     private.ai_analysis_permitted, public.ai_finish_analysis, public.ai_status, public.complete_analyzed_item_save (a v3 Save
--     keeps its manifest lineage instead of recording none).
--   * private.admin_set_budget: the ceiling constant 50000000 becomes 200000000. No table, column, grant, RPC or controls row changes.
begin;

insert into private.ai_execution_manifests values (
  'azure-eu-terra-devtest-v3','gpt-5.6-terra-2026-07-09',2,
  'f936938355042f9620fad74b3da848e1045bb76461a4a6e98a1f2ed8080cec46',
  '36ab5116df2cfce8443c5db0a9a0747e15f8d018e7463b8c2296d98568503d6e',
  '67fd5bae409fb317702d89780ce8dcc1b80ccd4d6b690942b43faa7989d459bf',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices','2026-09-21T00:00:00Z',
  'v3 of azure-eu-terra-devtest-v2 (1 Nov 2026): request envelope and reservation only; prompt, schema, model, notice, rates and tariff evidence unchanged and not re-retrieved. INACTIVE existing DEV/TEST eval-terra-20260709; expected snapshot gpt-5.6-terra-2026-07-09. Retail API SwedenCentral/USD Consumption effective 2026-08-01, product DZH318Z0T9WD: short input SKU 0XHQ meter 7206b6ce-1886-52e3-ae31-7d71b2472bd4 USD2.20; short output 0X47/334d9cd3-5352-5a2a-a321-ae65324ac12e USD13.20; long input 0XB6/7a3d6586-3a9e-52fb-b0fc-7788e224874e USD4.40; long output 0X33/64220ec3-9ca1-585b-a4b9-87bbbbbec3aa USD19.80 per1M. Higher ordinary rates used; no cache/unknown-billing guarantee. No worst-case hold: the reservation of 1 micro-USD is the smallest value the controls and usage constraints accept, and the real cost is recorded when the analysis finishes. Input envelope 16384 tokens is a bounded estimate (high-detail 1600 px image about 3000 tokens plus the fixed prompt and schema; not API-enforced): a reply beyond it is recorded as a usage anomaly with its unclamped estimate and fails only that photo, and analysis stays available. Output2048 requested including reasoning, not invoice ceiling. Explicit cache mode without breakpoints; store:false is not zero retention. Live deployment/counters/controls remain an activation gate. Notice2 selected entries SHA256606487b1c973f49c739dfac8ca8c15bcad33d190fdbcc83147cdd60112c51d24, not whole rendered notice.',
  'USD',440,1980,16384,2048,1,512000,1600,262144,8192,20,'2026-10-21T00:00:00Z'
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
  select * into m from private.ai_execution_manifests where id=p_manifest_id and id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3');
  if not found or c.execution_manifest_id is null then
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
        and m.id=c.execution_manifest_id and m.id in ('google-eu-3.8-v1','azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3')
        and m.model_id=r.model_id and m.prompt_version=r.prompt_version
        and (m.id='google-eu-3.8-v1' and p_now<m.review_expires_at or m.id<>'google-eu-3.8-v1' and c.notice_revision=2));
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
  if e.manifest_id not in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3') or p_code is null or p_code not in ('SUCCESS','FAILED','USAGE_ONLY') then
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
    -- v3 (BUDGET2): an envelope overrun is recorded and fails only this photo; v1 and v2 still deactivate the control.
    if e.manifest_id<>'azure-eu-terra-devtest-v3' then
      update private.ai_controls set activated=false,updated_at=v_now where owner_id=p.owner_id;
    end if;
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
        and e.manifest_id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3')
        and e.model_observation='response_unrecognised_model';
    v_result := v_result||jsonb_build_object('photoModelNoticeUntilMs',
      case when v_notice>v_now then floor(extract(epoch from v_notice)*1000)::bigint end);
  end if;
  return v_result;
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
        case when a.manifest_id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2','azure-eu-terra-devtest-v3') then a.manifest_id else null end);
  end if;
  update private.item_save_attempts set state='completed',completed_at=clock_timestamp() where owner_id=p_owner_id and item_id=p_item_id;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create or replace function private.admin_set_budget(p_admission_no smallint,p_account_version text,p_expected jsonb,p_limits jsonb,
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
  if v_new>200000000 then
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

commit;
