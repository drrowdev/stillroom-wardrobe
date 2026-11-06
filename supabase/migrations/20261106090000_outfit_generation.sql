-- OUTFITGEN1a: AI-judged outfit suggestions, backend only and INACTIVE (owner decision of 6 November 2026, ADR29). The photos
-- of a few of the owner's own garments are judged by the existing Terra deployment; only candidates built by the server are
-- judged, results are stored as suggestions the owner keeps or removes, and every judged set is remembered by the same
-- canonical key as suggestion_feedback so nothing is judged or suggested twice. Nothing is activated here: every owner keeps
-- outfitgen_activated=false, the Edge function is not deployed by this migration and no provider is called.
-- Classification: ADDITIVE (tables, columns, a manifest row, new functions) except
--   NON-ADDITIVE: the ai_usage purpose check (one more value), private.admin_account_v3 (the one purpose added to the admin
--     spending response so the history total stays right) and private.deletion_owner_rows_absent (three tables added to its
--     latest body, 20261011100000).
-- Settlement reuses the Stylist rules: a request with no usable metering stays held and is settled at its reservation by the
-- expiry job (outfitgen_expire_due, scheduled by 20261106090100 and required before the first owner trial).
begin;

alter table private.ai_usage drop constraint ai_usage_purpose_check;
alter table private.ai_usage add constraint ai_usage_purpose_check
  check (purpose in ('analysis','stylist','enhancement','try_on','outfitgen'));
create index ai_usage_outfitgen_recent on private.ai_usage(owner_id,created_at) where purpose='outfitgen';

alter table private.ai_controls
  add column outfitgen_activated boolean not null default false,
  add column outfitgen_notice_revision integer check (outfitgen_notice_revision between 1 and 2147483647),
  add column outfitgen_manifest_id text references private.ai_execution_manifests(id),
  add column outfitgen_max_request_micro bigint check (outfitgen_max_request_micro > 0),
  add column outfitgen_consent_revision integer check (outfitgen_consent_revision between 1 and 2147483647),
  add column outfitgen_consented_at timestamptz,
  add constraint ai_controls_outfitgen_settings check (not outfitgen_activated or (outfitgen_notice_revision is not null
    and outfitgen_manifest_id is not null and outfitgen_max_request_micro is not null)),
  add constraint ai_controls_outfitgen_consent_pair check ((outfitgen_consent_revision is null) = (outfitgen_consented_at is null));

-- Same model, deployment, endpoint and tariff as azure-eu-terra-stylist-v2. Reservation 373402 micro-USD values the
-- 48,000 input / 8,192 output envelope at LongCo 4.40/19.80: (48,000 x 440 + 8,192 x 1,980) / 100 = 373,401.6, rounded up.
-- Recorded usage is priced at the applicable ShortCo 2.20/13.20 and an input or output above the envelope is an anomaly.
insert into private.ai_execution_manifests values (
  'azure-eu-terra-outfitgen-v1','gpt-5.6-terra-2026-07-09',1,
  'c1e8b42a1b2f4e7ef26f4dc127a25ac545c47ef5e2479cf36bdc6786a5ce9e63',
  'a4ea301f45f5e40bbc12bf38165f24e2e1e3182f0ca556696777cd8b7ddcb1ae',
  'f9f30e0a7816b8da3d694d269036f2398c898fd6e42eb839e886b5a25b3cc08a',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-21T00:00:00Z',
  'INACTIVE outfit judging on the existing eval-terra-20260709 deployment; expected snapshot gpt-5.6-terra-2026-07-09. Applicable tariff ShortCo USD2.20 input/13.20 output per1M. Reservation 373402 micro values the 48000 input/8192 output envelope at LongCo 4.40/19.80 as a conservative allowance valuation; it is not an invoice ceiling and no typical per-call cost is claimed before the owner trial. Up to 8 garment photos (stored main JPEG, detail high, at most 3 MiB together) and enum/number/boolean item fields; no titles, notes or brands. Explicit cache mode without breakpoints; store:false is not zero retention. The Azure quota (TPM) of the deployment, the exact-route probe, the expiry schedule and paid activation remain owner gates.',
  'USD',220,1320,48000,8192,373402,512000,1600,262144,32768,75,'2099-01-01T00:00:00Z'
);

-- Suggestions. Owners may read their own rows; every write is a definer function below. A removed set is permanent (it is also
-- a disliked combination in suggestion_feedback); declined rows are a bounded judgement cache keyed by the garments' fingerprint.
create table public.suggested_outfits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  item_ids uuid[] not null check (cardinality(item_ids) between 2 and 6),
  signature text not null default '' check (signature ~ '^[0-9a-f]{64}$'), -- Derived before constraints by trigger.
  state text not null check (state in ('suggested','kept','removed','declined')),
  title text check (char_length(title) between 1 and 40),
  reason text check (char_length(reason) between 1 and 160),
  occasion text check (occasion in ('home','everyday','smart','business','formal')),
  score smallint not null check (score between 1 and 10),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  manifest_id text not null check (manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'), -- Written only by definer functions from the claimed manifest.
  prompt_version integer not null check (prompt_version between 1 and 2147483647),
  request_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  kept_outfit_id uuid,
  vote_before text check (vote_before in ('none','like','dislike')),
  vote_set_at timestamptz,
  unique(owner_id,id), unique(owner_id,signature),
  foreign key(owner_id,kept_outfit_id) references public.outfits(owner_id,id) on delete set null(kept_outfit_id),
  check ((state='declined') = (title is null and reason is null and occasion is null)),
  check (state not in ('kept','removed') or decided_at is not null),
  check ((vote_before is null) = (vote_set_at is null))
);
create index suggested_outfits_owner_state on public.suggested_outfits(owner_id,state,created_at desc,id);

