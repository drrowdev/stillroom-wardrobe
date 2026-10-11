-- TRYON-IDEA1: try on a Today idea without saving it as an outfit (issue #84, ADR28 amendment; owner request of 11 October 2026).
-- A chain may now be started from an owner-checked list of the owner's own garments instead of a saved outfit. Nothing else
-- about try-on changes: the per-step atomic holds, the shared monthly budget, Stop-before-claim, replay and late-result
-- suppression, consent, the 7-day result expiry and the owner-only reads are the reviewed bodies. Classification:
--   additive: one nullable chain column (idea_item_ids) and one private helper (tryon_select_idea_steps);
--   NON-ADDITIVE (constraints): outfit_id is nullable on private.tryon_chains and private.tryon_results. The composite owner
--     foreign keys are MATCH SIMPLE, so a null outfit_id skips the check; outfit-bound rows keep their key and cascade, and
--     a chain's outfit_id and idea_item_ids are never both set or both null;
--   NON-ADDITIVE (function replacement): public.tryon_claim gains one trailing defaulted argument p_item_ids (drop restrict
--     + create, FILT1 pattern; the old signature must be gone, the owner is the old claim's owner and the grants are
--     restated), and public.tryon_results_v1 and public.tryon_result_image_v1 keep their signatures and also answer for
--     results that have no outfit, but ONLY for a request that sends the header X-Stillroom-TryOn-Results-Contract: 2
--     (PostgREST exposes it as request.headers). Without it, an older cached client sees exactly the outfit rows it always
--     saw and its strict list parser keeps working; the owner's delete by id needs no header.
-- No new public function name, no new table, no grant to the API roles. Nothing dispatches: activation and the provider
-- switch are unchanged. Idea results belong to no outfit: they end by the 7-day expiry, the owner's delete, the profile
-- cascade, account deletion or tryon_discard_transient(), and never reach outfits, history, suggestions, statistics or exports.
-- Rollout (see docs/cloud-development.md): apply, then the operator reloads the PostgREST schema cache and runs the old- and
-- new-shaped non-dispatching claim checks BEFORE the Edge function is deployed. A cached query that still names the old
-- signature fails closed (function not found: nothing is claimed, held or charged).
begin;

-- Preconditions: the installed claim has the reviewed properties and grants and nothing depends on it. Its owner is kept.
do $$
declare f regprocedure := 'public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)'::regprocedure; p pg_catalog.pg_proc;
begin
  select * into p from pg_catalog.pg_proc where oid=f;
  if not p.prosecdef or p.prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
    or (select array_agg(x order by x) from unnest(p.proconfig) x) is distinct from array['lock_timeout=2s','search_path=""']
    or p.proacl is null or not has_function_privilege('service_role',f,'EXECUTE')
    or exists(select 1 from aclexplode(p.proacl) x where x.privilege_type='EXECUTE'
      and x.grantee not in (p.proowner,'service_role'::regrole)) then
    raise exception 'TRYON-IDEA1 precondition: tryon_claim properties not as expected';
  end if;
  if (select count(*) from pg_catalog.pg_proc where proname='tryon_claim' and pronamespace='public'::regnamespace)<>1 then
    raise exception 'TRYON-IDEA1 precondition: more than one tryon_claim signature';
  end if;
  if exists(select 1 from pg_catalog.pg_depend where refclassid='pg_catalog.pg_proc'::regclass and refobjid=f) then
    raise exception 'TRYON-IDEA1 precondition: tryon_claim has dependants';
  end if;
  if to_regclass('cron.job') is not null then
    if exists(select 1 from cron.job where command like '%tryon_claim%') then
      raise exception 'TRYON-IDEA1 precondition: a scheduled job calls tryon_claim';
    end if;
  end if;
  perform set_config('tryon_idea.claim_owner',p.proowner::regrole::text,true);
end;
$$;

-- Workflow state. An idea chain has no outfit: its garments are frozen in steps at the claim, and idea_item_ids is the
-- immutable request identity a step-1 retry must repeat (as p_outfit_id is for an outfit chain).
alter table private.tryon_chains alter column outfit_id drop not null;
alter table private.tryon_results alter column outfit_id drop not null;
alter table private.tryon_chains
  add column idea_item_ids uuid[],
  add constraint tryon_chains_idea_items check ((outfit_id is null) = (idea_item_ids is not null)
    and (idea_item_ids is null or (array_ndims(idea_item_ids)=1 and cardinality(idea_item_ids) between 1 and 8
      and array_position(idea_item_ids,null) is null)));

-- The SQL copy of selectTryOnSteps for an idea (src/domain/tryon.ts): the listed order instead of an outfit's saved order,
-- active and not deleted, one ready image. Only this owner's items can match.
create function private.tryon_select_idea_steps(p_owner uuid,p_items uuid[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := '[]'::jsonb; r record; v_slots text[];
begin
  if exists(select 1 from unnest(p_items) with ordinality u(id,n) join public.items i on i.owner_id=p_owner and i.id=u.id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where i.category='one_piece' and i.lifecycle='active' and i.deleted_at is null) then
    v_slots := array['one_piece','footwear'];
  else
    v_slots := array['top','bottom','footwear'];
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

-- The opt-in for results that have no outfit: a client that parses them says so with this request header.
create function private.tryon_results_contract() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-stillroom-tryon-results-contract','')='2';
$$;

-- Owner reads, same signatures and shape. An outfit's result still needs its outfit to be live. A result without an outfit
-- is returned only to a request that sends the results-contract header; any other request sees the outfit rows alone.
create or replace function public.tryon_results_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_ideas boolean := private.tryon_results_contract();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  return jsonb_build_object('code','OK','results',coalesce((select jsonb_agg(jsonb_build_object('id',r.result_id,
      'outfitId',r.outfit_id,'itemIds',to_jsonb(r.item_ids),'bytes',octet_length(r.jpeg),
      'completedAtMs',floor(extract(epoch from r.completed_at)*1000)::bigint,
      'expiresAtMs',floor(extract(epoch from r.expires_at)*1000)::bigint) order by r.completed_at desc,r.result_id)
    from private.tryon_results r
    where r.owner_id=auth.uid() and r.state='ready' and r.expires_at>v_now
      and ((r.outfit_id is null and v_ideas) or exists(select 1 from public.outfits o where o.owner_id=r.owner_id
        and o.id=r.outfit_id and o.deleted_at is null))),'[]'::jsonb));
end;
$$;

create or replace function public.tryon_result_image_v1(p_result_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v bytea; v_now timestamptz := clock_timestamp(); v_ideas boolean := private.tryon_results_contract();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select r.jpeg into v from private.tryon_results r
    where r.owner_id=auth.uid() and r.result_id=p_result_id and r.state='ready' and r.expires_at>v_now
      and ((r.outfit_id is null and v_ideas) or exists(select 1 from public.outfits o where o.owner_id=r.owner_id
        and o.id=r.outfit_id and o.deleted_at is null));
  if v is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','OK','jpegBase64',translate(encode(v,'base64'),E'\n',''),'bytes',octet_length(v));
end;
$$;

-- 20261010090000's claim plus the idea argument: step 1 names exactly one of an outfit or an item list. Every listed id must
-- be this owner's item (a foreign or unknown id is NOT_FOUND alike). An existing chain keeps the identity it started with.
drop function public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid) restrict;
create function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
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
    or p_step is null or p_step not between 1 and 3 or p_manifest_id is null
    or (p_step=1 and p_person_sha256 is not null)
    or (p_step>1 and (p_person_sha256 is null or p_person_sha256 !~ '^[0-9a-f]{64}$'))
    or (t.chain_id is null and p_step<>1)
    or (p_step=1 and (p_outfit_id is null) = (p_item_ids is null))
    or (p_step=1 and t.chain_id is not null and (p_outfit_id is distinct from t.outfit_id
      or p_item_ids is distinct from t.idea_item_ids))
    or (p_step>1 and (p_item_ids is not null or (p_outfit_id is not null and p_outfit_id is distinct from t.outfit_id)))
    or (p_item_ids is not null and (coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 8
      or array_position(p_item_ids,null) is not null
      or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids))) then
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

-- The new function keeps the old claim's owner (the role that owned it when this migration started).
do $$
declare f regprocedure := 'public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure;
  v_owner text := current_setting('tryon_idea.claim_owner');
begin
  if (select proowner::regrole::text from pg_catalog.pg_proc where oid=f) is distinct from v_owner then
    execute format('alter function %s owner to %s',f,v_owner);
  end if;
end;
$$;

revoke all on function private.tryon_select_idea_steps(uuid,uuid[]) from public,anon,authenticated,service_role;
revoke all on function private.tryon_results_contract() from public,anon,authenticated,service_role;
revoke all on function public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[]) to service_role;

-- Postconditions: exactly one claim signature (the old one is gone, one null default); it keeps the reviewed properties, the
-- old owner and service-role-only EXECUTE; the reads keep their properties; the constraints are valid.
do $$
declare f regprocedure := 'public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure; p pg_catalog.pg_proc;
  r regprocedure;
begin
  if to_regprocedure('public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)') is not null
    or (select count(*) from pg_catalog.pg_proc where proname='tryon_claim' and pronamespace='public'::regnamespace)<>1 then
    raise exception 'TRYON-IDEA1 postcondition: the old tryon_claim signature remains or a second one exists';
  end if;
  select * into p from pg_catalog.pg_proc where oid=f;
  if p.pronargdefaults<>1 or pg_catalog.pg_get_expr(p.proargdefaults,0) is distinct from 'NULL::uuid[]' then
    raise exception 'TRYON-IDEA1 postcondition: tryon_claim must have exactly one null default';
  end if;
  if not p.prosecdef or p.prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
    or (select array_agg(x order by x) from unnest(p.proconfig) x) is distinct from array['lock_timeout=2s','search_path=""']
    or p.proowner::regrole::text is distinct from current_setting('tryon_idea.claim_owner')
    or p.proowner is distinct from (select proowner from pg_catalog.pg_proc where oid='public.tryon_dispatch(uuid,uuid,boolean)'::regprocedure)
    or p.proacl is null or not has_function_privilege('service_role',f,'EXECUTE')
    or has_function_privilege('anon',f,'EXECUTE') or has_function_privilege('authenticated',f,'EXECUTE')
    or exists(select 1 from aclexplode(p.proacl) x where x.privilege_type='EXECUTE'
      and x.grantee not in (p.proowner,'service_role'::regrole)) then
    raise exception 'TRYON-IDEA1 postcondition: tryon_claim properties not as expected';
  end if;
  foreach r in array array['public.tryon_results_v1()','public.tryon_result_image_v1(uuid)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=r;
    if not p.prosecdef or p.provolatile<>'s' or p.proowner is distinct from (select proowner from pg_catalog.pg_proc where oid=f)
      or (select array_agg(x order by x) from unnest(p.proconfig) x) is distinct from array['search_path=""']
      or not has_function_privilege('authenticated',r,'EXECUTE') or has_function_privilege('anon',r,'EXECUTE') then
      raise exception 'TRYON-IDEA1 postcondition: % properties not as expected',r;
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_constraint where conrelid in ('private.tryon_chains'::regclass,'private.tryon_results'::regclass)
      and not convalidated) then
    raise exception 'TRYON-IDEA1 postcondition: a try-on constraint is not validated';
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='private.tryon_chains'::regclass
      and conname='tryon_chains_idea_items' and convalidated) then
    raise exception 'TRYON-IDEA1 postcondition: the idea constraint is missing';
  end if;
  if exists(select 1 from pg_catalog.pg_attribute where attrelid in ('private.tryon_chains'::regclass,'private.tryon_results'::regclass)
      and attname='outfit_id' and attnotnull) then
    raise exception 'TRYON-IDEA1 postcondition: outfit_id is still required';
  end if;
  if has_function_privilege('authenticated','private.tryon_select_idea_steps(uuid,uuid[])','EXECUTE')
    or has_function_privilege('service_role','private.tryon_select_idea_steps(uuid,uuid[])','EXECUTE')
    or has_function_privilege('authenticated','private.tryon_results_contract()','EXECUTE')
    or has_function_privilege('service_role','private.tryon_results_contract()','EXECUTE') then
    raise exception 'TRYON-IDEA1 postcondition: a private helper is callable by an API role';
  end if;
end;
$$;

commit;
