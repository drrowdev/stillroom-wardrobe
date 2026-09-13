import { createHash, randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence, TABLES } from './preservation.sessions.mjs';
import { bytes, intent, saveClients, saveHarness, denied, eq } from './item-save.sessions.mjs';
import { validateSessionEnvironment, assertLocalApi, assertPublishableKey, jwtClaims } from '../../scripts/backend/local.mjs';

const heldStages = ['before-holder', 'holder-ready', 'request-sent', 'response-read', 'classified',
  'intent-and-rows', 'image-insert-denied', 'status-read', 'released'];
const codeClasses = ['22023', '55P03', '42501', '23505', 'other', 'missing'];
export function lifecycleObservation(ownerOrdinal) {
  requireEvidence(ownerOrdinal === 1 || ownerOrdinal === 2);
  return {
    schemaVersion: 1, ownerOrdinal, stage: 'before-holder', status: null, ok: null, elapsedMs: null,
    contentType: null, bodyType: null, bodyBytes: null, truncated: null, captureError: null,
    cancelFailed: null, releaseFailed: null, code: null, errorPresent: null, errorIsString: null,
    statusCodePresent: null, statusCodeMatches: null, messagePresent: null,
    exactRequestConflict: null, containsFixedPhrase: null,
  };
}
export function serializeLifecycleObservation(observation) {
  const template = lifecycleObservation(1), keys = Object.keys(template), output = {};
  requireEvidence(observation !== null && typeof observation === 'object' && !Array.isArray(observation));
  eq(Reflect.ownKeys(observation).sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(observation, key);
    requireEvidence(descriptor && Object.hasOwn(descriptor, 'value'));
    output[key] = descriptor.value;
  }
  requireEvidence(output.schemaVersion === 1 && [1, 2].includes(output.ownerOrdinal) && heldStages.includes(output.stage));
  for (const [key, min, max] of [['status', 100, 599], ['elapsedMs', 0, 600000], ['bodyBytes', 0, 4096]]) {
    requireEvidence(output[key] === null || (Number.isInteger(output[key]) && output[key] >= min && output[key] <= max));
  }
  for (const key of ['ok', 'truncated', 'cancelFailed', 'releaseFailed', 'errorPresent', 'errorIsString',
    'statusCodePresent', 'statusCodeMatches', 'messagePresent', 'exactRequestConflict', 'containsFixedPhrase']) {
    requireEvidence(output[key] === null || typeof output[key] === 'boolean');
  }
  requireEvidence([null, 'json', 'other', 'missing'].includes(output.contentType));
  requireEvidence([null, 'missing', 'empty', 'object', 'array', 'primitive', 'invalid-utf8', 'invalid-json'].includes(output.bodyType));
  requireEvidence([null, 'none', 'request', 'headers', 'read', 'overflow', 'decode', 'json', 'shape'].includes(output.captureError));
  requireEvidence(output.code === null || codeClasses.includes(output.code));
  if (output.truncated === true) requireEvidence(output.bodyBytes === null);
  if (output.bodyType !== 'object') {
    for (const key of ['code', 'errorPresent', 'errorIsString', 'statusCodePresent', 'statusCodeMatches',
      'messagePresent', 'exactRequestConflict', 'containsFixedPhrase']) requireEvidence(output[key] === null);
  }
  const serialized = JSON.stringify(output);
  requireEvidence(typeof serialized === 'string' && !/[\r\n]/.test(serialized) && Buffer.byteLength(serialized, 'utf8') <= 1024);
  eq(JSON.parse(serialized), output);
  return serialized;
}

