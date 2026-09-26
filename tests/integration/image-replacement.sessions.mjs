import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from '../../scripts/quality/files.mjs';
import { LOCAL_API, probeStep, probeCause, probeHttpCause, resetProbe } from '../../scripts/backend/local.mjs';
import { intent, saveClients, saveHarness, denied, eq, equalAiStatusState } from './item-save.sessions.mjs';
import { requireEvidence, diagnosticHttpStatus } from './preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { classifyObjectDeletion } from '../../src/data/storage-delete.ts';

const bytes = jpegHeaderFixture();
const hash = createHash('sha256').update(bytes).digest('hex');
const stripped = ['id', 'owner_id', 'created_at', 'updated_at', 'deleted_at', 'version'];
const diagnosticCodes = new Set(['22023', '42501', '42601', '42702', '42703', '42883', '23502', '23503', '23505',
  '23514', '55P03', 'PGRST202', 'PGRST204', 'NoSuchKey', 'AccessDenied', 'Duplicate', 'InvalidKey', 'EntityTooLarge']);
function responseClass(result) {
  const status = diagnosticHttpStatus(result.status);
  const data = result.data;
  const code = data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.hasOwn(data, 'code') && typeof data.code === 'string' && diagnosticCodes.has(data.code) ? data.code : 'OTHER';
  return `${status}-${code}`;
}
export function imageChangeIntent(item, current, source = null) {
  const fields = Object.fromEntries(Object.entries(item).filter(([key]) => !stripped.includes(key)));
  return {
    requestId: randomUUID(), itemId: item.id, imageId: randomUUID(), expectedVersion: item.version,
    currentImageId: current.id, descriptionVersion: current.description_version, item: fields,
    image: { id: null, main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: hash,
      thumb_sha256: hash, width: 120, height: 80, alt_text: source?.alt_text ?? 'Synthetic replacement' },
    sourceImageId: source?.id ?? null, claim: null,
  };
}
export function imageChangeHarness(client, owner, env, mark = () => {}) {
  const h = saveHarness(client, owner);
  const paths = (value) => ['main', 'thumb'].map((variant) => `${owner.uid}/${value.itemId}/${value.imageId}/${variant}.jpg`);
  const create = async () => {
    const value = intent();
    value.p_item.id = '1080' + value.p_item.id.slice(4);
    value.p_image = { ...value.p_image, main_bytes: bytes.length, thumb_bytes: bytes.length,
      main_sha256: hash, thumb_sha256: hash, width: 120, height: 80, alt_text: 'Synthetic original' };
    const row = await h.reserve(value);
    for (const path of h.paths(value)) requireEvidence((await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`, {
      method: 'POST', binary: true, body: bytes, headers: { 'x-upsert': 'false' },
    })).ok);
    await h.finalize(value, row);
    return { value, item: (await h.read('items', value.p_item.id))[0], image: (await h.read('item_images', value.p_image.id))[0] };
  };
  const reserve = async (value) => {
    const result = await h.call('reserve_image_change', { p_intent: value });
    if (!(result.ok && result.status === 200)) mark(`reserve-http-${responseClass(result)}`);
    requireEvidence(result.ok && result.status === 200);
    const receiptKeys = ['completedVersion', 'fingerprint', 'imageId', 'itemId', 'kind', 'requestId', 'state'];
    if (result.data == null || !isDeepStrictEqual(Object.keys(result.data).sort(), receiptKeys)) mark('reserve-receipt-keys');
    eq(Object.keys(result.data).sort(), receiptKeys);
    const sameIdentity = result.data.requestId === value.requestId && result.data.itemId === value.itemId
      && result.data.imageId === value.imageId && /^[0-9a-f]{64}$/.test(result.data.fingerprint);
    if (!sameIdentity) mark('reserve-receipt-identity');
    requireEvidence(sameIdentity);
    return result.data;
  };
  const upload = async (value, variants = ['main', 'thumb']) => {
    for (const variant of variants) {
      const knownVariant = variant === 'main' || variant === 'thumb';
      if (knownVariant) mark(`upload-${variant}-attempt`);
      const result = await client.request(owner.token,
        `/storage/v1/object/wardrobe/${owner.uid}/${value.itemId}/${value.imageId}/${variant}.jpg`, {
        method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false' },
        ...(knownVariant ? { onFailure: (reason) => mark(`upload-${variant}-${reason}`) } : {}),
        });
      if (!result.ok && knownVariant) mark(`upload-${variant}-http-${responseClass(result)}`);
      requireEvidence(result.ok);
    }
  };
  const endpoint = async (value, action = 'complete', token = owner.token) => {
    const result = await fetch(`${LOCAL_API}/functions/v1/finalize-image-change`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer '.concat(token), apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, intent: value }),
    });
    if (result.status >= 500) probeCause(probeHttpCause(result.status));
    requireEvidence(result.status < 500);
    if (result.status === 204) { requireEvidence(result.body === null); return { status: 204 }; }
    const text = await result.text(); requireEvidence(Buffer.byteLength(text) <= 16384);
    return { status: result.status, data: JSON.parse(text) };
  };
  const make = (item, image, source) => {
    const value = imageChangeIntent(item, image, source); value.image.id = value.imageId; return value;
  };
  const remove = async (value) => {
    for (const path of paths(value)) {
      const result = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`, { method: 'DELETE' });
      requireEvidence(['removed', 'missing'].includes(classifyObjectDeletion(result)));
    }
  };
  return { ...h, create, make, reserve, upload, endpoint, paths, remove,
    status: (value) => client.rpc(owner, 'image_change_status', { p_item_id: value.itemId, p_request_id: value.requestId }),
    cancel: (value) => client.rpc(owner, 'cancel_image_change', { p_item_id: value.itemId, p_request_id: value.requestId }),
  };
}

