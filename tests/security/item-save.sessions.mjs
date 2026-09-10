import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { intent, saveClients, saveHarness, denied, eq, boundedRace } from '../integration/item-save.sessions.mjs';

async function main() {
  const harnesses = [];
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await saveClients(process.env);
    harnesses.push(...owners.map((owner) => saveHarness(client, owner)));
    for (const [index, owner] of owners.entries()) {
      const h = harnesses[index], peer = harnesses[1 - index];
      const foreign = peer.track(), foreignRow = await peer.reserve(foreign);
      const own = h.track(), ownRow = await h.reserve(own);
      for (const body of [
        foreign, { p_item: own.p_item, p_image: foreign.p_image },
        { p_item: foreign.p_item, p_image: own.p_image },
      ]) {
        denied(await h.call('reserve_item_save', body));
        eq(await peer.reserve(foreign), foreignRow);
      }
      // A global public image collision rolls back the new owned item and its marker.
      const collision = h.track();
      collision.p_image.id = foreign.p_image.id;
      denied(await h.call('reserve_item_save', collision));
      eq(await h.read('items', collision.p_item.id), []);
      eq(await h.read('item_images', collision.p_image.id), []);
      for (const body of [
        peer.finalizeArgs(foreign, foreignRow),
        { ...h.finalizeArgs(own, ownRow), p_image_id: foreign.p_image.id },
        { ...h.finalizeArgs(own, ownRow), p_item_id: foreign.p_item.id },
        { ...h.finalizeArgs(own, ownRow), p_fingerprint: foreignRow.fingerprint },
      ]) denied(await h.call('finalize_item_save', body));
      for (const bad of [
        null, [], {}, { ...intent(), extra: true },
      ]) {
        const response = await h.call('reserve_item_save', { p_item: bad, p_image: intent().p_image });
        denied(response, 'Invalid input');
      }
      for (const [target, key, value] of [
        ['p_item', 'owner_id', owner.uid], ['p_item', 'version', 1], ['p_item', 'deleted_at', null],
        ['p_item', 'created_at', '2026-01-01T00:00:00Z'], ['p_item', 'unknown', null],
        ['p_item', 'purchase_price', '1.00'], ['p_item', 'warmth', 1.5], ['p_item', 'windproof', 'false'],
        ['p_item', 'tags', [null]], ['p_item', 'notes', {}], ['p_item', 'title', ''],
        ['p_item', 'colours', null], ['p_item', 'field_provenance', []],
        ['p_image', 'owner_id', owner.uid], ['p_image', 'item_id', own.p_item.id],
        ['p_image', 'state', 'ready'], ['p_image', 'description_version', 1], ['p_image', 'main_path', 'untrusted'],
        ['p_image', 'completed_at', '2026-01-01T00:00:00Z'], ['p_image', 'width', '2'],
        ['p_image', 'alt_text', null], ['p_image', 'main_bytes', 512001],
      ]) {
        const valueToSave = h.track(), bad = structuredClone(valueToSave);
        bad[target][key] = value;
        denied(await h.call('reserve_item_save', bad), 'Invalid input');
        eq(await h.read('items', valueToSave.p_item.id), []);
        eq(await h.read('item_images', valueToSave.p_image.id), []);
      }
      for (const assertion of [
        { kind: 'ai_observed', revision: 1 }, { kind: 'ai_estimated', revision: 1 },
        { kind: 'unknown', revision: 1 }, { kind: 'user', revision: 0 }, { kind: 'user', revision: 2 },
        { kind: 'user', revision: 1, image_id: own.p_image.id }, { kind: 'user', revision: '1' },
      ]) {
        const bad = h.track(); bad.p_item.field_provenance.title = assertion;
        denied(await h.call('reserve_item_save', bad), 'Invalid input');
        eq(await h.read('items', bad.p_item.id), []);
      }
      for (const table of ['item_save_used_ids', 'item_save_attempts']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          const response = await client.request(owner.token, `/rest/v1/${table}`,
            { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
              headers: { 'Accept-Profile': 'private', 'Content-Profile': 'private' } });
          requireEvidence(!response.ok && response.status === 406 && response.data.code === 'PGRST106');
        }
      }
      for (const name of ['commit_item_save_image', 'item_save_current', 'item_save_owner', 'item_save_fingerprint']) {
        const result = await client.request(owner.token, `/rest/v1/rpc/${name}`,
          { method: 'POST', body: {}, headers: { 'Content-Profile': 'private' } });
        requireEvidence(!result.ok && result.status === 406);
      }

      // Old raw API remains valid for genuinely legacy IDs, never for either used identity.
      const original = h.track(); await h.reserve(original);
      const alternate = h.track({ p_item: original.p_item, p_image: { ...original.p_image, id: randomUUID() } });
      await client.insert(owner, 'item_images', { ...alternate.p_image, item_id: original.p_item.id });
      await h.upload(alternate);
      denied(await h.call('commit_image', { p_image_id: alternate.p_image.id }));
      await h.deleteItem(original);
      const recreated = [
        h.track({ p_item: original.p_item, p_image: { ...original.p_image, id: randomUUID() } }),
        h.track({ p_item: { ...original.p_item, id: randomUUID() }, p_image: original.p_image }),
      ];
      for (const raw of recreated) {
        await client.insert(owner, 'items', raw.p_item);
        await client.insert(owner, 'item_images', { ...raw.p_image, item_id: raw.p_item.id });
        await h.upload(raw);
        denied(await h.call('commit_image', { p_image_id: raw.p_image.id }));
        denied(await h.call('reserve_item_save', raw));
        eq((await h.read('item_images', raw.p_image.id))[0].state, 'pending');
      }
      const legacy = h.track();
      await client.insert(owner, 'items', legacy.p_item);
      await client.insert(owner, 'item_images', { ...legacy.p_image, item_id: legacy.p_item.id });
      denied(await h.call('reserve_item_save', legacy));
      await h.upload(legacy);
      requireEvidence((await h.call('commit_image', { p_image_id: legacy.p_image.id })).ok);
      eq((await h.read('item_images', legacy.p_image.id))[0].state, 'ready');
      await h.remove(legacy); await h.deleteItem(legacy);
      // Rejected legacy adoption left no used-ID marker, so this is a genuine first claim.
      await h.reserve(legacy);

      // Owner-local UUID reuse once public rows disappear: no peer marker lookup/adoption.
      const deleted = peer.track(); await peer.reserve(deleted); await peer.deleteItem(deleted);
      const reuse = h.track(structuredClone(deleted)); const reused = await h.reserve(reuse);
      eq(reused.item.owner_id, owner.uid); eq(reused.image.owner_id, owner.uid);
      await h.upload(reuse); await h.finalize(reuse, reused);
      denied(await peer.call('reserve_item_save', deleted));
      await peer.deleteItem(foreign);
      await h.reserve(collision);
      const race = h.track(), raceRow = await h.reserve(race); await h.upload(race);
      const results = await boundedRace([
        () => h.call('commit_image', { p_image_id: race.p_image.id }),
        () => h.call('finalize_item_save', h.finalizeArgs(race, raceRow)),
      ]);
      requireEvidence(!results[0].ok);
      if (results[1].ok) eq((await h.reserve(race)).state, 'completed');
      else eq((await h.reserve(race)).state, 'reserved');
      await h.finalize(race, raceRow);
    }
    for (const [name, body] of [
      ['reserve_item_save', intent()], ['finalize_item_save', { p_item_id: randomUUID(), p_image_id: randomUUID(), p_fingerprint: 'a'.repeat(64) }],
      ['commit_image', { p_image_id: randomUUID() }],
    ]) {
      const result = await client.request(null, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      requireEvidence(!result.ok && result.status === 401 && result.data.code === '42501');
    }
    console.log('PASS: checked manual Save security; normal owners=2 anonymous=1; closed inputs, no adoption, raw bypass and owner-local guards');
  } catch {
    console.error('FAIL: checked manual Save security; normal-session evidence required; no private details logged');
    process.exitCode = 1;
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: checked Save fixture cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
