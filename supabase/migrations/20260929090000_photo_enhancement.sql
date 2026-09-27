-- BG2b-1: inactive photo-enhancement backend (issue #84; plan rev3 with coordinator-binding R1-R4 and Q6; ADR26).
-- Nothing dispatches: no owner has enhance_activated, the provider kill switch starts off and 20260929090100 adds an
-- inactive expiry job. Classification:
--   additive: tables, columns, the manifest row and new functions; the v1 restore, replacement and recovery writers keep
--     their bodies and ACLs;
--   behaviour-changing: enhancement rows share private.ai_usage, so tagging and stylist admission count them;
--   NON-ADDITIVE: two triggers on public.item_images (admission before insert, attachment on pending -> ready) that
--     apply to every existing image writer, and a BEFORE UPDATE clamp on private.ai_controls.
-- Lock order (extends ST1a D6): approved account (share) -> profile -> ai_controls -> probe authorisation ->
--   provider_capacity -> ai_usage -> ai_usage_evidence. A global shutdown takes provider_capacity only after the owner
--   locks and never touches another owner's rows. Restore writers: image_change_lock -> profile -> marker.
-- Hash glossary: input_sha256 = H1 sent to Azure; output_sha256 = accepted H2; stored_sha256 = item_images.main_sha256
-- the provenance is attached to; backup_sha256 = the backup's main hash, which Q6 requires to equal stored_sha256.
begin;

-- R1: settlement storage. Enhancement outcomes get their own columns; the stylist pair and digest checks are untouched.
alter table private.ai_usage drop constraint ai_usage_purpose_check;
alter table private.ai_usage add constraint ai_usage_purpose_check check (purpose in ('analysis','stylist','enhancement'));
alter table private.ai_usage add column provider_slot_id uuid;
alter table private.ai_usage add constraint ai_usage_enhancement_slot
  check ((purpose='enhancement') = (provider_slot_id is not null));
create index ai_usage_enhancement_held on private.ai_usage(owner_id,dispatched_at)
  where purpose='enhancement' and charge_state='held';

alter table private.ai_usage_evidence
  add column enhance_code text check (enhance_code in ('OK','FAILED','FILTERED','OUTPUT_REJECTED','NOT_DISPATCHED','EXPIRED')),
  add column enhance_settlement_origin text
    check (enhance_settlement_origin in ('provisional_expiry','observed','unmetered','terminal_anomaly','non_dispatch')),
  add column enhance_settlement_digest text check (enhance_settlement_digest ~ '^[0-9a-f]{64}$'),
  add column enhance_input_sha256 text check (enhance_input_sha256 ~ '^[0-9a-f]{64}$'),
  add column enhance_probe_id uuid,
  add constraint ai_usage_evidence_enhance_pair check ((enhance_code is null) = (enhance_settlement_origin is null)),
  add constraint ai_usage_evidence_enhance_digest check
    ((enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch'))
      is not distinct from (enhance_settlement_digest is not null)
      or (enhance_settlement_origin is null and enhance_settlement_digest is null)),
  add constraint ai_usage_evidence_enhance_input check (enhance_code is null or enhance_input_sha256 is not null),
  add constraint ai_usage_evidence_one_outcome check (stylist_code is null or (enhance_code is null and enhance_input_sha256 is null));

alter table private.ai_controls
  add column enhance_activated boolean not null default false,
  add column enhance_notice_revision integer check (enhance_notice_revision between 1 and 2147483647),
  add column enhance_manifest_id text references private.ai_execution_manifests(id),
  add column enhance_max_request_micro bigint check (enhance_max_request_micro > 0),
  add column enhance_monthly_allowance_micro bigint check (enhance_monthly_allowance_micro > 0),
  add column enhance_max_requests_per_hour integer check (enhance_max_requests_per_hour between 1 and 1000),
  add column enhance_consent_revision integer check (enhance_consent_revision between 1 and 2147483647),
  add column enhance_consented_at timestamptz,
  add constraint ai_controls_enhance_settings check (not enhance_activated or (enhance_notice_revision is not null
    and enhance_manifest_id is not null and enhance_max_request_micro is not null
    and enhance_monthly_allowance_micro is not null and enhance_max_requests_per_hour is not null)),
  add constraint ai_controls_enhance_consent_pair check ((enhance_consent_revision is null) = (enhance_consented_at is null)),
  add constraint ai_controls_enhance_allowance check (enhance_monthly_allowance_micro is null
    or enhance_monthly_allowance_micro <= monthly_allowance_micro);

-- R1 clamp: when the shared total is lowered (for example by ST1a's unchanged stylist_direct_allocation), the
-- enhancement sub-limit follows in the same row update. It edits NEW only and issues no UPDATE, so it cannot recurse.
create function private.enhance_allowance_clamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.enhance_monthly_allowance_micro is not null and new.enhance_monthly_allowance_micro>new.monthly_allowance_micro then
    new.enhance_monthly_allowance_micro := new.monthly_allowance_micro;
  end if;
  return new;
end;
$$;
create trigger ai_controls_enhance_clamp before update of monthly_allowance_micro on private.ai_controls
for each row execute function private.enhance_allowance_clamp();

-- Retail Image-2.5-sunburst Global (USD per 1M tokens): text in 5.00, image in 8.00, image out 30.00. The reservation
-- values the 7,500 input / 8,000 output envelope with all input at image-in: an estimated envelope, not a ceiling.
insert into private.ai_execution_manifests values (
  'azure-global-image25-sunburst-enhance-v1','gpt-image-2.5-sunburst',1,
  '9a102c3c5b614cfa34fc1a0447a4410f9dfaa46ef8f53fb33316e1d15b3f9afe',
  '20cefa4d2f2fd2c381ac50f30af286f48ea804d9e6fb6d58ca5c5dbd45fa8efe',
  '5b78ccfddc0814bd9d8b5f46f871647bc791dad57aadcf0d7acfb7b7b8ecdcd5',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/images/edits','Global','GlobalStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-27T00:00:00Z',
  'INACTIVE photo enhancement on existing DEV/TEST eval-image25-sunburst-20260908 (GlobalStandard, 2 requests/min). Retail API USD per1M: text input 5.00, image input 8.00, image output 30.00. Reservation 300000 micro values the 7500 input/8000 output envelope with all input at image-in 8.00; the images API has no token cap, so this is an estimated envelope with possible in-flight overrun, handled by the anomaly kill switch. Frozen parameters n1 1024x1280 medium jpeg compression85 opaque, no input_fidelity. Only the prepared garment photo is sent. Global processing may happen outside the EU. Probe and paid activation remain owner gates.',
  'USD',800,3000,7500,8000,300000,512000,1600,4194304,512000,85,'2027-01-01T00:00:00Z'
);

-- M2/N5: shared provider capacity keyed by the immutable deployment identity. Slots carry no owner or request data,
-- expire by time only and are never released early, including by account deletion.
create table private.provider_capacity (
  deployment_key text primary key check (deployment_key ~ '^[a-z0-9-]{1,64}/[a-z0-9-]{1,64}/[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  window_seconds integer not null check (window_seconds between 1 and 3600),
  max_dispatch integer not null check (max_dispatch between 1 and 100),
  dispatch_enabled boolean not null default false,
  disabled_reason text check (disabled_reason in ('INITIAL','USAGE_ANOMALY','OPERATOR')),
  disabled_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (dispatch_enabled = (disabled_reason is null)),
  check ((disabled_reason is null) = (disabled_at is null))
);
create table private.provider_deployments (
  manifest_id text primary key references private.ai_execution_manifests(id),
  deployment_key text not null references private.provider_capacity(deployment_key)
);
create table private.provider_slots (
  slot_id uuid primary key,
  deployment_key text not null references private.provider_capacity(deployment_key),
  held_until timestamptz not null
);
create index provider_slots_held on private.provider_slots(deployment_key,held_until);
insert into private.provider_capacity(deployment_key,window_seconds,max_dispatch,dispatch_enabled,disabled_reason,disabled_at)
  values('stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08',60,2,false,'INITIAL',clock_timestamp());
insert into private.provider_deployments values('azure-global-image25-sunburst-enhance-v1',
  'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08');

-- Evidence of an accepted, released H2. It authorises NEW enhanced images for 24 hours only (N2).
create table private.image_enhancements (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  request_id uuid not null,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  output_bytes integer not null check (output_bytes between 1 and 512000),
  deployment_key text not null references private.provider_capacity(deployment_key),
  manifest_id text not null references private.ai_execution_manifests(id),
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  created_at timestamptz not null,
  usable_until timestamptz not null,
  primary key(owner_id,request_id),
  check (usable_until = created_at + interval '24 hours')
);
create index image_enhancements_output on private.image_enhancements(owner_id,output_sha256,output_bytes,created_at);
-- Permanent per-account output tombstone: hashes and identifiers only, never bytes. It lives as long as the account.
create table private.enhancement_outputs (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  output_bytes integer not null check (output_bytes between 1 and 512000),
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  manifest_id text not null references private.ai_execution_manifests(id),
  first_request_id uuid not null,
  created_at timestamptz not null,
  primary key(owner_id,output_sha256,output_bytes)
);

-- Durable provenance. Private (a deviation from the plan's public table): owners read it through
-- image_provenance_v1(), and nothing else writes it except the definer triggers and restore_image_provenance.
create table private.image_provenance (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  image_id uuid not null,
  kind text not null check (kind='ai_edited'),
  origin text not null check (origin in ('recorded','imported')),
  request_id uuid,
  import_id uuid,
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  manifest_id text not null check (manifest_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  input_sha256 text check (input_sha256 ~ '^[0-9a-f]{64}$'),
  backup_sha256 text check (backup_sha256 ~ '^[0-9a-f]{64}$'),
  stored_sha256 text not null check (stored_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,image_id),
  foreign key(owner_id,image_id) references public.item_images(owner_id,id) on delete cascade,
  constraint image_provenance_recorded check ((origin='recorded')
    = (request_id is not null and input_sha256 is not null and import_id is null and backup_sha256 is null)),
  constraint image_provenance_imported check ((origin='imported')
    = (import_id is not null and backup_sha256 is not null and request_id is null)),
  constraint image_provenance_byte_preserved check (backup_sha256 is null or backup_sha256=stored_sha256)
);

-- R2: a pending binding snapshots the complete validated provenance payload at reservation, under the writer's owner
-- locks, so completion never reads the source image or the evidence row again.
create table private.image_enhancement_bindings (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  image_id uuid not null,
  source_kind text not null check (source_kind in ('evidence','copy')),
  source_image_id uuid,
  origin text not null check (origin in ('recorded','imported')),
  request_id uuid,
  import_id uuid,
  model_id text not null check (model_id ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  manifest_id text not null check (manifest_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  input_sha256 text check (input_sha256 ~ '^[0-9a-f]{64}$'),
  backup_sha256 text check (backup_sha256 ~ '^[0-9a-f]{64}$'),
  stored_sha256 text not null check (stored_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,image_id),
  foreign key(owner_id,image_id) references public.item_images(owner_id,id) on delete cascade deferrable initially deferred,
  check ((source_kind='copy') = (source_image_id is not null)),
  check (source_kind='copy' or origin='recorded'),
  check ((origin='recorded') = (request_id is not null and input_sha256 is not null and import_id is null and backup_sha256 is null)),
  check ((origin='imported') = (import_id is not null and backup_sha256 is not null and request_id is null)),
  check (backup_sha256 is null or backup_sha256=stored_sha256)
);

-- N1/R3: restore-only markers. Immutable, bound to owner, item, image, import, restored hash, operation and mode.
-- The deferred FK is checked at commit, after the unchanged v1 writer inserted the image.
create table private.restore_image_markers (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  image_id uuid not null,
  item_id uuid not null,
  import_id uuid not null,
  restored_sha256 text not null check (restored_sha256 ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('item_save','image_change')),
  request_id uuid,
  mode text not null check (mode in ('legacy','v4','unlabelled')),
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  primary key(owner_id,image_id),
  foreign key(owner_id,image_id) references public.item_images(owner_id,id) on delete cascade deferrable initially deferred,
  check ((operation='image_change') = (request_id is not null))
);
create function private.restore_marker_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- The one permitted change: the attach trigger records the image's pending -> ready publication, once.
  if old.published_at is null and new.published_at is not null
    and (to_jsonb(new)-'published_at')=(to_jsonb(old)-'published_at') then
    return new;
  end if;
  raise exception using errcode='42501',message='Not available';
end;
$$;
create trigger restore_image_markers_immutable before update on private.restore_image_markers
for each row execute function private.restore_marker_immutable();

-- N3: operator-only probe authorisation (on-ledger). It substitutes for the owner's enhancement activation and
-- consent for probe claims only; it never enables normal dispatch.
create table private.enhancement_probe_authorisations (
  id uuid primary key,
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  deployment_key text not null references private.provider_capacity(deployment_key),
  manifest_id text not null references private.ai_execution_manifests(id),
  max_calls integer not null check (max_calls between 1 and 6),
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

alter table private.provider_capacity enable row level security;
alter table private.provider_deployments enable row level security;
alter table private.provider_slots enable row level security;
alter table private.image_enhancements enable row level security;
alter table private.enhancement_outputs enable row level security;
alter table private.image_provenance enable row level security;
alter table private.image_enhancement_bindings enable row level security;
alter table private.restore_image_markers enable row level security;
alter table private.enhancement_probe_authorisations enable row level security;
revoke all on private.provider_capacity,private.provider_deployments,private.provider_slots,private.image_enhancements,
  private.enhancement_outputs,private.image_provenance,private.image_enhancement_bindings,private.restore_image_markers,
  private.enhancement_probe_authorisations from public,anon,authenticated,service_role;

-- N2 admission, BEFORE INSERT on item_images, first match wins. It runs inside the calling writer after that writer's
-- own identity, lock, deletion-claim and fence checks. It never modifies NEW, another image or an item.
--   1. a restore marker for the image: pass (provenance comes through its mode, R3);
--   2. same-owner durable provenance on equal bytes (recover previous photo and other reuse): snapshot a copy, no expiry;
--   3. usable same-owner evidence on equal bytes: snapshot the earliest usable row (usable beats expired duplicates);
--   4. bytes the owner already restored as explicitly unlabelled (disclosed, Q6): pass unlabelled;
--   5. a same-owner tombstone only: refuse, so an unlabelled H2 cannot enter after 24 hours or after the purge;
--   6. otherwise an ordinary unlabelled image.
-- A hash match proves origin, not fidelity.
create function private.enhancement_admission() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare s private.image_provenance; ev private.image_enhancements;
begin
  if exists(select 1 from private.restore_image_markers k where k.owner_id=new.owner_id and k.image_id=new.id) then
    return new;
  end if;
  select p.* into s from private.image_provenance p
    join public.item_images x on x.owner_id=p.owner_id and x.id=p.image_id
    where p.owner_id=new.owner_id and p.stored_sha256=new.main_sha256 and x.main_bytes=new.main_bytes
    order by p.created_at,p.image_id limit 1;
  if found then
    insert into private.image_enhancement_bindings(owner_id,image_id,source_kind,source_image_id,origin,request_id,import_id,
      model_id,manifest_id,input_sha256,backup_sha256,stored_sha256)
      values(new.owner_id,new.id,'copy',s.image_id,s.origin,s.request_id,s.import_id,s.model_id,s.manifest_id,
        s.input_sha256,s.backup_sha256,new.main_sha256)
      on conflict (owner_id,image_id) do nothing;
    return new;
  end if;
  select * into ev from private.image_enhancements e
    where e.owner_id=new.owner_id and e.output_sha256=new.main_sha256 and e.output_bytes=new.main_bytes
      and e.usable_until>clock_timestamp()
    order by e.created_at,e.request_id limit 1;
  if found then
    insert into private.image_enhancement_bindings(owner_id,image_id,source_kind,origin,request_id,model_id,manifest_id,
      input_sha256,stored_sha256)
      values(new.owner_id,new.id,'evidence','recorded',ev.request_id,ev.model_id,ev.manifest_id,ev.input_sha256,new.main_sha256)
      on conflict (owner_id,image_id) do nothing;
    return new;
  end if;
  if exists(select 1 from private.restore_image_markers k where k.owner_id=new.owner_id and k.mode='unlabelled'
    and k.restored_sha256=new.main_sha256) then
    return new;
  end if;
  if exists(select 1 from private.enhancement_outputs t
    where t.owner_id=new.owner_id and t.output_sha256=new.main_sha256 and t.output_bytes=new.main_bytes) then
    raise exception using errcode='22023',message='Enhancement expired';
  end if;
  return new;
end;
$$;
create trigger item_images_enhancement_admission before insert on public.item_images
for each row execute function private.enhancement_admission();

-- R4: attach only on the pending -> ready publication, once. Pending -> retired, ready -> retired and unrelated updates
-- never attach or consume a binding. The finalizer's attempt row is not read: it is updated after this trigger.
-- It inserts only into image_provenance, deletes only the consumed binding and records a restore marker's publication;
-- item_images is never written.
create function private.enhancement_attach() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare b private.image_enhancement_bindings; k private.restore_image_markers; t private.enhancement_outputs;
  s private.image_provenance;
begin
  update private.restore_image_markers set published_at=clock_timestamp()
    where owner_id=new.owner_id and image_id=new.id and published_at is null;
  delete from private.image_enhancement_bindings where owner_id=new.owner_id and image_id=new.id returning * into b;
  if found then
    if b.stored_sha256=new.main_sha256 then
      insert into private.image_provenance(owner_id,image_id,kind,origin,request_id,import_id,model_id,manifest_id,
        input_sha256,backup_sha256,stored_sha256)
        values(new.owner_id,new.id,'ai_edited',b.origin,b.request_id,b.import_id,b.model_id,b.manifest_id,
          b.input_sha256,b.backup_sha256,new.main_sha256)
        on conflict (owner_id,image_id) do nothing;
    end if;
    return null;
  end if;
  -- R3 legacy mode (v2/v3 backups without provenance entries): a same-owner tombstone, or failing that same-owner
  -- durable provenance on equal bytes, labels the restored image as imported. v4 and unlabelled never auto-attach.
  select * into k from private.restore_image_markers where owner_id=new.owner_id and image_id=new.id;
  if found and k.mode='legacy' and k.restored_sha256=new.main_sha256 then
    select * into t from private.enhancement_outputs
      where owner_id=new.owner_id and output_sha256=new.main_sha256 and output_bytes=new.main_bytes;
    if found then
      insert into private.image_provenance(owner_id,image_id,kind,origin,import_id,model_id,manifest_id,backup_sha256,stored_sha256)
        values(new.owner_id,new.id,'ai_edited','imported',k.import_id,t.model_id,t.manifest_id,new.main_sha256,new.main_sha256)
        on conflict (owner_id,image_id) do nothing;
      return null;
    end if;
    select p.* into s from private.image_provenance p
      join public.item_images x on x.owner_id=p.owner_id and x.id=p.image_id
      where p.owner_id=new.owner_id and p.image_id<>new.id and p.stored_sha256=new.main_sha256 and x.main_bytes=new.main_bytes
      order by p.created_at,p.image_id limit 1;
    if found then
      insert into private.image_provenance(owner_id,image_id,kind,origin,import_id,model_id,manifest_id,backup_sha256,stored_sha256)
        values(new.owner_id,new.id,'ai_edited','imported',k.import_id,s.model_id,s.manifest_id,new.main_sha256,new.main_sha256)
        on conflict (owner_id,image_id) do nothing;
    end if;
  end if;
  return null;
end;
$$;
create trigger item_images_enhancement_attach after update of state on public.item_images
for each row when (old.state='pending' and new.state='ready') execute function private.enhancement_attach();

-- N1/R3 marker. Created only while the image is absent or still pending on that item with that hash. An exact replay
-- is a no-op; any conflicting reuse fails. A v1 pending reservation resumed through v2 has its old binding removed in
-- the same transaction, so the marker's mode alone decides. Completed images are never relabelled.
create function private.restore_marker(p_owner uuid,p_item uuid,p_image uuid,p_import uuid,p_hash text,
  p_operation text,p_request uuid,p_mode text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare k private.restore_image_markers; im public.item_images;
begin
  select * into k from private.restore_image_markers where owner_id=p_owner and image_id=p_image for update;
  if found then
    if k.item_id<>p_item or k.import_id<>p_import or k.restored_sha256<>p_hash or k.operation<>p_operation
      or k.request_id is distinct from p_request or k.mode<>p_mode then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return;
  end if;
  select * into im from public.item_images where id=p_image;
  if found then
    if im.owner_id<>p_owner or im.item_id<>p_item or im.state<>'pending' or im.main_sha256<>p_hash then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    delete from private.image_enhancement_bindings where owner_id=p_owner and image_id=p_image;
  end if;
  insert into private.restore_image_markers(owner_id,image_id,item_id,import_id,restored_sha256,operation,request_id,mode)
    values(p_owner,p_image,p_item,p_import,p_hash,p_operation,p_request,p_mode);
end;
$$;

-- Restore-only first photo: marker first, then the unchanged v1 writer in the same transaction, then a post-check.
-- Any failure rolls the marker back with the reservation.
create function public.reserve_restored_item_save_v2(p_item jsonb,p_image jsonb,p_import_id uuid,p_mode text)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); v_item uuid; v_image uuid; v_hash text; r record;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  if not found or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  if p_import_id is null or p_mode is null or p_mode not in ('legacy','v4','unlabelled')
    or p_item is null or jsonb_typeof(p_item)<>'object' or p_image is null or jsonb_typeof(p_image)<>'object'
    or jsonb_typeof(p_item->'id') is distinct from 'string'
    or p_item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_image->'id') is distinct from 'string'
    or p_image->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_image->'main_sha256') is distinct from 'string' or p_image->>'main_sha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  v_item := (p_item->>'id')::uuid; v_image := (p_image->>'id')::uuid; v_hash := p_image->>'main_sha256';
  perform private.restore_marker(u,v_item,v_image,p_import_id,v_hash,'item_save',null,p_mode);
  select * into r from public.reserve_restored_item_save(p_item,p_image);
  if not exists(select 1 from public.item_images x where x.owner_id=u and x.id=v_image and x.item_id=v_item
    and x.main_sha256=v_hash) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return query select r.item,r.image,r.fingerprint,r.state;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

-- Restore-only later photo: the ordinary replacement intent with claim and sourceImageId null, around the unchanged
-- reserve_image_change. Ordinary replacement and recovery are not routed here.
create function public.reserve_restored_image_change(p_intent jsonb,p_import_id uuid,p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); v_item uuid; v_image uuid; v_request uuid; v_hash text; r jsonb;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  if not found or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  if p_import_id is null or p_mode is null or p_mode not in ('legacy','v4','unlabelled')
    or p_intent is null or jsonb_typeof(p_intent)<>'object'
    or p_intent->'claim' is distinct from 'null'::jsonb or p_intent->'sourceImageId' is distinct from 'null'::jsonb
    or jsonb_typeof(p_intent->'image') is distinct from 'object'
    or jsonb_typeof(p_intent->'requestId') is distinct from 'string'
    or p_intent->>'requestId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_intent->'itemId') is distinct from 'string'
    or p_intent->>'itemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_intent->'imageId') is distinct from 'string'
    or p_intent->>'imageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_intent->'image'->'id' is distinct from p_intent->'imageId'
    or jsonb_typeof(p_intent->'image'->'main_sha256') is distinct from 'string'
    or p_intent->'image'->>'main_sha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  v_item := (p_intent->>'itemId')::uuid; v_image := (p_intent->>'imageId')::uuid;
  v_request := (p_intent->>'requestId')::uuid; v_hash := p_intent->'image'->>'main_sha256';
  perform private.restore_marker(u,v_item,v_image,p_import_id,v_hash,'image_change',v_request,p_mode);
  r := public.reserve_image_change(p_intent);
  if not exists(select 1 from public.item_images x where x.owner_id=u and x.id=v_image and x.item_id=v_item
    and x.main_sha256=v_hash) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return r;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

-- v4 restore authority (N4, Q6). Exact replay first (works after the marker's image is replaced or long after the
-- restore); otherwise a v4 marker, a published image on that item with the marker's hash, and backup = restored.
-- Published means it went pending -> ready (the marker records it): still ready, or retired by a later restored photo
-- (multi-photo restore). Pending images, and images retired without publication, are refused.
create function public.restore_image_provenance(p_item_id uuid,p_image_id uuid,p_import_id uuid,p_entry jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); s private.image_provenance; k private.restore_image_markers; im public.item_images;
  keys constant text[] := array['kind','model_id','manifest_id','backup_sha256'];
begin
  if u is null then raise exception using errcode='42501',message='Not available'; end if;
  begin
    perform private.image_change_lock(u);
    perform 1 from public.profiles where owner_id=u for update nowait;
    if not found then raise exception using errcode='42501',message='Not available'; end if;
    perform 1 from public.items where owner_id=u and id=p_item_id for update nowait;
  exception
    when lock_not_available then return jsonb_build_object('state','busy');
    when sqlstate '22023' then return jsonb_build_object('state','busy');
  end;
  if not private.is_approved()
    or not exists(select 1 from public.items where owner_id=u and id=p_item_id and deleted_at is null)
    or private.image_change_fenced(u,p_item_id)
    or exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id) then
    raise exception using errcode='42501',message='Not available';
  end if;
  if p_image_id is null or p_import_id is null or p_entry is null or jsonb_typeof(p_entry)<>'object'
    or octet_length(convert_to(p_entry::text,'UTF8'))>1024
    or not (p_entry ?& keys) or p_entry-keys<>'{}'::jsonb
    or p_entry->'kind' is distinct from '"ai_edited"'::jsonb
    or jsonb_typeof(p_entry->'model_id') is distinct from 'string' or p_entry->>'model_id' !~ '^[A-Za-z0-9._:/-]{1,128}$'
    or jsonb_typeof(p_entry->'manifest_id') is distinct from 'string' or p_entry->>'manifest_id' !~ '^[A-Za-z0-9._:-]{1,128}$'
    or jsonb_typeof(p_entry->'backup_sha256') is distinct from 'string' or p_entry->>'backup_sha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select * into s from private.image_provenance where owner_id=u and image_id=p_image_id;
  if found then
    if s.origin='imported' and s.import_id=p_import_id and s.model_id=p_entry->>'model_id'
      and s.manifest_id=p_entry->>'manifest_id' and s.backup_sha256=p_entry->>'backup_sha256'
      and exists(select 1 from public.item_images x where x.owner_id=u and x.id=p_image_id and x.item_id=p_item_id) then
      return jsonb_build_object('state','equal');
    end if;
    raise exception using errcode='22023',message='Request conflict';
  end if;
  select * into k from private.restore_image_markers
    where owner_id=u and image_id=p_image_id and item_id=p_item_id and import_id=p_import_id and mode='v4';
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into im from public.item_images where owner_id=u and id=p_image_id and item_id=p_item_id;
  if not found or im.state not in ('ready','retired') or k.published_at is null or im.main_sha256<>k.restored_sha256
    or p_entry->>'backup_sha256'<>k.restored_sha256 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  insert into private.image_provenance(owner_id,image_id,kind,origin,import_id,model_id,manifest_id,backup_sha256,stored_sha256)
    values(u,p_image_id,'ai_edited','imported',p_import_id,p_entry->>'model_id',p_entry->>'manifest_id',
      k.restored_sha256,im.main_sha256);
  return jsonb_build_object('state','created');
exception
  when invalid_text_representation or datatype_mismatch then raise exception using errcode='22023',message='Invalid input';
end;
$$;

-- Owner-only provenance read and its digest for the v4 before/after snapshot check. The export manifest is unchanged.
create function private.image_provenance_rows(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('image_id',p.image_id,'kind',p.kind,'origin',p.origin,'model_id',p.model_id,
    'manifest_id',p.manifest_id,'stored_sha256',p.stored_sha256,'backup_sha256',p.backup_sha256) order by p.image_id),'[]'::jsonb)
  from private.image_provenance p where p.owner_id=p_owner;
$$;
create function public.image_provenance_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  return private.image_provenance_rows(auth.uid());
end;
$$;
create function public.image_provenance_digest_v1() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  return encode(sha256(convert_to(private.image_provenance_rows(auth.uid())::text,'UTF8')),'hex');
end;
$$;

-- Enhancement accounting (R1). Purpose-specific permission, usage validator, expiry and sums; tagging and stylist
-- functions are unchanged and keep counting every ai_usage row in their shared totals and hourly counts.
create function private.enhance_permission(p_profile public.profiles,p_controls private.ai_controls) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.enhance_manifest_id is null then 'UNCONFIGURED'
    when not p_controls.enhance_activated then 'INACTIVE'
    when p_controls.enhance_consent_revision is distinct from p_controls.enhance_notice_revision then 'CONSENT_REQUIRED'
    else 'OK' end;
$$;

-- N3: the stored operator authorisation replaces activation and consent for probe rows only.
create function private.enhance_probe_permission(p_profile public.profiles,p_controls private.ai_controls,
  p_auth private.enhancement_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.enhance_manifest_id is null or p_controls.enhance_max_request_micro is null
      or p_controls.enhance_monthly_allowance_micro is null or p_controls.enhance_max_requests_per_hour is null then 'UNCONFIGURED'
    when p_auth.id is null or p_auth.owner_id<>p_profile.owner_id or p_auth.stopped_at is not null
      or p_auth.expires_at<=p_now or p_auth.manifest_id<>p_controls.enhance_manifest_id then 'INACTIVE'
    else 'OK' end;
$$;

-- Images API usage: input = inputText + inputImage and input + output = total. Responses carry no model field, so
-- not_observed is valid here; a missing or unrecognised reported model is bad. All input is valued at image-in.
create function private.enhance_azure_usage(p_usage jsonb,m private.ai_execution_manifests,
  out valid boolean,out bad boolean,out estimate bigint,out over boolean,out model text)
language plpgsql immutable set search_path = '' as $$
declare k text; n numeric;
  keys constant text[] := array['modelObservation','input','output','total','inputText','inputImage'];
begin
  valid := true; bad := false; estimate := null; over := false; model := null;
  if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(convert_to(p_usage::text,'UTF8'))>1024
    or not(p_usage ?& keys) or p_usage-keys<>'{}'::jsonb or jsonb_typeof(p_usage->'modelObservation')<>'string'
    or p_usage->>'modelObservation' not in ('not_observed','response_missing_model','response_unrecognised_model','expected_snapshot','model_family','deployment_alias') then
    valid := false; return;
  end if;
  model := p_usage->>'modelObservation';
  bad := model in ('response_missing_model','response_unrecognised_model');
  foreach k in array keys[2:6] loop
    if jsonb_typeof(p_usage->k) is distinct from 'number' then valid := false;
    else
      n := (p_usage->>k)::numeric;
      if n<0 or n>9007199254740991 or n<>trunc(n) then valid := false; end if;
    end if;
  end loop;
  if valid then
    valid := (p_usage->>'input')::numeric+(p_usage->>'output')::numeric=(p_usage->>'total')::numeric
      and (p_usage->>'inputText')::numeric+(p_usage->>'inputImage')::numeric=(p_usage->>'input')::numeric;
  end if;
  if valid then
    estimate := ceil(((p_usage->>'input')::numeric*m.input_rate_hundredths
      +(p_usage->>'output')::numeric*m.output_rate_hundredths)/100)::bigint;
    over := (p_usage->>'input')::numeric>m.input_envelope or (p_usage->>'output')::numeric>m.output_envelope;
  end if;
end;
$$;

-- Provisional expiry: a held enhancement row three minutes after dispatch (dispatch window + 85 s request + margin) is
-- estimated at its reservation. A probe row that expires stops its authorisation (missing usage stops the probe).
-- The caller holds the owner's profile and controls; authorisations are taken before usage rows (lock order).
create function private.enhance_expire(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  update private.enhancement_probe_authorisations a set stopped_at=p_now,stopped_reason='MISSING_USAGE'
    where a.owner_id=p_owner and a.stopped_at is null and a.id in (
      select e.enhance_probe_id from private.ai_usage u join private.ai_usage_evidence e
        on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p_owner and u.purpose='enhancement' and u.charge_state='held'
        and u.dispatched_at<=p_now-interval '3 minutes' and e.enhance_probe_id is not null);
  with due as (
    select request_id from private.ai_usage
      where owner_id=p_owner and purpose='enhancement' and charge_state='held' and dispatched_at<=p_now-interval '3 minutes'
      order by dispatched_at,request_id limit least(greatest(coalesce(p_limit,0),0),100) for update
  ), closed as (
    update private.ai_usage u set charge_state='estimated',accounted_micro=u.reserved_micro,closed_reason='EXPIRED',closed_at=p_now
      from due where u.owner_id=p_owner and u.request_id=due.request_id returning u.request_id
  )
  update private.ai_usage_evidence e set anomaly=true,enhance_code='EXPIRED',enhance_settlement_origin='provisional_expiry'
    from closed where e.owner_id=p_owner and e.request_id=closed.request_id and e.enhance_settlement_origin is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function private.enhance_usage(p_owner uuid,p_now timestamptz,
  out enhance_micro numeric,out total_micro numeric,out enhance_hour bigint,out total_hour bigint)
language sql stable set search_path = '' as $$
  select coalesce(sum(accounted_micro) filter (where purpose='enhancement' and (period=to_char(p_now at time zone 'UTC','YYYY-MM')
      or charge_state in ('reserved','held'))),0),
    coalesce(sum(accounted_micro) filter (where period=to_char(p_now at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held')),0),
    count(*) filter (where purpose='enhancement' and created_at>p_now-interval '1 hour'),
    count(*) filter (where created_at>p_now-interval '1 hour')
  from private.ai_usage where owner_id=p_owner;
$$;

-- Owner status. Capacity is reported only as a boolean for the shared deployment: no foreign counts or identifiers.
create function public.enhance_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); s record; v_policy jsonb := null;
  v_available boolean := false;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.enhance_expire(p.owner_id,v_now,100); end if;
  select * into s from private.enhance_usage(p.owner_id,v_now);
  if c.owner_id is not null and c.enhance_manifest_id is not null then
    select k.dispatch_enabled into v_available from private.provider_deployments d
      join private.provider_capacity k on k.deployment_key=d.deployment_key where d.manifest_id=c.enhance_manifest_id;
    v_policy := jsonb_build_object('activated',c.enhance_activated,'noticeRevision',c.enhance_notice_revision,
      'manifestId',c.enhance_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.enhance_manifest_id),
      'maxRequestMicro',c.enhance_max_request_micro::text,'enhanceAllowanceMicro',c.enhance_monthly_allowance_micro::text,
      'totalAllowanceMicro',c.monthly_allowance_micro::text,'maxRequestsPerHour',c.enhance_max_requests_per_hour,
      'providerAvailable',coalesce(v_available,false));
  end if;
  return jsonb_build_object('code',private.enhance_permission(p,c),'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.enhance_consent_revision is not null,'noticeRevision',c.enhance_consent_revision,
      'consentedAt',c.enhance_consented_at),
    'policy',v_policy,
    'usage',jsonb_build_object('enhanceMicro',s.enhance_micro::text,'totalMicro',s.total_micro::text,'enhanceLastHour',s.enhance_hour,
      'warning',coalesce(v_policy is not null and (s.enhance_micro>=0.8*c.enhance_monthly_allowance_micro
        or s.total_micro>=0.8*c.monthly_allowance_micro),false)));
end;
$$;

-- Separate enhancement consent (M4): its own notice revision; tagging and stylist consent are untouched.
create function public.enhance_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.enhance_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.enhance_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set enhance_consent_revision=p_notice_revision,enhance_consented_at=clock_timestamp(),updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  else
    update private.ai_controls set enhance_consent_revision=null,enhance_consented_at=null,updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  end if;
  return public.enhance_status();
end;
$$;

-- Claim (R1, M2, N3). Lock order: approved account (share, nowait) -> profile -> controls -> probe authorisation ->
-- shared capacity (waits up to lock_timeout) -> new rows. Only the Edge function calls this, with the owner verified
-- by /auth/v1/user. A slot is held until the latest permitted dispatch plus the window and is never released early.
create function public.enhance_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_input_sha256 text,p_probe_id uuid)
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
  if not found or m.id<>'azure-global-image25-sunburst-enhance-v1' or m.review_expires_at<=v_now or k.deployment_key is null then
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

create function private.enhance_replay(e private.ai_usage_evidence,u private.ai_usage,p public.profiles,c private.ai_controls,
  a private.enhancement_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when e.enhance_settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.enhance_settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.enhance_settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when e.enhance_settlement_origin='unmetered' then e.enhance_code
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.enhance_code in ('FAILED','FILTERED','OUTPUT_REJECTED') then e.enhance_code
    when c.enhance_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    when not exists(select 1 from private.image_enhancements x where x.owner_id=e.owner_id and x.request_id=e.request_id
      and x.usable_until>p_now) then 'EXPIRED'
    when e.enhance_probe_id is not null then private.enhance_probe_permission(p,c,a,p_now)
    else private.enhance_permission(p,c) end;
$$;

-- Finish: idempotent over {code, usage, outputSha256, outputBytes}. OK evidence is committed here, before the Edge
-- function releases any byte of H2. Precedence: missing usage (unmetered, or invalid for OK), invalid usage, a bad
-- model observation, an envelope overrun, then a valid settlement. An anomaly turns the shared provider switch off
-- once (a dedicated flag; no other owner's rows are touched) and stops a probe authorisation.
create function public.enhance_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,
  p_output_sha256 text,p_output_bytes integer) returns jsonb
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
    or ((p_code='OK') <> (p_output_sha256 is not null and p_output_bytes is not null))
    or (p_code<>'OK' and (p_output_sha256 is not null or p_output_bytes is not null))
    or (p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$')
    or (p_output_bytes is not null and p_output_bytes not between 1 and 512000) then
    return jsonb_build_object('code','INVALID_INPUT','accounting',private.ai_accounting(u));
  end if;
  v_now := clock_timestamp();
  v_digest := encode(sha256(convert_to(jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)::text,'UTF8')),'hex');
  if e.enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch') then
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
  if p_usage is null and p_code<>'OK' then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'FAILED'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest
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
      enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',enhance_settlement_digest=v_digest
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
    enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest
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

-- Scheduled expiry and retention (20260929090100 schedules it, inactive). Owners are taken skip-locked in profile
-- order. Retention: accepted-output evidence 30 days after it stopped authorising new images (pending bindings are
-- snapshots and never read it), free capacity slots one day after they end (no owner data; account deletion never
-- removes them), and probe authorisations 90 days after expiry. Output tombstones last as long as the account.
create function public.enhance_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_left integer; v_e integer; v_s integer; v_a integer;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  v_left := p_limit;
  for v_owner in
    select pr.owner_id from public.profiles pr
      where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id and u.purpose='enhancement'
        and u.charge_state='held' and u.dispatched_at<=v_now-interval '3 minutes')
      order by pr.owner_id limit p_limit for update of pr skip locked
  loop
    exit when v_left<=0;
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.enhance_expire(v_owner,v_now,least(v_left,100));
    v_left := p_limit-n;
  end loop;
  delete from private.image_enhancements where ctid in (select ctid from private.image_enhancements
    where usable_until<=v_now-interval '30 days' order by usable_until limit p_limit);
  get diagnostics v_e = row_count;
  delete from private.provider_slots where ctid in (select ctid from private.provider_slots
    where held_until<=v_now-interval '1 day' order by held_until limit p_limit);
  get diagnostics v_s = row_count;
  delete from private.enhancement_probe_authorisations where ctid in (select ctid from private.enhancement_probe_authorisations
    where expires_at<=v_now-interval '90 days' order by expires_at limit p_limit);
  get diagnostics v_a = row_count;
  return jsonb_build_object('code','OK','expired',n,'evidencePurged',v_e,'slotsPurged',v_s,'probesPurged',v_a);
end;
$$;

-- N3 operator probe authorisation (on-ledger). Service role only (plan §10), run through the approved private
-- operator channel after explicit probe-spend approval; the owner must be AI-activated for tagging. The allocation must fit the enhancement sub-limit and the
-- shared total at authorisation time and is charged on the normal ledger with no extra subtraction. Exact replay
-- returns the same receipt; any conflicting reuse of the id or approval reference fails.
create function public.enhance_probe_authorise(p_id uuid,p_owner_id uuid,p_manifest_id text,p_max_calls integer,
  p_allocation_micro bigint,p_approval_ref text,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.enhancement_probe_authorisations; s record; v_key text;
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
  select * into a from private.enhancement_probe_authorisations where id=p_id or approval_ref=p_approval_ref
    order by (id=p_id) desc limit 1 for update;
  if found then
    if a.id=p_id and a.owner_id=p_owner_id and a.manifest_id=p_manifest_id and a.max_calls=p_max_calls
      and a.allocation_micro=p_allocation_micro and a.approval_ref=p_approval_ref and a.expires_at=p_expires_at then
      return jsonb_build_object('code','OK','replayed',true,'id',a.id,'deploymentKey',a.deployment_key);
    end if;
    return jsonb_build_object('code','CONFLICT');
  end if;
  if not private.ai_owner_approved(p_owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if c.owner_id is null or not c.activated or c.enhance_manifest_id is distinct from p_manifest_id or c.enhance_max_request_micro is null
    or c.enhance_monthly_allowance_micro is null or c.enhance_max_requests_per_hour is null then
    return jsonb_build_object('code','UNCONFIGURED');
  end if;
  select deployment_key into v_key from private.provider_deployments where manifest_id=p_manifest_id;
  if v_key is null or p_expires_at<=v_now or p_expires_at>v_now+interval '7 days'
    or p_allocation_micro<c.enhance_max_request_micro then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  select * into s from private.enhance_usage(p_owner_id,v_now);
  if s.enhance_micro+p_allocation_micro>c.enhance_monthly_allowance_micro or s.total_micro+p_allocation_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','DEFER','enhanceMicro',s.enhance_micro::text,'totalMicro',s.total_micro::text);
  end if;
  insert into private.enhancement_probe_authorisations(id,owner_id,deployment_key,manifest_id,max_calls,allocation_micro,
      approval_ref,expires_at,created_at)
    values(p_id,p_owner_id,v_key,p_manifest_id,p_max_calls,p_allocation_micro,p_approval_ref,p_expires_at,v_now);
  return jsonb_build_object('code','OK','replayed',false,'id',p_id,'deploymentKey',v_key);
end;
$$;

-- Dedicated global switch for the shared deployment. Database owner only (no grants). Enabling does not activate any
-- owner: normal dispatch still needs that owner's enhance_activated and consent, probes their authorisation.
create function public.enhance_provider_control(p_deployment_key text,p_enabled boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare k private.provider_capacity; v_now timestamptz := clock_timestamp();
begin
  if p_deployment_key is null or p_enabled is null or (p_enabled and p_reason is not null)
    or (not p_enabled and p_reason is distinct from 'OPERATOR') then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  select * into k from private.provider_capacity where deployment_key=p_deployment_key for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,updated_at=v_now
      where deployment_key=p_deployment_key;
  else
    update private.provider_capacity set dispatch_enabled=false,disabled_reason='OPERATOR',
      disabled_at=coalesce(case when dispatch_enabled then null else disabled_at end,v_now),updated_at=v_now
      where deployment_key=p_deployment_key;
  end if;
  return jsonb_build_object('code','OK','dispatchEnabled',p_enabled);
end;
$$;

-- Every owner-keyed table, now including the six enhancement tables. Provider capacity and slots carry no owner
-- column and survive account deletion (N5), so a deletion never releases a live slot early.
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
    or exists(select 1 from private.enhancement_probe_authorisations where owner_id=p_owner));
$$;

revoke all on function private.enhance_allowance_clamp(),private.restore_marker_immutable(),
  private.enhancement_admission(),private.enhancement_attach(),
  private.restore_marker(uuid,uuid,uuid,uuid,text,text,uuid,text),private.image_provenance_rows(uuid),
  private.enhance_permission(public.profiles,private.ai_controls),
  private.enhance_probe_permission(public.profiles,private.ai_controls,private.enhancement_probe_authorisations,timestamptz),
  private.enhance_azure_usage(jsonb,private.ai_execution_manifests),private.enhance_expire(uuid,timestamptz,integer),
  private.enhance_usage(uuid,timestamptz),
  private.enhance_replay(private.ai_usage_evidence,private.ai_usage,public.profiles,private.ai_controls,
    private.enhancement_probe_authorisations,timestamptz),
  private.deletion_owner_rows_absent(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.reserve_restored_item_save_v2(jsonb,jsonb,uuid,text),
  public.reserve_restored_image_change(jsonb,uuid,text),public.restore_image_provenance(uuid,uuid,uuid,jsonb),
  public.image_provenance_v1(),public.image_provenance_digest_v1(),
  public.enhance_status(),public.enhance_set_consent(boolean,integer),
  public.enhance_claim(uuid,uuid,text,text,uuid),public.enhance_finish(uuid,uuid,text,jsonb,text,integer),
  public.enhance_expire_due(integer),
  public.enhance_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz),
  public.enhance_provider_control(text,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.reserve_restored_item_save_v2(jsonb,jsonb,uuid,text),
  public.reserve_restored_image_change(jsonb,uuid,text),public.restore_image_provenance(uuid,uuid,uuid,jsonb),
  public.image_provenance_v1(),public.image_provenance_digest_v1(),
  public.enhance_status(),public.enhance_set_consent(boolean,integer) to authenticated;
grant execute on function public.enhance_claim(uuid,uuid,text,text,uuid),
  public.enhance_finish(uuid,uuid,text,jsonb,text,integer),
  public.enhance_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz) to service_role;

commit;
