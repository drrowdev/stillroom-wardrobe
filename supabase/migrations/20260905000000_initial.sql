-- Stillroom Wardrobe / schema revision 1.1 / 2026-09-05
-- Apply ONCE as migration administrator to a NEW Supabase project.
-- Requires Supabase-managed auth.users, auth.uid(), storage.buckets/objects,
-- roles anon, authenticated and service_role. Never run as a browser user.
-- Contains the MVP schema only. Trips are deliberately absent.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- Two independent approved accounts; admission numbers enforce capacity only. No account relationship exists.
create table private.approved_accounts (
  admission_no smallint primary key check (admission_no in (1,2)),
  email text not null unique check (email = lower(btrim(email)) and position('@' in email)>1),
  user_id uuid unique references auth.users(id) on delete set null,
  enabled boolean not null default false
);
alter table private.approved_accounts enable row level security;
revoke all on private.approved_accounts from public, anon, authenticated;

-- A resumable deletion receipt must survive removal of the Auth row. Purge after 7 days.
create table private.deletion_jobs (
  owner_id uuid primary key,
  stage text not null check (stage in ('freeze','storage','rows','auth','complete','failed')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 10),
  last_code text check (last_code in ('UPSTREAM_UNAVAILABLE','RETRY_REQUIRED'))
);
alter table private.deletion_jobs enable row level security;
revoke all on private.deletion_jobs from public,anon,authenticated;

create function private.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.approved_accounts s
    where s.user_id = (select auth.uid()) and s.enabled);
$$;

-- Serializes concurrent signups for an email; rejects a third or uninvited user.
create function private.check_admission() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s private.approved_accounts;
begin
  select * into s from private.approved_accounts
    where email = lower(btrim(new.email)) for update;
  if not found or s.user_id is not null then
    raise exception using errcode='42501', message='Account not available';
  end if;
  return new;
end;
$$;
create trigger stillroom_admission before insert on auth.users
for each row execute function private.check_admission();

