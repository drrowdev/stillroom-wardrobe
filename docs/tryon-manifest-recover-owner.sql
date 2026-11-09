-- TRYON-PROMPT2: PER-OWNER guarded recovery of the try-on manifest (docs/cloud-development.md). It needs its own owner authorisation and is used
-- only after a read-back of private.ai_controls.tryon_manifest_id shows a MIXED state (some accounts on one try-on manifest and some on another),
-- for example after a configuration write ran during the cutover. docs/tryon-manifest-switch.sql refuses in that state by design. Run it with the
-- three placeholders replaced: <owner> (the account's user id), <from> (the manifest that account is on now) and <to> (the manifest it should be
-- on). It moves exactly that one account, in one transaction, with the same lock order as the claim (the profile row, then the controls row) and the
-- same refusals: <to> not installed, the account not on <from>, or the account having a running chain, a held or reserved try-on charge or a
-- reserved result. It asserts that exactly one row was updated and writes nothing but tryon_manifest_id (and updated_at). The same configuration
-- freeze applies: nobody runs tryon_bootstrap or another try-on configuration write while recovery and the read-back are in progress.
begin;
set local lock_timeout = '10s';
do $$
declare
  v_owner constant uuid := '<owner>';
  v_from constant text := '<from>';
  v_to constant text := '<to>';
  v_rows integer;
  c private.ai_controls;
begin
  if not exists(select 1 from private.ai_execution_manifests where id=v_to) then
    raise exception 'try-on manifest recovery: the manifest % is not installed',v_to;
  end if;
  perform 1 from public.profiles where owner_id=v_owner for update;
  if not found then raise exception 'try-on manifest recovery: no such account'; end if;
  select * into c from private.ai_controls where owner_id=v_owner for update;
  if not found or c.tryon_manifest_id is distinct from v_from then
    raise exception 'try-on manifest recovery: the account is on % and not %',coalesce(c.tryon_manifest_id,'(none)'),v_from;
  end if;
  if exists(select 1 from private.tryon_chains where owner_id=v_owner and state='running')
    or exists(select 1 from private.ai_usage where owner_id=v_owner and purpose='try_on' and charge_state in ('reserved','held'))
    or exists(select 1 from private.tryon_results where owner_id=v_owner and state='reserved') then
    raise exception 'try-on manifest recovery: try-on work is still running, held or reserved for the account; wait for it to settle';
  end if;
  update private.ai_controls set tryon_manifest_id=v_to,updated_at=clock_timestamp()
    where owner_id=v_owner and tryon_manifest_id=v_from;
  get diagnostics v_rows = row_count;
  if v_rows<>1 then raise exception 'try-on manifest recovery: % row(s) updated',v_rows; end if;
end;
$$;
commit;
