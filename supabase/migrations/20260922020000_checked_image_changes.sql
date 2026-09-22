-- I10b: explicit checked photo changes and owner-confirmed logical deletion.
begin;

create table private.image_change_attempts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  item_id uuid not null,
  image_id uuid not null,
  kind text not null check (kind in ('replacement','recovery')),
  state text not null check (state in ('reserved','completed','cancelled')),
  expected_version bigint,
  current_image_id uuid,
  description_version integer,
  fingerprint text,
  item_hash text,
  result_hash text,
  source_image_id uuid,
  source_objects jsonb,
  analysis_request_id uuid,
  manifest_id text references private.ai_execution_manifests(id),
  model_id text,
  prompt_version integer,
  fields jsonb,
  completed_version bigint,
  primary key(owner_id,request_id),
  unique(owner_id,image_id),
  unique(owner_id,analysis_request_id),
  check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$')
);
create unique index image_change_one_reserved on private.image_change_attempts(owner_id,item_id) where state='reserved';

create table private.image_change_context (
  transaction_id xid8 not null,
  owner_id uuid not null,
  item_id uuid not null,
  request_id uuid not null,
  target_id uuid not null,
  purpose text not null check (purpose in ('replacement','begin_deletion','finish_deletion','image_transition','forget_pending')),
  expected_version bigint,
  old_hash text not null,
  new_hash text,
  primary key(transaction_id,owner_id,item_id,target_id,purpose)
);
create table private.image_change_history (
  owner_id uuid not null,
  item_id uuid not null,
  request_id uuid not null,
  committed_version bigint not null check (committed_version>=2),
  source_image_id uuid,
  image_sha256 text not null,
  model_id text not null,
  prompt_version integer not null,
  fields jsonb not null,
  manifest_id text not null references private.ai_execution_manifests(id),
  primary key(owner_id,item_id,request_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id,source_image_id) references public.item_images(owner_id,item_id,id)
    on delete set null(source_image_id)
);
create table private.item_deletion_operations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  item_id uuid not null,
  phase text not null check (phase in (
    'preparing','blocked_preflight','prepared','authorized','removing_registered','completed','cancelled')),
  expected_version bigint,
  image_manifest text,
  inventory_hash text,
  image_cursor uuid,
  object_cursor text,
  images_done boolean not null default false,
  objects_done boolean not null default false,
  target_count bigint not null default 0,
  reason text check (reason in ('UNSUPPORTED_TARGET','INVARIANT')),
  begin_receipt jsonb,
  primary key(owner_id,request_id)
);
create unique index item_deletion_one_fence on private.item_deletion_operations(owner_id,item_id) where phase<>'cancelled';
create table private.item_deletion_targets (
  owner_id uuid not null,
  request_id uuid not null,
  ordinal bigint not null,
  path text not null,
  object_id uuid,
  object_version text,
  object_owner text,
  legacy_owner uuid,
  image_id uuid,
  category text not null check (category in ('pending','unmanifested','registered')),
  authorized boolean not null default false,
  reconciled_absent boolean not null default false,
  primary key(owner_id,request_id,ordinal),
  unique(owner_id,request_id,path),
  foreign key(owner_id,request_id) references private.item_deletion_operations(owner_id,request_id) on delete cascade
);
alter table private.image_change_attempts enable row level security;
alter table private.image_change_context enable row level security;
alter table private.image_change_history enable row level security;
alter table private.item_deletion_operations enable row level security;
alter table private.item_deletion_targets enable row level security;
revoke all on private.image_change_attempts,private.image_change_context,private.image_change_history,
  private.item_deletion_operations,private.item_deletion_targets from public,anon,authenticated,service_role;

