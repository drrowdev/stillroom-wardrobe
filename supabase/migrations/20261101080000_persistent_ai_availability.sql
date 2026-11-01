-- AVAIL1 persistent AI availability: no calendar review date ends photo analysis (Azure), Stylist, photo clean-up or try-on.
-- Owner decision: "Make it persistent like all other AI services. Nothing should expire."
-- Each body below is the exact current active definition with only the review-date predicate removed. Consent and notice
-- revisions, activation, manifest/model/prompt checks, the one monthly allowance, reservations, rate limits and every
-- operational expiry (request and result TTL, settlement, probe authorisation, retention) are unchanged. The review_expires_at
-- column and its values stay as immutable audit metadata. The retired Google manifest keeps its date in ai_analysis_permitted
-- (read-and-finish only). Signatures, security definer, empty search_path, volatility and lock_timeout are restated as before;
-- create or replace keeps each function's owner and ACL.
begin;

create or replace function public.ai_claim_analysis(p_owner_id uuid,p_request_id uuid,p_draft_id uuid,p_generation integer,
  p_image_sha256 text,p_byte_count integer,p_width integer,p_height integer,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests;
  u private.ai_usage; r private.ai_requests; a private.ai_analysis_attestations;
  v_now timestamptz; v_code text; v_result jsonb; v_deadline timestamptz;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_now := clock_timestamp();
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_draft_id is null
    or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_draft_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_generation is null or p_generation<1 or p_image_sha256 is null or p_image_sha256!~'^[0-9a-f]{64}$'
    or p_byte_count is null or p_byte_count not between 1 and 512000
    or p_width is null or p_width not between 1 and 1600 or p_height is null or p_height not between 1 and 1600 then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id and id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2');
  if not found or c.execution_manifest_id is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.execution_manifest_id<>m.id or c.model_id<>m.model_id or c.prompt_version<>m.prompt_version or c.notice_revision<>2 then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if c.max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  if found then
    select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
    if not found then return jsonb_build_object('code','TERMINAL','claimed',false); end if;
    if r.expires_at<=v_now then
      perform private.ai_close(p.owner_id,p_request_id,'EXPIRED',v_now);
      return jsonb_build_object('code','TERMINAL','claimed',false);
    end if;
    select * into a from private.ai_analysis_attestations where owner_id=p.owner_id and request_id=p_request_id;
    if not found or a.manifest_id<>m.id or a.image_sha256<>p_image_sha256 or a.byte_count<>p_byte_count
      or a.width<>p_width or a.height<>p_height or r.draft_id<>p_draft_id or r.generation<>p_generation
      or r.model_id<>c.model_id or r.prompt_version<>c.prompt_version or r.notice_revision<>c.notice_revision then
      return jsonb_build_object('code','CONFLICT','claimed',false);
    end if;
    return jsonb_build_object('code','ALREADY_CLAIMED','claimed',false);
  end if;
  v_result := private.ai_begin_owner(p.owner_id,p_request_id,p_draft_id,p_generation,p_image_sha256);
  if v_result->>'code'<>'OK' then return jsonb_build_object('code',v_result->>'code','claimed',false); end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id;
  v_now := clock_timestamp();
  v_deadline := least(v_now+interval '20 seconds',r.expires_at);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,claim_identity)
    values(p.owner_id,p_request_id,m.id,'not_observed',jsonb_build_object('draftId',p_draft_id,'generation',p_generation,
      'imageSha256',p_image_sha256,'bytes',p_byte_count,'width',p_width,'height',p_height));
  insert into private.ai_analysis_attestations values(p.owner_id,p_request_id,p_image_sha256,
    p_byte_count,p_width,p_height,m.id,v_now,v_deadline);
  update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'resultExpiresAtMs',floor(extract(epoch from r.expires_at)*1000)::bigint,
    'dispatchBeforeMs',floor(extract(epoch from v_deadline)*1000)::bigint);
end;
$$;

