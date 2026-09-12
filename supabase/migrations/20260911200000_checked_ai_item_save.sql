-- I29 B2: explicit Save only. No inference, consent activation or Storage writes.
begin;

create table private.ai_save_used_receipts (
  owner_id uuid not null references public.profiles(owner_id) on delete cascade,
  request_id uuid not null,
  item_id uuid not null,
  image_id uuid not null,
  primary key(owner_id,request_id),
  unique(owner_id,item_id),
  unique(owner_id,image_id)
);
create table private.ai_item_save_attempts (
  owner_id uuid not null,
  item_id uuid not null,
  claim_hash text,
  manifest_id text references private.ai_execution_manifests(id),
  model_id text,
  prompt_version integer,
  image_sha256 text,
  byte_count integer,
  width integer,
  height integer,
  fields jsonb not null,
  cancelled boolean not null default false,
  primary key(owner_id,item_id),
  foreign key(owner_id,item_id) references private.item_save_attempts(owner_id,item_id) on delete cascade,
  check ((claim_hash is null)=(manifest_id is null)),
  check (jsonb_typeof(fields)='object' and octet_length(convert_to(fields::text,'UTF8'))<=4096)
);
create table private.ai_item_save_context (
  owner_id uuid not null,
  item_id uuid not null,
  item_hash text not null,
  primary key(owner_id,item_id)
);
create table private.item_attribution_history (
  owner_id uuid not null,
  item_id uuid not null,
  source_image_id uuid,
  image_sha256 text not null,
  model_id text not null,
  prompt_version integer not null,
  fields jsonb not null,
  primary key(owner_id,item_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id,source_image_id) references public.item_images(owner_id,item_id,id)
    on delete set null(source_image_id)
);
alter table private.ai_save_used_receipts enable row level security;
alter table private.ai_item_save_attempts enable row level security;
alter table private.ai_item_save_context enable row level security;
alter table private.item_attribution_history enable row level security;
revoke all on private.ai_save_used_receipts,private.ai_item_save_attempts,
  private.ai_item_save_context,private.item_attribution_history from public,anon,authenticated,service_role;

