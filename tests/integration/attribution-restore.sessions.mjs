// P6d: tag-history restore against genuine server-recorded attribution. Invoked only by the CI-only preservation
// owner at the full migration inventory, with the analysis finalizer running; no provider calls.
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisId, analysisHash, analysisFacts, analysisUsage } from './ai-analysis.sessions.mjs';
import { imageChangeHarness } from './image-replacement.sessions.mjs';
import { colourAnalyzedSave, COLOUR_MANIFEST } from './azure-preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const omit = (entry, ...keys) => Object.fromEntries(Object.entries(entry).filter(([key]) => !keys.includes(key)));
const withoutOrigin = (entry) => omit(entry, 'origin');
const ENTRY_KEYS = ['fields', 'image_sha256', 'model_id', 'origin', 'prompt_version', 'source_image_id'];

// Catalog read-back: security definer, empty search_path, no PUBLIC/anon/service_role grant, RLS and no table grant.
export async function attributionRestoreStructure(sql) {
  const result = JSON.parse(await sql(`select jsonb_build_object(
    'table',(select c.relrowsecurity
      and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      from pg_class c where c.oid='private.imported_attribution_history'::regclass),
    'public_functions',(select count(*)=3 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
      and p.proacl is not null and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0)
      and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p where p.oid in ('public.restore_item_attribution(uuid,uuid,jsonb)'::regprocedure,
        'public.item_attribution_history_v2(uuid)'::regprocedure,'public.attribution_digest()'::regprocedure)),
    'private_functions',(select count(*)=2 and bool_and(p.proconfig @> array['search_path=""']
      and p.proacl is not null and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0)
      and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p where p.oid in ('private.backup_bounded(jsonb,integer)'::regprocedure,
        'private.deletion_owner_rows_absent(uuid)'::regprocedure)),
    'restore_lock_timeout',(select p.proconfig @> array['lock_timeout=2s'] from pg_proc p
      where p.oid='public.restore_item_attribution(uuid,uuid,jsonb)'::regprocedure),
    'deletion_inventory',(select p.prosrc like '%private.imported_attribution_history%' from pg_proc p
      where p.oid='private.deletion_owner_rows_absent(uuid)'::regprocedure),
    'legacy_projection',(select p.prosrc not like '%imported_attribution_history%' from pg_proc p
      where p.oid='public.item_attribution_history(uuid)'::regprocedure));`));
  equal(result, { table: true, public_functions: true, private_functions: true, restore_lock_timeout: true,
    deletion_inventory: true, legacy_projection: true });
}

async function projections(client, owner, itemId) {
  const legacy = await client.rpc(owner, 'item_attribution_history', { p_item_id: itemId });
  const current = await client.rpc(owner, 'item_attribution_history_v2', { p_item_id: itemId });
  requireEvidence(Array.isArray(legacy) && Array.isArray(current));
  for (const entry of current) equal(Object.keys(entry).sort(), ENTRY_KEYS);
  return { legacy, current };
}

// Existing owners: v2 without origin equals the legacy projection exactly, in the same order.
async function recordedOnly(client, owner, itemId, length) {
  const { legacy, current } = await projections(client, owner, itemId);
  requireEvidence(legacy.length === length && current.every((entry) => entry.origin === 'recorded'));
  equal(current.map(withoutOrigin), legacy);
  return current;
}

// What restore sends for one item: positions from 0 and photos mapped to the target item's photos, else no photo.
const entriesFrom = (rows, photos) => rows.map((row, position) => ({ position,
  source_image_id: row.source_image_id === null ? null : photos.get(row.source_image_id) ?? null,
  image_sha256: row.image_sha256, model_id: row.model_id, prompt_version: row.prompt_version, fields: row.fields }));
const asImported = (entries) => entries.map((entry) => ({ origin: 'imported', ...omit(entry, 'position') }));

async function restoreSettled(h, itemId, importId, entries) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await h.call('restore_item_attribution', { p_item_id: itemId, p_import_id: importId, p_entries: entries });
    requireEvidence(result.ok && result.status === 200);
    if (result.data.state !== 'busy') return result.data;
    equal(result.data, { state: 'busy', reason: null });
    await delay(50 * attempt);
  }
  return requireEvidence(false);
}

