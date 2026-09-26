import { createHash, randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { saveClients, eq } from './item-save.sessions.mjs';

// I15 Like / Not for me: the same upsert and delete the app sends, through normal owner sessions only.
const signatureOf = (ids) => createHash('sha256').update([...ids].sort().join('|')).digest('hex');
const columns = 'id,owner_id,item_ids,signature,vote';
// Names the table left different after cleanup; it carries no row content.
class ResidueError extends Error {
  constructor(table) { super(`residue in ${table}`); this.table = table; }
}

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
  // Don't pair these: the same idempotent insert and exact delete the app sends.
  const avoid = (low, high, token = owner.token, ownerId = owner.uid) => client.request(token,
    '/rest/v1/combination_rules?on_conflict=owner_id,item_low,item_high',
    { method: 'POST', body: { owner_id: ownerId, item_low: low, item_high: high }, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  const allow = (low, high, token = owner.token, ownerId = owner.uid) => client.request(token,
    `/rest/v1/combination_rules?owner_id=eq.${ownerId}&item_low=eq.${low}&item_high=eq.${high}`, { method: 'DELETE' });
  const pairs = async (token = owner.token) => {
    const result = await client.request(token, `/rest/v1/combination_rules?owner_id=eq.${owner.uid}&select=id,owner_id,item_low,item_high&order=id.asc&limit=500`);
    requireEvidence(result.ok && Array.isArray(result.data));
    return result.data;
  };
  // Every row of this owner in the tables these cases touch, as the other suites left them.
  const tables = ['suggestion_feedback', 'combination_rules', 'items'];
  const state = async () => {
    const result = {};
    for (const table of tables) {
      const rows = await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&select=*&order=id.asc&limit=1000`);
      requireEvidence(rows.ok && Array.isArray(rows.data) && rows.data.length < 1000);
      result[table] = rows.data;
    }
    return result;
  };
  let before = null;
  const snapshot = async () => { before = await state(); };
  // Removes only the rows these cases added, then requires every table to be exactly as it was; residue is named by table.
  const cleanup = async () => {
    requireEvidence(before !== null);
    for (const table of ['suggestion_feedback', 'combination_rules']) {
      const kept = new Set(before[table].map(row => row.id));
      for (const row of (await state())[table]) {
        if (kept.has(row.id)) continue;
        requireEvidence((await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&id=eq.${row.id}`, { method: 'DELETE' })).ok);
      }
    }
    for (const id of items) requireEvidence((await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
    const after = await state();
    for (const table of tables) {
      if (JSON.stringify(after[table]) !== JSON.stringify(before[table])) throw new ResidueError(table);
    }
  };
  return { item, vote, clear, read, avoid, allow, pairs, snapshot, cleanup };
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
  await pairCases(client, owner, other, h, peer, ids);
}

async function pairCases(client, owner, other, h, peer, ids) {
  const peerBefore = await peer.pairs();
  const [low, high] = [ids[0], ids[2]].sort();
  const avoided = await h.avoid(low, high);
  requireEvidence(avoided.ok && avoided.status === 201);
  const rows = await h.pairs();
  eq(rows.length, 1);
  eq(rows[0].owner_id, owner.uid); eq(rows[0].item_low, low); eq(rows[0].item_high, high);

  // Avoiding the same pair again keeps the one row.
  requireEvidence((await h.avoid(low, high)).ok);
  eq(await h.pairs(), rows);
  // The server keeps the lower ID first and two different items.
  for (const [first, second] of [[high, low], [low, low]]) requireEvidence(!(await h.avoid(first, second)).ok);

  // Another account cannot read or remove the pair, nor store one with this owner's items or ID.
  eq((await client.request(other.token, `/rest/v1/combination_rules?owner_id=eq.${owner.uid}&select=id`)).data, []);
  requireEvidence((await h.allow(low, high, other.token)).ok);
  requireEvidence((await h.allow(low, high, other.token, other.uid)).ok);
  eq(await h.pairs(), rows);
  requireEvidence(!(await h.avoid(low, high, other.token, other.uid)).ok);
  requireEvidence(!(await h.avoid(low, high, other.token, owner.uid)).ok);
  eq(await peer.pairs(), peerBefore);

  // Removing it deletes exactly that pair, and removing it again changes nothing.
  const [secondLow, secondHigh] = [ids[0], ids[1]].sort();
  requireEvidence((await h.avoid(secondLow, secondHigh)).ok);
  requireEvidence((await h.allow(low, high)).ok);
  const left = await h.pairs();
  eq(left.length, 1); eq(left[0].item_low, secondLow); eq(left[0].item_high, secondHigh);
  requireEvidence((await h.allow(low, high)).ok);
  eq(await h.pairs(), left);
  requireEvidence((await h.allow(secondLow, secondHigh)).ok);
  eq(await h.pairs(), []);
}

export async function feedbackIntegration(env) {
  const { client: normal, owners } = await saveClients(env);
  const harnesses = owners.map((owner) => feedbackHarness(normal, owner));
  let failure = null;
  try {
    for (const h of harnesses) await h.snapshot();
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
    console.log('PASS: I15 both normal owners: feedback upsert by derived signature, order-independent update, undo, owner isolation and server bounds; avoided pairs insert, duplicate, remove and owner isolation; both owners restored to their snapshot');
  } catch (error) {
    const residue = error instanceof ResidueError ? `; residue in ${error.table}` : '';
    console.error(`FAIL: I15 suggestion feedback integration${residue}; private evidence withheld`); process.exitCode = 1;
  }
}
