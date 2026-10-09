-- RAIN1: the stylist chooses garments without the weather; the weather may influence only outerwear (issue #84 owner decisions).
-- Nothing dispatches or activates: no ai_controls row, grant, consent or owner data is touched, and the owner's controls keep
-- selecting stylist-v1 until a separate approved cutover. Classification:
--   additive: the stylist-v2 manifest row. It copies the v1 numbers (model, rates, envelope, reservation, limits, schema hash,
--     notice 1 and the same review expiry); only the prompt version, prompt hash and settings hash change;
--   NON-ADDITIVE (function replacement): public.stylist_claim. Its body is byte-identical to 20260928090000 except
--     'create function' -> 'create or replace function' and the one admitted manifest check, which now admits v1 or v2. The
--     existing equality with the owner's stylist_manifest_id still binds each claim to the manifest the controls select, so v1
--     claims keep working until the controls are changed. stylist_finish, stylist_azure_usage and expiry read the evidence
--     row's manifest and are unchanged, so held v1 requests settle as before.
begin;

insert into private.ai_execution_manifests values (
  'azure-eu-terra-stylist-v2','gpt-5.6-terra-2026-07-09',2,
  '6ecb063a57f438b93c3aa9ec72a0d0901801004d6534c33a0a5309661ce8d88d',
  '003b745ceaca59678e2f274104fe7b0d3d2c34a181e1e9102df76c232d78409a',
  'e877d4a8e70a38c1deb99fa2bb061ff5f557dbeddba748aa846e1047a0e035ec',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-21T00:00:00Z',
  'INACTIVE stylist text chat v2 (weather influences only outerwear) on existing DEV/TEST eval-terra-20260709; expected snapshot gpt-5.6-terra-2026-07-09. Applicable tariff ShortCo USD2.20 input/13.20 output per1M (retail API SwedenCentral/USD, product DZH318Z0T9WD). Reservation 129360 micro values the 24000 input/1200 output envelope at LongCo 4.40/19.80 as a conservative allowance valuation; input envelope is an operational estimate over the bounded 20000-byte messages plus schema/framing, enforced by anomaly shutdown. Enum/number/boolean item fields only; no photos or item text. Explicit cache mode without breakpoints; store:false is not zero retention. Exact-route probe and paid activation remain owner gates.',
  'USD',220,1320,24000,1200,129360,0,0,262144,8192,25,'2026-12-01T00:00:00Z'
);

create or replace function public.stylist_claim(p_owner_id uuid,p_request_id uuid,p_manifest_id text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; m private.ai_execution_manifests; v_now timestamptz; v_code text;
  s record; v_period text; v_items jsonb;
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
  if not found or m.id not in ('azure-eu-terra-stylist-v1','azure-eu-terra-stylist-v2') or m.review_expires_at<=v_now then
    return jsonb_build_object('code','UNCONFIGURED','claimed',false);
  end if;
  if c.stylist_manifest_id<>m.id then return jsonb_build_object('code','CONFIG_CHANGED','claimed',false); end if;
  if c.stylist_max_request_micro<m.reservation_micro then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
  perform private.stylist_expire(p.owner_id,v_now,100);
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    return jsonb_build_object('code','TERMINAL','claimed',false);
  end if;
  select * into s from private.stylist_usage(p.owner_id,v_now);
  if s.stylist_hour>=c.stylist_max_requests_per_hour or s.total_hour>=c.max_requests_per_hour then
    return jsonb_build_object('code','RATE_LIMIT','claimed',false);
  end if;
  if s.stylist_micro+c.stylist_max_request_micro>c.stylist_monthly_allowance_micro
    or s.total_micro+c.stylist_max_request_micro>c.monthly_allowance_micro then
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

commit;