-- The durable "needs assessment" marker: an eligible item without a row here has not been assessed yet.
create table private.outfit_assessed_items (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  item_id uuid not null,
  request_id uuid,
  assessed_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,item_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
-- One frozen batch per claim. Signatures and targets are emptied at settlement; the row stays for the auto-run count.
create table private.outfitgen_requests (
  owner_id uuid not null,
  request_id uuid not null,
  mode text not null check (mode in ('auto','manual')),
  signatures text[] not null,
  target_items uuid[] not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,request_id),
  foreign key(owner_id,request_id) references private.ai_usage(owner_id,request_id) on delete cascade,
  check (cardinality(signatures) <= 24 and cardinality(target_items) <= 500)
);
create index outfitgen_requests_auto on private.outfitgen_requests(owner_id,created_at) where mode='auto';
alter table public.suggested_outfits enable row level security;
alter table private.outfit_assessed_items enable row level security;
alter table private.outfitgen_requests enable row level security;
revoke all on public.suggested_outfits from public,anon,authenticated;
grant select on public.suggested_outfits to authenticated;
-- The four owner policies every public table carries; only SELECT is granted, so the others can never apply.
do $$
declare t constant text := 'suggested_outfits';
begin
  execute format('create policy owner_read on public.%I for select to authenticated using (private.is_approved() and owner_id=(select auth.uid()))',t);
  execute format('create policy owner_create on public.%I for insert to authenticated with check (private.is_approved() and owner_id=(select auth.uid()))',t);
  execute format('create policy owner_update on public.%I for update to authenticated using (private.is_approved() and owner_id=(select auth.uid())) with check (private.is_approved() and owner_id=(select auth.uid()))',t);
  execute format('create policy owner_delete on public.%I for delete to authenticated using (private.is_approved() and owner_id=(select auth.uid()))',t);
end;
$$;
revoke all on private.outfit_assessed_items,private.outfitgen_requests from public,anon,authenticated,service_role;

create function private.outfitgen_signature(p_ids uuid[]) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(array_to_string(array(select x from unnest(p_ids) x order by x),'|'),'UTF8')),'hex');
$$;

-- Identity of what was judged: each garment's category, colours, pattern, seasons, formality and current ready photo.
create function private.outfitgen_fingerprint(p_owner uuid,p_ids uuid[]) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(string_agg(i.id::text||':'||i.category||':'||coalesce(array_to_string(i.colours,','),'')
    ||':'||coalesce(i.pattern,'')||':'||coalesce(array_to_string(i.seasons,','),'')||':'||coalesce(i.formality::text,'')||':'
    ||coalesce((select im.id::text from public.item_images im where im.owner_id=i.owner_id and im.item_id=i.id
      and im.state='ready' and im.retired_at is null limit 1),''),'|' order by i.id),''),'UTF8')),'hex')
  from public.items i where i.owner_id=p_owner and i.id=any(p_ids);
$$;

-- Same ownership, distinct-id and signature rules as the suggestion_feedback trigger; the set and its signature never change.
create function private.outfitgen_row_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id or new.item_ids is distinct from old.item_ids
      or new.signature is distinct from old.signature or new.created_at is distinct from old.created_at
      or new.request_id is distinct from old.request_id then
      raise exception using errcode='42501',message='Identity is immutable';
    end if;
    return new;
  end if;
  if coalesce(cardinality(new.item_ids),0) not between 2 and 6
    or (select count(distinct x) from unnest(new.item_ids) x)<>cardinality(new.item_ids)
    or (select count(*) from public.items where owner_id=new.owner_id and id=any(new.item_ids))<>cardinality(new.item_ids)
    then raise exception 'Invalid selection'; end if;
  select array_agg(x order by x) into new.item_ids from unnest(new.item_ids) x;
  new.signature:=private.outfitgen_signature(new.item_ids);
  return new;
end;
$$;
create trigger outfitgen_row_guard before insert or update on public.suggested_outfits
for each row execute function private.outfitgen_row_guard();
create function private.outfitgen_remove_item_rows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.suggested_outfits where owner_id=old.owner_id and old.id=any(item_ids);
  return old;
end;
$$;
create trigger outfitgen_remove_item_rows after delete on public.items
for each row execute function private.outfitgen_remove_item_rows();
-- Any later write of a set's Today vote (another device, the vote writer, a delete) voids the Undo ticket of its removed suggestion,
-- so Undo can never restore an older vote over a newer one. The Remove call sets the ticket after its own vote write.
create function private.outfitgen_vote_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='DELETE' then
    update public.suggested_outfits set vote_before=null,vote_set_at=null
      where owner_id=old.owner_id and signature=old.signature and vote_before is not null;
  else
    update public.suggested_outfits set vote_before=null,vote_set_at=null
      where owner_id=new.owner_id and signature=new.signature and vote_before is not null;
  end if;
  return null;
end;
$$;
create trigger outfitgen_vote_changed after insert or update or delete on public.suggestion_feedback
for each row execute function private.outfitgen_vote_changed();

