BEGIN;

-- App lifecycle contract; existing ordinary owner UPDATE/DELETE grants remain unchanged.
create function public.set_outfit_trashed(p_id uuid, p_expected_version bigint, p_trashed boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  u uuid := auth.uid();
  o public.outfits;
  v_now timestamptz;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  perform 1 from private.ai_controls where owner_id=u for update nowait;
  if p_id is null or p_expected_version is null or p_expected_version not between 1 and 9007199254740991
    or p_trashed is null then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select * into o from public.outfits where owner_id=u and id=p_id for update nowait;
  if not found or o.version<>p_expected_version or o.version>=9007199254740991 then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  v_now := clock_timestamp();
  if p_trashed then
    if o.deleted_at is not null then raise exception using errcode='22023',message='Request conflict'; end if;
  else
    if o.deleted_at is null then raise exception using errcode='22023',message='Request conflict'; end if;
    if o.deleted_at>v_now or o.deleted_at<v_now-interval '7 days' then
      raise exception using errcode='22023',message='Recovery expired';
    end if;
  end if;
  update public.outfits set deleted_at=case when p_trashed then v_now else null end
    where owner_id=u and id=p_id returning * into o;
  return jsonb_build_object('id',o.id,'owner_id',o.owner_id,'version',o.version,'deleted_at',o.deleted_at);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

create function public.delete_trashed_outfit(p_id uuid, p_expected_version bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  u uuid := auth.uid();
  o public.outfits;
begin
  perform private.image_change_lock(u);
  perform 1 from public.profiles where owner_id=u for update nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  perform 1 from private.ai_controls where owner_id=u for update nowait;
  if p_id is null or p_expected_version is null or p_expected_version not between 1 and 9007199254740991 then
    raise exception using errcode='22023',message='Invalid input';
  end if;
  select * into o from public.outfits where owner_id=u and id=p_id for update nowait;
  if not found or o.version<>p_expected_version or o.deleted_at is null then
    raise exception using errcode='22023',message='Request conflict';
  end if;
  -- Claims/finishes take the same owner locks. Never remove live accounting context mid-chain.
  if exists(select 1 from private.tryon_chains
    where owner_id=u and outfit_id=p_id and state='running' and expires_at>clock_timestamp()) then
    raise exception using errcode='22023',message='Try-on running';
  end if;
  delete from public.outfits where owner_id=u and id=p_id;
  return jsonb_build_object('id',o.id,'owner_id',o.owner_id,'version',o.version,'deleted',true);
exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';
end;
$$;

revoke all on function public.set_outfit_trashed(uuid,bigint,boolean),
  public.delete_trashed_outfit(uuid,bigint) from public,anon,authenticated;
grant execute on function public.set_outfit_trashed(uuid,bigint,boolean),
  public.delete_trashed_outfit(uuid,bigint) to authenticated;

COMMIT;
