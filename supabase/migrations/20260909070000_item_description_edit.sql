-- I29b saved description corrections only; immutable media and item facts are unchanged.
begin;

alter table public.item_images
  add column description_version bigint not null default 1
    check (description_version between 1 and 2147483647),
  drop constraint item_images_alt_text_check,
  add constraint item_images_alt_text_check check (length(alt_text) between 0 and 240);

create function public.update_image_description(
  p_image_id uuid, p_expected_description_version bigint, p_alt_text text
) returns table(id uuid, owner_id uuid, item_id uuid, alt_text text, description_version bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_approved() or auth.uid() is null then
    raise exception using errcode='42501',message='Not available';
  end if;
  if p_image_id is null or p_expected_description_version is null
    or p_expected_description_version not between 1 and 2147483647
    or p_alt_text is null or length(p_alt_text)>240 then
    raise exception using errcode='22023',message='Invalid input';
  end if;

  -- No parent lock: commit_image locks pending image, parent, then old ready image.
  -- Only the target image state/counter is rechecked after a concurrent row update.
  return query
    update public.item_images as im
    set alt_text=p_alt_text, description_version=im.description_version+1
    where im.id=p_image_id and im.owner_id=auth.uid()
      and im.state='ready' and im.retired_at is null
      and im.description_version=p_expected_description_version
      and im.description_version<2147483647
      and exists(select 1 from public.items as item
        where item.id=im.item_id and item.owner_id=auth.uid() and item.deleted_at is null)
    returning im.id,im.owner_id,im.item_id,im.alt_text,im.description_version;
  if found then return; end if;

  if exists(select 1 from public.item_images as im
    where im.id=p_image_id and im.owner_id=auth.uid()
      and im.state='ready' and im.retired_at is null
      and (im.description_version<>p_expected_description_version or im.description_version=2147483647)
      and exists(select 1 from public.items as item
        where item.id=im.item_id and item.owner_id=auth.uid() and item.deleted_at is null)) then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  raise exception using errcode='42501',message='Not available';
end;
$$;
revoke all on function public.update_image_description(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.update_image_description(uuid,bigint,text) to authenticated;

commit;