async function completeSettled(ich, value) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await ich.endpoint(value);
    if (result.status === 204) return;
    equal(result, { status: 409, data: { code: 'CONFLICT' } });
    await delay(50 * attempt);
  }
  requireEvidence(false);
}

// A genuine analyzed photo replacement, reserved and uploaded; the caller completes it.
async function analyzedReplacement(ich, sql, owner, n, itemId, imageId) {
  const id = analysisId(owner.label, n);
  requireEvidence(JSON.parse(await sql(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
    ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(COLOUR_MANIFEST.v2)});`)).claimed === true);
  const facts = { ...analysisFacts, fields: { ...analysisFacts.fields, pattern: 'solid' } };
  requireEvidence(JSON.parse(await sql(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},
    ${literal(COLOUR_MANIFEST.v2)},${json(facts)},${json(analysisUsage)},'SUCCESS');`)).stored === true);
  const value = ich.make((await ich.read('items', itemId))[0], (await ich.read('item_images', imageId))[0]);
  value.item.pattern = 'solid'; value.item.field_provenance.pattern = { kind: 'ai_observed', revision: 1 };
  value.claim = { requestId: id, draftId: id, generation: 1, imageSha256: analysisHash,
    fields: { pattern: { kind: 'ai_observed', value: 'solid' } } };
  await ich.reserve(value);
  await ich.upload(value);
  return value;
}