create function private.image_change_hash(p_value jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value::text,'UTF8')),'hex');
$$;
create function private.image_change_lock(p_owner uuid,p_exclusive boolean default false,p_deleting_account boolean default false)
returns void language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare enabled boolean;
begin
  if p_owner is null or current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='42501',message='Not available';
  end if;
  if p_exclusive then
    select a.enabled into enabled from private.approved_accounts a where a.user_id=p_owner for no key update nowait;
  else
    select a.enabled into enabled from private.approved_accounts a where a.user_id=p_owner for share nowait;
  end if;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select a.enabled into enabled from private.approved_accounts a where a.user_id=p_owner;
  if not enabled and not (p_deleting_account and exists(
    select 1 from private.deletion_jobs where owner_id=p_owner and stage='rows')) then
    raise exception using errcode='42501',message='Not available';
  end if;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function private.image_change_fenced(p_owner uuid,p_item uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  select exists(select 1 from private.item_deletion_operations
    where owner_id=p_owner and item_id=p_item and phase<>'cancelled');
$$;
create or replace function private.item_save_owner() returns uuid
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid();
begin
  perform private.image_change_lock(u);
  if not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  perform 1 from public.profiles where owner_id=u for update nowait;
  if not found or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  return u;
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create or replace function private.item_lifecycle_owner() returns uuid
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin return private.item_save_owner(); end;
$$;
create function private.consume_image_change_context(p_owner uuid,p_item uuid,p_target uuid,p_purpose text,
  p_version bigint,p_old jsonb,p_new jsonb) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare consumed uuid;
begin
  if p_purpose in ('image_transition','forget_pending') then
    p_old := p_old-array['main_path','thumb_path']; p_new := p_new-array['main_path','thumb_path'];
  end if;
  delete from private.image_change_context c
    where c.transaction_id=pg_current_xact_id() and c.owner_id=p_owner and c.item_id=p_item
      and c.target_id=p_target and c.purpose=p_purpose and c.expected_version is not distinct from p_version
      and c.old_hash=private.image_change_hash(p_old) and c.new_hash is not distinct from private.image_change_hash(p_new)
    returning c.request_id into consumed;
  return found;
end;
$$;

create function private.guard_image_change_item() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; target_item uuid; account_rows boolean; allowed boolean := false;
begin
  u := case when tg_op='INSERT' then new.owner_id else old.owner_id end;
  target_item := case when tg_op='INSERT' then new.id else old.id end;
  account_rows := tg_op='DELETE' and exists(select 1 from private.deletion_jobs
    where owner_id=u and stage='rows') and not exists(select 1 from private.approved_accounts where user_id=u and enabled);
  perform private.image_change_lock(u,false,account_rows);
  if account_rows and exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,u::text||'/')) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if private.image_change_fenced(u,target_item) then
    if tg_op='UPDATE' then
      allowed := private.consume_image_change_context(u,target_item,target_item,'begin_deletion',old.version,to_jsonb(old),to_jsonb(new));
    elsif tg_op='DELETE' then
      allowed := account_rows or private.consume_image_change_context(u,target_item,target_item,'finish_deletion',old.version,to_jsonb(old),null);
    end if;
    if not allowed then raise exception using errcode='22023',message='Request conflict'; end if;
  end if;
  if tg_op='DELETE' then
    update private.image_change_attempts set state=case when state='reserved' then 'cancelled' else state end,
      expected_version=null,current_image_id=null,description_version=null,fingerprint=null,item_hash=null,result_hash=null,
      source_image_id=null,source_objects=null,manifest_id=null,model_id=null,prompt_version=null,fields=null,completed_version=null
      where owner_id=u and item_id=old.id;
    return old;
  end if;
  return new;
end;
$$;
create trigger aa_image_change_item before insert or update or delete on public.items
for each row execute function private.guard_image_change_item();

create function private.guard_image_change_image() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid; parent uuid; target uuid; authorized boolean := false; account_rows boolean;
begin
  u := case when tg_op='INSERT' then new.owner_id else old.owner_id end;
  parent := case when tg_op='INSERT' then new.item_id else old.item_id end;
  target := case when tg_op='INSERT' then new.id else old.id end;
  account_rows := tg_op='DELETE' and exists(select 1 from private.deletion_jobs where owner_id=u and stage='rows')
    and not exists(select 1 from private.approved_accounts where user_id=u and enabled);
  perform private.image_change_lock(u,false,account_rows);
  if account_rows and exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,u::text||'/')) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if tg_op='UPDATE' then
    if row(new.owner_id,new.item_id,new.id) is distinct from row(old.owner_id,old.item_id,old.id) then
      raise exception using errcode='42501',message='Not available';
    end if;
    authorized := private.consume_image_change_context(u,parent,target,'image_transition',null,to_jsonb(old),to_jsonb(new));
    if not authorized and exists(select 1 from private.image_change_attempts where owner_id=u and image_id=target)
      and row(new.state,new.retired_at) is distinct from row(old.state,old.retired_at) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
  end if;
  if private.image_change_fenced(u,parent) then
    if tg_op='DELETE' then
      authorized := account_rows or private.consume_image_change_context(u,parent,target,'forget_pending',null,to_jsonb(old),null)
        or (not exists(select 1 from public.items where owner_id=u and id=parent)
          and exists(select 1 from private.item_deletion_operations where owner_id=u and item_id=parent and phase='removing_registered')
          and not exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,u::text||'/'||parent::text||'/')));
    end if;
    if not authorized then raise exception using errcode='22023',message='Request conflict'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger aa_image_change_image before insert or update or delete on public.item_images
for each row execute function private.guard_image_change_image();

