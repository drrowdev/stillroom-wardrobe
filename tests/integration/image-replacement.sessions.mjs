import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from '../../scripts/quality/files.mjs';
import { LOCAL_API } from '../../scripts/backend/local.mjs';
import { intent, saveClients, saveHarness, denied, eq, equalAiStatusState } from './item-save.sessions.mjs';
import { requireEvidence } from './preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { classifyObjectDeletion } from '../../src/data/storage-delete.ts';

const bytes = jpegHeaderFixture();
const hash = createHash('sha256').update(bytes).digest('hex');
const stripped = ['id', 'owner_id', 'created_at', 'updated_at', 'deleted_at', 'version'];
const diagnosticStatuses = new Set([200, 201, 204, 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]);
const diagnosticCodes = new Set(['22023', '42501', '42601', '42702', '42703', '42883', '23502', '23503', '23505',
  '23514', '55P03', 'PGRST202', 'PGRST204', 'NoSuchKey', 'AccessDenied', 'Duplicate', 'InvalidKey', 'EntityTooLarge']);
function responseClass(result) {
  const status = Number.isInteger(result.status) && diagnosticStatuses.has(result.status) ? result.status : 'OTHER';
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
      const result = await client.request(owner.token,
        `/storage/v1/object/wardrobe/${owner.uid}/${value.itemId}/${value.imageId}/${variant}.jpg`, {
        method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false' },
        });
      if (!result.ok && (variant === 'main' || variant === 'thumb')) mark(`upload-${variant}-http-${responseClass(result)}`);
      requireEvidence(result.ok);
    }
  };
  const endpoint = async (value, action = 'complete', token = owner.token) => {
    const result = await fetch(`${LOCAL_API}/functions/v1/finalize-image-change`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer '.concat(token), apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, intent: value }),
    });
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
    ]) {
      const invalid = structuredClone(value); change(invalid);
      const result = await h.call('reserve_image_change', { p_intent: invalid });
      requireEvidence(!result.ok && result.status === 400);
      eq(await h.read('items', base.item.id), [base.item]);
      eq(await h.read('item_images', value.imageId), []);
    }
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
    const h = imageChangeHarness(client, owner, env), base = await h.create();
    const before = await client.rpc(owner, 'ai_status', {});
    const value = h.make(base.item, base.image);
    value.item.notes = 'Explicit reviewed replacement';
    value.item.field_provenance.notes = { kind: 'user', revision: 1 };
    await h.reserve(value); await h.upload(value, ['thumb']);
    eq(await h.endpoint(value), { status: 409, data: { code: 'UPLOAD_INCOMPLETE' } });
    eq(await h.read('items', base.item.id), [base.item]); eq(await h.read('item_images', base.image.id), [base.image]);
    await h.upload(value, ['main']); eq(await h.endpoint(value), { status: 204 });
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
    const accepted = await h.endpoint(recovery, 'accept-recovery');
    requireEvidence(accepted.status === 200 && accepted.data.state === 'reserved' && accepted.data.kind === 'recovery');
    eq(await h.endpoint(recovery, 'accept-recovery'), accepted);
    // An accepted lost-ACK retry survives an explicitly forgotten source; no new acceptance or identity.
    await h.remove({ itemId: saved.id, imageId: retired.id });
    await client.rpc(owner, 'forget_image', { p_image_id: retired.id });
    eq(await h.endpoint(recovery, 'accept-recovery'), accepted);
    await h.upload(recovery); eq(await h.endpoint(recovery), { status: 204 });
    const restored = (await h.read('items', saved.id))[0];
    requireEvidence(restored.version === saved.version + 1);
    for (const [key, entry] of Object.entries(recovery.item)) eq(restored[key], entry);
    const restoredImage = (await h.read('item_images', recovery.imageId))[0];
    requireEvidence(restoredImage.state === 'ready' && restoredImage.id !== retired.id);
    eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: saved.id }), []);
    const stale = h.make(restored, restoredImage);
    await h.reserve(stale); await h.upload(stale);
    await client.rpc(owner, 'update_image_description', {
      p_image_id: restoredImage.id, p_expected_description_version: 1, p_alt_text: 'Concurrent caption',
    });
    eq(await h.endpoint(stale), { status: 409, data: { code: 'CONFLICT' } });
    eq((await h.cancel(stale)).state, 'cancelled');
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
    equalAiStatusState(await client.rpc(owner, 'ai_status', {}), before);
    for (const v of [{ itemId: base.item.id, imageId: base.image.id }, value, recovery, stale, race]) await h.remove(v);
    await h.deleteItem(base.value);
  }
}