export async function attributionRestoreProbes(snapshot, sql, mark) {
  const { client, owners: [a, b], env } = snapshot;
  const ichA = imageChangeHarness(client, a, env), ichB = imageChangeHarness(client, b, env);
  mark('structure');
  await attributionRestoreStructure(sql);

  // Existing owners see unchanged history: initial-only, combined, replacement-only and a forgotten photo.
  mark('initial-only');
  const combined = (await colourAnalyzedSave(client, a, env, sql, 5, COLOUR_MANIFEST.v2, ['navy'])).value;
  await recordedOnly(client, a, combined.p_item.id, 1);
  mark('combined');
  await completeSettled(ichA, await analyzedReplacement(ichA, sql, a, 6, combined.p_item.id, combined.p_image.id));
  const genuine = await recordedOnly(client, a, combined.p_item.id, 2);
  requireEvidence(genuine[0].source_image_id === combined.p_image.id && genuine[1].source_image_id !== null);
  mark('replacement-only');
  const manual = await ichA.create();
  await completeSettled(ichA, await analyzedReplacement(ichA, sql, a, 7, manual.item.id, manual.image.id));
  await recordedOnly(client, a, manual.item.id, 1);
  mark('null-image');
  await ichA.remove({ itemId: combined.p_item.id, imageId: combined.p_image.id });
  await client.rpc(a, 'forget_image', { p_image_id: combined.p_image.id });
  const forgotten = await recordedOnly(client, a, combined.p_item.id, 2);
  equal(forgotten, [{ ...genuine[0], source_image_id: null }, genuine[1]]);

  // Genuine history into B's restored item: labelled imported, same order and facts; the same import is a replay.
  mark('first-generation');
  const targetB = await ichB.create(), importB = randomUUID();
  const firstEntries = entriesFrom(forgotten, new Map([[genuine[1].source_image_id, targetB.image.id]]));
  equal(await restoreSettled(ichB, targetB.item.id, importB, firstEntries), { state: 'created', reason: null });
  equal(await restoreSettled(ichB, targetB.item.id, importB, firstEntries), { state: 'equal', reason: null });
  let history = await projections(client, b, targetB.item.id);
  equal(history, { legacy: [], current: asImported(firstEntries) });
  mark('peer-refusals');
  const peerItem = await client.request(b.token, '/rest/v1/rpc/restore_item_attribution', { method: 'POST',
    body: { p_item_id: manual.item.id, p_import_id: importB, p_entries: firstEntries } });
  requireEvidence(peerItem.status === 403 && peerItem.data?.code === '42501' && peerItem.data?.message === 'Not available');
  const peerPhoto = await client.request(b.token, '/rest/v1/rpc/restore_item_attribution', { method: 'POST',
    body: { p_item_id: targetB.item.id, p_import_id: randomUUID(), p_entries: entriesFrom(forgotten.slice(1), new Map([[genuine[1].source_image_id, genuine[1].source_image_id]])) } });
  requireEvidence(peerPhoto.status === 400 && peerPhoto.data?.code === '22023' && peerPhoto.data?.message === 'Invalid input');
  const peerRead = await client.request(b.token, '/rest/v1/rpc/item_attribution_history_v2', { method: 'POST',
    body: { p_item_id: combined.p_item.id } });
  requireEvidence(peerRead.status === 403 && peerRead.data?.code === '42501');
  equal((await projections(client, a, combined.p_item.id)).current, forgotten);

  // A genuine replacement after the import is recorded after the imported entries; imported stays imported.
  mark('imported-then-genuine');
  await completeSettled(ichB, await analyzedReplacement(ichB, sql, b, 11, targetB.item.id, targetB.image.id));
  history = await projections(client, b, targetB.item.id);
  requireEvidence(history.legacy.length === 1 && history.current.length === 3);
  equal(history.current.slice(0, 2), asImported(firstEntries));
  equal(history.current.slice(2).map(withoutOrigin), history.legacy);
  equal(history.current[2].origin, 'recorded');
  equal(await restoreSettled(ichB, targetB.item.id, importB, firstEntries), { state: 'equal', reason: null });

  // Second generation: B's history restored into A keeps every entry, now all imported.
  mark('second-generation');
  const targetA = await ichA.create();
  const secondEntries = entriesFrom(history.current, new Map([[history.current[2].source_image_id, targetA.image.id]]));
  equal(await restoreSettled(ichA, targetA.item.id, randomUUID(), secondEntries), { state: 'created', reason: null });
  equal(await projections(client, a, targetA.item.id), { legacy: [], current: asImported(secondEntries) });
  equal(secondEntries.map((entry) => omit(entry, 'source_image_id', 'position')),
    history.current.map((entry) => omit(entry, 'source_image_id', 'origin')));

  // Concurrent imports: busy is retried, never reported as kept; the final outcome is a serial one.
  mark('concurrent-identical');
  const same = await ichA.create(), sameImport = randomUUID(), sameEntries = entriesFrom(forgotten, new Map());
  const identical = await Promise.all([restoreSettled(ichA, same.item.id, sameImport, sameEntries),
    restoreSettled(ichA, same.item.id, sameImport, sameEntries)]);
  equal(identical.map((o) => o.state).sort(), ['created', 'equal']);
  equal((await projections(client, a, same.item.id)).current, asImported(sameEntries));
  mark('concurrent-differing');
  const differ = await ichA.create(), left = entriesFrom(forgotten, new Map()), right = entriesFrom(forgotten.slice(1), new Map());
  const differing = await Promise.all([restoreSettled(ichA, differ.item.id, randomUUID(), left),
    restoreSettled(ichA, differ.item.id, randomUUID(), right)]);
  const winner = differing[0].state === 'created' ? left : right;
  equal(differing.map((o) => `${o.state}:${o.reason}`).sort(), ['created:null', 'kept:other-import']);
  equal((await projections(client, a, differ.item.id)).current, asImported(winner));

  // An import racing a genuine completion: whichever commits first decides, and nothing is overwritten.
  mark('completion-race');
  const raced = await ichA.create();
  const replacement = await analyzedReplacement(ichA, sql, a, 12, raced.item.id, raced.image.id);
  const [, outcome] = await Promise.all([completeSettled(ichA, replacement),
    restoreSettled(ichA, raced.item.id, randomUUID(), sameEntries)]);
  history = await projections(client, a, raced.item.id);
  requireEvidence(history.legacy.length === 1 && history.legacy[0].source_image_id === replacement.imageId);
  if (outcome.state === 'created') {
    equal(history.current.slice(0, -1), asImported(sameEntries));
    equal(history.current.slice(-1).map(withoutOrigin), history.legacy);
  } else {
    equal(outcome, { state: 'kept', reason: 'recorded' });
    equal(history.current.map(withoutOrigin), history.legacy);
    requireEvidence(history.current.every((entry) => entry.origin === 'recorded'));
  }
  requireEvidence(isDeepStrictEqual((await projections(client, a, combined.p_item.id)).current, forgotten));
  mark('complete');
}