create or replace function private.ai_analysis_permitted(p public.profiles,c private.ai_controls,r private.ai_requests,p_now timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select private.ai_permission(p,c)='OK' and r.model_id=c.model_id and r.prompt_version=c.prompt_version
    and r.notice_revision=c.notice_revision and exists(
      select 1 from private.ai_analysis_attestations a join private.ai_execution_manifests m on m.id=a.manifest_id
      where a.owner_id=p.owner_id and a.request_id=r.request_id and a.image_sha256=r.image_sha256
        and m.id=c.execution_manifest_id and m.id in ('google-eu-3.8-v1','azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2')
        and m.model_id=r.model_id and m.prompt_version=r.prompt_version
        and (m.id='google-eu-3.8-v1' and p_now<m.review_expires_at or m.id<>'google-eu-3.8-v1' and c.notice_revision=2));
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
        when k=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
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

create or replace function public.stylist_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  v_used numeric; v_period text; v_items jsonb;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  v_code := private.stylist_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null then return jsonb_build_object('code','INVALID_INPUT','claimed',false); end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id not in ('azure-eu-terra-stylist-v1','azure-eu-terra-stylist-v2') then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.stylist_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.stylist_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.stylist_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if v_used+c.stylist_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  select coalesce(jsonb_agg(x.j order by x.id),'[]'::jsonb) into v_items from (
    select i.id,jsonb_build_object('id',i.id,'category',i.category,'colours',to_jsonb(i.colours),'pattern',i.pattern,
      'sleeve_length',i.sleeve_length,'garment_length',i.garment_length,'seasons',to_jsonb(i.seasons),'formality',i.formality,
      'warmth',case when i.field_provenance->'warmth'->>'kind'='user' then i.warmth end,
      'min_temp',case when i.field_provenance->'min_temp'->>'kind'='user' then i.min_temp end,
      'max_temp',case when i.field_provenance->'max_temp'->>'kind'='user' then i.max_temp end,
      'rain_rating',case when i.field_provenance->'rain_rating'->>'kind'='user' then i.rain_rating end,
      'windproof',case when i.field_provenance->'windproof'->>'kind'='user' then i.windproof end,
      'upper_coverage',i.upper_coverage,
      'lower_coverage',case when i.field_provenance->'lower_coverage'->>'kind' in ('user','ai_observed') then i.lower_coverage end,
      'favourite',i.favourite) j
    from public.items i
    where i.owner_id=p.owner_id and i.deleted_at is null and i.lifecycle='active' and i.availability='ready'
      and not i.exclude_suggestions
      and exists(select 1 from public.item_images im where im.owner_id=i.owner_id and im.item_id=i.id
        and im.state='ready' and im.retired_at is null)
      and not exists(select 1 from private.item_deletion_claims d where d.owner_id=i.owner_id and d.item_id=i.id)
      and not private.image_change_fenced(i.owner_id,i.id)
    order by i.id limit 500) x;
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,purpose)
    values(p.owner_id,p_request_id,v_period,v_now,c.stylist_max_request_micro,c.stylist_max_request_micro,'held',v_now,'stylist');
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation)
    values(p.owner_id,p_request_id,m.id,'not_observed');
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '5 seconds')*1000)::bigint,'items',v_items);
end;
$$;