// Only the existing held-parent negative POST uses this adapter; normalClient stays unchanged.
export async function readLifecycleUploadResponse(env, owner, value, observation) {
  const start = performance.now();
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL), key = assertPublishableKey(env.SUPABASE_PUBLISHABLE_KEY);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  requireEvidence(uuid.test(owner.uid) && uuid.test(value.p_item.id) && value.p_item.id.startsWith('1080')
    && uuid.test(value.p_image.id) && typeof owner.token === 'string' && !/[\r\n]/.test(owner.token));
  const claims = jwtClaims(owner.token);
  requireEvidence(claims.role === 'authenticated' && claims.sub === owner.uid);
  const route = `/storage/v1/object/wardrobe/${owner.uid}/${value.p_item.id}/${value.p_image.id}/thumb.jpg`;
  let response, reader, result, primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue;
  const cleanupFailure = (error) => {
    if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; }
  };
  observation.stage = 'request-sent';
  observation.captureError = 'request';
  try {
    response = await fetch(base + route, {
      method: 'POST', body: bytes, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { apikey: key, Authorization: 'Bearer ' + owner.token, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    });
    observation.captureError = 'headers';
    observation.status = response.status;
    observation.ok = response.ok;
    const contentType = response.headers.get('content-type');
    observation.contentType = contentType === null ? 'missing'
      : /^application\/json(?:\s*;|$)/i.test(contentType) ? 'json' : 'other';
    result = { ok: response.ok, status: response.status, data: null, elapsedMs: null };
    if (response.body === null) {
      observation.bodyType = 'missing';
    } else {
      observation.captureError = 'read';
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      observation.bodyBytes = 0;
      observation.truncated = false;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        requireEvidence(chunk instanceof Uint8Array);
        if (length + chunk.byteLength > 4096) {
          observation.bodyBytes = null;
          observation.truncated = true;
          observation.captureError = 'overflow';
          requireEvidence(false);
        }
        length += chunk.byteLength;
        observation.bodyBytes = length;
        chunks.push(chunk);
      }
      if (length === 0) {
        observation.bodyType = 'empty';
      } else {
        observation.captureError = 'decode';
        observation.bodyType = 'invalid-utf8';
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        observation.captureError = 'json';
        observation.bodyType = 'invalid-json';
        const data = JSON.parse(text);
        observation.captureError = 'shape';
        observation.bodyType = data !== null && typeof data === 'object'
          ? Array.isArray(data) ? 'array' : 'object' : 'primitive';
        requireEvidence(observation.bodyType === 'object');
        observation.code = !Object.hasOwn(data, 'code') ? 'missing'
          : codeClasses.slice(0, 4).find((code) => code === data.code) ?? 'other';
        observation.errorPresent = Object.hasOwn(data, 'error');
        observation.errorIsString = typeof data.error === 'string';
        observation.statusCodePresent = Object.hasOwn(data, 'statusCode');
        observation.statusCodeMatches = ['string', 'number'].includes(typeof data.statusCode)
          && String(data.statusCode) === String(response.status);
        observation.messagePresent = Object.hasOwn(data, 'message');
        observation.exactRequestConflict = data.message === 'Request conflict';
        observation.containsFixedPhrase = typeof data.message === 'string' && data.message.includes('Request conflict');
        result.data = data;
      }
    }
    observation.captureError = 'none';
    observation.stage = 'response-read';
  } catch (error) { primaryFailed = true; primaryValue = error; }
  if (reader) {
    try { await reader.cancel(); observation.cancelFailed = false; }
    catch (error) { observation.cancelFailed = true; cleanupFailure(error); }
    try { reader.releaseLock(); observation.releaseFailed = false; }
    catch (error) { observation.releaseFailed = true; cleanupFailure(error); }
  } else if (response) {
    try {
      if (response.body !== null) { await response.body.cancel(); observation.cancelFailed = false; }
    } catch (error) { observation.cancelFailed = true; cleanupFailure(error); }
  }
  try {
    const elapsed = performance.now() - start;
    observation.elapsedMs = Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 600000 ? Math.round(elapsed) : null;
    if (result) result.elapsedMs = elapsed;
  } catch (error) { cleanupFailure(error); }
  if (cleanupFailed) {
    try { console.error('FAIL: I08 held-upload response cleanup'); } catch (error) { cleanupFailure(error); }
  }
  if (primaryFailed) throw primaryValue;
  if (cleanupFailed) throw cleanupValue;
  return result;
}

