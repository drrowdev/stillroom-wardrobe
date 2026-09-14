import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { bytes, intent, saveClients, denied, eq } from '../integration/item-save.sessions.mjs';
import { deleteWardrobeObject } from '../../src/data/storage-delete.ts';
import { lifecycleHarness, legacyOrphanCase } from '../integration/item-lifecycle.sessions.mjs';

const alternateCases = ['alternate-put', 'alternate-copy', 'alternate-move', 'alternate-sign-upload', 'alternate-tus'];
const securityCases = ['setup', 'bulk-plain', 'bulk-spoofed', ...alternateCases, 'pending-roundtrip', 'claim-setup'];
const directStages = ['bulk-request', 'alternate-request', 'pending-absence'];
const opaqueStages = ['track-pending', 'reserve-pending', 'catalog', 'download-owned', 'prepare-alternates',
  'upload-pending', 'remove-pending', 'reupload-pending', 'trash-own', 'trash-peer', 'status-own', 'status-peer',
  'begin-args', 'begin-peer', 'snapshot-peer'];
export function securityObservation(ownerOrdinal) {
  requireEvidence(ownerOrdinal === 1 || ownerOrdinal === 2);
  return { schemaVersion: 1, ownerOrdinal, case: null, stage: null, status: null, ok: null };
}
export function serializeSecurityObservation(observation) {
  const keys = Object.keys(securityObservation(1)), output = {};
  requireEvidence(observation !== null && typeof observation === 'object' && !Array.isArray(observation));
  const ownKeys = Reflect.ownKeys(observation);
  requireEvidence(ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(observation, key);
    requireEvidence(descriptor && Object.hasOwn(descriptor, 'value'));
    output[key] = descriptor.value;
  }
  requireEvidence(output.schemaVersion === 1 && [1, 2].includes(output.ownerOrdinal));
  requireEvidence(output.case === null || securityCases.includes(output.case));
  requireEvidence(output.stage === null || directStages.includes(output.stage) || opaqueStages.includes(output.stage));
  requireEvidence(output.status === null || (Number.isInteger(output.status) && output.status >= 100 && output.status <= 599));
  requireEvidence(output.ok === null || typeof output.ok === 'boolean');
  requireEvidence((output.status === null) === (output.ok === null));
  if (!directStages.includes(output.stage)) requireEvidence(output.status === null && output.ok === null);
  const serialized = JSON.stringify(output);
  requireEvidence(typeof serialized === 'string' && !/[\r\n]/.test(serialized) && Buffer.byteLength(serialized, 'utf8') <= 512);
  eq(JSON.parse(serialized), output);
  return serialized;
}

