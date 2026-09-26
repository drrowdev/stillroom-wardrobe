import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { saveClients, eq } from '../integration/item-save.sessions.mjs';
import { wearHarness } from '../integration/wear-rpc.sessions.mjs';
import { buildStatistics, costTable, wearSummaries } from '../../src/domain/statistics.ts';

// I13 statistics read only the signed-in owner's own wear rows, through each owner's normal session. There is no
// administrator or global aggregate: the same filtered read the app uses, with RLS alone and with a foreign owner or
// item filter, never returns another account's rows. Fictional photo-less fixtures are created and removed by their owner.
const localToday = (timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const shift = (iso, days) => { const value = new Date(`${iso}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const projection = 'id,owner_id,item_id,event_id,event:wear_events!wear_event_items_owner_id_event_id_fkey!inner(id,owner_id,local_date,state,deleted_at)';

// The app's wear-history read (src/data/wear-history.ts), optionally narrowed to one item as on the item page.
async function wornLinks(client, token, filterOwner, only) {
  const query = new URLSearchParams({ select: projection, owner_id: `eq.${filterOwner}`, 'event.owner_id': `eq.${filterOwner}`,
    'event.state': 'eq.worn', 'event.deleted_at': 'is.null', item_id: 'not.is.null', order: 'id.asc', limit: '500' });
  if (only) query.append('item_id', `eq.${only}`);
  const result = await client.request(token, `/rest/v1/wear_event_items?${query}`);
  requireEvidence(result.ok && Array.isArray(result.data) && result.data.length < 500);
  return result.data;
}
// RLS alone, with no owner filter at all.
async function unfiltered(client, token) {
  const result = await client.request(token, `/rest/v1/wear_event_items?select=${projection}&limit=500`);
  requireEvidence(result.ok && Array.isArray(result.data) && result.data.length < 500);
  return result.data;
}
const days = (rows) => rows.map((row) => ({ itemId: row.item_id, localDate: row.event.local_date, state: row.event.state, deleted: row.event.deleted_at !== null }));

async function fixtures(h, prefix) {
  const today = localToday('Europe/Helsinki'), yesterday = shift(today, -1);
  const coat = await h.item({ title: `${prefix} coat`, category: 'outerwear', purchase_price: 90, currency: 'EUR' });
  const shirt = await h.item({ title: `${prefix} shirt`, purchase_price: 40, currency: 'USD' });
  const scarf = await h.item({ title: `${prefix} scarf`, category: 'accessory' });
  // Two looks with the coat on one day count once; a plan and a removed look never count.
  await h.create([coat.id, shirt.id], { p_local_date: yesterday, p_state: 'worn' });
  await h.create([coat.id], { p_local_date: yesterday, p_state: 'worn', p_label: 'Second look' });
  await h.create([coat.id], { p_local_date: today, p_state: 'worn' });
  await h.create([scarf.id], { p_local_date: today });
  const removed = await h.create([scarf.id], { p_local_date: today, p_state: 'worn', p_label: 'Removed' });
  const patch = await h.setRemoved(removed.p_id, 1, true);
  requireEvidence(patch.ok && patch.data.length === 1);
  return { coat, shirt, scarf, today, yesterday };
}

async function ownerCases(client, owner, other, mine, theirs, passed) {
  const ids = [mine.coat.id, mine.shirt.id, mine.scarf.id];
  const foreignIds = new Set([theirs.coat.id, theirs.shirt.id, theirs.scarf.id]);
  const own = await wornLinks(client, owner.token, owner.uid);
  requireEvidence(own.every((row) => row.owner_id === owner.uid && row.event.owner_id === owner.uid && !foreignIds.has(row.item_id)));
  const stats = buildStatistics(ids.map((id, n) => ({ id, title: String(n), lifecycle: 'active',
    purchasePrice: ['90.00', '40.00', null][n], currency: ['EUR', 'USD', 'EUR'][n] })),
  wearSummaries(ids, days(own)));
  const byId = new Map(stats.items.map((row) => [row.id, row]));
  eq([byId.get(mine.coat.id).count, byId.get(mine.coat.id).lastWorn], [2, mine.today]);
  eq([byId.get(mine.shirt.id).count, byId.get(mine.shirt.id).lastWorn], [1, mine.yesterday]);
  eq([byId.get(mine.scarf.id).count, byId.get(mine.scarf.id).lastWorn], [0, null]);
  eq(costTable(stats, 'EUR').map((row) => [row.id, row.costPerWear]), [[mine.coat.id, 45]]);
  eq(costTable(stats, 'USD').map((row) => [row.id, row.costPerWear]), [[mine.shirt.id, 40]]);
  passed.push('own distinct-day counts and per-currency cost');

  // RLS alone returns only the signed-in owner's rows, and the same rows as the owner-filtered read.
  const bare = await unfiltered(client, owner.token);
  requireEvidence(bare.every((row) => row.owner_id === owner.uid && row.event.owner_id === owner.uid));
  eq(new Set(bare.filter((row) => row.item_id !== null && row.event.state === 'worn' && row.event.deleted_at === null).map((row) => row.id)),
    new Set(own.map((row) => row.id)));
  passed.push('RLS alone returns own rows only');

  // Filtering by the other account, or by one of its items, returns nothing.
  eq(await wornLinks(client, owner.token, other.uid), []);
  for (const id of foreignIds) eq(await wornLinks(client, owner.token, owner.uid, id), []);
  const item = await wornLinks(client, owner.token, owner.uid, mine.coat.id);
  requireEvidence(item.length === 3 && item.every((row) => row.item_id === mine.coat.id));
  eq(wearSummaries([mine.coat.id], days(item)).get(mine.coat.id), { count: byId.get(mine.coat.id).count, lastWorn: byId.get(mine.coat.id).lastWorn });
  passed.push('foreign owner and item filters return nothing; the item page agrees');
}

export async function statisticsSessions(env, passed = []) {
  const { client, owners } = await saveClients(env);
  requireEvidence(owners.length === 2 && owners[0].uid !== owners[1].uid);
  const harnesses = owners.map((owner) => wearHarness(client, owner));
  let failure = null;
  try {
    const sets = [await fixtures(harnesses[0], 'Owner A'), await fixtures(harnesses[1], 'Owner B')];
    await ownerCases(client, owners[0], owners[1], sets[0], sets[1], passed);
    await ownerCases(client, owners[1], owners[0], sets[1], sets[0], passed);
  } catch (error) { failure = error; }
  for (const h of harnesses) {
    try { await h.cleanup(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  requireEvidence(passed.length === 2 * statisticsCases && passed.slice(0, statisticsCases).every((name, index) => passed[statisticsCases + index] === name));
  return passed;
}
export const statisticsCases = 3;

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2);
    const passed = await statisticsSessions(process.env);
    console.log(`PASS: I13 statistics, ${statisticsCases} cases for each of 2 normal owners (${passed.length} runs): ${passed.slice(0, statisticsCases).join('; ')}`);
  } catch {
    console.error('FAIL: I13 statistics isolation; private evidence withheld'); process.exitCode = 1;
  }
}
