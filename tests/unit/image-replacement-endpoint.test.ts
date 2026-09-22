import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageChangeFinalizer } from '../../supabase/functions/finalize-image-change/handler';
import { createFinalizer } from '../../supabase/functions/finalize-analyzed-item/handler';
import { verifyStoredImage } from '../../supabase/functions/finalize-analyzed-item/verify-image';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers';

vi.mock('../../supabase/functions/finalize-analyzed-item/verify-image', { spy: true });

const owner = '10000000-0000-4000-8000-000000000001';
const item = '20000000-0000-4000-8000-000000000001';
const image = '30000000-0000-4000-8000-000000000001';
const source = '30000000-0000-4000-8000-000000000002';
const requestId = '40000000-0000-4000-8000-000000000001';
const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'public-fixture', serviceKey: 'service-fixture' };
const bytes = jpegHeaderFixture();
const hash = createHash('sha256').update(bytes).digest('hex');
const normalBearer = 'Bearer '.concat('image-change-fixture');
const baseIntent = { requestId, itemId: item, imageId: image, expectedVersion: 4, currentImageId: source,
  descriptionVersion: 1, item: {}, image: {}, claim: null, sourceImageId: null };
const request = (input: unknown = { action: 'complete', intent: baseIntent }, signal?: AbortSignal, headers = {}) =>
  new Request('http://127.0.0.1/functions/v1/finalize-image-change', {
    method: 'POST', headers: { Authorization: normalBearer, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input), signal,
  });
