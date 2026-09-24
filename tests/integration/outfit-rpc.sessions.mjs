import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { saveClients, eq } from './item-save.sessions.mjs';

// Fictional photo-less fixtures only; every row is created and removed by this owner's normal session.
export function outfitHarness(client, owner) {
  const items = [], outfits = [], events = [];
  const call = (body, token = owner.token) => client.request(token, '/rest/v1/rpc/save_outfit', { method: 'POST', body });
  const item = async (extra = {}) => {
    const row = await client.insert(owner, 'items', { id: randomUUID(), title: 'Fictional outfit garment', category: 'top', ...extra });
    items.push(row.id);
    return row;
  };
  const args = (id, itemIds, extra = {}) => ({
    p_id: id, p_title: 'Fictional outfit', p_occasion: 'everyday', p_notes: '', p_favourite: false, p_item_ids: itemIds, ...extra,
  });
  const create = async (itemIds, extra = {}) => {
    const body = args(randomUUID(), itemIds, extra);
    outfits.push(body.p_id);
    const result = await call(body);
    requireEvidence(result.ok && result.status === 200 && result.data === 1);
    return body;
  };
  const read = async (id, token = owner.token) => {
    const parent = await client.request(token, `/rest/v1/outfits?id=eq.${id}&select=*`);
    const links = await client.request(token, `/rest/v1/outfit_items?outfit_id=eq.${id}&select=owner_id,outfit_id,item_id,position&order=position`);
    requireEvidence(parent.ok && Array.isArray(parent.data) && links.ok && Array.isArray(links.data));
    return { parent: parent.data, links: links.data };
  };
  const positions = (state) => state.links.map((link) => [link.item_id, link.position]);
  const rejected = (result, message) => {
    requireEvidence(!result.ok && result.status === 400 && result.data?.code === 'P0001');
    eq(result.data.message, message);
  };
  const cleanup = async () => {
    for (const id of events) requireEvidence((await client.request(owner.token, `/rest/v1/wear_events?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of outfits) requireEvidence((await client.request(owner.token, `/rest/v1/outfits?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of items) requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    for (const id of outfits) eq((await read(id)).parent, []);
  };
  return { call, item, args, create, read, positions, rejected, cleanup, outfits, events };
}

async function ownerCases(client, owner, h) {
  const [first, second, third] = [await h.item(), await h.item({ category: 'bottom' }), await h.item({ category: 'footwear' })];
  const ids = [first.id, second.id, third.id];

  const outfit = await h.create(ids);
  let state = await h.read(outfit.p_id);
  eq(state.parent.length, 1); eq(state.parent[0].version, 1); eq(state.parent[0].owner_id, owner.uid);
  eq(h.positions(state), ids.map((id, index) => [id, index]));
  for (const link of state.links) eq(link.owner_id, owner.uid);

  // Omitted and null versions both mean an exact create replay.
  for (const body of [outfit, { ...outfit, p_expected_version: null }]) {
    const replay = await h.call(body);
    requireEvidence(replay.ok && replay.data === 1);
  }
  eq(await h.read(outfit.p_id), state);
  h.rejected(await h.call({ ...outfit, p_title: 'Different payload' }), 'Request conflict');
  eq(await h.read(outfit.p_id), state);

  const edited = await h.call({ ...outfit, p_title: 'Edited outfit', p_item_ids: [third.id, first.id], p_expected_version: 1 });
  requireEvidence(edited.ok && edited.data === 2);
  state = await h.read(outfit.p_id);
  eq(state.parent[0].title, 'Edited outfit'); eq(state.parent[0].version, 2);
  eq(h.positions(state), [[third.id, 0], [first.id, 1]]);

  h.rejected(await h.call({ ...outfit, p_title: 'Stale', p_expected_version: 1 }), 'Request conflict');
  eq(await h.read(outfit.p_id), state);

  for (const itemIds of [[], ids.concat(ids).concat(ids).concat(ids).concat([first.id]), [first.id, first.id]]) {
    const id = randomUUID();
    h.rejected(await h.call(h.args(id, itemIds)), 'Invalid selection');
    eq((await h.read(id)).parent, []);
  }

  const twelve = [...ids];
  while (twelve.length < 12) twelve.push((await h.item()).id);
  const full = await h.create(twelve);
  eq(h.positions(await h.read(full.p_id)), twelve.map((id, index) => [id, index]));
  const thirteen = h.args(randomUUID(), [...twelve, (await h.item()).id]);
  h.rejected(await h.call(thirteen), 'Invalid selection');
  eq((await h.read(thirteen.p_id)).parent, []);

  // An invalid name fails the whole write.
  const invalidCreate = h.args(randomUUID(), [first.id], { p_title: '' });
  const failed = await h.call(invalidCreate);
  requireEvidence(!failed.ok && failed.status === 400 && failed.data?.code === '23514');
  eq((await h.read(invalidCreate.p_id)).parent, []);
  const invalidEdit = await h.call({ ...outfit, p_title: 'x'.repeat(101), p_item_ids: [second.id], p_expected_version: 2 });
  requireEvidence(!invalidEdit.ok && invalidEdit.status === 400 && invalidEdit.data?.code === '23514');
  eq(await h.read(outfit.p_id), state);

  const archived = await h.item({ lifecycle: 'archived' });
  const trashed = await h.item();
  const trash = await client.request(owner.token, '/rest/v1/rpc/set_item_trashed', { method: 'POST',
    body: { p_item_id: trashed.id, p_expected_version: trashed.version, p_trashed: true } });
  requireEvidence(trash.ok && Array.isArray(trash.data) && trash.data.length === 1 && trash.data[0].deleted_at !== null);
  const kept = await h.create([archived.id, trashed.id]);
  eq(h.positions(await h.read(kept.p_id)), [[archived.id, 0], [trashed.id, 1]]);

  const removed = await h.create([first.id]);
  const soft = await client.request(owner.token, `/rest/v1/outfits?owner_id=eq.${owner.uid}&id=eq.${removed.p_id}`, {
    method: 'PATCH', body: { deleted_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' } });
  requireEvidence(soft.ok && soft.data.length === 1 && soft.data[0].version === 2);
  const softState = await h.read(removed.p_id);
  h.rejected(await h.call({ ...removed, p_expected_version: 2 }), 'Request conflict');
  h.rejected(await h.call(removed), 'Request conflict');
  eq(await h.read(removed.p_id), softState);

  // Two sessions of the same owner edit from the same version: exactly one wins.
  const again = await client.signIn(owner.label);
  requireEvidence(again.uid === owner.uid && again.token !== owner.token);
  const race = await Promise.all([
    h.call({ ...outfit, p_title: 'First session', p_expected_version: 2 }),
    h.call({ ...outfit, p_title: 'Second session', p_expected_version: 2 }, again.token),
  ]);
  eq(race.filter((result) => result.ok).length, 1);
  const loser = race.find((result) => !result.ok);
  h.rejected(loser, 'Request conflict');
  state = await h.read(outfit.p_id);
  eq(state.parent[0].version, 3);
  requireEvidence(['First session', 'Second session'].includes(state.parent[0].title));

  // Base wear RPC fixture only: an outfit edit never touches existing wear rows.
  const event = randomUUID();
  h.events.push(event);
  const worn = await client.request(owner.token, '/rest/v1/rpc/save_wear_event', { method: 'POST', body: {
    p_id: event, p_local_date: '2026-01-01', p_timezone: 'Europe/Helsinki', p_state: 'worn', p_label: 'Fictional worn look',
    p_outfit_id: outfit.p_id, p_item_ids: [third.id, first.id], p_expected_version: null } });
  requireEvidence(worn.ok && worn.data === 1);
  const wear = async () => ({
    events: (await client.request(owner.token, `/rest/v1/wear_events?id=eq.${event}&select=*`)).data,
    links: (await client.request(owner.token, `/rest/v1/wear_event_items?event_id=eq.${event}&select=*&order=item_id`)).data,
  });
  const before = await wear();
  eq(before.events.length, 1); eq(before.links.length, 2);
  const wearEdit = await h.call({ ...outfit, p_title: 'After wear', p_item_ids: [second.id], p_expected_version: 3 });
  requireEvidence(wearEdit.ok && wearEdit.data === 4);
  eq(await wear(), before);

  // The embedded read returns only this owner's links.
  const embedded = await client.request(owner.token,
    `/rest/v1/outfits?owner_id=eq.${owner.uid}&id=eq.${outfit.p_id}&select=id,outfit_items!outfit_items_owner_id_outfit_id_fkey(owner_id,item_id,position)`);
  requireEvidence(embedded.ok && embedded.data.length === 1);
  eq(embedded.data[0].outfit_items, [{ owner_id: owner.uid, item_id: second.id, position: 0 }]);

  // Permanent item deletion cascades links without bumping the outfit version.
  const gapItems = [await h.item(), await h.item(), await h.item()];
  const gap = await h.create(gapItems.map((row) => row.id));
  const remove = async (id) => requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
  await remove(gapItems[1].id);
  let gapState = await h.read(gap.p_id);
  eq(gapState.parent[0].version, 1);
  eq(h.positions(gapState), [[gapItems[0].id, 0], [gapItems[2].id, 2]]);
  await remove(gapItems[0].id); await remove(gapItems[2].id);
  gapState = await h.read(gap.p_id);
  eq(gapState.parent.length, 1); eq(gapState.parent[0].version, 1); eq(gapState.links, []);
}

export async function outfitIntegration(env) {
  const { client, owners } = await saveClients(env);
  const harnesses = owners.map((owner) => outfitHarness(client, owner));
  let failure = null;
  try {
    for (const [index, owner] of owners.entries()) await ownerCases(client, owner, harnesses[index]);
  } catch (error) { failure = error; }
  for (const h of harnesses) {
    try { await h.cleanup(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2); await outfitIntegration(process.env);
    console.log('PASS: I11 both normal owners: save_outfit create/replay/conflict/edit/stale, bounds, atomicity, item states, soft delete, same-owner race, untouched wear rows, owned embed and item-deletion cascade');
  } catch {
    console.error('FAIL: I11 outfit RPC integration; private evidence withheld'); process.exitCode = 1;
  }
}
