import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { saveClients, eq } from '../integration/item-save.sessions.mjs';
import { outfitHarness } from '../integration/outfit-rpc.sessions.mjs';

const refused = (result) => requireEvidence(!result.ok && result.status < 500);

async function directionCases(client, owner, peer, h, p) {
  const own = await h.item(), mine = await h.create([own.id]);
  const foreignItem = await p.item(), theirs = await p.create([foreignItem.id], { p_title: 'Fictional peer outfit' });
  const snapshot = async () => ({ mine: await h.read(mine.p_id), theirs: await p.read(theirs.p_id) });
  const before = await snapshot();

  // Foreign items, alone or mixed, are invalid and create nothing.
  for (const itemIds of [[foreignItem.id], [own.id, foreignItem.id]]) {
    const body = h.args(randomUUID(), itemIds);
    h.rejected(await h.call(body), 'Invalid selection');
    eq((await h.read(body.p_id)).parent, []); eq((await p.read(body.p_id)).parent, []);
  }
  for (const itemIds of [[own.id, foreignItem.id], [own.id, randomUUID()]]) {
    h.rejected(await h.call({ ...mine, p_title: 'Foreign link attempt', p_item_ids: itemIds, p_expected_version: 1 }), 'Invalid selection');
  }
  // A foreign outfit ID is invisible: a create gets the normalized conflict (same as an own conflicting create), an edit conflicts.
  const collision = await h.call(h.args(theirs.p_id, [own.id]));
  requireEvidence(!collision.ok && collision.status === 400);
  eq(collision.data, { code: 'P0001', details: null, hint: null, message: 'Request conflict' });
  h.rejected(await h.call(h.args(theirs.p_id, [own.id], { p_expected_version: 1 })), 'Request conflict');
  eq(await snapshot(), before);

  // Direct REST writes cannot spoof ownership or cross accounts.
  for (const [table, body] of [
    ['outfits', { id: randomUUID(), owner_id: peer.uid, title: 'Spoofed owner' }],
    ['outfit_items', { owner_id: peer.uid, outfit_id: theirs.p_id, item_id: foreignItem.id, position: 5 }],
    ['outfit_items', { owner_id: owner.uid, outfit_id: mine.p_id, item_id: foreignItem.id, position: 5 }],
    ['outfit_items', { owner_id: owner.uid, outfit_id: theirs.p_id, item_id: own.id, position: 5 }],
  ]) refused(await client.request(owner.token, `/rest/v1/${table}`, { method: 'POST', body }));
  for (const table of ['outfits', 'outfit_items']) {
    const filter = table === 'outfits' ? `id=eq.${theirs.p_id}` : `outfit_id=eq.${theirs.p_id}`;
    const patch = await client.request(owner.token, `/rest/v1/${table}?${filter}`, {
      method: 'PATCH', body: table === 'outfits' ? { title: 'Foreign mutation' } : { position: 7 }, headers: { Prefer: 'return=representation' } });
    requireEvidence(patch.status < 500 && (!patch.ok || Array.isArray(patch.data) && patch.data.length === 0));
    const remove = await client.request(owner.token, `/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    requireEvidence(remove.status < 500 && (!remove.ok || Array.isArray(remove.data) && remove.data.length === 0));
  }
  refused(await client.request(owner.token, `/rest/v1/outfits?id=eq.${mine.p_id}`, { method: 'PATCH', body: { owner_id: peer.uid } }));
  refused(await client.request(owner.token, `/rest/v1/outfit_items?outfit_id=eq.${mine.p_id}`, { method: 'PATCH', body: { owner_id: peer.uid } }));
  eq(await snapshot(), before);

  // Reads, including the embedded projection, return nothing foreign.
  for (const route of [
    `/rest/v1/outfits?id=eq.${theirs.p_id}&select=*`,
    `/rest/v1/outfit_items?outfit_id=eq.${theirs.p_id}&select=*`,
    `/rest/v1/outfits?id=eq.${theirs.p_id}&select=id,outfit_items!outfit_items_owner_id_outfit_id_fkey(owner_id,item_id,position)`,
    `/rest/v1/outfits?owner_id=eq.${peer.uid}&select=id`,
  ]) {
    const result = await client.request(owner.token, route);
    requireEvidence(result.ok); eq(result.data, []);
  }

  // Anonymous callers can neither save nor write nor read.
  const anonymous = await h.call(h.args(randomUUID(), [own.id]), null);
  requireEvidence(!anonymous.ok && [401, 403].includes(anonymous.status) && anonymous.data?.code === '42501');
  refused(await client.request(null, '/rest/v1/outfits', { method: 'POST', body: { id: randomUUID(), owner_id: owner.uid, title: 'Anonymous' } }));
  for (const method of ['PATCH', 'DELETE']) {
    const result = await client.request(null, `/rest/v1/outfits?id=eq.${mine.p_id}`, {
      method, ...(method === 'PATCH' ? { body: { title: 'Anonymous mutation' } } : {}) });
    requireEvidence(result.status < 500 && (!result.ok || Array.isArray(result.data) && result.data.length === 0 || result.data === null));
  }
  const anonymousRead = await client.request(null, `/rest/v1/outfits?id=eq.${mine.p_id}&select=*`);
  requireEvidence(!anonymousRead.ok || Array.isArray(anonymousRead.data) && anonymousRead.data.length === 0);
  eq(await snapshot(), before);
}

export async function outfitSecurity(env) {
  const { client, owners } = await saveClients(env);
  const harnesses = owners.map((owner) => outfitHarness(client, owner));
  let failure = null;
  try {
    for (const index of [0, 1]) await directionCases(client, owners[index], owners[1 - index], harnesses[index], harnesses[1 - index]);
  } catch (error) { failure = error; }
  for (const h of harnesses) {
    try { await h.cleanup(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2); await outfitSecurity(process.env);
    console.log('PASS: I11 A->B and B->A: foreign items/outfits rejected via RPC, spoofed/foreign REST writes denied, foreign reads empty, anonymous refused; normal sessions only');
  } catch {
    console.error('FAIL: I11 outfit RPC security; private evidence withheld'); process.exitCode = 1;
  }
}