export async function imageReplacementBaseline(env) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    const h = imageChangeHarness(client, owner, env), base = await h.create(), value = h.make(base.item, base.image);
    const before = await client.rpc(owner, 'ai_status', {});
    for (const change of [
      (v) => { v.expectedVersion++; }, (v) => { v.descriptionVersion++; },
      (v) => { v.currentImageId = randomUUID(); }, (v) => { v.item.title = null; },
      (v) => { v.item.field_provenance.material = { kind: 'ai_estimated', revision: 1 }; v.item.material = 'Invented'; },
      (v) => { v.image.main_bytes = 1.5; }, (v) => { v.item.tags = Array(13).fill('duplicate'); },
      ...['wine', 'Burgundy', 'light-blue', 'lightblue'].map((colour) => (v) => {
        v.item.colours = [colour]; v.item.field_provenance.colours = { kind: 'user', revision: 1 }; }),
    ]) {
      const invalid = structuredClone(value); change(invalid);
      const result = await h.call('reserve_image_change', { p_intent: invalid });
      requireEvidence(!result.ok && result.status === 400);
      eq(await h.read('items', base.item.id), [base.item]);
      eq(await h.read('item_images', value.imageId), []);
    }
    // The frozen change also carries added colour codes; the item row stays unchanged until completion.
    value.item.colours = ['burgundy', 'light_blue', 'gold'];
    value.item.field_provenance = { ...value.item.field_provenance, colours: { kind: 'user', revision: 1 } };
    const receipt = await h.reserve(value); eq(await h.reserve(value), receipt);
    const drift = structuredClone(value); drift.image.alt_text = 'Changed frozen request';
    denied(await h.call('reserve_image_change', { p_intent: drift }));
    const duplicate = structuredClone(value); duplicate.requestId = randomUUID();
    denied(await h.call('reserve_image_change', { p_intent: duplicate }));
    eq(await client.rpc(owner, 'image_change_requests', { p_item_id: value.itemId }), [receipt]);
    eq(await h.read('items', base.item.id), [base.item]);
    eq(await h.read('item_images', base.image.id), [base.image]);
    denied(await h.call('commit_image', { p_image_id: value.imageId }));
    eq((await h.cancel(value)).state, 'cancelled');
    eq(await h.status(value), await h.cancel(value));
    denied(await h.call('reserve_image_change', { p_intent: value }));
    requireEvidence(!(await client.request(owner.token, `/storage/v1/object/wardrobe/${h.paths(value)[0]}`, {
      method: 'POST', body: bytes, binary: true,
    })).ok);
    equalAiStatusState(await client.rpc(owner, 'ai_status', {}), before);
    await h.remove({ itemId: base.item.id, imageId: base.image.id });
    await h.deleteItem(base.value);
    const scrubbed = await h.status(value);
    requireEvidence(scrubbed.state === 'cancelled' && scrubbed.fingerprint === null);
  }
}

