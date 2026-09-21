import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  assertNoServiceSecrets, validateSessionEnvironment, fail, reportError,
} from '../../scripts/backend/local.mjs';
import { isMain } from '../../scripts/quality/files.mjs';

export const CLEANUP_RPCS = Object.freeze([
  ['image_cleanup_page', {}],
  ['image_cleanup_claims', {}],
  ['image_cleanup_status', { p_request_id: '10000000-0000-4000-8000-000000000001' }],
  ['begin_image_cleanup', {
    p_request_id: '10000000-0000-4000-8000-000000000001',
    p_item_id: '10000000-0000-4000-8000-000000000002',
    p_image_id: '10000000-0000-4000-8000-000000000003', p_manifest_sha256: '0'.repeat(64),
  }],
  ['finish_image_cleanup', { p_request_id: '10000000-0000-4000-8000-000000000001' }],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const JPEG = new Uint8Array([255, 216, 255, 217]);
export const CLEANUP_IMAGE_HASH = createHash('sha256').update(JPEG).digest('hex');

export function cleanupImageRow(value) {
  return {
    id: value.imageId, owner_id: value.ownerId, item_id: value.itemId,
    main_bytes: JPEG.length, thumb_bytes: JPEG.length, main_sha256: CLEANUP_IMAGE_HASH,
    thumb_sha256: CLEANUP_IMAGE_HASH, width: 1, height: 1, alt_text: 'Cleanup fixture',
  };
}

export function requireCleanup(condition, code = 'contract') {
  if (!condition) fail(`FAIL: image cleanup ${code}.`, 1);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function cleanupClient(env) {
  validateSessionEnvironment(env);
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options = {}) => fetch(url, {
      ...options, cache: 'no-store', redirect: 'error', credentials: 'omit',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }) },
  });
}

