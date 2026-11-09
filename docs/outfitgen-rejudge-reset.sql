-- OUTFITGEN-QUALITY2: the owner-run re-judge reset (docs/cloud-development.md). The judge's verdicts are cached as `declined` rows per prompt
-- version, so sets judged before the selection bar moved from 8 to 7 (and the eights that the caps held back) are never offered again. This
-- removes the owner's declined rows of prompt version 2 (manifest azure-eu-terra-outfitgen-v2), with a score of at least <min_score>, and clears the owner's
-- "assessed" markers, so the next whole-wardrobe press judges every garment again (about one call per garment). Run it only AFTER the new
-- outfit-generate Edge function is deployed AND VERIFIED, and only inside the quiet window of docs/cloud-development.md (OUTFITGEN-QUALITY2): the
-- held/reserved check below cannot see an old Edge invocation that has planned but not yet claimed, and the manifest does not change, so such an
-- invocation could claim after this commits and re-cache verdicts under the old rules.
-- Placeholders: <owner> (the owner's user id) and <min_score> (1 to 10: 1 clears every declined row and gives the cleanest, relative scores;
-- 7 clears only the near-misses, which are then judged without the sets they were ranked against).
-- One transaction. The lock order is the claim's: the profile row, then the controls row, so a claim that already committed a held row is
-- seen below and a claim that starts afterwards fails its own no-wait lock (BUSY) and writes nothing. It refuses, changing nothing, while any
-- outfit work is held or reserved (wait for it to settle or expire, then run it again). It never touches suggested, kept or removed rows,
-- consent, controls or usage. It fails closed unless the owner is on exactly the expected manifest and prompt version (a constant below, so
-- an account still on v1, or on a later version, loses nothing). The result is counts only.
begin;
set local lock_timeout = '10s';
do $$
declare
  v_owner constant uuid := '<owner>';
  v_min constant integer := <min_score>;
  v_expected_manifest constant text := 'azure-eu-terra-outfitgen-v2';
  v_expected_version constant integer := 2;
  c private.ai_controls;
  v_version integer;
  v_declined integer;
  v_assessed integer;
begin
  if v_min is null or v_min not between 1 and 10 then raise exception 'outfit re-judge reset: min_score must be 1 to 10'; end if;
  perform 1 from public.profiles where owner_id=v_owner for update;
  if not found then raise exception 'outfit re-judge reset: no such owner'; end if;
  select * into c from private.ai_controls where owner_id=v_owner for update;
  if not found or c.outfitgen_manifest_id is null then raise exception 'outfit re-judge reset: no outfit manifest is installed'; end if;
  select m.prompt_version into v_version from private.ai_execution_manifests m where m.id=c.outfitgen_manifest_id;
  if not found then raise exception 'outfit re-judge reset: the manifest % is not installed',c.outfitgen_manifest_id; end if;
  if c.outfitgen_manifest_id is distinct from v_expected_manifest or v_version is distinct from v_expected_version then
    raise exception 'outfit re-judge reset: the installed manifest is % (prompt version %), not % (prompt version %)',c.outfitgen_manifest_id,v_version,v_expected_manifest,v_expected_version;
  end if;
  if exists(select 1 from private.ai_usage where owner_id=v_owner and purpose='outfitgen' and charge_state in ('reserved','held')) then
    raise exception 'outfit re-judge reset: outfit work is still held or reserved; wait for it to settle';
  end if;
  delete from public.suggested_outfits where owner_id=v_owner and state='declined' and prompt_version=v_expected_version and score>=v_min;
  get diagnostics v_declined = row_count;
  delete from private.outfit_assessed_items where owner_id=v_owner;
  get diagnostics v_assessed = row_count;
  raise notice 'outfit re-judge reset: % declined rows removed, % assessed markers cleared',v_declined,v_assessed;
end;
$$;
commit;
select s.state, count(*) as rows from public.suggested_outfits s where s.owner_id='<owner>' group by s.state order by s.state;
select count(*) as assessed_left from private.outfit_assessed_items where owner_id='<owner>';
