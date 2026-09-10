-- Checked manual Save only. No analysis, legacy adoption or provider authority.
begin;

create table private.item_save_used_ids (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  item_id uuid not null,
  image_id uuid not null,
  primary key(owner_id,item_id),
  unique(owner_id,image_id)
);
comment on table private.item_save_used_ids is
  'Minimal pseudonymous retry guard until profile deletion: three UUIDs only; never add timestamps or content.';
alter table private.item_save_used_ids enable row level security;
revoke all on private.item_save_used_ids from public,anon,authenticated;

alter table public.item_images add constraint item_images_owned_item_identity unique(owner_id,item_id,id);
create table private.item_save_attempts (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  item_id uuid not null,
  image_id uuid,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  state text not null default 'reserved' check (state in ('reserved','completed')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key(owner_id,item_id),
  unique(owner_id,image_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id,image_id) references public.item_images(owner_id,item_id,id)
    on delete set null(image_id),
  check ((state='completed')=(completed_at is not null))
);
alter table private.item_save_attempts enable row level security;
revoke all on private.item_save_attempts from public,anon,authenticated;

-- One projection for validated intent and locked live rows; no duplicate stored values.
create function private.item_save_fingerprint(p_item public.items,p_image public.item_images) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'item',to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at'],
    'image',to_jsonb(p_image)-array['created_at','state','retired_at','description_version','main_path','thumb_path']
  )::text,'UTF8')),'hex');
$$;

create function private.item_save_owner() returns uuid
language plpgsql volatile set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not private.is_approved() then
    raise exception using errcode='42501',message='Not available';
  end if;
  perform 1 from public.profiles where owner_id=v_owner for update nowait;
  if not found or not private.is_approved() then
    raise exception using errcode='42501',message='Not available';
  end if;
  return v_owner;
end;
$$;

-- Caller already holds the profile. NOWAIT breaks reverse DELETE/image lock edges.
create function private.item_save_current(p_owner uuid,p_item_id uuid,p_image_id uuid,p_fingerprint text)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile set search_path = '' as $$
declare a private.item_save_attempts; i public.items; im public.item_images; n integer;
begin
  select * into a from private.item_save_attempts
    where owner_id=p_owner and item_id=p_item_id for update nowait;
  if not found or a.image_id is distinct from p_image_id or a.fingerprint is distinct from p_fingerprint then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  select * into im from public.item_images
    where owner_id=p_owner and item_id=p_item_id and id=p_image_id for update nowait;
  if not found or im.description_version<>1 or im.retired_at is not null
    or im.state<>(case a.state when 'reserved' then 'pending' else 'ready' end) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  select * into i from public.items where owner_id=p_owner and id=p_item_id for update nowait;
  if not found or i.version<>1 or i.deleted_at is not null
    or private.item_save_fingerprint(i,im)<>a.fingerprint then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if a.state='completed' then
    perform 1 from storage.objects where bucket_id='wardrobe' and name in(im.main_path,im.thumb_path)
      for share nowait;
    get diagnostics n = row_count;
    if n<>2 then raise exception using errcode='22023',message='Upload incomplete'; end if;
  end if;
  return query select to_jsonb(i),to_jsonb(im),a.fingerprint,a.state;
end;
$$;

