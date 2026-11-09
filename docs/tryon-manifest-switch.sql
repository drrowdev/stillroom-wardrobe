-- TRYON-PROMPT2: the guarded move of the try-on manifest (docs/cloud-development.md). The owner runs it with the two placeholders replaced:
-- <from> (the manifest id every configured account must be on now) and <to> (the new one). The same text moves the accounts back (swap <from>
-- and <to>). It is one transaction. It moves every configured account at once because the try-on Edge function and the app accept
-- exactly one manifest: an account left behind would fail closed after the redeploy.
-- CONFIGURATION FREEZE: from before this starts until the read-back check afterwards is done, nobody runs tryon_bootstrap or any other write
-- to private.ai_controls.tryon_*. The row locks below cover the configured accounts only; they are not a global admission barrier (the
-- configuration write for a previously unconfigured account takes only that account's own locks). The transaction therefore collects the
-- configured account ids once, locks and checks exactly those, updates exactly those ids and asserts the updated row count, and finally
-- refuses (rolling back) if the set of configured accounts is no longer exactly the collected one. Unconfigured accounts are never written.
-- The lock order is the claim's, account by account in owner order: the profile row, then the controls row, so a claim that has already
-- committed a held row or a chain is seen, and a claim that starts afterwards fails its own no-wait lock (BUSY) and writes nothing.
-- It refuses, changing nothing, when <to> is not installed, when any configured account is not on <from>, or when any configured account has
-- a running chain, a try-on charge that is held or reserved, or a reserved result (wait for it to settle, or for the 15-minute expiry job to
-- end an abandoned chain, then run it again; these predicates are unrestricted by age and are the drain check, unlike the 10-minute
-- threshold of tryon_purge_health().heldUsage). Because it refuses while a chain runs, no chain continues across the move: all steps of a
-- chain use one manifest. It writes nothing but tryon_manifest_id (and updated_at): consent, the notice revision, the limits and the saved
-- reference photo stay. Run it only after the prompt v4 migration is installed. If a read-back ever shows a MIXED v3/v4 state, this text
-- refuses (an account differs from <from>); use docs/tryon-manifest-recover-owner.sql, which needs its own authorisation.
begin;
set local lock_timeout = '10s';
do $$
declare
  v_from constant text := '<from>';
  v_to constant text := '<to>';
  v_ids uuid[];
  v_n integer;
  v_rows integer;
  o uuid;
  c private.ai_controls;
begin
  if not exists(select 1 from private.ai_execution_manifests where id=v_to) then
    raise exception 'try-on manifest switch: the manifest % is not installed',v_to;
  end if;
  select coalesce(array_agg(owner_id order by owner_id),'{}'::uuid[]) into v_ids from private.ai_controls where tryon_manifest_id is not null;
  v_n := cardinality(v_ids);
  if v_n=0 then raise exception 'try-on manifest switch: no configured account'; end if;
  foreach o in array v_ids loop
    perform 1 from public.profiles where owner_id=o for update;
    if not found then raise exception 'try-on manifest switch: configured account % has no profile',o; end if;
    select * into c from private.ai_controls where owner_id=o for update;
    if c.tryon_manifest_id is distinct from v_from then
      raise exception 'try-on manifest switch: account % is on % and not %',o,coalesce(c.tryon_manifest_id,'(none)'),v_from;
    end if;
    if exists(select 1 from private.tryon_chains where owner_id=o and state='running')
      or exists(select 1 from private.ai_usage where owner_id=o and purpose='try_on' and charge_state in ('reserved','held'))
      or exists(select 1 from private.tryon_results where owner_id=o and state='reserved') then
      raise exception 'try-on manifest switch: try-on work is still running, held or reserved for account %; wait for it to settle',o;
    end if;
  end loop;
  update private.ai_controls set tryon_manifest_id=v_to,updated_at=clock_timestamp()
    where owner_id=any(v_ids) and tryon_manifest_id=v_from;
  get diagnostics v_rows = row_count;
  if v_rows<>v_n then
    raise exception 'try-on manifest switch: % row(s) updated for % collected account(s)',v_rows,v_n;
  end if;
  if (select count(*) from private.ai_controls where tryon_manifest_id is not null)<>v_n then
    raise exception 'try-on manifest switch: the set of configured accounts changed during the switch; nothing was changed';
  end if;
  raise notice 'try-on manifest switch: % account(s) moved from % to %',v_n,v_from,v_to;
end;
$$;
commit;