export function requireLifecycleUploadConflict(result) {
  requireEvidence(!result.ok && result.status < 500 && result.elapsedMs < 5_000);
  requireEvidence(result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data));
  const dbConflict = result.data?.code === '22023' && result.data?.message === 'Request conflict';
  const wrappedConflict = result.data?.message === 'Request conflict'
    && typeof result.data?.error === 'string' && String(result.data?.statusCode) === String(result.status);
  requireEvidence(dbConflict || wrappedConflict);
}

const statusKeys = ['id', 'owner_id', 'title', 'version', 'deleted_at', 'photo_count', 'current_image_id',
  'current_thumb_path', 'image_manifest_sha256', 'cleanup_blocked', 'unmanifested_count',
  'request_id', 'expected_version', 'started_at'];
const beginKeys = ['request_id', 'expected_version', 'version', 'started_at', 'image_manifest_sha256'];
export function one(result, keys) {
  requireEvidence(result.ok && result.status === 200 && Array.isArray(result.data) && result.data.length === 1);
  eq(Object.keys(result.data[0]).sort(), [...keys].sort());
  return result.data[0];
}
export function lifecycleHarness(client, owner) {
  const h = saveHarness(client, owner);
  const tracked = [];
  const track = (value) => { const attempt = h.track(value); tracked.push(attempt); return attempt; };
  const create = async (legacy = false) => {
    const value = intent();
    value.p_item.id = '1080' + value.p_item.id.slice(4);
    value.p_image.id = '1080' + value.p_image.id.slice(4);
    track(value);
    if (legacy) {
      await client.insert(owner, 'items', value.p_item);
      await client.insert(owner, 'item_images', { ...value.p_image, item_id: value.p_item.id });
      await h.upload(value);
      await client.rpc(owner, 'commit_image', { p_image_id: value.p_image.id });
    } else {
      const reservation = await h.reserve(value);
      await h.upload(value);
      await h.finalize(value, reservation);
    }
    return value;
  };
  const status = async (value) => {
    const row = one(await h.call('item_deletion_status', { p_item_ids: [value.p_item.id] }), statusKeys);
    eq(row.id, value.p_item.id); eq(row.owner_id, owner.uid);
    requireEvidence(Number.isSafeInteger(row.version) && row.version > 0
      && Number.isSafeInteger(row.photo_count) && row.photo_count >= 0
      && /^[0-9a-f]{64}$/.test(row.image_manifest_sha256));
    return row;
  };
  const trash = async (value, version, trashed = true) => one(await h.call('set_item_trashed', {
    p_item_id: value.p_item.id, p_expected_version: version, p_trashed: trashed,
  }), ['id', 'owner_id', 'version', 'deleted_at']);
  const beginArgs = (value, preview, requestId = randomUUID()) => ({
    p_item_id: value.p_item.id, p_expected_version: preview.version,
    p_request_id: requestId, p_image_manifest_sha256: preview.image_manifest_sha256,
  });
  const begin = async (args) => one(await h.call('begin_item_deletion', args), beginKeys);
  const finish = async (value, requestId) => one(await h.call('finish_item_deletion', {
    p_item_id: value.p_item.id, p_request_id: requestId,
  }), ['state']).state;
  const unchanged = async (value, before) => {
    eq(await h.read('items', value.p_item.id), before.items);
    eq(await h.read('item_images', value.p_image.id), before.images);
    eq(await status(value), before.status);
  };
  const snapshot = async (value) => ({
    items: await h.read('items', value.p_item.id), images: await h.read('item_images', value.p_image.id), status: await status(value),
  });
  const download = async (path) => {
    const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
    requireEvidence(result.ok && result.status === 200 && Buffer.isBuffer(result.data));
    eq(result.data, Buffer.from(bytes));
    eq(createHash('sha256').update(result.data).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  };
  const cleanup = async () => {
    await h.cleanup();
    for (const value of tracked) {
      eq(await h.read('items', value.p_item.id), []);
      eq(await h.read('item_images', value.p_image.id), []);
    }
  };
  return { ...h, track, create, status, trash, beginArgs, begin, finish, unchanged, snapshot, download, cleanup };
}

function savedValues(item) {
  const { deleted_at, updated_at, version, ...values } = item;
  requireEvidence(deleted_at === null || Number.isFinite(Date.parse(deleted_at)));
  requireEvidence(Number.isFinite(Date.parse(updated_at)) && Number.isSafeInteger(version));
  return values;
}
async function removePaths(client, owner, paths) {
  requireEvidence(paths.length > 0 && paths.length <= 40);
  const result = await client.request(owner.token, '/storage/v1/object/wardrobe', { method: 'DELETE', body: { prefixes: paths } });
  requireEvidence(result.ok);
}

async function ownerCases(client, owner, h) {
  const value = await h.create(), original = (await h.read('items', value.p_item.id))[0];
  const preview = await h.status(value), originalImages = await h.read('item_images', value.p_image.id);
  eq(preview.photo_count, 1); eq(preview.current_image_id, value.p_image.id);
  eq(preview.current_thumb_path, h.paths(value)[0]); eq(preview.request_id, null);
  eq(preview.expected_version, null); eq(preview.started_at, null); eq(preview.cleanup_blocked, false);
  eq(preview.unmanifested_count, 0);
  const beforeRead = await h.snapshot(value);
  await h.status(value); await h.unchanged(value, beforeRead);
  const from = Date.now(), trashed = await h.trash(value, original.version);
  requireEvidence(Date.parse(trashed.deleted_at) >= from - 5_000 && Date.parse(trashed.deleted_at) <= Date.now() + 5_000);
  eq(trashed.version, original.version + 1);
  eq(savedValues((await h.read('items', value.p_item.id))[0]), savedValues(original));
  eq(await h.read('item_images', value.p_image.id), originalImages);
  denied(await h.call('set_item_trashed', { p_item_id: value.p_item.id, p_expected_version: original.version, p_trashed: false }));
  const restored = await h.trash(value, trashed.version, false);
  eq(restored.deleted_at, null); eq(restored.version, trashed.version + 1);

  // Explicitly seeded legacy dates exercise either side of seven days, not elapsed-time evidence.
  for (const delta of [-60_000, 60_000]) {
    const row = (await h.read('items', value.p_item.id))[0];
    const seededTime = Date.now() - 7 * 86400_000 + delta;
    const seeded = one(await client.patch(owner, 'items', row, { deleted_at: new Date(seededTime).toISOString() }), Object.keys(row));
    eq(Date.parse(seeded.deleted_at), seededTime); eq(seeded.version, row.version + 1);
    const response = await h.call('set_item_trashed', { p_item_id: value.p_item.id, p_expected_version: seeded.version, p_trashed: false });
    if (delta < 0) denied(response);
    else eq(one(response, ['id', 'owner_id', 'version', 'deleted_at']).deleted_at, null);
  }
  const live = (await h.read('items', value.p_item.id))[0];
  const staleManifest = await h.status(value);
  requireEvidence((await h.call('update_image_description', {
    p_image_id: value.p_image.id, p_expected_description_version: 1, p_alt_text: 'Fictional description revision',
  })).ok);
  await h.trash(value, live.version);
  const current = await h.status(value);
  requireEvidence(current.image_manifest_sha256 !== staleManifest.image_manifest_sha256);
  denied(await h.call('begin_item_deletion', { ...h.beginArgs(value, current), p_image_manifest_sha256: staleManifest.image_manifest_sha256 }));

  const pending = h.track({ p_item: value.p_item, p_image: { ...value.p_image, id: randomUUID() } });
  await client.insert(owner, 'item_images', { ...pending.p_image, item_id: value.p_item.id });
  const withPending = await h.snapshot(value);
  denied(await h.call('begin_item_deletion', h.beginArgs(value, withPending.status)));
  await h.unchanged(value, withPending);
  requireEvidence((await h.call('forget_image', { p_image_id: pending.p_image.id })).ok);

  const finalPreview = await h.status(value), args = h.beginArgs(value, finalPreview);
  const claim = await h.begin(args);
  eq(claim.expected_version, finalPreview.version); eq(claim.version, finalPreview.version + 1);
  eq(claim.image_manifest_sha256, finalPreview.image_manifest_sha256);
  requireEvidence(Number.isFinite(Date.parse(claim.started_at)));
  const claimed = await h.snapshot(value);
  eq(await h.begin(args), claim); await h.unchanged(value, claimed);
  const reloaded = await h.status(value);
  eq([reloaded.request_id, reloaded.expected_version, reloaded.version],
    [args.p_request_id, args.p_expected_version, args.p_expected_version + 1]);
  for (const change of [{ p_request_id: randomUUID() }, { p_expected_version: claim.version }, { p_image_manifest_sha256: '0'.repeat(64) }]) {
    denied(await h.call('begin_item_deletion', { ...args, ...change }));
    await h.unchanged(value, claimed);
  }
  denied(await h.call('set_item_trashed', { p_item_id: value.p_item.id, p_expected_version: claim.version, p_trashed: false }));
  denied(await client.patch(owner, 'items', claimed.items[0], { title: 'Forbidden change' }));
  denied(await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${value.p_item.id}`, { method: 'DELETE' }));
  denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: randomUUID() }));
  denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: args.p_request_id }));
  const insertion = { ...value.p_image, id: randomUUID(), item_id: value.p_item.id, owner_id: owner.uid };
  denied(await client.request(owner.token, '/rest/v1/item_images', { method: 'POST', body: insertion }));
  const retire = await h.call('retire_image', { p_image_id: value.p_image.id });
  denied(retire);
  const description = await h.call('update_image_description', {
    p_image_id: value.p_image.id, p_expected_description_version: 2, p_alt_text: 'Forbidden description',
  });
  requireEvidence(!description.ok && description.status === 403 && description.data.code === '42501');
  await h.unchanged(value, claimed);
  await removePaths(client, owner, [h.paths(value)[0]]);
  denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: args.p_request_id }));
  await h.unchanged(value, claimed); await h.download(h.paths(value)[1]);
  // Explicit status/replay on resume; no replacement nonce or metadata forgetting.
  eq((await h.status(value)).image_manifest_sha256, finalPreview.image_manifest_sha256);
  eq(await h.begin(args), claim);
  await removePaths(client, owner, [h.paths(value)[1]]);
  denied(await h.call('forget_image', { p_image_id: value.p_image.id }));
  eq(await h.finish(value, args.p_request_id), 'completed');
  eq(await h.read('items', value.p_item.id), []); eq(await h.read('item_images', value.p_image.id), []);
  eq(await h.finish(value, args.p_request_id), 'absent');
  eq(await h.finish({ p_item: { id: randomUUID() } }, randomUUID()), 'absent');
  denied(await h.call('reserve_item_save', value));
}

async function historyCase(client, owner, h) {
  const value = await h.create(), peer = await h.create();
  const eventId = randomUUID(), outfitId = randomUUID();
  try {
    await client.rpc(owner, 'save_outfit', { p_id: outfitId, p_title: 'Fictional lifecycle outfit',
      p_occasion: 'everyday', p_notes: '', p_favourite: false, p_item_ids: [value.p_item.id, peer.p_item.id] });
    await client.rpc(owner, 'save_wear_event', { p_id: eventId, p_local_date: '2024-02-29',
      p_timezone: 'Europe/Helsinki', p_state: 'worn', p_label: 'Fictional lifecycle wear',
      p_outfit_id: outfitId, p_item_ids: [value.p_item.id] });
    await client.insert(owner, 'suggestion_feedback', { item_ids: [value.p_item.id, peer.p_item.id], vote: -1 });
    const read = async (table, filter) => {
      const result = await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&${filter}&select=*`);
      requireEvidence(result.ok && Array.isArray(result.data)); return result.data;
    };
    const history = await read('wear_event_items', `event_id=eq.${eventId}`);
    eq(history.length, 1);
    await h.trash(value, 1);
    const args = h.beginArgs(value, await h.status(value)); await h.begin(args); await h.remove(value);
    eq(await h.finish(value, args.p_request_id), 'completed');
    eq(await read('wear_event_items', `event_id=eq.${eventId}`), [{ ...history[0], item_id: null }]);
    const links = await read('outfit_items', `outfit_id=eq.${outfitId}`);
    eq(links.map((row) => row.item_id), [peer.p_item.id]);
    eq(await read('suggestion_feedback', `item_ids=cs.{${value.p_item.id}}`), []);
    await h.download(h.paths(peer)[0]); await h.download(h.paths(peer)[1]);
  } finally {
    for (const [table, id] of [['wear_events', eventId], ['outfits', outfitId]]) {
      const result = await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' });
      requireEvidence(result.ok);
    }
  }
}

