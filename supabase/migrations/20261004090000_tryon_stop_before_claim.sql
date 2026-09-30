-- VTO-3a: Stop before claim (ADR28; VTO-3 plan rev3, approved by 001cb8ee). The hosted runtime does not pass a client
-- abort to the Edge function, so a step request that has already arrived can still claim after the owner pressed Stop.
-- Stop for a chain the server has not seen yet now records an owner-scoped marker, and the claim refuses a marked chain
-- before it writes anything. Classification:
--   additive: private.tryon_chain_stops (owner, chain, time only; RLS on, no grants, cascades with the profile);
--   NON-ADDITIVE (function replacement, same signatures, grants kept): public.tryon_cancel (the missing-chain branch),
--     public.tryon_claim (one check first in the new-chain branch), public.tryon_expire_due (purges markers after one
--     day, stopsPurged), public.tryon_discard_transient (deletes markers, stopsDeleted) and
--     private.deletion_owner_rows_absent (adds the marker table). Every other statement in each body is unchanged.
-- Cancel and claim both lock the owner's profile row, so one of them sees the other's committed work. Nothing
-- dispatches: the provider switch and activation are unchanged.
begin;

create table private.tryon_chain_stops (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  chain_id uuid not null,
  created_at timestamptz not null,
  primary key(owner_id,chain_id)
);
create index tryon_chain_stops_created on private.tryon_chain_stops(created_at);
alter table private.tryon_chain_stops enable row level security;
revoke all on private.tryon_chain_stops from public,anon,authenticated,service_role;

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
      and state='ready' and expires_at>v_now;
    return jsonb_build_object('code','COMPLETED','resultId',v_result);
  end if;
  return jsonb_build_object('code',upper(t.state));
end;
$$;

create or replace function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; t private.tryon_chains;
  k private.provider_capacity; m private.ai_execution_manifests; v_now timestamptz; v_code text; s record; v_slot uuid;
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
  -- Expiry first: it can stop this probe authorisation or end this chain, so both are reloaded before judging.
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
    or (t.chain_id is null and (p_step<>1 or p_outfit_id is null))
    or (t.chain_id is not null and p_outfit_id is not null and p_outfit_id<>t.outfit_id) then
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
  select * into s from private.tryon_usage(p.owner_id,v_now);
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.tryon_probe_id=a.id;
  end if;
  v_new := t.chain_id is null;
  if v_new then
    -- VTO-3a: a chain stopped before this claim is never created: no usage, slot, chain, attempt or result.
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED','claimed',false);
    end if;
    if exists(select 1 from private.tryon_results where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','TERMINAL','claimed',false);
    end if;
    if private.tryon_purge_overdue(v_now) then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
      return jsonb_build_object('code','NOT_FOUND','claimed',false);
    end if;
    v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
    v_n := jsonb_array_length(v_steps);
    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;
    if (select count(*) from private.tryon_results where owner_id=p.owner_id
        and (state='reserved' or expires_at>v_now))>=20 then
      return jsonb_build_object('code','RESULTS_FULL','claimed',false);
    end if;
    -- §3.5 precheck with the effective reservation for every step. It reserves nothing: each step re-checks.
    if s.tryon_micro+v_n*v_r>c.tryon_monthly_allowance_micro or s.total_micro+v_n*v_r>c.monthly_allowance_micro then
      return jsonb_build_object('code','ALLOWANCE','claimed',false);
    end if;
    if a.id is not null and (v_calls+v_n>a.max_calls or v_spent+v_n*v_r>a.allocation_micro) then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
    if s.tryon_hour+v_n>c.tryon_max_requests_per_hour or s.total_hour+v_n>c.max_requests_per_hour then
      return jsonb_build_object('code','RATE_LIMIT','claimed',false);
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
  -- D4 at every step claim: never substitute. A changed garment ends the chain as stale with no usage or slot.
  if not private.tryon_garment_current(p.owner_id,(v_step->>'itemId')::uuid,(v_step->>'imageId')::uuid,
      v_step->>'mainSha256',(v_step->>'bytes')::integer) then
    if not v_new then perform private.tryon_end_chain(p.owner_id,t.chain_id,'stale','CHAIN_MISMATCH',v_now); end if;
    return jsonb_build_object('code','CHAIN_MISMATCH','claimed',false);
  end if;
  if s.tryon_micro+v_r>c.tryon_monthly_allowance_micro or s.total_micro+v_r>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null and (v_calls>=a.max_calls or v_spent+v_r>a.allocation_micro) then
    return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
  end if;
  if s.tryon_hour>=c.tryon_max_requests_per_hour or s.total_hour>=c.max_requests_per_hour then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  select main_path into v_path from public.item_images where owner_id=p.owner_id and id=(v_step->>'imageId')::uuid;
  if v_new then
    insert into private.tryon_chains(owner_id,chain_id,outfit_id,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,v_steps,'running',1,gen_random_uuid(),v_now,v_now+interval '30 minutes')
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

create or replace function public.tryon_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_r integer; v_o integer; v_c integer;
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
  delete from private.tryon_results where ctid in (select ctid from private.tryon_results
    where state='ready' and expires_at<=v_now order by expires_at limit p_limit);
  get diagnostics v_r = row_count;
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
  return jsonb_build_object('code','OK','expired',n,'resultsPurged',v_r,'slotsPurged',v_o,'chainsPurged',v_c,
    'probesPurged',v_a,'stopsPurged',v_s);
end;
$$;

create or replace function public.tryon_discard_transient() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; v_r integer; v_c integer; v_s integer; n integer := 0;
begin
  delete from private.tryon_results;
  get diagnostics v_r = row_count;
  delete from private.tryon_chains;
  get diagnostics v_c = row_count;
  delete from private.tryon_attempts;
  delete from private.tryon_chain_stops;
  get diagnostics v_s = row_count;
  for v_owner in
    select pr.owner_id from public.profiles pr where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id
      and u.purpose='try_on' and u.charge_state='held') order by pr.owner_id for update of pr
  loop
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.tryon_expire_accounting(v_owner,v_now,100);
  end loop;
  return jsonb_build_object('code','OK','resultsDeleted',v_r,'chainsDeleted',v_c,'stopsDeleted',v_s,'expired',n);
