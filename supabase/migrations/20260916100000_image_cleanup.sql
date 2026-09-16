-- I10a: explicit owner cleanup only; no automatic deletion or inference.
begin;

create table private.image_cleanup_claims (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  request_id uuid not null,
  item_id uuid not null,
  image_id uuid not null,
  state text not null check (state in ('active','completed')),
  kind text,
  started_at timestamptz,
  eligibility_at timestamptz,
  manifest_sha256 text,
  objects jsonb,
  primary key(owner_id,request_id),
  unique(owner_id,item_id,image_id),
  check (
    (state='active' and kind in ('pending','retired','orphan') and kind is not null
      and started_at is not null and isfinite(started_at)
      and eligibility_at is not null and isfinite(eligibility_at)
      and manifest_sha256 is not null and manifest_sha256 ~ '^[0-9a-f]{64}$'
      and objects is not null and jsonb_typeof(objects)='array'
      and jsonb_array_length(objects)<=2 and octet_length(convert_to(objects::text,'UTF8'))<=16384)
    or (state='completed' and kind is null and started_at is null and eligibility_at is null
      and manifest_sha256 is null and objects is null)
  )
);
create table private.image_cleanup_delete_context (
  owner_id uuid not null,
  request_id uuid not null,
  item_id uuid not null,
  image_id uuid not null,
  primary key(owner_id,request_id),
  foreign key(owner_id,request_id) references private.image_cleanup_claims(owner_id,request_id) on delete cascade
);
alter table private.image_cleanup_claims enable row level security;
alter table private.image_cleanup_delete_context enable row level security;
revoke all on private.image_cleanup_claims,private.image_cleanup_delete_context from public,anon,authenticated,service_role;

create function private.image_cleanup_old_enough(p_kind text,p_time timestamptz,p_now timestamptz) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(isfinite(p_time) and isfinite(p_now) and p_time<=p_now
    and case p_kind when 'pending' then timezone('UTC',p_time)<timezone('UTC',p_now)-interval '24 hours'
      when 'retired' then timezone('UTC',p_time)<timezone('UTC',p_now)-interval '7 days'
      when 'orphan' then timezone('UTC',p_time)<timezone('UTC',p_now)-interval '7 days' else false end,false);
$$;

create function private.image_cleanup_image(p_owner uuid,p_item uuid,p_image uuid) returns jsonb
language sql volatile security definer set search_path = '' as $$
  select jsonb_build_object(
    'owner_id',im.owner_id,'item_id',im.item_id,'id',im.id,'state',im.state,
    'created_at',timezone('UTC',im.created_at),'retired_at',timezone('UTC',im.retired_at),'description_version',im.description_version,
    'main_path',im.main_path,'thumb_path',im.thumb_path,'main_bytes',im.main_bytes,
    'thumb_bytes',im.thumb_bytes,'main_sha256',im.main_sha256,'thumb_sha256',im.thumb_sha256,
    'width',im.width,'height',im.height,'alt_text',im.alt_text)
  from public.item_images im where im.owner_id=p_owner and im.item_id=p_item and im.id=p_image;
$$;

create function private.image_cleanup_manifest(p_owner uuid,p_item uuid,p_image uuid,p_kind text,
  p_registered jsonb,p_objects jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object('owner_id',p_owner,'item_id',p_item,
    'image_id',p_image,'kind',p_kind,'registered',p_registered,'objects',p_objects)::text,'UTF8')),'hex');
$$;

