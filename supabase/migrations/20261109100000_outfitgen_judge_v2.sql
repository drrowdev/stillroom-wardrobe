-- OUTFITGEN-QUALITY1: judge v2 for suggested outfits (owner feedback of 8 November 2026: every garment was matched with every other, 64 of 65
-- suggestions scored exactly the bar, the same few garments recurred, and an outfit was judged with its jacket although the jacket comes off
-- indoors). Classification:
--   additive: the immutable manifest azure-eu-terra-outfitgen-v2 (prompt version 2, schema version 2). Same model, endpoint, tariff, rates,
--     envelope, reservation (373402 micro), limits and review date as v1; only the three hashes, the prompt version and the description
--     differ. v1 stays installed and unchanged. No provider-deployment row exists for either (the claim does not use one);
--   NON-ADDITIVE (function replacement, same signatures, owners, security, search_path, lock_timeout and ACLs kept by create or replace):
--     public.outfitgen_claim, each latest body (20261109090000) with only the manifest pin changed from v1 to v1-or-v2;
--     public.outfitgen_plan, its latest body (20261109090000) plus one key, 'seen': the item sets of the newest 500 waiting and kept
--     suggestions, which the Edge function reads to keep a garment or a top+bottom base from filling the list. It is read-only.
-- Not written: private.ai_controls (the accounts stay on v1 until the owner's controls move), consent, the notice revision (the data flow is the
-- same), suggestions, assessments, usage and every other function. Inert for the running stack: the claim still admits v1, and an Edge function
-- or app of the previous version ignores the extra plan key.
-- Rollout (docs/cloud-development.md): this migration, then Pages, then, with no held request, the owner's controls move to v2 and the Edge
-- function redeploy back to back. Backout: controls back to v1 and the previous Edge function; nothing here needs a compensating statement.
begin;
set local lock_timeout = '5s';

do $$
declare f regprocedure; p pg_catalog.pg_proc;
begin
  foreach f in array array['public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[])','public.outfitgen_plan(uuid)']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=f;
    if not p.prosecdef or not exists(select 1 from unnest(p.proconfig) x where x like 'search_path=%')
      or not exists(select 1 from unnest(p.proconfig) x where x like 'lock_timeout=%') then
      raise exception 'OUTFITGEN-QUALITY1 precondition: % properties not as expected',f;
    end if;
  end loop;
  if not exists(select 1 from private.ai_execution_manifests where id='azure-eu-terra-outfitgen-v1') then
    raise exception 'OUTFITGEN-QUALITY1 precondition: the v1 manifest is missing';
  end if;
  if exists(select 1 from private.ai_execution_manifests where id='azure-eu-terra-outfitgen-v2') then
    raise exception 'OUTFITGEN-QUALITY1 precondition: the v2 manifest already exists';
  end if;
  perform set_config('outfitgen_quality1.v1_row',
    (select md5(to_jsonb(m)::text) from private.ai_execution_manifests m where id='azure-eu-terra-outfitgen-v1'),true);
  perform set_config('outfitgen_quality1.controls',(select md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.owner_id),''))
    from private.ai_controls c),true);
  -- The installed bodies with only the stated deltas: the replacements must reproduce exactly these bytes.
  perform set_config('outfitgen_quality1.claim',(select md5(replace(prosrc,'m.id<>''azure-eu-terra-outfitgen-v1''',
    'm.id not in (''azure-eu-terra-outfitgen-v1'',''azure-eu-terra-outfitgen-v2'')')) from pg_catalog.pg_proc
    where oid='public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[])'::regprocedure),true);
  perform set_config('outfitgen_quality1.plan',(select md5(prosrc) from pg_catalog.pg_proc
    where oid='public.outfitgen_plan(uuid)'::regprocedure),true);
end;
$$;

