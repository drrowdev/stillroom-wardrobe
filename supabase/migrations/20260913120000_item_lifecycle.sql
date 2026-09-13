-- I08: ordinary-owner lifecycle; no provider calls or public row-shape changes.
begin;

create table private.item_deletion_claims (
  owner_id uuid not null,
  item_id uuid not null,
  request_id uuid not null,
  expected_version bigint not null check (expected_version between 1 and 9007199254740990),
  started_at timestamptz not null default clock_timestamp(),
  primary key (owner_id,item_id),
  unique (owner_id,request_id),
  foreign key (owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
alter table private.item_deletion_claims enable row level security;
revoke all on private.item_deletion_claims from public,anon,authenticated;

-- Pure projection: byte removal cannot change this manifest, nor can session timezone.
create function private.item_lifecycle_manifest(p_images jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(
    im->'id',im->'owner_id',im->'item_id',im->'state',im->'main_path',im->'thumb_path',
    im->'main_bytes',im->'thumb_bytes',im->'main_sha256',im->'thumb_sha256',
    im->'width',im->'height',im->'description_version'
  ) order by im->>'id'),'[]'::jsonb)::text,'UTF8')),'hex')
  from jsonb_array_elements(p_images) im;
$$;

create function private.item_lifecycle_owner() returns uuid
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid();
begin
  if u is null or not private.is_approved() then
    raise exception using errcode='42501',message='Not available';
  end if;
  perform 1 from public.profiles p where p.owner_id=u for update nowait;
  if not found or not private.is_approved() then
    raise exception using errcode='42501',message='Not available';
  end if;
  return u;
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function private.guard_item_deletion() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if exists(select 1 from private.item_deletion_claims c where c.owner_id=old.owner_id and c.item_id=old.id) then
    if tg_op='UPDATE' or exists(select 1 from storage.objects o where o.bucket_id='wardrobe'
      and starts_with(o.name,old.owner_id::text || '/' || old.id::text || '/')) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger item_deletion_guard before update or delete on public.items
for each row execute function private.guard_item_deletion();

create function private.guard_item_image_deletion() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if tg_op='INSERT' then
    -- This precedes the FK trigger: an admitted insert fences BEGIN's parent lock.
    perform 1 from public.items i where i.owner_id=new.owner_id and i.id=new.item_id for key share nowait;
    if exists(select 1 from private.item_deletion_claims c where c.owner_id=new.owner_id and c.item_id=new.item_id) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return new;
  end if;
  if exists(select 1 from private.item_deletion_claims c where c.owner_id=old.owner_id and c.item_id=old.item_id)
    and exists(select 1 from public.items i where i.owner_id=old.owner_id and i.id=old.item_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  -- The parent is absent only during the byte-checked final cascade (or already absent).
  if tg_op='DELETE' then return old; end if;
  return new;
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;
create trigger item_image_deletion_guard before insert or update or delete on public.item_images
for each row execute function private.guard_item_image_deletion();

create function private.may_create_item_object(p_name text) returns boolean
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); target uuid;
begin
  if u is null or not private.is_approved() then return false; end if;
  select im.item_id into target from public.item_images im
    where im.owner_id=u and im.state='pending' and p_name in(im.main_path,im.thumb_path);
  if not found then return false; end if;
  perform 1 from public.items i where i.owner_id=u and i.id=target for key share nowait;
  if not found then return false; end if;
  return private.is_approved()
    and exists(select 1 from public.item_images im where im.owner_id=u and im.item_id=target
      and im.state='pending' and p_name in(im.main_path,im.thumb_path))
    and not exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=target);
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;
drop policy wardrobe_create on storage.objects;
create policy wardrobe_create on storage.objects for insert to authenticated
with check (bucket_id='wardrobe' and private.may_create_item_object(name));

create function public.set_item_trashed(p_item_id uuid,p_expected_version bigint,p_trashed boolean)
returns table(id uuid,owner_id uuid,version bigint,deleted_at timestamptz)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; item public.items;
begin
  u := private.item_lifecycle_owner();
  if p_item_id is null or p_expected_version is null or p_expected_version not between 1 and 9007199254740990
    or p_trashed is null then raise exception using errcode='22023',message='Invalid input'; end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  select i.* into item from public.items i where i.owner_id=u and i.id=p_item_id for update nowait;
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  if item.version<>p_expected_version
    or exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id)
    or (p_trashed and (item.deleted_at is not null or not exists(
      select 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id and im.state='ready')))
    or (not p_trashed and (item.deleted_at is null or item.deleted_at>clock_timestamp()
      or item.deleted_at<clock_timestamp()-interval '7 days')) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return query update public.items i set deleted_at=case when p_trashed then clock_timestamp() else null end
    where i.owner_id=u and i.id=p_item_id returning i.id,i.owner_id,i.version,i.deleted_at;
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.item_deletion_status(p_item_ids uuid[])
returns table(id uuid,owner_id uuid,title text,version bigint,deleted_at timestamptz,
  photo_count bigint,current_image_id uuid,current_thumb_path text,image_manifest_sha256 text,
  cleanup_blocked boolean,unmanifested_count bigint,request_id uuid,expected_version bigint,started_at timestamptz)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid();