create table public.profiles (
  owner_id uuid primary key default auth.uid()
    references private.approved_accounts(user_id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 60),
  ui_language text check (ui_language in ('en','fi','sv')), -- NULL until the owner's first language choice.
  timezone text not null default 'Europe/Helsinki',
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  weather_enabled boolean not null default false,
  weather_city text check (length(weather_city)<=100),
  latitude numeric(4,1) check (latitude between -90 and 90),
  longitude numeric(4,1) check (longitude between -180 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  check ((latitude is null) = (longitude is null))
);
create table public.style_preferences (
  owner_id uuid primary key default auth.uid()
    references public.profiles(owner_id) on delete cascade,
  preferred_colours text[] not null default '{}' check (cardinality(preferred_colours)<=8),
  style_tags text[] not null default '{}' check (cardinality(style_tags)<=8),
  excluded_categories text[] not null default '{}' check (cardinality(excluded_categories)<=7),
  minimum_upper_coverage smallint not null default 0 check (minimum_upper_coverage between 0 and 2),
  minimum_lower_coverage smallint not null default 0 check (minimum_lower_coverage between 0 and 2),
  cold_sensitivity smallint not null default 0 check (cold_sensitivity between -2 and 2),
  repeat_gap_days smallint not null default 2 check (repeat_gap_days between 0 and 14),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1
);

create function private.finish_admission() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n smallint;
begin
  update private.approved_accounts set user_id=new.id, enabled=true
    where email=lower(btrim(new.email)) and user_id is null returning admission_no into n;
  if n is null then raise exception 'Account not available'; end if;
  insert into public.profiles(owner_id,display_name)
    values(new.id, 'Me');
  insert into public.style_preferences(owner_id) values(new.id);
  return new;
end;
$$;
create trigger stillroom_finish_admission after insert on auth.users
for each row execute function private.finish_admission();

create function private.check_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(btrim(new.email)) is distinct from lower(btrim(old.email))
     and not exists(select 1 from private.approved_accounts
       where user_id=old.id and email=lower(btrim(new.email))) then
    raise exception using errcode='42501', message='Account not available';
  end if;
  return new;
end;
$$;
create trigger stillroom_email before update of email on auth.users
for each row execute function private.check_email_change();

create table public.items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(owner_id) on delete cascade,
  title text not null check (length(title) between 1 and 100),
  category text not null check (category in ('top','bottom','one_piece','footwear','layer','outerwear','accessory')),
  subcategory text check (length(subcategory)<=60),
  colours text[] not null default '{unknown}' check (cardinality(colours) between 1 and 3),
  brand text check (length(brand)<=100),
  size_label text check (length(size_label)<=50),
  material text check (length(material)<=200),
  seasons text[] not null default '{spring,summer,autumn,winter}'
    check (cardinality(seasons) between 1 and 4 and seasons <@ array['spring','summer','autumn','winter']::text[]),
  formality smallint not null default 1 check (formality between 0 and 4),
  warmth smallint not null default 1 check (warmth between 0 and 4),
  min_temp smallint check (min_temp between -40 and 50),
  max_temp smallint check (max_temp between -40 and 50),
  rain_rating smallint not null default 0 check (rain_rating between 0 and 2),
  windproof boolean not null default false,
  upper_coverage smallint not null default 0 check (upper_coverage between 0 and 2),
  lower_coverage smallint not null default 0 check (lower_coverage between 0 and 2),
  style_tags text[] not null default '{}' check (cardinality(style_tags)<=8),
  tags text[] not null default '{}' check (cardinality(tags)<=12 and octet_length(array_to_string(tags,','))<=512),
  purchase_date date,
  purchase_price numeric(12,2) check (purchase_price>=0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  notes text not null default '' check (length(notes)<=4000),
  favourite boolean not null default false,
  availability text not null default 'ready' check (availability in ('ready','laundry','repair','lent')),
  lifecycle text not null default 'active' check (lifecycle in ('active','archived','donated','sold')),
  exclude_suggestions boolean not null default false,
  wear_more boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  unique(owner_id,id),
  check (min_temp is null or max_temp is null or min_temp<=max_temp)
);
create index items_owner_live on public.items(owner_id,category,created_at desc,id) where deleted_at is null;
create index items_owner_title on public.items(owner_id,lower(title));
create index items_owner_deleted on public.items(owner_id,deleted_at) where deleted_at is not null;

create table public.item_images (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(owner_id) on delete cascade,
  item_id uuid not null,
  state text not null default 'pending' check (state in ('pending','ready','retired')),
  retired_at timestamptz,
  main_path text generated always as
    (owner_id::text || '/' || item_id::text || '/' || id::text || '/main.jpg') stored,
  thumb_path text generated always as
    (owner_id::text || '/' || item_id::text || '/' || id::text || '/thumb.jpg') stored,
  main_bytes integer not null check (main_bytes between 1 and 512000),
  thumb_bytes integer not null check (thumb_bytes between 1 and 61440),
  main_sha256 text not null check (main_sha256 ~ '^[0-9a-f]{64}$'),
  thumb_sha256 text not null check (thumb_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width between 1 and 1600),
  height integer not null check (height between 1 and 1600),
  alt_text text not null check (length(alt_text) between 1 and 240),
  created_at timestamptz not null default now(),
  unique(owner_id,id), unique(main_path), unique(thumb_path),
  check ((state='retired')=(retired_at is not null)),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
create unique index image_one_ready on public.item_images(item_id) where state='ready';
create index images_item on public.item_images(owner_id,item_id,state);
create index images_cleanup on public.item_images(owner_id,state,created_at);
create index images_retired_cleanup on public.item_images(owner_id,retired_at) where state='retired';

create table public.outfits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(owner_id) on delete cascade,
  title text not null check (length(title) between 1 and 100),
  occasion text not null default 'everyday' check (length(occasion)<=60),
  notes text not null default '' check (length(notes)<=2000),
  favourite boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1,
  unique(owner_id,id)
);
create index outfits_owner on public.outfits(owner_id,created_at desc,id) where deleted_at is null;
create table public.outfit_items (
  owner_id uuid not null default auth.uid(),
  outfit_id uuid not null, item_id uuid not null,
  position smallint not null check (position between 0 and 11),
  primary key(outfit_id,item_id), unique(outfit_id,position),
  foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
create index outfit_items_owner on public.outfit_items(owner_id,item_id);

-- Planned and actually worn records access a schema; only 'worn' enters statistics.
create table public.wear_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(owner_id) on delete cascade,
  outfit_id uuid,
  local_date date not null,
  timezone text not null default 'Europe/Helsinki',
  state text not null default 'planned' check (state in ('planned','worn')),
  label text not null default 'Daily outfit' check (length(label) between 1 and 100),
  deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1,
  unique(owner_id,id),
  foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete set null(outfit_id)
);
create index wear_owner_date on public.wear_events(owner_id,local_date desc,id) where deleted_at is null;
create table public.wear_event_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  event_id uuid not null, item_id uuid,
  import_id uuid,
  title_snapshot text not null check (length(title_snapshot) between 1 and 100),
  category_snapshot text not null check (length(category_snapshot)<=40),
  foreign key(owner_id,event_id) references public.wear_events(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete set null(item_id),
  unique(event_id,item_id)
);
create index wear_items_owner_item on public.wear_event_items(owner_id,item_id,event_id);

create table public.combination_rules (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid(),
  item_low uuid not null, item_high uuid not null,
  created_at timestamptz not null default now(),
  check (item_low < item_high), unique(owner_id,item_low,item_high),
  foreign key(owner_id,item_low) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,item_high) references public.items(owner_id,id) on delete cascade
);
create table public.suggestion_feedback (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(owner_id) on delete cascade,
  item_ids uuid[] not null check (cardinality(item_ids) between 1 and 12),
  signature text not null default '' check (signature ~ '^[0-9a-f]{64}$'), -- Derived before constraints by trigger.
  vote smallint not null check (vote in (-1,1)),
  created_at timestamptz not null default now(),
  unique(owner_id,signature)
);

