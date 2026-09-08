-- I29a saved facts only; no AI receipt or assertion authority.
begin;

alter table public.items
  add column pattern text check (pattern in ('solid','striped','checked','dotted','floral','graphic','abstract','animal','other')),
  add column sleeve_length text check (sleeve_length in ('sleeveless','short','elbow','three_quarter','long')),
  add column garment_length text check (garment_length in ('cropped','short','regular','long')),
  add column field_provenance jsonb not null default '{}',
  alter column formality drop not null,
  alter column formality drop default,
  alter column warmth drop not null,
  alter column warmth drop default,
  alter column rain_rating drop not null,
  alter column rain_rating drop default,
  alter column windproof drop not null,
  alter column windproof drop default,
  alter column upper_coverage drop not null,
  alter column upper_coverage drop default,
  alter column lower_coverage drop not null,
  alter column lower_coverage drop default;

create function private.item_field_provenance() returns trigger
language plpgsql set search_path = '' as $$
declare
  fields constant text[] := array[
    'title','category','subcategory','colours','pattern','sleeve_length','garment_length',
    'brand','size_label','material','seasons','formality','warmth','min_temp','max_temp',
    'rain_rating','windproof','upper_coverage','lower_coverage','style_tags','tags',
    'purchase_date','purchase_price','notes'
  ];
  field text;
  entry jsonb;
  previous jsonb;
  revision numeric;
  previous_revision integer;
  new_values jsonb := to_jsonb(new);
  old_values jsonb;
begin
  if new.field_provenance is null or jsonb_typeof(new.field_provenance)<>'object'
    or octet_length(convert_to(new.field_provenance::text,'UTF8'))>4096 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  for field,entry in select key,value from jsonb_each(new.field_provenance) loop
    if not field=any(fields) or jsonb_typeof(entry)<>'object' then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if not (entry ?& array['kind','revision']) or entry - array['kind','revision']<>'{}'::jsonb
      or jsonb_typeof(entry->'kind')<>'string' or jsonb_typeof(entry->'revision')<>'number'
      or entry->>'kind' not in ('unknown','user') then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    revision := (entry->>'revision')::numeric;
    if revision<1 or revision>2147483647 or revision<>trunc(revision) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
    if tg_op='INSERT' and (entry->>'kind'<>'user' or revision<>1) then
      raise exception using errcode='22023',message='Invalid input';
    end if;
  end loop;
  if tg_op='INSERT' then return new; end if;

  old_values := to_jsonb(old);
  foreach field in array fields loop
    entry := new.field_provenance->field;
    previous := old.field_provenance->field;
    previous_revision := coalesce((previous->'revision')::integer,0);
    -- Explicit changed intent takes precedence over value-only invalidation.
    if entry is distinct from previous then
      if entry is null or previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      if (entry->'revision')::integer<>previous_revision+1 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    elsif new_values->field is distinct from old_values->field then
      if previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
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
revoke all on function private.item_field_provenance() from public,anon,authenticated;
create trigger item_field_provenance before insert or update on public.items
for each row execute function private.item_field_provenance();

-- Raw v2 snapshot, not yet the final saved-only I29 export contract.
create or replace function public.export_manifest(p_export_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when private.is_approved() then jsonb_build_object(
    'schema_version',2,'export_id',p_export_id,'owner_id',auth.uid(),'created_at',statement_timestamp(),
    'tables',jsonb_build_object(
      'profiles',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.profiles t where owner_id=auth.uid()),
      'style_preferences',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.style_preferences t where owner_id=auth.uid()),
      'items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.items t where owner_id=auth.uid()),
      'item_images',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.item_images t where owner_id=auth.uid()),
      'outfits',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfits t where owner_id=auth.uid()),
      'outfit_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.outfit_items t where owner_id=auth.uid()),
      'wear_events',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_events t where owner_id=auth.uid()),
      'wear_event_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.wear_event_items t where owner_id=auth.uid()),
      'combination_rules',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.combination_rules t where owner_id=auth.uid()),
      'suggestion_feedback',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.suggestion_feedback t where owner_id=auth.uid())
    )) else null end;
$$;
commit;
