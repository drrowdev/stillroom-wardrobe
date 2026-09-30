-- FILT1: provider refusal kind and filtered_unmetered settlement (plan rev3, Tier A; issue #84).
-- Additive to the evidence: two nullable columns and one settlement origin. A proven content-filter refusal with
-- genuinely absent metering (the Edge sends p_refusal_kind in rai_input/rai_output/unknown_filter and
-- p_usage_absent=true) settles as filtered_unmetered: charged the full reservation like unmetered, anomaly false, a
-- probe authorisation still stops with MISSING_USAGE, the switch and activation are untouched. Everything else keeps
-- today's handling; with both new arguments null (an old Edge) settlement and the idempotency digest are unchanged.
-- NON-ADDITIVE: the origin and digest checks are widened, and tryon_finish/enhance_finish are replaced with two
-- trailing defaulted parameters (drop restrict + create; no dependants, checked first). One transaction: the
-- preconditions, the constraints, the replays, both replacements, the grants and the postconditions.
begin;

-- Preconditions: both installed signatures with their properties and grants, owned like tryon_claim, and nothing
-- depending on them (views, rules, cron commands).
do $$
declare f regprocedure; p pg_catalog.pg_proc;
begin
  foreach f in array array['public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean)','public.enhance_finish(uuid,uuid,text,jsonb,text,integer)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=f;
    if not p.prosecdef or p.prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
      or (select array_agg(x order by x) from unnest(p.proconfig) x) is distinct from array['lock_timeout=2s','search_path=""']
      or p.proowner is distinct from (select proowner from pg_catalog.pg_proc where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)'::regprocedure)
      or p.proacl is null or not has_function_privilege('service_role',f,'EXECUTE')
      or exists(select 1 from aclexplode(p.proacl) x where x.privilege_type='EXECUTE'
        and x.grantee not in (p.proowner,'service_role'::regrole)) then
      raise exception 'FILT1 precondition: % properties not as expected',f;
    end if;
  end loop;
end;
$$;
do $$
begin
  if exists(select 1 from pg_catalog.pg_depend where refclassid='pg_catalog.pg_proc'::regclass
      and refobjid in ('public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean)'::regprocedure,'public.enhance_finish(uuid,uuid,text,jsonb,text,integer)'::regprocedure)) then
    raise exception 'FILT1 precondition: the finish functions have dependants';
  end if;
  if to_regclass('cron.job') is not null then
    if exists(select 1 from cron.job where command like '%tryon_finish%' or command like '%enhance_finish%') then
      raise exception 'FILT1 precondition: a scheduled job calls a finish function';
    end if;
  end if;
end;
$$;

-- Evidence: the bounded refusal kind (FILTERED only) and whether metering was genuinely absent.
alter table private.ai_usage_evidence
  drop constraint ai_usage_evidence_enhance_settlement_origin_check,
  drop constraint ai_usage_evidence_enhance_digest;
alter table private.ai_usage_evidence
  add column provider_refusal text,
  add column usage_absent boolean,
  add constraint ai_usage_evidence_enhance_settlement_origin_check check (enhance_settlement_origin in
    ('provisional_expiry','observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch')),
  add constraint ai_usage_evidence_enhance_digest check
    ((enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch'))
      is not distinct from (enhance_settlement_digest is not null)
      or (enhance_settlement_origin is null and enhance_settlement_digest is null)),
  add constraint ai_usage_evidence_refusal_kind check (provider_refusal in ('rai_input','rai_output','unknown_filter','unverified_filter')),
  add constraint ai_usage_evidence_refusal_filtered check (provider_refusal is null or enhance_code='FILTERED'),
  add constraint ai_usage_evidence_usage_absent check (usage_absent is null
    or (provider_refusal is not null and normalized_usage is null)),
  add constraint ai_usage_evidence_filtered_unmetered check (enhance_settlement_origin is distinct from 'filtered_unmetered'
    or (enhance_code is not distinct from 'FILTERED' and provider_refusal is not null and provider_refusal in ('rai_input','rai_output','unknown_filter')
      and usage_absent is true and normalized_usage is null and anomaly is false));

-- Replays: filtered_unmetered replays as FILTERED.
create or replace function private.tryon_replay(e private.ai_usage_evidence,u private.ai_usage) returns text
language sql stable set search_path = '' as $$
  select case
    when e.enhance_settlement_origin='pre_dispatch' then 'PRE_DISPATCH'
    when e.enhance_settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.enhance_settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when e.enhance_settlement_origin='unmetered' and e.enhance_code='PRE_DISPATCH' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='unmetered' then e.enhance_code
    when e.enhance_settlement_origin='filtered_unmetered' then 'FILTERED'
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.enhance_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then e.enhance_code
    when exists(select 1 from private.tryon_attempts x where x.owner_id=u.owner_id and x.request_id=u.request_id
      and x.state='accepted') then 'OK'
    when u.closed_reason is not null then 'UNAVAILABLE'
    else 'LATE' end;
$$;

create or replace function private.enhance_replay(e private.ai_usage_evidence,u private.ai_usage,p public.profiles,c private.ai_controls,
  a private.enhancement_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when e.enhance_settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.enhance_settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when e.enhance_settlement_origin='unmetered' then e.enhance_code
    when e.enhance_settlement_origin='filtered_unmetered' then 'FILTERED'
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.enhance_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then e.enhance_code
    when c.enhance_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    when not exists(select 1 from private.image_enhancements x where x.owner_id=e.owner_id and x.request_id=e.request_id
      and x.usable_until>p_now) then 'EXPIRED'
    when e.enhance_probe_id is not null then private.enhance_probe_permission(p,c,a,p_now)
    else private.enhance_permission(p,c) end;
$$;

-- Finish: the installed bodies plus the refusal validation, the digest suffix (only when present), the settled-set
-- entry, the evidence columns and the filtered_unmetered branch just before unmetered.
drop function public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean) restrict;
create function public.tryon_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,p_output_sha256 text,
  p_output_bytes integer,p_output bytea,p_fetch_started boolean,p_client_live_at_fetch boolean,p_client_gone boolean,
  p_refusal_kind text default null,p_usage_absent boolean default null)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence; m private.ai_execution_manifests;
  a private.tryon_probe_authorisations; k private.provider_capacity; t private.tryon_chains; v_key text; v_probe uuid;
  v_chain uuid; v_now timestamptz; v_digest text; o record; v_code text; v_accounted bigint; v_last boolean;
  v_active boolean; v_result uuid; v_until timestamptz;
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
      -- A committed final picture stays readable after withdrawal or Stop. No resurrection: a deleted or expired
      -- result is reported, never recreated.
      select result_id,expires_at into v_result,v_until from private.tryon_results
        where owner_id=p_owner_id and chain_id=u.tryon_chain_id and state='ready' and expires_at>v_now;
      return jsonb_build_object('code','OK','replayed',true,'last',true,'accounting',private.ai_accounting(u),'resultId',v_result,
        'deleted',v_result is null,'expiresAtMs',floor(extract(epoch from v_until)*1000)::bigint);
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
  v_until := v_now+interval '7 days';
  update private.tryon_results set state='ready',jpeg=p_output,completed_at=v_now,expires_at=v_until
    where owner_id=p_owner_id and chain_id=t.chain_id and state='reserved' returning result_id into v_result;
  update private.tryon_chains set state='complete',active_request_id=null,next_step=next_step+1,last_output_sha256=null,
    last_output_bytes=null,ended_at=v_now,end_reason='COMPLETE' where owner_id=p_owner_id and chain_id=t.chain_id;
  return jsonb_build_object('code','OK','last',true,'accounting',private.ai_accounting(u),'resultId',v_result,
    'deleted',v_result is null,'expiresAtMs',floor(extract(epoch from v_until)*1000)::bigint);
end;
$$;

drop function public.enhance_finish(uuid,uuid,text,jsonb,text,integer) restrict;
create function public.enhance_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,
  p_output_sha256 text,p_output_bytes integer,p_refusal_kind text default null,p_usage_absent boolean default null)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence; m private.ai_execution_manifests;
  a private.enhancement_probe_authorisations; k private.provider_capacity; v_key text; v_probe uuid;
  v_now timestamptz; v_digest text; o record; v_code text; v_accounted bigint; v_until timestamptz;
begin
  select d.deployment_key,x.enhance_probe_id into v_key,v_probe from private.ai_usage_evidence x
    join private.provider_deployments d on d.manifest_id=x.manifest_id
    where x.owner_id=p_owner_id and x.request_id=p_request_id;
  begin
    perform 1 from private.approved_accounts where user_id=p_owner_id for share;
    select * into p from public.profiles where owner_id=p_owner_id for update;
    if not found then return jsonb_build_object('code','UNAVAILABLE','accounting',null); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update;
    if v_probe is not null then
      select * into a from private.enhancement_probe_authorisations where id=v_probe and owner_id=p_owner_id for update;
    end if;
    if v_key is not null then select * into k from private.provider_capacity where deployment_key=v_key for update; end if;
    select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id for update;
    select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id for update;
  exception when lock_not_available then return jsonb_build_object('code','BUSY','accounting',null);
  end;
  if u.owner_id is null or u.purpose<>'enhancement' or e.owner_id is null or k.deployment_key is null
    or e.enhance_probe_id is distinct from v_probe then
    return jsonb_build_object('code','INVALID_INPUT','accounting',null);
  end if;
  if p_code is null or p_code not in ('OK','FAILED','FILTERED','OUTPUT_REJECTED','NOT_DISPATCHED')
    or (p_code='NOT_DISPATCHED' and p_usage is not null)
    or (p_refusal_kind is not null and p_refusal_kind not in ('rai_input','rai_output','unknown_filter','unverified_filter'))
    or (p_code<>'FILTERED' and (p_refusal_kind is not null or p_usage_absent is not null))
    or (p_usage_absent is not null and (p_usage is not null or p_refusal_kind is null))
    or ((p_code='OK') <> (p_output_sha256 is not null and p_output_bytes is not null))
    or (p_code<>'OK' and (p_output_sha256 is not null or p_output_bytes is not null))
    or (p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$')
    or (p_output_bytes is not null and p_output_bytes not between 1 and 512000) then
    return jsonb_build_object('code','INVALID_INPUT','accounting',private.ai_accounting(u));
  end if;
  v_now := clock_timestamp();
  v_digest := encode(sha256(convert_to((jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)||jsonb_strip_nulls(jsonb_build_object('refusalKind',p_refusal_kind,
    'usageAbsent',p_usage_absent)))::text,'UTF8')),'hex');
  if e.enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch') then
    if e.enhance_settlement_digest<>v_digest then
      return jsonb_build_object('code','USAGE_CONFLICT','accounting',private.ai_accounting(u));
    end if;
    v_code := private.enhance_replay(e,u,p,c,a,v_now);
    select usable_until into v_until from private.image_enhancements where owner_id=p_owner_id and request_id=p_request_id;
    return jsonb_build_object('code',v_code,'replayed',true,'accounting',private.ai_accounting(u),
      'usableUntilMs',case when v_code='OK' then floor(extract(epoch from v_until)*1000)::bigint end);
  end if;
  if p_code='NOT_DISPATCHED' then
    if u.charge_state='held' then
      update private.ai_usage set charge_state='estimated',closed_reason='UNAVAILABLE',closed_at=v_now
        where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    end if;
    update private.ai_usage_evidence set enhance_code='NOT_DISPATCHED',enhance_settlement_origin='non_dispatch',
      enhance_settlement_digest=v_digest,anomaly=false
      where owner_id=p_owner_id and request_id=p_request_id;
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
      update private.enhancement_probe_authorisations set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
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
      update private.enhancement_probe_authorisations set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
    return jsonb_build_object('code',p_code,'accounting',private.ai_accounting(u));
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  select * into o from private.enhance_azure_usage(p_usage,m);
  if not o.valid or o.bad or o.over then
    -- An anomaly never settles below the reservation (rev3 §5.2: max(estimate, reservation)).
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
    update private.ai_controls set enhance_activated=false,updated_at=v_now where owner_id=p_owner_id and enhance_activated;
    if a.id is not null and a.stopped_at is null then
      update private.enhancement_probe_authorisations set stopped_at=v_now,
        stopped_reason=case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end where id=a.id;
    end if;
    return jsonb_build_object('code',case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end,
      'accounting',private.ai_accounting(u));
  end if;
  v_code := case when u.closed_reason='EXPIRED' then 'EXPIRED' when p_code<>'OK' then p_code
    when c.enhance_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    when e.enhance_probe_id is not null then private.enhance_probe_permission(p,c,a,v_now)
    else private.enhance_permission(p,c) end;
  update private.ai_usage set charge_state='estimated',accounted_micro=o.estimate,
    closed_reason=case when closed_reason is not null then closed_reason when v_code='OK' then null
      when v_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then 'FAILED' else 'UNAVAILABLE' end,
    closed_at=case when closed_at is not null then closed_at when v_code='OK' then null else v_now end
    where owner_id=p_owner_id and request_id=p_request_id returning * into u;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=o.estimate,anomaly=false,model_observation=o.model,
    enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest,
    provider_refusal=p_refusal_kind
    where owner_id=p_owner_id and request_id=p_request_id;
  if v_code='OK' then
    v_until := v_now+interval '24 hours';
    insert into private.image_enhancements(owner_id,request_id,input_sha256,output_sha256,output_bytes,deployment_key,manifest_id,
        model_id,created_at,usable_until)
      values(p_owner_id,p_request_id,e.enhance_input_sha256,p_output_sha256,p_output_bytes,k.deployment_key,m.id,m.model_id,
        v_now,v_until);
    insert into private.enhancement_outputs(owner_id,output_sha256,output_bytes,model_id,manifest_id,first_request_id,created_at)
      values(p_owner_id,p_output_sha256,p_output_bytes,m.model_id,m.id,p_request_id,v_now)
      on conflict (owner_id,output_sha256,output_bytes) do nothing;
  end if;
  return jsonb_build_object('code',v_code,'accounting',private.ai_accounting(u),
    'usableUntilMs',case when v_code='OK' then floor(extract(epoch from v_until)*1000)::bigint end);
end;
$$;

revoke all on function public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean,text,boolean),public.enhance_finish(uuid,uuid,text,jsonb,text,integer,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean,text,boolean),public.enhance_finish(uuid,uuid,text,jsonb,text,integer,text,boolean) to service_role;