async function legacyOrphanCase(client, owner, h) {
  const value = await h.create(true);
  // The deliberate legacy raw DELETE leaves real bytes. Reuse only this exact owned UUID.
  await h.deleteItem(value);
  await client.insert(owner, 'items', value.p_item);
  const blocked = await h.status(value);
  eq(blocked.photo_count, 0); eq(blocked.unmanifested_count, 2); eq(blocked.cleanup_blocked, true);
  const replacement = h.track({ p_item: value.p_item, p_image: { ...value.p_image, id: randomUUID() } });
  await client.insert(owner, 'item_images', { ...replacement.p_image, item_id: value.p_item.id });
  await h.upload(replacement); await client.rpc(owner, 'commit_image', { p_image_id: replacement.p_image.id });
  await h.trash(value, 1);
  const before = await h.snapshot(value);
  denied(await h.call('begin_item_deletion', h.beginArgs(value, before.status)));
  await h.unchanged(value, before);
  eq((await h.trash(value, before.status.version, false)).deleted_at, null);
  // Exact known fixture paths only; this is not a production orphan cleaner.
  await h.remove(value);
}

async function retainedVersionsCase(client, owner, h) {
  const value = await h.create(true);
  const replacement = h.track({ p_item: value.p_item, p_image: { ...value.p_image, id: randomUUID() } });
  await client.insert(owner, 'item_images', { ...replacement.p_image, item_id: value.p_item.id });
  await h.upload(replacement); await client.rpc(owner, 'commit_image', { p_image_id: replacement.p_image.id });
  const old = await h.read('item_images', value.p_image.id), ready = await h.read('item_images', replacement.p_image.id);
  eq(old[0].state, 'retired'); eq(ready[0].state, 'ready');
  await h.trash(value, 1);
  const preview = await h.status(value);
  eq(preview.photo_count, 2); eq(preview.current_image_id, replacement.p_image.id);
  const args = h.beginArgs(value, preview); await h.begin(args);
  await h.remove(value);
  denied(await h.call('forget_image', { p_image_id: value.p_image.id }));
  denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: args.p_request_id }));
  eq(await h.read('item_images', value.p_image.id), old);
  eq(await h.read('item_images', replacement.p_image.id), ready);
  eq((await h.status(value)).image_manifest_sha256, preview.image_manifest_sha256);
  for (const path of h.paths(replacement)) await h.download(path);
  await h.remove(replacement); eq(await h.finish(value, args.p_request_id), 'completed');
  eq(await h.read('item_images', value.p_image.id), []);
  eq(await h.read('item_images', replacement.p_image.id), []);
}