async function main() {
  const harnesses = [];
  let phase = 'arguments';
  let observation = null;
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await saveClients(process.env);
    harnesses.push(...owners.map((owner) => lifecycleHarness(client, owner)));
    for (const [index, owner] of owners.entries()) {
      const h = harnesses[index], peer = harnesses[1 - index];
      phase = 'legacy-orphan-privacy';
      await legacyOrphanCase(client, owner, owners[1 - index], h);
      const own = await h.create(), foreign = await peer.create();
      phase = 'native-operation-boundary';
      observation = null;
      observation = securityObservation(index + 1);
      Object.assign(observation, { case: 'setup', stage: 'track-pending', status: null, ok: null });
      const pending = h.track(intent());
      Object.assign(observation, { case: 'setup', stage: 'reserve-pending', status: null, ok: null });
      await h.reserve(pending);
      const catalog = async () => {
        const result = await client.request(owner.token, '/storage/v1/object/list/wardrobe', {
          method: 'POST', body: { prefix: `${owner.uid}/${own.p_item.id}/${own.p_image.id}/`, limit: 10, offset: 0 },
        });
        requireEvidence(result.ok && Array.isArray(result.data) && result.data.length === 2);
        return result.data.map(({ id, name, metadata }) => ({ id, name, metadata })).sort((a, b) => a.name.localeCompare(b.name));
      };
      Object.assign(observation, { case: 'setup', stage: 'catalog', status: null, ok: null });
      const originalCatalog = await catalog();
      for (const [bulkIndex, headers] of [{}, { 'storage.operation': 'storage.object.delete',
        'x-storage-operation': 'storage.object.delete', 'x-http-method-override': 'DELETE' }].entries()) {
        const caseName = ['bulk-plain', 'bulk-spoofed'][bulkIndex];
        Object.assign(observation, { case: caseName, stage: 'bulk-request', status: null, ok: null });
        const bulk = await client.request(owner.token, '/storage/v1/object/wardrobe',
          { method: 'DELETE', body: { prefixes: h.paths(own) }, headers });
        requireEvidence(Number.isInteger(bulk.status) && bulk.status >= 100 && bulk.status <= 599 && typeof bulk.ok === 'boolean');
        Object.assign(observation, { status: bulk.status, ok: bulk.ok });
        requireEvidence(bulk.status < 500);
        if (bulk.ok) eq(bulk.data, []);
        Object.assign(observation, { case: caseName, stage: 'download-owned', status: null, ok: null });
        for (const path of h.paths(own)) {
          Object.assign(observation, { case: caseName, stage: 'download-owned', status: null, ok: null });
          await h.download(path);
        }
        Object.assign(observation, { case: caseName, stage: 'catalog', status: null, ok: null });
        eq(await catalog(), originalCatalog);
      }
      Object.assign(observation, { case: 'setup', stage: 'prepare-alternates', status: null, ok: null });
      const alternates = [
        [`/storage/v1/object/wardrobe/${h.paths(pending)[0]}`, { method: 'PUT', body: bytes, binary: true }],
        ['/storage/v1/object/copy', { method: 'POST', body: {
          bucketId: 'wardrobe', sourceKey: h.paths(own)[0], destinationKey: h.paths(pending)[0],
        } }],
        ['/storage/v1/object/move', { method: 'POST', body: {
          bucketId: 'wardrobe', sourceKey: h.paths(own)[0], destinationKey: h.paths(pending)[0],
        } }],
        [`/storage/v1/object/upload/sign/wardrobe/${h.paths(pending)[0]}`, { method: 'POST', body: {} }],
        ['/storage/v1/upload/resumable', { method: 'POST', body: bytes, binary: true, headers: {
          'Tus-Resumable': '1.0.0', 'Upload-Length': '4', 'Content-Type': 'application/offset+octet-stream',
          'Upload-Metadata': `bucketName ${Buffer.from('wardrobe').toString('base64')},objectName ${Buffer.from(h.paths(pending)[0]).toString('base64')},contentType ${Buffer.from('image/jpeg').toString('base64')}`,
        } }],
      ];
      requireEvidence(alternates.length === 5 && alternateCases.length === 5);
      for (const [alternateIndex, [route, options]] of alternates.entries()) {
        const caseName = alternateCases[alternateIndex];
        Object.assign(observation, { case: caseName, stage: 'alternate-request', status: null, ok: null });
        const response = await client.request(owner.token, route, { ...options, headers: {
          ...options.headers, 'storage.operation': 'storage.object.upload', 'x-storage-operation': 'storage.object.upload',
        } });
        requireEvidence(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && typeof response.ok === 'boolean');
        Object.assign(observation, { status: response.status, ok: response.ok });
        requireEvidence(!response.ok && response.status < 500);
        Object.assign(observation, { case: caseName, stage: 'download-owned', status: null, ok: null });
        for (const path of h.paths(own)) {
          Object.assign(observation, { case: caseName, stage: 'download-owned', status: null, ok: null });
          await h.download(path);
        }
        Object.assign(observation, { case: caseName, stage: 'catalog', status: null, ok: null });
        eq(await catalog(), originalCatalog);
        Object.assign(observation, { case: caseName, stage: 'pending-absence', status: null, ok: null });
        const absent = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${h.paths(pending)[0]}`);
        requireEvidence(Number.isInteger(absent.status) && absent.status >= 100 && absent.status <= 599 && typeof absent.ok === 'boolean');
        Object.assign(observation, { status: absent.status, ok: absent.ok });
        requireEvidence(!absent.ok);
      }
      // Standard POST and pending delete/new-INSERT remain supported after alternate-route denial.
      Object.assign(observation, { case: 'pending-roundtrip', stage: 'upload-pending', status: null, ok: null });
      await h.upload(pending);
      Object.assign(observation, { case: 'pending-roundtrip', stage: 'remove-pending', status: null, ok: null });
      for (const path of h.paths(pending)) {
        Object.assign(observation, { case: 'pending-roundtrip', stage: 'remove-pending', status: null, ok: null });
        eq(await deleteWardrobeObject((route, options) => client.request(owner.token, route, options), owner.uid, path), 'removed');
      }
      Object.assign(observation, { case: 'pending-roundtrip', stage: 'reupload-pending', status: null, ok: null });
      await h.upload(pending);
      Object.assign(observation, { case: 'claim-setup', stage: 'trash-own', status: null, ok: null });
      await h.trash(own, 1);
      Object.assign(observation, { case: 'claim-setup', stage: 'trash-peer', status: null, ok: null });
      await peer.trash(foreign, 1);
      Object.assign(observation, { case: 'claim-setup', stage: 'status-own', status: null, ok: null });
      const ownPreview = await h.status(own);
      Object.assign(observation, { case: 'claim-setup', stage: 'status-peer', status: null, ok: null });
      const foreignPreview = await peer.status(foreign);
      Object.assign(observation, { case: 'claim-setup', stage: 'begin-args', status: null, ok: null });
      const peerArgs = peer.beginArgs(foreign, foreignPreview);
      Object.assign(observation, { case: 'claim-setup', stage: 'begin-peer', status: null, ok: null });
      await peer.begin(peerArgs);
      Object.assign(observation, { case: 'claim-setup', stage: 'snapshot-peer', status: null, ok: null });
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
      const singular = await client.request(owner.token, `/storage/v1/object/wardrobe/${peer.paths(foreign)[0]}`, { method: 'DELETE' });
      requireEvidence(!singular.ok && singular.status < 500);
      eq(singular.data, { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' });
      eq(singular.status, 400);
      const missing = await client.request(owner.token,
        `/storage/v1/object/wardrobe/${owners[1 - index].uid}/${foreign.p_item.id}/${randomUUID()}/main.jpg`, { method: 'DELETE' });
      requireEvidence(!missing.ok); eq(missing.status, 400);
      eq(missing.data, { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' });
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
    if (phase === 'native-operation-boundary' && observation !== null) {
      try { console.error(`I08 security observation: ${serializeSecurityObservation(observation)}`); } catch {
        try { console.error('FAIL: I08 security observation capture'); } catch {
          // The primary failure is already reported; diagnostics must not prevent cleanup.
        }
      }
    }
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: I08 exact security cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