-- This helper is private; callers supply their captured server clock.
create function private.image_cleanup_evidence(p_owner uuid,p_item uuid,p_image uuid,p_now timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare prefix text := p_owner::text || '/' || p_item::text || '/' || p_image::text || '/';
  image jsonb; objects jsonb; kind text; age timestamptz; eligible boolean := true;
  invalid boolean := false; grace boolean := false; member record;
begin
  image := private.image_cleanup_image(p_owner,p_item,p_image);
  kind := coalesce(image->>'state','orphan');
  if image is not null then
    invalid := image->>'main_path' is distinct from prefix || 'main.jpg'
      or image->>'thumb_path' is distinct from prefix || 'thumb.jpg';
    age := case kind when 'retired' then timezone('UTC',(image->>'retired_at')::timestamp)
      else timezone('UTC',(image->>'created_at')::timestamp) end;
    if kind in ('pending','retired') then
      invalid := invalid or age is null or not isfinite(age) or age>p_now;
      eligible := private.image_cleanup_old_enough(kind,age,p_now);
      grace := kind='pending' and not invalid and not eligible;
    else
      eligible := false;
    end if;
  elsif exists(select 1 from public.item_images im where im.owner_id=p_owner
    and (im.main_path in(prefix || 'main.jpg',prefix || 'thumb.jpg')
      or im.thumb_path in(prefix || 'main.jpg',prefix || 'thumb.jpg'))) then
    invalid := true;
  end if;
  objects := '[]'::jsonb;
  for member in select o.id,o.name,o.version,o.created_at from storage.objects o
    where o.bucket_id='wardrobe' and o.name in(prefix || 'main.jpg',prefix || 'thumb.jpg') order by o.name loop
    if member.id is null or member.created_at is null or not isfinite(member.created_at)
      or member.created_at>p_now or (member.version is not null
        and octet_length(convert_to(member.version,'UTF8'))>1024) then invalid := true; end if;
    objects := objects || jsonb_build_array(jsonb_build_object(
      'id',member.id,'name',member.name,'version',member.version,'created_at',timezone('UTC',member.created_at)));
    if kind='orphan' then
      eligible := eligible and private.image_cleanup_old_enough('orphan',member.created_at,p_now);
      age := greatest(age,member.created_at);
    end if;
  end loop;
  if jsonb_array_length(objects)>2 or octet_length(convert_to(objects::text,'UTF8'))>16384 then invalid := true; end if;
  if kind='orphan' and jsonb_array_length(objects)=0 then eligible := false; end if;
  return jsonb_build_object('kind',kind,'eligible',eligible and not invalid,
    'invalid',invalid,'pending_grace',grace and not invalid,'eligibility_at',age,
    'objects',objects,'object_count',jsonb_array_length(objects),
    'manifest_sha256',private.image_cleanup_manifest(p_owner,p_item,p_image,kind,image,objects));
end;
$$;

create function public.image_cleanup_page(p_after_item_id uuid default null,p_after_image_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare u uuid := auth.uid(); observed timestamptz := clock_timestamp(); target record; evidence jsonb;
  candidates jsonb := '[]'::jsonb; next_cursor jsonb := null; unsupported boolean; invalid boolean := false;
  grace boolean := false; has_more boolean := false;
begin
  if u is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  if (p_after_item_id is null)<>(p_after_image_id is null) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select exists(select 1 from storage.objects o where o.bucket_id='wardrobe' and starts_with(o.name,u::text || '/')
    and o.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(main|thumb)\.jpg$') into unsupported;
  for target in
    with canonical as materialized (
      select o.name from storage.objects o where o.bucket_id='wardrobe' and starts_with(o.name,u::text || '/')
        and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(main|thumb)\.jpg$'
    ), targets as (
      select im.item_id,im.id image_id from public.item_images im where im.owner_id=u
      union select split_part(name,'/',2)::uuid,split_part(name,'/',3)::uuid from canonical
    ) select * from targets order by item_id,image_id loop
    evidence := private.image_cleanup_evidence(u,target.item_id,target.image_id,observed);
    invalid := invalid or (evidence->>'invalid')::boolean;
    grace := grace or (evidence->>'pending_grace')::boolean;
    if (evidence->>'eligible')::boolean
      and (p_after_item_id is null or row(target.item_id,target.image_id)>row(p_after_item_id,p_after_image_id))
      and not exists(select 1 from private.image_cleanup_claims c
        where c.owner_id=u and c.item_id=target.item_id and c.image_id=target.image_id) then
      if jsonb_array_length(candidates)<20 then
        candidates := candidates || jsonb_build_array(jsonb_build_object(
          'item_id',target.item_id,'image_id',target.image_id,'kind',evidence->>'kind',
          'manifest_sha256',evidence->>'manifest_sha256','object_count',evidence->'object_count'));
        next_cursor := jsonb_build_object('item_id',target.item_id,'image_id',target.image_id);
      else
        has_more := true;
      end if;
    end if;
  end loop;
  return jsonb_build_object('owner_id',u,'observed_at',observed,'candidates',candidates,
    'next',case when has_more then next_cursor else null end,
    'review_reasons',jsonb_build_object('unsupported_paths',unsupported,'unverifiable_metadata',invalid),
    'pending_grace',grace);
end;
$$;

-- Compare accepted immutable identity separately from frozen eligibility timestamps.
create function private.image_cleanup_checked_status(p_claim private.image_cleanup_claims) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare prefix text := p_claim.owner_id::text || '/' || p_claim.item_id::text || '/' || p_claim.image_id::text || '/';
  image jsonb; member record; paths jsonb;
begin
  if p_claim.state='completed' then
    return jsonb_build_object('owner_id',p_claim.owner_id,'request_id',p_claim.request_id,
      'item_id',p_claim.item_id,'image_id',p_claim.image_id,'state','completed');
  end if;
  image := private.image_cleanup_image(p_claim.owner_id,p_claim.item_id,p_claim.image_id);
  if (p_claim.kind='orphan' and (image is not null or exists(select 1 from public.item_images im
      where im.owner_id=p_claim.owner_id and (im.main_path in(prefix || 'main.jpg',prefix || 'thumb.jpg')
        or im.thumb_path in(prefix || 'main.jpg',prefix || 'thumb.jpg')))))
    or (p_claim.kind<>'orphan' and image is null)
    or private.image_cleanup_manifest(p_claim.owner_id,p_claim.item_id,p_claim.image_id,
      p_claim.kind,image,p_claim.objects) is distinct from p_claim.manifest_sha256 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  for member in select o.id,o.name,o.version from storage.objects o
    where o.bucket_id='wardrobe' and o.name in(prefix || 'main.jpg',prefix || 'thumb.jpg') loop
    if not exists(select 1 from jsonb_array_elements(p_claim.objects) frozen
      where frozen->>'name'=member.name and (frozen->>'id')::uuid=member.id
        and frozen->>'version' is not distinct from member.version) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object('role',v.role,'path',prefix || v.role || '.jpg',
    'present',exists(select 1 from storage.objects o where o.bucket_id='wardrobe'
      and o.name=prefix || v.role || '.jpg')) order by v.position) into paths
    from (values ('main',1),('thumb',2)) v(role,position);
  return jsonb_build_object('owner_id',p_claim.owner_id,'request_id',p_claim.request_id,
    'item_id',p_claim.item_id,'image_id',p_claim.image_id,'kind',p_claim.kind,'state','active',
    'manifest_sha256',p_claim.manifest_sha256,'paths',paths);
end;
$$;

create function public.image_cleanup_status(p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare u uuid := auth.uid(); claim private.image_cleanup_claims;
begin
  if u is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  if p_request_id is null then raise exception using errcode='22023',message='Invalid input'; end if;
  select * into claim from private.image_cleanup_claims c where c.owner_id=u and c.request_id=p_request_id;
  if not found then return jsonb_build_object('owner_id',u,'request_id',p_request_id,'state','not_started'); end if;
  return private.image_cleanup_checked_status(claim);
end;
$$;

create function public.image_cleanup_claims(p_after_request_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare u uuid := auth.uid(); result jsonb; next_request uuid;
begin
  if u is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  with page as materialized (
    select c.request_id,c.item_id,c.image_id,c.kind,c.state from private.image_cleanup_claims c
    where c.owner_id=u and c.state='active' and (p_after_request_id is null or c.request_id>p_after_request_id)
    order by c.request_id limit 21
  ), visible as (select * from page order by request_id limit 20)
  select coalesce((select jsonb_agg(jsonb_build_object('request_id',v.request_id,'item_id',v.item_id,
      'image_id',v.image_id,'kind',v.kind,'state',v.state) order by v.request_id) from visible v),'[]'::jsonb),
    case when (select count(*) from page)>20 then (select request_id from visible order by request_id desc limit 1) end
    into result,next_request;
  return jsonb_build_object('owner_id',u,'claims',result,'next',next_request);
end;
$$;

create function public.begin_image_cleanup(p_request_id uuid,p_item_id uuid,p_image_id uuid,p_manifest_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; claim private.image_cleanup_claims; evidence jsonb; prefix text; observed timestamptz;
begin
  u := private.item_lifecycle_owner();
  if p_request_id is null or p_item_id is null or p_image_id is null or p_manifest_sha256 is null
    or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='Invalid input'; end if;
  prefix := u::text || '/' || p_item_id::text || '/' || p_image_id::text || '/';
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id and im.id=p_image_id for update nowait;
  perform 1 from public.items i where i.owner_id=u and i.id=p_item_id for update nowait;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=p_item_id and im.id=p_image_id for update nowait;
  perform 1 from storage.objects o where o.bucket_id='wardrobe' and o.name in(prefix || 'main.jpg',prefix || 'thumb.jpg')
    order by o.name for share nowait;
  select * into claim from private.image_cleanup_claims c where c.owner_id=u and c.request_id=p_request_id for update nowait;
  if found then
    if claim.item_id<>p_item_id or claim.image_id<>p_image_id
      or (claim.state='active' and claim.manifest_sha256<>p_manifest_sha256) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return private.image_cleanup_checked_status(claim);
  end if;
  if exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  observed := clock_timestamp();
  evidence := private.image_cleanup_evidence(u,p_item_id,p_image_id,observed);
  if not (evidence->>'eligible')::boolean or evidence->>'manifest_sha256'<>p_manifest_sha256 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  insert into private.item_image_used_ids(owner_id,image_id) values(u,p_image_id) on conflict do nothing;
  -- An in-flight raw INSERT must either own this marker first or fail its permanent-ID guard.
  evidence := private.image_cleanup_evidence(u,p_item_id,p_image_id,observed);
  if not (evidence->>'eligible')::boolean or evidence->>'manifest_sha256'<>p_manifest_sha256 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  insert into private.image_cleanup_claims(owner_id,request_id,item_id,image_id,state,kind,
    started_at,eligibility_at,manifest_sha256,objects)
    values(u,p_request_id,p_item_id,p_image_id,'active',evidence->>'kind',observed,
      (evidence->>'eligibility_at')::timestamptz,p_manifest_sha256,evidence->'objects') returning * into claim;
  if claim.kind='pending' then
    update private.ai_item_save_attempts a set cancelled=true where a.owner_id=u and a.item_id=p_item_id
      and exists(select 1 from private.item_save_attempts s where s.owner_id=u and s.item_id=p_item_id
        and s.image_id=p_image_id and s.state='reserved');
  end if;
  return private.image_cleanup_checked_status(claim);
exception when lock_not_available or unique_violation then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.finish_image_cleanup(p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; claim private.image_cleanup_claims; prefix text; checked jsonb;
begin
  u := private.item_lifecycle_owner();
  if p_request_id is null then raise exception using errcode='22023',message='Invalid input'; end if;
  select * into claim from private.image_cleanup_claims c where c.owner_id=u and c.request_id=p_request_id;
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  if claim.state='completed' then return private.image_cleanup_checked_status(claim); end if;
  prefix := u::text || '/' || claim.item_id::text || '/' || claim.image_id::text || '/';
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=claim.item_id and im.id=claim.image_id for update nowait;
  perform 1 from public.items i where i.owner_id=u and i.id=claim.item_id for update nowait;
  perform 1 from public.item_images im where im.owner_id=u and im.item_id=claim.item_id and im.id=claim.image_id for update nowait;
  perform 1 from storage.objects o where o.bucket_id='wardrobe' and o.name in(prefix || 'main.jpg',prefix || 'thumb.jpg')
    order by o.name for share nowait;
  select * into claim from private.image_cleanup_claims c where c.owner_id=u and c.request_id=p_request_id for update nowait;
  if exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=claim.item_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  checked := private.image_cleanup_checked_status(claim);
  if exists(select 1 from jsonb_array_elements(checked->'paths') p where (p->>'present')::boolean) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if claim.kind<>'orphan' then
    insert into private.image_cleanup_delete_context(owner_id,request_id,item_id,image_id)
      values(u,p_request_id,claim.item_id,claim.image_id);
    delete from public.item_images im where im.owner_id=u and im.item_id=claim.item_id and im.id=claim.image_id;
    if not found then raise exception using errcode='22023',message='Request conflict'; end if;
    delete from private.image_cleanup_delete_context c where c.owner_id=u and c.request_id=p_request_id;
  end if;
  update private.image_cleanup_claims c set state='completed',kind=null,started_at=null,eligibility_at=null,
    manifest_sha256=null,objects=null where c.owner_id=u and c.request_id=p_request_id returning * into claim;
  return private.image_cleanup_checked_status(claim);
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create or replace function private.guard_item_image_deletion() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if tg_op='INSERT' then
    perform 1 from public.items i where i.owner_id=new.owner_id and i.id=new.item_id for key share nowait;
    if exists(select 1 from private.item_deletion_claims c where c.owner_id=new.owner_id and c.item_id=new.item_id)
      or exists(select 1 from private.image_cleanup_claims c where c.owner_id=new.owner_id
        and c.item_id=new.item_id and c.image_id=new.id and c.state='active') then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return new;
  end if;
  if exists(select 1 from private.image_cleanup_claims c where c.owner_id=old.owner_id
      and c.item_id=old.item_id and c.image_id=old.id and c.state='active')
    and not (tg_op='DELETE' and exists(select 1 from private.image_cleanup_delete_context d
      join private.image_cleanup_claims c on c.owner_id=d.owner_id and c.request_id=d.request_id
      where d.owner_id=old.owner_id and d.item_id=old.item_id and d.image_id=old.id
        and c.item_id=d.item_id and c.image_id=d.image_id and c.state='active')) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if exists(select 1 from private.item_deletion_claims c where c.owner_id=old.owner_id and c.item_id=old.item_id)
    and exists(select 1 from public.items i where i.owner_id=old.owner_id and i.id=old.item_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
exception when lock_not_available then
  raise exception using errcode='22023',message='Request conflict';
end;
$$;

create or replace function private.may_create_item_object(p_name text) returns boolean
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); target uuid;
begin
  if u is null or not private.is_approved()
    or not storage.allow_only_operation('storage.object.upload') then return false; end if;
  select im.item_id into target from public.item_images im
    where im.owner_id=u and im.state='pending' and p_name in(im.main_path,im.thumb_path);
  if not found then return false; end if;
  perform 1 from public.items i where i.owner_id=u and i.id=target for key share nowait;
  if not found then return false; end if;
  return private.is_approved()
    and exists(select 1 from public.item_images im where im.owner_id=u and im.item_id=target
      and im.state='pending' and p_name in(im.main_path,im.thumb_path))
    and not exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=target)
    and not exists(select 1 from private.image_cleanup_claims c where c.owner_id=u and c.item_id=target
      and c.state='active' and p_name in(
        u::text || '/' || c.item_id::text || '/' || c.image_id::text || '/main.jpg',
        u::text || '/' || c.item_id::text || '/' || c.image_id::text || '/thumb.jpg'));
exception when lock_not_available then
  raise exception using errcode='55P03',message='The resource is locked';
end;
$$;

create or replace function private.guard_item_object_publication() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare image public.item_images; item public.items; u uuid; image_id uuid; parent_id uuid;
begin
  if tg_op='UPDATE' then
    if old.bucket_id<>'wardrobe' and new.bucket_id<>'wardrobe' then return new; end if;
    if row(new.id,new.bucket_id,new.name,new.owner,new.owner_id,new.archived_at,new.is_delete_marker,new.is_versioned)
      is distinct from row(old.id,old.bucket_id,old.name,old.owner,old.owner_id,old.archived_at,old.is_delete_marker,old.is_versioned) then
      raise exception using errcode='42501',message='Not available';
    end if;
    if new.version is distinct from old.version then
      raise exception using errcode='23505',message='The resource already exists';
    end if;
    -- Nonlocking: housekeeping must not contend with an unrelated profile-serialized Save.
    if exists(select 1 from private.image_cleanup_claims c where c.state='active'
      and new.name in(c.owner_id::text || '/' || c.item_id::text || '/' || c.image_id::text || '/main.jpg',
        c.owner_id::text || '/' || c.item_id::text || '/' || c.image_id::text || '/thumb.jpg')) then
      raise exception using errcode='42501',message='Not available';
    end if;
    return new;
  end if;
  if new.bucket_id<>'wardrobe' then return new; end if;
  select im.owner_id,im.id,im.item_id into u,image_id,parent_id
    from public.item_images im where new.name in(im.main_path,im.thumb_path);
  if not found or new.owner_id is distinct from u::text
    or (new.owner is not null and new.owner<>u)
    or new.archived_at is not null or new.is_delete_marker is distinct from false
    or new.is_versioned is distinct from false then
    raise exception using errcode='42501',message='Not available';
  end if;
  perform 1 from public.profiles p where p.owner_id=u for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  perform 1 from private.approved_accounts a where a.user_id=u for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id;
  if not exists(select 1 from public.profiles p where p.owner_id=u)
    or not exists(select 1 from private.approved_accounts a where a.user_id=u and a.enabled)
    or image.item_id is distinct from parent_id or image.state is distinct from 'pending'
    or image.retired_at is not null or new.name not in(image.main_path,image.thumb_path)
    or item.id is null or item.deleted_at is not null
    or exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=parent_id)
    or exists(select 1 from private.image_cleanup_claims c where c.owner_id=u and c.item_id=parent_id
      and c.image_id=image.id and c.state='active')
    or exists(select 1 from private.ai_item_save_attempts a where a.owner_id=u and a.item_id=parent_id and a.cancelled) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return new;
exception when lock_not_available then
  raise exception using errcode='55P03',message='The resource is locked';
end;
$$;

create or replace function public.begin_item_deletion(p_item_id uuid,p_expected_version bigint,p_request_id uuid,p_image_manifest_sha256 text)
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
  if exists(select 1 from private.image_cleanup_claims c where c.owner_id=u and c.item_id=p_item_id and c.state='active') then
    raise exception using errcode='22023',message='Request conflict';
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

revoke all on function private.image_cleanup_old_enough(text,timestamptz,timestamptz),
  private.image_cleanup_image(uuid,uuid,uuid),private.image_cleanup_manifest(uuid,uuid,uuid,text,jsonb,jsonb),
  private.image_cleanup_evidence(uuid,uuid,uuid,timestamptz),
  private.image_cleanup_checked_status(private.image_cleanup_claims) from public,anon,authenticated,service_role;
revoke all on function public.image_cleanup_page(uuid,uuid),public.begin_image_cleanup(uuid,uuid,uuid,text),
  public.image_cleanup_status(uuid),public.image_cleanup_claims(uuid),public.finish_image_cleanup(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.image_cleanup_page(uuid,uuid),public.begin_image_cleanup(uuid,uuid,uuid,text),
  public.image_cleanup_status(uuid),public.image_cleanup_claims(uuid),public.finish_image_cleanup(uuid) to authenticated;

commit;