export async function imageDeletionCases(env, { withLifecycleLateUpload, requireLifecyclePrefixEmpty, withLifecycleParentLock } = {}) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    const h = imageChangeHarness(client, owner, env), base = await h.create();
    const unaffected = withLifecycleParentLock ? await h.create() : null;
    const pending = h.make(base.item, base.image);
    await h.reserve(pending); await h.upload(pending, ['main']);
    const deletion = async () => {
    await client.rpc(owner, 'set_item_trashed', { p_item_id: base.item.id, p_expected_version: base.item.version, p_trashed: true });
    const preview = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [base.item.id] }))[0];
    const args = { p_item_id: base.item.id, p_request_id: randomUUID() };
    const prepare = () => client.rpc(owner, 'prepare_item_deletion', {
      ...args, p_expected_version: preview.version, p_image_manifest_sha256: preview.image_manifest_sha256,
    });
    if (withLifecycleParentLock) {
      await withLifecycleParentLock(owner.uid, base.item.id, 'owner share', async () => {
        denied(await h.call('prepare_item_deletion', { ...args, p_expected_version: preview.version,
          p_image_manifest_sha256: preview.image_manifest_sha256 }));
        eq(await client.rpc(owner, 'item_deletion_operation_status', args), null);
      });
    }
    const prepared = await prepare(); eq(await prepare(), prepared);
    requireEvidence(prepared.phase === 'preparing');
    denied(await h.call('authorize_item_deletion', { ...args, p_inventory_hash: 'a'.repeat(64) }));
    let operation = prepared;
    for (let page = 0; page < 4 && operation.phase === 'preparing'; page++) {
      operation = await client.rpc(owner, 'inventory_item_deletion', args);
    }
    requireEvidence(operation.phase === 'prepared' && operation.targetCount === 4 && /^[0-9a-f]{64}$/.test(operation.inventoryHash));
    if (withLifecycleParentLock) {
      const frozenItem = await h.read('items', base.item.id), frozenPending = await h.read('item_images', pending.imageId);
      const readUnaffected = async () => {
        for (const path of h.paths({ itemId: unaffected.item.id, imageId: unaffected.image.id })) {
          const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
          requireEvidence(result.ok && result.status === 200 && Buffer.isBuffer(result.data) && result.data.length === bytes.length);
          eq(createHash('sha256').update(result.data).digest('hex'), hash);
        }
      };
      await withLifecycleParentLock(owner.uid, base.item.id, 'owner no key update', async () => {
        await readUnaffected();
        denied(await h.call('set_item_trashed', { p_item_id: base.item.id, p_expected_version: preview.version, p_trashed: false }));
        for (const path of [h.paths(pending)[0], h.paths({ itemId: unaffected.item.id, imageId: unaffected.image.id })[0]]) {
          const refused = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`, { method: 'DELETE' });
          requireEvidence(!refused.ok && refused.status >= 400 && refused.status < 500);
        }
        await readUnaffected();
        eq(await h.read('items', base.item.id), frozenItem); eq(await h.read('item_images', pending.imageId), frozenPending);
        eq(await h.read('items', unaffected.item.id), [unaffected.item]);
        eq(await h.read('item_images', unaffected.image.id), [unaffected.image]);
      });
      eq(await client.rpc(owner, 'item_deletion_operation_status', args), operation);
      await withLifecycleParentLock(owner.uid, base.item.id, 'deletion update', async () => {
        const refused = await h.call('authorize_item_deletion', { ...args, p_inventory_hash: operation.inventoryHash });
        requireEvidence(!refused.ok); eq(refused.status, 400);
        eq(refused.data, { code: '22023', details: null, hint: null, message: 'Request conflict' });
        eq(await client.rpc(owner, 'item_deletion_operation_status', args), operation);
        eq((await h.status(pending)).state, 'reserved');
      });
      eq(await h.read('items', base.item.id), frozenItem); eq(await h.read('item_images', pending.imageId), frozenPending);
    }
    const authorized = await client.rpc(owner, 'authorize_item_deletion', { ...args, p_inventory_hash: operation.inventoryHash });
    requireEvidence(authorized.phase === 'authorized');
    denied(await h.call('cancel_item_deletion_preparation', args));
    eq((await h.status(pending)).state, 'cancelled');
    let dispatches = 0;
    const removePhase = async (expected) => {
      for (let n = 0; n < expected; n++) {
        const target = await client.rpc(owner, 'item_deletion_next_target', args);
        requireEvidence(target !== null && Number.isInteger(target.ordinal) && target.path.startsWith(`${owner.uid}/${base.item.id}/`));
        eq(await client.rpc(owner, 'item_deletion_next_target', args), target);
        const result = await client.request(owner.token, `/storage/v1/object/wardrobe/${target.path}`, { method: 'DELETE' });
        requireEvidence(['removed', 'missing'].includes(classifyObjectDeletion(result))); dispatches++;
        const reconciled = await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal });
        eq(reconciled, { ordinal: target.ordinal, state: 'reconciled_absent' });
        eq(await client.rpc(owner, 'reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal }), reconciled);
      }
      eq(await client.rpc(owner, 'item_deletion_next_target', args), null);
    };
    await removePhase(2);
    const begun = await client.rpc(owner, 'begin_prepared_item_deletion', args);
    requireEvidence(begun.phase === 'removing_registered' && begun.begin.version === preview.version + 1);
    eq(await client.rpc(owner, 'begin_prepared_item_deletion', args), begun);
    eq(await h.read('item_images', pending.imageId), []);
    denied(await h.call('finish_item_deletion', args));
    await removePhase(2); eq(dispatches, 4);
    eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'completed' }]);
    eq(await client.rpc(owner, 'finish_item_deletion', args), [{ state: 'absent' }]);
    const terminal = await client.rpc(owner, 'item_deletion_operation_status', args);
    requireEvidence(terminal.phase === 'completed' && terminal.inventoryHash === null && terminal.begin === null && terminal.targetCount === 0);
    eq(await client.rpc(owner, 'item_deletion_operation_status', { ...args, p_request_id: randomUUID() }), null);
    eq(await h.read('items', base.item.id), []);
    const reinsert = await client.request(owner.token, '/rest/v1/items', { method: 'POST', body: base.value.p_item });
    requireEvidence(!reinsert.ok && reinsert.status < 500);
    const late = await client.request(owner.token, `/storage/v1/object/wardrobe/${h.paths(pending)[0]}`, {
      method: 'POST', binary: true, body: bytes, headers: { 'x-upsert': 'false' },
    });
    requireEvidence(!late.ok && late.status < 500);
    };
    if (withLifecycleLateUpload) {
      await withLifecycleLateUpload(owner, { p_item: { id: base.item.id }, p_image: { id: pending.imageId } }, deletion);
      await requireLifecyclePrefixEmpty(owner.uid, base.item.id);
      for (const path of h.paths(pending)) requireEvidence(!(await client.request(owner.token,
        `/storage/v1/object/authenticated/wardrobe/${path}`)).ok);
    } else await deletion();
    if (unaffected) {
      await h.remove({ itemId: unaffected.item.id, imageId: unaffected.image.id });
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
  const base = await h.create();
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