export async function imageReplacementServed(env) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    probeStep('replacement-create');
    const h = imageChangeHarness(client, owner, env), base = await h.create();
    const before = await client.rpc(owner, 'ai_status', {});
    const value = h.make(base.item, base.image);
    value.item.notes = 'Explicit reviewed replacement';
    value.item.field_provenance = { ...value.item.field_provenance, notes: { kind: 'user', revision: 1 } };
    probeStep('replacement-reserve');
    await h.reserve(value);
    probeStep('replacement-upload-thumb');
    await h.upload(value, ['thumb']);
    probeStep('replacement-incomplete');
    const incomplete = await h.endpoint(value);
    if (incomplete.status !== 409) probeCause(probeHttpCause(incomplete.status));
    eq(incomplete, { status: 409, data: { code: 'UPLOAD_INCOMPLETE' } });
    eq(await h.read('items', base.item.id), [base.item]); eq(await h.read('item_images', base.image.id), [base.image]);
    probeStep('replacement-upload-main');
    await h.upload(value, ['main']);
    probeStep('replacement-complete');
    const completed = await h.endpoint(value);
    if (completed.status !== 204) probeCause(probeHttpCause(completed.status));
    eq(completed, { status: 204 });
    probeStep('replacement-verify');
    const saved = (await h.read('items', base.item.id))[0], ready = (await h.read('item_images', value.imageId))[0];
    const retired = (await h.read('item_images', base.image.id))[0];
    requireEvidence(saved.version === base.item.version + 1 && ready.state === 'ready' && retired.state === 'retired'
      && typeof retired.retired_at === 'string');
    for (const [key, entry] of Object.entries(value.item)) eq(saved[key], entry);
    eq((await h.status(value)).state, 'completed');
    eq((await h.cancel(value)).state, 'completed');
    eq(await h.endpoint(value), { status: 204 }); eq(await h.read('items', base.item.id), [saved]);
    requireEvidence(!(await client.request(owner.token, `/storage/v1/object/wardrobe/${h.paths(value)[0]}`, {
      method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false' },
    })).ok);
    const versions = await client.rpc(owner, 'image_recovery_versions', { p_item_id: saved.id, p_after: null });
    requireEvidence(versions.length === 1 && versions[0].eligible); eq(versions[0].image, retired);
    const recovery = h.make(saved, ready, retired);
    probeStep('recovery-accept');
    const accepted = await h.endpoint(recovery, 'accept-recovery');
    requireEvidence(accepted.status === 200 && accepted.data.state === 'reserved' && accepted.data.kind === 'recovery');
    eq(await h.endpoint(recovery, 'accept-recovery'), accepted);
    // An accepted lost-ACK retry survives an explicitly forgotten source; no new acceptance or identity.
    await h.remove({ itemId: saved.id, imageId: retired.id });
    await client.rpc(owner, 'forget_image', { p_image_id: retired.id });
    eq(await h.endpoint(recovery, 'accept-recovery'), accepted);
    probeStep('recovery-complete');
    await h.upload(recovery); eq(await h.endpoint(recovery), { status: 204 });
    const restored = (await h.read('items', saved.id))[0];
    requireEvidence(restored.version === saved.version + 1);
    for (const [key, entry] of Object.entries(recovery.item)) eq(restored[key], entry);
    const restoredImage = (await h.read('item_images', recovery.imageId))[0];
    requireEvidence(restoredImage.state === 'ready' && restoredImage.id !== retired.id);
    eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: saved.id }), []);
    probeStep('stale-caption');
    const stale = h.make(restored, restoredImage);
    await h.reserve(stale); await h.upload(stale);
    await client.rpc(owner, 'update_image_description', {
      p_image_id: restoredImage.id, p_expected_description_version: 1, p_alt_text: 'Concurrent caption',
    });
    eq(await h.endpoint(stale), { status: 409, data: { code: 'CONFLICT' } });
    eq((await h.cancel(stale)).state, 'cancelled');
    probeStep('completion-race');
    const raceBase = (await h.read('items', saved.id))[0], raceImage = (await h.read('item_images', recovery.imageId))[0];
    const race = h.make(raceBase, raceImage);
    await h.reserve(race); await h.upload(race);
    const [completion, cancellation] = await Promise.all([h.endpoint(race),
      h.call('cancel_image_change', { p_item_id: race.itemId, p_request_id: race.requestId })]);
    const outcome = await h.status(race);
    requireEvidence(outcome.state === 'completed' || outcome.state === 'cancelled');
    if (outcome.state === 'completed') {
      eq(completion, { status: 204 });
      if (cancellation.ok) eq(cancellation.data.state, 'completed');
      else {
        eq(cancellation.status, 400);
        eq(cancellation.data, { code: '22023', details: null, hint: null, message: 'Request conflict' });
      }
      eq((await h.cancel(race)).state, 'completed');
      requireEvidence((await h.read('items', saved.id))[0].version === raceBase.version + 1);
    } else {
      eq(completion, { status: 409, data: { code: 'CONFLICT' } });
      requireEvidence(cancellation.ok); eq(cancellation.data.state, 'cancelled');
      eq(await h.read('items', saved.id), [raceBase]); eq(await h.read('item_images', raceImage.id), [raceImage]);
    }
    probeStep('replacement-cleanup');
    equalAiStatusState(await client.rpc(owner, 'ai_status', {}), before);
    for (const v of [{ itemId: base.item.id, imageId: base.image.id }, value, recovery, stale, race]) await h.remove(v);
    await h.deleteItem(base.value);
  }
  resetProbe();
}

