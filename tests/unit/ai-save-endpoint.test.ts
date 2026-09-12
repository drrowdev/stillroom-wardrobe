import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinalizer } from '../../supabase/functions/finalize-analyzed-item/handler';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers';

const owner = '10000000-0000-4000-8000-000000000001';
const item = '20000000-0000-4000-8000-000000000001';
const image = '30000000-0000-4000-8000-000000000001';
const object = '40000000-0000-4000-8000-000000000001';
const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'public-fixture', serviceKey: 'service-fixture' };
const body = { itemId: item, imageId: image, fingerprint: 'a'.repeat(64) };
const bytes = jpegHeaderFixture();
const hash = createHash('sha256').update(bytes).digest('hex');
const prefix = `${owner}/${item}/${image}`;
const request = (input: unknown = body, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new Request('http://127.0.0.1/functions/v1/finalize-analyzed-item', {
    method: 'POST', headers: { Authorization: 'Bearer ordinary.fixture', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input), signal,
  });
function setup() {
  const preflight = {
    image: { id: image, item_id: item, owner_id: owner, width: 120, height: 80,
      main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`,
      main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: hash, thumb_sha256: hash,
      state: 'pending', retired_at: null, description_version: 1, alt_text: '', created_at: '2026-09-12T00:00:00Z' },
    objects: { main: { id: object, version: 'opaque-main' },
      thumb: { id: '40000000-0000-4000-8000-000000000002', version: 'opaque-thumb' } }, state: 'reserved',
  };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const normal = (path: string) => {
    if (path.endsWith('/auth/v1/user')) return Response.json({ id: owner, role: 'authenticated', is_anonymous: false });
    if (path.endsWith('/analyzed_item_save_preflight')) return Response.json(preflight);
    if (path.includes('/storage/v1/object/authenticated/')) return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
    if (path.endsWith('/complete_analyzed_item_save')) return new Response(null, { status: 204 });
    throw new Error('Unexpected route');
  };
  let respond = normal;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname; calls.push({ path, init });
    return respond(path);
  }));
  return { handler: createFinalizer(config), preflight, calls, normal, respond: (fn: typeof normal) => { respond = fn; } };
}
afterEach(() => vi.unstubAllGlobals());
describe('synchronous byte finalizer (synthetic transport; not real Storage proof)', () => {
  it('verifies real response bytes and submits the same opaque object identities only to the service RPC', async () => {
    const a = setup();
    const response = await a.handler(request());
    expect(response.status).toBe(204); expect(response.body).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(a.calls.map((c) => c.path)).toEqual([
      '/auth/v1/user', '/rest/v1/rpc/analyzed_item_save_preflight',
      `/storage/v1/object/authenticated/wardrobe/${prefix}/main.jpg`,
      `/storage/v1/object/authenticated/wardrobe/${prefix}/thumb.jpg`,
      '/rest/v1/rpc/complete_analyzed_item_save',
    ]);
    for (const call of a.calls) {
      expect(call.init?.redirect).toBe('error'); expect(call.init?.cache).toBe('no-store');
      expect(new Headers(call.init?.headers).get('Authorization')).toBe(call === a.calls.at(-1) ? 'Bearer service-fixture' : 'Bearer ordinary.fixture');
    }
    expect(JSON.parse(String(a.calls.at(-1)?.init?.body))).toEqual({
      p_owner_id: owner, p_item_id: item, p_image_id: image, p_fingerprint: body.fingerprint, p_objects: a.preflight.objects,
    });
  });
  it.each([null, {}, [], { ...body, ownerId: owner }, { ...body, url: 'https://example.test' },
    { ...body, fingerprint: 'bad' }, { ...body, imageId: item.toUpperCase().replace('2', 'Z') }])('rejects malformed request %# before upstream calls', async (value) => {
    const a = setup(); const result = await a.handler(request(value));
    expect(result.status).toBe(400); expect(a.calls).toHaveLength(0);
  });
  it.each([{ id: owner, role: 'service_role', is_anonymous: false },
    { id: owner, role: 'authenticated', is_anonymous: true }, { role: 'authenticated' }])('rejects non-ordinary Auth %#', async (user) => {
    const a = setup(); a.respond(() => Response.json(user));
    expect((await a.handler(request())).status).toBe(401); expect(a.calls).toHaveLength(1);
  });
  it.each(['owner_id', 'main_path', 'thumb_path', 'main_bytes', 'main_sha256', 'width', 'description_version', 'state'])(
    'rejects changed metadata %s or bytes without completion', async (key) => {
      const a = setup();
      const changed: Record<string, unknown> = { ...a.preflight.image,
        [key]: ['main_bytes', 'width', 'description_version'].includes(key) ? 999 : 'foreign' };
      a.respond((path) => path.endsWith('/analyzed_item_save_preflight')
        ? Response.json({ ...a.preflight, image: changed }) : a.normal(path));
      const response = await a.handler(request());
      expect(response.status).toBe(409);
      expect(a.calls.some((c) => c.path.endsWith('/complete_analyzed_item_save'))).toBe(false);
    },
  );
  it.each([null, '', 1, 'x'.repeat(1025)])('rejects invalid opaque version %#', async (version) => {
    const a = setup();
    a.respond((path) => path.endsWith('/analyzed_item_save_preflight') ? Response.json({ ...a.preflight,
      objects: { ...a.preflight.objects, main: { id: object, version } } }) : a.normal(path));
    expect((await a.handler(request())).status).toBe(409); expect(a.calls).toHaveLength(2);
  });
  it.each(['main', 'thumb'])('hashes the entire %s body instead of trusting a matching metadata hash', async (variant) => {
    const a = setup();
    a.respond((path) => path.endsWith(`/${variant}.jpg`)
      ? new Response(jpegHeaderFixture(121, 80), { headers: { 'Content-Type': 'image/jpeg' } }) : a.normal(path));
    expect((await a.handler(request())).status).toBe(409);
    expect(a.calls.some((c) => c.path.endsWith('/complete_analyzed_item_save'))).toBe(false);
  });
  it('requires valid sanitized JPEG structure even when a content hash matches', async () => {
    const a = setup(); const wrong = new Uint8Array(bytes.length);
    a.preflight.image.main_sha256 = createHash('sha256').update(wrong).digest('hex');
    a.respond((path) => path.endsWith('/main.jpg') ? new Response(wrong, { headers: { 'Content-Type': 'image/jpeg' } }) : a.normal(path));
    expect((await a.handler(request())).status).toBe(409);
  });
  it('repeats byte verification for completed retries', async () => {
    const a = setup(); a.preflight.state = 'completed'; a.preflight.image.state = 'ready';
    expect((await a.handler(request())).status).toBe(204);
    expect(a.calls.filter((c) => c.path.includes('/authenticated/'))).toHaveLength(2);
  });
  it('propagates an object-version conflict after the downloads without exposing private errors', async () => {
    const a = setup();
    a.respond((path) => path.endsWith('/complete_analyzed_item_save')
      ? Response.json({ code: '22023', message: 'Request conflict', details: null, hint: null }, { status: 400 }) : a.normal(path));
    const response = await a.handler(request());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: 'CONFLICT' });
    a.respond(() => Response.json({ detail: 'private' }, { status: 500 }));
    expect(await (await a.handler(request())).json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
  it.each([1, 2, 3, 4])('does not complete after cancellation at upstream boundary %s', async (boundary) => {
    const a = setup(), controller = new AbortController();
    a.respond((path) => {
      const response = a.normal(path);
      if (a.calls.length === boundary) controller.abort();
      return response;
    });
    expect((await a.handler(request(body, {}, controller.signal))).status).toBe(504);
    expect(a.calls.some((c) => c.path.endsWith('/complete_analyzed_item_save'))).toBe(false);
  });
  it('fails closed on unknown origins and keeps the exact preflight method/header contract', async () => {
    const a = setup();
    expect((await a.handler(request(body, { Origin: 'https://example.test' }))).status).toBe(403);
    const response = await a.handler(new Request('http://127.0.0.1/finalize-analyzed-item', {
      method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type' },
    }));
    expect(response.status).toBe(204); expect(a.calls).toHaveLength(0);
  });
});