-- The one eligibility contract: saved, active, ready, not excluded, not an accessory, a ready photo, no deletion in progress.
create function private.outfitgen_eligible(p_owner uuid,p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  select exists(select 1 from public.items i where i.id=p_id and i.owner_id=p_owner and i.deleted_at is null
    and i.lifecycle='active' and i.availability='ready' and not i.exclude_suggestions and i.category<>'accessory'
    and exists(select 1 from public.item_images im where im.owner_id=i.owner_id and im.item_id=i.id
      and im.state='ready' and im.retired_at is null)
    and not exists(select 1 from private.item_deletion_claims d where d.owner_id=i.owner_id and d.item_id=i.id)
    and not private.image_change_fenced(i.owner_id,i.id));
$$;

-- A valid outfit: distinct eligible garments forming top+bottom+footwear or one-piece+footwear, at most one layer and one
-- outerwear, no avoided pair and not a disliked set. Only validity and the owner's explicit bans are enforced here.
create function private.outfitgen_valid_set(p_owner uuid,p_ids uuid[]) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare c record;
begin
  if p_ids is null or cardinality(p_ids) not between 2 and 6 or (select count(distinct x) from unnest(p_ids) x)<>cardinality(p_ids) then
    return false;
  end if;
  if exists(select 1 from unnest(p_ids) x where not private.outfitgen_eligible(p_owner,x)) then return false; end if;
  select count(*) filter (where category='top') t,count(*) filter (where category='bottom') b,count(*) filter (where category='one_piece') o,
    count(*) filter (where category='footwear') f,count(*) filter (where category='layer') l,count(*) filter (where category='outerwear') w
    into c from public.items where owner_id=p_owner and id=any(p_ids);
  if not (c.f=1 and ((c.o=1 and c.t=0 and c.b=0) or (c.t=1 and c.b=1 and c.o=0)) and c.l<=1 and c.w<=1) then return false; end if;
  if exists(select 1 from public.combination_rules r where r.owner_id=p_owner and r.item_low=any(p_ids) and r.item_high=any(p_ids)) then
    return false;
  end if;
  if exists(select 1 from public.suggestion_feedback f where f.owner_id=p_owner and f.vote=-1
    and f.signature=private.outfitgen_signature(p_ids)) then return false; end if;
  return true;
end;
$$;

-- Already judged, suggested, removed, disliked or saved (including an outfit in Trash).
create function private.outfitgen_known(p_owner uuid,p_signature text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.suggested_outfits where owner_id=p_owner and signature=p_signature)
    or exists(select 1 from public.suggestion_feedback where owner_id=p_owner and vote=-1 and signature=p_signature)
    or exists(select 1 from (select encode(sha256(convert_to(string_agg(oi.item_id::text,'|' order by oi.item_id),'UTF8')),'hex') s
      from public.outfit_items oi where oi.owner_id=p_owner group by oi.outfit_id) o where o.s=p_signature);
$$;

create function private.outfitgen_permission(p_profile public.profiles,p_controls private.ai_controls) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.outfitgen_manifest_id is null then 'UNCONFIGURED'
    when not p_controls.outfitgen_activated then 'INACTIVE'
    when p_controls.outfitgen_consent_revision is distinct from p_controls.outfitgen_notice_revision then 'CONSENT_REQUIRED'
    else 'OK' end;
$$;

-- Provisional expiry: a held outfitgen row six minutes after dispatch is estimated at its reservation, its frozen batch is
-- emptied, and the failure starts the cooldown. A later valid finish may replace the estimate but never records suggestions.
create function private.outfitgen_expire(p_owner uuid,p_now timestamptz,p_limit integer) returns integer
language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  with due as (
    select request_id from private.ai_usage
      where owner_id=p_owner and purpose='outfitgen' and charge_state='held' and dispatched_at<=p_now-interval '6 minutes'
      order by dispatched_at,request_id limit least(greatest(coalesce(p_limit,0),0),100) for update
  ), closed as (
    update private.ai_usage u set charge_state='estimated',accounted_micro=u.reserved_micro,closed_reason='EXPIRED',closed_at=p_now
      from due where u.owner_id=p_owner and u.request_id=due.request_id returning u.request_id
  ), emptied as (
    update private.outfitgen_requests r set signatures='{}',target_items='{}' from closed
      where r.owner_id=p_owner and r.request_id=closed.request_id returning r.request_id
  )
  update private.ai_usage_evidence e set anomaly=true,stylist_code='EXPIRED',settlement_origin='provisional_expiry'
    from closed where e.owner_id=p_owner and e.request_id=closed.request_id and e.settlement_origin is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.outfitgen_expire_due(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; n integer := 0; v_left integer;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  v_left := p_limit;
  for v_owner in
    select pr.owner_id from public.profiles pr
      where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id and u.purpose='outfitgen'
        and u.charge_state='held' and u.dispatched_at<=v_now-interval '6 minutes')
      order by pr.owner_id limit p_limit for update of pr skip locked
  loop
    exit when v_left<=0;
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.outfitgen_expire(v_owner,v_now,least(v_left,100));
    v_left := p_limit-n;
  end loop;
  return jsonb_build_object('code','OK','expired',n);
end;
$$;

-- Owner status. Counts are for the badge and for deciding whether an automatic run may start; they never write.
create function public.outfitgen_status() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_used numeric; v_policy jsonb := null;
  v_pending integer; v_new integer; v_auto integer; v_cool timestamptz; v_auto_calls integer; v_live boolean;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if found then perform private.outfitgen_expire(p.owner_id,v_now,100); end if;
  if not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if c.owner_id is not null and c.outfitgen_manifest_id is not null then
    v_policy := jsonb_build_object('activated',c.outfitgen_activated,'noticeRevision',c.outfitgen_notice_revision,
      'manifestId',c.outfitgen_manifest_id,'modelId',(select model_id from private.ai_execution_manifests where id=c.outfitgen_manifest_id),
      'maxRequestMicro',c.outfitgen_max_request_micro::text);
  end if;
  select count(*) into v_pending from public.suggested_outfits s where s.owner_id=p.owner_id and s.state='suggested'
    and private.outfitgen_valid_set(s.owner_id,s.item_ids);
  select count(*) filter (where true),count(*) filter (where c.outfitgen_consented_at is not null and i.created_at>=c.outfitgen_consented_at)
    into v_new,v_auto from public.items i
    where i.owner_id=p.owner_id and private.outfitgen_eligible(i.owner_id,i.id)
      and not exists(select 1 from private.outfit_assessed_items a where a.owner_id=i.owner_id and a.item_id=i.id);
  select max(closed_at)+interval '15 minutes' into v_cool from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen'
    and closed_reason in ('FAILED','EXPIRED','UNAVAILABLE');
  select count(*) into v_auto_calls from private.outfitgen_requests where owner_id=p.owner_id and mode='auto'
    and created_at>v_now-interval '6 hours';
  select exists(select 1 from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen' and charge_state='held'
    and dispatched_at>v_now-interval '6 minutes') into v_live;
  return jsonb_build_object('code',private.outfitgen_permission(p,c),'period',to_char(v_now at time zone 'UTC','YYYY-MM'),
    'serverTimeMs',floor(extract(epoch from v_now)*1000)::bigint,
    'consent',jsonb_build_object('enabled',c.outfitgen_consent_revision is not null,'noticeRevision',c.outfitgen_consent_revision,
      'consentedAt',c.outfitgen_consented_at),
    'policy',v_policy,
    'budget',case when c.owner_id is null then null else private.ai_budget_json(c.monthly_allowance_micro,v_used) end,
    'pending',v_pending,'unassessed',coalesce(v_new,0),'autoUnassessed',coalesce(v_auto,0),
    'autoCallsLeft',greatest(0,3-v_auto_calls),'live',v_live,
    'cooldownUntilMs',case when v_cool is not null and v_cool>v_now then floor(extract(epoch from v_cool)*1000)::bigint end);
end;
$$;

create function public.outfitgen_set_consent(p_enabled boolean,p_notice_revision integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_enabled is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  if p_enabled and not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  if p_enabled then
    if c.outfitgen_notice_revision is null then return jsonb_build_object('code','UNCONFIGURED'); end if;
    if p_notice_revision is distinct from c.outfitgen_notice_revision then return jsonb_build_object('code','CONFIG_CHANGED'); end if;
    update private.ai_controls set outfitgen_consent_revision=p_notice_revision,outfitgen_consented_at=clock_timestamp(),
      updated_at=clock_timestamp() where owner_id=p.owner_id;
  else
    update private.ai_controls set outfitgen_consent_revision=null,outfitgen_consented_at=null,updated_at=clock_timestamp()
      where owner_id=p.owner_id;
  end if;
  return public.outfitgen_status();
end;
$$;

-- Plan (service role, read-mostly, no hold): the owner's eligible garments with photo identity and assessment flags, the
-- explicit bans and every known signature. Judgements whose garments changed since (fingerprint) are dropped first, so they
-- can be judged again; owner removals are never dropped.
create function public.outfitgen_plan(p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_code text; v_items jsonb; v_pairs jsonb; v_disliked jsonb; v_known jsonb;
begin
  select * into p from public.profiles where owner_id=p_owner_id;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id;
  v_code := private.outfitgen_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  -- A judgement is dropped, and may be made again, when what was judged changed or when a newer prompt version exists (the cache is
  -- versioned and bounded); an owner's removal is never dropped.
  delete from public.suggested_outfits s where s.owner_id=p_owner_id and s.state in ('suggested','declined')
    and ((exists(select 1 from public.items i where i.owner_id=s.owner_id and i.id=any(s.item_ids) and i.updated_at>s.created_at)
      or exists(select 1 from public.item_images im where im.owner_id=s.owner_id and im.item_id=any(s.item_ids)
        and im.state='ready' and im.created_at>s.created_at))
      and s.fingerprint is distinct from private.outfitgen_fingerprint(s.owner_id,s.item_ids)
      or s.state='declined' and s.prompt_version<(select m.prompt_version from private.ai_execution_manifests m where m.id=c.outfitgen_manifest_id));
  -- Anchors are chosen apart from the partner pool: up to 100 unassessed garments added since consent (what automatic runs may
  -- assess), up to 100 other unassessed ones (manual runs), oldest first, so a pre-consent backlog never hides a new garment and
  -- coverage stays eventual. The rest of the 500 is a partner pool taken from every other eligible garment (unassessed ones
  -- included), rotating daily rather than a fixed prefix.
  select coalesce(jsonb_agg(x.j order by x.id),'[]'::jsonb) into v_items from (
    select i.id,jsonb_build_object('id',i.id,'category',i.category,'colours',to_jsonb(i.colours),'pattern',i.pattern,
      'sleeve_length',i.sleeve_length,'garment_length',i.garment_length,'seasons',to_jsonb(i.seasons),'formality',i.formality,
      'warmth',case when i.field_provenance->'warmth'->>'kind'='user' then i.warmth end,
      'upper_coverage',i.upper_coverage,
      'lower_coverage',case when i.field_provenance->'lower_coverage'->>'kind' in ('user','ai_observed') then i.lower_coverage end,
      'favourite',i.favourite,
      'unassessed',not exists(select 1 from private.outfit_assessed_items a where a.owner_id=i.owner_id and a.item_id=i.id),
      'auto',c.outfitgen_consented_at is not null and i.created_at>=c.outfitgen_consented_at
        and not exists(select 1 from private.outfit_assessed_items a where a.owner_id=i.owner_id and a.item_id=i.id),
      'coverage',(select count(*) from public.outfit_items oi where oi.owner_id=i.owner_id and oi.item_id=i.id)
        +(select count(*) from public.suggested_outfits s where s.owner_id=i.owner_id and i.id=any(s.item_ids)),
      'image',jsonb_build_object('path',im.main_path,'sha256',im.main_sha256,'bytes',im.main_bytes)) j
    from public.items i
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready' and im.retired_at is null
    where i.owner_id=p_owner_id and i.id in (
      with pool as (
        select ei.id,ei.created_at,case when exists(select 1 from private.outfit_assessed_items a where a.owner_id=ei.owner_id and a.item_id=ei.id) then 2
          when c.outfitgen_consented_at is not null and ei.created_at>=c.outfitgen_consented_at then 0 else 1 end grp
        from public.items ei where ei.owner_id=p_owner_id and private.outfitgen_eligible(ei.owner_id,ei.id)),
      ranked as (
        select pool.id,pool.grp,row_number() over (partition by pool.grp
          order by case when pool.grp<2 then pool.created_at end,md5(pool.id::text||current_date::text),pool.id) rn from pool),
      anchors as (select r.id from ranked r where r.grp<2 and r.rn<=100)
      select a.id from anchors a
      union
      (select r.id from ranked r where r.id not in (select id from anchors)
        order by md5(r.id::text||current_date::text),r.id limit 500-(select count(*) from anchors))
    )) x;
  select coalesce(jsonb_agg(jsonb_build_array(r.item_low,r.item_high)),'[]'::jsonb) into v_pairs
    from public.combination_rules r where r.owner_id=p_owner_id;
  select coalesce(jsonb_agg(to_jsonb(f.item_ids)),'[]'::jsonb) into v_disliked from (
    select item_ids from public.suggestion_feedback where owner_id=p_owner_id and vote=-1 order by id limit 2000) f;
  select coalesce(jsonb_agg(k.s),'[]'::jsonb) into v_known from (
    select signature s from public.suggested_outfits where owner_id=p_owner_id
    union select signature from public.suggestion_feedback where owner_id=p_owner_id and vote=-1
    union select encode(sha256(convert_to(string_agg(oi.item_id::text,'|' order by oi.item_id),'UTF8')),'hex')
      from public.outfit_items oi where oi.owner_id=p_owner_id group by oi.outfit_id
    limit 20000) k;
  return jsonb_build_object('code','OK','items',v_items,'pairs',v_pairs,'disliked',v_disliked,'known',v_known,
    'pendingRoom',greatest(0,40-(select count(*) from public.suggested_outfits where owner_id=p_owner_id and state='suggested')));
end;
$$;

-- Marks items assessed without any provider call (they have no candidate to judge, or every one is already known).
create function public.outfitgen_assess(p_owner_id uuid,p_items uuid[]) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_code text; n integer;
begin
  select * into p from public.profiles where owner_id=p_owner_id;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id;
  v_code := private.outfitgen_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  if p_items is null or cardinality(p_items)>500 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  insert into private.outfit_assessed_items(owner_id,item_id)
    select p_owner_id,i.id from public.items i where i.owner_id=p_owner_id and i.deleted_at is null and i.id=any(p_items)
    on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('code','OK','assessed',n);
end;
$$;

-- Claim: one LIVE batch per owner (the lock only lasts for the transaction, so a live held row is what serialises devices),
-- the claimed signatures are frozen for settlement, pending capacity and every cap are checked here, and the reservation is held.
create function public.outfitgen_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_auto boolean,p_signatures text[],
  p_targets uuid[]) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  v_period text; v_hour integer; v_day integer; v_ten integer; s text;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  v_code := private.outfitgen_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null or p_auto is null or p_signatures is null or cardinality(p_signatures) not between 1 and 24
    or (select count(distinct x) from unnest(p_signatures) x)<>cardinality(p_signatures)
    or exists(select 1 from unnest(p_signatures) x where x is null or x!~'^[0-9a-f]{64}$')
    or p_targets is null or cardinality(p_targets)>500 or array_position(p_targets,null) is not null then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-eu-terra-outfitgen-v1' then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if c.outfitgen_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.outfitgen_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.outfitgen_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen' and charge_state='held'
    and dispatched_at>v_now-interval '6 minutes') then return jsonb_build_object('code','BUSY','claimed',false); end if;
  select count(*) filter (where created_at>v_now-interval '1 hour'),count(*) filter (where created_at>v_now-interval '1 day'),
    count(*) filter (where created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten
    from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen';
  if v_hour>=6 or v_day>=40 or v_ten>=4 then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;
  if p_auto then
    if exists(select 1 from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen'
      and closed_reason in ('FAILED','EXPIRED','UNAVAILABLE') and closed_at>v_now-interval '15 minutes')
      or (select count(*) from private.outfitgen_requests where owner_id=p.owner_id and mode='auto'
        and created_at>v_now-interval '6 hours')>=3 then return jsonb_build_object('code','COOLDOWN','claimed',false); end if;
  end if;
  if (select count(*) from public.suggested_outfits where owner_id=p.owner_id and state='suggested')>=40 then
    return jsonb_build_object('code','PENDING_FULL','claimed',false);
  end if;
  if private.ai_budget_used(p.owner_id,v_now)+c.outfitgen_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  foreach s in array p_signatures loop
    if private.outfitgen_known(p.owner_id,s) then return jsonb_build_object('code','CONFLICT','claimed',false); end if;
  end loop;
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,purpose)
    values(p.owner_id,p_request_id,v_period,v_now,c.outfitgen_max_request_micro,c.outfitgen_max_request_micro,'held',v_now,'outfitgen');
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation)
    values(p.owner_id,p_request_id,m.id,'not_observed');
  insert into private.outfitgen_requests(owner_id,request_id,mode,signatures,target_items)
    values(p.owner_id,p_request_id,case when p_auto then 'auto' else 'manual' end,p_signatures,p_targets);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '60 seconds')*1000)::bigint);
