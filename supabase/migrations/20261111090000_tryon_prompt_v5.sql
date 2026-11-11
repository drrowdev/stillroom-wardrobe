-- TRYON-PROMPT3: garments keep their length in try-on pictures, and coats and jackets stay in an outfit as an optional piece that is never
-- drawn (issue #84, ADR28; owner report of 11 November 2026: "Some of the pictures look a bit weird because the clothes are too short, like this
-- shirt and jacket"; owner decision: try a prompt change for length; scope amendment: "I'd also want the outwear to become an optional part of the
-- outfit that doesnt get generated with the image. It should only stay as a suggestion in the outfit"). Classification:
--   additive: the immutable manifest azure-global-image25-sunburst-tryon-v5 (prompt version 5) and its provider-deployment row, on the same
--     deployment key as v1 to v4, and one private helper (private.tryon_drawn_steps, no API grant). Only the top, one-piece and layer prompts
--     differ from v4 (a fixed hem-length sentence; the layer also keeps the length of the clothing underneath); the outerwear prompt is the v4
--     text, unused. The model, parameters, rates, limits, reservation, six chained steps and result handling are identical.
--     v1 to v4 stay installed and unchanged;
--   NON-ADDITIVE (function replacement, same signatures, owners, security, search_path, lock_timeout and ACLs kept by create or replace):
--     public.tryon_claim and public.tryon_bootstrap, each the exact latest body (20261109110000) with only the manifest pin widened from
--     v3-or-v4 to v3-or-v4-or-v5 (a rollback from v5 to v4 must stay admitted), and in the claim one added statement, right after the garment
--     selection of a new chain: v_steps := private.tryon_drawn_steps(m.id,v_steps), which removes the outerwear step for v5 only. Chains
--     already running keep their frozen steps. Every other try-on function compares with the account's configured manifest and needs no change.
-- Not written: private.ai_controls (every account stays on v4 until the owner's guarded switch, docs/tryon-manifest-switch.sql), consent, the
-- notice revision (3; the data flow is the same, so nobody consents again), results, chains, photos and every other function. Inert for the
-- running stack: under v3 and v4 controls the claim selects exactly as before, so there is no drain and no admission lock here (nothing is moved).
-- Rollout (docs/cloud-development.md): this migration, then the guarded switch, the try-on Edge function redeploy and Pages back to back in that
-- order. Backout: the same guarded switch back to v4 with the previous Edge function and Pages; nothing here needs a compensating statement.
begin;
set local lock_timeout = '5s';

-- Preconditions: both replaced functions exist with the reviewed properties, v1 to v4 and the v4 deployment are installed on the shared key,
-- v5 and the helper are not, and the pin and the insertion point occur exactly once.
do $$
declare f regprocedure; p pg_catalog.pg_proc;
  v_pin constant text := 'm.id not in (''azure-global-image25-sunburst-tryon-v3'',''azure-global-image25-sunburst-tryon-v4'')';
  v_anchor constant text := '    v_n := jsonb_array_length(v_steps);'||chr(10)
    ||'    if v_n=0 then return jsonb_build_object(''code'',''NO_GARMENTS'',''claimed'',false); end if;';
begin
  foreach f in array array['public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])',
    'public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=f;
    if not p.prosecdef or not exists(select 1 from unnest(p.proconfig) x where x like 'search_path=%')
      or not exists(select 1 from unnest(p.proconfig) x where x like 'lock_timeout=%') then
      raise exception 'TRYON-PROMPT3 precondition: % properties not as expected',f;
    end if;
    -- The one manifest pin the replacements change must occur exactly once in each installed body.
    if (length(p.prosrc)-length(replace(p.prosrc,v_pin,''))) <> length(v_pin) then
      raise exception 'TRYON-PROMPT3 precondition: % does not pin the v3 and v4 manifests exactly once',f;
    end if;
  end loop;
  select * into p from pg_catalog.pg_proc where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure;
  if (length(p.prosrc)-length(replace(p.prosrc,v_anchor,''))) <> length(v_anchor) then
    raise exception 'TRYON-PROMPT3 precondition: the claim does not select the garments of a new chain exactly once';
  end if;
  if (select count(*) from private.ai_execution_manifests where id in ('azure-global-image25-sunburst-tryon-v1',
      'azure-global-image25-sunburst-tryon-v2','azure-global-image25-sunburst-tryon-v3','azure-global-image25-sunburst-tryon-v4'))<>4
    or (select count(*) from private.provider_deployments where manifest_id='azure-global-image25-sunburst-tryon-v4')<>1 then
    raise exception 'TRYON-PROMPT3 precondition: the v4 manifest or its deployment is missing';
  end if;
  if (select count(distinct deployment_key) from private.provider_deployments
      where manifest_id like 'azure-global-image25-sunburst-tryon-v%')<>1 then
    raise exception 'TRYON-PROMPT3 precondition: the try-on manifests are not on one deployment key';
  end if;
  if exists(select 1 from private.ai_execution_manifests where id='azure-global-image25-sunburst-tryon-v5') then
    raise exception 'TRYON-PROMPT3 precondition: the v5 manifest already exists';
  end if;
  if to_regprocedure('private.tryon_drawn_steps(text,jsonb)') is not null then
    raise exception 'TRYON-PROMPT3 precondition: private.tryon_drawn_steps already exists';
  end if;
  perform set_config('tryon_prompt3.rows',(select md5(string_agg(to_jsonb(m)::text,'|' order by m.id))
    from private.ai_execution_manifests m where m.id in ('azure-global-image25-sunburst-tryon-v1',
      'azure-global-image25-sunburst-tryon-v2','azure-global-image25-sunburst-tryon-v3','azure-global-image25-sunburst-tryon-v4')),true);
  perform set_config('tryon_prompt3.controls',(select md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.owner_id),''))
    from private.ai_controls c),true);
  -- The installed bodies with only the stated delta: the replacements must reproduce exactly these bytes.
  perform set_config('tryon_prompt3.claim',(select md5(replace(replace(prosrc,v_pin,
    'm.id not in (''azure-global-image25-sunburst-tryon-v3'',''azure-global-image25-sunburst-tryon-v4'',''azure-global-image25-sunburst-tryon-v5'')'),
    v_anchor,'    v_steps := private.tryon_drawn_steps(m.id,v_steps);'||chr(10)||v_anchor)) from pg_catalog.pg_proc
    where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure),true);
  perform set_config('tryon_prompt3.bootstrap',(select md5(replace(prosrc,v_pin,
    'm.id not in (''azure-global-image25-sunburst-tryon-v3'',''azure-global-image25-sunburst-tryon-v4'',''azure-global-image25-sunburst-tryon-v5'')'))
    from pg_catalog.pg_proc where oid='public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)'::regprocedure),true);
