-- Conflict-response normalization for client-chosen create IDs (I17 follow-up).
-- A create whose ID is already held by another account now gets the same answer as the caller's own conflicting
-- create: 400 P0001 "Request conflict". Only the primary-key violation of the parent insert is translated; every
-- other error (check, foreign-key, other unique constraints, child inserts) is re-raised unchanged. Exact own
-- replays still return the stored version. A known taken ID is still refused, unlike a fresh one; that residual
-- needs a candidate UUID and stays in the accepted-risk inventory.
-- Signatures, owner, grants and security invoker are unchanged, so generated types do not change.

create or replace function public.save_outfit(p_id uuid,p_title text,p_occasion text,p_notes text,
  p_favourite boolean,p_item_ids uuid[],p_expected_version bigint default null) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare o public.outfits; existing_ids uuid[]; v bigint; v_schema text; v_table text; v_constraint text;
begin
  if not private.is_approved() or coalesce(cardinality(p_item_ids),0) not between 1 and 12
     or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids)
     or (select count(*) from public.items where id=any(p_item_ids) and owner_id=auth.uid())<>cardinality(p_item_ids) then
    raise exception 'Invalid selection';
  end if;
  select * into o from public.outfits where id=p_id for update;
  if found and p_expected_version is null then
    select array_agg(item_id order by position) into existing_ids from public.outfit_items where outfit_id=p_id;
    if o.title=p_title and o.occasion=p_occasion and o.notes=p_notes and o.favourite=p_favourite
       and existing_ids=p_item_ids and o.deleted_at is null then return o.version; end if;
    raise exception 'Request conflict';
  elsif found then
    if o.version<>p_expected_version or o.deleted_at is not null then raise exception 'Request conflict'; end if;
    update public.outfits set title=p_title,occasion=p_occasion,notes=p_notes,favourite=p_favourite
      where id=p_id returning version into v;
  else
    if p_expected_version is not null then raise exception 'Request conflict'; end if;
    begin
      insert into public.outfits(id,title,occasion,notes,favourite)
        values(p_id,p_title,p_occasion,p_notes,p_favourite) returning version into v;
    exception when unique_violation then
      get stacked diagnostics v_schema = schema_name, v_table = table_name, v_constraint = constraint_name;
      if v_schema is distinct from 'public' or v_table is distinct from 'outfits' or v_constraint is distinct from 'outfits_pkey' then raise; end if;
      raise exception 'Request conflict';
    end;
  end if;
  delete from public.outfit_items where outfit_id=p_id;
  insert into public.outfit_items(owner_id,outfit_id,item_id,position)
    select auth.uid(),p_id,x.id,(x.ord-1)::smallint from unnest(p_item_ids) with ordinality x(id,ord);
  return v;
end;
$$;

create or replace function public.save_wear_event(p_id uuid,p_local_date date,p_timezone text,p_state text,
  p_label text,p_outfit_id uuid,p_item_ids uuid[],p_expected_version bigint default null) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare e public.wear_events; existing_ids uuid[]; sorted_ids uuid[]; v bigint; v_schema text; v_table text; v_constraint text;
begin
  if not private.is_approved() or coalesce(cardinality(p_item_ids),0) not between 1 and 12
    or (select count(distinct x) from unnest(p_item_ids) x)<>cardinality(p_item_ids)
    or (select count(*) from public.items where id=any(p_item_ids) and owner_id=auth.uid()
         and deleted_at is null)<>cardinality(p_item_ids) then raise exception 'Invalid selection'; end if;
  select array_agg(x order by x) into sorted_ids from unnest(p_item_ids) x;
  select * into e from public.wear_events where id=p_id for update;
  if found and p_expected_version is null then
    select array_agg(item_id order by item_id) into existing_ids from public.wear_event_items where event_id=p_id and item_id is not null;
    if e.local_date=p_local_date and e.timezone=p_timezone and e.state=p_state and e.label=p_label
       and e.outfit_id is not distinct from p_outfit_id and existing_ids=sorted_ids and e.deleted_at is null
       then return e.version; end if;
    raise exception 'Request conflict';
  elsif found then
    if e.version<>p_expected_version or e.deleted_at is not null then raise exception 'Request conflict'; end if;
    update public.wear_events set local_date=p_local_date,timezone=p_timezone,state=p_state,label=p_label,outfit_id=p_outfit_id
      where id=p_id returning version into v;
  else
    if p_expected_version is not null then raise exception 'Request conflict'; end if;
    begin
      insert into public.wear_events(id,local_date,timezone,state,label,outfit_id)
        values(p_id,p_local_date,p_timezone,p_state,p_label,p_outfit_id) returning version into v;
    exception when unique_violation then
      get stacked diagnostics v_schema = schema_name, v_table = table_name, v_constraint = constraint_name;
      if v_schema is distinct from 'public' or v_table is distinct from 'wear_events' or v_constraint is distinct from 'wear_events_pkey' then raise; end if;
      raise exception 'Request conflict';
    end;
  end if;
  delete from public.wear_event_items where event_id=p_id and item_id is not null and not(item_id=any(p_item_ids));
  insert into public.wear_event_items(owner_id,event_id,item_id)
    select auth.uid(),p_id,x from unnest(p_item_ids) x on conflict(event_id,item_id) do nothing;
  return v;
end;
$$;