export async function withCleanupOwners(operation, env = process.env) {
  assertNoServiceSecrets(env);
  validateSessionEnvironment(env);
  const owners = [];
  let primary;
  let failed = false;
  let cleanupFailed = false;
  try {
    for (const label of ['A', 'B']) {
      const client = cleanupClient(env);
      owners.push({ client });
      const login = await client.auth.signInWithPassword({
        email: env[`TEST_${label}_EMAIL`], password: env[`TEST_${label}_PASSWORD`],
      });
      requireCleanup(!login.error && login.data.session, 'ordinary-login');
      const verified = await client.auth.getUser();
      requireCleanup(!verified.error && UUID.test(verified.data.user?.id), 'verified-owner');
      const owner = owners.at(-1);
      owner.uid = verified.data.user.id;
      owner.token = login.data.session.access_token;
      owner.url = env.SUPABASE_URL;
      owner.key = env.SUPABASE_PUBLISHABLE_KEY;
      const profile = await client.from('profiles').select('*').eq('owner_id', owner.uid).single();
      requireCleanup(!profile.error && profile.data?.owner_id === owner.uid, 'enabled-owner');
      owner.profile = profile.data;
    }
    requireCleanup(owners[0].uid !== owners[1].uid, 'independent-owners');
    await operation(owners);
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    for (const owner of owners) {
      try {
        if (owner.profile) {
          const profile = await owner.client.from('profiles').select('*').eq('owner_id', owner.uid).single();
          requireCleanup(!profile.error && JSON.stringify(profile.data) === JSON.stringify(owner.profile), 'profile-preservation');
        }
      } catch {
        cleanupFailed = true;
      }
      try {
        const signedOut = await owner.client.auth.signOut({ scope: 'local' });
        if (signedOut.error) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (failed && cleanupFailed) fail('FAIL: image cleanup primary and session teardown.', 1);
  if (cleanupFailed) fail('FAIL: image cleanup session teardown.', 1);
  if (failed) throw primary;
}

export function newCleanupFixture(ownerId, options = {}) {
  requireCleanup(UUID.test(ownerId), 'fixture-owner');
  const itemId = options.itemId ?? randomUUID();
  const imageId = options.imageId ?? randomUUID();
  requireCleanup(UUID.test(itemId) && UUID.test(imageId), 'fixture-identity');
  return Object.freeze({
    ownerId, itemId, imageId, requestId: randomUUID(),
    main: `${ownerId}/${itemId}/${imageId}/main.jpg`,
    thumb: `${ownerId}/${itemId}/${imageId}/thumb.jpg`,
  });
}

export async function createCleanupFixture(owner, value, { newItem = true, upload = true, ready = false } = {}) {
  requireCleanup(value.ownerId === owner.uid, 'fixture-scope');
  if (newItem) {
    const item = await owner.client.from('items').insert({
      id: value.itemId, owner_id: owner.uid, title: 'Cleanup fixture', category: 'top',
    });
    requireCleanup(!item.error, 'fixture-item');
  }
  const image = await owner.client.from('item_images').insert(cleanupImageRow(value));
  requireCleanup(!image.error, 'fixture-image');
  if (upload) for (const path of [value.main, value.thumb]) {
    const result = await owner.client.storage.from('wardrobe').upload(path, JPEG, {
      contentType: 'image/jpeg', cacheControl: '0', upsert: false,
    });
    requireCleanup(!result.error, 'fixture-upload');
  }
  if (ready) requireCleanup(!(await owner.client.rpc('commit_image', { p_image_id: value.imageId })).error, 'fixture-ready');
}

export async function cleanupRpc(owner, name, args = {}) {
  const result = await owner.client.rpc(name, args);
  requireCleanup(!result.error && result.data !== null, 'rpc');
  return result.data;
}

export function checkCleanupPage(value, ownerId) {
  requireCleanup(exactKeys(value, ['owner_id', 'observed_at', 'candidates', 'next', 'review_reasons', 'pending_grace'])
    && value.owner_id === ownerId && Number.isFinite(Date.parse(value.observed_at))
    && Array.isArray(value.candidates) && value.candidates.length <= 20
    && exactKeys(value.review_reasons, ['unsupported_paths', 'unverifiable_metadata'])
    && typeof value.review_reasons.unsupported_paths === 'boolean'
    && typeof value.review_reasons.unverifiable_metadata === 'boolean'
    && typeof value.pending_grace === 'boolean', 'page-shape');
  let previous = '';
  for (const candidate of value.candidates) {
    requireCleanup(exactKeys(candidate, ['item_id', 'image_id', 'kind', 'manifest_sha256', 'object_count'])
      && UUID.test(candidate.item_id) && UUID.test(candidate.image_id)
      && ['pending', 'retired', 'orphan'].includes(candidate.kind) && HASH.test(candidate.manifest_sha256)
      && Number.isInteger(candidate.object_count) && candidate.object_count >= (candidate.kind === 'orphan' ? 1 : 0)
      && candidate.object_count <= 2, 'candidate-shape');
    const key = `${candidate.item_id}/${candidate.image_id}`;
    requireCleanup(previous < key, 'candidate-order');
    previous = key;
  }
  requireCleanup(value.next === null || (exactKeys(value.next, ['item_id', 'image_id'])
    && value.candidates.length === 20 && value.next.item_id === value.candidates.at(-1).item_id
    && value.next.image_id === value.candidates.at(-1).image_id), 'page-cursor');
  return value;
}

export async function readCleanupPages(owner) {
  const deadline = performance.now() + 30_000;
  const candidates = [];
  let cursor = {};
  let last = '';
  do {
    requireCleanup(performance.now() < deadline, 'scan-timeout');
    const page = checkCleanupPage(await cleanupRpc(owner, 'image_cleanup_page', cursor), owner.uid);
    requireCleanup(performance.now() < deadline, 'scan-timeout');
    for (const candidate of page.candidates) {
      const key = `${candidate.item_id}/${candidate.image_id}`;
      requireCleanup(last < key, 'scan-progress');
      last = key;
      candidates.push(candidate);
    }
    if (page.next === null) return candidates;
    cursor = { p_after_item_id: page.next.item_id, p_after_image_id: page.next.image_id };
  } while (performance.now() < deadline);
  fail('FAIL: image cleanup incomplete scan.', 1);
}

export function checkCleanupStatus(value, ownerId, requestId) {
  requireCleanup(value?.owner_id === ownerId && value.request_id === requestId, 'status-owner');
  if (value.state === 'not_started') {
    requireCleanup(exactKeys(value, ['owner_id', 'request_id', 'state']), 'not-started-shape');
  } else if (value.state === 'completed') {
    requireCleanup(exactKeys(value, ['owner_id', 'request_id', 'item_id', 'image_id', 'state'])
      && UUID.test(value.item_id) && UUID.test(value.image_id), 'completed-shape');
  } else {
    requireCleanup(value.state === 'active'
      && exactKeys(value, ['owner_id', 'request_id', 'item_id', 'image_id', 'kind', 'state', 'manifest_sha256', 'paths'])
      && UUID.test(value.item_id) && UUID.test(value.image_id) && HASH.test(value.manifest_sha256)
      && ['pending', 'retired', 'orphan'].includes(value.kind)
      && Array.isArray(value.paths) && value.paths.length === 2, 'active-shape');
    for (const [index, role] of ['main', 'thumb'].entries()) {
      const entry = value.paths[index];
      requireCleanup(exactKeys(entry, ['role', 'path', 'present']) && entry.role === role
        && entry.path === `${ownerId}/${value.item_id}/${value.image_id}/${role}.jpg`
        && typeof entry.present === 'boolean', 'active-path');
    }
  }
  return value;
}

// Independent test transport, not a replacement for the application's singular-delete helper.
export async function removeCleanupObject(owner, path) {
  const segments = typeof path === 'string' ? path.split('/') : [];
  requireCleanup(segments.length === 4 && segments[0] === owner.uid && UUID.test(segments[0])
    && UUID.test(segments[1]) && UUID.test(segments[2]) && ['main.jpg', 'thumb.jpg'].includes(segments[3]), 'delete-scope');
  const response = await fetch(`${owner.url}/storage/v1/object/wardrobe/${path}`, {
    method: 'DELETE', headers: { apikey: owner.key, Authorization: `Bearer ${owner.token}` },
    cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
  });
  const reader = response.body?.getReader();
  requireCleanup(reader, 'delete-response');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireCleanup(size <= 4096, 'delete-response-limit');
      chunks.push(part.value);
    }
  } finally {
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('FAIL: image cleanup malformed deletion response.', 1); }
  if (response.status === 200 && exactKeys(body, ['message']) && body.message === 'Successfully deleted') return 'removed';
  if (response.status === 400 && exactKeys(body, ['statusCode', 'code', 'error', 'message'])
    && body.statusCode === '404' && body.code === 'NoSuchKey' && body.error === 'not_found'
    && body.message === 'Object not found') return 'missing';
  fail('FAIL: image cleanup singular-delete acknowledgement.', 1);
}

export async function resumeCleanupFixture(owner, value) {
  const deadline = performance.now() + 30_000;
  let status = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {
    p_request_id: value.requestId,
  }), owner.uid, value.requestId);
  requireCleanup(status.state !== 'not_started', 'resume-unstarted');
  if (status.state === 'completed') return status;
  requireCleanup(status.item_id === value.itemId && status.image_id === value.imageId, 'resume-target');
  for (const entry of status.paths) if (entry.present) {
    requireCleanup(performance.now() < deadline, 'resume-timeout');
    requireCleanup(await removeCleanupObject(owner, entry.path) === 'removed', 'claimed-removal');
  }
  requireCleanup(performance.now() < deadline, 'resume-timeout');
  status = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {
    p_request_id: value.requestId,
  }), owner.uid, value.requestId);
  requireCleanup(status.state === 'active' && status.paths.every((entry) => !entry.present), 'catalog-absence');
  const completed = checkCleanupStatus(await cleanupRpc(owner, 'finish_image_cleanup', {
    p_request_id: value.requestId,
  }), owner.uid, value.requestId);
  requireCleanup(completed.state === 'completed', 'checked-completion');
  requireCleanup(performance.now() < deadline, 'resume-timeout');
  return completed;
}

