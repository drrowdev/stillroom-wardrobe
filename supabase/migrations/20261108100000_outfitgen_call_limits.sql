-- OUTFITGEN3-B2: the call limits of manual outfit checks are raised so one "Find new outfits" pass can check a whole wardrobe.
-- The function is its latest body (20261106090000, the only definition) with the rate-limit block replaced and nothing else:
-- calls are now counted per owner AND per mode (failed and expired claims count, they are still rows), manual 40 per 10 minutes,
-- 120 per hour and 200 per rolling day, automatic unchanged at 4, 6 and 40 (its 3-per-6-hours rule and failure cooldown are untouched).
-- The monthly allowance, the spending guard and the other purposes are unchanged. Grants are unchanged (create or replace keeps them).
begin;

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
  if (select count(*) from public.suggested_outfits where owner_id=p.owner_id and state='suggested')>=40 then
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

commit;