-- Postconditions: the old signatures are gone, the new ones keep the properties, owner and grants.
do $$
begin
  if to_regprocedure('public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean)') is not null or to_regprocedure('public.enhance_finish(uuid,uuid,text,jsonb,text,integer)') is not null then
    raise exception 'FILT1 postcondition: an old finish signature remains';
  end if;
  if exists(select 1 from pg_catalog.pg_constraint where conrelid='private.ai_usage_evidence'::regclass
      and conname in ('ai_usage_evidence_refusal_kind','ai_usage_evidence_refusal_filtered','ai_usage_evidence_usage_absent',
        'ai_usage_evidence_filtered_unmetered','ai_usage_evidence_enhance_settlement_origin_check',
        'ai_usage_evidence_enhance_digest') and not convalidated) then
    raise exception 'FILT1 postcondition: a constraint is not validated';
  end if;
end;
$$;
do $$
declare f regprocedure; p pg_catalog.pg_proc;
begin
  foreach f in array array['public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean,text,boolean)','public.enhance_finish(uuid,uuid,text,jsonb,text,integer,text,boolean)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=f;
    if not p.prosecdef or p.prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
      or (select array_agg(x order by x) from unnest(p.proconfig) x) is distinct from array['lock_timeout=2s','search_path=""']
      or p.proowner is distinct from (select proowner from pg_catalog.pg_proc where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)'::regprocedure)
      or p.proacl is null or not has_function_privilege('service_role',f,'EXECUTE')
      or exists(select 1 from aclexplode(p.proacl) x where x.privilege_type='EXECUTE'
        and x.grantee not in (p.proowner,'service_role'::regrole)) then
      raise exception 'FILT1 postcondition: % properties not as expected',f;
    end if;
  end loop;
end;
$$;

commit;