end;
$$;

-- Records the judged sets and the assessed items of one settled request. Every row is validated again against the frozen
-- claim and the current state; a row that is stale, duplicate, banned or over capacity is skipped on its own. It never raises
-- to the caller of finish as a whole (finish wraps it), so accounting is never rolled back by a suggestion problem.
create function private.outfitgen_record(p_owner uuid,p_request uuid,p_results jsonb,p_assessed uuid[],m private.ai_execution_manifests)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare q private.outfitgen_requests; r record; v_room integer; v_ids uuid[]; v_sig text; v_seen text[] := '{}';
  v_s integer := 0; v_d integer := 0; v_a integer := 0;
begin
  select * into q from private.outfitgen_requests where owner_id=p_owner and request_id=p_request;
  if not found or p_results is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>24 then
    return jsonb_build_object('suggested',0,'declined',0,'assessed',0);
  end if;
  select 40-count(*) into v_room from public.suggested_outfits where owner_id=p_owner and state='suggested';
  for r in select t.e,t.ord from jsonb_array_elements(p_results) with ordinality t(e,ord)
    order by case when jsonb_typeof(t.e)='object' and (t.e->>'score') ~ '^[0-9]{1,2}$' then (t.e->>'score')::integer else 0 end desc,t.ord
  loop
    begin
      if jsonb_typeof(r.e)<>'object' or r.e->>'decision' not in ('suggested','declined') then continue; end if;
      v_ids := array(select x::uuid from jsonb_array_elements_text(r.e->'items') x);
      v_sig := private.outfitgen_signature(v_ids);
      if not v_sig=any(q.signatures) or v_sig=any(v_seen) then continue; end if;
      v_seen := v_seen||v_sig;
      if private.outfitgen_known(p_owner,v_sig) or not private.outfitgen_valid_set(p_owner,v_ids) then continue; end if;
      if r.e->>'decision'='suggested' then
        if v_room<=0 then continue; end if;
        insert into public.suggested_outfits(owner_id,item_ids,state,title,reason,occasion,score,fingerprint,manifest_id,prompt_version,request_id)
          values(p_owner,v_ids,'suggested',r.e->>'title',r.e->>'reason',r.e->>'occasion',(r.e->>'score')::smallint,
            private.outfitgen_fingerprint(p_owner,v_ids),m.id,m.prompt_version,p_request);
        v_room := v_room-1; v_s := v_s+1;
      else
        insert into public.suggested_outfits(owner_id,item_ids,state,score,fingerprint,manifest_id,prompt_version,request_id)
          values(p_owner,v_ids,'declined',(r.e->>'score')::smallint,private.outfitgen_fingerprint(p_owner,v_ids),m.id,m.prompt_version,p_request);
        v_d := v_d+1;
      end if;
    exception when others then null;
    end;
  end loop;
  delete from public.suggested_outfits where owner_id=p_owner and state='declined' and id in (
    select id from public.suggested_outfits where owner_id=p_owner and state='declined' order by created_at desc,id offset 5000);
  if p_assessed is not null and cardinality(p_assessed)<=500 then
    insert into private.outfit_assessed_items(owner_id,item_id,request_id)
      select p_owner,i.id,p_request from public.items i where i.owner_id=p_owner and i.deleted_at is null
        and i.id=any(p_assessed) and i.id=any(q.target_items)
      on conflict do nothing;
    get diagnostics v_a = row_count;
  end if;
  return jsonb_build_object('suggested',v_s,'declined',v_d,'assessed',v_a);
