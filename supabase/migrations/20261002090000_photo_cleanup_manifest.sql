-- BG2c-1: inactive photo clean-up manifest (issue #84; plan rev4, approved on #84 c5876588292; ADR26 note).
-- Nothing dispatches: no owner has enhance_activated and the provider kill switch is unchanged. Classification:
--   additive: the cleanup-v1 manifest row, its deployment row on the SAME deployment key as enhance-v1 (one shared
--     provider_capacity row: the same slots and the same kill switch) and the ai_controls notice-floor constraint;
--   NON-ADDITIVE (function replacement): public.enhance_claim. Its body is byte-identical to 20260929090000 except the
--     one admitted manifest literal, enhance-v1 -> cleanup-v1. New enhance-v1 claims (ordinary and probe) return
--     UNCONFIGURED; held or finished enhance-v1 rows still settle, expire, account and restore (enhance_finish,
--     enhance_expire, enhance_replay, provenance, export and restore do not name the manifest). A settlement never
--     releases a capacity slot: it stays occupied until held_until (claim + 5 s + window).
-- No consent is copied: enhance_permission already requires enhance_consent_revision = enhance_notice_revision, so a
-- revision-1 consent under notice 2 is CONSENT_REQUIRED.
begin;

-- The same model, rates, currency, limits, reservation and review expiry as enhance-v1; new prompt and settings hashes.
insert into private.ai_execution_manifests values (
  'azure-global-image25-sunburst-cleanup-v1','gpt-image-2.5-sunburst',2,
  '2c909f6b4c7446df89d45400aff2cffab01f384c4e4eca6e6b60ecea9453bd86',
  '20cefa4d2f2fd2c381ac50f30af286f48ea804d9e6fb6d58ca5c5dbd45fa8efe',
  '9c17e7051bbca456745869b23eebe20dd7ed104d05780de527260860859c21e4',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/images/edits','Global','GlobalStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-27T00:00:00Z',
  'INACTIVE photo clean-up (BG2c) on existing DEV/TEST eval-image25-sunburst-20260908 (GlobalStandard, 2 requests/min, the same capacity as enhance-v1). Retail API USD per1M: text input 5.00, image input 8.00, image output 30.00. Reservation 300000 micro values the 7500 input/8000 output envelope with all input at image-in 8.00; the images API has no token cap, so this is an estimated envelope with possible in-flight overrun, handled by the anomaly kill switch. Frozen parameters n1 1024x1280 medium jpeg compression85 opaque, no input_fidelity. Prompt v2 isolates the one middle garment on a plain background. Input: the original unmasked pixels of the accepted crop, reframed locally and re-encoded by the app; background people and objects can be included. Global processing may happen outside the EU. Notice revision 2 or later. Probe and paid activation remain owner gates.',
  'USD',800,3000,7500,8000,300000,512000,1600,4194304,512000,85,'2027-01-01T00:00:00Z'
);
insert into private.provider_deployments values('azure-global-image25-sunburst-cleanup-v1',
  'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08');

-- Server-enforced notice floor. The explicit "is not null" matters: a NULL revision would otherwise make the check NULL,
-- which Postgres accepts. Rows with a NULL or enhance-v1 manifest are unaffected.
alter table private.ai_controls add constraint ai_controls_cleanup_notice check (
  enhance_manifest_id is distinct from 'azure-global-image25-sunburst-cleanup-v1'
  or (enhance_notice_revision is not null and enhance_notice_revision >= 2));

-- Claim (R1, M2, N3). Lock order: approved account (share, nowait) -> profile -> controls -> probe authorisation ->
-- shared capacity (waits up to lock_timeout) -> new rows. Only the Edge function calls this, with the owner verified
-- by /auth/v1/user. A slot is held until the latest permitted dispatch plus the window and is never released early.
create or replace function public.enhance_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_input_sha256 text,p_probe_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.enhancement_probe_authorisations; k private.provider_capacity;
  m private.ai_execution_manifests; v_now timestamptz; v_code text; s record; v_period text; v_slot uuid;
  v_calls bigint; v_spent numeric;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if p_probe_id is not null then
      select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id for update nowait;
    end if;
    select x.* into k from private.provider_capacity x join private.provider_deployments d on d.deployment_key=x.deployment_key
      where d.manifest_id=p_manifest_id for update of x;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  -- Outstanding work expires before the permission decision: it can stop this probe authorisation (MISSING_USAGE),
  -- so the already-locked authorisation is reloaded before it is judged.
  perform private.enhance_expire(p.owner_id,v_now,100);
  if p_probe_id is not null then
    select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id;
  end if;
  v_code := case when p_probe_id is null then private.enhance_permission(p,c) else private.enhance_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null or p_input_sha256 is null or p_input_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-cleanup-v1' or m.review_expires_at<=v_now or k.deployment_key is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.enhance_manifest_id<>m.id or (a.id is not null and a.deployment_key<>k.deployment_key) then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if c.enhance_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  select * into s from private.enhance_usage(p.owner_id,v_now);
  if s.enhance_micro+c.enhance_max_request_micro>c.enhance_monthly_allowance_micro
    or s.total_micro+c.enhance_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.enhance_probe_id=a.id;
    if v_calls>=a.max_calls or v_spent+c.enhance_max_request_micro>a.allocation_micro then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
  end if;
  if s.enhance_hour>=c.enhance_max_requests_per_hour or s.total_hour>=c.max_requests_per_hour then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  v_slot := gen_random_uuid();
  insert into private.provider_slots(slot_id,deployment_key,held_until)
    values(v_slot,k.deployment_key,v_now+interval '5 seconds'+make_interval(secs=>k.window_seconds));
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,
      purpose,provider_slot_id)
    values(p.owner_id,p_request_id,v_period,v_now,c.enhance_max_request_micro,c.enhance_max_request_micro,'held',v_now,
      'enhancement',v_slot);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,enhance_input_sha256,enhance_probe_id)
    values(p.owner_id,p_request_id,m.id,'not_observed',p_input_sha256,a.id);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '5 seconds')*1000)::bigint,'requestSeconds',m.request_seconds);
end;
$$;

revoke all on function public.enhance_claim(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.enhance_claim(uuid,uuid,text,text,uuid) to service_role;

commit;