async function raceCases(client, owner, h) {
  // Ordinary bounded samples, NOT proof of forced SQL overlap (separate CI fixture).
  const value = await h.create(true);
  const before = await h.read('item_images', value.p_image.id);
  const start = performance.now();
  const trash = await Promise.all([true, true].map((p_trashed) => h.call('set_item_trashed', {
    p_item_id: value.p_item.id, p_expected_version: 1, p_trashed,
  })));
  eq(trash.filter((result) => result.ok).length, 1);
  for (const result of trash) if (!result.ok) denied(result);
  const preview = await h.status(value), args = h.beginArgs(value, preview);
  const results = await Promise.all([
    h.call('begin_item_deletion', args),
    h.call('set_item_trashed', { p_item_id: value.p_item.id, p_expected_version: preview.version, p_trashed: false }),
  ]);
  eq(results.filter((result) => result.ok).length, 1);
  for (const result of results) if (!result.ok) denied(result);
  const after = await h.status(value);
  eq(after.version, preview.version + 1);
  eq(after.request_id, results[0].ok ? args.p_request_id : null);
  eq(after.deleted_at === null, results[1].ok);
  eq(await h.read('item_images', value.p_image.id), before);
  for (const path of h.paths(value)) await h.download(path);
  requireEvidence(performance.now() - start < 15_000);

  const legacy = await h.create(true);
  const pending = h.track({ p_item: legacy.p_item, p_image: { ...legacy.p_image, id: randomUUID() } });
  await client.insert(owner, 'item_images', { ...pending.p_image, item_id: legacy.p_item.id });
  await h.upload(pending);
  const trashed = await h.trash(legacy, 1);
  const previewWithPending = await h.status(legacy), newArgs = h.beginArgs(legacy, previewWithPending);
  const replacementRace = await Promise.all([
    h.call('begin_item_deletion', newArgs), h.call('commit_image', { p_image_id: pending.p_image.id }),
  ]);
  // A pending manifest cannot become a valid claim while commit changes its state.
  denied(replacementRace[0]);
  if (!replacementRace[1].ok) denied(replacementRace[1]);
  eq((await h.status(legacy)).request_id, null);
  eq((await h.status(legacy)).version, trashed.version);
}

