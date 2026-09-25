import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { saveClients, saveHarness, intent, denied, eq } from './item-save.sessions.mjs';

// P6b restore: the restored checked Save keeps exported provenance kinds, starts revisions at 1 and only replays
// an unfinished restored save. Normal owner sessions only; no analysis, receipt or consent is involved.
let phase = 'arguments';

function restoredIntent() {
  const value = intent();
  Object.assign(value.p_item, { title: 'Fictional restored garment', colours: ['green'], material: 'Owner supplied' });
  value.p_item.field_provenance = {
    title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
    colours: { kind: 'ai_observed', revision: 1 }, material: { kind: 'ai_estimated', revision: 1 },
    brand: { kind: 'unknown', revision: 1 },
  };
  return value;
}

async function ownerCases(client, owner, other) {
  const h = saveHarness(client, owner);
  const peer = saveHarness(client, other);
  const reserve = (value, harness = h) => harness.call('reserve_restored_item_save', value);
  try {
    phase = 'restored-reserve-keeps-kinds';
    const profileBefore = await client.rows(owner, 'profiles');
    const value = h.track(restoredIntent());
    const first = await reserve(value);
    requireEvidence(first.ok && first.status === 200 && Array.isArray(first.data) && first.data.length === 1);
    const row = first.data[0];
    eq(row.state, 'reserved'); eq(row.item.owner_id, owner.uid); eq(row.item.version, 1);
    eq(row.item.field_provenance, value.p_item.field_provenance);
    eq(row.image.state, 'pending'); eq(row.image.item_id, value.p_item.id);
    eq(await h.read('items', value.p_item.id), [row.item]);

    phase = 'restored-reserve-replay';
    const replay = await reserve(value);
    requireEvidence(replay.ok);
    eq(replay.data[0], row);

    phase = 'other-owner-cannot-reserve-or-read';
    denied(await reserve(value, peer));
    eq(await client.request(other.token, '/rest/v1/rpc/restore_image_change_status',
      { method: 'POST', body: { p_item_id: value.p_item.id, p_request_id: randomUUID() } }).then((r) => r.data), null);
    eq(await h.read('items', value.p_item.id), [row.item]);

    phase = 'unknown-request-status';
    const missing = await h.call('restore_image_change_status', { p_item_id: value.p_item.id, p_request_id: randomUUID() });
    requireEvidence(missing.ok); eq(missing.data, null);

    phase = 'finalize-then-no-restored-replay';
    await h.upload(value);
    await h.finalize(value, row);
    eq((await h.read('item_images', value.p_image.id))[0].state, 'ready');
    denied(await reserve(value));
    eq((await h.read('items', value.p_item.id))[0].field_provenance, value.p_item.field_provenance);

    phase = 'invalid-provenance';
    for (const change of [
      (v) => { v.p_item.field_provenance.title = { kind: 'ai_estimated', revision: 1 }; },
      (v) => { v.p_item.field_provenance.material = { kind: 'ai_observed', revision: 1 }; },
      (v) => { v.p_item.brand = null; v.p_item.field_provenance.brand = { kind: 'ai_observed', revision: 1 }; },
      (v) => { v.p_item.colours = []; },
      (v) => { v.p_item.field_provenance.title = 'user'; },
    ]) {
      const bad = restoredIntent(); change(bad);
      denied(await reserve(bad), 'Invalid input');
      eq(await h.read('items', bad.p_item.id), []);
    }

    phase = 'ordinary-saved-item-not-replayed';
    const plain = h.track(intent());
    const saved = await h.reserve(plain);
    await h.upload(plain); await h.finalize(plain, saved);
    denied(await reserve(plain));

    phase = 'unchanged-profile';
    eq(await client.rows(owner, 'profiles'), profileBefore);
  } finally {
    const priorPhase = phase;
    phase = 'cleanup';
    await h.cleanup();
    phase = priorPhase;
  }
}

async function main() {
  try {
    phase = 'arguments';
    requireEvidence(process.argv.length === 2);
    phase = 'sign-in';
    const { client, owners } = await saveClients(process.env);
    await ownerCases(client, owners[0], owners[1]);
    await ownerCases(client, owners[1], owners[0]);
    console.log('PASS: restored checked Save integration; normal owners=2; kinds kept, replay only while unfinished');
  } catch {
    console.error(`FAIL: restored checked Save integration; phase=${phase}; normal-session evidence required; no private details logged`);
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