-- Keep exact-combination feedback portable when restore remaps item UUIDs.
create function private.feedback_signature() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(cardinality(new.item_ids),0) not between 1 and 12
    or (select count(distinct x) from unnest(new.item_ids) x)<>cardinality(new.item_ids)
    or (select count(*) from public.items where owner_id=new.owner_id and id=any(new.item_ids))<>cardinality(new.item_ids)
    then raise exception 'Invalid selection'; end if;
  select array_agg(x order by x) into new.item_ids from unnest(new.item_ids) x;
  new.signature:=encode(sha256(convert_to(array_to_string(new.item_ids,'|'),'UTF8')),'hex');
  return new;
end;
$$;
create trigger feedback_signature before insert or update on public.suggestion_feedback
for each row execute function private.feedback_signature();
create function private.remove_item_feedback() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.suggestion_feedback where owner_id=old.owner_id and old.id=any(item_ids);
  return old;
end;
$$;
create trigger remove_item_feedback after delete on public.items
for each row execute function private.remove_item_feedback();

-- Historical snapshots are populated from owner records, never caller-supplied titles.
create function private.wear_snapshot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.items;
begin
  if tg_op='INSERT' and new.item_id is null and new.import_id is null then raise exception 'Invalid input'; end if;
  if new.item_id is not null then
    select * into i from public.items where id=new.item_id and owner_id=new.owner_id;
    if not found then raise exception using errcode='42501',message='Not available'; end if;
    if tg_op='INSERT' and new.import_id is not null then
      return new; -- Only the checked restore RPC may set import_id on INSERT.
    elsif tg_op='INSERT' or new.item_id is distinct from old.item_id then
      new.title_snapshot:=i.title; new.category_snapshot:=i.category;
    else
      new.title_snapshot:=old.title_snapshot; new.category_snapshot:=old.category_snapshot;
    end if;
  elsif tg_op='UPDATE' then
    new.title_snapshot:=old.title_snapshot; new.category_snapshot:=old.category_snapshot;
  end if;
  return new;