end;
$$;

create function private.outfitgen_replay(e private.ai_usage_evidence,u private.ai_usage,p public.profiles,c private.ai_controls)
returns text language sql stable set search_path = '' as $$
  select case
    when e.settlement_origin='non_dispatch' then 'NOT_DISPATCHED'
    when e.settlement_origin='terminal_anomaly' and e.normalized_usage is null and e.stylist_code in ('FAILED','FILTERED') then e.stylist_code
    when e.settlement_origin='terminal_anomaly' and e.normalized_usage is null then 'INVALID_USAGE'
    when e.settlement_origin='terminal_anomaly' then 'USAGE_ANOMALY'
    when u.closed_reason='EXPIRED' then 'EXPIRED'
    when e.stylist_code in ('FAILED','FILTERED') then e.stylist_code
    when c.outfitgen_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE'
    else private.outfitgen_permission(p,c) end;
$$;

-- Finish: idempotent, purpose-checked and conflict-safe, with the Stylist precedence (invalid usage, then a bad model or control
-- observation, then an envelope overrun, then a valid settlement). A FAILED or FILTERED outcome with no usable metering keeps
-- the whole reservation (nothing proves zero billing) without switching the feature off; unreadable usage on a reply that did
-- arrive does switch it off, as for the Stylist. Suggestions are recorded only for a valid OK settlement while consent holds,
-- inside their own subtransaction, so a recording problem never undoes the accounting.
create function public.outfitgen_finish(p_owner_id uuid,p_request_id uuid,p_code text,p_usage jsonb,p_results jsonb,p_assessed uuid[])
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence; m private.ai_execution_manifests;
  v_now timestamptz; v_digest text; o record; v_code text; v_accounted bigint; v_recorded jsonb := null;
