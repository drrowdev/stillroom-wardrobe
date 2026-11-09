-- OUTFITGEN-QUALITY1: the guarded move of one owner's outfit-suggestion manifest (docs/cloud-development.md). The owner runs it with the
-- three placeholders replaced: <owner> (the owner's user id), <from> (the manifest id that must be installed now) and <to> (the new one).
-- The same text moves the owner back (swap <from> and <to>). It is one transaction. The lock order is the claim's: the profile row,
-- then the controls row, so a claim that has already committed a held row is seen below, and a claim that starts afterwards fails its
-- own no-wait lock (BUSY) and writes nothing. It refuses, changing nothing, when the expected manifest is not the installed one or when any
-- outfit work is held or reserved (wait for it to settle or expire, then run it again). It writes nothing else: consent, the notice
-- revision and the limits stay. Run it only after the judge v2 migration is installed.
begin;
set local lock_timeout = '10s';
do $$
declare
  v_owner constant uuid := '<owner>';
  v_from constant text := '<from>';
  v_to constant text := '<to>';
  c private.ai_controls;
begin
  perform 1 from public.profiles where owner_id=v_owner for update;
  if not found then raise exception 'outfit manifest switch: no such owner'; end if;
  select * into c from private.ai_controls where owner_id=v_owner for update;
  if not found or c.outfitgen_manifest_id is distinct from v_from then
    raise exception 'outfit manifest switch: the installed manifest is % and not %',coalesce(c.outfitgen_manifest_id,'(none)'),v_from;
  end if;
  if not exists(select 1 from private.ai_execution_manifests where id=v_to) then
    raise exception 'outfit manifest switch: the manifest % is not installed',v_to;
  end if;
  if exists(select 1 from private.ai_usage where owner_id=v_owner and purpose='outfitgen' and charge_state in ('reserved','held')) then
    raise exception 'outfit manifest switch: outfit work is still held or reserved; wait for it to settle';
  end if;
  update private.ai_controls set outfitgen_manifest_id=v_to,updated_at=clock_timestamp() where owner_id=v_owner;
end;
$$;
commit;