-- Keep the installed Add implementation and its committed refusal/accounting behavior.
alter function public.reserve_analyzed_item_save(jsonb,jsonb,jsonb) set schema private;
alter function private.reserve_analyzed_item_save(jsonb,jsonb,jsonb) rename to reserve_analyzed_item_save_v10;
revoke all on function private.reserve_analyzed_item_save_v10(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.reserve_analyzed_item_save(p_item jsonb,p_image jsonb,p_claim jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid;
begin
  perform private.image_change_lock(auth.uid());
  u := private.item_save_owner();
  if exists(select 1 from private.image_change_attempts
    where owner_id=u and analysis_request_id::text=p_claim->>'requestId') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return query select * from private.reserve_analyzed_item_save_v10(p_item,p_image,p_claim);
end;
$$;

create or replace function private.item_field_provenance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fields constant text[] := array['title','category','subcategory','colours','pattern','sleeve_length','garment_length',
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

create or replace function public.item_attribution_history(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() or not exists(
    select 1 from public.items where owner_id=auth.uid() and id=p_item_id and deleted_at is null) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return coalesce((select jsonb_agg(h.value order by h.version,h.rank,h.request_id nulls first) from (
    select 1::bigint version,0 rank,null::uuid request_id,
      jsonb_build_object('source_image_id',a.source_image_id,'image_sha256',a.image_sha256,
        'model_id',a.model_id,'prompt_version',a.prompt_version,'fields',a.fields) value
      from private.item_attribution_history a where a.owner_id=auth.uid() and a.item_id=p_item_id
    union all
    select a.committed_version,1,a.request_id,
      jsonb_build_object('source_image_id',a.source_image_id,'image_sha256',a.image_sha256,
        'model_id',a.model_id,'prompt_version',a.prompt_version,'fields',a.fields)
      from private.image_change_history a where a.owner_id=auth.uid() and a.item_id=p_item_id
  ) h),'[]'::jsonb);
end;
$$;

create function private.image_change_intent(p_owner uuid,p_intent jsonb) returns public.items
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
            'black','white','grey','navy','blue','green','olive','beige','brown','red','yellow','orange','pink','purple','unknown')) then
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

create function private.image_change_objects(p_owner uuid,p_image public.item_images) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare result jsonb; n integer;
begin
  select count(*),jsonb_object_agg(case o.name when p_image.main_path then 'main' else 'thumb' end,
    jsonb_build_object('id',o.id,'version',o.version)) into n,result
    from (select * from storage.objects where bucket_id='wardrobe' and name in(p_image.main_path,p_image.thumb_path)
      for share nowait) o
    where o.owner_id=p_owner::text and (o.owner is null or o.owner=p_owner)
      and o.archived_at is null and not o.is_delete_marker and not o.is_versioned
      and length(o.version) between 1 and 1024;
  if n<>2 then raise exception using errcode='22023',message='Upload incomplete'; end if;
  return result;
end;
$$;
create function private.image_change_receipt(p_attempt private.image_change_attempts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('requestId',p_attempt.request_id,'itemId',p_attempt.item_id,'imageId',p_attempt.image_id,
    'kind',p_attempt.kind,'state',p_attempt.state,'fingerprint',p_attempt.fingerprint,'completedVersion',p_attempt.completed_version);
$$;
create function public.image_change_status(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a private.image_change_attempts;
begin
  perform private.image_change_lock(auth.uid());
  select * into a from private.image_change_attempts where owner_id=auth.uid() and item_id=p_item_id and request_id=p_request_id;
  if not found then return null; end if;
  return private.image_change_receipt(a);
end;
$$;
create function public.image_change_requests(p_item_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.image_change_lock(auth.uid());
  return coalesce((select jsonb_agg(private.image_change_receipt(a) order by request_id) from private.image_change_attempts a
    where owner_id=auth.uid() and item_id=p_item_id and state='reserved'),'[]');
end;
$$;
create function public.image_recovery_versions(p_item_id uuid,p_after uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.image_change_lock(auth.uid());
  if private.image_change_fenced(auth.uid(),p_item_id) or not exists(
    select 1 from public.items where owner_id=auth.uid() and id=p_item_id and deleted_at is null) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('image',to_jsonb(im),
    'eligible',im.retired_at<=clock_timestamp() and im.retired_at>=clock_timestamp()-interval '7 days') order by im.id)
    from (select * from public.item_images where owner_id=auth.uid() and item_id=p_item_id and state='retired'
      and (p_after is null or id>p_after) order by id limit 40) im),'[]');
end;
$$;

create function private.reserve_image_change(p_owner uuid,p_intent jsonb,p_recovery_objects jsonb default null) returns jsonb
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
        or m.id is distinct from c.execution_manifest_id or m.review_expires_at<=clock_timestamp();
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
        when key=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
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
create function public.reserve_image_change(p_intent jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin return private.reserve_image_change(auth.uid(),p_intent); end;
$$;
create function public.reserve_image_recovery(p_owner_id uuid,p_intent jsonb,p_objects jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if p_objects is null then raise exception using errcode='22023',message='Invalid input'; end if;
  return private.reserve_image_change(p_owner_id,p_intent,p_objects);
end;
$$;
create function public.image_recovery_preflight(p_intent jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); target public.items; source public.item_images; a private.image_change_attempts;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  select * into a from private.image_change_attempts where owner_id=u and request_id=(p_intent->>'requestId')::uuid;
  if found then
    if a.kind<>'recovery' or a.state='cancelled' or a.fingerprint is distinct from private.image_change_hash(p_intent) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return jsonb_build_object('receipt',private.image_change_receipt(a));
  end if;
  target := private.image_change_intent(u,p_intent);
  select * into source from public.item_images where owner_id=u and item_id=target.id and id=(p_intent->>'sourceImageId')::uuid for share nowait;
  if not found or source.state<>'retired' or source.retired_at>clock_timestamp() or source.retired_at<clock_timestamp()-interval '7 days' then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return jsonb_build_object('image',to_jsonb(source),'objects',private.image_change_objects(u,source),'state','source');
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function public.image_change_preflight(p_intent jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); a private.image_change_attempts; image public.item_images;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  select * into a from private.image_change_attempts where owner_id=u and request_id=(p_intent->>'requestId')::uuid for update nowait;
  if not found or a.fingerprint is distinct from private.image_change_hash(p_intent) or a.state='cancelled'
    or private.image_change_fenced(u,a.item_id) then raise exception using errcode='22023',message='Request conflict'; end if;
  if a.state='reserved' then perform private.image_change_intent(u,p_intent); end if;
  select * into image from public.item_images where owner_id=u and item_id=a.item_id and id=a.image_id for share nowait;
  if not found or image.state<>(case when a.state='reserved' then 'pending' else 'ready' end)
    or image.description_version<>1 or image.retired_at is not null
    or to_jsonb(image)-array['owner_id','item_id','state','retired_at','main_path','thumb_path','created_at','description_version']
      is distinct from p_intent->'image' then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  return jsonb_build_object('image',to_jsonb(image),'objects',private.image_change_objects(u,image),'state',a.state);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.complete_image_change(p_owner_id uuid,p_intent jsonb,p_objects jsonb) returns void
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
    pattern=target.pattern,sleeve_length=target.sleeve_length,garment_length=target.garment_length,
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
create function public.cancel_image_change(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); a private.image_change_attempts;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  select * into a from private.image_change_attempts where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found then return null; end if;
  if a.state='reserved' then
    update private.image_change_attempts set state='cancelled',fields=null,source_objects=null,
      manifest_id=null,model_id=null,prompt_version=null where owner_id=u and request_id=p_request_id returning * into a;
  end if;
  return private.image_change_receipt(a);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function private.item_deletion_target_supported(p_owner uuid,p_item uuid,p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(starts_with(p_name,p_owner::text||'/'||p_item::text||'/') and octet_length(p_name)<=1024
    and array_length(string_to_array(p_name,'/'),1) between 3 and 18
    and not exists(select 1 from unnest(string_to_array(p_name,'/')) segment
      where length(segment) not between 1 and 128 or segment in ('.','..') or segment !~ '^[A-Za-z0-9._-]+$'),false);
$$;
create function private.item_deletion_receipt(p_operation private.item_deletion_operations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('requestId',p_operation.request_id,'itemId',p_operation.item_id,'phase',p_operation.phase,
    'expectedVersion',p_operation.expected_version,'inventoryHash',p_operation.inventory_hash,
    'targetCount',p_operation.target_count,'reason',p_operation.reason,'begin',p_operation.begin_receipt,
    'pendingTargets',(select count(*) from private.item_deletion_targets where owner_id=p_operation.owner_id
      and request_id=p_operation.request_id and category='pending'),
    'unmanifestedTargets',(select count(*) from private.item_deletion_targets where owner_id=p_operation.owner_id
      and request_id=p_operation.request_id and category='unmanifested'),
    'registeredTargets',(select count(*) from private.item_deletion_targets where owner_id=p_operation.owner_id
      and request_id=p_operation.request_id and category='registered'));
$$;
create function public.item_deletion_operation_status(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d private.item_deletion_operations;
begin
  perform private.image_change_lock(auth.uid());
  select * into d from private.item_deletion_operations where owner_id=auth.uid() and item_id=p_item_id and request_id=p_request_id;
  if not found then return null; end if;
  return private.item_deletion_receipt(d);
end;
$$;
create function public.item_deletion_operations(p_item_ids uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.image_change_lock(auth.uid());
  if coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 40
    or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids) then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  return coalesce((select jsonb_agg(private.item_deletion_receipt(d) order by d.item_id,d.request_id)
    from private.item_deletion_operations d where d.owner_id=auth.uid() and d.item_id=any(p_item_ids) and d.phase<>'cancelled'),'[]');
end;
$$;
create function public.prepare_item_deletion(p_item_id uuid,p_request_id uuid,p_expected_version bigint,p_image_manifest_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); i public.items; d private.item_deletion_operations; c private.item_deletion_claims; manifest text;
begin
  perform private.image_change_lock(u,true);
  perform private.item_lifecycle_owner();
  if p_item_id is null or p_request_id is null or p_expected_version is null
    or p_expected_version not between 1 and 9007199254740990 or p_image_manifest_sha256 is null
    or p_image_manifest_sha256 !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='Invalid input'; end if;
  select * into d from private.item_deletion_operations where owner_id=u and request_id=p_request_id for update nowait;
  if found then
    if d.item_id<>p_item_id or d.expected_version is distinct from p_expected_version
      or d.image_manifest is distinct from p_image_manifest_sha256 or d.phase='cancelled' then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    return private.item_deletion_receipt(d);
  end if;
  perform 1 from public.item_images where owner_id=u and item_id=p_item_id order by id for update nowait;
  select * into i from public.items where owner_id=u and id=p_item_id for update nowait;
  if not found or i.deleted_at is null or i.version<>p_expected_version then raise exception using errcode='22023',message='Request conflict'; end if;
  select private.item_lifecycle_manifest(coalesce(jsonb_agg(to_jsonb(im)),'[]')) into manifest
    from public.item_images im where owner_id=u and item_id=p_item_id;
  if manifest<>p_image_manifest_sha256 then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into c from private.item_deletion_claims where owner_id=u and item_id=p_item_id;
  if found and (c.request_id<>p_request_id or i.version<>c.expected_version+1) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  insert into private.item_deletion_operations(owner_id,request_id,item_id,phase,expected_version,image_manifest,begin_receipt)
    values(u,p_request_id,p_item_id,'preparing',p_expected_version,manifest,
      case when c.request_id is null then null else jsonb_build_object('request_id',c.request_id,'expected_version',c.expected_version,
        'version',i.version,'started_at',c.started_at,'image_manifest_sha256',manifest) end) returning * into d;
  return private.item_deletion_receipt(d);
exception when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function private.item_deletion_inventory_valid(p_operation private.item_deletion_operations) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare t private.item_deletion_targets; o storage.objects;
begin
  perform 1 from storage.objects where bucket_id='wardrobe'
    and starts_with(name,p_operation.owner_id::text||'/'||p_operation.item_id::text||'/') order by name for share nowait;
  if exists(select 1 from storage.objects objects where objects.bucket_id='wardrobe'
    and starts_with(objects.name,p_operation.owner_id::text||'/'||p_operation.item_id::text||'/')
    and not exists(select 1 from private.item_deletion_targets targets where targets.owner_id=p_operation.owner_id
      and targets.request_id=p_operation.request_id and targets.path=objects.name)) then return false; end if;
  for t in select * from private.item_deletion_targets where owner_id=p_operation.owner_id and request_id=p_operation.request_id loop
    select * into o from storage.objects where bucket_id='wardrobe' and name=t.path;
    if found and (t.reconciled_absent or o.id is distinct from t.object_id or o.version is distinct from t.object_version
      or o.owner_id is distinct from t.object_owner or o.owner is distinct from t.legacy_owner
      or o.archived_at is not null or o.is_delete_marker is distinct from false or o.is_versioned is distinct from false) then return false; end if;
    if not found and t.object_id is not null and p_operation.phase in ('preparing','prepared','blocked_preflight') then return false; end if;
  end loop;
  return true;
end;
$$;
create function public.inventory_item_deletion(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; im public.item_images; o storage.objects;
  n integer := 0; v_path text; v_ordinal bigint; manifest text; supported boolean := true;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or d.phase<>'preparing' then raise exception using errcode='22023',message='Request conflict'; end if;
  v_ordinal := d.target_count;
  if not d.images_done then
    for im in select * from public.item_images where owner_id=u and item_id=p_item_id
      and (d.image_cursor is null or id>d.image_cursor) order by id limit 40 for share nowait loop
      n := n+1;
      foreach v_path in array array[im.main_path,im.thumb_path] loop
        select * into o from storage.objects where bucket_id='wardrobe' and name=v_path for share nowait;
        supported := supported and private.item_deletion_target_supported(u,p_item_id,v_path)
          and (o.id is null or (o.owner_id=u::text and (o.owner is null or o.owner=u)
            and o.archived_at is null and not o.is_delete_marker and not o.is_versioned and length(o.version) between 1 and 1024));
        v_ordinal := v_ordinal+1;
        insert into private.item_deletion_targets(owner_id,request_id,ordinal,path,object_id,object_version,object_owner,legacy_owner,image_id,category)
          values(u,p_request_id,v_ordinal,v_path,o.id,o.version,o.owner_id,o.owner,im.id,case when im.state='pending' then 'pending' else 'registered' end);
      end loop;
      d.image_cursor := im.id;
    end loop;
    d.images_done := n<40;
  else
    for o in select * from storage.objects where bucket_id='wardrobe' and starts_with(name,u::text||'/'||p_item_id::text||'/')
      and (d.object_cursor is null or name>d.object_cursor) order by name limit 40 for share nowait loop
      n := n+1;
      supported := supported and private.item_deletion_target_supported(u,p_item_id,o.name)
        and o.owner_id=u::text and (o.owner is null or o.owner=u) and o.archived_at is null
        and not o.is_delete_marker and not o.is_versioned and length(o.version) between 1 and 1024;
      if not exists(select 1 from private.item_deletion_targets where owner_id=u and request_id=p_request_id and path=o.name) then
        v_ordinal := v_ordinal+1;
        insert into private.item_deletion_targets(owner_id,request_id,ordinal,path,object_id,object_version,object_owner,legacy_owner,category)
          values(u,p_request_id,v_ordinal,o.name,o.id,o.version,o.owner_id,o.owner,'unmanifested');
      end if;
      d.object_cursor := o.name;
    end loop;
    d.objects_done := n<40;
  end if;
  if not coalesce(supported,false) then d.phase := 'blocked_preflight'; d.reason := 'UNSUPPORTED_TARGET'; end if;
  if d.images_done and d.objects_done and d.phase='preparing' then
    select private.item_lifecycle_manifest(coalesce(jsonb_agg(to_jsonb(i)),'[]')) into manifest
      from public.item_images i where owner_id=u and item_id=p_item_id;
    if manifest<>d.image_manifest or not private.item_deletion_inventory_valid(d) then
      d.phase := 'blocked_preflight'; d.reason := 'INVARIANT';
    else
      d.phase := 'prepared';
      select private.image_change_hash(coalesce(jsonb_agg(jsonb_build_array(t.ordinal,t.path,t.object_id,t.object_version,
        t.object_owner,t.legacy_owner,t.image_id,t.category) order by t.ordinal),'[]')) into d.inventory_hash
        from private.item_deletion_targets t where owner_id=u and request_id=p_request_id;
    end if;
  end if;
  update private.item_deletion_operations set phase=d.phase,reason=d.reason,image_cursor=d.image_cursor,object_cursor=d.object_cursor,
    images_done=d.images_done,objects_done=d.objects_done,target_count=v_ordinal,inventory_hash=d.inventory_hash
    where owner_id=u and request_id=p_request_id returning * into d;
  return private.item_deletion_receipt(d);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function public.cancel_item_deletion_preparation(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or d.phase not in ('preparing','blocked_preflight','prepared','cancelled') or d.begin_receipt is not null then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  delete from private.item_deletion_targets where owner_id=u and request_id=p_request_id;
  update private.item_deletion_operations set phase='cancelled',reason=null,image_manifest=null,inventory_hash=null,
    image_cursor=null,object_cursor=null,target_count=0 where owner_id=u and request_id=p_request_id returning * into d;
  return private.item_deletion_receipt(d);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function public.authorize_item_deletion(p_item_id uuid,p_request_id uuid,p_inventory_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; t private.item_deletion_targets;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or p_inventory_hash is null or d.inventory_hash is distinct from p_inventory_hash
    or d.phase not in ('prepared','authorized','removing_registered') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if not private.item_deletion_inventory_valid(d) then raise exception using errcode='22023',message='Request conflict'; end if;
  if d.phase='prepared' then
    for t in select * from private.item_deletion_targets where owner_id=u and request_id=p_request_id and category='unmanifested' loop
      if t.path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(main|thumb)\.jpg$'
        and split_part(t.path,'/',3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        insert into private.item_image_used_ids(owner_id,image_id) values(u,split_part(t.path,'/',3)::uuid) on conflict do nothing;
      end if;
    end loop;
    update private.image_change_attempts set state='cancelled',fields=null,source_objects=null,manifest_id=null,model_id=null,prompt_version=null
      where owner_id=u and item_id=p_item_id and state='reserved';
    update private.ai_item_save_attempts set cancelled=true where owner_id=u and item_id=p_item_id
      and exists(select 1 from private.item_save_attempts where owner_id=u and item_id=p_item_id and state='reserved');
    update private.item_deletion_operations set phase=case when begin_receipt is null then 'authorized' else 'removing_registered' end
      where owner_id=u and request_id=p_request_id returning * into d;
  end if;
  return private.item_deletion_receipt(d);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function public.item_deletion_next_target(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; t private.item_deletion_targets;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or d.phase not in ('authorized','removing_registered') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if not private.item_deletion_inventory_valid(d) then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into t from private.item_deletion_targets where owner_id=u and request_id=p_request_id and not reconciled_absent
    and ((d.phase='removing_registered')=(category='registered')) order by ordinal limit 1 for update nowait;
  if not found then return null; end if;
  update private.item_deletion_targets set authorized=true where owner_id=u and request_id=p_request_id and ordinal=t.ordinal;
  return jsonb_build_object('ordinal',t.ordinal,'path',t.path,'objectId',t.object_id,'version',t.object_version);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;
create function public.reconcile_item_deletion_target(p_item_id uuid,p_request_id uuid,p_ordinal bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; t private.item_deletion_targets;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or d.phase not in ('authorized','removing_registered') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if not private.item_deletion_inventory_valid(d) then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into t from private.item_deletion_targets where owner_id=u and request_id=p_request_id and ordinal=p_ordinal for update nowait;
  if not found or not t.authorized or ((d.phase='removing_registered')<>(t.category='registered')) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if exists(select 1 from storage.objects where bucket_id='wardrobe' and name=t.path) then
    return jsonb_build_object('ordinal',t.ordinal,'state','present');
  end if;
  update private.item_deletion_targets set reconciled_absent=true where owner_id=u and request_id=p_request_id and ordinal=p_ordinal;
  return jsonb_build_object('ordinal',t.ordinal,'state','reconciled_absent');
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create or replace function private.may_delete_storage(p_name text) returns boolean
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations;
begin
  if u is null or not private.is_approved() or not starts_with(p_name,u::text||'/') then return false; end if;
  select * into d from private.item_deletion_operations where owner_id=u and item_id::text=split_part(p_name,'/',2) and phase<>'cancelled';
  if found then
    return d.phase in ('authorized','removing_registered')
      and exists(select 1 from private.item_deletion_targets t where t.owner_id=u and t.request_id=d.request_id and t.path=p_name
        and t.authorized and not t.reconciled_absent and ((d.phase='removing_registered')=(t.category='registered')));
  end if;
  return p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(main|thumb)\.jpg$';
end;
$$;

create or replace function private.guard_item_object_publication() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare image public.item_images; item public.items; u uuid; image_id uuid; parent_id uuid;
  object storage.objects; d private.item_deletion_operations; t private.item_deletion_targets;
begin
  if tg_op='DELETE' then object := old; else object := new; end if;
  if tg_op='UPDATE' then
    if old.bucket_id<>'wardrobe' and new.bucket_id<>'wardrobe' then return new; end if;
    if row(new.id,new.bucket_id,new.name,new.owner,new.owner_id,new.archived_at,new.is_delete_marker,new.is_versioned)
      is distinct from row(old.id,old.bucket_id,old.name,old.owner,old.owner_id,old.archived_at,old.is_delete_marker,old.is_versioned) then
      raise exception using errcode='42501',message='Not available';
    end if;
    if new.version is distinct from old.version then raise exception using errcode='23505',message='The resource already exists'; end if;
  end if;
  if object.bucket_id<>'wardrobe' then return object; end if;
  if split_part(object.name,'/',1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or split_part(object.name,'/',2) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='42501',message='Not available';
  end if;
  u := split_part(object.name,'/',1)::uuid; parent_id := split_part(object.name,'/',2)::uuid;
  -- Native Storage needs 55P03; the shared RPC helper deliberately emits 22023.
  begin
    perform private.image_change_lock(u);
  exception when sqlstate '22023' then
    raise exception using errcode='55P03',message='The resource is locked';
  end;
  select * into d from private.item_deletion_operations where owner_id=u and item_id=parent_id and phase<>'cancelled';
  if found then
    if tg_op<>'DELETE' or d.phase not in ('authorized','removing_registered')
      or not storage.allow_only_operation('storage.object.delete') then raise exception using errcode='42501',message='Not available'; end if;
    select * into t from private.item_deletion_targets where owner_id=u and request_id=d.request_id and path=object.name
      and authorized and not reconciled_absent and ((d.phase='removing_registered')=(category='registered'));
    if not found or row(object.id,object.version,object.owner_id,object.owner)
      is distinct from row(t.object_id,t.object_version,t.object_owner,t.legacy_owner)
      or object.archived_at is not null or object.is_delete_marker is distinct from false or object.is_versioned is distinct from false then
      raise exception using errcode='42501',message='Not available';
    end if;
    return old;
  end if;
  if tg_op='DELETE' then return old; end if;
  select im.* into image from public.item_images im where object.name in(im.main_path,im.thumb_path);
  if not found or image.owner_id<>u or image.item_id<>parent_id or object.owner_id is distinct from u::text
    or (object.owner is not null and object.owner<>u) or object.archived_at is not null
    or object.is_delete_marker is distinct from false or object.is_versioned is distinct from false then
    raise exception using errcode='42501',message='Not available';
  end if;
  image_id := image.id;
  perform 1 from public.profiles where owner_id=u for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id for share nowait;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id for share nowait;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id;
  if not exists(select 1 from private.approved_accounts where user_id=u and enabled)
    or not exists(select 1 from public.profiles where owner_id=u) or image.item_id is distinct from parent_id
    or item.id is null or private.image_change_fenced(u,parent_id)
    or exists(select 1 from private.item_deletion_claims where owner_id=u and item_id=parent_id)
    or (tg_op='INSERT' and (image.state<>'pending' or image.retired_at is not null or item.deleted_at is not null
      or exists(select 1 from private.ai_item_save_attempts where owner_id=u and item_id=parent_id and cancelled)
      or exists(select 1 from private.image_change_attempts a where a.owner_id=u and a.image_id=image.id and a.state='cancelled'))) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return new;
exception when lock_not_available then raise exception using errcode='55P03',message='The resource is locked';
end;
$$;
create or replace trigger item_object_publication_guard after insert or update or delete on storage.objects
for each row execute function private.guard_item_object_publication();

create function public.begin_prepared_item_deletion(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; i public.items; im public.item_images; manifest text; receipt record;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and request_id=p_request_id for update nowait;
  if not found or d.phase not in ('authorized','removing_registered') then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  if not private.item_deletion_inventory_valid(d) then raise exception using errcode='22023',message='Request conflict'; end if;
  if d.phase='removing_registered' then return private.item_deletion_receipt(d); end if;
  if exists(select 1 from private.item_deletion_targets where owner_id=u and request_id=p_request_id
    and category<>'registered' and not reconciled_absent) then raise exception using errcode='22023',message='Request conflict'; end if;
  for im in select * from public.item_images where owner_id=u and item_id=p_item_id and state='pending' order by id for update nowait loop
    if exists(select 1 from storage.objects where bucket_id='wardrobe' and name in(im.main_path,im.thumb_path))
      or (select count(*) from private.item_deletion_targets where owner_id=u and request_id=p_request_id
        and image_id=im.id and category='pending' and reconciled_absent)<>2 then
      raise exception using errcode='22023',message='Request conflict';
    end if;
    insert into private.image_change_context values(pg_current_xact_id(),u,p_item_id,p_request_id,im.id,'forget_pending',null,
      private.image_change_hash(to_jsonb(im)-array['main_path','thumb_path']),null);
    delete from public.item_images where owner_id=u and id=im.id;
  end loop;
  select * into i from public.items where owner_id=u and id=p_item_id for update nowait;
  if not found or i.version<>d.expected_version then raise exception using errcode='22023',message='Request conflict'; end if;
  select private.item_lifecycle_manifest(coalesce(jsonb_agg(to_jsonb(remaining_image)),'[]')) into manifest from public.item_images remaining_image
    where owner_id=u and item_id=p_item_id;
  insert into private.image_change_context values(pg_current_xact_id(),u,p_item_id,p_request_id,p_item_id,'begin_deletion',i.version,
    private.image_change_hash(to_jsonb(i)),private.image_change_hash(to_jsonb(i)));
  select * into receipt from public.begin_item_deletion(p_item_id,i.version,p_request_id,manifest);
  if exists(select 1 from private.image_change_context where transaction_id=pg_current_xact_id() and owner_id=u and request_id=p_request_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  update private.item_deletion_operations set phase='removing_registered',begin_receipt=to_jsonb(receipt)
    where owner_id=u and request_id=p_request_id returning * into d;
  return private.item_deletion_receipt(d);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

alter function public.finish_item_deletion(uuid,uuid) set schema private;
alter function private.finish_item_deletion(uuid,uuid) rename to finish_item_deletion_v9;
revoke all on function private.finish_item_deletion_v9(uuid,uuid) from public,anon,authenticated,service_role;
create function public.finish_item_deletion(p_item_id uuid,p_request_id uuid) returns table(state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare u uuid := auth.uid(); d private.item_deletion_operations; i public.items; c private.item_deletion_claims; result text;
begin
  perform private.image_change_lock(u,true); perform private.item_lifecycle_owner();
  if p_item_id is null or p_request_id is null then raise exception using errcode='22023',message='Invalid input'; end if;
  select * into i from public.items where owner_id=u and id=p_item_id for update nowait;
  if not found then return query select 'absent'::text; return; end if;
  select * into c from private.item_deletion_claims where owner_id=u and item_id=p_item_id for update nowait;
  if not found or c.request_id<>p_request_id then raise exception using errcode='22023',message='Request conflict'; end if;
  select * into d from private.item_deletion_operations where owner_id=u and item_id=p_item_id and phase<>'cancelled' for update nowait;
  if found then
    if d.request_id<>p_request_id or d.phase<>'removing_registered' or not private.item_deletion_inventory_valid(d)
      or exists(select 1 from private.item_deletion_targets where owner_id=u and request_id=p_request_id and not reconciled_absent) then
      raise exception using errcode='22023',message='Request conflict';
    end if;
  else
    insert into private.item_deletion_operations(owner_id,request_id,item_id,phase)
      values(u,p_request_id,p_item_id,'removing_registered');
  end if;
  insert into private.image_change_context values(pg_current_xact_id(),u,p_item_id,p_request_id,p_item_id,'finish_deletion',i.version,
    private.image_change_hash(to_jsonb(i)),null);
  select f.state into result from private.finish_item_deletion_v9(p_item_id,p_request_id) f;
  if result is distinct from 'completed' or exists(select 1 from private.image_change_context
    where transaction_id=pg_current_xact_id() and owner_id=u and request_id=p_request_id) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  delete from private.item_deletion_targets where owner_id=u and request_id=p_request_id;
  update private.item_deletion_operations set phase='completed',expected_version=null,image_manifest=null,inventory_hash=null,
    image_cursor=null,object_cursor=null,target_count=0,reason=null,begin_receipt=null
    where owner_id=u and request_id=p_request_id;
  return query select 'completed'::text;
exception when lock_not_available or unique_violation then raise exception using errcode='22023',message='Request conflict';
end;
$$;

-- New functions have no implicit service/browser authority.
revoke all on function private.image_change_hash(jsonb),private.image_change_lock(uuid,boolean,boolean),
  private.image_change_fenced(uuid,uuid),private.consume_image_change_context(uuid,uuid,uuid,text,bigint,jsonb,jsonb),
  private.guard_image_change_item(),private.guard_image_change_image(),private.image_change_intent(uuid,jsonb),
  private.image_change_objects(uuid,public.item_images),private.image_change_receipt(private.image_change_attempts),
  private.reserve_image_change(uuid,jsonb,jsonb),private.item_deletion_target_supported(uuid,uuid,text),
  private.item_deletion_receipt(private.item_deletion_operations),private.item_deletion_inventory_valid(private.item_deletion_operations)
  from public,anon,authenticated,service_role;
revoke all on function public.reserve_image_change(jsonb),public.reserve_image_recovery(uuid,jsonb,jsonb),
  public.image_change_status(uuid,uuid),public.image_change_requests(uuid),public.image_recovery_versions(uuid,uuid),public.image_recovery_preflight(jsonb),
  public.image_change_preflight(jsonb),public.complete_image_change(uuid,jsonb,jsonb),public.cancel_image_change(uuid,uuid),
  public.item_deletion_operation_status(uuid,uuid),public.item_deletion_operations(uuid[]),
  public.prepare_item_deletion(uuid,uuid,bigint,text),public.inventory_item_deletion(uuid,uuid),
  public.cancel_item_deletion_preparation(uuid,uuid),public.authorize_item_deletion(uuid,uuid,text),
  public.item_deletion_next_target(uuid,uuid),public.reconcile_item_deletion_target(uuid,uuid,bigint),
  public.begin_prepared_item_deletion(uuid,uuid),public.finish_item_deletion(uuid,uuid),
  public.reserve_analyzed_item_save(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reserve_image_change(jsonb),public.image_change_status(uuid,uuid),
  public.image_change_requests(uuid),public.image_recovery_versions(uuid,uuid),public.image_recovery_preflight(jsonb),public.image_change_preflight(jsonb),
  public.cancel_image_change(uuid,uuid),public.item_deletion_operation_status(uuid,uuid),public.item_deletion_operations(uuid[]),
  public.prepare_item_deletion(uuid,uuid,bigint,text),public.inventory_item_deletion(uuid,uuid),
  public.cancel_item_deletion_preparation(uuid,uuid),public.authorize_item_deletion(uuid,uuid,text),
  public.item_deletion_next_target(uuid,uuid),public.reconcile_item_deletion_target(uuid,uuid,bigint),
  public.begin_prepared_item_deletion(uuid,uuid),public.finish_item_deletion(uuid,uuid),
  public.reserve_analyzed_item_save(jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.reserve_image_recovery(uuid,jsonb,jsonb),public.complete_image_change(uuid,jsonb,jsonb) to service_role;

commit;
