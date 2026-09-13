import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { bytes, saveClients, denied, eq } from '../integration/item-save.sessions.mjs';
import { lifecycleHarness } from '../integration/item-lifecycle.sessions.mjs';

async function main() {
  const harnesses = [];
  let phase = 'arguments';
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await saveClients(process.env);
    harnesses.push(...owners.map((owner) => lifecycleHarness(client, owner)));
    for (const [index, owner] of owners.entries()) {
      const h = harnesses[index], peer = harnesses[1 - index];
      const own = await h.create(), foreign = await peer.create();
      await h.trash(own, 1); await peer.trash(foreign, 1);
      const ownPreview = await h.status(own), foreignPreview = await peer.status(foreign);
      const peerArgs = peer.beginArgs(foreign, foreignPreview);
      await peer.begin(peerArgs);
      const foreignBefore = await peer.snapshot(foreign);
      phase = 'foreign-and-absent';
      const status = await h.call('item_deletion_status', { p_item_ids: [own.p_item.id, foreign.p_item.id, randomUUID()] });
      requireEvidence(status.ok); eq(status.data, [ownPreview]);
      for (const target of [foreign.p_item.id, randomUUID()]) {
        denied(await h.call('set_item_trashed', { p_item_id: target, p_expected_version: 2, p_trashed: false }));
        denied(await h.call('begin_item_deletion', { ...peerArgs, p_item_id: target }));
        eq(await h.finish({ p_item: { id: target } }, peerArgs.p_request_id), 'absent');
      }
      for (const method of ['PATCH', 'DELETE']) {
        const response = await client.request(owner.token, `/rest/v1/items?id=eq.${foreign.p_item.id}`,
          { method, ...(method === 'PATCH' ? { body: { deleted_at: null } } : {}), headers: { Prefer: 'return=representation' } });
        requireEvidence(response.ok); eq(response.data, []);
      }
      phase = 'closed-inputs';
      for (const ids of [null, [], [null], [own.p_item.id, own.p_item.id], Array.from({ length: 41 }, () => randomUUID()), [[own.p_item.id]]]) {
        denied(await h.call('item_deletion_status', { p_item_ids: ids }), 'Invalid input');
      }
      for (const version of [null, 0, -1, 9007199254740991]) {
        denied(await h.call('set_item_trashed', { p_item_id: own.p_item.id, p_expected_version: version, p_trashed: false }), 'Invalid input');
        denied(await h.call('begin_item_deletion', { ...h.beginArgs(own, ownPreview), p_expected_version: version }), 'Invalid input');
      }
      denied(await h.call('set_item_trashed', { p_item_id: own.p_item.id, p_expected_version: ownPreview.version, p_trashed: null }), 'Invalid input');
      for (const manifest of [null, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
        denied(await h.call('begin_item_deletion', { ...h.beginArgs(own, ownPreview), p_image_manifest_sha256: manifest }), 'Invalid input');
      }
      denied(await h.call('begin_item_deletion', { ...h.beginArgs(own, ownPreview), p_request_id: null }), 'Invalid input');
      denied(await h.call('finish_item_deletion', { p_item_id: own.p_item.id, p_request_id: null }), 'Invalid input');
      phase = 'owner-local-nonce';
      // The peer's nonce is not globally looked up; the same UUID can be used by this owner.
      const args = h.beginArgs(own, ownPreview, peerArgs.p_request_id);
      const claim = await h.begin(args);
      eq(claim.request_id, peerArgs.p_request_id);
      const second = await h.create(); await h.trash(second, 1);
      const secondBefore = await h.snapshot(second);
      denied(await h.call('begin_item_deletion', h.beginArgs(second, secondBefore.status, args.p_request_id)));
      await h.unchanged(second, secondBefore);
      phase = 'private-surfaces';
      for (const token of [owner.token, null]) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          const response = await client.request(token, '/rest/v1/item_deletion_claims', {
            method, ...(method === 'POST' || method === 'PATCH' ? { body: {} } : {}),
            headers: { 'Accept-Profile': 'private', 'Content-Profile': 'private' },
          });
          requireEvidence(!response.ok && response.status === 406 && response.data.code === 'PGRST106');
        }
        for (const name of ['item_lifecycle_owner', 'item_lifecycle_manifest', 'guard_item_deletion', 'guard_item_image_deletion', 'may_create_item_object']) {
          const response = await client.request(token, `/rest/v1/rpc/${name}`,
            { method: 'POST', body: {}, headers: { 'Content-Profile': 'private' } });
          requireEvidence(!response.ok && response.status === 406);
        }
      }
      phase = 'storage-owner-reservation';
      const unreserved = `${owner.uid}/${own.p_item.id}/${randomUUID()}/main.jpg`;
      for (const path of [peer.paths(foreign)[0], unreserved, 'not/a/uuid/main.jpg']) {
        const response = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`,
          { method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false' } });
        requireEvidence(!response.ok);
      }
      const read = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${peer.paths(foreign)[0]}`);
      requireEvidence(!read.ok);
      const remove = await client.request(owner.token, '/storage/v1/object/wardrobe', {
        method: 'DELETE', body: { prefixes: peer.paths(foreign) },
      });
      requireEvidence(remove.ok && Array.isArray(remove.data)); eq(remove.data, []);
      await peer.unchanged(foreign, foreignBefore);
      for (const path of peer.paths(foreign)) await peer.download(path);
      phase = 'normal-completion';
      await h.remove(own); eq(await h.finish(own, args.p_request_id), 'completed');
      await peer.unchanged(foreign, foreignBefore);
    }
    phase = 'anonymous';
    for (const [name, body] of [
      ['set_item_trashed', { p_item_id: randomUUID(), p_expected_version: 1, p_trashed: true }],
      ['item_deletion_status', { p_item_ids: [randomUUID()] }],
      ['begin_item_deletion', { p_item_id: randomUUID(), p_expected_version: 1, p_request_id: randomUUID(), p_image_manifest_sha256: 'a'.repeat(64) }],
      ['finish_item_deletion', { p_item_id: randomUUID(), p_request_id: randomUUID() }],
    ]) {
      const response = await client.request(null, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      requireEvidence(!response.ok && response.status === 401 && response.data.code === '42501');
    }
    console.log('PASS: I08 ordinary-owner security; owners=2 anonymous=1; closed inputs, private406, owner-local nonce and foreign rows/bytes preserved');
  } catch {
    console.error(`FAIL: I08 security ${phase}; evidence required; private details suppressed`);
    process.exitCode = 1;
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: I08 exact security cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