export async function destroyCleanupFixture(owner, value) {
  const status = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {
    p_request_id: value.requestId,
  }), owner.uid, value.requestId);
  if (status.state === 'active') await resumeCleanupFixture(owner, value);
  for (const path of [value.main, value.thumb]) await removeCleanupObject(owner, path);
  requireCleanup(!(await owner.client.rpc('forget_image', { p_image_id: value.imageId })).error, 'fixture-forget');
  requireCleanup(!(await owner.client.from('items').delete().eq('owner_id', owner.uid).eq('id', value.itemId)).error, 'fixture-delete');
}

export async function runCleanupIntegration() {
  await withCleanupOwners(async ([owner, peer]) => {
    const value = newCleanupFixture(owner.uid);
    let primary;
    let failed = false;
    let teardownFailed = false;
    try {
      await createCleanupFixture(owner, value);
      const page = checkCleanupPage(await cleanupRpc(owner, 'image_cleanup_page'), owner.uid);
      requireCleanup(page.pending_grace && !page.candidates.some((c) => c.image_id === value.imageId), 'pending-grace');
      requireCleanup(!(await readCleanupPages(peer)).some((c) => c.image_id === value.imageId), 'peer-preview');
      const status = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {
        p_request_id: value.requestId,
      }), owner.uid, value.requestId);
      requireCleanup(status.state === 'not_started', 'fresh-request');
      const begin = await owner.client.rpc('begin_image_cleanup', {
        p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
        p_manifest_sha256: '0'.repeat(64),
      });
      requireCleanup(begin.error?.code === '22023', 'young-refusal');
      requireCleanup((await owner.client.rpc('finish_image_cleanup', { p_request_id: value.requestId })).error?.code === '22023', 'unstarted-finish');
      requireCleanup((await owner.client.rpc('image_cleanup_page', { p_after_item_id: value.itemId })).error?.code === '22023', 'partial-cursor');
      requireCleanup((await owner.client.rpc('image_cleanup_status', { p_request_id: null })).error?.code === '22023', 'null-request');
      const claims = await cleanupRpc(owner, 'image_cleanup_claims');
      requireCleanup(exactKeys(claims, ['owner_id', 'claims', 'next']) && claims.owner_id === owner.uid
        && Array.isArray(claims.claims) && claims.claims.length <= 20
        && !claims.claims.some((c) => c.request_id === value.requestId), 'no-refused-claim');
      requireCleanup(!(await owner.client.rpc('commit_image', { p_image_id: value.imageId })).error, 'ready-after-refusal');
      for (const path of [value.main, value.thumb]) {
        requireCleanup(await removeCleanupObject(owner, path) === 'removed', 'ready-missing-setup');
      }
      requireCleanup(!(await readCleanupPages(owner)).some((c) => c.image_id === value.imageId), 'ready-missing-ineligible');
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      try { await destroyCleanupFixture(owner, value); } catch { teardownFailed = true; }
    }
    if (failed && teardownFailed) fail('FAIL: image cleanup integration and fixture teardown.', 1);
    if (teardownFailed) fail('FAIL: image cleanup integration fixture teardown.', 1);
    if (failed) throw primary;
  });
  console.log('PASS: image cleanup ordinary protocol and non-aged refusals; aged cases belong to the guarded rehearsal.');
}

if (isMain(import.meta.url)) runCleanupIntegration().catch(reportError);