create function private.item_save_value_hash(p_item public.items) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to((to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at'])::text,'UTF8')),'hex');
$$;

create or replace function private.item_field_provenance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fields constant text[] := array[
    'title','category','subcategory','colours','pattern','sleeve_length','garment_length',
    'brand','size_label','material','seasons','formality','warmth','min_temp','max_temp',
    'rain_rating','windproof','upper_coverage','lower_coverage','style_tags','tags',
    'purchase_date','purchase_price','notes'
  ];
  field text; entry jsonb; previous jsonb; revision numeric; previous_revision integer;
  new_values jsonb := to_jsonb(new); old_values jsonb; admitted boolean := false;
begin
  if tg_op='INSERT' then
    select exists(select 1 from private.ai_item_save_context c
      where c.owner_id=new.owner_id and c.item_id=new.id
        and c.item_hash=private.item_save_value_hash(new)) into admitted;
  end if;
  if new.field_provenance is null or jsonb_typeof(new.field_provenance)<>'object'
    or octet_length(convert_to(new.field_provenance::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for field,entry in select key,value from jsonb_each(new.field_provenance) loop
    if not field=any(fields) or jsonb_typeof(entry)<>'object' then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if not (entry ?& array['kind','revision']) or entry-array['kind','revision']<>'{}'::jsonb
      or jsonb_typeof(entry->'kind')<>'string' or jsonb_typeof(entry->'revision')<>'number'
      or entry->>'kind' not in ('unknown','user','ai_observed','ai_estimated') then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    revision := (entry->>'revision')::numeric;
    if revision<1 or revision>2147483647 or revision<>trunc(revision) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if tg_op='INSERT' and (revision<>1 or (not admitted and entry->>'kind'<>'user')) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if tg_op='UPDATE' and entry->>'kind' in ('ai_observed','ai_estimated')
      and entry is distinct from old.field_provenance->field then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if tg_op='INSERT' then return new; end if;
  old_values := to_jsonb(old);
  foreach field in array fields loop
    entry := new.field_provenance->field;
    previous := old.field_provenance->field;
    previous_revision := coalesce((previous->'revision')::integer,0);
    if entry is distinct from previous then
      if entry is null or previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      if (entry->'revision')::integer<>previous_revision+1 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    elsif new_values->field is distinct from old_values->field then
      if previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      new.field_provenance := jsonb_set(new.field_provenance,array[field],
        jsonb_build_object('kind','unknown','revision',previous_revision+1));
    end if;
  end loop;
  if octet_length(convert_to(new.field_provenance::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  return new;
end;
$$;

-- Same admission, value validation, fingerprint and identity lifecycle as manual Save.
create function private.reserve_item_save(p_item jsonb,p_image jsonb,p_kinds text[])
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile set search_path = '' as $$
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
    if not k=any(fields) or jsonb_typeof(v)<>'object' or not coalesce(v->>'kind'=any(p_kinds),false)
      or v<>jsonb_build_object('kind',v->>'kind','revision',1) then
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
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  im := jsonb_populate_record(null::public.item_images,p_image||jsonb_build_object('owner_id',v_owner,'item_id',i.id,'description_version',1));
  f := private.item_save_fingerprint(i,im);
  if exists(select 1 from private.item_save_used_ids u
    where u.owner_id=v_owner and (u.item_id=i.id or u.image_id=im.id)) then
    return query select * from private.item_save_current(v_owner,i.id,im.id,f);
    return;
  end if;
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

create or replace function public.reserve_item_save(p_item jsonb,p_image jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return query select * from private.reserve_item_save(p_item,p_image,array['user']);
  if exists(select 1 from private.ai_item_save_attempts a
    where a.owner_id=auth.uid() and a.item_id=(p_item->>'id')::uuid) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
end;
$$;

alter function public.finalize_item_save(uuid,uuid,text) set schema private;
alter function private.finalize_item_save(uuid,uuid,text) rename to finalize_manual_item_save;
create function public.finalize_item_save(p_item_id uuid,p_image_id uuid,p_fingerprint text) returns void
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid;
begin
  v_owner := private.item_save_owner();
  if exists(select 1 from private.ai_item_save_attempts a where a.owner_id=v_owner and a.item_id=p_item_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  perform private.finalize_manual_item_save(p_item_id,p_image_id,p_fingerprint);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.reserve_analyzed_item_save(p_item jsonb,p_image jsonb,p_claim jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  v_owner uuid; i public.items; a private.ai_item_save_attempts;
  p public.profiles; c private.ai_controls; r private.ai_requests;
  proof private.ai_analysis_attestations; m private.ai_execution_manifests;
  k text; v jsonb; kind text; derived jsonb := '{}'; result record;
begin
  v_owner := private.item_save_owner();
  if p_item is null or p_image is null or jsonb_typeof(p_item)<>'object' or jsonb_typeof(p_image)<>'object'
    or jsonb_typeof(p_item->'field_provenance') is distinct from 'object'
    or octet_length(convert_to(p_item::text,'UTF8'))>32768
    or octet_length(convert_to(p_image::text,'UTF8'))>2048 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if p_claim is not null and (
    jsonb_typeof(p_claim)<>'object' or octet_length(convert_to(p_claim::text,'UTF8'))>8192
    or not (p_claim ?& array['requestId','draftId','generation','imageSha256','fields'])
    or p_claim-array['requestId','draftId','generation','imageSha256','fields']<>'{}'::jsonb
    or jsonb_typeof(p_claim->'fields')<>'object') then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  i := jsonb_populate_record(null::public.items,p_item||jsonb_build_object('owner_id',v_owner,'version',1));
  select * into a from private.ai_item_save_attempts where owner_id=v_owner and item_id=i.id for update nowait;
  if found then
    if a.cancelled or a.claim_hash is distinct from encode(sha256(convert_to(p_claim::text,'UTF8')),'hex') then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return query select * from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
    return;
  end if;
  if exists(select 1 from private.item_save_used_ids u where u.owner_id=v_owner
    and (u.item_id=i.id or u.image_id=(p_image->>'id')::uuid)) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if p_claim is not null then
    select * into p from public.profiles where owner_id=v_owner;
    select * into c from private.ai_controls where owner_id=v_owner for update nowait;
    perform 1 from private.ai_usage where owner_id=v_owner and request_id=(p_claim->>'requestId')::uuid for update nowait;
    select * into r from private.ai_requests where owner_id=v_owner and request_id=(p_claim->>'requestId')::uuid for update nowait;
    if not found or r.status<>'ready' or r.expires_at<=clock_timestamp()
      or not private.ai_analysis_permitted(p,c,r,clock_timestamp()) or r.notice_revision is distinct from c.notice_revision
      or r.model_id is distinct from c.model_id or r.prompt_version is distinct from c.prompt_version
      or p_claim->'requestId' is distinct from to_jsonb(r.request_id)
      or p_claim->'draftId' is distinct from to_jsonb(r.draft_id)
      or p_claim->'generation' is distinct from to_jsonb(r.generation)
      or p_claim->'imageSha256' is distinct from to_jsonb(r.image_sha256)
      or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    select * into proof from private.ai_analysis_attestations where owner_id=v_owner and request_id=r.request_id for share nowait;
    if not found then raise exception using errcode='22023',message='Request conflict'; end if;
    select * into m from private.ai_execution_manifests where id=proof.manifest_id;
    if not found or m.id is distinct from c.execution_manifest_id or m.review_expires_at<=clock_timestamp()
      or m.model_id<>r.model_id or m.prompt_version<>r.prompt_version
      or proof.image_sha256<>r.image_sha256 or p_image->'main_sha256' is distinct from to_jsonb(proof.image_sha256)
      or p_image->'main_bytes' is distinct from to_jsonb(proof.byte_count)
      or p_image->'width' is distinct from to_jsonb(proof.width)
      or p_image->'height' is distinct from to_jsonb(proof.height) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    for k,v in select key,value from jsonb_each(p_claim->'fields') loop
      kind := case when k=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
        when k=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
        then 'ai_observed' else null end;
      if kind is null or jsonb_typeof(v)<>'object'
        or v is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->k)
        or r.facts->'fields'->k is null or r.facts->'fields'->k in ('null'::jsonb,'[]'::jsonb)
        or p_item->k is distinct from r.facts->'fields'->k
        or p_item->'field_provenance'->k is distinct from jsonb_build_object('kind',kind,'revision',1) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      derived := derived||jsonb_build_object(k,jsonb_build_object('kind',kind,'revision',1));
    end loop;
    if exists(select 1 from private.ai_save_used_receipts where owner_id=v_owner and request_id=r.request_id) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    insert into private.ai_save_used_receipts values(v_owner,r.request_id,i.id,(p_image->>'id')::uuid);
  end if;
  for k,v in select key,value from jsonb_each(i.field_provenance) loop
    if v->>'kind' in ('ai_observed','ai_estimated') and v is distinct from derived->k then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  insert into private.ai_item_save_context values(v_owner,i.id,private.item_save_value_hash(i));
  select * into result from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
  delete from private.ai_item_save_context where owner_id=v_owner and item_id=i.id;
  -- Store identity and field classes, not copied result values or the caller's draft.
  insert into private.ai_item_save_attempts values(
    v_owner,i.id,encode(sha256(convert_to(p_claim::text,'UTF8')),'hex'),m.id,m.model_id,m.prompt_version,proof.image_sha256,
    proof.byte_count,proof.width,proof.height,derived,false
  );
  return query select result.item,result.image,result.fingerprint,result.state;
exception
  when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow then raise exception using errcode='22023',message='Invalid input';
end;
$$;

create function private.analyzed_item_save_current(p_owner uuid,p_item_id uuid,p_image_id uuid,p_fingerprint text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare a private.ai_item_save_attempts; current record; im public.item_images; objects jsonb; n integer;
begin
  if p_owner is null or not private.ai_owner_approved(p_owner) then
    raise exception using errcode='42501',message='Not available';
  end if;
  perform 1 from public.profiles where owner_id=p_owner for update nowait;
  if not found or not private.ai_owner_approved(p_owner) then
    raise exception using errcode='42501',message='Not available';
  end if;
  if p_item_id is null or p_image_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select * into a from private.ai_item_save_attempts where owner_id=p_owner and item_id=p_item_id for update nowait;
  if not found or a.cancelled then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into current from private.item_save_current(p_owner,p_item_id,p_image_id,p_fingerprint);
  im := jsonb_populate_record(null::public.item_images,current.image);
  if a.claim_hash is not null and (im.main_sha256<>a.image_sha256 or im.main_bytes<>a.byte_count
    or im.width<>a.width or im.height<>a.height) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  select count(*),jsonb_object_agg(case o.name when im.main_path then 'main' else 'thumb' end,
    jsonb_build_object('id',o.id,'version',o.version::text))
    into n,objects from (select id,name,version from storage.objects
      where bucket_id='wardrobe' and name in(im.main_path,im.thumb_path) for share nowait) o;
  if n<>2 then raise exception using errcode='22023',message='Upload incomplete'; end if;
  if objects->'main'->>'version' is null or objects->'thumb'->>'version' is null
    or length(objects->'main'->>'version') not between 1 and 1024
    or length(objects->'thumb'->>'version') not between 1 and 1024 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return jsonb_build_object('image',current.image,'objects',objects,'state',current.state);
end;
$$;

create function public.analyzed_item_save_preflight(p_item_id uuid,p_image_id uuid,p_fingerprint text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  return private.analyzed_item_save_current(private.item_save_owner(),p_item_id,p_image_id,p_fingerprint);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.complete_analyzed_item_save(p_owner_id uuid,p_item_id uuid,p_image_id uuid,p_fingerprint text,p_objects jsonb)
returns void language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare current jsonb; a private.ai_item_save_attempts;
begin
  current := private.analyzed_item_save_current(p_owner_id,p_item_id,p_image_id,p_fingerprint);
  if p_objects is distinct from current->'objects' then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if current->>'state'='completed' then return; end if;
  perform 1 from public.item_images where owner_id=p_owner_id and item_id=p_item_id and state='ready' for update nowait;
  if found then raise exception using errcode='22023',message='Request conflict'; end if;
  update public.item_images set state='ready'
    where owner_id=p_owner_id and item_id=p_item_id and id=p_image_id and state='pending';
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into a from private.ai_item_save_attempts where owner_id=p_owner_id and item_id=p_item_id;
  if a.fields<>'{}'::jsonb then
    insert into private.item_attribution_history values(
      p_owner_id,p_item_id,p_image_id,a.image_sha256,a.model_id,a.prompt_version,a.fields);
  end if;
  update private.item_save_attempts set state='completed',completed_at=clock_timestamp()
    where owner_id=p_owner_id and item_id=p_item_id;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.cancel_analyzed_item_save(p_item_id uuid,p_image_id uuid,p_fingerprint text)
returns void language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid; a record;
begin
  v_owner := private.item_save_owner();
  select * into a from private.item_save_current(v_owner,p_item_id,p_image_id,p_fingerprint);
  if a.state<>'reserved' then raise exception using errcode='22023',message='Request conflict'; end if;
  update private.ai_item_save_attempts set cancelled=true where owner_id=v_owner and item_id=p_item_id;
  if not found then raise exception using errcode='22023',message='Request conflict'; end if;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.item_attribution_history(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() or not exists(
    select 1 from public.items where owner_id=auth.uid() and id=p_item_id and deleted_at is null) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(h)-array['owner_id','item_id'])
    from private.item_attribution_history h where owner_id=auth.uid() and item_id=p_item_id),'[]'::jsonb);
end;
$$;

revoke all on function private.item_save_value_hash(public.items),private.item_field_provenance(),
  private.reserve_item_save(jsonb,jsonb,text[]),private.finalize_manual_item_save(uuid,uuid,text),
  private.analyzed_item_save_current(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.reserve_item_save(jsonb,jsonb),public.finalize_item_save(uuid,uuid,text),
  public.reserve_analyzed_item_save(jsonb,jsonb,jsonb),public.analyzed_item_save_preflight(uuid,uuid,text),
  public.cancel_analyzed_item_save(uuid,uuid,text),public.item_attribution_history(uuid),
  public.complete_analyzed_item_save(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reserve_item_save(jsonb,jsonb),public.finalize_item_save(uuid,uuid,text),
  public.reserve_analyzed_item_save(jsonb,jsonb,jsonb),public.analyzed_item_save_preflight(uuid,uuid,text),
  public.cancel_analyzed_item_save(uuid,uuid,text),public.item_attribution_history(uuid) to authenticated;
grant execute on function public.complete_analyzed_item_save(uuid,uuid,uuid,text,jsonb) to service_role;
commit;