-- Manifest v2: the v1 numbers, model, endpoint and rates; the v2 prompt, schema and settings hashes.
insert into private.ai_execution_manifests values (
  'azure-eu-terra-outfitgen-v2','gpt-5.6-terra-2026-07-09',2,
  '061161adb7a4cf1f1110b901e2603d3b3f0c90a51945bb5fa688ab44c5ad2cad',
  '7ab35cad3de6e3c63ec3f57422f112a0e362de984b129513046d031bfa5866fd',
  'b7dabdd0086600613cfe1525e7c618176a7861048727312df83044b4ac2eadd6',
  'Azure OpenAI','stillroom-ai-eval.openai.azure.com','v1/chat/completions','EU','DataZoneStandard',
  'https://prices.azure.com/api/retail/prices',
  '2026-09-21T00:00:00Z',
  'Outfit judging v2 on the existing eval-terra-20260709 deployment; expected snapshot gpt-5.6-terra-2026-07-09. The judge scores the base look (top or one-piece, bottoms, shoes) and the whole outfit separately on an anchored scale; the server stores the lower score and applies the suggestion caps. Same data, tariff and envelope as v1: applicable tariff ShortCo USD2.20 input/13.20 output per1M; reservation 373402 micro values the 48000 input/8192 output envelope at LongCo 4.40/19.80 as a conservative allowance valuation; it is not an invoice ceiling and no typical per-call cost is claimed before the owner trial. Up to 8 garment photos (stored main JPEG, detail high, at most 3 MiB together) and enum/number/boolean item fields; no titles, notes or brands. Explicit cache mode without breakpoints; store:false is not zero retention.',
  'USD',220,1320,48000,8192,373402,512000,1600,262144,32768,75,'2099-01-01T00:00:00Z'
);

-- 20261109090000's claim with the manifest pin accepting v1 and v2.
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
  if not found or m.id not in ('azure-eu-terra-outfitgen-v1','azure-eu-terra-outfitgen-v2') then return jsonb_build_object('code','UNCONFIGURED','claimed',false); end if;
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

-- 20261109090000's plan plus the 'seen' key (waiting and kept item sets, newest 500). Removed sets are already in 'disliked'.
create or replace function public.outfitgen_plan(p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_code text; v_items jsonb; v_pairs jsonb; v_disliked jsonb; v_known jsonb; v_seen jsonb;
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
  select coalesce(jsonb_agg(jsonb_build_array(q.state,to_jsonb(q.item_ids)) order by q.created_at desc,q.id),'[]'::jsonb) into v_seen from (
    select state,item_ids,created_at,id from public.suggested_outfits where owner_id=p_owner_id and state in ('suggested','kept')
      order by created_at desc,id limit 500) q;
  return jsonb_build_object('code','OK','items',v_items,'pairs',v_pairs,'disliked',v_disliked,'known',v_known,'seen',v_seen,
    'pendingRoom',greatest(0,100-(select count(*) from public.suggested_outfits where owner_id=p_owner_id and state='suggested')));
end;
$$;

do $$
declare v_seen_block text := $seen$  select coalesce(jsonb_agg(jsonb_build_array(q.state,to_jsonb(q.item_ids)) order by q.created_at desc,q.id),'[]'::jsonb) into v_seen from (
    select state,item_ids,created_at,id from public.suggested_outfits where owner_id=p_owner_id and state in ('suggested','kept')
      order by created_at desc,id limit 500) q;
$seen$;
begin
  if not exists(select 1 from private.ai_execution_manifests where id='azure-eu-terra-outfitgen-v2' and prompt_version=2) then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: the v2 manifest is missing';
  end if;
  -- v2 equals v1 on everything but its identity, hashes, prompt version and description.
  if (select to_jsonb(m)-array['id','prompt_version','prompt_sha256','schema_sha256','settings_sha256','tariff_description']
      from private.ai_execution_manifests m where id='azure-eu-terra-outfitgen-v2')
    is distinct from (select to_jsonb(m)-array['id','prompt_version','prompt_sha256','schema_sha256','settings_sha256','tariff_description']
      from private.ai_execution_manifests m where id='azure-eu-terra-outfitgen-v1') then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: v2 differs from v1 beyond the stated columns';
  end if;
  if (select md5(to_jsonb(m)::text) from private.ai_execution_manifests m where id='azure-eu-terra-outfitgen-v1')
    is distinct from current_setting('outfitgen_quality1.v1_row') then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: the v1 manifest changed';
  end if;
  if (select md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.owner_id),'')) from private.ai_controls c)
    is distinct from current_setting('outfitgen_quality1.controls') then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: private.ai_controls changed';
  end if;
  if (select md5(prosrc) from pg_catalog.pg_proc where oid='public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[])'::regprocedure)
    is distinct from current_setting('outfitgen_quality1.claim') then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: the claim differs from the installed body beyond the manifest pin';
  end if;
  if (select md5(replace(replace(replace(prosrc,v_seen_block,''),' v_seen jsonb;',''),'''seen'',v_seen,','')) from pg_catalog.pg_proc
    where oid='public.outfitgen_plan(uuid)'::regprocedure) is distinct from current_setting('outfitgen_quality1.plan') then
    raise exception 'OUTFITGEN-QUALITY1 postcondition: the plan differs from the installed body beyond the seen key';
  end if;
end;
$$;

commit;