function setup(recovery = false) {
  const id = recovery ? source : image;
  const prefix = `${owner}/${item}/${id}`;
  const preflight = {
    image: { id, item_id: item, owner_id: owner, width: 120, height: 80,
      main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`,
      main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: hash, thumb_sha256: hash,
      state: recovery ? 'retired' : 'pending', retired_at: recovery ? '2026-09-22T00:00:00Z' : null,
      description_version: 1, alt_text: 'Synthetic garment', created_at: '2026-09-20T00:00:00Z' },
    objects: { main: { id: requestId, version: 'main-version' }, thumb: { id: image, version: 'thumb-version' } },
    state: recovery ? 'source' : 'reserved',
  };
  const intent = { ...baseIntent, sourceImageId: recovery ? source : null };
  const receipt = { requestId, itemId: item, imageId: image, kind: 'recovery', state: 'reserved',
    fingerprint: 'a'.repeat(64), completedVersion: null };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const normal = (path: string) => {
    if (path.endsWith('/auth/v1/user')) return Response.json({ id: owner, role: 'authenticated', is_anonymous: false });
    if (path.endsWith('_preflight')) return Response.json(preflight);
    if (path.includes('/storage/v1/object/authenticated/')) return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
    if (path.endsWith('/complete_image_change')) return new Response(null, { status: 204 });
    if (path.endsWith('/reserve_image_recovery')) return Response.json(receipt);
    throw new Error('Unexpected route');
  };
  let respond = normal;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init }); return respond(path);
  }));
  return { handler: createImageChangeFinalizer(config), calls, preflight, receipt, intent, prefix, normal,
    input: { action: recovery ? 'accept-recovery' : 'complete', intent },
    respond(fn: typeof normal) { respond = fn; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('checked image changes (synthetic endpoint transport, not live backend proof)', () => {
  it.each(['add', 'complete', 'accept-recovery'])('passes only ordinary-user transport to the real verifier for %s', async (action) => {
    const a = setup(action === 'accept-recovery');
    a.respond((path) => path.endsWith('/complete_analyzed_item_save') ? new Response(null, { status: 204 }) : a.normal(path));
    const response = action === 'add'
      ? await createFinalizer(config)(new Request('http://127.0.0.1/functions/v1/finalize-analyzed-item', {
        method: 'POST', headers: { Authorization: normalBearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item, imageId: image, fingerprint: 'a'.repeat(64) }),
      }))
      : await a.handler(request(a.input));
    expect(response.status).toBe(action === 'accept-recovery' ? 200 : 204);
    expect(verifyStoredImage).toHaveBeenCalledOnce();
    const transport = vi.mocked(verifyStoredImage).mock.calls[0]![2];
    expect(Object.keys(transport).sort()).toEqual(['bearer', 'publicKey', 'signal', 'supabaseUrl']);
    expect(transport).toEqual({ supabaseUrl: config.supabaseUrl, publicKey: config.publicKey,
      bearer: normalBearer, signal: expect.any(AbortSignal) });
    expect(transport).not.toHaveProperty('serviceKey');
    expect(a.calls.filter((call) => call.path.includes('/storage/'))).toHaveLength(2);
  });
  it.each([false, true])('verifies both authenticated JPEGs before service-only completion/acceptance recovery=%s', async (recovery) => {
    const a = setup(recovery);
    const result = await a.handler(request(a.input));
    expect(result.status).toBe(recovery ? 200 : 204);
    expect(a.calls.map((c) => c.path)).toEqual([
      '/auth/v1/user', `/rest/v1/rpc/${recovery ? 'image_recovery_preflight' : 'image_change_preflight'}`,
      `/storage/v1/object/authenticated/wardrobe/${a.prefix}/main.jpg`,
      `/storage/v1/object/authenticated/wardrobe/${a.prefix}/thumb.jpg`,
      `/rest/v1/rpc/${recovery ? 'reserve_image_recovery' : 'complete_image_change'}`,
    ]);
    expect(JSON.parse(String(a.calls.at(-1)?.init?.body))).toEqual({
      p_owner_id: owner, p_intent: a.intent, p_objects: a.preflight.objects,
    });
    for (const call of a.calls) {
      expect(call.init?.redirect).toBe('error'); expect(call.init?.cache).toBe('no-store');
      expect(new Headers(call.init?.headers).get('Authorization')).toBe(
        call === a.calls.at(-1) ? 'Bearer '.concat(config.serviceKey) : normalBearer);
    }
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('returns an exact already-accepted recovery without rereading an expired or absent source', async () => {
    const a = setup(true);
    a.respond((path) => path.endsWith('_preflight') ? Response.json({ receipt: a.receipt }) : a.normal(path));
    const result = await a.handler(request(a.input));
    expect(result.status).toBe(200); expect(await result.json()).toEqual(a.receipt);
    expect(a.calls.map((c) => c.path)).toEqual(['/auth/v1/user', '/rest/v1/rpc/image_recovery_preflight']);
  });
  it.each([{ imageId: source }, { requestId: image }, { kind: 'replacement' }, { state: 'cancelled' },
    { completedVersion: 2 }, { fingerprint: 'bad' }, { extra: true }])('rejects drifted accepted recovery receipt %#', async (drift) => {
    const a = setup(true);
    a.respond((path) => path.endsWith('_preflight') ? Response.json({ receipt: { ...a.receipt, ...drift } }) : a.normal(path));
    expect((await a.handler(request(a.input))).status).toBe(409); expect(a.calls).toHaveLength(2);
  });
  it('reverifies completed destination bytes without upload or changed IDs', async () => {
    const a = setup(); a.preflight.state = 'completed'; a.preflight.image.state = 'ready';
    expect((await a.handler(request(a.input))).status).toBe(204);
    expect(a.calls.filter((c) => c.path.includes('/storage/') && c.init?.method === 'POST')).toHaveLength(0);
    expect(a.calls.filter((c) => c.path.includes('/storage/'))).toHaveLength(2);
  });
  it.each([null, {}, { action: 'anything', intent: baseIntent },
    { action: 'complete', intent: { ...baseIntent, ownerId: owner } },
    { action: 'complete', intent: { ...baseIntent, expectedVersion: 1.5 } },
    { action: 'accept-recovery', intent: baseIntent },
    { action: 'complete', intent: baseIntent, url: 'https://example.test' }])('rejects malformed envelope %# before Auth', async (input) => {
    const a = setup(); expect((await a.handler(request(input))).status).toBe(400); expect(a.calls).toHaveLength(0);
  });
  it('enforces the full envelope byte bound without relaxing the old finalizer', async () => {
    const a = setup();
    expect((await a.handler(request({ action: 'complete', intent: { ...baseIntent, item: { notes: 'a'.repeat(49152) } } }))).status).toBe(400);
    expect(a.calls).toHaveLength(0);
  });
  it.each([false, true])('rejects anonymous/service identities before preflight anonymous=%s', async (anonymous) => {
    const a = setup(); a.respond(() => Response.json({ id: owner, role: anonymous ? 'authenticated' : 'service_role', is_anonymous: anonymous }));
    expect((await a.handler(request())).status).toBe(401); expect(a.calls).toHaveLength(1);
  });
  it.each(['main', 'thumb'])('does not accept source proof for corrupt %s bytes', async (variant) => {
    const a = setup(true);
    a.respond((path) => path.endsWith(`/${variant}.jpg`)
      ? new Response(jpegHeaderFixture(121, 80), { headers: { 'Content-Type': 'image/jpeg' } }) : a.normal(path));
    expect((await a.handler(request(a.input))).status).toBe(409);
    expect(a.calls.some((c) => c.path.endsWith('/reserve_image_recovery'))).toBe(false);
  });
  it.each([404, 403, 500])('does not turn unreadable source %s into acceptance', async (status) => {
    const a = setup(true);
    a.respond((path) => path.endsWith('/main.jpg') ? new Response(null, { status }) : a.normal(path));
    expect((await a.handler(request(a.input))).status).toBe(status === 404 ? 409 : 502);
    expect(a.calls.some((c) => c.path.endsWith('/reserve_image_recovery'))).toBe(false);
  });
  it.each([1, 2, 3, 4])('stops after aborted asynchronous boundary %s', async (boundary) => {
    const a = setup(), controller = new AbortController();
    a.respond((path) => { const result = a.normal(path); if (a.calls.length === boundary) controller.abort(); return result; });
    expect((await a.handler(request(a.input, controller.signal))).status).toBe(504);
    expect(a.calls.some((c) => c.path.endsWith('/complete_image_change'))).toBe(false);
  });
  it('rechecks source-age and catalogue tuple conflict at acceptance without leaking private errors', async () => {
    const a = setup(true);
    a.respond((path) => path.endsWith('/reserve_image_recovery')
      ? Response.json({ code: '22023', message: 'Request conflict', details: null, hint: null }, { status: 400 }) : a.normal(path));
    const result = await a.handler(request(a.input));
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ code: 'CONFLICT' });
  });
});