export async function lifecycleFixtureCases(env, { withLifecycleParentLock, withLifecycleCatalogMarker }) {
  const { client, owners } = await saveClients(env);
  requireEvidence(owners.length === 2);
  for (const [index, owner] of owners.entries()) {
    const h = lifecycleHarness(client, owner);
    let phase = 'reserve';
    let primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue;
    const cleanupFailure = (error) => {
      if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; }
    };
    try {
      const value = h.track();
      value.p_item.id = '1080' + value.p_item.id.slice(4);
      const reservation = await h.reserve(value), retainedIntent = structuredClone(value);
      phase = 'held-upload';
      const observation = lifecycleObservation(index + 1);
      try {
        await withLifecycleParentLock(owner.uid, value.p_item.id, 'update', async () => {
          observation.stage = 'holder-ready';
          const result = await readLifecycleUploadResponse(env, owner, value, observation);
          requireLifecycleUploadConflict(result);
          observation.stage = 'classified';
          console.log(`PASS: I08 observed held-parent Storage rejection http=${result.status}; fixed Request conflict; no photo-validation claim`);
          eq(value, retainedIntent); eq(await h.read('items', value.p_item.id), [reservation.item]);
          eq(await h.read('item_images', value.p_image.id), [reservation.image]);
          observation.stage = 'intent-and-rows';
          denied(await client.request(owner.token, '/rest/v1/item_images', { method: 'POST',
            body: { ...value.p_image, id: randomUUID(), owner_id: owner.uid, item_id: value.p_item.id } }));
          observation.stage = 'image-insert-denied';
          await h.status(value); // Must remain nonlocking/read-only while UPDATE is held.
          observation.stage = 'status-read';
        });
        observation.stage = 'released';
      } catch (error) { primaryFailed = true; primaryValue = error; }
      try { console.log(serializeLifecycleObservation(observation)); }
      catch (error) {
        cleanupFailure(error);
        try { console.error('FAIL: I08 held-upload observation'); } catch (noticeError) { cleanupFailure(noticeError); }
      }
      if (primaryFailed) throw primaryValue;
      if (cleanupFailed) throw cleanupValue;
      phase = 'explicit-retry';
      eq(value, retainedIntent); eq(await h.reserve(value), reservation);
      await h.upload(value); await h.finalize(value, reservation);
      await h.download(h.paths(value)[0]); await h.download(h.paths(value)[1]);
      await h.trash(value, 1);
      const args = h.beginArgs(value, await h.status(value)), before = await h.snapshot(value);
      phase = 'begin-overlap';
      await withLifecycleParentLock(owner.uid, value.p_item.id, 'key share', async () => {
        denied(await h.call('begin_item_deletion', args));
        await h.unchanged(value, before);
      });
      await h.begin(args); await h.remove(value);
      phase = 'finish-overlap';
      await withLifecycleParentLock(owner.uid, value.p_item.id, 'key share', async () => {
        denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: args.p_request_id }));
      });
      const claimed = await h.snapshot(value);
      phase = 'catalog-marker-only';
      await withLifecycleCatalogMarker(owner.uid, value.p_item.id, async () => {
        const status = await h.status(value);
        eq(status.cleanup_blocked, true); eq(status.unmanifested_count, 1);
        eq(status.image_manifest_sha256, claimed.status.image_manifest_sha256);
        denied(await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${value.p_item.id}`, { method: 'DELETE' }));
        denied(await h.call('finish_item_deletion', { p_item_id: value.p_item.id, p_request_id: args.p_request_id }));
        eq(await h.read('items', value.p_item.id), claimed.items);
        eq(await h.read('item_images', value.p_image.id), claimed.images);
        eq((await h.status(value)).request_id, args.p_request_id);
      });
      await h.unchanged(value, claimed);
      eq(await h.finish(value, args.p_request_id), 'completed');
      eq(await h.read('items', value.p_item.id), []); eq(await h.read('item_images', value.p_image.id), []);
    } catch (error) {
      primaryFailed = true;
      primaryValue = error;
      try { console.error(`FAIL: I08 fixture ${phase}; ordinary-session evidence required`); }
      catch (noticeError) { cleanupFailure(noticeError); }
    }
    try { await h.cleanup(); } catch (error) {
      cleanupFailure(error);
      try { console.error('FAIL: I08 exact lifecycle fixture cleanup'); } catch (noticeError) { cleanupFailure(noticeError); }
    }
    if (primaryFailed) throw primaryValue;
    if (cleanupFailed) throw cleanupValue;
  }
}

async function main() {
  const harnesses = [];
  let phase = 'arguments';
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await saveClients(process.env);
    harnesses.push(...owners.map((owner) => lifecycleHarness(client, owner)));
    for (const [index, owner] of owners.entries()) {
      const h = harnesses[index], other = owners[1 - index];
      const peer = await harnesses[1 - index].create();
      const before = await Promise.all(TABLES.map((table) => client.rows(other, table)));
      phase = 'versioned-lifecycle'; await ownerCases(client, owner, h);
      phase = 'history'; await historyCase(client, owner, h);
      phase = 'legacy-orphan'; await legacyOrphanCase(client, owner, h);
      phase = 'retained-photo-versions'; await retainedVersionsCase(client, owner, h);
      phase = 'bounded-race-samples'; await raceCases(client, owner, h);
      eq(await Promise.all(TABLES.map((table) => client.rows(other, table))), before);
      for (const path of harnesses[1 - index].paths(peer)) await harnesses[1 - index].download(path);
    }
    console.log('PASS: I08 ordinary-owner integration; owners=2; version/replay, partial real-byte cleanup, history and peer preservation; seeded seven-day boundaries');
  } catch {
    console.error(`FAIL: I08 integration ${phase}; evidence required; private details suppressed`);
    process.exitCode = 1;
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: I08 exact fixture cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