begin
  begin
    perform 1 from private.approved_accounts where user_id=p_owner_id for share;
    select * into p from public.profiles where owner_id=p_owner_id for update;
    if not found then return jsonb_build_object('code','UNAVAILABLE','accounting',null); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update;
    select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id for update;
    select * into e from private.ai_usage_evidence where owner_id=p_owner_id and request_id=p_request_id for update;
  exception when lock_not_available then return jsonb_build_object('code','BUSY','accounting',null);
  end;
  if u.owner_id is null or u.purpose<>'outfitgen' or e.owner_id is null then
    return jsonb_build_object('code','INVALID_INPUT','accounting',null);
  end if;
  if p_code is null or p_code not in ('OK','FAILED','FILTERED','NOT_DISPATCHED') or (p_code='NOT_DISPATCHED' and p_usage is not null)
    or (p_code='OK' and p_usage is null) or (p_code<>'OK' and (p_results is not null or p_assessed is not null))
    or (p_code='OK' and (p_results is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>24
      or (p_assessed is not null and cardinality(p_assessed)>500))) then
    return jsonb_build_object('code','INVALID_INPUT','accounting',private.ai_accounting(u));
  end if;
  v_now := clock_timestamp();
  v_digest := encode(sha256(convert_to(jsonb_build_object('code',p_code,'usage',p_usage,'results',p_results,
    'assessed',to_jsonb(p_assessed))::text,'UTF8')),'hex');
  if e.settlement_origin in ('observed','terminal_anomaly','non_dispatch') then
    if e.settlement_digest<>v_digest then return jsonb_build_object('code','USAGE_CONFLICT','accounting',private.ai_accounting(u)); end if;
    return jsonb_build_object('code',private.outfitgen_replay(e,u,p,c),'replayed',true,'accounting',private.ai_accounting(u));
  end if;
  if p_code='NOT_DISPATCHED' then
    if u.charge_state='held' then
      update private.ai_usage set charge_state='estimated',closed_reason='UNAVAILABLE',closed_at=v_now
        where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    end if;
    update private.ai_usage_evidence set stylist_code='NOT_DISPATCHED',settlement_origin='non_dispatch',settlement_digest=v_digest,anomaly=false
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.outfitgen_requests set signatures='{}',target_items='{}' where owner_id=p_owner_id and request_id=p_request_id;
    return jsonb_build_object('code','NOT_DISPATCHED','accounting',private.ai_accounting(u));
  end if;
  if p_usage is null then
    if u.charge_state='held' then
      update private.ai_usage set charge_state='estimated',closed_reason='FAILED',closed_at=v_now
        where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    end if;
    update private.ai_usage_evidence set stylist_code=p_code,settlement_origin='terminal_anomaly',settlement_digest=v_digest,anomaly=true
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.outfitgen_requests set signatures='{}',target_items='{}' where owner_id=p_owner_id and request_id=p_request_id;
    return jsonb_build_object('code',p_code,'accounting',private.ai_accounting(u));
  end if;
  select * into m from private.ai_execution_manifests where id=e.manifest_id;
  select * into o from private.stylist_azure_usage(p_usage,m);
  if not o.valid or o.bad or o.over then
    v_accounted := case when not o.valid then u.reserved_micro when o.bad then greatest(o.estimate,u.reserved_micro) else o.estimate end;
    update private.ai_usage set charge_state='estimated',accounted_micro=v_accounted,
      closed_reason=coalesce(closed_reason,case when not o.valid then 'FAILED' else 'UNAVAILABLE' end),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set normalized_usage=case when o.valid then p_usage end,estimated_micro=case when o.valid then o.estimate end,
      anomaly=true,model_observation=coalesce(o.model,model_observation),control_observation=o.control,stylist_code=p_code,
      settlement_origin='terminal_anomaly',settlement_digest=v_digest
      where owner_id=p_owner_id and request_id=p_request_id;
    update private.ai_controls set outfitgen_activated=false,updated_at=v_now where owner_id=p_owner_id;
    update private.outfitgen_requests set signatures='{}',target_items='{}' where owner_id=p_owner_id and request_id=p_request_id;
    return jsonb_build_object('code',case when not o.valid then 'INVALID_USAGE' else 'USAGE_ANOMALY' end,'accounting',private.ai_accounting(u));
  end if;
  v_code := case when u.closed_reason='EXPIRED' then 'EXPIRED' when p_code in ('FAILED','FILTERED') then p_code
    when c.outfitgen_manifest_id is distinct from e.manifest_id then 'UNAVAILABLE' else private.outfitgen_permission(p,c) end;
  update private.ai_usage set charge_state='estimated',accounted_micro=o.estimate,
    closed_reason=case when closed_reason is not null then closed_reason when v_code='OK' then null
      when v_code in ('FAILED','FILTERED') then 'FAILED' else 'UNAVAILABLE' end,
    closed_at=case when closed_at is not null then closed_at when v_code='OK' then null else v_now end
    where owner_id=p_owner_id and request_id=p_request_id returning * into u;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=o.estimate,anomaly=false,model_observation=o.model,
    control_observation=o.control,stylist_code=p_code,settlement_origin='observed',settlement_digest=v_digest
    where owner_id=p_owner_id and request_id=p_request_id;
  if v_code='OK' and p_code='OK' then
    begin
      v_recorded := private.outfitgen_record(p_owner_id,p_request_id,p_results,p_assessed,m);
    exception when others then
      v_recorded := jsonb_build_object('suggested',0,'declined',0,'assessed',0,'failed',true);
    end;
  end if;
  update private.outfitgen_requests set signatures='{}',target_items='{}' where owner_id=p_owner_id and request_id=p_request_id;
  return jsonb_build_object('code',v_code,'accounting',private.ai_accounting(u),'recorded',v_recorded);
