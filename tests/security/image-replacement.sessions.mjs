import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { saveClients, denied, eq } from '../integration/item-save.sessions.mjs';
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';

export async function imageReplacementSecurity(env) {
  const { client, owners } = await saveClients(env);
  for (const [index, owner] of owners.entries()) {
    const peer = owners[1 - index], h = imageChangeHarness(client, owner, env);
    const base = await h.create(), value = h.make(base.item, base.image);
    for (const token of [null, peer.token]) {
      const result = await h.call('reserve_image_change', { p_intent: value }, token);
      requireEvidence(!result.ok && result.status < 500);
      const status = await h.call('image_change_status', { p_item_id: value.itemId, p_request_id: value.requestId }, token);
      requireEvidence(status.status < 500 && (!status.ok || status.data === null));
    }
    await h.reserve(value);
    for (const token of [null, owner.token, peer.token]) {
      for (const name of ['reserve_image_recovery', 'complete_image_change']) {
        const result = await h.call(name, { p_owner_id: owner.uid, p_intent: value, p_objects: {} }, token);
        requireEvidence(!result.ok && result.status < 500);
      }
    }
    for (const table of ['image_change_attempts', 'image_change_context', 'image_change_history', 'item_deletion_operations', 'item_deletion_targets']) {
      for (const method of ['GET', 'POST']) {
        const result = await client.request(owner.token, `/rest/v1/${table}`, {
          method, ...(method === 'POST' ? { body: { owner_id: owner.uid, request_id: value.requestId } } : {}),
          headers: { 'Accept-Profile': 'private', 'Content-Profile': 'private' },
        });
        requireEvidence(!result.ok && result.status < 500);
      }
    }
    denied(await h.call('commit_image', { p_image_id: value.imageId }));
    const forged = { ...value, imageId: randomUUID(), requestId: randomUUID() };
    denied(await h.call('image_change_preflight', { p_intent: forged }));
    await h.cancel(value);
    await client.rpc(owner, 'set_item_trashed', { p_item_id: base.item.id, p_expected_version: base.item.version, p_trashed: true });
    const status = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [base.item.id] }))[0];
    const args = { p_item_id: base.item.id, p_request_id: randomUUID() };
    await client.rpc(owner, 'prepare_item_deletion', {
      ...args, p_expected_version: status.version, p_image_manifest_sha256: status.image_manifest_sha256,
    });
    const frozen = (await h.read('items', base.item.id))[0];
    for (const token of [null, peer.token]) {
      for (const name of ['inventory_item_deletion', 'cancel_item_deletion_preparation', 'begin_prepared_item_deletion']) {
        const result = await h.call(name, args, token); requireEvidence(!result.ok && result.status < 500);
      }
      const hidden = await h.call('item_deletion_operation_status', args, token);
      requireEvidence(hidden.status < 500 && (!hidden.ok || hidden.data === null));
    }
    for (const method of ['PATCH', 'DELETE']) {
      const result = await client.request(owner.token, `/rest/v1/items?id=eq.${base.item.id}`, {
        method, ...(method === 'PATCH' ? { body: { title: 'Forbidden mutation' } } : {}),
      });
      requireEvidence(!result.ok && result.status < 500);
    }
    eq(await h.read('items', base.item.id), [frozen]);
    for (const path of h.paths({ itemId: base.item.id, imageId: base.image.id })) {
      for (const token of [owner.token, peer.token]) {
        const result = await client.request(token, `/storage/v1/object/wardrobe/${path}`, { method: 'DELETE',
          headers: { 'storage.operation': 'storage.object.delete', 'x-storage-operation': 'storage.object.delete' } });
        requireEvidence(!result.ok && result.status < 500);
      }
    }
    await client.rpc(owner, 'cancel_item_deletion_preparation', args);
    await h.remove({ itemId: base.item.id, imageId: base.image.id }); await h.deleteItem(base.value);
  }
}
if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2); await imageReplacementSecurity(process.env);
    console.log('PASS: I10b normal-owner/peer/anonymous service denial and reversible-fence isolation');
  } catch {
    console.error('FAIL: I10b image replacement security; private evidence withheld'); process.exitCode = 1;
  }
}