end;
$$;

-- Manifest v5: the v4 numbers, model, deployment key and parameters; the top, one-piece and layer prompts (prompt version 5) and settings.
insert into private.ai_execution_manifests values (
  'azure-global-image25-sunburst-tryon-v5','gpt-image-2.5-sunburst',5,
  '096e3febfbcf37f6ebc9c42a7d40b42f9fab68e64829feebf9da366a057218a1',
  '20cefa4d2f2fd2c381ac50f30af286f48ea804d9e6fb6d58ca5c5dbd45fa8efe',
  '8e40adebb513da00daf7d5c87cdcd96004e6ee5fe08f5e63ac010758c42f126a',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/images/edits','Global','GlobalStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-27T00:00:00Z',
  'Virtual try-on v5 on existing DEV/TEST eval-image25-sunburst-20260908 (GlobalStandard, 2 requests/min shared with photo enhancement). Retail API USD per1M: text input 5.00, image input 8.00, image output 30.00. Reservation 360000 micro per garment step values the 15000 total input (prompt plus person and garment images)/8000 output envelope with all input at image-in 8.00; the images API has no token cap, so this is an estimated envelope with possible in-flight overrun, handled by the anomaly kill switch. One garment per call, at most 6 chained steps (top or one-piece, bottoms, layer, shoes, one accessory); outerwear is an optional piece of an outfit and is never drawn. Tops, one-piece outfits and layers are shown at the full length they have in the garment photo (the hem is not shortened, cropped, tucked in or hiked up) and a layer keeps the length of the clothing underneath. Layers copy the garment''s construction from its photo: pullovers stay closed and a neck-only zip stays as shown, while garments with a full-length front opening, coats photographed fastened included, are shown open. Frozen parameters n1 1024x1280 medium jpeg compression85 opaque, no input_fidelity. The body photo is sent as is; Global processing may happen outside the EU. Results are kept until the owner deletes them.',
  'USD',800,3000,15000,8000,360000,512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'
);
insert into private.provider_deployments
  select 'azure-global-image25-sunburst-tryon-v5',deployment_key from private.provider_deployments
  where manifest_id='azure-global-image25-sunburst-tryon-v4';

