-- VTO-1: inactive virtual try-on backend (issue #84; plan rev4 with the critic's binding amendments; ADR28).
-- Nothing dispatches: no owner has tryon_activated or try-on configuration, the shared provider switch is unchanged
-- (off since M8) and 20261003090100 schedules only expiry and cleanup. Classification:
--   additive: four private tables, evidence/controls/usage columns, the manifest row and new functions;
--   behaviour-changing: try-on rows share private.ai_usage, so tagging, stylist and enhancement admission count them,
--     and they share the enhancement deployment's capacity slots and switch;
--   NON-ADDITIVE: the purpose, slot and enhancement-settlement checks are widened, a guard trigger on
--     private.ai_usage_evidence, a BEFORE UPDATE clamp on private.ai_controls, admin_set_ai_limits (v1) now refuses a
--     shared total below a configured try-on sub-limit, and deletion_owner_rows_absent gains the four tables.
-- Lock order (extends BG2b-1 and AD1): approved account (share) -> profile -> ai_controls -> probe authorisation ->
--   chain -> attempt -> result slot -> provider_capacity -> ai_usage -> ai_usage_evidence. Withdrawal and Stop take
--   the same prefix. Accounting truth is ai_usage + evidence; chains and attempts are workflow state only.
-- Privacy: no body-photo byte or hash is stored (enhance_input_sha256 stays null for try-on); only the final picture is
--   kept, owner-only, for 7 days of access. Chains keep the latest intermediate's hash only while running.
begin;

-- Shared ledger. Try-on rows name their chain and step; the provider slot rule now covers both image features.
alter table private.ai_usage drop constraint ai_usage_purpose_check;
alter table private.ai_usage add constraint ai_usage_purpose_check
  check (purpose in ('analysis','stylist','enhancement','try_on'));
alter table private.ai_usage drop constraint ai_usage_enhancement_slot;
alter table private.ai_usage add constraint ai_usage_provider_slot
  check ((purpose in ('enhancement','try_on')) = (provider_slot_id is not null));
alter table private.ai_usage
  add column tryon_chain_id uuid,
  add column tryon_step smallint check (tryon_step between 1 and 3),
  add constraint ai_usage_tryon_chain check ((purpose='try_on') = (tryon_chain_id is not null)
    and (tryon_chain_id is null) = (tryon_step is null));
-- Serves per-owner expiry and the global stale-purge safeguard (held longer than 10 minutes).
create index ai_usage_tryon_held on private.ai_usage(dispatched_at,owner_id)
  where purpose='try_on' and charge_state='held';

-- D1-D3 durable evidence. The enhancement settlement columns are reused (code, origin, digest); try-on adds its own
-- dispatch cutoff, the once-only dispatch authorisation, its probe id and the finish observations.
alter table private.ai_usage_evidence
  drop constraint ai_usage_evidence_enhance_code_check,
  drop constraint ai_usage_evidence_enhance_settlement_origin_check,
  drop constraint ai_usage_evidence_enhance_digest,
  drop constraint ai_usage_evidence_enhance_input;
alter table private.ai_usage_evidence
  add column tryon_dispatch_before timestamptz,
  add column tryon_dispatch_authorised_at timestamptz,
  add column tryon_probe_id uuid,
  add column tryon_fetch_started boolean,
  add column tryon_client_live_at_fetch boolean,
  add column tryon_client_gone_at_finish boolean,
  add column tryon_settled_at timestamptz,
  add constraint ai_usage_evidence_enhance_code_check check (enhance_code in
    ('OK','FAILED','FILTERED','OUTPUT_REJECTED','NOT_DISPATCHED','EXPIRED','PRE_DISPATCH')),
  add constraint ai_usage_evidence_enhance_settlement_origin_check check (enhance_settlement_origin in
    ('provisional_expiry','observed','unmetered','terminal_anomaly','non_dispatch','pre_dispatch')),
  add constraint ai_usage_evidence_enhance_digest check
    ((enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch','pre_dispatch'))
      is not distinct from (enhance_settlement_digest is not null)
      or (enhance_settlement_origin is null and enhance_settlement_digest is null)),
  add constraint ai_usage_evidence_enhance_input check (enhance_code is null or enhance_input_sha256 is not null
    or tryon_dispatch_before is not null),
  add constraint ai_usage_evidence_tryon_columns check (tryon_dispatch_before is not null
    or (tryon_dispatch_authorised_at is null and tryon_probe_id is null and tryon_fetch_started is null
      and tryon_client_live_at_fetch is null and tryon_client_gone_at_finish is null and tryon_settled_at is null)),
  add constraint ai_usage_evidence_tryon_scope check (tryon_dispatch_before is null
    or (enhance_input_sha256 is null and enhance_probe_id is null and stylist_code is null)),
  add constraint ai_usage_evidence_tryon_authorised check (tryon_dispatch_authorised_at is null
    or tryon_dispatch_authorised_at <= tryon_dispatch_before),
  add constraint ai_usage_evidence_tryon_fetch check (tryon_fetch_started is not true
    or tryon_dispatch_authorised_at is not null),
  add constraint ai_usage_evidence_tryon_observed check ((tryon_fetch_started is null) = (tryon_client_gone_at_finish is null)
    and (tryon_client_live_at_fetch is null or tryon_fetch_started)
    and (not coalesce(tryon_fetch_started,false) or tryon_client_live_at_fetch is not null)
    and (tryon_fetch_started is null or tryon_settled_at is not null)),
  add constraint ai_usage_evidence_pre_dispatch check ((enhance_code is distinct from 'PRE_DISPATCH'
      and enhance_settlement_origin is distinct from 'pre_dispatch') or tryon_dispatch_before is not null);

-- D1: the cutoff, the probe id and a set authorisation never change; the finish observations are set once. Inserts
-- must match the ledger row's purpose. Deletion (account deletion only) is unaffected.
create function private.tryon_evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_purpose text;
begin
  if tg_op='INSERT' then
    select purpose into v_purpose from private.ai_usage where owner_id=new.owner_id and request_id=new.request_id;
    if (v_purpose='try_on') <> (new.tryon_dispatch_before is not null)
      or (new.tryon_dispatch_before is not null and (new.tryon_dispatch_authorised_at is not null
        or new.tryon_fetch_started is not null or new.tryon_settled_at is not null)) then
      raise exception using errcode='23514',message='Try-on evidence not valid';
    end if;
    return new;
  end if;
  if new.tryon_dispatch_before is distinct from old.tryon_dispatch_before
    or new.tryon_probe_id is distinct from old.tryon_probe_id
    or (old.tryon_dispatch_authorised_at is not null
      and new.tryon_dispatch_authorised_at is distinct from old.tryon_dispatch_authorised_at)
    or (old.tryon_fetch_started is not null and new.tryon_fetch_started is distinct from old.tryon_fetch_started)
    or (old.tryon_client_live_at_fetch is not null
      and new.tryon_client_live_at_fetch is distinct from old.tryon_client_live_at_fetch)
    or (old.tryon_client_gone_at_finish is not null
      and new.tryon_client_gone_at_finish is distinct from old.tryon_client_gone_at_finish)
    or (old.tryon_settled_at is not null and new.tryon_settled_at is distinct from old.tryon_settled_at) then
    raise exception using errcode='42501',message='Try-on evidence is immutable';
  end if;
  return new;
end;
$$;
create trigger ai_usage_evidence_tryon_guard before insert or update on private.ai_usage_evidence
for each row execute function private.tryon_evidence_guard();

alter table private.ai_controls
  add column tryon_activated boolean not null default false,
  add column tryon_notice_revision integer check (tryon_notice_revision between 1 and 2147483647),
  add column tryon_manifest_id text references private.ai_execution_manifests(id),
  add column tryon_max_request_micro bigint check (tryon_max_request_micro > 0),
  add column tryon_monthly_allowance_micro bigint check (tryon_monthly_allowance_micro > 0),
  add column tryon_max_requests_per_hour integer check (tryon_max_requests_per_hour between 1 and 1000),
  add column tryon_consent_revision integer check (tryon_consent_revision between 1 and 2147483647),
  add column tryon_consented_at timestamptz,
  add constraint ai_controls_tryon_settings check (not tryon_activated or (tryon_notice_revision is not null
    and tryon_manifest_id is not null and tryon_max_request_micro is not null
    and tryon_monthly_allowance_micro is not null and tryon_max_requests_per_hour is not null)),
  add constraint ai_controls_tryon_consent_pair check ((tryon_consent_revision is null) = (tryon_consented_at is null)),
  add constraint ai_controls_tryon_allowance check (tryon_monthly_allowance_micro is null
    or tryon_monthly_allowance_micro <= monthly_allowance_micro);

-- The enhancement clamp pattern: a lowered shared total pulls the try-on sub-limit down in the same row update. The
-- admin v1 write refuses that case instead (it cannot show try-on), so only other writers reach this clamp.
create function private.tryon_allowance_clamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tryon_monthly_allowance_micro is not null and new.tryon_monthly_allowance_micro>new.monthly_allowance_micro then
    new.tryon_monthly_allowance_micro := new.monthly_allowance_micro;
  end if;
  return new;
end;
$$;
create trigger ai_controls_tryon_clamp before update of monthly_allowance_micro on private.ai_controls
for each row execute function private.tryon_allowance_clamp();

-- Retail Image-2.5-sunburst Global (USD per 1M tokens): text in 5.00, image in 8.00, image out 30.00. The reservation
-- values the 15,000 total input / 8,000 output envelope with all input at image-in: an estimated envelope, not a ceiling.
insert into private.ai_execution_manifests values (
  'azure-global-image25-sunburst-tryon-v1','gpt-image-2.5-sunburst',1,
  '4e51a18efc0c3a4ec5ee9b86cd613fa9628974c47d49a42f7e32c6cad58e7975',
  '20cefa4d2f2fd2c381ac50f30af286f48ea804d9e6fb6d58ca5c5dbd45fa8efe',
  '1ebcd10b4af07c07c414c3eff88022967403b8b5615cd8605a569e721158825b',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/images/edits','Global','GlobalStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-27T00:00:00Z',
  'INACTIVE virtual try-on on existing DEV/TEST eval-image25-sunburst-20260908 (GlobalStandard, 2 requests/min shared with photo enhancement). Retail API USD per1M: text input 5.00, image input 8.00, image output 30.00. Reservation 360000 micro per garment step values the 15000 total input (prompt plus person and garment images)/8000 output envelope with all input at image-in 8.00; the images API has no token cap, so this is an estimated envelope with possible in-flight overrun, handled by the anomaly kill switch. One garment per call, at most 3 chained steps. Frozen parameters n1 1024x1280 medium jpeg compression85 opaque, no input_fidelity. The body photo is sent as is and never stored; Global processing may happen outside the EU. Bootstrap, probe and activation remain owner gates.',
  'USD',800,3000,15000,8000,360000,512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'
);
insert into private.provider_deployments values('azure-global-image25-sunburst-tryon-v1',
  'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08');

-- Workflow state (§3.1, §5.1). Private, RLS on, written only by the definer functions below. None of these rows is
-- accounting truth: ai_usage and its evidence have no foreign key to them and outlive them.
create table private.tryon_chains (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  chain_id uuid not null,
  outfit_id uuid not null,
  steps jsonb not null check (jsonb_typeof(steps)='array' and jsonb_array_length(steps) between 1 and 3),
  state text not null check (state in ('running','complete','cancelled','withdrawn','expired','stale')),
  next_step smallint not null check (next_step between 1 and 4),
  active_request_id uuid,
  last_output_sha256 text check (last_output_sha256 ~ '^[0-9a-f]{64}$'),
  last_output_bytes integer check (last_output_bytes between 1 and 512000),
  result_id uuid not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('COMPLETE','CANCELLED','WITHDRAWN','EXPIRED','CHAIN_MISMATCH','DISCARDED')),
  primary key(owner_id,chain_id),
  unique(owner_id,chain_id,result_id),
  foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete cascade,
  check (expires_at = created_at + interval '30 minutes'),
  check ((state='running') = (ended_at is null) and (ended_at is null) = (end_reason is null)),
  check (state='running' or (active_request_id is null and last_output_sha256 is null and last_output_bytes is null)),
  check ((last_output_sha256 is null) = (last_output_bytes is null))
);
create index tryon_chains_state on private.tryon_chains(state,expires_at);
create index tryon_chains_ended on private.tryon_chains(ended_at) where state<>'running';
create table private.tryon_attempts (
  owner_id uuid not null,
  request_id uuid not null,
  chain_id uuid not null,
  step smallint not null check (step between 1 and 3),
  state text not null check (state in ('claimed','dispatched','accepted','failed','released','expired','late')),
  dispatch_before timestamptz not null,
  created_at timestamptz not null,
  closed_at timestamptz,
  primary key(owner_id,request_id),
  foreign key(owner_id,chain_id) references private.tryon_chains(owner_id,chain_id) on delete cascade,
  check ((state in ('claimed','dispatched')) = (closed_at is null)),
  check (dispatch_before > created_at and dispatch_before <= created_at + interval '15 seconds')
);
create index tryon_attempts_state on private.tryon_attempts(state,created_at);
create index tryon_attempts_chain on private.tryon_attempts(owner_id,chain_id);
alter table private.tryon_chains add constraint tryon_chains_active foreign key(owner_id,active_request_id)
  references private.tryon_attempts(owner_id,request_id) deferrable initially deferred;
-- Results outlive their chain (no chain FK); an outfit deletion removes them.
create table private.tryon_results (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  result_id uuid not null,
  chain_id uuid not null,
  outfit_id uuid not null,
  state text not null check (state in ('reserved','ready')),
  item_ids uuid[] not null check (cardinality(item_ids) between 1 and 3),
  jpeg bytea check (octet_length(jpeg) between 1 and 512000),
  created_at timestamptz not null,
  completed_at timestamptz,
  expires_at timestamptz,
  primary key(owner_id,result_id),
  unique(owner_id,chain_id),
  foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete cascade,
  check ((state='ready') = (jpeg is not null) and (jpeg is null) = (completed_at is null)
    and (completed_at is null) = (expires_at is null)),
  check (expires_at is null or expires_at = completed_at + interval '7 days')
);
create index tryon_results_expiry on private.tryon_results(expires_at) where state='ready';
create index tryon_results_owner on private.tryon_results(owner_id,state);
-- N3 copy for try-on, at most five calls (the §11 probe needs four).
create table private.tryon_probe_authorisations (
  id uuid primary key,
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  deployment_key text not null references private.provider_capacity(deployment_key),
  manifest_id text not null references private.ai_execution_manifests(id),
  max_calls integer not null check (max_calls between 1 and 5),
  allocation_micro bigint not null check (allocation_micro > 0),
  approval_ref text not null unique check (approval_ref ~ '^[A-Za-z0-9._:/#-]{1,200}$'),
  expires_at timestamptz not null,
  stopped_at timestamptz,
  stopped_reason text check (stopped_reason in ('MISSING_USAGE','INVALID_USAGE','USAGE_ANOMALY','EXPIRED','OPERATOR')),
  created_at timestamptz not null,
  unique(owner_id,id),
  check ((stopped_at is null) = (stopped_reason is null)),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
alter table private.tryon_chains enable row level security;
alter table private.tryon_attempts enable row level security;
alter table private.tryon_results enable row level security;
alter table private.tryon_probe_authorisations enable row level security;
revoke all on private.tryon_chains,private.tryon_attempts,private.tryon_results,private.tryon_probe_authorisations
  from public,anon,authenticated,service_role;

-- §3.7 ordinary permission. The shared provider switch is checked separately by the claim and the mark (UNAVAILABLE).
create function private.tryon_permission(p_profile public.profiles,p_controls private.ai_controls,p_now timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.tryon_manifest_id is null then 'UNCONFIGURED'
    when not p_controls.tryon_activated then 'INACTIVE'
    when p_controls.tryon_consent_revision is distinct from p_controls.tryon_notice_revision then 'CONSENT_REQUIRED'
    when not exists(select 1 from private.ai_execution_manifests m where m.id=p_controls.tryon_manifest_id
      and m.review_expires_at>p_now) then 'UNCONFIGURED'
    else 'OK' end;
$$;

-- §3.7 probe permission: the stored authorisation replaces activation and consent, and it is refused while the
-- ordinary path is fully on, so a probe row can never be an ordinary one and the reverse.
create function private.tryon_probe_permission(p_profile public.profiles,p_controls private.ai_controls,
  p_auth private.tryon_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.tryon_manifest_id is null or p_controls.tryon_max_request_micro is null
      or p_controls.tryon_monthly_allowance_micro is null or p_controls.tryon_max_requests_per_hour is null then 'UNCONFIGURED'
    when not exists(select 1 from private.ai_execution_manifests m where m.id=p_controls.tryon_manifest_id
      and m.review_expires_at>p_now) then 'UNCONFIGURED'
    when p_auth.id is null or p_auth.owner_id<>p_profile.owner_id or p_auth.stopped_at is not null
      or p_auth.expires_at<=p_now or p_auth.manifest_id<>p_controls.tryon_manifest_id
      or p_auth.deployment_key is distinct from (select d.deployment_key from private.provider_deployments d
        where d.manifest_id=p_controls.tryon_manifest_id) then 'INACTIVE'
    when p_controls.tryon_activated and p_controls.tryon_consent_revision is not distinct from p_controls.tryon_notice_revision
      then 'INACTIVE'
    else 'OK' end;
$$;

create function private.tryon_usage(p_owner uuid,p_now timestamptz,
  out tryon_micro numeric,out total_micro numeric,out tryon_hour bigint,out total_hour bigint)
language sql stable set search_path = '' as $$
  select coalesce(sum(accounted_micro) filter (where purpose='try_on' and (period=to_char(p_now at time zone 'UTC','YYYY-MM')
      or charge_state in ('reserved','held'))),0),
    coalesce(sum(accounted_micro) filter (where period=to_char(p_now at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held')),0),
    count(*) filter (where purpose='try_on' and created_at>p_now-interval '1 hour'),
    count(*) filter (where created_at>p_now-interval '1 hour')
  from private.ai_usage where owner_id=p_owner;
$$;

-- D4: the frozen association still holds, with no substitution. The item is the owner's, active and not deleted, not
-- claimed or fenced for deletion, the account is not being deleted, and the image is its ready one with the same bytes.
create function private.tryon_garment_current(p_owner uuid,p_item uuid,p_image uuid,p_sha text,p_bytes integer)
returns boolean language sql stable set search_path = '' as $$
  select exists(select 1 from public.items i join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id
      where i.owner_id=p_owner and i.id=p_item and i.lifecycle='active' and i.deleted_at is null
        and im.id=p_image and im.state='ready' and im.main_sha256=p_sha and im.main_bytes=p_bytes)
    and not exists(select 1 from private.item_deletion_claims d where d.owner_id=p_owner and d.item_id=p_item)
    and not exists(select 1 from private.item_deletion_operations o where o.owner_id=p_owner and o.item_id=p_item
      and o.phase<>'cancelled')
    and not exists(select 1 from private.deletion_jobs j where j.owner_id=p_owner and j.stage<>'complete');
$$;

-- §3.6 accounting expiry, driven only by held try-on usage and its durable evidence. An authorised row three minutes
-- after its authorisation is estimated at the reservation (missing usage stops a probe); an unauthorised row past its
-- cutoff is released, because the mark refuses after the cutoff. Attempts and chains are touched only if they exist.
-- The caller holds the owner's profile and controls, which serialise every writer of this owner's try-on rows.
create function private.tryon_expire_accounting(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer := 0; m integer; v_ids uuid[];
begin
  update private.tryon_probe_authorisations a set stopped_at=p_now,stopped_reason='MISSING_USAGE'
    where a.owner_id=p_owner and a.stopped_at is null and a.id in (
      select e.tryon_probe_id from private.ai_usage u join private.ai_usage_evidence e
        on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p_owner and u.purpose='try_on' and u.charge_state='held' and e.tryon_probe_id is not null
        and e.tryon_dispatch_authorised_at<=p_now-interval '3 minutes');
  with due as (
    select u.request_id from private.ai_usage u join private.ai_usage_evidence e
        on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p_owner and u.purpose='try_on' and u.charge_state='held'
        and e.tryon_dispatch_authorised_at<=p_now-interval '3 minutes'
      order by u.dispatched_at,u.request_id limit least(greatest(coalesce(p_limit,0),0),100) for update of u
  ), closed as (
    update private.ai_usage u set charge_state='estimated',accounted_micro=u.reserved_micro,closed_reason='EXPIRED',closed_at=p_now
      from due where u.owner_id=p_owner and u.request_id=due.request_id returning u.request_id
  ), marked as (
    update private.ai_usage_evidence e set anomaly=true,enhance_code='EXPIRED',enhance_settlement_origin='provisional_expiry',
      tryon_settled_at=coalesce(e.tryon_settled_at,p_now)
      from closed where e.owner_id=p_owner and e.request_id=closed.request_id returning e.request_id
  )
  select array_agg(request_id) into v_ids from marked;
  n := coalesce(cardinality(v_ids),0);
  with due as (
    select u.request_id from private.ai_usage u join private.ai_usage_evidence e
        on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p_owner and u.purpose='try_on' and u.charge_state='held'
        and e.tryon_dispatch_authorised_at is null and e.tryon_dispatch_before<p_now
      order by u.dispatched_at,u.request_id limit least(greatest(coalesce(p_limit,0)-n,0),100) for update of u
  ), closed as (
    update private.ai_usage u set charge_state='released',accounted_micro=0,dispatched_at=null,closed_reason='EXPIRED',closed_at=p_now
      from due where u.owner_id=p_owner and u.request_id=due.request_id returning u.request_id
  ), marked as (
    update private.ai_usage_evidence e set enhance_code='EXPIRED',enhance_settlement_origin='provisional_expiry',
      tryon_settled_at=coalesce(e.tryon_settled_at,p_now)
      from closed where e.owner_id=p_owner and e.request_id=closed.request_id returning e.request_id
  )
  select coalesce(v_ids,'{}')||coalesce(array_agg(request_id),'{}') into v_ids from marked;
  m := coalesce(cardinality(v_ids),0);
  if m>0 then
    update private.tryon_chains c set active_request_id=null
      where c.owner_id=p_owner and c.active_request_id=any(v_ids);
    update private.tryon_attempts t set state='expired',closed_at=p_now
      where t.owner_id=p_owner and t.request_id=any(v_ids) and t.state in ('claimed','dispatched');
  end if;
  return m;
end;
$$;

-- A chain leaves running: its open attempt settles as late (accounting is unaffected), the reserved result slot is
-- freed and the intermediate hash is dropped. Completed results are never touched here.
create function private.tryon_end_chain(p_owner uuid,p_chain uuid,p_state text,p_reason text,p_now timestamptz)
returns void language plpgsql volatile set search_path = '' as $$
begin
  update private.tryon_attempts set state='late',closed_at=p_now
    where owner_id=p_owner and chain_id=p_chain and state in ('claimed','dispatched');
  update private.tryon_chains set state=p_state,active_request_id=null,last_output_sha256=null,last_output_bytes=null,
      ended_at=p_now,end_reason=p_reason
    where owner_id=p_owner and chain_id=p_chain and state='running';
  delete from private.tryon_results where owner_id=p_owner and chain_id=p_chain and state='reserved';
end;
$$;

-- Accounting first, then chains past their 30 minutes. The caller holds the owner's profile and controls.
create function private.tryon_expire_owner(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer; v_chain uuid;
begin
  n := private.tryon_expire_accounting(p_owner,p_now,p_limit);
  for v_chain in select chain_id from private.tryon_chains where owner_id=p_owner and state='running' and expires_at<=p_now
    order by chain_id for update
  loop
    perform private.tryon_end_chain(p_owner,v_chain,'expired','EXPIRED',p_now);
  end loop;
  return n;
end;
$$;

-- §5.2 safeguard: a stalled purge or stranded accounting anywhere stops new chains (not running ones).
create function private.tryon_purge_overdue(p_now timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select exists(select 1 from private.tryon_results where state='ready' and expires_at<p_now-interval '2 hours')
    or exists(select 1 from private.ai_usage where purpose='try_on' and charge_state='held'
      and dispatched_at<p_now-interval '10 minutes');
$$;

-- The SQL copy of selectTryOnSteps (src/domain/tryon.ts): saved order, active and not deleted, one ready image.
create function private.tryon_select_steps(p_owner uuid,p_outfit uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := '[]'::jsonb; r record; v_slots text[];
begin
  if exists(select 1 from public.outfit_items oi join public.items i on i.owner_id=oi.owner_id and i.id=oi.item_id
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready'
      where oi.owner_id=p_owner and oi.outfit_id=p_outfit and i.category='one_piece' and i.lifecycle='active'
        and i.deleted_at is null) then
    v_slots := array['one_piece','footwear'];
  else
    v_slots := array['top','bottom','footwear'];
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

-- Owner status. Capacity is a boolean for the shared deployment only; results are this owner's own counts.
create function public.tryon_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); s record; v_policy jsonb := null;
  v_available boolean := false; v_results bigint; v_code text;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.tryon_expire_owner(p.owner_id,v_now,100); end if;
  select * into s from private.tryon_usage(p.owner_id,v_now);
  select count(*) into v_results from private.tryon_results where owner_id=p.owner_id
    and (state='reserved' or expires_at>v_now);
  if c.owner_id is not null and c.tryon_manifest_id is not null then
    select k.dispatch_enabled into v_available from private.provider_deployments d
      join private.provider_capacity k on k.deployment_key=d.deployment_key where d.manifest_id=c.tryon_manifest_id;
    v_policy := jsonb_build_object('activated',c.tryon_activated,'noticeRevision',c.tryon_notice_revision,
      'manifestId',c.tryon_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.tryon_manifest_id),
      'maxRequestMicro',c.tryon_max_request_micro::text,'tryOnAllowanceMicro',c.tryon_monthly_allowance_micro::text,
      'totalAllowanceMicro',c.monthly_allowance_micro::text,'maxRequestsPerHour',c.tryon_max_requests_per_hour,
      'maxSteps',3,'maxResults',20,'resultDays',7,'providerAvailable',coalesce(v_available,false));
  end if;
  v_code := private.tryon_permission(p,c,v_now);
  return jsonb_build_object('code',v_code,'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.tryon_consent_revision is not null,'noticeRevision',c.tryon_consent_revision,
      'consentedAt',c.tryon_consented_at),
    'policy',v_policy,'results',v_results,
    'usage',jsonb_build_object('tryOnMicro',s.tryon_micro::text,'totalMicro',s.total_micro::text,'tryOnLastHour',s.tryon_hour,
      'warning',coalesce(v_policy is not null and (s.tryon_micro>=0.8*c.tryon_monthly_allowance_micro
        or s.total_micro>=0.8*c.monthly_allowance_micro),false)));
end;
$$;

-- Separate try-on consent. Withdrawal is accepted whenever controls exist, activated or not, and in the same
-- transaction ends every running chain as withdrawn: later claims and marks refuse, and a late finish never publishes.
create function public.tryon_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_chain uuid;
begin
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.tryon_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.tryon_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set tryon_consent_revision=p_notice_revision,tryon_consented_at=v_now,updated_at=v_now
      where owner_id=p.owner_id;
  else
    for v_chain in select chain_id from private.tryon_chains where owner_id=p.owner_id and state='running'
      order by chain_id for update
    loop
      perform private.tryon_end_chain(p.owner_id,v_chain,'withdrawn','WITHDRAWN',v_now);
    end loop;
    update private.ai_controls set tryon_consent_revision=null,tryon_consented_at=null,updated_at=v_now
      where owner_id=p.owner_id;
  end if;
  return public.tryon_status();
end;
$$;

-- §3.2 reconciliation. A foreign or unknown chain is NOT_FOUND alike.
create function public.tryon_chain_status(p_chain_id uuid) returns jsonb
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
    and state='ready' and expires_at>v_now;
  return jsonb_build_object('code','OK','state',t.state,'nextStep',t.next_step,
    'steps',(select jsonb_agg(jsonb_build_object('slot',x->>'slot','itemId',x->>'itemId') order by n)
      from jsonb_array_elements(t.steps) with ordinality s(x,n)),
    'activeAttempt',t.active_request_id is not null,'resultId',v_result,
    'expiresAtMs',floor(extract(epoch from t.expires_at)*1000)::bigint);
end;
$$;

-- D2 Stop. It serialises with the final finish through the profile lock: a running chain is cancelled and its slot
-- freed; a completed chain keeps its result and says so; other terminal states are reported as they are.
create function public.tryon_cancel(p_chain_id uuid) returns jsonb
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
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
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

-- Owner reads filter on the exact 7-day access expiry; they never depend on the purge having run.
create function public.tryon_results_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  return jsonb_build_object('code','OK','results',coalesce((select jsonb_agg(jsonb_build_object('id',r.result_id,
      'outfitId',r.outfit_id,'itemIds',to_jsonb(r.item_ids),'bytes',octet_length(r.jpeg),
      'completedAtMs',floor(extract(epoch from r.completed_at)*1000)::bigint,
      'expiresAtMs',floor(extract(epoch from r.expires_at)*1000)::bigint) order by r.completed_at desc,r.result_id)
    from private.tryon_results r join public.outfits o on o.owner_id=r.owner_id and o.id=r.outfit_id
    where r.owner_id=auth.uid() and r.state='ready' and r.expires_at>v_now and o.deleted_at is null),'[]'::jsonb));
end;
$$;

create function public.tryon_result_image_v1(p_result_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v bytea; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select r.jpeg into v from private.tryon_results r join public.outfits o on o.owner_id=r.owner_id and o.id=r.outfit_id
    where r.owner_id=auth.uid() and r.result_id=p_result_id and r.state='ready' and r.expires_at>v_now and o.deleted_at is null;
  if v is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','OK','jpegBase64',translate(encode(v,'base64'),E'\n',''),'bytes',octet_length(v));
end;
$$;

-- Deletes a finished picture now, expired or not. A reserved slot belongs to a running chain: use Stop instead.
create function public.tryon_delete_result(p_result_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  delete from private.tryon_results where owner_id=p.owner_id and result_id=p_result_id and state='ready';
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','OK');
end;
$$;

-- Closes this attempt's workflow after a non-publishing finish: the chain's active attempt takes p_state (failed or
-- released) and is cleared so Try again can claim a new request ID; any other open attempt becomes late.
create function private.tryon_close_attempt(p_owner uuid,p_request uuid,p_state text,p_now timestamptz)
returns void language plpgsql volatile set search_path = '' as $$
declare v_chain uuid;
begin
  select chain_id into v_chain from private.tryon_chains
    where owner_id=p_owner and active_request_id=p_request and state='running';
  if v_chain is not null then
    update private.tryon_chains set active_request_id=null where owner_id=p_owner and chain_id=v_chain;
    update private.tryon_attempts set state=p_state,closed_at=p_now
      where owner_id=p_owner and request_id=p_request and state in ('claimed','dispatched');
  else
    update private.tryon_attempts set state='late',closed_at=p_now
      where owner_id=p_owner and request_id=p_request and state in ('claimed','dispatched');
  end if;
end;
$$;

-- Claim one step (§3.1, D4). Lock order: approved account (share, nowait) -> profile -> controls -> probe
-- authorisation -> chain (all nowait) -> shared capacity (waits up to lock_timeout) -> new rows. Only the Edge function
-- calls this, with the owner verified by /auth/v1/user. Step 1 creates the chain, freezes its garments and reserves the
-- result slot; a failed step keeps next_step, so Try again claims the same step with a new request ID. No body-photo
-- hash is taken at step 1; later steps bind the previous step's accepted output hash.
create function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
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

-- D1 dispatch authorisation, at most once and never cleared. The probe is derived from the stored evidence and is
-- re-judged, not counted again. Every refusal sets nothing; the Edge then finishes with PRE_DISPATCH (released).
create function public.tryon_dispatch(p_owner_id uuid,p_request_id uuid,p_client_present boolean) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; t private.tryon_chains;
  k private.provider_capacity; u private.ai_usage; e private.ai_usage_evidence; v_probe uuid; v_chain uuid; v_key text;
  v_now timestamptz; v_code text; v_auth timestamptz;
begin
  select x.tryon_probe_id,y.tryon_chain_id,d.deployment_key into v_probe,v_chain,v_key from private.ai_usage_evidence x
    join private.ai_usage y on y.owner_id=x.owner_id and y.request_id=x.request_id
    join private.provider_deployments d on d.manifest_id=x.manifest_id
    where x.owner_id=p_owner_id and x.request_id=p_request_id and y.purpose='try_on';
  if v_chain is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if v_probe is not null then
      select * into a from private.tryon_probe_authorisations where id=v_probe and owner_id=p_owner_id for update nowait;
    end if;
    select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=v_chain for update nowait;
    select * into k from private.provider_capacity where deployment_key=v_key for update;
    select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id for update;
    select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id for update;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY');
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE');
  end;
  v_now := clock_timestamp();
  perform private.tryon_expire_owner(p_owner_id,v_now,100);
  select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id;
  select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id;
  select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=v_chain;
  if v_probe is not null then
    select * into a from private.tryon_probe_authorisations where id=v_probe and owner_id=p_owner_id;
  end if;
  if e.tryon_dispatch_authorised_at is not null then
    return jsonb_build_object('code','ALREADY_AUTHORISED');
  end if;
  if u.charge_state<>'held' then return jsonb_build_object('code','TERMINAL'); end if;
  if clock_timestamp()>=e.tryon_dispatch_before then return jsonb_build_object('code','EXPIRED'); end if;
  if t.chain_id is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  if t.state<>'running' then
    return jsonb_build_object('code',case t.state when 'withdrawn' then 'WITHDRAWN' when 'cancelled' then 'CANCELLED'
      when 'expired' then 'EXPIRED' when 'stale' then 'CHAIN_MISMATCH' else 'TERMINAL' end);
  end if;
  if t.active_request_id is distinct from p_request_id then return jsonb_build_object('code','TERMINAL'); end if;
  if p_client_present is not true then return jsonb_build_object('code','CLIENT_GONE'); end if;
  v_code := case when v_probe is null then private.tryon_permission(p,c,v_now)
    else private.tryon_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  if c.tryon_manifest_id is distinct from e.manifest_id then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_auth := clock_timestamp();
  if v_auth>=e.tryon_dispatch_before then return jsonb_build_object('code','EXPIRED'); end if;
  update private.ai_usage_evidence set tryon_dispatch_authorised_at=v_auth
    where owner_id=p_owner_id and request_id=p_request_id;
  update private.tryon_attempts set state='dispatched' where owner_id=p_owner_id and request_id=p_request_id and state='claimed';
  return jsonb_build_object('code','AUTHORISED','authorisedAtMs',floor(extract(epoch from v_auth)*1000)::bigint,
    'dispatchBeforeMs',floor(extract(epoch from e.tryon_dispatch_before)*1000)::bigint);
end;
$$;

create function private.tryon_replay(e private.ai_usage_evidence,u private.ai_usage) returns text
language sql stable set search_path = '' as $$
  select case
    when e.enhance_settlement_origin='pre_dispatch' then 'PRE_DISPATCH'
    when e.enhance_settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.enhance_settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when e.enhance_settlement_origin='unmetered' and e.enhance_code='PRE_DISPATCH' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='unmetered' then e.enhance_code
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.enhance_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then e.enhance_code
    when exists(select 1 from private.tryon_attempts x where x.owner_id=u.owner_id and x.request_id=u.request_id
      and x.state='accepted') then 'OK'
    when u.closed_reason is not null then 'UNAVAILABLE'
    else 'LATE' end;
$$;

-- Finish (§3.4): idempotent over {code, usage, outputSha256, outputBytes}. Settlement is decided only from the
-- durable evidence (the cutoff and the once-only authorisation), never from attempt or chain rows. Publication happens
-- only for the chain's active attempt on a running chain with the permission still held: an intermediate advances
-- the chain, the last step fills the reserved result slot. Anything else settles accounting and returns without bytes.
-- The fetch and client observations are recorded once, as probe evidence; settlement never depends on them.
create function public.tryon_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,p_output_sha256 text,
  p_output_bytes integer,p_output bytea,p_fetch_started boolean,p_client_live_at_fetch boolean,p_client_gone boolean)
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
  v_digest := encode(sha256(convert_to(jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)::text,'UTF8')),'hex');
  if e.enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch','pre_dispatch') then
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
  if p_usage is null and p_code<>'OK' then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'FAILED'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest
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
      enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',enhance_settlement_digest=v_digest
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
    enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest
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

-- Scheduled expiry and cleanup (20261003090100 schedules it, active: it only expires and deletes). Owners are taken
-- skip-locked in profile order. Cleanup never touches ai_usage or evidence: held usage settles through §3.6 whether its
-- chain exists or not. Terminal chains (hashes already null) go after one day with their attempts; reserved slots with
-- no running chain go at once; probe authorisations 90 days after expiry.
create function public.tryon_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_r integer; v_o integer; v_c integer;
  v_a integer;
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
  return jsonb_build_object('code','OK','expired',n,'resultsPurged',v_r,'slotsPurged',v_o,'chainsPurged',v_c,
    'probesPurged',v_a);
end;
$$;

-- D7 monitoring: overdue counts only, no owner or content. Read by the coordinator in every hosted receipt.
create function public.tryon_purge_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code','OK',
    'overdueResults',(select count(*) from private.tryon_results where state='ready'
      and expires_at<clock_timestamp()-interval '1 hour'),
    'overdueChains',(select count(*) from private.tryon_chains where state<>'running'
      and ended_at<clock_timestamp()-interval '25 hours'),
    'heldUsage',(select count(*) from private.ai_usage where purpose='try_on' and charge_state='held'
      and dispatched_at<clock_timestamp()-interval '10 minutes'),
    'safeguard',private.tryon_purge_overdue(clock_timestamp()));
$$;

-- N3 try-on probe authorisation, service role only, run through the approved operator channel after explicit
-- probe-spend approval. The same rules as enhance_probe_authorise, at most five calls.
create function public.tryon_probe_authorise(p_id uuid,p_owner_id uuid,p_manifest_id text,p_max_calls integer,
  p_allocation_micro bigint,p_approval_ref text,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; s record; v_key text;
  v_now timestamptz := clock_timestamp();
begin
  if p_id is null or p_owner_id is null or p_manifest_id is null or p_max_calls is null or p_max_calls not between 1 and 5
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
  if c.owner_id is null or not c.activated or c.tryon_manifest_id is distinct from p_manifest_id or c.tryon_max_request_micro is null
    or c.tryon_monthly_allowance_micro is null or c.tryon_max_requests_per_hour is null then
    return jsonb_build_object('code','UNCONFIGURED');
  end if;
  select deployment_key into v_key from private.provider_deployments where manifest_id=p_manifest_id;
  if v_key is null or p_expires_at<=v_now or p_expires_at>v_now+interval '7 days'
    or p_allocation_micro<c.tryon_max_request_micro then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  select * into s from private.tryon_usage(p_owner_id,v_now);
  if s.tryon_micro+p_allocation_micro>c.tryon_monthly_allowance_micro or s.total_micro+p_allocation_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','DEFER','tryOnMicro',s.tryon_micro::text,'totalMicro',s.total_micro::text);
  end if;
  insert into private.tryon_probe_authorisations(id,owner_id,deployment_key,manifest_id,max_calls,allocation_micro,
      approval_ref,expires_at,created_at)
    values(p_id,p_owner_id,v_key,p_manifest_id,p_max_calls,p_allocation_micro,p_approval_ref,p_expires_at,v_now);
  return jsonb_build_object('code','OK','replayed',false,'id',p_id,'deploymentKey',v_key);
end;
$$;

-- §7.6 bootstrap of the inactive configuration. Database owner only (no grants). It sets the five fields once, never
-- activation or consent, and enforces the manifest floor and the shared total. Exact replay is OK; any other change
-- after bootstrap goes through the audited admin v2 write.
create function public.tryon_bootstrap(p_owner_id uuid,p_manifest_id text,p_notice_revision integer,
  p_max_request_micro bigint,p_monthly_allowance_micro bigint,p_max_requests_per_hour integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare c private.ai_controls; m private.ai_execution_manifests;
begin
  if p_owner_id is null or p_manifest_id is null or p_notice_revision is null or p_notice_revision<1
    or p_max_request_micro is null or p_monthly_allowance_micro is null or p_max_requests_per_hour is null
    or p_max_requests_per_hour not between 1 and 1000 then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  perform 1 from private.approved_accounts where user_id=p_owner_id for share;
  perform 1 from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v1' then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if c.tryon_manifest_id is not null or c.tryon_notice_revision is not null or c.tryon_max_request_micro is not null
    or c.tryon_monthly_allowance_micro is not null or c.tryon_max_requests_per_hour is not null then
    if c.tryon_manifest_id=p_manifest_id and c.tryon_notice_revision=p_notice_revision
      and c.tryon_max_request_micro=p_max_request_micro and c.tryon_monthly_allowance_micro=p_monthly_allowance_micro
      and c.tryon_max_requests_per_hour=p_max_requests_per_hour then
      return jsonb_build_object('code','OK','replayed',true);
    end if;
    return jsonb_build_object('code','CONFLICT');
  end if;
  if p_max_request_micro<m.reservation_micro or p_monthly_allowance_micro<p_max_request_micro
    or p_monthly_allowance_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','INVALID_LIMITS');
  end if;
  update private.ai_controls set tryon_manifest_id=p_manifest_id,tryon_notice_revision=p_notice_revision,
    tryon_max_request_micro=p_max_request_micro,tryon_monthly_allowance_micro=p_monthly_allowance_micro,
    tryon_max_requests_per_hour=p_max_requests_per_hour,updated_at=clock_timestamp()
    where owner_id=p_owner_id;
  return jsonb_build_object('code','OK','replayed',false);
end;
$$;

-- §5.3 platform-restore step. Database owner only (no grants). Deletes every result, chain and attempt, never usage or
-- evidence, then settles whatever held try-on usage is already due; the rest settles through the scheduled expiry.
create function public.tryon_discard_transient() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; v_r integer; v_c integer; n integer := 0;
begin
  delete from private.tryon_results;
  get diagnostics v_r = row_count;
  delete from private.tryon_chains;
  get diagnostics v_c = row_count;
  delete from private.tryon_attempts;
  for v_owner in
    select pr.owner_id from public.profiles pr where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id
      and u.purpose='try_on' and u.charge_state='held') order by pr.owner_id for update of pr
  loop
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.tryon_expire_accounting(v_owner,v_now,100);
  end loop;
  return jsonb_build_object('code','OK','resultsDeleted',v_r,'chainsDeleted',v_c,'expired',n);
end;
$$;

-- Admin (AD1) v2: the same lock order, caller-before-target rule, accountVersion, expected values and audit, with
-- try-on added as a fourth feature. v1 keeps its exact output; its write now refuses a shared total below a configured
-- try-on sub-limit (CONFLICT) instead of letting the clamp change a value it cannot show.
create function private.admin_limits_v2(c private.ai_controls) returns jsonb
language sql stable set search_path = '' as $$
  select private.admin_limits(c)||jsonb_build_object('tryOn',jsonb_build_object(
    'monthlyAllowanceMicro',c.tryon_monthly_allowance_micro::text,'maxRequestMicro',c.tryon_max_request_micro::text,
    'maxRequestsPerHour',c.tryon_max_requests_per_hour));
$$;

create function private.admin_limits_shape_fields(p jsonb,p_fields text[]) returns boolean
language plpgsql immutable set search_path = '' as $$
declare f text; k text; v jsonb;
begin
  if p is null or jsonb_typeof(p)<>'object' then return false; end if;
  if not p ?& p_fields or (select count(*) from jsonb_object_keys(p))<>cardinality(p_fields) then return false; end if;
  foreach f in array p_fields loop
    if jsonb_typeof(p->f)<>'object' then return false; end if;
    if not (p->f) ?& array['monthlyAllowanceMicro','maxRequestMicro','maxRequestsPerHour']
      or (select count(*) from jsonb_object_keys(p->f))<>3 then return false; end if;
    foreach k in array array['monthlyAllowanceMicro','maxRequestMicro'] loop
      v := p->f->k;
      if jsonb_typeof(v)='string' then
        if not (v#>>'{}') ~ '^(0|[1-9][0-9]{0,11})$' then return false; end if;
      elsif jsonb_typeof(v)<>'null' then return false;
      end if;
    end loop;
    v := p->f->'maxRequestsPerHour';
    if jsonb_typeof(v)='number' then
      if not v::text ~ '^-?[0-9]{1,9}$' then return false; end if;
    elsif jsonb_typeof(v)<>'null' then return false;
    end if;
  end loop;
  return true;
end;
$$;

-- The AD1 write body, shared by v1 (three features) and v2 (four). Unchanged for v1 except the try-on CONFLICT.
create function private.admin_set_limits(p_admission_no smallint,p_account_version text,p_expected jsonb,p_limits jsonb,
  p_reason_code text,p_v2 boolean) returns jsonb
language plpgsql volatile set search_path = '' set lock_timeout = '2s' as $$
declare v_actor uuid := private.admin_authority(); v_actor_no smallint; t private.approved_accounts; c private.ai_controls;
  v_current jsonb; v_saved jsonb; f text; k text; v_monthly numeric; v_request numeric; v_hour numeric; v_shared numeric;
  v_manifest text; v_reservation bigint; s record; e record; y record; v_below boolean;
  v_fields text[] := case when p_v2 then array['shared','stylist','enhancement','tryOn']
    else array['shared','stylist','enhancement'] end;
begin
  -- Caller-only authorisation, before any target lookup, lock or detailed validation.
  if v_actor is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_admission_no is null or p_admission_no not in (1,2) or p_account_version is null
    or p_account_version !~ '^[0-9a-f]{64}$' or not private.admin_limits_shape_fields(p_expected,v_fields)
    or not private.admin_limits_shape_fields(p_limits,v_fields)
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
    -- Recomputed from the locked admission row, never trusted from the caller.
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
  v_current := case when p_v2 then private.admin_limits_v2(c) else private.admin_limits(c) end;
  if p_expected<>v_current then return jsonb_build_object('code','CONFLICT','limits',v_current); end if;
  v_shared := (p_limits->'shared'->>'monthlyAllowanceMicro')::numeric;
  foreach f in array v_fields loop
    -- A configured value cannot be removed and an unconfigured one cannot be added here.
    foreach k in array array['monthlyAllowanceMicro','maxRequestMicro','maxRequestsPerHour'] loop
      if (jsonb_typeof(p_limits->f->k)='null')<>(jsonb_typeof(v_current->f->k)='null') then
        return jsonb_build_object('code','INVALID_LIMITS','field',f||'.'||k,'reason','REQUIRED');
      end if;
    end loop;
    v_monthly := (p_limits->f->>'monthlyAllowanceMicro')::numeric;
    v_request := (p_limits->f->>'maxRequestMicro')::numeric;
    v_hour := (p_limits->f->>'maxRequestsPerHour')::numeric;
    if v_monthly<=0 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.monthlyAllowanceMicro','reason','NOT_POSITIVE');
    end if;
    if v_request<=0 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','NOT_POSITIVE');
    end if;
    if v_hour<1 or v_hour>1000 then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestsPerHour','reason','RANGE');
    end if;
    if f='shared' and v_monthly>50000000 then
      return jsonb_build_object('code','INVALID_LIMITS','field','shared.monthlyAllowanceMicro','reason','APP_LIMIT');
    end if;
    if v_request>v_monthly then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','ABOVE_MONTHLY');
    end if;
    if f<>'shared' and v_monthly>v_shared then
      return jsonb_build_object('code','INVALID_LIMITS','field',f||'.monthlyAllowanceMicro','reason','ABOVE_SHARED');
    end if;
    -- Every proposed per-request value, changed or not, must cover the active manifest's reservation.
    v_manifest := case f when 'shared' then c.execution_manifest_id when 'stylist' then c.stylist_manifest_id
      when 'enhancement' then c.enhance_manifest_id else c.tryon_manifest_id end;
    if v_request is not null and v_manifest is not null then
      select reservation_micro into v_reservation from private.ai_execution_manifests where id=v_manifest;
      if v_request<v_reservation then
        return jsonb_build_object('code','INVALID_LIMITS','field',f||'.maxRequestMicro','reason','BELOW_RESERVATION');
      end if;
    end if;
  end loop;
  if p_limits=v_current then return jsonb_build_object('code','UNCHANGED','limits',v_current); end if;
  -- v1 cannot show try-on, so it may not lower the shared total below a configured try-on sub-limit.
  if not p_v2 and c.tryon_monthly_allowance_micro is not null and v_shared<c.tryon_monthly_allowance_micro then
    return jsonb_build_object('code','CONFLICT','limits',v_current);
  end if;
  update private.ai_controls set
    monthly_allowance_micro=(p_limits->'shared'->>'monthlyAllowanceMicro')::bigint,
    max_request_micro=(p_limits->'shared'->>'maxRequestMicro')::bigint,
    max_requests_per_hour=(p_limits->'shared'->>'maxRequestsPerHour')::integer,
    stylist_monthly_allowance_micro=(p_limits->'stylist'->>'monthlyAllowanceMicro')::bigint,
    stylist_max_request_micro=(p_limits->'stylist'->>'maxRequestMicro')::bigint,
    stylist_max_requests_per_hour=(p_limits->'stylist'->>'maxRequestsPerHour')::integer,
    enhance_monthly_allowance_micro=(p_limits->'enhancement'->>'monthlyAllowanceMicro')::bigint,
    enhance_max_request_micro=(p_limits->'enhancement'->>'maxRequestMicro')::bigint,
    enhance_max_requests_per_hour=(p_limits->'enhancement'->>'maxRequestsPerHour')::integer,
    tryon_monthly_allowance_micro=case when p_v2 then (p_limits->'tryOn'->>'monthlyAllowanceMicro')::bigint
      else tryon_monthly_allowance_micro end,
    tryon_max_request_micro=case when p_v2 then (p_limits->'tryOn'->>'maxRequestMicro')::bigint
      else tryon_max_request_micro end,
    tryon_max_requests_per_hour=case when p_v2 then (p_limits->'tryOn'->>'maxRequestsPerHour')::integer
      else tryon_max_requests_per_hour end,
    updated_at=clock_timestamp()
    where owner_id=t.user_id returning * into c;
  v_saved := case when p_v2 then private.admin_limits_v2(c) else private.admin_limits(c) end;
  if v_saved<>p_limits then raise exception using errcode='P0001',message='Limit write changed'; end if;
  select * into s from private.stylist_usage(t.user_id,clock_timestamp());
  select * into e from private.enhance_usage(t.user_id,clock_timestamp());
  v_below := s.total_micro>c.monthly_allowance_micro or coalesce(s.stylist_micro>c.stylist_monthly_allowance_micro,false)
    or coalesce(e.enhance_micro>c.enhance_monthly_allowance_micro,false);
  if p_v2 then
    select * into y from private.tryon_usage(t.user_id,clock_timestamp());
    v_below := v_below or coalesce(y.tryon_micro>c.tryon_monthly_allowance_micro,false);
  end if;
  insert into private.ai_limit_audit(id,created_at,owner_id,target_admission_no,actor_owner_id,old_limits,new_limits,reason_code)
    values(gen_random_uuid(),clock_timestamp(),t.user_id,t.admission_no,v_actor,v_current,v_saved,p_reason_code);
  return jsonb_build_object('code','OK','limits',v_saved,'belowUse',v_below);
end;
$$;

create or replace function public.admin_set_ai_limits(p_admission_no smallint,p_account_version text,p_expected jsonb,
  p_limits jsonb,p_reason_code text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return private.admin_set_limits(p_admission_no,p_account_version,p_expected,p_limits,p_reason_code,false);
end;
$$;

create function public.admin_set_ai_limits_v2(p_admission_no smallint,p_account_version text,p_expected jsonb,
  p_limits jsonb,p_reason_code text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return private.admin_set_limits(p_admission_no,p_account_version,p_expected,p_limits,p_reason_code,true);
end;
$$;

-- v1 account plus try-on amounts, counts, limits and flags only (ADR27 amended): never images, results, chains or hashes.
create function private.admin_account_v2(a private.approved_accounts,p_now timestamptz,p_months text[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := private.admin_account(a,p_now,p_months); c private.ai_controls; y record; v_probe jsonb;
begin
  select * into c from private.ai_controls where owner_id=a.user_id;
  select * into y from private.tryon_usage(a.user_id,p_now);
  select jsonb_build_object('count',count(*),'allocationMicro',coalesce(sum(allocation_micro),0)::text,
    'maxCalls',coalesce(sum(max_calls),0))
    into v_probe from private.tryon_probe_authorisations
    where owner_id=a.user_id and stopped_at is null and expires_at>p_now;
  v := jsonb_set(v,'{features,tryOn}',jsonb_build_object('configured',c.tryon_monthly_allowance_micro is not null,
    'activated',coalesce(c.tryon_activated,false)));
  if c.owner_id is not null then v := jsonb_set(v,'{limits}',private.admin_limits_v2(c)); end if;
  v := jsonb_set(v,'{history}',(select jsonb_agg(h||jsonb_build_object('tryOn',private.admin_month(a.user_id,h->>'month','try_on'))
    order by n) from jsonb_array_elements(v->'history') with ordinality x(h,n)));
  v := jsonb_set(v,'{current,tryOn}',jsonb_build_object('usedMicro',y.tryon_micro::text,'lastHour',y.tryon_hour));
  v := jsonb_set(v,'{openAllocations,tryOnProbe}',v_probe);
  return v;
end;
$$;

create function public.admin_ai_spending_v2(p_months integer default 6) returns jsonb
language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_months text[];
begin
  if private.admin_authority() is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_months is null or p_months<1 or p_months>12 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select array_agg(to_char(date_trunc('month',v_now at time zone 'UTC')-make_interval(months=>g),'YYYY-MM') order by g)
    into v_months from generate_series(0,p_months-1) g;
  return jsonb_build_object('code','OK','asOf',floor(extract(epoch from v_now)*1000)::bigint,'months',to_jsonb(v_months),
    'accounts',coalesce((select jsonb_agg(private.admin_account_v2(a,v_now,v_months) order by a.admission_no)
      from private.approved_accounts a
      where a.user_id is not null and exists(select 1 from public.profiles p where p.owner_id=a.user_id)),'[]'::jsonb));
end;
$$;

-- Every owner-keyed table, now including the four try-on tables (they cascade from the profile delete).
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
    or exists(select 1 from private.tryon_probe_authorisations where owner_id=p_owner));
$$;

revoke all on function private.tryon_evidence_guard(),private.tryon_allowance_clamp(),
  private.tryon_permission(public.profiles,private.ai_controls,timestamptz),
  private.tryon_probe_permission(public.profiles,private.ai_controls,private.tryon_probe_authorisations,timestamptz),
  private.tryon_usage(uuid,timestamptz),private.tryon_garment_current(uuid,uuid,uuid,text,integer),
  private.tryon_expire_accounting(uuid,timestamptz,integer),private.tryon_end_chain(uuid,uuid,text,text,timestamptz),
  private.tryon_expire_owner(uuid,timestamptz,integer),private.tryon_purge_overdue(timestamptz),
  private.tryon_select_steps(uuid,uuid),private.tryon_close_attempt(uuid,uuid,text,timestamptz),
  private.tryon_replay(private.ai_usage_evidence,private.ai_usage),
  private.admin_limits_v2(private.ai_controls),private.admin_limits_shape_fields(jsonb,text[]),
  private.admin_set_limits(smallint,text,jsonb,jsonb,text,boolean),
  private.admin_account_v2(private.approved_accounts,timestamptz,text[]),
  private.deletion_owner_rows_absent(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.tryon_status(),public.tryon_set_consent(boolean,integer),public.tryon_chain_status(uuid),
  public.tryon_cancel(uuid),public.tryon_results_v1(),public.tryon_result_image_v1(uuid),public.tryon_delete_result(uuid),
  public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid),public.tryon_dispatch(uuid,uuid,boolean),
  public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean),
  public.tryon_expire_due(integer),public.tryon_purge_health(),
  public.tryon_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz),
  public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer),public.tryon_discard_transient(),
  public.admin_set_ai_limits(smallint,text,jsonb,jsonb,text),public.admin_set_ai_limits_v2(smallint,text,jsonb,jsonb,text),
  public.admin_ai_spending_v2(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.tryon_status(),public.tryon_set_consent(boolean,integer),public.tryon_chain_status(uuid),
  public.tryon_cancel(uuid),public.tryon_results_v1(),public.tryon_result_image_v1(uuid),public.tryon_delete_result(uuid),
  public.admin_set_ai_limits(smallint,text,jsonb,jsonb,text),public.admin_set_ai_limits_v2(smallint,text,jsonb,jsonb,text),
  public.admin_ai_spending_v2(integer) to authenticated;
grant execute on function public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid),
  public.tryon_dispatch(uuid,uuid,boolean),
  public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean),
  public.tryon_purge_health(),
  public.tryon_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz) to service_role;

commit;
