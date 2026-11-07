-- OUTFITGEN1b review fix: Undo of a removed suggestion puts it back among the pending ones, so it must respect the same
-- cap of 40 pending suggestions that recording enforces. The function is its latest body (20261106090000) plus the one
-- capacity check; grants are unchanged. A refusal changes nothing (the Remove and its vote stay as they were).
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
  if (select count(*) from public.suggested_outfits where owner_id=v_owner and state='suggested')>=40 then
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