begin
  if u is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  if coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 40
    or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  -- All relation reads below share ONE statement snapshot. The manifest helper is pure.
  return query
    with owned as materialized (
      select i.* from public.items i where i.owner_id=u and i.id=any(p_item_ids) and private.is_approved()
    ), images as materialized (
      select im.* from public.item_images im join owned i on i.owner_id=im.owner_id and i.id=im.item_id
    )
    select i.id,i.owner_id,i.title,i.version,i.deleted_at,
      (select count(*) from images im where im.item_id=i.id),
      (select im.id from images im where im.item_id=i.id and im.state='ready'),
      (select im.thumb_path from images im where im.item_id=i.id and im.state='ready'),
      private.item_lifecycle_manifest(coalesce((select jsonb_agg(to_jsonb(im)) from images im where im.item_id=i.id),'[]'::jsonb)),
      orphan.n>0,orphan.n,c.request_id,c.expected_version,c.started_at
    from owned i left join private.item_deletion_claims c on c.owner_id=i.owner_id and c.item_id=i.id
    cross join lateral (
      select count(*) n from storage.objects o where o.bucket_id='wardrobe'
        and starts_with(o.name,u::text || '/' || i.id::text || '/')
        and not exists(select 1 from images im where im.item_id=i.id and o.name in(im.main_path,im.thumb_path))
    ) orphan order by i.id;
end;
$$;

create function public.begin_item_deletion(p_item_id uuid,p_expected_version bigint,p_request_id uuid,p_image_manifest_sha256 text)
returns table(request_id uuid,expected_version bigint,version bigint,started_at timestamptz,image_manifest_sha256 text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; item public.items; claim private.item_deletion_claims; manifest text;
begin
  u := private.item_lifecycle_owner();
  if p_item_id is null or p_request_id is null or p_expected_version is null
    or p_expected_version not between 1 and 9007199254740990
    or p_image_manifest_sha256 is null or p_image_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  select i.* into item from public.items i where i.owner_id=u and i.id=p_item_id for update nowait;
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  select private.item_lifecycle_manifest(coalesce(jsonb_agg(to_jsonb(im)),'[]'::jsonb)) into manifest
    from public.item_images im where im.owner_id=u and im.item_id=p_item_id;
  select c.* into claim from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id for update nowait;
  if found then
    if claim.request_id<>p_request_id or claim.expected_version<>p_expected_version
      or item.version<>claim.expected_version+1 or manifest<>p_image_manifest_sha256 then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return query select claim.request_id,claim.expected_version,item.version,claim.started_at,manifest;
    return;
  end if;
  if item.version<>p_expected_version or item.deleted_at is null or manifest<>p_image_manifest_sha256
    or exists(select 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id and im.state='pending')
    or exists(select 1 from storage.objects o where o.bucket_id='wardrobe'
      and starts_with(o.name,u::text || '/' || p_item_id::text || '/')
      and not exists(select 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id
        and o.name in(im.main_path,im.thumb_path))) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  update public.items i set deleted_at=i.deleted_at where i.owner_id=u and i.id=p_item_id returning i.* into item;
  insert into private.item_deletion_claims(owner_id,item_id,request_id,expected_version)
    values(u,p_item_id,p_request_id,p_expected_version) returning * into claim;
  return query select claim.request_id,claim.expected_version,item.version,claim.started_at,manifest;
exception when lock_not_available or unique_violation then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.finish_item_deletion(p_item_id uuid,p_request_id uuid)
returns table(state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; item public.items; claim private.item_deletion_claims;
begin
  u := private.item_lifecycle_owner();
  if p_item_id is null or p_request_id is null then raise exception using errcode='22023',message='Invalid input'; end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  select i.* into item from public.items i where i.owner_id=u and i.id=p_item_id for update nowait;
  if not found then return query select 'absent'::text; return; end if;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id order by im.id for update nowait;
  select c.* into claim from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id for update nowait;
  if not found or claim.request_id<>p_request_id or item.version<>claim.expected_version+1 or item.deleted_at is null then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  perform 1 from storage.objects o where o.bucket_id='wardrobe'
    and starts_with(o.name,u::text || '/' || p_item_id::text || '/') order by o.name for share nowait;
  if found then raise exception using errcode='22023',message='Request conflict'; end if;
  -- The parent UPDATE lock, not an empty Storage query, excludes admitted INSERTs.
  delete from public.items i where i.owner_id=u and i.id=p_item_id;
  return query select 'completed'::text;
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

revoke all on function private.item_lifecycle_manifest(jsonb) from public,anon,authenticated;
revoke all on function private.item_lifecycle_owner() from public,anon,authenticated;
revoke all on function private.guard_item_deletion() from public,anon,authenticated;
revoke all on function private.guard_item_image_deletion() from public,anon,authenticated;
revoke all on function private.may_create_item_object(text) from public,anon,authenticated;
grant execute on function private.may_create_item_object(text) to authenticated;
revoke all on function public.set_item_trashed(uuid,bigint,boolean) from public,anon,authenticated;
revoke all on function public.item_deletion_status(uuid[]) from public,anon,authenticated;
revoke all on function public.begin_item_deletion(uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.finish_item_deletion(uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_item_trashed(uuid,bigint,boolean) to authenticated;
grant execute on function public.item_deletion_status(uuid[]) to authenticated;
grant execute on function public.begin_item_deletion(uuid,bigint,uuid,text) to authenticated;
grant execute on function public.finish_item_deletion(uuid,uuid) to authenticated;

commit;
