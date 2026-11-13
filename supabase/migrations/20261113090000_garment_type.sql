-- CAPS1a garment type (owner decision of 12 November 2026): a closed type per category on every garment, stored on items.
-- Forward-only DDL. One transaction, LF. It takes an exclusive lock on public.items first and REFUSES, changing nothing, while
-- any checked item save (manual, analysed or restored) or photo replacement is still pending: those freeze row hashes and
-- intents that the new column would change (see below). Finish or cancel them in the app, then run it again.
--   * public.items.garment_type: nullable text, one code per garment, checked against its category (the table below).
--     Existing rows stay null (not set); no data is written. The CHECK is written inline: the app roles cannot call private functions.
--   * private.garment_type_allowed(category, type): the same table for the definer validators. No API grant.
--   * Row hashes: private.item_save_fingerprint and private.item_save_value_hash hash the whole row. They now leave a NULL
--     garment_type out, so the text hashed for every existing row (and for every completed retry) is byte for byte what it was
--     before the column existed; a set garment_type is part of the hash like any other column.
--   * The other functions are replaced with their exact current bodies plus one stated delta each (garment_type joins the
--     provenance field list, the AI-observed list, the key list and the pair check): private.ai_valid_facts,
--     private.item_field_provenance, private.reserve_item_save (garment_type is an OPTIONAL key, so an older client's Save still
--     works), private.image_change_intent, public.complete_image_change, private.reserve_analyzed_item_save_v10,
--     private.reserve_image_change, public.reserve_restored_item_save. The analysis manifest is NOT changed here (CAPS1a M2).
--   * Not written: any consent, control, usage, item or image row. An older Pages build cannot Add, Replace photo or Export
--     once this is installed (see docs/cloud-development.md, CAPS1a): install this and deploy Pages as one maintenance cutover.
begin;

lock table public.items in access exclusive mode;

do $pre$
begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='items' and column_name='garment_type') then
    raise exception 'garment type: already installed';
  end if;
  if exists(select 1 from private.item_save_attempts where state='reserved')
    or exists(select 1 from private.image_change_attempts where state='reserved') then
    raise exception 'garment type: a checked item save or photo replacement is still pending; finish or cancel it, then run this again';
  end if;
end
$pre$;

alter table public.items add column garment_type text;
alter table public.items add constraint items_garment_type_pair check (garment_type is null or
  case category
        when 'top' then garment_type in ('t_shirt','shirt','polo','knit','sweatshirt','tank')
        when 'bottom' then garment_type in ('jeans','chinos','trousers','shorts','skirt')
        when 'one_piece' then garment_type in ('dress','jumpsuit')
        when 'footwear' then garment_type in ('sneakers','boots','shoes','sandals')
        when 'layer' then garment_type in ('blazer','cardigan','hoodie','sweatshirt','knit','vest','overshirt')
        when 'outerwear' then garment_type in ('coat','jacket','parka','bomber','puffer','shell','vest','overshirt')
        when 'accessory' then garment_type in ('hat','scarf','belt','bag')
        else false end
);

create function private.garment_type_allowed(p_category text,p_type text) returns boolean
language sql immutable set search_path = '' as $$
  select p_type is null or coalesce(case p_category
        when 'top' then p_type in ('t_shirt','shirt','polo','knit','sweatshirt','tank')
        when 'bottom' then p_type in ('jeans','chinos','trousers','shorts','skirt')
        when 'one_piece' then p_type in ('dress','jumpsuit')
        when 'footwear' then p_type in ('sneakers','boots','shoes','sandals')
        when 'layer' then p_type in ('blazer','cardigan','hoodie','sweatshirt','knit','vest','overshirt')
        when 'outerwear' then p_type in ('coat','jacket','parka','bomber','puffer','shell','vest','overshirt')
        when 'accessory' then p_type in ('hat','scarf','belt','bag')
        else false end,false);
$$;
revoke all on function private.garment_type_allowed(text,text) from public,anon,authenticated;

create or replace function private.item_save_fingerprint(p_item public.items,p_image public.item_images) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'item',to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at']-case when p_item.garment_type is null then 'garment_type' else '' end,
    'image',to_jsonb(p_image)-array['created_at','state','retired_at','description_version','main_path','thumb_path']
  )::text,'UTF8')),'hex');