create function public.reserve_item_save(p_item jsonb,p_image jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  fields constant text[] := array[
    'title','category','subcategory','colours','pattern','sleeve_length','garment_length',
    'brand','size_label','material','seasons','formality','warmth','min_temp','max_temp',
    'rain_rating','windproof','upper_coverage','lower_coverage','style_tags','tags',
    'purchase_date','purchase_price','notes'
  ];
  settings constant text[] := array['currency','favourite','availability','lifecycle','exclude_suggestions','wear_more'];
  image_keys constant text[] := array['id','main_bytes','thumb_bytes','main_sha256','thumb_sha256','width','height','alt_text'];
  k text; v jsonb; e jsonb; lim integer; n numeric; v_owner uuid; f text;
  i public.items; im public.item_images; v_constraint text;
begin
  v_owner := private.item_save_owner();
  if p_item is null or jsonb_typeof(p_item)<>'object' or p_image is null or jsonb_typeof(p_image)<>'object'
    or octet_length(convert_to(p_item::text,'UTF8'))>32768 or octet_length(convert_to(p_image::text,'UTF8'))>2048
    or not (p_item ?& (fields||settings||array['id','field_provenance']))
    or p_item-(fields||settings||array['id','field_provenance'])<>'{}'::jsonb
    or not (p_image ?& image_keys) or p_image-image_keys<>'{}'::jsonb then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if jsonb_typeof(p_item->'field_provenance')<>'object'
    or octet_length(convert_to((p_item->'field_provenance')::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for k,v in select key,value from jsonb_each(p_item->'field_provenance') loop
    if not k=any(fields) or jsonb_typeof(v)<>'object' or v<>jsonb_build_object('kind','user','revision',1) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  for k,v in select key,value from jsonb_each(p_item-'field_provenance') loop
    if k=any(fields) and v<>'null'::jsonb and v<>'[]'::jsonb and not (k='notes' and v='""'::jsonb)
      and not ((p_item->'field_provenance') ? k) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if k in ('colours','seasons','style_tags','tags') then
      if jsonb_typeof(v)<>'array' then raise exception using errcode='22023',message='Invalid input'; end if;
      lim := case k when 'colours' then 3 when 'seasons' then 4 when 'style_tags' then 8 else 12 end;
      if jsonb_array_length(v)>lim or (select count(*)<>count(distinct value) from jsonb_array_elements(v)) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      for e in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(e)<>'string' or length(e#>>'{}') not between 1 and 40 or btrim(e#>>'{}')='' then
          raise exception using errcode='22023',message='Invalid input';
        end if;
        if k='colours' and not (e#>>'{}')=any(array[
          'black','white','grey','navy','blue','green','olive','beige','brown','red','yellow','orange','pink','purple','unknown'
        ]) then raise exception using errcode='22023',message='Invalid input'; end if;
      end loop;
    elsif k in ('formality','warmth','min_temp','max_temp','rain_rating','upper_coverage','lower_coverage','purchase_price') then
      if v<>'null'::jsonb then
        if jsonb_typeof(v)<>'number' then raise exception using errcode='22023',message='Invalid input'; end if;
        n := (v#>>'{}')::numeric;
        if k='purchase_price' then
          if n<0 or n>9999999999.99 or n<>round(n,2) then
            raise exception using errcode='22023',message='Invalid input';
          end if;
        elsif n<>trunc(n) then raise exception using errcode='22023',message='Invalid input';
        end if;
      end if;
    elsif k in ('windproof','favourite','exclude_suggestions','wear_more') then
      if jsonb_typeof(v)<>'boolean' and not (k='windproof' and v='null'::jsonb) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
    elsif v='null'::jsonb then
      if k in ('id','title','category','currency','availability','lifecycle','notes') then
        raise exception using errcode='22023',message='Invalid input';
      end if;
    elsif jsonb_typeof(v)<>'string' then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if jsonb_typeof(p_item->'id')<>'string' or p_item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or btrim(p_item->>'title')='' or (p_item->'purchase_date'<>'null'::jsonb
      and p_item->>'purchase_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for k,v in select key,value from jsonb_each(p_image) loop
    if k in ('main_bytes','thumb_bytes','width','height') then
      if jsonb_typeof(v)<>'number' then raise exception using errcode='22023',message='Invalid input'; end if;
      n := (v#>>'{}')::numeric;
      if n<>trunc(n) then raise exception using errcode='22023',message='Invalid input'; end if;
    elsif jsonb_typeof(v)<>'string' then raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if p_image->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  i := jsonb_populate_record(null::public.items,p_item||jsonb_build_object('owner_id',v_owner,'version',1));
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind','user','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  im := jsonb_populate_record(null::public.item_images,p_image||jsonb_build_object('owner_id',v_owner,'item_id',i.id,'description_version',1));
  f := private.item_save_fingerprint(i,im);
  if exists(select 1 from private.item_save_used_ids u
    where u.owner_id=v_owner and (u.item_id=i.id or u.image_id=im.id)) then
    return query select * from private.item_save_current(v_owner,i.id,im.id,f);
    return;
  end if;
  -- Existing public identities are never adopted; uniqueness errors are closed below.
  insert into private.item_save_used_ids(owner_id,item_id,image_id) values(v_owner,i.id,im.id);
  insert into public.items(
    id,owner_id,title,category,subcategory,colours,pattern,sleeve_length,garment_length,
    brand,size_label,material,seasons,formality,warmth,min_temp,max_temp,rain_rating,windproof,
    upper_coverage,lower_coverage,style_tags,tags,purchase_date,purchase_price,notes,
    currency,favourite,availability,lifecycle,exclude_suggestions,wear_more,field_provenance
  ) values(
    i.id,v_owner,i.title,i.category,i.subcategory,i.colours,i.pattern,i.sleeve_length,i.garment_length,
    i.brand,i.size_label,i.material,i.seasons,i.formality,i.warmth,i.min_temp,i.max_temp,i.rain_rating,i.windproof,
    i.upper_coverage,i.lower_coverage,i.style_tags,i.tags,i.purchase_date,i.purchase_price,i.notes,
    i.currency,i.favourite,i.availability,i.lifecycle,i.exclude_suggestions,i.wear_more,i.field_provenance
  ) returning * into i;
  insert into public.item_images(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
    values(im.id,v_owner,i.id,im.main_bytes,im.thumb_bytes,im.main_sha256,im.thumb_sha256,im.width,im.height,im.alt_text)
    returning * into im;
  insert into private.item_save_attempts(owner_id,item_id,image_id,fingerprint) values(v_owner,i.id,im.id,f);
  return query select * from private.item_save_current(v_owner,i.id,im.id,f);
exception
  when lock_not_available then raise exception using errcode='22023',message='Request conflict';
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint not in ('items_pkey','item_images_pkey','item_images_main_path_key','item_images_thumb_path_key') then raise; end if;
    raise exception using errcode='22023',message='Request conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow then raise exception using errcode='22023',message='Invalid input';
end;
$$;

-- Move the exact legacy implementation, retaining its checks and behavior behind a private seam.
alter function public.commit_image(uuid) set schema private;
alter function private.commit_image(uuid) rename to commit_item_save_image;
revoke all on function private.commit_item_save_image(uuid) from public,anon,authenticated;

create function public.commit_image(p_image_id uuid) returns void
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid; v_item_id uuid; im public.item_images;
begin
  v_owner := private.item_save_owner();
  select item_id into v_item_id from public.item_images where owner_id=v_owner and id=p_image_id;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  perform 1 from public.item_images where owner_id=v_owner and item_id=v_item_id and state='ready' for update;
  select * into im from public.item_images where owner_id=v_owner and id=p_image_id for update nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  if im.owner_id is distinct from v_owner or im.item_id is distinct from v_item_id then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if exists(select 1 from private.item_save_used_ids u
    where u.owner_id=v_owner and (u.item_id=im.item_id or u.image_id=im.id)) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  perform 1 from public.items where owner_id=v_owner and id=im.item_id for update nowait;
  perform 1 from public.item_images where owner_id=v_owner and item_id=im.item_id and state='ready' for update nowait;
  perform private.commit_item_save_image(p_image_id);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.finalize_item_save(p_item_id uuid,p_image_id uuid,p_fingerprint text) returns void
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid; a record; im public.item_images; n integer;
begin
  v_owner := private.item_save_owner();
  if p_item_id is null or p_image_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select * into a from private.item_save_current(v_owner,p_item_id,p_image_id,p_fingerprint);
  im := jsonb_populate_record(null::public.item_images,a.image);
  perform 1 from storage.objects where bucket_id='wardrobe' and name in(im.main_path,im.thumb_path) for share nowait;
  get diagnostics n = row_count;
  if n<>2 then raise exception using errcode='22023',message='Upload incomplete'; end if;
  if a.state='completed' then return; end if;
  -- A separately inserted legacy image must not be retired/adopted by this Save.
  perform 1 from public.item_images where owner_id=v_owner and item_id=p_item_id and state='ready' for update nowait;
  if found then raise exception using errcode='22023',message='Request conflict'; end if;
  perform private.commit_item_save_image(p_image_id);
  update private.item_save_attempts set state='completed',completed_at=clock_timestamp()
    where owner_id=v_owner and item_id=p_item_id;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

revoke all on function private.item_save_fingerprint(public.items,public.item_images),
  private.item_save_owner(),private.item_save_current(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.reserve_item_save(jsonb,jsonb),public.finalize_item_save(uuid,uuid,text),
  public.commit_image(uuid) from public,anon,authenticated;
grant execute on function public.reserve_item_save(jsonb,jsonb),public.finalize_item_save(uuid,uuid,text),
  public.commit_image(uuid) to authenticated;
grant execute on function public.commit_image(uuid) to service_role;
commit;
