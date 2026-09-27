-- Phase 6 P6d (Q5): a restore brings back each item's saved tag history.
-- New objects: private.imported_attribution_history, private.backup_bounded, private.backup_number_bytes,
-- private.backup_compact_bytes, public.restore_item_attribution, public.item_attribution_history_v2 and
-- public.attribution_digest.
-- NOT additive: replaces private.deletion_owner_rows_absent(uuid) with the same signature (P6c's list plus the new
-- table). Hosted apply needs owner approval of the exact bodies, then a body/ACL/owner/search_path read-back.
-- public.item_attribution_history is unchanged: it keeps returning only server-recorded attribution.
begin;

do $$
begin
  if to_regprocedure('private.deletion_owner_rows_absent(uuid)') is null then
    raise exception using message='P6c required';
  end if;
end
$$;

-- Imported claims, kept apart from server-recorded attribution. Rows are written only by restore_item_attribution;
-- nothing reads them as attestation.
create table private.imported_attribution_history (
  owner_id uuid not null,
  item_id uuid not null,
  position smallint not null check (position between 0 and 999),
  source_image_id uuid,
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  model_id text not null,
  prompt_version integer not null check (prompt_version >= 0),
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  import_id uuid not null,
  primary key(owner_id,item_id,position),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id,source_image_id) references public.item_images(owner_id,item_id,id)
    on delete set null(source_image_id)
);
alter table private.imported_attribution_history enable row level security;
revoke all on private.imported_attribution_history from public,anon,authenticated,service_role;

