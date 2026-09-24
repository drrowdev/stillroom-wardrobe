-- COL1 garment colours: widen code checks only. No data change; existing values stay valid.
begin;

create or replace function private.ai_valid_facts(p_facts jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  observed constant text[] := array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'];
  estimated constant text[] := array['material','seasons','formality','style_tags'];
  k text; v jsonb; e jsonb; n numeric; lim integer; allowed text[];
  whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_facts is null or jsonb_typeof(p_facts)<>'object'
    or octet_length(convert_to(p_facts::text,'UTF8'))>8192 then return false; end if;
  if not (p_facts ?& array['outcome','fields']) or p_facts-array['outcome','fields']<>'{}'::jsonb
    or jsonb_typeof(p_facts->'outcome')<>'string' or p_facts->>'outcome' not in ('ready','unclear')
    or jsonb_typeof(p_facts->'fields')<>'object' then return false; end if;
  for k,v in select key,value from jsonb_each(p_facts->'fields') loop
    if not k=any(observed||estimated) then return false; end if;
    if k in ('colours','seasons','style_tags') then
      if jsonb_typeof(v)<>'array' then return false; end if;
      lim := case k when 'colours' then 3 when 'seasons' then 4 else 8 end;
      if jsonb_array_length(v)>lim
        or (select count(*)<>count(distinct value) from jsonb_array_elements(v)) then return false; end if;
      allowed := case k
        when 'colours' then array['black','white','cream','grey','navy','blue','light_blue','teal','green','olive','khaki','beige','brown','burgundy','red','yellow','orange','pink','purple','gold','silver']
        when 'seasons' then array['spring','summer','autumn','winter'] else null end;
      for e in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(e)<>'string' then return false; end if;
        if k='style_tags' then
          if char_length(e#>>'{}')>40 or btrim(e#>>'{}',whitespace)='' then return false; end if;
        elsif not (e#>>'{}')=any(allowed) then return false; end if;
      end loop;
    elsif v='null'::jsonb then null;
    elsif k in ('formality','upper_coverage','lower_coverage') then
      if jsonb_typeof(v)<>'number' then return false; end if;
      n := (v#>>'{}')::numeric;
      lim := case k when 'formality' then 4 else 2 end;
      if n<>trunc(n) or n<0 or n>lim then return false; end if;
    elsif k in ('category','pattern','sleeve_length','garment_length') then
      allowed := case k
        when 'category' then array['top','bottom','one_piece','footwear','layer','outerwear','accessory']
        when 'pattern' then array['solid','striped','checked','dotted','floral','graphic','abstract','animal','other']
        when 'sleeve_length' then array['sleeveless','short','elbow','three_quarter','long']
        else array['cropped','short','regular','long'] end;
      if jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(allowed) then return false; end if;
    else
      lim := case k when 'subcategory' then 60 when 'brand' then 100 when 'size_label' then 50 else 200 end;
      if jsonb_typeof(v)<>'string' or char_length(v#>>'{}')>lim
        or btrim(v#>>'{}',whitespace)='' then return false; end if;
    end if;
    if p_facts->>'outcome'='unclear' and v<>'null'::jsonb and v<>'[]'::jsonb then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function private.reserve_item_save(p_item jsonb,p_image jsonb,p_kinds text[])
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
          'black','white','cream','grey','navy','blue','light_blue','teal','green','olive','khaki','beige','brown','burgundy','red','yellow','orange','pink','purple','gold','silver','unknown'
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

create or replace function private.image_change_intent(p_owner uuid,p_intent jsonb) returns public.items
language plpgsql volatile security definer set search_path = '' as $$
declare i public.items; target public.items; image public.item_images; key text; value jsonb; baseline jsonb; entry jsonb;
begin
  if p_intent is null or jsonb_typeof(p_intent)<>'object'
    or not (p_intent ?& array['requestId','itemId','imageId','expectedVersion','currentImageId','descriptionVersion','item','image','claim','sourceImageId'])
    or p_intent-array['requestId','itemId','imageId','expectedVersion','currentImageId','descriptionVersion','item','image','claim','sourceImageId']<>'{}'
    or octet_length(convert_to(p_intent::text,'UTF8'))>49152
    or jsonb_typeof(p_intent->'item')<>'object' or jsonb_typeof(p_intent->'image')<>'object'
    or octet_length(convert_to((p_intent->'item')::text,'UTF8'))>32768
    or octet_length(convert_to((p_intent->'image')::text,'UTF8'))>2048 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  foreach key in array array['requestId','itemId','imageId','currentImageId'] loop
    if jsonb_typeof(p_intent->key) is distinct from 'string'
      or p_intent->>key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  perform 1 from public.item_images where owner_id=p_owner and item_id=(p_intent->>'itemId')::uuid order by id for update nowait;
  select * into i from public.items where owner_id=p_owner and id=(p_intent->>'itemId')::uuid for update nowait;
  if not found or i.deleted_at is not null or to_jsonb(i.version) is distinct from p_intent->'expectedVersion'
    or i.version>=9007199254740991 or private.image_change_fenced(p_owner,i.id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  select * into image from public.item_images where owner_id=p_owner and item_id=i.id and state='ready' for update nowait;
  if not found or to_jsonb(image.id) is distinct from p_intent->'currentImageId'
    or to_jsonb(image.description_version) is distinct from p_intent->'descriptionVersion' then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  baseline := to_jsonb(i)-array['id','owner_id','created_at','updated_at','version','deleted_at'];
  if (select array_agg(k order by k) from jsonb_object_keys(baseline) k)
    is distinct from (select array_agg(k order by k) from jsonb_object_keys(p_intent->'item') k) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  target := jsonb_populate_record(i,p_intent->'item');
  -- Round-tripping rejects numeric rounding, coercion and unexpected JSON types.
  if to_jsonb(target)-array['id','owner_id','created_at','updated_at','version','deleted_at'] is distinct from p_intent->'item'
    or btrim(target.title)='' or length(target.title)>100
    or target.category not in ('top','bottom','one_piece','footwear','layer','outerwear','accessory')
    or target.field_provenance is null or jsonb_typeof(target.field_provenance)<>'object'
    or octet_length(convert_to(target.field_provenance::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if target.title is null or target.category is null or target.colours is null or target.seasons is null
    or target.style_tags is null or target.tags is null or target.currency is null or target.notes is null
    or target.favourite is null or target.availability is null or target.lifecycle is null
    or target.exclude_suggestions is null or target.wear_more is null
    or length(target.subcategory)>60 or length(target.brand)>100 or length(target.size_label)>50 or length(target.material)>200
    or cardinality(target.colours)>3 or cardinality(target.seasons)>4
    or not target.seasons <@ array['spring','summer','autumn','winter']::text[]
    or target.formality not between 0 and 4 or target.warmth not between 0 and 4
    or target.min_temp not between -40 and 50 or target.max_temp not between -40 and 50
    or target.min_temp>target.max_temp or target.rain_rating not between 0 and 2
    or target.upper_coverage not between 0 and 2 or target.lower_coverage not between 0 and 2
    or cardinality(target.style_tags)>8 or cardinality(target.tags)>12 or octet_length(array_to_string(target.tags,','))>512
    or target.purchase_price<0 or target.currency !~ '^[A-Z]{3}$' or length(target.notes)>4000
    or target.availability not in ('ready','laundry','repair','lent') or target.lifecycle not in ('active','archived','donated','sold')
    or target.pattern not in ('solid','striped','checked','dotted','floral','graphic','abstract','animal','other')
    or target.sleeve_length not in ('sleeveless','short','elbow','three_quarter','long')
    or target.garment_length not in ('cropped','short','regular','long') then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for key,value in select k,v from jsonb_each(p_intent->'item') as e(k,v) loop
    if key in ('colours','seasons','style_tags','tags') and value is distinct from baseline->key then
      if jsonb_typeof(value)<>'array' or (select count(*)<>count(distinct v) from jsonb_array_elements(value) v) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      for entry in select v from jsonb_array_elements(value) v loop
        if jsonb_typeof(entry)<>'string' or length(entry#>>'{}') not between 1 and 40 or btrim(entry#>>'{}')=''
          or (key='colours' and entry#>>'{}' not in (
            'black','white','cream','grey','navy','blue','light_blue','teal','green','olive','khaki','beige','brown','burgundy','red','yellow','orange','pink','purple','gold','silver','unknown')) then
          raise exception using errcode='22023',message='Invalid input';
        end if;
      end loop;
    end if;
    if value is distinct from baseline->key and key<>'field_provenance'
      and not (key=any(array['currency','favourite','availability','lifecycle','exclude_suggestions','wear_more'])) then
      if not (target.field_provenance ? key) then raise exception using errcode='22023',message='Invalid input'; end if;
    end if;
  end loop;
  for key,value in select k,v from jsonb_each(target.field_provenance) as e(k,v) loop
    if not (baseline ? key) or key=any(array['field_provenance','currency','favourite','availability','lifecycle','exclude_suggestions','wear_more'])
      or jsonb_typeof(value)<>'object' or value-array['kind','revision']<>'{}'
      or not (value ?& array['kind','revision']) or jsonb_typeof(value->'kind') is distinct from 'string'
      or value->>'kind' not in ('user','unknown','ai_observed','ai_estimated')
      or jsonb_typeof(value->'revision') is distinct from 'number'
      or (value->>'revision')::numeric not between 1 and 2147483647
      or trunc((value->>'revision')::numeric)<>(value->>'revision')::numeric then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if value is distinct from i.field_provenance->key
      and (value->>'revision')::numeric<>coalesce((i.field_provenance->key->>'revision')::numeric,0)+1 then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    if value is not distinct from i.field_provenance->key and (p_intent->'item'->key) is distinct from baseline->key then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if exists(select 1 from jsonb_object_keys(i.field_provenance) k where not (target.field_provenance ? k)) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if p_intent->'image'->'id' is distinct from p_intent->'imageId'
    or not (p_intent->'image' ?& array['id','main_bytes','thumb_bytes','main_sha256','thumb_sha256','width','height','alt_text'])
    or (p_intent->'image')-array['id','main_bytes','thumb_bytes','main_sha256','thumb_sha256','width','height','alt_text']<>'{}' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  image := jsonb_populate_record(null::public.item_images,p_intent->'image');
  if jsonb_build_object('id',image.id,'main_bytes',image.main_bytes,'thumb_bytes',image.thumb_bytes,
      'main_sha256',image.main_sha256,'thumb_sha256',image.thumb_sha256,'width',image.width,'height',image.height,'alt_text',image.alt_text)
      is distinct from p_intent->'image'
    or not coalesce(image.main_bytes between 1 and 512000 and image.thumb_bytes between 1 and 61440
      and image.width between 1 and 1600 and image.height between 1 and 1600 and length(image.alt_text) between 0 and 240
      and image.main_sha256 ~ '^[0-9a-f]{64}$' and image.thumb_sha256 ~ '^[0-9a-f]{64}$',false) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  return target;
end;
$$;

commit;