-- The garments a manifest draws: v5 never draws outerwear (it stays in the outfit), every earlier manifest draws the selection as it is.
create function private.tryon_drawn_steps(p_manifest_id text,p_steps jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when p_manifest_id='azure-global-image25-sunburst-tryon-v5'
    then coalesce((select jsonb_agg(s.step order by s.n) from jsonb_array_elements(p_steps) with ordinality s(step,n)
      where s.step->>'slot'<>'outerwear'),'[]'::jsonb)
    else p_steps end;
$$;
revoke all on function private.tryon_drawn_steps(text,jsonb) from public,anon,authenticated,service_role;

-- 20261109110000's claim with the manifest pin accepting v3, v4 and v5, and the drawn steps of a new chain.
create or replace function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid,p_item_ids uuid[] default null) returns jsonb
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
    or p_step is null or p_step not between 1 and 6 or p_manifest_id is null
    or (p_step=1 and p_person_sha256 is not null)
    or (p_step>1 and (p_person_sha256 is null or p_person_sha256 !~ '^[0-9a-f]{64}$'))
    or (t.chain_id is null and p_step<>1)
    or (p_step=1 and (p_outfit_id is null) = (p_item_ids is null))
    or (p_step=1 and t.chain_id is not null and (p_outfit_id is distinct from t.outfit_id
      or p_item_ids is distinct from t.idea_item_ids))
    or (p_step>1 and (p_item_ids is not null or p_outfit_id is not null))
    or (p_item_ids is not null and (coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 8
      or array_position(p_item_ids,null) is not null
      or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids))) then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id not in ('azure-global-image25-sunburst-tryon-v3','azure-global-image25-sunburst-tryon-v4','azure-global-image25-sunburst-tryon-v5') or k.deployment_key is null then
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
    if p_item_ids is null then
      if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
    else
      if (select count(*) from public.items where owner_id=p.owner_id and id=any(p_item_ids))<>cardinality(p_item_ids) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_idea_steps(p.owner_id,p_item_ids);
    end if;
    v_steps := private.tryon_drawn_steps(m.id,v_steps);
    v_n := jsonb_array_length(v_steps);
    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;
    if (select count(*) from private.tryon_results where owner_id=p.owner_id)>=200 then
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
    insert into private.tryon_chains(owner_id,chain_id,outfit_id,idea_item_ids,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,p_item_ids,v_steps,'running',1,gen_random_uuid(),v_now,v_now+interval '30 minutes')
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

-- 20261109110000's bootstrap with the manifest pin accepting v3, v4 and v5.
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
  if not found or m.id not in ('azure-global-image25-sunburst-tryon-v3','azure-global-image25-sunburst-tryon-v4','azure-global-image25-sunburst-tryon-v5') then return jsonb_build_object('code','UNCONFIGURED'); end if;
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

-- Postconditions: v5 is installed on the shared deployment key, the earlier manifests and every account's controls are exactly as they were,
-- both replaced bodies equal the installed ones except for the stated delta, and the helper behaves and is callable by no API role.
do $$
begin
  if (select count(distinct deployment_key) from private.provider_deployments
      where manifest_id like 'azure-global-image25-sunburst-tryon-v%')<>1
    or (select count(*) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%')<>5 then
    raise exception 'TRYON-PROMPT3 postcondition: v5 is not on the shared deployment key';
  end if;
  if (select md5(string_agg(to_jsonb(m)::text,'|' order by m.id)) from private.ai_execution_manifests m
      where m.id in ('azure-global-image25-sunburst-tryon-v1','azure-global-image25-sunburst-tryon-v2','azure-global-image25-sunburst-tryon-v3',
        'azure-global-image25-sunburst-tryon-v4'))
      is distinct from current_setting('tryon_prompt3.rows') then
    raise exception 'TRYON-PROMPT3 postcondition: an earlier manifest changed';
  end if;
  if (select md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.owner_id),'')) from private.ai_controls c)
      is distinct from current_setting('tryon_prompt3.controls') then
    raise exception 'TRYON-PROMPT3 postcondition: an account''s controls changed';
  end if;
  if (select md5(prosrc) from pg_catalog.pg_proc
        where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure)
      is distinct from current_setting('tryon_prompt3.claim')
    or (select md5(prosrc) from pg_catalog.pg_proc
        where oid='public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)'::regprocedure)
      is distinct from current_setting('tryon_prompt3.bootstrap') then
    raise exception 'TRYON-PROMPT3 postcondition: a replaced function differs from the installed body beyond the stated delta';
  end if;
  if has_function_privilege('anon','private.tryon_drawn_steps(text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','private.tryon_drawn_steps(text,jsonb)','EXECUTE')
    or has_function_privilege('service_role','private.tryon_drawn_steps(text,jsonb)','EXECUTE')
    or (select p.provolatile<>'i' or p.prosecdef or p.proconfig is distinct from array['search_path=""']
        from pg_catalog.pg_proc p where p.oid='private.tryon_drawn_steps(text,jsonb)'::regprocedure) then
    raise exception 'TRYON-PROMPT3 postcondition: private.tryon_drawn_steps properties not as expected';
  end if;
  if private.tryon_drawn_steps('azure-global-image25-sunburst-tryon-v5',
      '[{"slot":"top","itemId":"a"},{"slot":"outerwear","itemId":"b"},{"slot":"footwear","itemId":"c"}]'::jsonb)
      is distinct from '[{"slot":"top","itemId":"a"},{"slot":"footwear","itemId":"c"}]'::jsonb
    or private.tryon_drawn_steps('azure-global-image25-sunburst-tryon-v5','[{"slot":"outerwear","itemId":"b"}]'::jsonb) is distinct from '[]'::jsonb
    or private.tryon_drawn_steps('azure-global-image25-sunburst-tryon-v4','[{"slot":"outerwear","itemId":"b"}]'::jsonb)
      is distinct from '[{"slot":"outerwear","itemId":"b"}]'::jsonb then
    raise exception 'TRYON-PROMPT3 postcondition: private.tryon_drawn_steps does not behave as stated';
  end if;
end;
$$;

commit;
