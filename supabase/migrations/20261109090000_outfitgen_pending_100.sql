-- OUTFITGEN-PENDING100: the waiting list of "Suggested outfits" holds up to 100 pending suggestions instead of 40 (owner decision of
-- 8 November 2026; 40 was a number chosen at OUTFITGEN1, not a technical limit). Four functions are replaced, each by its latest body
-- and nothing else but the cap literal: outfitgen_claim (20261108100000), outfitgen_undo_remove (20261107090000), and outfitgen_plan and
-- private.outfitgen_record (20261106090000, never replaced). The claim refuses at 100, a settled request may record up to the room that
-- is left under 100, Undo is refused at 100 and the plan reports the room under 100. Grants, owners, security and every other function are
-- unchanged (create or replace keeps them); the manifest, its settings, the prompt and the call limits are untouched.
begin;

create or replace function public.outfitgen_plan(p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_code text; v_items jsonb; v_pairs jsonb; v_disliked jsonb; v_known jsonb;
begin
  select * into p from public.profiles where owner_id=p_owner_id;
  if not found then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p_owner_id;
  v_code := private.outfitgen_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  -- A judgement is dropped, and may be made again, when what was judged changed or when a newer prompt version exists (the cache is
  -- versioned and bounded); an owner's removal is never dropped.
  delete from public.suggested_outfits s where s.owner_id=p_owner_id and s.state in ('suggested','declined')
    and ((exists(select 1 from public.items i where i.owner_id=s.owner_id and i.id=any(s.item_ids) and i.updated_at>s.created_at)
      or exists(select 1 from public.item_images im where im.owner_id=s.owner_id and im.item_id=any(s.item_ids)
        and im.state='ready' and im.created_at>s.created_at))
      and s.fingerprint is distinct from private.outfitgen_fingerprint(s.owner_id,s.item_ids)
      or s.state='declined' and s.prompt_version<(select m.prompt_version from private.ai_execution_manifests m where m.id=c.outfitgen_manifest_id));
  -- Anchors are chosen apart from the partner pool: up to 100 unassessed garments added since consent (what automatic runs may
  -- assess), up to 100 other unassessed ones (manual runs), oldest first, so a pre-consent backlog never hides a new garment and
  -- coverage stays eventual. The rest of the 500 is a partner pool taken from every other eligible garment (unassessed ones
  -- included), rotating daily rather than a fixed prefix.
  select coalesce(jsonb_agg(x.j order by x.id),'[]'::jsonb) into v_items from (
    select i.id,jsonb_build_object('id',i.id,'category',i.category,'colours',to_jsonb(i.colours),'pattern',i.pattern,
      'sleeve_length',i.sleeve_length,'garment_length',i.garment_length,'seasons',to_jsonb(i.seasons),'formality',i.formality,
      'warmth',case when i.field_provenance->'warmth'->>'kind'='user' then i.warmth end,
      'upper_coverage',i.upper_coverage,
      'lower_coverage',case when i.field_provenance->'lower_coverage'->>'kind' in ('user','ai_observed') then i.lower_coverage end,
      'favourite',i.favourite,
      'unassessed',not exists(select 1 from private.outfit_assessed_items a where a.owner_id=i.owner_id and a.item_id=i.id),
      'auto',c.outfitgen_consented_at is not null and i.created_at>=c.outfitgen_consented_at
        and not exists(select 1 from private.outfit_assessed_items a where a.owner_id=i.owner_id and a.item_id=i.id),
      'coverage',(select count(*) from public.outfit_items oi where oi.owner_id=i.owner_id and oi.item_id=i.id)
        +(select count(*) from public.suggested_outfits s where s.owner_id=i.owner_id and i.id=any(s.item_ids)),
      'image',jsonb_build_object('path',im.main_path,'sha256',im.main_sha256,'bytes',im.main_bytes)) j
    from public.items i
      join public.item_images im on im.owner_id=i.owner_id and im.item_id=i.id and im.state='ready' and im.retired_at is null
    where i.owner_id=p_owner_id and i.id in (
      with pool as (
        select ei.id,ei.created_at,case when exists(select 1 from private.outfit_assessed_items a where a.owner_id=ei.owner_id and a.item_id=ei.id) then 2
          when c.outfitgen_consented_at is not null and ei.created_at>=c.outfitgen_consented_at then 0 else 1 end grp
        from public.items ei where ei.owner_id=p_owner_id and private.outfitgen_eligible(ei.owner_id,ei.id)),
      ranked as (
        select pool.id,pool.grp,row_number() over (partition by pool.grp
          order by case when pool.grp<2 then pool.created_at end,md5(pool.id::text||current_date::text),pool.id) rn from pool),
      anchors as (select r.id from ranked r where r.grp<2 and r.rn<=100)
      select a.id from anchors a
      union
      (select r.id from ranked r where r.id not in (select id from anchors)
        order by md5(r.id::text||current_date::text),r.id limit 500-(select count(*) from anchors))
    )) x;
  select coalesce(jsonb_agg(jsonb_build_array(r.item_low,r.item_high)),'[]'::jsonb) into v_pairs
    from public.combination_rules r where r.owner_id=p_owner_id;
  select coalesce(jsonb_agg(to_jsonb(f.item_ids)),'[]'::jsonb) into v_disliked from (
    select item_ids from public.suggestion_feedback where owner_id=p_owner_id and vote=-1 order by id limit 2000) f;
  select coalesce(jsonb_agg(k.s),'[]'::jsonb) into v_known from (
    select signature s from public.suggested_outfits where owner_id=p_owner_id
    union select signature from public.suggestion_feedback where owner_id=p_owner_id and vote=-1
    union select encode(sha256(convert_to(string_agg(oi.item_id::text,'|' order by oi.item_id),'UTF8')),'hex')
      from public.outfit_items oi where oi.owner_id=p_owner_id group by oi.outfit_id
    limit 20000) k;
  return jsonb_build_object('code','OK','items',v_items,'pairs',v_pairs,'disliked',v_disliked,'known',v_known,
    'pendingRoom',greatest(0,100-(select count(*) from public.suggested_outfits where owner_id=p_owner_id and state='suggested')));
end;
$$;

create or replace function public.outfitgen_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text,p_auto boolean,p_signatures text[],
  p_targets uuid[]) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  v_period text; v_hour integer; v_day integer; v_ten integer; s text;
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
  v_code := private.outfitgen_permission(p,c);
  if v_code<>'OK' then return jsonb_build_object('code',v_code,'claimed',false); end if;
  if p_request_id is null or p_request_id::text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_manifest_id is null or p_auto is null or p_signatures is null or cardinality(p_signatures) not between 1 and 24
    or (select count(distinct x) from unnest(p_signatures) x)<>cardinality(p_signatures)
    or exists(select 1 from unnest(p_signatures) x where x is null or x!~'^[0-9a-f]{64}$')
    or p_targets is null or cardinality(p_targets)>500 or array_position(p_targets,null) is not null then
    return jsonb_build_object('code','INVALID_INPUT','claimed',false);
  end if;
  select * into m from private.ai_execution_manifests where id=p_manifest_id;
  if not found or m.id<>'azure-eu-terra-outfitgen-v1' then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  if c.outfitgen_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.outfitgen_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.outfitgen_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen' and charge_state='held'
    and dispatched_at>v_now-interval '6 minutes') then return jsonb_build_object('code','BUSY','claimed',false); end if;
  select count(*) filter (where u.created_at>v_now-interval '1 hour'),count(*) filter (where u.created_at>v_now-interval '1 day'),
    count(*) filter (where u.created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten
    from private.ai_usage u left join private.outfitgen_requests r on r.owner_id=u.owner_id and r.request_id=u.request_id
    where u.owner_id=p.owner_id and u.purpose='outfitgen' and u.created_at>v_now-interval '1 day'
      and coalesce(r.mode,'manual')=case when p_auto then 'auto' else 'manual' end;
  if (p_auto and (v_hour>=6 or v_day>=40 or v_ten>=4)) or (not p_auto and (v_hour>=120 or v_day>=200 or v_ten>=40))
    then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;
  if p_auto then
    if exists(select 1 from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen'
      and closed_reason in ('FAILED','EXPIRED','UNAVAILABLE') and closed_at>v_now-interval '15 minutes')
      or (select count(*) from private.outfitgen_requests where owner_id=p.owner_id and mode='auto'
        and created_at>v_now-interval '6 hours')>=3 then return jsonb_build_object('code','COOLDOWN','claimed',false); end if;
  end if;
  if (select count(*) from public.suggested_outfits where owner_id=p.owner_id and state='suggested')>=100 then
    return jsonb_build_object('code','PENDING_FULL','claimed',false);
  end if;
  if private.ai_budget_used(p.owner_id,v_now)+c.outfitgen_max_request_micro>c.monthly_allowance_micro then
    return jsonb_build_object('code','ALLOWANCE','claimed',false);
  end if;
  foreach s in array p_signatures loop
    if private.outfitgen_known(p.owner_id,s) then return jsonb_build_object('code','CONFLICT','claimed',false); end if;
  end loop;
  v_period := to_char(v_now at time zone 'UTC','YYYY-MM');
  insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,purpose)
    values(p.owner_id,p_request_id,v_period,v_now,c.outfitgen_max_request_micro,c.outfitgen_max_request_micro,'held',v_now,'outfitgen');
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation)
    values(p.owner_id,p_request_id,m.id,'not_observed');
  insert into private.outfitgen_requests(owner_id,request_id,mode,signatures,target_items)
    values(p.owner_id,p_request_id,case when p_auto then 'auto' else 'manual' end,p_signatures,p_targets);
  return jsonb_build_object('code','OK','claimed',true,'manifestId',m.id,
    'dispatchBeforeMs',floor(extract(epoch from v_now+interval '60 seconds')*1000)::bigint);