end;
$$;

-- Owner list: suggestions that are still valid outfits of eligible garments (laundry, archive, trash or an edit that breaks the
-- outfit hide a row without any paid reassessment). Newest first, at most 40.
create function public.outfitgen_list() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  return jsonb_build_object('code','OK','suggestions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'itemIds',to_jsonb(s.item_ids),
    'title',s.title,'reason',s.reason,'occasion',s.occasion,'score',s.score,'createdAt',s.created_at) order by s.created_at desc,s.id)
    from public.suggested_outfits s where s.owner_id=v_owner and s.state='suggested'
      and private.outfitgen_valid_set(s.owner_id,s.item_ids)),'[]'::jsonb));
end;
$$;

-- Keep: rechecks eligibility, bans and duplicates NOW, then creates the normal outfit through save_outfit in the same
-- transaction. The outfit id is chosen by the client, so a retry with the same id is a replay.
create function public.outfitgen_keep(p_id uuid,p_outfit_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid := auth.uid(); s public.suggested_outfits; v_ordered uuid[]; v_existing uuid; v_existing_deleted timestamptz; v_ids uuid[];
begin
  if v_owner is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  if p_id is null or p_outfit_id is null then return jsonb_build_object('code','INVALID_INPUT'); end if;
  select item_ids into v_ids from public.suggested_outfits where id=p_id and owner_id=v_owner;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  -- The garments are locked in the order set_item_trashed uses (photos, then the garment), so a trash that has not committed
  -- either finishes first (and the recheck below sees it) or is refused; the suggestion row is locked afterwards.
  perform 1 from public.item_images im where im.owner_id=v_owner and im.item_id=any(v_ids) order by im.item_id,im.id for share;
  perform 1 from public.items i where i.owner_id=v_owner and i.id=any(v_ids) order by i.id for share;
  select * into s from public.suggested_outfits where id=p_id and owner_id=v_owner for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if s.state='kept' then
    return case when s.kept_outfit_id is not distinct from p_outfit_id then jsonb_build_object('code','OK','outfitId',s.kept_outfit_id,'replayed',true)
      else jsonb_build_object('code','CONFLICT') end;
  end if;
  if s.state<>'suggested' then return jsonb_build_object('code','CONFLICT'); end if;
  if not private.outfitgen_valid_set(v_owner,s.item_ids) then return jsonb_build_object('code','STALE'); end if;
  select o.id,o.deleted_at into v_existing,v_existing_deleted from public.outfits o where o.owner_id=v_owner
    and private.outfitgen_signature(array(select oi.item_id from public.outfit_items oi where oi.outfit_id=o.id))=s.signature
    order by o.deleted_at nulls first limit 1;
  if v_existing is not null and v_existing_deleted is null then
    update public.suggested_outfits set state='kept',kept_outfit_id=v_existing,decided_at=clock_timestamp() where id=s.id;
    return jsonb_build_object('code','OK','outfitId',v_existing,'duplicate',true);
  elsif v_existing is not null then
    -- The same set is already saved and sits in Trash: no second outfit; the suggestion becomes a judged set that is never offered again.
    update public.suggested_outfits set state='declined',title=null,reason=null,occasion=null,decided_at=null where id=s.id;
    return jsonb_build_object('code','IN_TRASH');
  end if;
  select array_agg(i.id order by array_position(array['top','bottom','one_piece','layer','outerwear','footwear'],i.category),i.id)
    into v_ordered from public.items i where i.owner_id=v_owner and i.id=any(s.item_ids);
  begin
    perform public.save_outfit(p_outfit_id,s.title,s.occasion,s.reason,false,v_ordered);
  exception when others then return jsonb_build_object('code','CONFLICT');
  end;
  update public.suggested_outfits set state='kept',kept_outfit_id=p_outfit_id,decided_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('code','OK','outfitId',p_outfit_id);
exception when lock_not_available or deadlock_detected then
  return jsonb_build_object('code','BUSY');
end;
$$;

-- Remove: permanent. It also records the existing disliked-combination vote, so Today stops showing this exact set too; the
-- vote that was there before and when this call wrote it are kept so Undo can restore it only if nothing changed since.
-- Lock order everywhere (the Today vote writer, its outfitgen_vote_changed trigger, Remove and Undo): the vote row first, then the
-- suggestion row. A lock timeout or deadlock is answered BUSY, never raised.
create function public.outfitgen_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid := auth.uid(); s public.suggested_outfits; f public.suggestion_feedback; v_now timestamptz := clock_timestamp();
  v_before text; v_signature text;
begin
  if v_owner is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select signature into v_signature from public.suggested_outfits where id=p_id and owner_id=v_owner;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  select * into f from public.suggestion_feedback where owner_id=v_owner and signature=v_signature for update;
  v_before := case when not found then 'none' when f.vote=1 then 'like' else 'dislike' end;
  select * into s from public.suggested_outfits where id=p_id and owner_id=v_owner for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if s.state='removed' then return jsonb_build_object('code','OK','replayed',true); end if;
  if s.state<>'suggested' then return jsonb_build_object('code','CONFLICT'); end if;
  insert into public.suggestion_feedback(owner_id,item_ids,vote,created_at) values(v_owner,s.item_ids,-1,v_now)
    on conflict (owner_id,signature) do update set vote=-1,created_at=v_now;
  update public.suggested_outfits set state='removed',decided_at=v_now,vote_before=v_before,vote_set_at=v_now where id=s.id;
  return jsonb_build_object('code','OK');
exception when lock_not_available or deadlock_detected then
  return jsonb_build_object('code','BUSY');
end;
$$;

create function public.outfitgen_undo_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid := auth.uid(); s public.suggested_outfits; f public.suggestion_feedback; v_signature text; v_found boolean;
begin
  if v_owner is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select signature into v_signature from public.suggested_outfits where id=p_id and owner_id=v_owner;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  select * into f from public.suggestion_feedback where owner_id=v_owner and signature=v_signature for update;
  v_found := found;
  select * into s from public.suggested_outfits where id=p_id and owner_id=v_owner for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if s.state='suggested' then return jsonb_build_object('code','OK','replayed',true); end if;
  if s.state<>'removed' then return jsonb_build_object('code','CONFLICT'); end if;
  -- The ticket (vote_before) is cleared by outfitgen_vote_changed whenever anyone writes this set's vote after the Remove,
  -- so a surviving ticket proves the dislike is still the one this Remove wrote.
  if s.vote_before is null or not v_found or f.vote<>-1 then return jsonb_build_object('code','CONFLICT'); end if;
  if s.vote_before='none' then delete from public.suggestion_feedback where id=f.id;
  elsif s.vote_before='like' then update public.suggestion_feedback set vote=1 where id=f.id; end if;
  update public.suggested_outfits set state='suggested',decided_at=null,vote_before=null,vote_set_at=null where id=s.id;
  return jsonb_build_object('code','OK');
exception when lock_not_available or deadlock_detected then
  return jsonb_build_object('code','BUSY');
end;
$$;

-- The spending history total must include the new purpose (the admin parser sums the purposes it knows).
create or replace function private.admin_account_v3(a private.approved_accounts,p_now timestamptz,p_months text[]) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v jsonb := private.admin_account_v2(a,p_now,p_months); c private.ai_controls; k text; cur jsonb := '{}'::jsonb;
begin
  select * into c from private.ai_controls where owner_id=a.user_id;
  v := jsonb_set(v,'{limits}',case when c.owner_id is null then 'null'::jsonb
    else jsonb_build_object('monthlyAllowanceMicro',c.monthly_allowance_micro::text) end);
  foreach k in array array['shared','analysis','stylist','enhancement','tryOn'] loop
    cur := cur||jsonb_build_object(k,jsonb_build_object('usedMicro',v#>>array['current',k,'usedMicro']));
  end loop;
  cur := cur||jsonb_build_object('outfitGen',jsonb_build_object('usedMicro',(select coalesce(sum(accounted_micro) filter (
    where period=to_char(p_now at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held')),0)::text
    from private.ai_usage where owner_id=a.user_id and purpose='outfitgen')));
  v := jsonb_set(v,'{features,outfitGen}',jsonb_build_object('configured',c.outfitgen_max_request_micro is not null,
    'activated',coalesce(c.outfitgen_activated,false)));
  v := jsonb_set(v,'{history}',(select jsonb_agg(h||jsonb_build_object('outfitGen',private.admin_month(a.user_id,h->>'month','outfitgen'))
    order by n) from jsonb_array_elements(v->'history') with ordinality x(h,n)));
  return jsonb_set(v,'{current}',jsonb_build_object('period',v#>>'{current,period}')||cur);
end;
$$;

-- The latest body (20261011100000) plus the three new owner-keyed tables.
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
    or exists(select 1 from private.tryon_chain_stops where owner_id=p_owner)
    or exists(select 1 from private.tryon_person_photos where owner_id=p_owner)
    or exists(select 1 from public.suggested_outfits where owner_id=p_owner)
    or exists(select 1 from private.outfit_assessed_items where owner_id=p_owner)
    or exists(select 1 from private.outfitgen_requests where owner_id=p_owner));
$$;

revoke all on function private.outfitgen_signature(uuid[]),private.outfitgen_fingerprint(uuid,uuid[]),private.outfitgen_row_guard(),
  private.outfitgen_remove_item_rows(),private.outfitgen_vote_changed(),private.outfitgen_eligible(uuid,uuid),private.outfitgen_valid_set(uuid,uuid[]),
  private.outfitgen_known(uuid,text),private.outfitgen_permission(public.profiles,private.ai_controls),
  private.outfitgen_expire(uuid,timestamptz,integer),
  private.outfitgen_record(uuid,uuid,jsonb,uuid[],private.ai_execution_manifests),
  private.outfitgen_replay(private.ai_usage_evidence,private.ai_usage,public.profiles,private.ai_controls)
  from public,anon,authenticated,service_role;
revoke all on function public.outfitgen_status(),public.outfitgen_set_consent(boolean,integer),public.outfitgen_list(),
  public.outfitgen_keep(uuid,uuid),public.outfitgen_remove(uuid),public.outfitgen_undo_remove(uuid),
  public.outfitgen_plan(uuid),public.outfitgen_assess(uuid,uuid[]),
  public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[]),public.outfitgen_finish(uuid,uuid,text,jsonb,jsonb,uuid[]),
  public.outfitgen_expire_due(integer) from public,anon,authenticated,service_role;
grant execute on function public.outfitgen_status(),public.outfitgen_set_consent(boolean,integer),public.outfitgen_list(),
  public.outfitgen_keep(uuid,uuid),public.outfitgen_remove(uuid),public.outfitgen_undo_remove(uuid) to authenticated;
grant execute on function public.outfitgen_plan(uuid),public.outfitgen_assess(uuid,uuid[]),
  public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[]),public.outfitgen_finish(uuid,uuid,text,jsonb,jsonb,uuid[]) to service_role;

commit;
