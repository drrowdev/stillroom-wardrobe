import { createHash, randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { saveClients, eq } from './item-save.sessions.mjs';

// I15 Like / Not for me: the same upsert and delete the app sends, through normal owner sessions only.
const signatureOf = (ids) => createHash('sha256').update([...ids].sort().join('|')).digest('hex');
const columns = 'id,owner_id,item_ids,signature,vote';

function feedbackHarness(client, owner) {
  const items = [];
  const item = async (category) => {
    const row = await client.insert(owner, 'items', { id: randomUUID(), title: 'Fictional suggestion garment', category });
    items.push(row.id);
    return row.id;
  };
  const vote = (itemIds, value, token = owner.token, ownerId = owner.uid) => client.request(token,
    '/rest/v1/suggestion_feedback?on_conflict=owner_id,signature',
    { method: 'POST', body: { owner_id: ownerId, item_ids: itemIds, vote: value }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  const clear = (itemIds, token = owner.token, ownerId = owner.uid) => client.request(token,
    `/rest/v1/suggestion_feedback?owner_id=eq.${ownerId}&signature=eq.${signatureOf(itemIds)}`, { method: 'DELETE' });
  const read = async (token = owner.token) => {
    const result = await client.request(token, `/rest/v1/suggestion_feedback?owner_id=eq.${owner.uid}&select=${columns}&order=id.asc&limit=500`);
    requireEvidence(result.ok && Array.isArray(result.data));
    return result.data;
  };
  const cleanup = async () => {
    requireEvidence((await client.request(owner.token, `/rest/v1/suggestion_feedback?owner_id=eq.${owner.uid}`, { method: 'DELETE' })).ok);
    for (const id of items) requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    eq(await read(), []);
  };
  return { item, vote, clear, read, cleanup };
}

async function ownerCases(client, owner, other, h, peer) {
  const peerBefore = await peer.read();
  const ids = [await h.item('top'), await h.item('bottom'), await h.item('footwear')];
  const reversed = [...ids].reverse();

  const liked = await h.vote(reversed, 1);
  requireEvidence(liked.ok && liked.status === 201);
  let rows = await h.read();
  eq(rows.length, 1);
  eq(rows[0].owner_id, owner.uid); eq(rows[0].item_ids, [...ids].sort()); eq(rows[0].signature, signatureOf(ids)); eq(rows[0].vote, 1);

  // Voting again on the same combination in any order updates the one row.
  const hidden = await h.vote(ids, -1);
  requireEvidence(hidden.ok);
  const after = await h.read();
  eq(after.length, 1); eq(after[0].id, rows[0].id); eq(after[0].vote, -1);

  // Another account cannot read, change or clear it, nor vote with this owner's items or ID.
  eq((await client.request(other.token, `/rest/v1/suggestion_feedback?owner_id=eq.${owner.uid}&select=${columns}`)).data, []);
  requireEvidence((await h.clear(ids, other.token)).ok);
  eq(await h.read(), after);
  const foreign = await h.vote(ids, 1, other.token, other.uid);
  requireEvidence(!foreign.ok && foreign.status === 400 && foreign.data?.code === 'P0001');
  const spoofed = await h.vote(ids, 1, other.token, owner.uid);
  requireEvidence(!spoofed.ok);
  eq(await h.read(), after);
  eq(await peer.read(), peerBefore);

  // Undo removes exactly that combination.
  const pair = [ids[0], ids[1]];
  requireEvidence((await h.vote(pair, 1)).ok);
  eq((await h.read()).length, 2);
  requireEvidence((await h.clear(reversed)).ok);
  rows = await h.read();
  eq(rows.length, 1); eq(rows[0].item_ids, [...pair].sort()); eq(rows[0].vote, 1);

  // Bounds are enforced by the server, not only by the app.
  for (const bad of [[], [ids[0], ids[0]], [randomUUID()]]) {
    const result = await h.vote(bad, 1);
    requireEvidence(!result.ok && result.status === 400);
  }
  const badVote = await h.vote(ids, 2);
  requireEvidence(!badVote.ok && badVote.status === 400);
  eq((await h.read()).length, 1);
}

export async function feedbackIntegration(env) {
  const { client: normal, owners } = await saveClients(env);
  const harnesses = owners.map((owner) => feedbackHarness(normal, owner));
  let failure = null;
  try {
    await ownerCases(normal, owners[0], owners[1], harnesses[0], harnesses[1]);
    await ownerCases(normal, owners[1], owners[0], harnesses[1], harnesses[0]);
  } catch (error) { failure = error; }
  for (const h of harnesses) {
    try { await h.cleanup(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2); await feedbackIntegration(process.env);
    console.log('PASS: I15 both normal owners: feedback upsert by derived signature, order-independent update, undo, owner isolation and server bounds');
  } catch {
    console.error('FAIL: I15 suggestion feedback integration; private evidence withheld'); process.exitCode = 1;
  }
}