-- The backup's structural bounds (assertBounded in src/domain/export-format.ts), so anything stored here can be
-- exported again. Depth counts from the metadata `tables` object; string and key lengths are UTF-16 code units.
create function private.backup_bounded(p_value jsonb,p_depth integer) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if p_depth>12 then return false; end if;
  case jsonb_typeof(p_value)
    when 'string' then
      return char_length(p_value#>>'{}')+regexp_count(p_value#>>'{}','[\U00010000-\U0010FFFF]')<=8192;
    when 'array' then
      if jsonb_array_length(p_value)>20000 then return false; end if;
      for v in select value from jsonb_array_elements(p_value) loop
        if not private.backup_bounded(v,p_depth+1) then return false; end if;
      end loop;
      return true;
    when 'object' then
      if (select count(*) from jsonb_object_keys(p_value))>64 then return false; end if;
      for k,v in select key,value from jsonb_each(p_value) loop
        if char_length(k)+regexp_count(k,'[\U00010000-\U0010FFFF]')>64 or not private.backup_bounded(v,p_depth+1) then
          return false;
        end if;
      end loop;
      return true;
    when 'number' then
      return abs((p_value#>>'{}')::numeric)<=1.7976931348623157e308;
    else
      return true;
  end case;
end;
$$;

-- The length of a number as JSON.stringify writes it: plain digits from 1e-6 up to 1e21, else d.ddde+n.
create function private.backup_number_bytes(p numeric) returns integer
language plpgsql immutable set search_path = '' as $$
declare t text := trim_scale(abs(p))::text; whole text := split_part(t,'.',1); frac text := split_part(t,'.',2);
  digits integer; exponent integer;
begin
  if p=0 then return 1; end if;
  if abs(p)<1e21 and abs(p)>=1e-6 then return octet_length(trim_scale(p)::text); end if;
  digits := length(trim(both '0' from whole||frac));
  exponent := case when whole<>'0' then length(whole)-1 else -(length(frac)-length(ltrim(frac,'0'))+1) end;
  return (p<0)::integer+digits+(digits>1)::integer+2+length(abs(exponent)::text);
end;
$$;

-- UTF-8 bytes of the value as compact JSON, the form the backup's metadata limit measures. jsonb's own text adds
-- a space after every ':' and ',' and writes numbers in full, so it is longer.
create function private.backup_compact_bytes(p_value jsonb) returns bigint
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; total bigint := 0; n integer := 0;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      for k,v in select key,value from jsonb_each(p_value) loop
        total := total+octet_length(to_jsonb(k)::text)+1+private.backup_compact_bytes(v); n := n+1;
      end loop;
      return total+2+greatest(n-1,0);
    when 'array' then
      for v in select value from jsonb_array_elements(p_value) loop
        total := total+private.backup_compact_bytes(v); n := n+1;
      end loop;
      return total+2+greatest(n-1,0);
    when 'number' then
      return private.backup_number_bytes((p_value#>>'{}')::numeric);
    else
      return octet_length(p_value::text);
  end case;
end;
$$;

-- Restores one item's tag history from a backup. Outcomes are values: created, equal (the same import again),
-- kept (differs, other-import or recorded: existing history is never changed) and busy (lock contention; retry).
create function public.restore_item_attribution(p_item_id uuid,p_import_id uuid,p_entries jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  u uuid := auth.uid(); n integer; e jsonb; stored jsonb; imports uuid[];
  keys constant text[] := array['position','source_image_id','image_sha256','model_id','prompt_version','fields'];
begin
  if u is null then raise exception using errcode='42501',message='Not available'; end if;
  -- The writer order of checked item and image changes: admission (share), profile, then the item row.
  -- image_change_lock reports its own contention as 22023 'Request conflict'; here that is only contention.
  begin
    perform private.image_change_lock(u);
    perform 1 from public.profiles where owner_id=u for update nowait;
    if not found then raise exception using errcode='42501',message='Not available'; end if;
    perform 1 from public.items where owner_id=u and id=p_item_id for update nowait;
  exception
    when lock_not_available then return jsonb_build_object('state','busy','reason',null);
    when sqlstate '22023' then return jsonb_build_object('state','busy','reason',null);
  end;
  if not private.is_approved()
    or not exists(select 1 from public.items where owner_id=u and id=p_item_id and deleted_at is null)
    or private.image_change_fenced(u,p_item_id)
    or exists(select 1 from private.item_deletion_claims c where c.owner_id=u and c.item_id=p_item_id) then
    raise exception using errcode='42501',message='Not available';
  end if;
  if p_import_id is null or p_entries is null or jsonb_typeof(p_entries)<>'array'
    or jsonb_array_length(p_entries) not between 1 and 1000
    or not private.backup_bounded(p_entries,1)
    or private.backup_compact_bytes(p_entries)>8388608 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  n := jsonb_array_length(p_entries);
  for i in 0..n-1 loop
    e := p_entries->i;
    if jsonb_typeof(e)<>'object' or not (e ?& keys) or e-keys<>'{}'::jsonb
      or jsonb_typeof(e->'position') is distinct from 'number' or e->>'position'<>i::text
      or jsonb_typeof(e->'image_sha256') is distinct from 'string' or e->>'image_sha256' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(e->'model_id') is distinct from 'string'
      or jsonb_typeof(e->'prompt_version') is distinct from 'number'
      or e->>'prompt_version' !~ '^(0|[1-9][0-9]{0,9})$'
      or jsonb_typeof(e->'fields') is distinct from 'object'
      or jsonb_typeof(e->'source_image_id') not in ('null','string') then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if (e->>'prompt_version')::bigint>2147483647 then raise exception using errcode='22023',message='Invalid input'; end if;
    if jsonb_typeof(e->'source_image_id')='string' then
      if e->>'source_image_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists(select 1 from public.item_images m where m.owner_id=u and m.item_id=p_item_id
          and m.id=(e->>'source_image_id')::uuid and m.state in ('ready','retired')) then
        raise exception using errcode='22023',message='Invalid input';
      end if;
    end if;
  end loop;
  -- Decided and written under the locks above, so a concurrent import or completion cannot interleave.
  -- Server-recorded history comes first: an item with any is kept as it is, whatever was imported before.
  if exists(select 1 from private.item_attribution_history a where a.owner_id=u and a.item_id=p_item_id)
    or exists(select 1 from private.image_change_history a where a.owner_id=u and a.item_id=p_item_id) then
    return jsonb_build_object('state','kept','reason','recorded');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('position',h.position,'source_image_id',h.source_image_id,
      'image_sha256',h.image_sha256,'model_id',h.model_id,'prompt_version',h.prompt_version,'fields',h.fields)
      order by h.position),'[]'::jsonb),
    coalesce(array_agg(distinct h.import_id),'{}'::uuid[])
    into stored,imports
    from private.imported_attribution_history h where h.owner_id=u and h.item_id=p_item_id;
  if jsonb_array_length(stored)>0 then
    if imports<>array[p_import_id] then return jsonb_build_object('state','kept','reason','other-import'); end if;
    if stored=p_entries then return jsonb_build_object('state','equal','reason',null); end if;
    return jsonb_build_object('state','kept','reason','differs');
  end if;
  insert into private.imported_attribution_history(owner_id,item_id,position,source_image_id,image_sha256,model_id,
    prompt_version,fields,import_id)
    select u,p_item_id,(x->>'position')::smallint,(x->>'source_image_id')::uuid,x->>'image_sha256',x->>'model_id',
      (x->>'prompt_version')::integer,x->'fields',p_import_id
    from jsonb_array_elements(p_entries) x;
  return jsonb_build_object('state','created','reason',null);
exception
  when invalid_text_representation or datatype_mismatch or numeric_value_out_of_range or untranslatable_character
    or character_not_in_repertoire then raise exception using errcode='22023',message='Invalid input';
end;
$$;

-- Origin-aware history: imported rows by position, then server-recorded rows in the legacy order.
-- The origin comes from the table a row is stored in, never from a caller.
create function public.item_attribution_history_v2(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_approved() or not exists(
    select 1 from public.items where owner_id=auth.uid() and id=p_item_id and deleted_at is null) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return coalesce((select jsonb_agg(h.value order by h.origin_rank,h.version,h.rank,h.request_id nulls first) from (
    select 0 origin_rank,a.position::bigint version,0 rank,null::uuid request_id,
      jsonb_build_object('origin','imported','source_image_id',a.source_image_id,'image_sha256',a.image_sha256,
        'model_id',a.model_id,'prompt_version',a.prompt_version,'fields',a.fields) value
      from private.imported_attribution_history a where a.owner_id=auth.uid() and a.item_id=p_item_id
    union all
    select 1,1::bigint,0,null::uuid,
      jsonb_build_object('origin','recorded','source_image_id',a.source_image_id,'image_sha256',a.image_sha256,
        'model_id',a.model_id,'prompt_version',a.prompt_version,'fields',a.fields)
      from private.item_attribution_history a where a.owner_id=auth.uid() and a.item_id=p_item_id
    union all
    select 1,a.committed_version,1,a.request_id,
      jsonb_build_object('origin','recorded','source_image_id',a.source_image_id,'image_sha256',a.image_sha256,
        'model_id',a.model_id,'prompt_version',a.prompt_version,'fields',a.fields)
      from private.image_change_history a where a.owner_id=auth.uid() and a.item_id=p_item_id
  ) h),'[]'::jsonb);
end;
$$;

-- One value for all of the caller's tag history, so an export can refuse a snapshot that changed while it read.
create function public.attribution_digest() returns text
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null or not private.is_approved() then raise exception using errcode='42501',message='Not available'; end if;
  return encode(sha256(convert_to(coalesce((select string_agg(r.value,E'\n' order by r.value) from (
    select 'recorded:'||to_jsonb(a)::text value from private.item_attribution_history a where a.owner_id=u
    union all
    select 'replacement:'||to_jsonb(a)::text from private.image_change_history a where a.owner_id=u
    union all
    select 'imported:'||to_jsonb(a)::text from private.imported_attribution_history a where a.owner_id=u
  ) r),''),'UTF8')),'hex');
end;
$$;

-- Every owner-keyed table. A unit test compares this list with the migrations.
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
    or exists(select 1 from private.imported_attribution_history where owner_id=p_owner));
$$;

revoke all on function private.backup_bounded(jsonb,integer),private.backup_number_bytes(numeric),
  private.backup_compact_bytes(jsonb),private.deletion_owner_rows_absent(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.restore_item_attribution(uuid,uuid,jsonb),public.item_attribution_history_v2(uuid),
  public.attribution_digest() from public,anon,authenticated,service_role;
grant execute on function public.restore_item_attribution(uuid,uuid,jsonb),public.item_attribution_history_v2(uuid),
  public.attribution_digest() to authenticated;

commit;
