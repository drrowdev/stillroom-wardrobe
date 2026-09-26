import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { saveClients, eq } from './item-save.sessions.mjs';

// I12 calendar writes against the current main schema, through each owner's normal session only. Fictional photo-less
// fixtures are created and removed by that owner. The hosted project still runs the initial save_wear_event, which
// reports a create-ID collision as 23505 instead of 'Request conflict'; the UI maps both, and this suite covers main.
const localToday = (timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const shift = (iso, days) => { const value = new Date(`${iso}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const lookSelect = 'id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at,version,'
  + 'wear_event_items!wear_event_items_owner_id_event_id_fkey(owner_id,item_id,title_snapshot,category_snapshot)';

export function wearHarness(client, owner) {
  const items = [], outfits = [], events = [];
  const call = (body, token = owner.token) => client.request(token, '/rest/v1/rpc/save_wear_event', { method: 'POST', body });
  const item = async (extra = {}) => {
    const row = await client.insert(owner, 'items', { id: randomUUID(), title: 'Fictional calendar garment', category: 'top', ...extra });
    items.push(row.id);
    return row;
  };
  const outfit = async (itemIds) => {
    const id = randomUUID();
    outfits.push(id);
    const saved = await client.request(owner.token, '/rest/v1/rpc/save_outfit', { method: 'POST', body: {
      p_id: id, p_title: 'Fictional calendar outfit', p_occasion: 'everyday', p_notes: '', p_favourite: false, p_item_ids: itemIds } });
    requireEvidence(saved.ok && saved.data === 1);
    return id;
  };
  const args = (id, itemIds, extra = {}) => ({
    p_id: id, p_local_date: localToday('Europe/Helsinki'), p_timezone: 'Europe/Helsinki', p_state: 'planned',
    p_label: 'Fictional look', p_outfit_id: null, p_item_ids: itemIds, ...extra,
  });
  const create = async (itemIds, extra = {}) => {
    const body = args(randomUUID(), itemIds, extra);
    events.push(body.p_id);
    const result = await call(body);
    requireEvidence(result.ok && result.status === 200 && result.data === 1);
    return body;
  };
  const read = async (id, token = owner.token) => {
    const result = await client.request(token, `/rest/v1/wear_events?id=eq.${id}&select=${lookSelect}`);
    requireEvidence(result.ok && Array.isArray(result.data));
    for (const row of result.data) row.wear_event_items.sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
    return result.data;
  };
  // The UI's remove and undo: an owner- and version-guarded PATCH of deleted_at that must change exactly one row.
  const setRemoved = (id, version, removed, token = owner.token, uid = owner.uid) => client.request(token,
    `/rest/v1/wear_events?id=eq.${id}&owner_id=eq.${uid}&version=eq.${version}&select=id,version,deleted_at`, {
      method: 'PATCH', body: { deleted_at: removed ? new Date().toISOString() : null }, headers: { Prefer: 'return=representation' } });
  const rejected = (result, message) => {
    requireEvidence(!result.ok && result.status === 400 && result.data?.code === 'P0001');
    eq(result.data.message, message);
  };
  const cleanup = async () => {
    for (const id of events) requireEvidence((await client.request(owner.token, `/rest/v1/wear_events?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of outfits) requireEvidence((await client.request(owner.token, `/rest/v1/outfits?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of items) requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of events) eq(await read(id), []);
  };
  return { call, item, outfit, args, create, read, setRemoved, rejected, cleanup, items, outfits, events };
}

async function ownerCases(client, owner, other, h, otherH, passed) {
  const [top, bottom] = [await h.item({ title: 'Calendar top' }), await h.item({ title: 'Calendar trousers', category: 'bottom' })];
  const outfitId = await h.outfit([top.id, bottom.id]);
  const today = localToday('Europe/Helsinki');

  // Plan from a saved outfit, mark it worn, then undo back to planned with the new version.
  const planned = await h.create([top.id, bottom.id], { p_outfit_id: outfitId, p_label: 'Calendar plan' });
  let [row] = await h.read(planned.p_id);
  eq(row.owner_id, owner.uid); eq(row.state, 'planned'); eq(row.version, 1); eq(row.outfit_id, outfitId); eq(row.local_date, today);
  eq(row.wear_event_items.map((link) => [link.owner_id, link.title_snapshot]).sort(),
    [[owner.uid, 'Calendar top'], [owner.uid, 'Calendar trousers']]);
  const replay = await h.call(planned);
  requireEvidence(replay.ok && replay.data === 1);
  const worn = await h.call({ ...planned, p_state: 'worn', p_expected_version: 1 });
  requireEvidence(worn.ok && worn.data === 2);
  const undo = await h.call({ ...planned, p_state: 'planned', p_expected_version: 2 });
  requireEvidence(undo.ok && undo.data === 3);
  h.rejected(await h.call({ ...planned, p_state: 'planned', p_expected_version: 2 }), 'Request conflict');
  [row] = await h.read(planned.p_id);
  eq(row.state, 'planned'); eq(row.version, 3);
  passed.push('plan, replay, worn, undo and stale undo');

  // A second look on the same day, from separate items and without an outfit.
  const second = await h.create([top.id], { p_label: 'Evening', p_state: 'worn' });
  eq((await h.read(second.p_id))[0].state, 'worn');
  passed.push('second look on one day');

  // A future day can be planned but never marked worn, on create or on edit.
  const tomorrow = shift(today, 1);
  const future = await h.create([top.id], { p_local_date: tomorrow });
  h.rejected(await h.call({ ...future, p_state: 'worn', p_expected_version: 1 }), 'A future plan cannot count as worn');
  const futureWorn = h.args(randomUUID(), [top.id], { p_local_date: tomorrow, p_state: 'worn' });
  h.rejected(await h.call(futureWorn), 'A future plan cannot count as worn');
  eq(await h.read(futureWorn.p_id), []);
  eq((await h.read(future.p_id))[0].version, 1);
  passed.push('future day cannot be worn');

  // "Today" is the look's own time zone: the stored local date never moves, and the same date can be worn where it is
  // already that day but is still in the future where it is not.
  const ahead = localToday('Pacific/Kiritimati');
  const zoned = await h.create([bottom.id], { p_local_date: ahead, p_timezone: 'Pacific/Kiritimati' });
  const zonedWorn = await h.call({ ...zoned, p_state: 'worn', p_expected_version: 1 });
  requireEvidence(zonedWorn.ok && zonedWorn.data === 2);
  [row] = await h.read(zoned.p_id);
  eq(row.local_date, ahead); eq(row.timezone, 'Pacific/Kiritimati');
  if (ahead > localToday('Pacific/Pago_Pago')) {
    const behind = await h.create([bottom.id], { p_local_date: ahead, p_timezone: 'Pacific/Pago_Pago' });
    h.rejected(await h.call({ ...behind, p_state: 'worn', p_expected_version: 1 }), 'A future plan cannot count as worn');
    eq((await h.read(behind.p_id))[0].local_date, ahead);
  }
  h.rejected(await h.call(h.args(randomUUID(), [top.id], { p_timezone: 'Not/AZone' })), 'Invalid timezone');
  passed.push('worn rule follows the look time zone');

  // Remove and undo through the guarded PATCH: exactly one row, and a stale version changes nothing.
  const removed = await h.setRemoved(second.p_id, 1, true);
  requireEvidence(removed.ok && removed.data.length === 1 && removed.data[0].version === 2 && removed.data[0].deleted_at !== null);
  const staleRemove = await h.setRemoved(second.p_id, 1, false);
  requireEvidence(staleRemove.ok); eq(staleRemove.data, []);
  requireEvidence((await h.read(second.p_id))[0].deleted_at !== null);
  h.rejected(await h.call({ ...second, p_expected_version: 2 }), 'Request conflict');
  h.rejected(await h.call(second), 'Request conflict');
  const restored = await h.setRemoved(second.p_id, 2, false);
  requireEvidence(restored.ok && restored.data.length === 1 && restored.data[0].version === 3 && restored.data[0].deleted_at === null);
  passed.push('guarded remove and undo');

  // Selections: empty, duplicate, over twelve, trashed and another account's items are all refused without a row.
  const trashed = await h.item();
  const trash = await client.patch(owner, 'items', trashed, { deleted_at: new Date().toISOString() });
  requireEvidence(trash.ok && trash.data.length === 1);
  const twelve = [top.id, bottom.id];
  while (twelve.length < 13) twelve.push((await h.item()).id);
  const foreignItem = otherH.items[0];
  for (const itemIds of [[], [top.id, top.id], twelve, [trashed.id], [foreignItem], [top.id, foreignItem]]) {
    const body = h.args(randomUUID(), itemIds);
    h.rejected(await h.call(body), 'Invalid selection');
    eq(await h.read(body.p_id), []);
  }
  passed.push('selection bounds and foreign items');

  // Another account's outfit fails its owner foreign key, and another account's look is neither readable nor writable.
  const foreignOutfit = h.args(randomUUID(), [top.id], { p_outfit_id: otherH.outfits[0] });
  const foreignOutfitResult = await h.call(foreignOutfit);
  requireEvidence(!foreignOutfitResult.ok && foreignOutfitResult.data?.code === '23503');
  eq(await h.read(foreignOutfit.p_id), []);
  const theirs = otherH.events[0];
  const theirsBefore = await otherH.read(theirs);
  eq(await h.read(theirs), []);
  const foreignPatch = await h.setRemoved(theirs, theirsBefore[0].version, true, owner.token, other.uid);
  requireEvidence(foreignPatch.ok); eq(foreignPatch.data, []);
  const foreignEdit = await h.call({ ...h.args(theirs, [top.id]), p_expected_version: theirsBefore[0].version });
  h.rejected(foreignEdit, 'Request conflict');
  // Known existence oracle, reported by the I17 audit: a foreign create ID collides with the other owner's primary key.
  h.rejected(await h.call(h.args(theirs, [top.id])), 'Request conflict');
  eq(await otherH.read(theirs), theirsBefore);
  passed.push('foreign outfit and look refused');

  // Deleting a garment keeps the look's snapshot; the event keeps its version and its other link.
  const gone = await h.item({ title: 'Garment to delete', category: 'outerwear' });
  const kept = await h.create([gone.id, top.id], { p_label: 'Snapshot look', p_state: 'worn' });
  requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${gone.id}`, { method: 'DELETE' })).ok);
  h.items.splice(h.items.indexOf(gone.id), 1);
  [row] = await h.read(kept.p_id);
  eq(row.version, 1);
  const snapshot = row.wear_event_items.find((link) => link.item_id === null);
  requireEvidence(snapshot !== undefined && snapshot.title_snapshot === 'Garment to delete' && snapshot.category_snapshot === 'outerwear');
  // Undo on a look whose garment is gone sends only the remaining item and keeps the snapshot.
  const keptUndo = await h.call({ ...kept, p_state: 'planned', p_item_ids: [top.id], p_expected_version: 1 });
  requireEvidence(keptUndo.ok && keptUndo.data === 2);
  [row] = await h.read(kept.p_id);
  eq(row.wear_event_items.length, 2);
  requireEvidence(row.wear_event_items.some((link) => link.item_id === null && link.title_snapshot === 'Garment to delete'));
  passed.push('deleted garment keeps its snapshot');
}

export async function wearIntegration(env, passed = []) {
  const { client, owners } = await saveClients(env);
  requireEvidence(owners.length === 2 && owners[0].uid !== owners[1].uid);
  const harnesses = owners.map((owner) => wearHarness(client, owner));
  let failure = null;
  try {
    // Each owner first gets a fixture look the other owner then tries to reach.
    for (const h of harnesses) {
      const itemId = (await h.item({ title: 'Other owner garment' })).id;
      await h.outfit([itemId]);
      await h.create([itemId], { p_label: 'Other owner look' });
    }
    await ownerCases(client, owners[0], owners[1], harnesses[0], harnesses[1], passed);
    await ownerCases(client, owners[1], owners[0], harnesses[1], harnesses[0], passed);
  } catch (error) { failure = error; }
  for (const h of harnesses) {
    try { await h.cleanup(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  // Every case ran for both owners.
  requireEvidence(passed.length === 2 * wearCases && passed.slice(0, wearCases).every((name, index) => passed[wearCases + index] === name));
  return passed;
}
export const wearCases = 8;

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2);
    const passed = await wearIntegration(process.env);
    console.log(`PASS: I12 wear RPC, ${wearCases} cases for each of 2 normal owners (${passed.length} runs): ${passed.slice(0, wearCases).join('; ')}`);
  } catch {
    console.error('FAIL: I12 wear RPC integration; private evidence withheld'); process.exitCode = 1;
  }
}