$$;

create or replace function private.item_save_value_hash(p_item public.items) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to((to_jsonb(p_item)-array['created_at','updated_at','version','deleted_at']-case when p_item.garment_type is null then 'garment_type' else '' end)::text,'UTF8')),'hex');
$$;

create or replace function private.ai_valid_facts(p_facts jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  observed constant text[] := array['category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'];
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
    elsif k in ('category','garment_type','pattern','sleeve_length','garment_length') then
      allowed := case k
        when 'category' then array['top','bottom','one_piece','footwear','layer','outerwear','accessory']
        when 'garment_type' then array['t_shirt','shirt','polo','knit','sweatshirt','tank','jeans','chinos','trousers','shorts','skirt','dress','jumpsuit','sneakers','boots','shoes','sandals','blazer','cardigan','hoodie','vest','overshirt','coat','jacket','parka','bomber','puffer','shell','hat','scarf','belt','bag']
        when 'pattern' then array['solid','striped','checked','dotted','floral','graphic','abstract','animal','other']
        when 'sleeve_length' then array['sleeveless','short','elbow','three_quarter','long']
        else array['cropped','short','regular','long'] end;
      if jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(allowed) then return false; end if;
      if k='garment_type' and not private.garment_type_allowed(p_facts->'fields'->>'category',v#>>'{}') then return false; end if;
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

create or replace function private.item_field_provenance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fields constant text[] := array['title','category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length',
    'brand','size_label','material','seasons','formality','warmth','min_temp','max_temp','rain_rating','windproof',
    'upper_coverage','lower_coverage','style_tags','tags','purchase_date','purchase_price','notes'];
  field text; entry jsonb; previous jsonb; revision numeric; previous_revision integer;
  new_values jsonb := to_jsonb(new); old_values jsonb; admitted boolean := false;
begin
  if tg_op='INSERT' then
    select exists(select 1 from private.ai_item_save_context c where c.owner_id=new.owner_id and c.item_id=new.id
      and c.item_hash=private.item_save_value_hash(new)) into admitted;
  else
    admitted := private.consume_image_change_context(old.owner_id,old.id,old.id,'replacement',old.version,
      to_jsonb(old),to_jsonb(new));
  end if;
  if new.field_provenance is null or jsonb_typeof(new.field_provenance)<>'object'
    or octet_length(convert_to(new.field_provenance::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for field,entry in select key,value from jsonb_each(new.field_provenance) loop
    if not field=any(fields) or jsonb_typeof(entry)<>'object'
      or not (entry ?& array['kind','revision']) or entry-array['kind','revision']<>'{}'::jsonb
      or jsonb_typeof(entry->'kind')<>'string' or jsonb_typeof(entry->'revision')<>'number'
      or entry->>'kind' not in ('unknown','user','ai_observed','ai_estimated') then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    revision := (entry->>'revision')::numeric;
    if revision<1 or revision>2147483647 or revision<>trunc(revision)
      or (tg_op='INSERT' and (revision<>1 or (not admitted and entry->>'kind'<>'user'))) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if tg_op='UPDATE' and not admitted and entry->>'kind' in ('ai_observed','ai_estimated')
      and entry is distinct from old.field_provenance->field then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if tg_op='INSERT' then return new; end if;
  old_values := to_jsonb(old);
  foreach field in array fields loop
    entry := new.field_provenance->field; previous := old.field_provenance->field;
    previous_revision := coalesce((previous->'revision')::integer,0);
    if entry is distinct from previous then
      if entry is null or previous_revision=2147483647 or (entry->'revision')::integer<>previous_revision+1 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    elsif new_values->field is distinct from old_values->field then
      if previous_revision=2147483647 then raise exception using errcode='22023',message='Request conflict'; end if;
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

create or replace function private.reserve_item_save(p_item jsonb,p_image jsonb,p_kinds text[])
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile set search_path = '' as $$
declare
  fields constant text[] := array[
    'title','category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length',
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
    or not (p_item ?& (array_remove(fields,'garment_type')||settings||array['id','field_provenance']))
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
  if p_item->>'garment_type' is not null and not private.garment_type_allowed(p_item->>'category',p_item->>'garment_type') then
    raise exception using errcode='22023',message='Invalid input';
  end if;
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
    id,owner_id,title,category,subcategory,colours,pattern,sleeve_length,garment_length,garment_type,
    brand,size_label,material,seasons,formality,warmth,min_temp,max_temp,rain_rating,windproof,
    upper_coverage,lower_coverage,style_tags,tags,purchase_date,purchase_price,notes,
    currency,favourite,availability,lifecycle,exclude_suggestions,wear_more,field_provenance
  ) values(
    i.id,v_owner,i.title,i.category,i.subcategory,i.colours,i.pattern,i.sleeve_length,i.garment_length,i.garment_type,
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
    or target.garment_length not in ('cropped','short','regular','long')
    or not private.garment_type_allowed(target.category,target.garment_type) then
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

create or replace function public.complete_image_change(p_owner_id uuid,p_intent jsonb,p_objects jsonb) returns void
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare a private.image_change_attempts; target public.items; old_item public.items; image public.item_images; previous public.item_images;
  changed public.item_images;
begin
  perform private.image_change_lock(p_owner_id);
  perform 1 from public.profiles where owner_id=p_owner_id for update nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select * into a from private.image_change_attempts where owner_id=p_owner_id and request_id=(p_intent->>'requestId')::uuid for update nowait;
  if not found or a.fingerprint is distinct from private.image_change_hash(p_intent) or a.state='cancelled'
    or private.image_change_fenced(p_owner_id,a.item_id) then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into image from public.item_images where owner_id=p_owner_id and item_id=a.item_id and id=a.image_id for update nowait;
  if not found or private.image_change_objects(p_owner_id,image) is distinct from p_objects
    or to_jsonb(image)-array['owner_id','item_id','state','retired_at','main_path','thumb_path','created_at','description_version']
      is distinct from p_intent->'image' then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if a.state='completed' then
    if image.state<>'ready' or image.description_version<>1 then raise exception using errcode='22023',message='Request conflict'; end if;
    return;
  end if;
  target := private.image_change_intent(p_owner_id,p_intent);
  select * into old_item from public.items where owner_id=p_owner_id and id=a.item_id;
  if private.item_save_value_hash(old_item)<>a.item_hash or private.item_save_value_hash(target)<>a.result_hash
    or image.state<>'pending' or image.description_version<>1 then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into previous from public.item_images where owner_id=p_owner_id and id=a.current_image_id;
  changed := previous; changed.state := 'retired'; changed.retired_at := clock_timestamp();
  insert into private.image_change_context values(pg_current_xact_id(),p_owner_id,a.item_id,a.request_id,previous.id,
    'image_transition',null,private.image_change_hash(to_jsonb(previous)-array['main_path','thumb_path']),
    private.image_change_hash(to_jsonb(changed)-array['main_path','thumb_path']));
  update public.item_images set state=changed.state,retired_at=changed.retired_at where owner_id=p_owner_id and id=previous.id;
  changed := image; changed.state := 'ready';
  insert into private.image_change_context values(pg_current_xact_id(),p_owner_id,a.item_id,a.request_id,image.id,
    'image_transition',null,private.image_change_hash(to_jsonb(image)-array['main_path','thumb_path']),
    private.image_change_hash(to_jsonb(changed)-array['main_path','thumb_path']));
  update public.item_images set state='ready' where owner_id=p_owner_id and id=image.id;
  insert into private.image_change_context values(pg_current_xact_id(),p_owner_id,a.item_id,a.request_id,a.item_id,
    'replacement',old_item.version,private.image_change_hash(to_jsonb(old_item)),private.image_change_hash(to_jsonb(target)));
  update public.items set title=target.title,category=target.category,subcategory=target.subcategory,colours=target.colours,
    pattern=target.pattern,sleeve_length=target.sleeve_length,garment_length=target.garment_length,garment_type=target.garment_type,
    brand=target.brand,size_label=target.size_label,material=target.material,seasons=target.seasons,formality=target.formality,
    warmth=target.warmth,min_temp=target.min_temp,max_temp=target.max_temp,rain_rating=target.rain_rating,windproof=target.windproof,
    upper_coverage=target.upper_coverage,lower_coverage=target.lower_coverage,style_tags=target.style_tags,tags=target.tags,
    purchase_date=target.purchase_date,purchase_price=target.purchase_price,notes=target.notes,currency=target.currency,
    favourite=target.favourite,availability=target.availability,lifecycle=target.lifecycle,
    exclude_suggestions=target.exclude_suggestions,wear_more=target.wear_more,field_provenance=target.field_provenance
    where owner_id=p_owner_id and id=a.item_id returning * into target;
  if a.fields<>'{}' then
    insert into private.image_change_history values(p_owner_id,a.item_id,a.request_id,target.version,image.id,image.main_sha256,
      a.model_id,a.prompt_version,a.fields,a.manifest_id);
  end if;
  update private.image_change_attempts set state='completed',completed_version=target.version,source_objects=null
    where owner_id=p_owner_id and request_id=a.request_id;
  if exists(select 1 from private.image_change_context where transaction_id=pg_current_xact_id()
    and owner_id=p_owner_id and request_id=a.request_id) then raise exception using errcode='22023',message='Request conflict'; end if;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create or replace function private.reserve_analyzed_item_save_v10(p_item jsonb,p_image jsonb,p_claim jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid; i public.items; a private.ai_item_save_attempts;
  p public.profiles; c private.ai_controls; r private.ai_requests; u private.ai_usage;
  proof private.ai_analysis_attestations; m private.ai_execution_manifests; e private.ai_usage_evidence;
  k text; v jsonb; kind text; derived jsonb := '{}'; result record; v_refuse boolean := false;
begin
  -- This serializes absence tests with every same-owner reservation and consent change.
  v_owner := private.item_save_owner();
  if p_item is null or p_image is null or jsonb_typeof(p_item)<>'object' or jsonb_typeof(p_image)<>'object'
    or jsonb_typeof(p_item->'field_provenance') is distinct from 'object'
    or octet_length(convert_to(p_item::text,'UTF8'))>32768 or octet_length(convert_to(p_image::text,'UTF8'))>2048
    or coalesce(p_item->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_image->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if p_claim is not null and (jsonb_typeof(p_claim)<>'object' or octet_length(convert_to(p_claim::text,'UTF8'))>8192
    or not(p_claim ?& array['requestId','draftId','generation','imageSha256','fields'])
    or p_claim-array['requestId','draftId','generation','imageSha256','fields']<>'{}'::jsonb
    or jsonb_typeof(p_claim->'fields')<>'object'
    or coalesce(p_claim->>'requestId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_claim->>'draftId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_claim->'generation') is distinct from 'number'
    or coalesce(p_claim->>'imageSha256','')!~'^[0-9a-f]{64}$'
    or p_claim->'imageSha256' is distinct from p_image->'main_sha256') then
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
  if exists(select 1 from private.item_save_used_ids x where x.owner_id=v_owner
    and (x.item_id=i.id or x.image_id=(p_image->>'id')::uuid)) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if p_claim is not null then
    if exists(select 1 from private.ai_save_used_receipts x where x.owner_id=v_owner
      and (x.request_id=(p_claim->>'requestId')::uuid or x.item_id=i.id or x.image_id=(p_image->>'id')::uuid)) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    select * into p from public.profiles where owner_id=v_owner;
    select * into c from private.ai_controls where owner_id=v_owner for update nowait;
    select * into u from private.ai_usage where owner_id=v_owner and request_id=(p_claim->>'requestId')::uuid for update nowait;
    if not found or u.dispatched_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
    select * into r from private.ai_requests where owner_id=v_owner and request_id=u.request_id for update nowait;
    if not found then
      if u.closed_reason is null or u.closed_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
      select * into e from private.ai_usage_evidence where owner_id=v_owner and request_id=u.request_id;
      if not found or e.claim_identity is null or e.claim_identity is distinct from jsonb_build_object(
        'draftId',p_claim->'draftId','generation',p_claim->'generation','imageSha256',p_claim->'imageSha256',
        'bytes',p_image->'main_bytes','width',p_image->'width','height',p_image->'height') then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      v_refuse := true;
    else
      if p_claim->'requestId' is distinct from to_jsonb(r.request_id)
        or p_claim->'draftId' is distinct from to_jsonb(r.draft_id)
        or p_claim->'generation' is distinct from to_jsonb(r.generation)
        or p_claim->'imageSha256' is distinct from to_jsonb(r.image_sha256) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      select * into proof from private.ai_analysis_attestations where owner_id=v_owner and request_id=r.request_id for share nowait;
      if not found or p_image->'main_sha256' is distinct from to_jsonb(proof.image_sha256)
        or p_image->'main_bytes' is distinct from to_jsonb(proof.byte_count)
        or p_image->'width' is distinct from to_jsonb(proof.width)
        or p_image->'height' is distinct from to_jsonb(proof.height) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      select * into m from private.ai_execution_manifests where id=proof.manifest_id;
      if not found then raise exception using errcode='22023',message='Request conflict'; end if;
      update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
        'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
        where owner_id=v_owner and request_id=u.request_id and claim_identity is null;
      v_refuse := r.expires_at<=clock_timestamp() or not private.ai_analysis_permitted(p,c,r,clock_timestamp())
        or m.id is distinct from c.execution_manifest_id;
      if not v_refuse and (r.status<>'ready' or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts)) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    end if;
    if v_refuse then
      -- Return, do not raise: the terminal usage identity and close must commit with this ACK.
      perform private.ai_close(v_owner,u.request_id,'UNAVAILABLE',clock_timestamp());
      return query select jsonb_build_object('id',i.id,'owner_id',v_owner),
        jsonb_build_object('id',(p_image->>'id')::uuid,'item_id',i.id,'owner_id',v_owner),
        null::text,'analysis_unavailable'::text;
      return;
    end if;
    for k,v in select key,value from jsonb_each(p_claim->'fields') loop
      kind := case when k=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
        when k=any(array['category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
        then 'ai_observed' else null end;
      if kind is null or jsonb_typeof(v)<>'object' or v is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->k)
        or r.facts->'fields'->k is null or r.facts->'fields'->k in ('null'::jsonb,'[]'::jsonb)
        or p_item->k is distinct from r.facts->'fields'->k
        or p_item->'field_provenance'->k is distinct from jsonb_build_object('kind',kind,'revision',1) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      derived := derived||jsonb_build_object(k,jsonb_build_object('kind',kind,'revision',1));
    end loop;
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
  insert into private.ai_item_save_attempts values(v_owner,i.id,encode(sha256(convert_to(p_claim::text,'UTF8')),'hex'),
    m.id,m.model_id,m.prompt_version,proof.image_sha256,proof.byte_count,proof.width,proof.height,derived,false);
  return query select result.item,result.image,result.fingerprint,result.state;
exception
  when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow then raise exception using errcode='22023',message='Invalid input';
end;
$$;

create or replace function private.reserve_image_change(p_owner uuid,p_intent jsonb,p_recovery_objects jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare a private.image_change_attempts; target public.items; old_item public.items; image public.item_images; source public.item_images;
  r private.ai_requests; proof private.ai_analysis_attestations; m private.ai_execution_manifests;
  p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence;
  claim jsonb := nullif(p_intent->'claim','null'); derived jsonb := '{}'; key text; value jsonb; kind text;
  fingerprint text := private.image_change_hash(p_intent); refused boolean := false; recovery boolean := p_recovery_objects is not null;
begin
  perform private.image_change_lock(p_owner);
  perform 1 from public.profiles where owner_id=p_owner for update nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select * into a from private.image_change_attempts where owner_id=p_owner and request_id=(p_intent->>'requestId')::uuid for update nowait;
  if found then
    if a.fingerprint is distinct from fingerprint or a.state='cancelled'
      or a.kind<>(case when recovery then 'recovery' else 'replacement' end)
      or private.image_change_fenced(p_owner,a.item_id) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return private.image_change_receipt(a);
  end if;
  target := private.image_change_intent(p_owner,p_intent);
  select * into old_item from public.items where owner_id=p_owner and id=target.id;
  if recovery then
    if claim is not null or p_intent->'item' is distinct from
      (to_jsonb(old_item)-array['id','owner_id','created_at','updated_at','version','deleted_at']) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    select * into source from public.item_images where owner_id=p_owner and item_id=target.id
      and id=(p_intent->>'sourceImageId')::uuid for share nowait;
    if not found or source.state<>'retired' or source.retired_at>clock_timestamp()
      or source.retired_at<clock_timestamp()-interval '7 days'
      or private.image_change_objects(p_owner,source) is distinct from p_recovery_objects
      or (p_intent->'image')-array['id','alt_text'] is distinct from
        (to_jsonb(source)-array['id','owner_id','item_id','state','retired_at','main_path','thumb_path','alt_text','created_at','description_version']) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
  elsif p_intent->'sourceImageId' is distinct from 'null'::jsonb then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  if claim is not null then
    if jsonb_typeof(claim)<>'object' or octet_length(convert_to(claim::text,'UTF8'))>8192
      or not (claim ?& array['requestId','draftId','generation','imageSha256','fields'])
      or claim-array['requestId','draftId','generation','imageSha256','fields']<>'{}'
      or jsonb_typeof(claim->'fields')<>'object'
      or jsonb_typeof(claim->'generation') is distinct from 'number'
      or coalesce(claim->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(claim->>'draftId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(claim->>'imageSha256','') !~ '^[0-9a-f]{64}$'
      or claim->'imageSha256' is distinct from p_intent->'image'->'main_sha256' then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if exists(select 1 from private.ai_save_used_receipts where owner_id=p_owner and request_id=(claim->>'requestId')::uuid)
      or exists(select 1 from private.image_change_attempts where owner_id=p_owner and analysis_request_id=(claim->>'requestId')::uuid) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    select * into p from public.profiles where owner_id=p_owner;
    select * into c from private.ai_controls where owner_id=p_owner for update nowait;
    select * into u from private.ai_usage where owner_id=p_owner and request_id=(claim->>'requestId')::uuid for update nowait;
    if not found or u.dispatched_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
    select * into r from private.ai_requests where owner_id=p_owner and request_id=u.request_id for update nowait;
    if not found then
      select * into e from private.ai_usage_evidence where owner_id=p_owner and request_id=u.request_id;
      if u.closed_at is null or u.closed_reason is null or e.claim_identity is distinct from jsonb_build_object(
        'draftId',claim->'draftId','generation',claim->'generation','imageSha256',claim->'imageSha256',
        'bytes',p_intent->'image'->'main_bytes','width',p_intent->'image'->'width','height',p_intent->'image'->'height') then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      refused := true;
    else
      select * into proof from private.ai_analysis_attestations where owner_id=p_owner and request_id=r.request_id for share nowait;
      if not found or claim->'draftId' is distinct from to_jsonb(r.draft_id)
        or claim->'generation' is distinct from to_jsonb(r.generation)
        or claim->'imageSha256' is distinct from to_jsonb(r.image_sha256)
        or claim->'imageSha256' is distinct from p_intent->'image'->'main_sha256'
        or to_jsonb(proof.image_sha256) is distinct from claim->'imageSha256'
        or to_jsonb(proof.byte_count) is distinct from p_intent->'image'->'main_bytes'
        or to_jsonb(proof.width) is distinct from p_intent->'image'->'width'
        or to_jsonb(proof.height) is distinct from p_intent->'image'->'height' then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      select * into m from private.ai_execution_manifests where id=proof.manifest_id;
      if not found then raise exception using errcode='22023',message='Request conflict'; end if;
      update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
        'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
        where owner_id=p_owner and request_id=u.request_id and claim_identity is null;
      refused := r.expires_at<=clock_timestamp() or not private.ai_analysis_permitted(p,c,r,clock_timestamp())
        or m.id is distinct from c.execution_manifest_id;
      if not refused and (r.status<>'ready' or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts)) then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    end if;
    if refused then
      perform private.ai_close(p_owner,u.request_id,'UNAVAILABLE',clock_timestamp());
      return jsonb_build_object('state','analysis_unavailable','requestId',p_intent->'requestId','itemId',p_intent->'itemId','imageId',p_intent->'imageId');
    end if;
    for key,value in select k,v from jsonb_each(claim->'fields') as f(k,v) loop
      kind := case when key=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
        when key=any(array['category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
        then 'ai_observed' else null end;
      if kind is null or value is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->key)
        or r.facts->'fields'->key is null or r.facts->'fields'->key in ('null'::jsonb,'[]'::jsonb)
        or p_intent->'item'->key is distinct from r.facts->'fields'->key
        or old_item.field_provenance->key->>'kind'='user'
        or to_jsonb(old_item)->key not in ('null'::jsonb,'[]'::jsonb,'""'::jsonb)
        or target.field_provenance->key is distinct from jsonb_build_object('kind',kind,
          'revision',coalesce((old_item.field_provenance->key->>'revision')::integer,0)+1) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
      derived := derived||jsonb_build_object(key,target.field_provenance->key);
    end loop;
  end if;
  for key,value in select k,v from jsonb_each(target.field_provenance) as f(k,v) loop
    if value->>'kind' in ('ai_observed','ai_estimated') and value is distinct from old_item.field_provenance->key
      and value is distinct from derived->key then raise exception using errcode='22023',message='Invalid input'; end if;
  end loop;
  image := jsonb_populate_record(null::public.item_images,p_intent->'image');
  insert into public.item_images(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
    values(image.id,p_owner,target.id,image.main_bytes,image.thumb_bytes,image.main_sha256,image.thumb_sha256,image.width,image.height,image.alt_text)
    returning * into image;
  insert into private.image_change_attempts(owner_id,request_id,item_id,image_id,kind,state,expected_version,current_image_id,
    description_version,fingerprint,item_hash,result_hash,source_image_id,source_objects,analysis_request_id,manifest_id,model_id,prompt_version,fields)
    values(p_owner,(p_intent->>'requestId')::uuid,target.id,image.id,case when recovery then 'recovery' else 'replacement' end,'reserved',
      old_item.version,(p_intent->>'currentImageId')::uuid,(p_intent->>'descriptionVersion')::integer,fingerprint,
      private.item_save_value_hash(old_item),private.item_save_value_hash(target),source.id,p_recovery_objects,u.request_id,
      m.id,m.model_id,m.prompt_version,derived) returning * into a;
  return private.image_change_receipt(a);
exception when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception using errcode='22023',message='Invalid input';
end;
$$;

create or replace function public.reserve_restored_item_save(p_item jsonb,p_image jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  estimated constant text[] := array['material','seasons','formality','style_tags'];
  observed constant text[] := array['category','garment_type','subcategory','colours','pattern','sleeve_length','garment_length',
    'brand','size_label','upper_coverage','lower_coverage'];
  v_owner uuid; v_item uuid; i public.items; k text; v jsonb; r record;
begin
  perform private.image_change_lock(auth.uid());
  v_owner := private.item_save_owner();
  if p_item is null or jsonb_typeof(p_item)<>'object' or jsonb_typeof(p_item->'field_provenance') is distinct from 'object'
    or jsonb_typeof(p_item->'id') is distinct from 'string'
    or p_item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  v_item := (p_item->>'id')::uuid;
  for k,v in select key,value from jsonb_each(p_item->'field_provenance') loop
    if jsonb_typeof(v)<>'object'
      or (v->>'kind'='ai_estimated' and not k=any(estimated)) or (v->>'kind'='ai_observed' and not k=any(observed))
      or (v->>'kind' in ('ai_estimated','ai_observed')
        and coalesce(p_item->k,'null'::jsonb) in ('null'::jsonb,'[]'::jsonb,'""'::jsonb)) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  -- Only an unfinished restored save may be replayed. An item that was saved, analyzed, changed, trashed or is being
  -- deleted is never touched again through this path.
  if exists(select 1 from private.ai_item_save_attempts a where a.owner_id=v_owner and a.item_id=v_item)
    or exists(select 1 from private.image_change_attempts c where c.owner_id=v_owner and c.item_id=v_item)
    or exists(select 1 from private.item_deletion_claims c where c.owner_id=v_owner and c.item_id=v_item)
    or private.image_change_fenced(v_owner,v_item)
    or exists(select 1 from public.items x where x.owner_id=v_owner and x.id=v_item and x.deleted_at is not null)
    or exists(select 1 from public.item_images x where x.owner_id=v_owner and x.item_id=v_item and x.state<>'pending') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  i := jsonb_populate_record(null::public.items,p_item||jsonb_build_object('owner_id',v_owner,'version',1));
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  insert into private.ai_item_save_context values(v_owner,i.id,private.item_save_value_hash(i));
  select * into r from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
  delete from private.ai_item_save_context where owner_id=v_owner and item_id=i.id;
  return query select r.item,r.image,r.fingerprint,r.state;
exception
  when lock_not_available then raise exception using errcode='22023',message='Request conflict';
  when invalid_text_representation or datatype_mismatch or numeric_value_out_of_range or datetime_field_overflow
    or invalid_datetime_format then raise exception using errcode='22023',message='Invalid input';
end;
$$;

commit;