end;
$$;
create trigger wear_snapshot before insert or update on public.wear_event_items
for each row execute function private.wear_snapshot();

create function private.touch_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
    or (to_jsonb(new)->>'id') is distinct from (to_jsonb(old)->>'id') then
    raise exception using errcode='42501',message='Identity is immutable';
  end if;
  new.created_at:=old.created_at; new.updated_at:=now(); new.version:=old.version+1;
  return new;
end;
$$;
create function private.valid_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
    raise exception 'Invalid timezone';
  end if;
  if tg_table_name='wear_events' and (to_jsonb(new)->>'state')='worn'
    and (to_jsonb(new)->>'local_date')::date > (now() at time zone new.timezone)::date then
    raise exception 'A future plan cannot count as worn';
  end if;
  return new;
end;
$$;
create trigger profile_timezone before insert or update on public.profiles
for each row execute function private.valid_timezone();
create trigger event_timezone before insert or update on public.wear_events
for each row execute function private.valid_timezone();

-- Multi-row writes are atomic, executed with the caller's RLS permissions.
create function public.save_outfit(p_id uuid,p_title text,p_occasion text,p_notes text,
  p_favourite boolean,p_item_ids uuid[],p_expected_version bigint default null) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare o public.outfits; existing_ids uuid[]; v bigint;
begin
  if not private.is_approved() or coalesce(cardinality(p_item_ids),0) not between 1 and 12
     or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids)
     or (select count(*) from public.items where id=any(p_item_ids) and owner_id=auth.uid())<>cardinality(p_item_ids) then
    raise exception 'Invalid selection';
  end if;
  select * into o from public.outfits where id=p_id for update;
  if found and p_expected_version is null then
    select array_agg(item_id order by position) into existing_ids from public.outfit_items where outfit_id=p_id;
    if o.title=p_title and o.occasion=p_occasion and o.notes=p_notes and o.favourite=p_favourite
       and existing_ids=p_item_ids and o.deleted_at is null then return o.version; end if;
    raise exception 'Request conflict';
  elsif found then
    if o.version<>p_expected_version or o.deleted_at is not null then raise exception 'Request conflict'; end if;
    update public.outfits set title=p_title,occasion=p_occasion,notes=p_notes,favourite=p_favourite
      where id=p_id returning version into v;
  else
    if p_expected_version is not null then raise exception 'Request conflict'; end if;
    insert into public.outfits(id,title,occasion,notes,favourite)
      values(p_id,p_title,p_occasion,p_notes,p_favourite) returning version into v;
  end if;
  delete from public.outfit_items where outfit_id=p_id;
  insert into public.outfit_items(owner_id,outfit_id,item_id,position)
    select auth.uid(),p_id,x.id,(x.ord-1)::smallint from unnest(p_item_ids) with ordinality x(id,ord);
  return v;
end;
$$;
create function public.save_wear_event(p_id uuid,p_local_date date,p_timezone text,p_state text,
  p_label text,p_outfit_id uuid,p_item_ids uuid[],p_expected_version bigint default null) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare e public.wear_events; existing_ids uuid[]; sorted_ids uuid[]; v bigint;