create or replace function public.enhance_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_input_sha256 text,p_probe_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.enhancement_probe_authorisations; k private.provider_capacity;
  m private.ai_execution_manifests; v_now timestamptz; v_code text; v_used numeric; v_period text; v_slot uuid;
  v_calls bigint; v_spent numeric;
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if p_probe_id is not null then
      select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id for update nowait;
    end if;
    select x.* into k from private.provider_capacity x join private.provider_deployments d on d.deployment_key=x.deployment_key
      where d.manifest_id=p_manifest_id for update of x;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  perform private.enhance_expire(p.owner_id,v_now,100);
  if p_probe_id is not null then
    select * into a from private.enhancement_probe_authorisations where id=p_probe_id and owner_id=p_owner_id;
  end if;
  v_code := case when p_probe_id is null then private.enhance_permission(p,c) else private.enhance_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null or p_input_sha256 is null or p_input_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-cleanup-v1' or k.deployment_key is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.enhance_manifest_id<>m.id or (a.id is not null and a.deployment_key<>k.deployment_key) then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  if c.enhance_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if v_used+c.enhance_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.enhance_probe_id=a.id;
    if v_calls>=a.max_calls or v_spent+c.enhance_max_request_micro>a.allocation_micro then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','BUSY','claimed',false);
  end if;
  v_slot := gen_random_uuid();
  insert into private.provider_slots(slot_id,deployment_key,held_until)
    values(v_slot,k.deployment_key,v_now+interval '5 seconds'+make_interval(secs=>k.window_seconds));
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,
      purpose,provider_slot_id)
    values(p.owner_id,p_request_id,v_period,v_now,c.enhance_max_request_micro,c.enhance_max_request_micro,'held',v_now,
      'enhancement',v_slot);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,enhance_input_sha256,enhance_probe_id)
    values(p.owner_id,p_request_id,m.id,'not_observed',p_input_sha256,a.id);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '5 seconds')*1000)::bigint,'requestSeconds',m.request_seconds);
end;
$$;