end;
$$;

create or replace function private.deletion_owner_rows_absent(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not (
    exists(select 1 from public.profiles where owner_id=p_owner)
    or exists(select 1 from public.style_preferences where owner_id=p_owner)
    or exists(select 1 from public.items where owner_id=p_owner)
    or exists(select 1 from public.item_images where owner_id=p_owner)
    or exists(select 1 from public.outfits where owner_id=p_owner)
    or exists(select 1 from public.outfit_items where owner_id=p_owner)
    or exists(select 1 from public.wear_events where owner_id=p_owner)
    or exists(select 1 from public.wear_event_items where owner_id=p_owner)
    or exists(select 1 from public.combination_rules where owner_id=p_owner)
    or exists(select 1 from public.suggestion_feedback where owner_id=p_owner)
    or exists(select 1 from private.ai_controls where owner_id=p_owner)
    or exists(select 1 from private.ai_usage where owner_id=p_owner)
    or exists(select 1 from private.ai_requests where owner_id=p_owner)
    or exists(select 1 from private.ai_usage_evidence where owner_id=p_owner)
    or exists(select 1 from private.ai_analysis_attestations where owner_id=p_owner)
    or exists(select 1 from private.item_save_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_save_used_receipts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_context where owner_id=p_owner)
    or exists(select 1 from private.item_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.item_image_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_claims where owner_id=p_owner)
    or exists(select 1 from private.image_change_attempts where owner_id=p_owner)
    or exists(select 1 from private.image_change_context where owner_id=p_owner)
    or exists(select 1 from private.image_change_history where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_operations where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_targets where owner_id=p_owner)
    or exists(select 1 from private.imported_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.image_enhancements where owner_id=p_owner)
    or exists(select 1 from private.enhancement_outputs where owner_id=p_owner)
    or exists(select 1 from private.image_provenance where owner_id=p_owner)
    or exists(select 1 from private.image_enhancement_bindings where owner_id=p_owner)
    or exists(select 1 from private.restore_image_markers where owner_id=p_owner)
    or exists(select 1 from private.enhancement_probe_authorisations where owner_id=p_owner)
    or exists(select 1 from private.app_admins where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where actor_owner_id=p_owner)
    or exists(select 1 from private.tryon_chains where owner_id=p_owner)
    or exists(select 1 from private.tryon_attempts where owner_id=p_owner)
    or exists(select 1 from private.tryon_results where owner_id=p_owner)
    or exists(select 1 from private.tryon_probe_authorisations where owner_id=p_owner)
    or exists(select 1 from private.tryon_chain_stops where owner_id=p_owner));
$$;

commit;