begin
  if not private.is_approved() or coalesce(cardinality(p_item_ids),0) not between 1 and 12
    or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids)
    or (select count(*) from public.items where id=any(p_item_ids) and owner_id=auth.uid()
         and deleted_at is null)<>cardinality(p_item_ids) then raise exception 'Invalid selection'; end if;
  select array_agg(x order by x) into sorted_ids from unnest(p_item_ids) x;
  select * into e from public.wear_events where id=p_id for update;
  if found and p_expected_version is null then
    select array_agg(item_id order by item_id) into existing_ids from public.wear_event_items where event_id=p_id and item_id is not null;
    if e.local_date=p_local_date and e.timezone=p_timezone and e.state=p_state and e.label=p_label
       and e.outfit_id is not distinct from p_outfit_id and existing_ids=sorted_ids and e.deleted_at is null
       then return e.version; end if;
    raise exception 'Request conflict';
  elsif found then
    if e.version<>p_expected_version or e.deleted_at is not null then raise exception 'Request conflict'; end if;
    update public.wear_events set local_date=p_local_date,timezone=p_timezone,state=p_state,label=p_label,outfit_id=p_outfit_id
      where id=p_id returning version into v;
  else
    if p_expected_version is not null then raise exception 'Request conflict'; end if;
    insert into public.wear_events(id,local_date,timezone,state,label,outfit_id)
      values(p_id,p_local_date,p_timezone,p_state,p_label,p_outfit_id) returning version into v;
  end if;
  delete from public.wear_event_items where event_id=p_id and item_id is not null and not(item_id=any(p_item_ids));
  insert into public.wear_event_items(owner_id,event_id,item_id)
    select auth.uid(),p_id,x from unnest(p_item_ids) x on conflict(event_id,item_id) do nothing;
  return v;
end;
$$;

-- Exact read/create/update/delete ownership rules on all private application tables.
do $$
declare t text;
begin
  foreach t in array array['profiles','style_preferences','items','item_images','outfits','outfit_items',
    'wear_events','wear_event_items','combination_rules','suggestion_feedback'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to authenticated',t);
    execute format('create policy owner_read on public.%I for select to authenticated using (private.is_approved() and owner_id=(select auth.uid()))',t);
    execute format('create policy owner_create on public.%I for insert to authenticated with check (private.is_approved() and owner_id=(select auth.uid()))',t);
    execute format('create policy owner_update on public.%I for update to authenticated using (private.is_approved() and owner_id=(select auth.uid())) with check (private.is_approved() and owner_id=(select auth.uid()))',t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (private.is_approved() and owner_id=(select auth.uid()))',t);
  end loop;
  foreach t in array array['profiles','style_preferences','items','outfits','wear_events'] loop
    execute format('create trigger touch_record before update on public.%I for each row execute function private.touch_record()',t);
  end loop;
end;
$$;
-- Profiles are provisioned by the auth trigger; account removal uses the recovery workflow.
revoke insert, delete on public.profiles from authenticated;
revoke insert,update on public.wear_event_items from authenticated;
grant insert(id,owner_id,event_id,item_id,title_snapshot,category_snapshot)
  on public.wear_event_items to authenticated;
-- Immutability also protects image paths/hashes and image identity.
revoke update on public.item_images from authenticated;
revoke insert on public.item_images from authenticated;
grant insert(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
  on public.item_images to authenticated;
-- Image DELETE is restricted to a checked RPC, after object bytes have been removed.
revoke delete on public.item_images from authenticated;

create function public.commit_image(p_image_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare im public.item_images;
begin
  if not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  select * into im from public.item_images where id=p_image_id and owner_id=auth.uid() for update;
  if not found then raise exception 'Not available'; end if;
  perform 1 from public.items where id=im.item_id and owner_id=auth.uid() for update;
  if im.state='ready' then return; end if;
  if im.state<>'pending' then raise exception 'Request conflict'; end if;
  if (select count(*) from storage.objects where bucket_id='wardrobe'
       and name in (im.main_path,im.thumb_path))<>2 then raise exception 'Upload incomplete'; end if;
  update public.item_images set state='retired',retired_at=now() where item_id=im.item_id and owner_id=auth.uid() and state='ready';
  update public.item_images set state='ready',retired_at=null where id=im.id;
end;
$$;
-- Restore can register a historical version without replacing the active photo.
create function public.retire_image(p_image_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare im public.item_images;
begin
  if not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  select * into im from public.item_images where id=p_image_id and owner_id=auth.uid() for update;
  if not found then raise exception 'Not available'; end if;
  perform 1 from public.items where id=im.item_id and owner_id=auth.uid() for update;
  if im.state='retired' then return; end if;
  if (select count(*) from storage.objects where bucket_id='wardrobe' and name in(im.main_path,im.thumb_path))<>2
    then raise exception 'Upload incomplete'; end if;
  update public.item_images set state='retired',retired_at=now() where id=im.id;
end;
$$;
create function public.forget_image(p_image_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  -- Call after Storage.remove has succeeded for both objects. A missing object is already removed.
  if exists(select 1 from public.item_images im join storage.objects o
    on o.bucket_id='wardrobe' and o.name in(im.main_path,im.thumb_path)
    where im.id=p_image_id and im.owner_id=auth.uid()) then raise exception 'Remove files first'; end if;
  delete from public.item_images where id=p_image_id and owner_id=auth.uid();
end;
$$;

-- One MVCC statement captures metadata consistently. Photos remain separate immutable files.
create function public.export_manifest(p_export_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when private.is_approved() then jsonb_build_object(
    'schema_version',1,'export_id',p_export_id,'owner_id',auth.uid(),'created_at',statement_timestamp(),
    'tables',jsonb_build_object(
      'profiles',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.profiles t where owner_id=auth.uid()),
      'style_preferences',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.style_preferences t where owner_id=auth.uid()),
      'items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.items t where owner_id=auth.uid()),
      'item_images',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.item_images t where owner_id=auth.uid()),
      'outfits',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfits t where owner_id=auth.uid()),
      'outfit_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfit_items t where owner_id=auth.uid()),
      'wear_events',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_events t where owner_id=auth.uid()),
      'wear_event_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_event_items t where owner_id=auth.uid()),
      'combination_rules',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.combination_rules t where owner_id=auth.uid()),
      'suggestion_feedback',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.suggestion_feedback t where owner_id=auth.uid())
    )) else null end;