end;
$$;

create or replace function private.outfitgen_record(p_owner uuid,p_request uuid,p_results jsonb,p_assessed uuid[],m private.ai_execution_manifests)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare q private.outfitgen_requests; r record; v_room integer; v_ids uuid[]; v_sig text; v_seen text[] := '{}';
  v_s integer := 0; v_d integer := 0; v_a integer := 0;
begin
  select * into q from private.outfitgen_requests where owner_id=p_owner and request_id=p_request;
  if not found or p_results is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>24 then
    return jsonb_build_object('suggested',0,'declined',0,'assessed',0);
  end if;
  select 100-count(*) into v_room from public.suggested_outfits where owner_id=p_owner and state='suggested';
  for r in select t.e,t.ord from jsonb_array_elements(p_results) with ordinality t(e,ord)
    order by case when jsonb_typeof(t.e)='object' and (t.e->>'score') ~ '^[0-9]{1,2}$' then (t.e->>'score')::integer else 0 end desc,t.ord
  loop
    begin
      if jsonb_typeof(r.e)<>'object' or r.e->>'decision' not in ('suggested','declined') then continue; end if;
      v_ids := array(select x::uuid from jsonb_array_elements_text(r.e->'items') x);
      v_sig := private.outfitgen_signature(v_ids);
      if not v_sig=any(q.signatures) or v_sig=any(v_seen) then continue; end if;
      v_seen := v_seen||v_sig;
      if private.outfitgen_known(p_owner,v_sig) or not private.outfitgen_valid_set(p_owner,v_ids) then continue; end if;
      if r.e->>'decision'='suggested' then
        if v_room<=0 then continue; end if;
        insert into public.suggested_outfits(owner_id,item_ids,state,title,reason,occasion,score,fingerprint,manifest_id,prompt_version,request_id)
          values(p_owner,v_ids,'suggested',r.e->>'title',r.e->>'reason',r.e->>'occasion',(r.e->>'score')::smallint,
            private.outfitgen_fingerprint(p_owner,v_ids),m.id,m.prompt_version,p_request);
        v_room := v_room-1; v_s := v_s+1;
      else
        insert into public.suggested_outfits(owner_id,item_ids,state,score,fingerprint,manifest_id,prompt_version,request_id)
          values(p_owner,v_ids,'declined',(r.e->>'score')::smallint,private.outfitgen_fingerprint(p_owner,v_ids),m.id,m.prompt_version,p_request);
        v_d := v_d+1;
      end if;
    exception when others then null;
    end;
  end loop;
  delete from public.suggested_outfits where owner_id=p_owner and state='declined' and id in (
    select id from public.suggested_outfits where owner_id=p_owner and state='declined' order by created_at desc,id offset 5000);
  if p_assessed is not null and cardinality(p_assessed)<=500 then
    insert into private.outfit_assessed_items(owner_id,item_id,request_id)
      select p_owner,i.id,p_request from public.items i where i.owner_id=p_owner and i.deleted_at is null
        and i.id=any(p_assessed) and i.id=any(q.target_items)
      on conflict do nothing;
    get diagnostics v_a = row_count;
  end if;
  return jsonb_build_object('suggested',v_s,'declined',v_d,'assessed',v_a);