export async function imageDeletionCases(env, { withLifecycleLateUpload, requireLifecyclePrefixEmpty, withLifecycleParentLock, mark = () => {} } = {}) {
  mark('entry');
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    mark('owner-create');
    const h = imageChangeHarness(client, owner, env), base = await h.create();
    mark('unaffected-create');
    const unaffected = withLifecycleParentLock ? await h.create() : null;
    mark('pending-intent');
    const pending = h.make(base.item, base.image);
    mark('pending-reserve');
    await h.reserve(pending);
    mark('pending-upload');
    await h.upload(pending, ['main']);
    const deletion = async () => {
    mark('trash');
    await client.rpc(owner, 'set_item_trashed', { p_item_id: base.item.id, p_expected_version: base.item.version, p_trashed: true });
    mark('preview');
    const preview = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [base.item.id] }))[0];
    mark('prepare-arguments');
    const args = { p_item_id: base.item.id, p_request_id: randomUUID() };
    const prepare = () => client.rpc(owner, 'prepare_item_deletion', {
      ...args, p_expected_version: preview.version, p_image_manifest_sha256: preview.image_manifest_sha256,
    });
    if (withLifecycleParentLock) {
      mark('prepare-lock-admit');
      await withLifecycleParentLock(owner.uid, base.item.id, 'owner share', async () => {
        mark('prepare-lock-call');
        const refused = await h.call('prepare_item_deletion', { ...args, p_expected_version: preview.version,
          p_image_manifest_sha256: preview.image_manifest_sha256 });
        mark(`prepare-lock-result-${responseClass(refused)}`);
        denied(refused);
        mark('prepare-lock-status');
        eq(await client.rpc(owner, 'item_deletion_operation_status', args), null);
        mark('prepare-lock-release');
      });
    }
    mark('prepare');
    const prepared = await prepare();
    mark('prepare-replay');
    eq(await prepare(), prepared);
    mark('prepare-result');
    requireEvidence(prepared.phase === 'preparing');
    mark('authorize-bad-hash');
    const invalidHash = await h.call('authorize_item_deletion', { ...args, p_inventory_hash: 'a'.repeat(64) });
    mark(`authorize-bad-hash-result-${responseClass(invalidHash)}`);
    denied(invalidHash);
    let operation = prepared;
    for (let page = 0; page < 4 && operation.phase === 'preparing'; page++) {
      mark('inventory');
      operation = await client.rpc(owner, 'inventory_item_deletion', args);
    }
    mark('inventory-result');
    requireEvidence(operation.phase === 'prepared' && operation.targetCount === 4 && /^[0-9a-f]{64}$/.test(operation.inventoryHash));
    if (withLifecycleParentLock) {
      mark('freeze-item');
      const frozenItem = await h.read('items', base.item.id);
      mark('freeze-pending');
      const frozenPending = await h.read('item_images', pending.imageId);
      const readUnaffected = async () => {
        for (const path of h.paths({ itemId: unaffected.item.id, imageId: unaffected.image.id })) {
          mark('unaffected-read');
          const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
          mark(`unaffected-read-result-${responseClass(result)}`);
          requireEvidence(result.ok && result.status === 200 && Buffer.isBuffer(result.data) && result.data.length === bytes.length);
          mark('unaffected-read-hash');
          eq(createHash('sha256').update(result.data).digest('hex'), hash);
        }
      };
      mark('owner-lock-admit');
      await withLifecycleParentLock(owner.uid, base.item.id, 'owner no key update', async () => {
        await readUnaffected();
        mark('owner-lock-trash');
        const trash = await h.call('set_item_trashed', { p_item_id: base.item.id, p_expected_version: preview.version, p_trashed: false });
        mark(`owner-lock-trash-result-${responseClass(trash)}`);
        denied(trash);
        for (const path of [h.paths(pending)[0], h.paths({ itemId: unaffected.item.id, imageId: unaffected.image.id })[0]]) {
          mark('owner-lock-delete');
          const refused = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`, {
            method: 'DELETE', onFailure: (reason) => mark(`owner-lock-delete-${reason}`),
          });
          mark(`owner-lock-delete-result-${responseClass(refused)}`);
          requireEvidence(!refused.ok && refused.status >= 400 && refused.status < 500);
        }
        await readUnaffected();
        mark('owner-lock-item');
        eq(await h.read('items', base.item.id), frozenItem);
        mark('owner-lock-pending');
        eq(await h.read('item_images', pending.imageId), frozenPending);
        mark('owner-lock-unaffected-item');
        eq(await h.read('items', unaffected.item.id), [unaffected.item]);
        mark('owner-lock-unaffected-image');
        eq(await h.read('item_images', unaffected.image.id), [unaffected.image]);
        mark('owner-lock-release');
      });
      mark('owner-lock-status');
      eq(await client.rpc(owner, 'item_deletion_operation_status', args), operation);
      mark('authorize-lock-admit');
      await withLifecycleParentLock(owner.uid, base.item.id, 'deletion update', async () => {
        mark('authorize-lock-call');
        const refused = await h.call('authorize_item_deletion', { ...args, p_inventory_hash: operation.inventoryHash });
        mark(`authorize-lock-result-${responseClass(refused)}`);
        requireEvidence(!refused.ok); eq(refused.status, 400);
        eq(refused.data, { code: '22023', details: null, hint: null, message: 'Request conflict' });
        mark('authorize-lock-status');
        eq(await client.rpc(owner, 'item_deletion_operation_status', args), operation);
        mark('authorize-lock-reservation');
        eq((await h.status(pending)).state, 'reserved');
        mark('authorize-lock-release');
      });
      mark('after-lock-item');
      eq(await h.read('items', base.item.id), frozenItem);
      mark('after-lock-pending');
      eq(await h.read('item_images', pending.imageId), frozenPending);
    }
    mark('authorize');
    const authorized = await client.rpc(owner, 'authorize_item_deletion', { ...args, p_inventory_hash: operation.inventoryHash });
    mark('authorize-result');
    requireEvidence(authorized.phase === 'authorized');
    mark('cancel-refusal');
    const cancelled = await h.call('cancel_item_deletion_preparation', args);
    mark(`cancel-result-${responseClass(cancelled)}`);
    denied(cancelled);
    mark('cancelled-reservation');
    eq((await h.status(pending)).state, 'cancelled');
    let dispatches = 0;
    const removePhase = async (expected, registered) => {
      for (let n = 0; n < expected; n++) {
        mark(registered ? 'registered-next' : 'pending-next');
        const target = await client.rpc(owner, 'item_deletion_next_target', args);
        mark(registered ? 'registered-target' : 'pending-target');
        requireEvidence(target !== null && Number.isInteger(target.ordinal) && target.path.startsWith(`${owner.uid}/${base.item.id}/`));
        mark(registered ? 'registered-next-replay' : 'pending-next-replay');
        eq(await client.rpc(owner, 'item_deletion_next_target', args), target);
        mark(registered ? 'registered-remove' : 'pending-remove');
        const result = await client.request(owner.token, `/storage/v1/object/wardrobe/${target.path}`, { method: 'DELETE' });
        mark(registered ? `registered-remove-result-${responseClass(result)}` : `pending-remove-result-${responseClass(result)}`);
        requireEvidence(['removed', 'missing'].includes(classifyObjectDeletion(result))); dispatches++;
        mark(registered ? 'registered-reconcile' : 'pending-reconcile');
        const reconciled = await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal });
        mark(registered ? 'registered-reconcile-result' : 'pending-reconcile-result');
        eq(reconciled, { ordinal: target.ordinal, state: 'reconciled_absent' });
        mark(registered ? 'registered-reconcile-replay' : 'pending-reconcile-replay');
        eq(await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal }), reconciled);
      }
      mark(registered ? 'registered-empty' : 'pending-empty');
      eq(await client.rpc(owner, 'item_deletion_next_target', args), null);
    };
    await removePhase(2, false);
    mark('begin');
    const begun = await client.rpc(owner, 'begin_prepared_item_deletion', args);
    mark('begin-result');
    requireEvidence(begun.phase === 'removing_registered' && begun.begin.version === preview.version + 1);
    mark('begin-replay');
    eq(await client.rpc(owner, 'begin_prepared_item_deletion', args), begun);
    mark('pending-row-absent');
    eq(await h.read('item_images', pending.imageId), []);
    mark('finish-premature');
    const premature = await h.call('finish_item_deletion', args);
    mark(`finish-premature-result-${responseClass(premature)}`);
    denied(premature);
    await removePhase(2, true);
    mark('dispatch-count');
    eq(dispatches, 4);
    mark('finish');
    eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'completed' }]);
    mark('finish-replay');
    eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'absent' }]);
    mark('terminal-status');
    const terminal = await client.rpc(owner, 'item_deletion_operation_status', args);
    mark('terminal-result');
    requireEvidence(terminal.phase === 'completed' && terminal.inventoryHash === null && terminal.begin === null && terminal.targetCount === 0);
    mark('terminal-other-request');
    eq(await client.rpc(owner, 'item_deletion_operation_status', { ...args, p_request_id: randomUUID() }), null);
    mark('item-absent');
    eq(await h.read('items', base.item.id), []);
    mark('reinsert-refusal');
    const reinsert = await client.request(owner.token, '/rest/v1/items', { method: 'POST', body: base.value.p_item });
    mark(`reinsert-result-${responseClass(reinsert)}`);
    requireEvidence(!reinsert.ok && reinsert.status < 500);
    mark('late-post-refusal');
    const late = await client.request(owner.token, `/storage/v1/object/wardrobe/${h.paths(pending)[0]}`, {
      method: 'POST', binary: true, body: bytes, headers: { 'x-upsert': 'false' },
    });
    mark(`late-post-result-${responseClass(late)}`);
    requireEvidence(!late.ok && late.status < 500);
    mark('child-settlement');
    };
    if (withLifecycleLateUpload) {
      mark('child-admit');
      await withLifecycleLateUpload(owner, { p_item: { id: base.item.id }, p_image: { id: pending.imageId } }, deletion, 'pending-thumb-absent');
      mark('post-child-prefix');
      await requireLifecyclePrefixEmpty(owner.uid, base.item.id);
      for (const path of h.paths(pending)) {
        mark('post-child-get');
        const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
        mark(`post-child-get-result-${responseClass(result)}`);
        requireEvidence(!result.ok);
      }
    } else await deletion();
    if (unaffected) {
      mark('unaffected-remove');
      await h.remove({ itemId: unaffected.item.id, imageId: unaffected.image.id });
      mark('unaffected-delete-item');
      await h.deleteItem(unaffected.value);
    }
  }
}

export async function imageChangePagedDeletion(env) {
  const { client, owners: [owner] } = await saveClients(env), h = imageChangeHarness(client, owner, env);
  const base = await h.create(), versions = [], expectedPaths = new Set(h.paths({ itemId: base.item.id, imageId: base.image.id }));
  for (let n = 0; n < 41; n++) {
    const image = { ...base.value.p_image, id: randomUUID(), item_id: base.item.id };
    await client.insert(owner, 'item_images', image);
    const value = { itemId: base.item.id, imageId: image.id };
    await h.upload(value); await client.rpc(owner, 'retire_image', { p_image_id: image.id });
    versions.push(image.id); for (const path of h.paths(value)) expectedPaths.add(path);
  }
  eq(await h.read('item_images', base.image.id), [base.image]);
  const first = await client.rpc(owner, 'image_recovery_versions', { p_item_id: base.item.id, p_after: null });
  requireEvidence(first.length === 40 && first.every((v) => v.eligible === true));
  const second = await client.rpc(owner, 'image_recovery_versions', { p_item_id: base.item.id, p_after: first[39].image.id });
  requireEvidence(second.length === 1 && second[0].eligible === true);
  eq([...first, ...second].map((v) => v.image.id), versions.sort());
  eq(await client.rpc(owner, 'image_recovery_versions', { p_item_id: base.item.id, p_after: second[0].image.id }), []);
  await client.rpc(owner, 'set_item_trashed', { p_item_id: base.item.id, p_expected_version: base.item.version, p_trashed: true });
  const preview = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [base.item.id] }))[0];
  const args = { p_item_id: base.item.id, p_request_id: randomUUID() };
  let operation = await client.rpc(owner, 'prepare_item_deletion', {
    ...args, p_expected_version: preview.version, p_image_manifest_sha256: preview.image_manifest_sha256,
  });
  let pages = 0;
  while (pages < 6 && operation.phase === 'preparing') {
    operation = await client.rpc(owner, 'inventory_item_deletion', args); pages++;
  }
  requireEvidence(pages === 5 && operation.phase === 'prepared' && operation.targetCount === 84
    && operation.registeredTargets === 84 && operation.pendingTargets === 0 && operation.unmanifestedTargets === 0);
  await client.rpc(owner, 'authorize_item_deletion', { ...args, p_inventory_hash: operation.inventoryHash });
  eq(await client.rpc(owner, 'item_deletion_next_target', args), null);
  await client.rpc(owner, 'begin_prepared_item_deletion', args);
  for (let n = 0; n < 84; n++) {
    const target = await client.rpc(owner, 'item_deletion_next_target', args);
    requireEvidence(target !== null && expectedPaths.delete(target.path));
    eq(classifyObjectDeletion(await client.request(owner.token, `/storage/v1/object/wardrobe/${target.path}`, { method: 'DELETE' })), 'removed');
    if (n === 0) {
      // Lost DELETE acknowledgment: exact native missing is reconciled against the actual catalogue.
      eq(classifyObjectDeletion(await client.request(owner.token, `/storage/v1/object/wardrobe/${target.path}`, { method: 'DELETE' })), 'missing');
    }
    eq(await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal }),
      { ordinal: target.ordinal, state: 'reconciled_absent' });
  }
  eq(expectedPaths.size, 0); eq(await client.rpc(owner, 'item_deletion_next_target', args), null);
  eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'completed' }]);
  requireEvidence((await client.rpc(owner, 'item_deletion_operation_status', args)).phase === 'completed');
}

export async function imageChangeOrphanDeletion(env) {
  const { client, owners: [, owner] } = await saveClients(env), h = imageChangeHarness(client, owner, env);
  const value = intent();
  value.p_item.id = '1080' + value.p_item.id.slice(4);
  value.p_image = { ...value.p_image, id: '1080' + value.p_image.id.slice(4),
    main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: hash, thumb_sha256: hash,
    width: 120, height: 80, alt_text: 'Synthetic original' };
  await client.insert(owner, 'items', value.p_item);
  await client.insert(owner, 'item_images', { ...value.p_image, item_id: value.p_item.id });
  await h.upload({ itemId: value.p_item.id, imageId: value.p_image.id });
  await client.rpc(owner, 'commit_image', { p_image_id: value.p_image.id });
  const items = await h.read('items', value.p_item.id), images = await h.read('item_images', value.p_image.id);
  eq(items.length, 1); eq(images.length, 1);
  const base = { value, item: items[0], image: images[0] };
  eq(base.item.id, value.p_item.id); eq(base.item.owner_id, owner.uid);
  eq(base.image.owner_id, owner.uid); eq(base.image.item_id, value.p_item.id); eq(base.image.state, 'ready');
  for (const [key, expected] of Object.entries(value.p_image)) eq(base.image[key], expected);
  // Preserve the existing raw-delete orphan compatibility case; cleanup uses only native DELETE.
  await h.deleteItem(base.value);
  await client.insert(owner, 'items', base.value.p_item);
  const image = { ...base.value.p_image, id: randomUUID(), item_id: base.item.id };
  await client.insert(owner, 'item_images', image);
  await h.upload({ itemId: base.item.id, imageId: image.id });
  await client.rpc(owner, 'commit_image', { p_image_id: image.id });
  await client.rpc(owner, 'set_item_trashed', { p_item_id: base.item.id, p_expected_version: 1, p_trashed: true });
  const preview = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [base.item.id] }))[0];
  requireEvidence(preview.unmanifested_count === 2 && preview.cleanup_blocked);
  const args = { p_item_id: base.item.id, p_request_id: randomUUID() };
  await client.rpc(owner, 'prepare_item_deletion', { ...args, p_expected_version: preview.version,
    p_image_manifest_sha256: preview.image_manifest_sha256 });
  let prepared;
  for (let n = 0; n < 2; n++) prepared = await client.rpc(owner, 'inventory_item_deletion', args);
  requireEvidence(prepared.phase === 'prepared' && prepared.targetCount === 4 && prepared.unmanifestedTargets === 2
    && prepared.pendingTargets === 0 && prepared.registeredTargets === 2);
  await client.rpc(owner, 'authorize_item_deletion', { ...args, p_inventory_hash: prepared.inventoryHash });
  for (let phase = 0; phase < 2; phase++) {
    const paths = new Set(h.paths({ itemId: base.item.id, imageId: phase === 0 ? base.image.id : image.id }));
    for (let n = 0; n < 2; n++) {
      const target = await client.rpc(owner, 'item_deletion_next_target', args);
      requireEvidence(target !== null && paths.delete(target.path));
      eq(classifyObjectDeletion(await client.request(owner.token, `/storage/v1/object/wardrobe/${target.path}`, { method: 'DELETE' })), 'removed');
      await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal });
    }
    eq(paths.size, 0); eq(await client.rpc(owner, 'item_deletion_next_target', args), null);
    if (phase === 0) await client.rpc(owner, 'begin_prepared_item_deletion', args);
  }
  eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'completed' }]);
  eq(await h.read('items', base.item.id), []);
}

if (isMain(import.meta.url)) {
  try {
    requireEvidence(process.argv.length === 2);
    await imageReplacementBaseline(process.env);
    await imageDeletionCases(process.env);
    console.log('PASS: I10b ordinary-owner reservation, baseline survival, cancellation and terminal scrubbing; no inference');
  } catch {
    console.error('FAIL: I10b ordinary-owner image replacement; private evidence withheld');
    process.exitCode = 1;
  }
}