create or replace function private.tryon_permission(p_profile public.profiles,p_controls private.ai_controls,p_now timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.tryon_manifest_id is null then 'UNCONFIGURED'
    when not p_controls.tryon_activated then 'INACTIVE'
    when p_controls.tryon_consent_revision is distinct from p_controls.tryon_notice_revision then 'CONSENT_REQUIRED'
    when not exists(select 1 from private.ai_execution_manifests m where m.id=p_controls.tryon_manifest_id) then 'UNCONFIGURED'
    else 'OK' end;
$$;

create or replace function private.tryon_probe_permission(p_profile public.profiles,p_controls private.ai_controls,
  p_auth private.tryon_probe_authorisations,p_now timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when p_profile.owner_id is null or not private.ai_owner_approved(p_profile.owner_id) then 'UNAVAILABLE'
    when p_controls.owner_id is null or p_controls.tryon_manifest_id is null or p_controls.tryon_max_request_micro is null then 'UNCONFIGURED'
    when not exists(select 1 from private.ai_execution_manifests m where m.id=p_controls.tryon_manifest_id) then 'UNCONFIGURED'
    when p_auth.id is null or p_auth.owner_id<>p_profile.owner_id or p_auth.stopped_at is not null
      or p_auth.expires_at<=p_now or p_auth.manifest_id<>p_controls.tryon_manifest_id
      or p_auth.deployment_key is distinct from (select d.deployment_key from private.provider_deployments d
        where d.manifest_id=p_controls.tryon_manifest_id) then 'INACTIVE'
    when p_controls.tryon_activated and p_controls.tryon_consent_revision is not distinct from p_controls.tryon_notice_revision
      then 'INACTIVE'
    else 'OK' end;
$$;

create or replace function public.tryon_claim(p_owner_id uuid,p_chain_id uuid,p_step integer,p_request_id uuid,p_manifest_id text,
  p_outfit_id uuid,p_person_sha256 text,p_probe_id uuid,p_item_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; a private.tryon_probe_authorisations; t private.tryon_chains;
  k private.provider_capacity; m private.ai_execution_manifests; v_now timestamptz; v_code text; v_used numeric; v_slot uuid;
  v_steps jsonb; v_step jsonb; v_n integer; v_r bigint; v_calls bigint; v_spent numeric; v_path text; v_new boolean;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  begin
    perform private.image_change_lock(p_owner_id);
    select * into p from public.profiles where owner_id=p_owner_id for update nowait;
    if not found then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    select * into c from private.ai_controls where owner_id=p_owner_id for update nowait;
    if p_probe_id is not null then
      select * into a from private.tryon_probe_authorisations where id=p_probe_id and owner_id=p_owner_id for update nowait;
    end if;
    if p_chain_id is not null then
      select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=p_chain_id for update nowait;
    end if;
    select x.* into k from private.provider_capacity x join private.provider_deployments d on d.deployment_key=x.deployment_key
      where d.manifest_id=p_manifest_id for update of x;
  exception
    when lock_not_available or sqlstate '22023' then return jsonb_build_object('code','BUSY','claimed',false);
    when insufficient_privilege then return jsonb_build_object('code','UNAVAILABLE','claimed',false);
  end;
  v_now := clock_timestamp();
  perform private.tryon_expire_owner(p.owner_id,v_now,100);
  if p_probe_id is not null then
    select * into a from private.tryon_probe_authorisations where id=p_probe_id and owner_id=p_owner_id;
  end if;
  if p_chain_id is not null then
    select * into t from private.tryon_chains where owner_id=p_owner_id and chain_id=p_chain_id;
  end if;
  v_code := case when p_probe_id is null then private.tryon_permission(p,c,v_now)
    else private.tryon_probe_permission(p,c,a,v_now) end;
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~uuid_re or p_chain_id is null or p_chain_id::text!~uuid_re
    or p_step is null or p_step not between 1 and 3 or p_manifest_id is null
    or (p_step=1 and p_person_sha256 is not null)
    or (p_step>1 and (p_person_sha256 is null or p_person_sha256 !~ '^[0-9a-f]{64}$'))
    or (t.chain_id is null and p_step<>1)
    or (p_step=1 and (p_outfit_id is null) = (p_item_ids is null))
    or (p_step=1 and t.chain_id is not null and (p_outfit_id is distinct from t.outfit_id
      or p_item_ids is distinct from t.idea_item_ids))
    or (p_step>1 and (p_item_ids is not null or p_outfit_id is not null))
    or (p_item_ids is not null and (coalesce(array_ndims(p_item_ids),0)<>1 or cardinality(p_item_ids) not between 1 and 8
      or array_position(p_item_ids,null) is not null
      or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids))) then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-global-image25-sunburst-tryon-v1' or k.deployment_key is null then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.tryon_manifest_id<>m.id or (a.id is not null and a.deployment_key<>k.deployment_key) then
    return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);
  end if;
  v_r := c.tryon_max_request_micro;
  if v_r<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if not k.dispatch_enabled then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
  v_used := private.ai_budget_used(p.owner_id,v_now);
  if a.id is not null then
    select count(*),coalesce(sum(u.accounted_micro),0) into v_calls,v_spent from private.ai_usage u
      join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id
      where u.owner_id=p.owner_id and e.tryon_probe_id=a.id;
  end if;
  v_new := t.chain_id is null;
  if v_new then
    if exists(select 1 from private.tryon_chain_stops where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','CANCELLED','claimed',false);
    end if;
    if exists(select 1 from private.tryon_results where owner_id=p.owner_id and chain_id=p_chain_id) then
      return jsonb_build_object('code','TERMINAL','claimed',false);
    end if;
    if private.tryon_purge_overdue(v_now) then return jsonb_build_object('code','UNAVAILABLE','claimed',false); end if;
    if p_item_ids is null then
      if not exists(select 1 from public.outfits where owner_id=p.owner_id and id=p_outfit_id and deleted_at is null) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_steps(p.owner_id,p_outfit_id);
    else
      if (select count(*) from public.items where owner_id=p.owner_id and id=any(p_item_ids))<>cardinality(p_item_ids) then
        return jsonb_build_object('code','NOT_FOUND','claimed',false);
      end if;
      v_steps := private.tryon_select_idea_steps(p.owner_id,p_item_ids);
    end if;
    v_n := jsonb_array_length(v_steps);
    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;
    if (select count(*) from private.tryon_results where owner_id=p.owner_id
        and (state='reserved' or expires_at>v_now))>=20 then
      return jsonb_build_object('code','RESULTS_FULL','claimed',false);
    end if;
    if v_used+v_n*v_r>c.monthly_allowance_micro then
      return jsonb_build_object('code','ALLOWANCE','claimed',false);
    end if;
    if a.id is not null and (v_calls+v_n>a.max_calls or v_spent+v_n*v_r>a.allocation_micro) then
      return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
    end if;
  else
    if t.state<>'running' then
      return jsonb_build_object('code',case t.state when 'withdrawn' then 'WITHDRAWN' when 'cancelled' then 'CANCELLED'
        when 'expired' then 'EXPIRED' when 'stale' then 'CHAIN_MISMATCH' else 'TERMINAL' end,'claimed',false);
    end if;
    if t.next_step<>p_step or (p_step>1 and p_person_sha256 is distinct from t.last_output_sha256) then
      return jsonb_build_object('code','CONFLICT','claimed',false);
    end if;
    if t.active_request_id is not null then return jsonb_build_object('code','BUSY','claimed',false); end if;
    v_steps := t.steps;
    v_n := jsonb_array_length(v_steps);
  end if;
  if p_step>v_n then return jsonb_build_object('code','CONFLICT','claimed',false); end if;
  v_step := v_steps->(p_step-1);
  if not private.tryon_garment_current(p.owner_id,(v_step->>'itemId')::uuid,(v_step->>'imageId')::uuid,
      v_step->>'mainSha256',(v_step->>'bytes')::integer) then
    if not v_new then perform private.tryon_end_chain(p.owner_id,t.chain_id,'stale','CHAIN_MISMATCH',v_now); end if;
    return jsonb_build_object('code','CHAIN_MISMATCH','claimed',false);
  end if;
  if v_used+v_r>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  if a.id is not null and (v_calls>=a.max_calls or v_spent+v_r>a.allocation_micro) then
    return jsonb_build_object('code','PROBE_LIMIT','claimed',false);
  end if;
  if (select count(*) from private.provider_slots where deployment_key=k.deployment_key and held_until>v_now)>=k.max_dispatch then
    return jsonb_build_object('code','BUSY','claimed',false);
  end if;
  select main_path into v_path from public.item_images where owner_id=p.owner_id and id=(v_step->>'imageId')::uuid;
  if v_new then
    insert into private.tryon_chains(owner_id,chain_id,outfit_id,idea_item_ids,steps,state,next_step,result_id,created_at,expires_at)
      values(p.owner_id,p_chain_id,p_outfit_id,p_item_ids,v_steps,'running',1,gen_random_uuid(),v_now,v_now+interval '30 minutes')
      returning * into t;
    insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,created_at)
      values(p.owner_id,t.result_id,t.chain_id,t.outfit_id,'reserved',
        (select array_agg((x->>'itemId')::uuid order by n) from jsonb_array_elements(v_steps) with ordinality q(x,n)),v_now);
  end if;
  insert into private.tryon_attempts(owner_id,request_id,chain_id,step,state,dispatch_before,created_at)
    values(p.owner_id,p_request_id,t.chain_id,p_step,'claimed',v_now+interval '15 seconds',v_now);
  update private.tryon_chains set active_request_id=p_request_id where owner_id=p.owner_id and chain_id=t.chain_id;
  v_slot := gen_random_uuid();
  insert into private.provider_slots(slot_id,deployment_key,held_until)
    values(v_slot,k.deployment_key,v_now+interval '20 seconds'+make_interval(secs=>k.window_seconds));
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,
      purpose,provider_slot_id,tryon_chain_id,tryon_step)
    values(p.owner_id,p_request_id,to_char(v_now at time zone 'UTC','YYYY-MM'),v_now,v_r,v_r,'held',v_now,
      'try_on',v_slot,t.chain_id,p_step);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,tryon_dispatch_before,tryon_probe_id)
    values(p.owner_id,p_request_id,m.id,'not_observed',v_now+interval '15 seconds',a.id);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,'chainId',t.chain_id,'step',p_step,'steps',v_n,
    'last',p_step=v_n,'slot',v_step->>'slot',
    'garment',jsonb_build_object('path',v_path,'mainSha256',v_step->>'mainSha256','bytes',(v_step->>'bytes')::integer),
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '15 seconds')*1000)::bigint,
    'requestSeconds',m.request_seconds,'reservationMicro',v_r::text);
end;
$$;

commit;