end;
$$;

create or replace function public.outfitgen_undo_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_owner uuid := auth.uid(); s public.suggested_outfits; f public.suggestion_feedback; v_signature text; v_found boolean;
begin
  if v_owner is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select signature into v_signature from public.suggested_outfits where id=p_id and owner_id=v_owner;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  select * into f from public.suggestion_feedback where owner_id=v_owner and signature=v_signature for update;
  v_found := found;
  select * into s from public.suggested_outfits where id=p_id and owner_id=v_owner for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if s.state='suggested' then return jsonb_build_object('code','OK','replayed',true); end if;
  if s.state<>'removed' then return jsonb_build_object('code','CONFLICT'); end if;
  -- The ticket (vote_before) is cleared by outfitgen_vote_changed whenever anyone writes this set's vote after the Remove,
  -- so a surviving ticket proves the dislike is still the one this Remove wrote.
  if s.vote_before is null or not v_found or f.vote<>-1 then return jsonb_build_object('code','CONFLICT'); end if;
  if (select count(*) from public.suggested_outfits where owner_id=v_owner and state='suggested')>=100 then
    return jsonb_build_object('code','PENDING_FULL');
  end if;
  if s.vote_before='none' then delete from public.suggestion_feedback where id=f.id;
  elsif s.vote_before='like' then update public.suggestion_feedback set vote=1 where id=f.id; end if;
  update public.suggested_outfits set state='suggested',decided_at=null,vote_before=null,vote_set_at=null where id=s.id;
  return jsonb_build_object('code','OK');
exception when lock_not_available or deadlock_detected then
  return jsonb_build_object('code','BUSY');
end;
$$;

commit;
