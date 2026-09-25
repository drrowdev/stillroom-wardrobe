-- Phase 6 I20/I21 restore (P6b). Additive only: three new owner-scoped functions; no existing object changes.
-- reserve_restored_item_save lets a restore keep the exported provenance kinds of a saved item through the same
-- checked Save chain (private.reserve_item_save -> upload -> finalize_item_save). There is no receipt, manifest,
-- consent or inference: an owner can only re-assert kinds on their own values. Revisions start again at 1.
-- restore_image_change_status adds the reserved intent facts to the image_change_status receipt, so an interrupted
-- restored photo replacement can be resumed with its original intent.
begin;

create function public.reserve_restored_item_save(p_item jsonb,p_image jsonb)
returns table(item jsonb,image jsonb,fingerprint text,state text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  estimated constant text[] := array['material','seasons','formality','style_tags'];
  observed constant text[] := array['category','subcategory','colours','pattern','sleeve_length','garment_length',
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

create function public.restore_image_change_status(p_item_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a private.image_change_attempts; im public.item_images;
begin
  perform private.image_change_lock(auth.uid());
  select * into a from private.image_change_attempts where owner_id=auth.uid() and item_id=p_item_id and request_id=p_request_id;
  if not found then return null; end if;
  select * into im from public.item_images where owner_id=auth.uid() and item_id=a.item_id and id=a.image_id;
  if not found then
    return private.image_change_receipt(a)||jsonb_build_object('expectedVersion',a.expected_version,
      'currentImageId',a.current_image_id,'descriptionVersion',a.description_version,'image',null);
  end if;
  return private.image_change_receipt(a)||jsonb_build_object('expectedVersion',a.expected_version,
    'currentImageId',a.current_image_id,'descriptionVersion',a.description_version,'image',jsonb_build_object(
      'state',im.state,'main_path',im.main_path,'thumb_path',im.thumb_path,'main_bytes',im.main_bytes,'thumb_bytes',im.thumb_bytes,
      'main_sha256',im.main_sha256,'thumb_sha256',im.thumb_sha256,'width',im.width,'height',im.height,
      'alt_text',im.alt_text,'description_version',im.description_version));
end;
$$;

-- restore_item_save_status is the checked-save evidence for a restored item's first photo: the owner's own save attempt,
-- its image and whether it was finalized. Another owner's or an unknown item reads as null.
create function public.restore_item_save_status(p_item_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a private.item_save_attempts;
begin
  perform private.image_change_lock(auth.uid());
  select * into a from private.item_save_attempts where owner_id=auth.uid() and item_id=p_item_id;
  if not found then return null; end if;
  return jsonb_build_object('itemId',a.item_id,'imageId',a.image_id,'state',a.state);
end;
$$;

revoke all on function public.reserve_restored_item_save(jsonb,jsonb),public.restore_image_change_status(uuid,uuid),
  public.restore_item_save_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reserve_restored_item_save(jsonb,jsonb),public.restore_image_change_status(uuid,uuid),
  public.restore_item_save_status(uuid) to authenticated;

commit;
