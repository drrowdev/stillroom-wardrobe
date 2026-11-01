-- TRYON-LIMITS1: more garments per try-on, results kept until the owner deletes them (issue #84, ADR28 amendment; owner direction
-- of 1 November 2026: "This is a personal app. Doesnt need enterprise grade privacy. Keep the photos until I remove them using
-- the app UI." and more than three garments). Classification:
--   additive: the manifest azure-global-image25-sunburst-tryon-v2 (and its provider-deployment row, the same deployment key as v1)
--     with three more prompts (layer, outerwear, accessory) and six chained steps; v1 stays installed and unchanged;
--   NON-ADDITIVE (constraints): chain/attempt/ledger step bounds 3 -> 6, next_step 4 -> 7, result item count 3 -> 6, and the
--     probe authorisation call cap 5 -> 6;
--   NON-ADDITIVE (data): private.tryon_results.expires_at is dropped with its checks and index. NO RESULT IS DELETED: every ready
--     result, including one past its old 7-day mark that the purge had not removed yet, is kept. Configured accounts move
--     tryon_manifest_id v1 -> v2 and tryon_notice_revision -> 3. Consent is never written, so the owner consents to notice
--     revision 3 again. The existing saved-photo guard runs as always: it deletes the saved reference photo when consent no
--     longer equals the configured notice, so the owner saves it again after consenting;
--   NON-ADDITIVE (function replacement, same signatures, ACLs kept; each body is the exact latest active definition plus the
--     deltas named here): public.tryon_claim (v2 manifest, six steps, 200-result cap over every stored or reserved result),
--     private.tryon_select_steps / tryon_select_idea_steps (six slots), public.tryon_status (limits, no result lifetime),
--     tryon_results_v1 / tryon_result_image_v1 / tryon_chain_status / tryon_cancel / tryon_finish (no expiry), tryon_expire_due
--     (no deletion by age; reserved-slot orphans, chains, stops and probe authorisations are still handled),
--     private.tryon_purge_overdue / public.tryon_purge_health (no overdue-result term), tryon_probe_authorise (six calls),
--     tryon_bootstrap (v2) and tryon_person_photo_put_v1 (notice revision 2 or later, consent equal to it).
-- Unchanged: RLS and grants, withdrawal (it ends running chains; results stay, as the notice says), tryon_discard_transient,
-- deletion_owner_rows_absent (account deletion cascades results through profiles; they are database rows, not Storage objects).
-- Rollout (docs/cloud-development.md): drain, apply, deploy the try-on Edge function, then Pages. A client or Edge function from
-- another version fails closed (the status read does not parse or the manifest/notice differ).
begin;

-- Preconditions: every function replaced below exists with the reviewed properties, the v1 manifest and deployment are installed,
-- v2 is not, and each constraint to change is found by its definition exactly once.
do $$
declare f regprocedure; p pg_catalog.pg_proc;
begin
  foreach f in array array['public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])','public.tryon_status()',
    'public.tryon_results_v1()','public.tryon_result_image_v1(uuid)','public.tryon_chain_status(uuid)','public.tryon_cancel(uuid)',
    'public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean,text,boolean)',
    'public.tryon_expire_due(integer)','public.tryon_purge_health()',
    'public.tryon_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz)',
    'public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)','public.tryon_person_photo_put_v1(text,text)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=f;
    if not p.prosecdef or not exists(select 1 from unnest(p.proconfig) x where x like 'search_path=%') then
      raise exception 'TRYON-LIMITS1 precondition: % properties not as expected',f;
    end if;
  end loop;
  perform 'private.tryon_select_steps(uuid,uuid)'::regprocedure, 'private.tryon_select_idea_steps(uuid,uuid[])'::regprocedure,
    'private.tryon_purge_overdue(timestamptz)'::regprocedure;
  if not exists(select 1 from private.ai_execution_manifests where id='azure-global-image25-sunburst-tryon-v1')
    or not exists(select 1 from private.provider_deployments where manifest_id='azure-global-image25-sunburst-tryon-v1') then
    raise exception 'TRYON-LIMITS1 precondition: the v1 manifest or its deployment is missing';
  end if;
  if exists(select 1 from private.ai_execution_manifests where id='azure-global-image25-sunburst-tryon-v2') then
    raise exception 'TRYON-LIMITS1 precondition: the v2 manifest already exists';
  end if;
end;
$$;

-- The step, count and call bounds, found by definition (their names were generated) and replaced with named constraints.
do $$
declare r record; v_name text; n integer;
begin
  for r in select * from (values
    ('private.tryon_chains','%jsonb_array_length(steps)%'),('private.tryon_chains','%next_step >= 1%'),
    ('private.tryon_attempts','%(step >= 1)%'),('private.ai_usage','%tryon_step >= 1%'),
    ('private.tryon_results','%cardinality(item_ids)%'),('private.tryon_probe_authorisations','%max_calls >= 1%')) v(tbl,pat) loop
    select count(*),min(conname) into n,v_name from pg_catalog.pg_constraint
      where conrelid=r.tbl::regclass and contype='c' and pg_get_constraintdef(oid) like r.pat;
    if n<>1 then raise exception 'TRYON-LIMITS1 precondition: % check % matched % times',r.tbl,r.pat,n; end if;
    execute format('alter table %s drop constraint %I',r.tbl,v_name);
  end loop;
end;
$$;
alter table private.tryon_chains
  add constraint tryon_chains_steps_count check (jsonb_typeof(steps)='array' and jsonb_array_length(steps) between 1 and 6),
  add constraint tryon_chains_next_step check (next_step between 1 and 7);
alter table private.tryon_attempts add constraint tryon_attempts_step_range check (step between 1 and 6);
alter table private.ai_usage add constraint ai_usage_tryon_step_range check (tryon_step between 1 and 6);
alter table private.tryon_probe_authorisations add constraint tryon_probe_authorisations_calls check (max_calls between 1 and 6);

-- Results have no lifetime. Dropping the column removes both checks that used it and tryon_results_expiry; the remaining
-- state check is restated without it. Every existing row is kept.
alter table private.tryon_results
  drop column expires_at,
  add constraint tryon_results_item_count check (cardinality(item_ids) between 1 and 6),
  add constraint tryon_results_ready check ((state='ready') = (jpeg is not null) and (jpeg is null) = (completed_at is null));

-- Manifest v2: the v1 numbers, model, deployment key and parameters; a new prompt set (prompt version 2) and settings.
insert into private.ai_execution_manifests values (
  'azure-global-image25-sunburst-tryon-v2','gpt-image-2.5-sunburst',2,
  'ae4ff2eba2785365bd05c41598116ac6abc9e21813230e7d1655fb067e9dc1d0',
  '20cefa4d2f2fd2c381ac50f30af286f48ea804d9e6fb6d58ca5c5dbd45fa8efe',
  'dd55d31420908672a3d55029e9fedfa2c9ce2a97032fe65d67da60708208a63e',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/images/edits','Global','GlobalStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-27T00:00:00Z',
  'Virtual try-on v2 on existing DEV/TEST eval-image25-sunburst-20260908 (GlobalStandard, 2 requests/min shared with photo enhancement). Retail API USD per1M: text input 5.00, image input 8.00, image output 30.00. Reservation 360000 micro per garment step values the 15000 total input (prompt plus person and garment images)/8000 output envelope with all input at image-in 8.00; the images API has no token cap, so this is an estimated envelope with possible in-flight overrun, handled by the anomaly kill switch. One garment per call, at most 6 chained steps (top or one-piece, bottoms, layer, outerwear, shoes, one accessory). Frozen parameters n1 1024x1280 medium jpeg compression85 opaque, no input_fidelity. The body photo is sent as is; Global processing may happen outside the EU. Results are kept until the owner deletes them.',
  'USD',800,3000,15000,8000,360000,512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'
);
insert into private.provider_deployments
  select 'azure-global-image25-sunburst-tryon-v2',deployment_key from private.provider_deployments
  where manifest_id='azure-global-image25-sunburst-tryon-v1';

-- Configured accounts move to v2 and notice revision 3. Consent is not touched, so each owner turns try-on on again. The
-- existing guard trigger on private.ai_controls then removes a saved reference photo whose consent no longer matches.
update private.ai_controls set tryon_manifest_id='azure-global-image25-sunburst-tryon-v2',tryon_notice_revision=3,
  updated_at=clock_timestamp() where tryon_manifest_id='azure-global-image25-sunburst-tryon-v1';


-- The SQL copy of selectTryOnSteps for a saved outfit (src/domain/tryon.ts): saved order, one garment per slot, six slots at most.
create or replace function private.tryon_select_steps(p_owner uuid,p_outfit uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := '[]'::jsonb; r record; v_slots text[];
begin
  if exists(select 1 from public.outfit_items oi join public.items i on i.owner_id=oi.owner_id and i.id=oi.item_id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where oi.owner_id=p_owner and oi.outfit_id=p_outfit and i.category='one_piece' and i.lifecycle='active'
        and i.deleted_at is null) then
    v_slots := array['one_piece','layer','outerwear','footwear','accessory'];
  else
    v_slots := array['top','bottom','layer','outerwear','footwear','accessory'];
  end if;
  for r in
    select s.slot,s.n,(select jsonb_build_object('slot',s.slot,'itemId',i.id,'imageId',im.id,'mainSha256',im.main_sha256,
        'bytes',im.main_bytes)
      from public.outfit_items oi join public.items i on i.owner_id=oi.owner_id and i.id=oi.item_id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where oi.owner_id=p_owner and oi.outfit_id=p_outfit and i.category=s.slot and i.lifecycle='active' and i.deleted_at is null
      order by oi.position limit 1) as step
    from unnest(v_slots) with ordinality s(slot,n) order by s.n
  loop
    if r.step is not null then v := v||jsonb_build_array(r.step); end if;
  end loop;
  return v;
end;
$$;

-- The same for an unsaved idea: the listed order instead of an outfit's saved order.
create or replace function private.tryon_select_idea_steps(p_owner uuid,p_items uuid[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := '[]'::jsonb; r record; v_slots text[];
begin
  if exists(select 1 from unnest(p_items) with ordinality u(id,n) join public.items i on i.owner_id=p_owner and i.id=u.id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where i.category='one_piece' and i.lifecycle='active' and i.deleted_at is null) then
    v_slots := array['one_piece','layer','outerwear','footwear','accessory'];
  else
    v_slots := array['top','bottom','layer','outerwear','footwear','accessory'];
  end if;
  for r in
    select s.slot,s.n,(select jsonb_build_object('slot',s.slot,'itemId',i.id,'imageId',im.id,'mainSha256',im.main_sha256,
        'bytes',im.main_bytes)
      from unnest(p_items) with ordinality u(id,n) join public.items i on i.owner_id=p_owner and i.id=u.id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where i.category=s.slot and i.lifecycle='active' and i.deleted_at is null
      order by u.n limit 1) as step
    from unnest(v_slots) with ordinality s(slot,n) order by s.n
  loop
    if r.step is not null then v := v||jsonb_build_array(r.step); end if;
  end loop;
  return v;
end;
$$;

-- The new-chain safeguard no longer looks at results: they have no age limit. Stranded accounting still blocks it.
create or replace function private.tryon_purge_overdue(p_now timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select exists(select 1 from private.ai_usage where purpose='try_on' and charge_state='held'
    and dispatched_at<p_now-interval '10 minutes');
$$;

-- 20261101080000's claim with the v2 manifest, six steps and the 200-result cap over every stored or reserved result.
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
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v2' or k.deployment_key is null then
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

-- 20261010090000's status with the new limits and no result lifetime.
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
  select count(*) into v_results from private.tryon_results where owner_id=p.owner_id;
  if c.owner_id is not null and c.tryon_manifest_id is not null then
    select k.dispatch_enabled into v_available from private.provider_deployments d
      join private.provider_capacity k on k.deployment_key=d.deployment_key where d.manifest_id=c.tryon_manifest_id;
    v_policy := jsonb_build_object('activated',c.tryon_activated,'noticeRevision',c.tryon_notice_revision,
      'manifestId',c.tryon_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.tryon_manifest_id),
      'maxRequestMicro',c.tryon_max_request_micro::text,
      'maxSteps',6,'maxResults',200,'providerAvailable',coalesce(v_available,false));
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

-- Owner reads: no expiry filter and no expiresAtMs. Everything else, including the results-contract header, is unchanged.
create or replace function public.tryon_results_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ideas boolean := private.tryon_results_contract();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  return jsonb_build_object('code','OK','results',coalesce((select jsonb_agg(jsonb_build_object('id',r.result_id,
      'outfitId',r.outfit_id,'itemIds',to_jsonb(r.item_ids),'bytes',octet_length(r.jpeg),
      'completedAtMs',floor(extract(epoch from r.completed_at)*1000)::bigint) order by r.completed_at desc,r.result_id)
    from private.tryon_results r
    where r.owner_id=auth.uid() and r.state='ready'
      and ((r.outfit_id is null and v_ideas) or exists(select 1 from public.outfits o where o.owner_id=r.owner_id
        and o.id=r.outfit_id and o.deleted_at is null))),'[]'::jsonb));
end;
$$;

create or replace function public.tryon_result_image_v1(p_result_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v bytea; v_ideas boolean := private.tryon_results_contract();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select r.jpeg into v from private.tryon_results r
    where r.owner_id=auth.uid() and r.result_id=p_result_id and r.state='ready'
      and ((r.outfit_id is null and v_ideas) or exists(select 1 from public.outfits o where o.owner_id=r.owner_id
        and o.id=r.outfit_id and o.deleted_at is null));
  if v is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','OK','jpegBase64',translate(encode(v,'base64'),E'\n',''),'bytes',octet_length(v));
end;
$$;

-- Stop and chain reconciliation find a finished result without an expiry.
create or replace function public.tryon_chain_status(p_chain_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; t private.tryon_chains; v_now timestamptz := clock_timestamp(); v_result uuid;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_chain_id is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  perform 1 from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.tryon_expire_owner(p.owner_id,v_now,100); end if;
  select * into t from private.tryon_chains where owner_id=p.owner_id and chain_id=p_chain_id;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  select result_id into v_result from private.tryon_results where owner_id=p.owner_id and chain_id=t.chain_id
    and state='ready';
  return jsonb_build_object('code','OK','state',t.state,'nextStep',t.next_step,
    'steps',(select jsonb_agg(jsonb_build_object('slot',x->>'slot','itemId',x->>'itemId') order by n)
      from jsonb_array_elements(t.steps) with ordinality s(x,n)),
    'activeAttempt',t.active_request_id is not null,'resultId',v_result,
    'expiresAtMs',floor(extract(epoch from t.expires_at)*1000)::bigint);
end;
$$;

create or replace function public.tryon_cancel(p_chain_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; t private.tryon_chains; v_now timestamptz := clock_timestamp(); v_result uuid;
begin
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_chain_id is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  perform 1 from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.tryon_expire_owner(p.owner_id,v_now,100); end if;
  select * into t from private.tryon_chains where owner_id=p.owner_id and chain_id=p_chain_id for update;
  if not found then
    -- VTO-3a: Stop can arrive before the first step has claimed. The marker makes that claim refuse; a repeat Stop
    -- reuses it. At most 60 new markers an hour per owner; over that, Stop is UNAVAILABLE and writes nothing.
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED');
    end if;
    if (select count(*) from private.tryon_chain_stops where owner_id=p.owner_id
        and created_at>v_now-interval '1 hour')>=60 then
      return jsonb_build_object('code','UNAVAILABLE');
    end if;
    insert into private.tryon_chain_stops(owner_id,chain_id,created_at) values(p.owner_id,p_chain_id,v_now);
    return jsonb_build_object('code','CANCELLED');
  end if;
  if t.state='running' then
    perform private.tryon_end_chain(p.owner_id,t.chain_id,'cancelled','CANCELLED',v_now);
    return jsonb_build_object('code','CANCELLED');
  end if;
  if t.state='complete' then
    select result_id into v_result from private.tryon_results where owner_id=p.owner_id and chain_id=t.chain_id
      and state='ready';
    return jsonb_build_object('code','COMPLETED','resultId',v_result);
  end if;
  return jsonb_build_object('code',upper(t.state));
end;
$$;

-- Finish publishes the result with completed_at only; its replies carry no expiresAtMs.
create or replace function public.tryon_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,p_output_sha256 text,
  p_output_bytes integer,p_output bytea,p_fetch_started boolean,p_client_live_at_fetch boolean,p_client_gone boolean,
  p_refusal_kind text default null,p_usage_absent boolean default null)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence; m private.ai_execution_manifests;
  a private.tryon_probe_authorisations; k private.provider_capacity; t private.tryon_chains; v_key text; v_probe uuid;
  v_chain uuid; v_now timestamptz; v_digest text; o record; v_code text; v_accounted bigint; v_last boolean;
  v_active boolean; v_result uuid;
begin
  select d.deployment_key,x.tryon_probe_id,y.tryon_chain_id into v_key,v_probe,v_chain from private.ai_usage_evidence x
    join private.ai_usage y on y.owner_id=x.owner_id and y.request_id=x.request_id
    join private.provider_deployments d on d.manifest_id=x.manifest_id
    where x.owner_id=p_owner_id and x.request_id=p_request_id and y.purpose='try_on';
  begin
    perform 1 from private.approved_accounts where user_id=p_owner_id for share;
    select * into p from public.profiles where owner_id=p_owner_id for update;
    if not found then return jsonb_build_object('code','UNAVAILABLE','accounting',null); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update;
    if v_probe is not null then
      select * into a from private.tryon_probe_authorisations where id=v_probe and owner_id=p_owner_id for update;
    end if;
    if v_chain is not null then
      select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=v_chain for update;
    end if;
    if v_key is not null then select * into k from private.provider_capacity where deployment_key=v_key for update; end if;
    select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id for update;
    select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id for update;
  exception when lock_not_available then return jsonb_build_object('code','BUSY','accounting',null);
  end;
  -- Expiry first, under the owner locks, as claim and dispatch do: a step past the provisional expiry keeps EXPIRED
  -- and a chain past its 30 minutes ends before settlement or publication is decided. Everything is then reloaded.
  perform private.tryon_expire_owner(p_owner_id,clock_timestamp(),100);
  select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id;
  select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id;
  if v_chain is not null then
    select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=v_chain;
  end if;
  if v_probe is not null then
    select * into a from private.tryon_probe_authorisations where id=v_probe and owner_id=p_owner_id;
  end if;
  if u.owner_id is null or u.purpose<>'try_on' or e.owner_id is null or k.deployment_key is null
    or e.tryon_probe_id is distinct from v_probe then
    return jsonb_build_object('code','INVALID_INPUT','accounting',null);
  end if;
  v_last := t.chain_id is not null and u.tryon_step=jsonb_array_length(t.steps);
  if p_code is null or p_code not in ('OK','FAILED','FILTERED','OUTPUT_REJECTED','NOT_DISPATCHED','PRE_DISPATCH')
    or p_fetch_started is null or p_client_gone is null
    or (p_refusal_kind is not null and p_refusal_kind not in ('rai_input','rai_output','unknown_filter','unverified_filter'))
    or (p_code<>'FILTERED' and (p_refusal_kind is not null or p_usage_absent is not null))
    or (p_usage_absent is not null and (p_usage is not null or p_refusal_kind is null))
    or ((p_code='PRE_DISPATCH') = p_fetch_started)
    or (p_fetch_started <> (p_client_live_at_fetch is not null))
    or (p_code in ('NOT_DISPATCHED','PRE_DISPATCH') and p_usage is not null)
    or ((p_code='OK') <> (p_output_sha256 is not null and p_output_bytes is not null))
    or (p_code<>'OK' and (p_output_sha256 is not null or p_output_bytes is not null or p_output is not null))
    or (p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$')
    or (p_output_bytes is not null and p_output_bytes not between 1 and 512000)
    or (p_output is not null and (octet_length(p_output)<>p_output_bytes or encode(sha256(p_output),'hex')<>p_output_sha256))
    or (p_code='OK' and v_last and p_output is null and e.enhance_settlement_origin is distinct from 'observed')
    or (p_code='OK' and not v_last and t.chain_id is not null and p_output is not null) then
    return jsonb_build_object('code','INVALID_INPUT','accounting',private.ai_accounting(u));
  end if;
  v_now := clock_timestamp();
  v_digest := encode(sha256(convert_to((jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)||jsonb_strip_nulls(jsonb_build_object('refusalKind',p_refusal_kind,
    'usageAbsent',p_usage_absent)))::text,'UTF8')),'hex');
  if e.enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch') then
    if e.enhance_settlement_digest<>v_digest then
      return jsonb_build_object('code','USAGE_CONFLICT','accounting',private.ai_accounting(u));
    end if;
    v_code := private.tryon_replay(e,u);
    if v_code='OK' and (v_last or (t.chain_id is null and exists(select 1 from private.tryon_results
        where owner_id=p_owner_id and chain_id=u.tryon_chain_id))) then
      -- A committed final picture stays readable after withdrawal or Stop. No resurrection: a deleted result is
      -- reported, never recreated.
      select result_id into v_result from private.tryon_results
        where owner_id=p_owner_id and chain_id=u.tryon_chain_id and state='ready';
      return jsonb_build_object('code','OK','replayed',true,'last',true,'accounting',private.ai_accounting(u),'resultId',v_result,
        'deleted',v_result is null);
    end if;
    if v_code='OK' then
      -- An intermediate is delivered again only while it is still the chain's current output, the chain is running
      -- and the permission holds; after Stop, withdrawal, expiry or the next claim the replay is LATE (no bytes).
      if t.chain_id is null or t.state<>'running' or t.expires_at<=v_now or t.active_request_id is not null
        or t.next_step<>u.tryon_step+1 or t.last_output_sha256 is distinct from p_output_sha256
        or c.tryon_manifest_id is distinct from e.manifest_id
        or (case when v_probe is null then private.tryon_permission(p,c,v_now)
          else private.tryon_probe_permission(p,c,a,v_now) end)<>'OK' then
        return jsonb_build_object('code','LATE','replayed',true,'accounting',private.ai_accounting(u));
      end if;
      return jsonb_build_object('code','OK','replayed',true,'last',false,'accounting',private.ai_accounting(u));
    end if;
    return jsonb_build_object('code',v_code,'replayed',true,'accounting',private.ai_accounting(u));
  end if;
  -- A fetch without a committed authorisation cannot happen through the Edge: an anomaly, observations not recorded.
  if p_fetch_started and e.tryon_dispatch_authorised_at is null then
    update private.ai_usage set charge_state='estimated',accounted_micro=reserved_micro,dispatched_at=coalesce(dispatched_at,v_now),
      closed_reason=coalesce(closed_reason,'UNAVAILABLE'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',
      enhance_settlement_digest=v_digest,tryon_settled_at=coalesce(tryon_settled_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.provider_capacity set dispatch_enabled=false,disabled_reason='USAGE_ANOMALY',disabled_at=v_now,updated_at=v_now
      where deployment_key=k.deployment_key and dispatch_enabled;
    update private.ai_controls set tryon_activated=false,updated_at=v_now where owner_id=p_owner_id and tryon_activated;
    if a.id is not null and a.stopped_at is null then
      update private.tryon_probe_authorisations set stopped_at=v_now,stopped_reason='USAGE_ANOMALY' where id=a.id;
    end if;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code','USAGE_ANOMALY','accounting',private.ai_accounting(u));
  end if;
  update private.ai_usage_evidence set tryon_fetch_started=p_fetch_started,tryon_client_live_at_fetch=p_client_live_at_fetch,
    tryon_client_gone_at_finish=p_client_gone,tryon_settled_at=coalesce(tryon_settled_at,v_now)
    where owner_id=p_owner_id and request_id=p_request_id returning * into e;
  if p_code='PRE_DISPATCH' then
    if e.tryon_dispatch_authorised_at is null then
      -- Proven pre-dispatch: a fetch needs a committed authorisation and a released row can never be authorised.
      if u.charge_state='held' then
        update private.ai_usage set charge_state='released',accounted_micro=0,dispatched_at=null,closed_reason='UNAVAILABLE',
          closed_at=v_now where owner_id=p_owner_id and request_id=p_request_id returning * into u;
      end if;
      update private.ai_usage_evidence set enhance_code='PRE_DISPATCH',enhance_settlement_origin='pre_dispatch',
        enhance_settlement_digest=v_digest,anomaly=false
        where owner_id=p_owner_id and request_id=p_request_id;
      perform private.tryon_close_attempt(p_owner_id,p_request_id,'released',v_now);
      return jsonb_build_object('code','PRE_DISPATCH','accounting',private.ai_accounting(u));
    end if;
    -- Authorised but not fetched (a lost or late mark reply, or the cutoff passed): charged as not dispatched.
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'UNAVAILABLE'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=true,enhance_code='PRE_DISPATCH',enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then
      update private.tryon_probe_authorisations set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code','NOT_DISPATCHED','accounting',private.ai_accounting(u));
  end if;
  if p_code='NOT_DISPATCHED' then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'UNAVAILABLE'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set enhance_code='NOT_DISPATCHED',enhance_settlement_origin='non_dispatch',
      enhance_settlement_digest=v_digest,anomaly=false
      where owner_id=p_owner_id and request_id=p_request_id;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code','NOT_DISPATCHED','accounting',private.ai_accounting(u));
  end if;
  -- FILT1: a proven content-filter refusal with genuinely absent metering. Charged the full reservation like
  -- unmetered, but not an anomaly; a probe authorisation still stops (missing usage). The switch and activation stay.
  if p_usage is null and p_code='FILTERED' and p_usage_absent and p_refusal_kind in ('rai_input','rai_output','unknown_filter') then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'FAILED'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=false,enhance_code=p_code,enhance_settlement_origin='filtered_unmetered',
      enhance_settlement_digest=v_digest,provider_refusal=p_refusal_kind,usage_absent=true
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then
      update private.tryon_probe_authorisations set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code',p_code,'accounting',private.ai_accounting(u));
  end if;
  if p_usage is null and p_code<>'OK' then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'FAILED'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest,provider_refusal=p_refusal_kind,usage_absent=p_usage_absent
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then
      update private.tryon_probe_authorisations set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code',p_code,'accounting',private.ai_accounting(u));
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  select * into o from private.enhance_azure_usage(p_usage,m);
  if not o.valid or o.bad or o.over then
    v_accounted := case when not o.valid then u.reserved_micro else greatest(o.estimate,u.reserved_micro) end;
    update private.ai_usage set charge_state='estimated',accounted_micro=v_accounted,
      closed_reason=coalesce(closed_reason,case when not o.valid then 'FAILED' else 'UNAVAILABLE' end),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set normalized_usage=case when o.valid then p_usage end,
      estimated_micro=case when o.valid then o.estimate end,anomaly=true,model_observation=coalesce(o.model,model_observation),
      enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',enhance_settlement_digest=v_digest,
      provider_refusal=p_refusal_kind
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.provider_capacity set dispatch_enabled=false,disabled_reason='USAGE_ANOMALY',disabled_at=v_now,updated_at=v_now
      where deployment_key=k.deployment_key and dispatch_enabled;
    update private.ai_controls set tryon_activated=false,updated_at=v_now where owner_id=p_owner_id and tryon_activated;
    if a.id is not null and a.stopped_at is null then
      update private.tryon_probe_authorisations set stopped_at=v_now,
        stopped_reason=case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end where id=a.id;
    end if;
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code',case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end,
      'accounting',private.ai_accounting(u));
  end if;
  v_code := case when u.closed_reason='EXPIRED' then 'EXPIRED' when p_code<>'OK' then p_code
    when c.tryon_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    when v_probe is not null then private.tryon_probe_permission(p,c,a,v_now)
    else private.tryon_permission(p,c,v_now) end;
  update private.ai_usage set charge_state='estimated',accounted_micro=o.estimate,
    closed_reason=case when closed_reason is not null then closed_reason when v_code='OK' then null
      when v_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then 'FAILED' else 'UNAVAILABLE' end,
    closed_at=case when closed_at is not null then closed_at when v_code='OK' then null else v_now end
    where owner_id=p_owner_id and request_id=p_request_id returning * into u;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=o.estimate,anomaly=false,model_observation=o.model,
    enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest,
    provider_refusal=p_refusal_kind
    where owner_id=p_owner_id and request_id=p_request_id;
  v_active := t.chain_id is not null and t.state='running' and t.expires_at>v_now
    and t.active_request_id is not distinct from p_request_id;
  if v_code<>'OK' then
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code',v_code,'accounting',private.ai_accounting(u));
  end if;
  if not v_active then
    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);
    return jsonb_build_object('code','LATE','accounting',private.ai_accounting(u));
  end if;
  update private.tryon_attempts set state='accepted',closed_at=v_now where owner_id=p_owner_id and request_id=p_request_id;
  if not v_last then
    update private.tryon_chains set active_request_id=null,next_step=next_step+1,last_output_sha256=p_output_sha256,
      last_output_bytes=p_output_bytes where owner_id=p_owner_id and chain_id=t.chain_id;
    return jsonb_build_object('code','OK','last',false,'accounting',private.ai_accounting(u));
  end if;
  update private.tryon_results set state='ready',jpeg=p_output,completed_at=v_now
    where owner_id=p_owner_id and chain_id=t.chain_id and state='reserved' returning result_id into v_result;
  update private.tryon_chains set state='complete',active_request_id=null,next_step=next_step+1,last_output_sha256=null,
    last_output_bytes=null,ended_at=v_now,end_reason='COMPLETE' where owner_id=p_owner_id and chain_id=t.chain_id;
  return jsonb_build_object('code','OK','last',true,'accounting',private.ai_accounting(u),'resultId',v_result,
    'deleted',v_result is null);
end;
$$;

-- Maintenance no longer deletes results by age. It still ends expired chains, settles stranded accounting and deletes reserved slots whose chain is gone.
create or replace function public.tryon_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_o integer; v_c integer;
  v_a integer; v_s integer;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  for v_owner in
    select pr.owner_id from public.profiles pr
      where exists(select 1 from private.ai_usage u join private.ai_usage_evidence e
          on e.owner_id=u.owner_id and e.request_id=u.request_id
          where u.owner_id=pr.owner_id and u.purpose='try_on' and u.charge_state='held'
            and (e.tryon_dispatch_authorised_at<=v_now-interval '3 minutes'
              or (e.tryon_dispatch_authorised_at is null and e.tryon_dispatch_before<v_now)))
        or exists(select 1 from private.tryon_chains t where t.owner_id=pr.owner_id and t.state='running'
          and t.expires_at<=v_now)
      order by pr.owner_id limit p_limit for update of pr skip locked
  loop
    exit when n>=p_limit;
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.tryon_expire_owner(v_owner,v_now,least(p_limit-n,100));
  end loop;
  delete from private.tryon_results r where ctid in (select x.ctid from private.tryon_results x
    where x.state='reserved' and not exists(select 1 from private.tryon_chains t where t.owner_id=x.owner_id
      and t.chain_id=x.chain_id and t.state='running') limit p_limit);
  get diagnostics v_o = row_count;
  delete from private.tryon_chains where ctid in (select ctid from private.tryon_chains
    where state<>'running' and ended_at<=v_now-interval '1 day' order by ended_at limit p_limit);
  get diagnostics v_c = row_count;
  delete from private.tryon_probe_authorisations where ctid in (select ctid from private.tryon_probe_authorisations
    where expires_at<=v_now-interval '90 days' order by expires_at limit p_limit);
  get diagnostics v_a = row_count;
  delete from private.tryon_chain_stops where ctid in (select ctid from private.tryon_chain_stops
    where created_at<=v_now-interval '1 day' order by created_at limit p_limit);
  get diagnostics v_s = row_count;
  return jsonb_build_object('code','OK','expired',n,'slotsPurged',v_o,'chainsPurged',v_c,
    'probesPurged',v_a,'stopsPurged',v_s);
end;
$$;

create or replace function public.tryon_purge_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code','OK',
    'overdueChains',(select count(*) from private.tryon_chains where state<>'running'
      and ended_at<clock_timestamp()-interval '25 hours'),
    'heldUsage',(select count(*) from private.ai_usage where purpose='try_on' and charge_state='held'
      and dispatched_at<clock_timestamp()-interval '10 minutes'),
    'safeguard',private.tryon_purge_overdue(clock_timestamp()));
$$;

-- The probe authorisation allows up to six calls, so one probe can cover a full six-garment chain.
create or replace function public.tryon_probe_authorise(p_id uuid,p_owner_id uuid,p_manifest_id text,p_max_calls integer,
  p_allocation_micro bigint,p_approval_ref text,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; v_used numeric; v_key text;
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

-- Bootstrap configures the v2 manifest.
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
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v2' then return jsonb_build_object('code','UNCONFIGURED'); end if;
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

-- Saving the reference photo needs the configured notice at revision 2 or later (the revisions that state it) and consent equal to it.
create or replace function public.tryon_person_photo_put_v1(p_jpeg_base64 text,p_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_code text; v_bytes bytea;
begin
  if auth.uid() is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  v_code := private.tryon_permission(p,c,v_now);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  if c.tryon_notice_revision<2 or c.tryon_consent_revision is distinct from c.tryon_notice_revision then
    return jsonb_build_object('code','CONSENT_REQUIRED');
  end if;
  if p_jpeg_base64 is null or p_sha256 is null or length(p_jpeg_base64) not between 8 and 682668 or length(p_jpeg_base64)%4<>0
    or p_jpeg_base64 !~ '^[A-Za-z0-9+/]+={0,2}$' or p_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  begin
    v_bytes := decode(p_jpeg_base64,'base64');
  exception when others then
    return jsonb_build_object('code','INVALID_INPUT');
  end;
  if encode(pg_catalog.sha256(v_bytes),'hex')<>p_sha256 or not private.tryon_person_photo_admit(v_bytes) then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  insert into private.tryon_person_photos(owner_id,jpeg,sha256,saved_at) values(p.owner_id,v_bytes,p_sha256,v_now)
    on conflict (owner_id) do update set jpeg=excluded.jpeg,sha256=excluded.sha256,saved_at=excluded.saved_at;
  return jsonb_build_object('code','OK','saved',true,'bytes',octet_length(v_bytes),
    'savedAtMs',floor(extract(epoch from v_now)*1000)::bigint);
end;
$$;

-- Postconditions: v2 is installed on the shared deployment key, no configured account is left at v1 or below notice 3, the
-- column and every bound are as intended, and no result row was lost by this migration (it never deletes one).
do $$
begin
  if (select count(distinct deployment_key) from private.provider_deployments
      where manifest_id in ('azure-global-image25-sunburst-tryon-v1','azure-global-image25-sunburst-tryon-v2'))<>1
    or (select count(*) from private.provider_deployments
      where manifest_id in ('azure-global-image25-sunburst-tryon-v1','azure-global-image25-sunburst-tryon-v2'))<>2 then
    raise exception 'TRYON-LIMITS1 postcondition: v2 is not on the v1 deployment key';
  end if;
  if exists(select 1 from private.ai_controls where tryon_manifest_id='azure-global-image25-sunburst-tryon-v1'
      or (tryon_manifest_id is not null and tryon_notice_revision<3)) then
    raise exception 'TRYON-LIMITS1 postcondition: a configured account is not on v2 and notice 3';
  end if;
  if exists(select 1 from pg_catalog.pg_attribute where attrelid='private.tryon_results'::regclass and attname='expires_at'
      and not attisdropped) then
    raise exception 'TRYON-LIMITS1 postcondition: tryon_results.expires_at still exists';
  end if;
  if (select count(*) from pg_catalog.pg_constraint where conname in ('tryon_chains_steps_count','tryon_chains_next_step',
      'tryon_attempts_step_range','ai_usage_tryon_step_range','tryon_results_item_count','tryon_results_ready',
      'tryon_probe_authorisations_calls'))<>7 then
    raise exception 'TRYON-LIMITS1 postcondition: a named constraint is missing';
  end if;
end;
$$;

commit;