$$;

create function public.restore_history_entry(p_id uuid,p_event_id uuid,p_item_id uuid,
  p_title text,p_category text,p_import_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.wear_event_items;
begin
  if not private.is_approved() or p_import_id is null
    or not exists(select 1 from public.wear_events where id=p_event_id and owner_id=auth.uid())
    or (p_item_id is not null and not exists(select 1 from public.items where id=p_item_id and owner_id=auth.uid())) then
    raise exception using errcode='42501',message='Not available';
  end if;
  select * into e from public.wear_event_items where id=p_id;
  if found then
    if e.owner_id=auth.uid() and e.event_id=p_event_id and e.item_id is not distinct from p_item_id
      and e.title_snapshot=p_title and e.category_snapshot=p_category and e.import_id=p_import_id then return; end if;
    raise exception 'Request conflict';
  end if;
  insert into public.wear_event_items(id,owner_id,event_id,item_id,title_snapshot,category_snapshot,import_id)
    values(p_id,auth.uid(),p_event_id,p_item_id,p_title,p_category,p_import_id);
end;
$$;

-- Server-only RPC; Edge derives p_owner_id from verified user identity, never request JSON.
-- No authenticated/anon EXECUTE grant. Service tools can also resume a failed deletion.
create function public.deletion_control(p_owner_id uuid,p_action text,p_code text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j private.deletion_jobs;
begin
  if p_action='begin' then
    if not exists(select 1 from private.approved_accounts where user_id=p_owner_id)
      and not exists(select 1 from private.deletion_jobs where owner_id=p_owner_id) then raise exception 'Not available'; end if;
    insert into private.deletion_jobs(owner_id,stage) values(p_owner_id,'freeze') on conflict(owner_id) do nothing;
    select * into j from private.deletion_jobs where owner_id=p_owner_id for update;
    if j.stage='complete' then return to_jsonb(j); end if;
    update private.approved_accounts set enabled=false where user_id=p_owner_id;
    update private.deletion_jobs set stage='storage',attempts=attempts+1,last_code=null where owner_id=p_owner_id;
  elsif p_action='storage_removed' then
    select * into j from private.deletion_jobs where owner_id=p_owner_id for update;
    if j.stage<>'storage' then raise exception 'Request conflict'; end if;
    if exists(select 1 from storage.objects where bucket_id='wardrobe' and split_part(name,'/',1)=p_owner_id::text)
      then raise exception 'Remove files first'; end if;
    update private.deletion_jobs set stage='rows' where owner_id=p_owner_id;
    delete from public.profiles where owner_id=p_owner_id;
    update private.deletion_jobs set stage='auth' where owner_id=p_owner_id;
  elsif p_action='auth_removed' then
    if exists(select 1 from auth.users where id=p_owner_id) then raise exception 'Remove identity first'; end if;
    update private.deletion_jobs set stage='complete',completed_at=now(),last_code=null where owner_id=p_owner_id;
  elsif p_action='failed' then
    update private.deletion_jobs set stage='failed',last_code=p_code where owner_id=p_owner_id;
  elsif p_action<>'status' then raise exception 'Invalid action';
  end if;
  select * into j from private.deletion_jobs where owner_id=p_owner_id;
  return to_jsonb(j);
end;
$$;

-- Storage keys are reserved in the database before upload. No arbitrary filenames or upserts; images are accessible only by their owner.
create function private.owns_storage_path(p_name text, p_pending boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_approved() and exists(select 1 from public.item_images im
    where im.owner_id=auth.uid() and p_name in(im.main_path,im.thumb_path)
      and (not p_pending or im.state='pending'));
$$;
create function private.may_delete_storage(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_approved() and split_part(p_name,'/',1)=auth.uid()::text
    and p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(main|thumb)\.jpg$';
$$;
-- Reject additive policies that could silently defeat this model in an existing project.
do $$ begin
  if exists(select 1 from pg_catalog.pg_policies where schemaname='storage' and tablename='objects') then
    raise exception 'Expected new project with no Storage policies; review existing policies first';
  end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('wardrobe','wardrobe',false,512000,array['image/jpeg']);
create policy wardrobe_read on storage.objects for select to authenticated
  using(bucket_id='wardrobe' and private.owns_storage_path(name,false));
create policy wardrobe_create on storage.objects for insert to authenticated
  with check(bucket_id='wardrobe' and private.owns_storage_path(name,true));
create policy wardrobe_delete on storage.objects for delete to authenticated
  using(bucket_id='wardrobe' and private.may_delete_storage(name));
-- UPDATE has no policy: use a new image UUID for every replacement.
-- Supabase owns storage table privileges and its RLS enablement; do not disable it.

-- Remove default function execution; allowlist the only callable public RPCs/helpers.
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on all functions in schema public from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_approved(),
  private.owns_storage_path(text,boolean),private.may_delete_storage(text) to authenticated;
grant execute on function public.commit_image(uuid),public.retire_image(uuid),public.forget_image(uuid),
  public.save_outfit(uuid,text,text,text,boolean,uuid[],bigint),
  public.save_wear_event(uuid,date,text,text,text,uuid,uuid[],bigint),public.export_manifest(uuid),
  public.restore_history_entry(uuid,uuid,uuid,text,text,uuid) to authenticated;
-- Service credentials are used only for narrow, authenticated Edge operations and provisioning.
grant usage on schema public,private to service_role;
grant all on all tables in schema public,private to service_role;
grant execute on all functions in schema public,private to service_role;
commit;

-- SEED APPROACH (not executed): operator reserves exactly two lower-case emails BEFORE
-- creating Auth users with the admin API. Never put real emails/passwords in migrations.
-- insert into private.approved_accounts(admission_no,email) values
--   (1,'user-a@example.test'),(2,'user-b@example.test');
-- Use scripts/provision-test-users.mjs only against a disposable local Supabase stack.
-- Normal user sessions then insert fictional items; see validation/security-sessions.mjs.
