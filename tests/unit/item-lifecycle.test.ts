import { createClient, type Session } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmsTrash, deletionIntent, lifecycleBudgetMs, matchesClaim, parseBeginReply, parseDeletionStatuses,
  parseFinishReply, parseLifecycleImages, parseLifecycleSnapshot, parseTrashReply, requireLifecycleIds, safeVersion,
  type DeletionStatus,
} from '../../src/domain/item-lifecycle';
import { ItemLifecycleClient } from '../../src/data/item-lifecycle';
import type { Database } from '../../src/data/database.types';
import { newGarmentDraft, editGarmentField, validateGarmentDraft } from '../../src/domain/garment-fields';

const owner = '10000000-0000-4000-8000-000000000001', id = '20000000-0000-4000-8000-000000000001';
const imageId = '30000000-0000-4000-8000-000000000001', nonce = '40000000-0000-4000-8000-000000000001';
const now = '2026-09-14T12:00:00Z', hash = 'a'.repeat(64);
const status: DeletionStatus = {
  id, owner_id: owner, title: 'Fictional shirt', version: 2, deleted_at: now, photo_count: 1, current_image_id: imageId,
  current_thumb_path: `${owner}/${id}/${imageId}/thumb.jpg`, image_manifest_sha256: hash,
  cleanup_blocked: false, unmanifested_count: 0, request_id: null, expected_version: null, started_at: null,
};
const image = { id: imageId, owner_id: owner, item_id: id, state: 'ready', retired_at: null,
  main_path: `${owner}/${id}/${imageId}/main.jpg`, thumb_path: status.current_thumb_path };
const claim = { ...status, version: 3, request_id: nonce, expected_version: 2, started_at: now };
const intent = deletionIntent(status, 1, nonce);
const begin = [{ request_id: nonce, expected_version: 2, version: 3, started_at: now, image_manifest_sha256: hash }];
const missing = { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' };
const denied = { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
function row() {
  let draft = newGarmentDraft('EUR', 'en');
  draft = editGarmentField(draft, 'title', 'Fictional shirt', 'en');
  draft = editGarmentField(draft, 'category', 'top', 'en');
  const validated = validateGarmentDraft(draft);
  if (!validated.values) throw new Error('Invalid unit fixture.');
  return { ...validated.values, id, owner_id: owner, version: 2, deleted_at: now, field_provenance: {},
    created_at: now, updated_at: now };
}
function harness(options: { deleteReply?: () => Promise<Response> | Response; lose?: 'begin' | 'finish'; images?: unknown[] } = {}) {
  const requests: { url: URL; method: string; body: string | null; headers: Headers; init: RequestInit }[] = [];
  const initial = { ...status, photo_count: options.images?.length ?? 1 };
  let claimed = false;
  const transport = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null, headers: new Headers(init.headers), init });
    if (url.pathname.endsWith('/item_deletion_status')) return json([claimed ? { ...claim, photo_count: initial.photo_count } : initial]);
    if (url.pathname.endsWith('/begin_item_deletion')) { claimed = true; if (options.lose === 'begin') throw new TypeError('fictional delivery loss'); return json(begin); }
    if (url.pathname.endsWith('/finish_item_deletion')) { if (options.lose === 'finish') throw new TypeError('fictional delivery loss'); return json([{ state: 'completed' }]); }
    if (url.pathname.endsWith('/item_images')) {
      const cursor = url.searchParams.get('id')?.slice(3) ?? '';
      return json((options.images ?? [image]).filter(value => typeof value === 'object' && value !== null && 'id' in value && String(value.id) > cursor).slice(0, 40));
    }
    if (url.pathname.startsWith('/storage/')) return options.deleteReply ? options.deleteReply() : json({ message: 'Successfully deleted' });
    throw new Error('Unexpected unit request.');
  });
  const client = createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_unit_fixture', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
  });
  const session: Session = { access_token: 'fictional', refresh_token: 'fictional', token_type: 'bearer', expires_in: 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now } };
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  vi.stubGlobal('fetch', transport);
  const controller = new AbortController(), scope = { ownerId: owner, epoch: 1, signal: controller.signal };
  const api = new ItemLifecycleClient(client, { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_unit_fixture', version: 'fixture' }, scope);
  return { client, api, requests, controller, scope, session, transport, intent: deletionIntent(initial, 1, nonce) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('strict lifecycle domain contracts', () => {
  it('validates bounded canonical IDs, safe versions and real nullable coherence', () => {
    expect(parseDeletionStatuses([status], owner, [id])).toEqual([status]);
    expect(parseDeletionStatuses([{ ...status, current_image_id: null, current_thumb_path: null, photo_count: 0 }], owner, [id])).toHaveLength(1);
    expect(parseDeletionStatuses([claim], owner, [id])).toEqual([claim]);
    expect(parseDeletionStatuses([], owner, [id])).toEqual([]);
    for (const patch of [{ owner_id: nonce }, { current_image_id: null }, { current_thumb_path: null }, { current_image_id: nonce },
      { request_id: nonce }, { expected_version: 1 }, { started_at: now }, { photo_count: -1 }, { photo_count: 0 }, { cleanup_blocked: true },
      { deleted_at: 'invalid' }, { title: '' }, { title: 'a'.repeat(101) }, { version: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }]) {
      expect(() => parseDeletionStatuses([{ ...status, ...patch }], owner, [id])).toThrow();
    }
    expect(() => parseDeletionStatuses([status, status], owner, [id])).toThrow();
    expect(() => requireLifecycleIds([], owner)).toThrow();
    expect(() => requireLifecycleIds([id, id], owner)).toThrow();
    expect(() => requireLifecycleIds(Array(41).fill(id), owner)).toThrow();
    expect(safeVersion(Number.MAX_SAFE_INTEGER, true)).toBe(false);
    expect(safeVersion(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
  it('requires exact original nonce, version, name and image manifest for resume', () => {
    expect(matchesClaim(claim, intent)).toBe(true);
    expect(deletionIntent(claim, 1, imageId)).toMatchObject({ requestId: nonce, expectedVersion: 2 });
    expect(matchesClaim({ ...claim, started_at: '2026-09-14T12:01:00Z' }, deletionIntent(claim, 1))).toBe(false);
    expect(() => parseBeginReply(begin, intent)).not.toThrow();
    for (const patch of [{ request_id: imageId }, { version: 4 }, { expected_version: 3 }, { image_manifest_sha256: 'b'.repeat(64) }, { started_at: null }, { extra: true }]) {
      expect(() => parseBeginReply([{ ...begin[0], ...patch }], intent)).toThrow();
    }
    for (const patch of [{ title: 'Changed' }, { photo_count: 2 }, { current_image_id: nonce }, { cleanup_blocked: true }, { request_id: null }]) {
      expect(matchesClaim({ ...claim, ...patch }, intent)).toBe(false);
    }
    expect(parseFinishReply([{ state: 'absent' }])).toBe('absent');
    expect(parseFinishReply([{ state: 'completed' }])).toBe('completed');
    for (const value of [null, [], [{ state: 'success' }], [{ state: 'completed', bytesGone: true }]]) expect(() => parseFinishReply(value)).toThrow();
  });
  it('reconciles only exact saved values/provenance and one returned version advance', () => {
    const baseline = parseLifecycleSnapshot(row(), owner, id), change = { baseline, epoch: 1, trashed: false };
    const restored = parseTrashReply([{ id, owner_id: owner, version: 3, deleted_at: null }], change);
    expect(confirmsTrash(restored, change)).toBe(true);
    expect(confirmsTrash({ ...restored, values: { ...restored.values, favourite: true } }, change)).toBe(false);
    expect(confirmsTrash({ ...restored, provenance: { title: { kind: 'user', revision: 1 } } }, change)).toBe(false);
    expect(confirmsTrash({ ...restored, version: 4 }, change)).toBe(false);
    expect(() => parseTrashReply([{ id, owner_id: owner, version: 3, deleted_at: now }], change)).toThrow();
  });
  it('accepts only complete ordered immutable pages of at most forty rows', () => {
    expect(parseLifecycleImages([image], owner, id, null)).toHaveLength(1);
    for (const value of [[image, image], [{ ...image, state: 'pending' }], [{ ...image, main_path: 'foreign' }], [{ ...image, retired_at: now }],
      Array(41).fill(image), [{ ...image, item_id: nonce }]]) expect(() => parseLifecycleImages(value, owner, id, null)).toThrow();
    expect(() => parseLifecycleImages([image], owner, id, imageId)).toThrow();
  });
});
describe('first production singular deletion adapter', () => {
  it.each([40, 41])('paginates %i immutable image versions and chunks named paths without bulk', async size => {
    const images = Array.from({ length: size }, (_, index) => {
      const imageId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return { ...image, id: imageId, state: index ? 'retired' : 'ready', retired_at: index ? now : null,
        main_path: `${owner}/${id}/${imageId}/main.jpg`, thumb_path: `${owner}/${id}/${imageId}/thumb.jpg` };
    });
    const h = harness({ images }), batches: string[][] = [];
    expect(await h.api.delete(h.intent, true, paths => batches.push(paths))).toEqual({ removed: size * 2, missing: 0 });
    expect(batches.every(batch => batch.length <= 40)).toBe(true);
    expect(new Set(batches.flat()).size).toBe(size * 2);
    expect(h.requests.filter(request => request.url.pathname.endsWith('/item_images'))).toHaveLength(2);
    expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(size * 2);
  });
  it('uses actual claim/status before byte requests and checked finish after exact acknowledgements', async () => {
    const h = harness(), invalidated: string[][] = [];
    expect(await h.api.delete(intent, true, paths => invalidated.push(paths))).toEqual({ removed: 2, missing: 0 });
    const deletes = h.requests.filter(request => request.method === 'DELETE');
    expect(deletes.map(request => request.url.pathname)).toEqual([image.main_path, image.thumb_path].map(path => `/storage/v1/object/wardrobe/${path}`));
    expect(deletes.every(request => request.url.origin === 'http://127.0.0.1:54321' && request.body === null
      && request.headers.get('apikey') === 'sb_publishable_unit_fixture' && request.headers.get('authorization') === 'Bearer fictional'
      && request.init.cache === 'no-store' && request.init.credentials === 'omit' && request.init.redirect === 'error')).toBe(true);
    expect(invalidated).toEqual([[image.main_path, image.thumb_path]]);
    expect(h.requests.at(-1)!.url.pathname).toBe('/rest/v1/rpc/finish_item_deletion');
    expect(h.requests.filter(r => r.url.pathname.endsWith('/item_images')).every(r => r.url.searchParams.get('limit') === '40')).toBe(true);
  });
  it('keeps the exact missing acknowledgement distinct, and still requires finish', async () => {
    const h = harness({ deleteReply: () => json(missing, 400) });
    expect(await h.api.delete(intent, true, () => {})).toEqual({ removed: 0, missing: 2 });
    expect(h.requests.at(-1)!.url.pathname.endsWith('/finish_item_deletion')).toBe(true);
  });
  it('stops on exact Storage denial with a definite registered error and no automatic resend', async () => {
    const h = harness({ deleteReply: () => json(denied, 400) });
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({
      stage: 'bytes', uncertain: false, messageKey: 'error.unavailable',
    });
    expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(h.requests.some(request => request.url.pathname.endsWith('/finish_item_deletion'))).toBe(false);
  });
  it.each([
    () => json({ ...denied, extra: true }, 400), () => json([], 200),
    () => json({ message: 'Successfully deleted', extra: true }), () => json({ message: 'Successfully deleted' }, 500),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => json({ message: 'x'.repeat(4096) }),
    () => new Response('unread', { headers: { 'content-type': 'text/plain' } }),
  ])('keeps malformed or unrecognized responses unconfirmed without automatic resend', async deleteReply => {
    const h = harness({ deleteReply });
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({
      stage: 'bytes', uncertain: true, messageKey: 'lifecycle.unconfirmed',
    });
    expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(h.requests.some(request => request.url.pathname.endsWith('/finish_item_deletion'))).toBe(false);
  });
  it.each(['begin', 'finish'] as const)('lost %s remains unconfirmed, never blind-retried', async lose => {
    const h = harness({ lose });
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({ uncertain: true, stage: lose });
    expect(h.requests.filter(request => request.url.pathname.endsWith(`/${lose}_item_deletion`))).toHaveLength(1);
    if (lose === 'begin') expect(h.requests.some(request => request.method === 'DELETE')).toBe(false);
  });
  it.each([new TypeError('Fictional delivery loss'), new DOMException('Fictional abort', 'AbortError')])(
    'keeps a failed singular DELETE unconfirmed without later path requests or FINISH', async problem => {
      vi.useFakeTimers();
      const h = harness({ deleteReply: () => { throw problem; } });
      await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({
        stage: 'bytes', uncertain: true, messageKey: 'lifecycle.unconfirmed',
      });
      expect(h.requests.filter(request => request.method === 'DELETE').map(request => request.url.pathname))
        .toEqual([`/storage/v1/object/wardrobe/${image.main_path}`]);
      const attempted = h.requests.length;
      await vi.advanceTimersByTimeAsync(lifecycleBudgetMs);
      expect(h.requests).toHaveLength(attempted);
      expect(h.requests.some(request => request.url.pathname.endsWith('/finish_item_deletion'))).toBe(false);
    },
  );
  it('does not convert generic finish absence into byte proof', async () => {
    const h = harness();
    h.transport.mockImplementationOnce(async () => json([status]))
      .mockImplementationOnce(async () => json(begin)).mockImplementationOnce(async () => json([claim]))
      .mockImplementationOnce(async () => json([image])).mockImplementationOnce(async () => json({ message: 'Successfully deleted' }))
      .mockImplementationOnce(async () => json({ message: 'Successfully deleted' })).mockImplementationOnce(async () => json([claim]))
      .mockImplementationOnce(async () => json([{ state: 'absent' }]));
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({ stage: 'finish', uncertain: true });
  });
  it('bounds stalled auth and starts no DELETE after owner cancellation or timeout', async () => {
    vi.useFakeTimers();
    const h = harness();
    const original = h.transport.getMockImplementation()!;
    h.transport.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith('/item_images')) {
        vi.mocked(h.client.auth.getSession).mockReturnValue(new Promise(() => {}));
      }
      return response;
    });
    const result = h.api.delete(intent, true, () => {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(lifecycleBudgetMs);
    expect(await result).toMatchObject({ uncertain: true });
    expect(h.requests.some(request => request.method === 'DELETE')).toBe(false);
    await vi.advanceTimersByTimeAsync(lifecycleBudgetMs);
    expect(h.requests.some(request => request.method === 'DELETE')).toBe(false);
  });
  it('rejects foreign epoch before any request and changed session owner before bytes', async () => {
    const h = harness();
    await expect(h.api.delete({ ...intent, epoch: 2 }, true, () => {})).rejects.toMatchObject({
      stage: 'read', uncertain: false, messageKey: 'error.unavailable',
    });
    expect(h.requests).toHaveLength(0);
    vi.mocked(h.client.auth.getSession).mockResolvedValue({ data: { session: { ...h.session, user: { ...h.session.user, id: nonce } } }, error: null });
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({
      stage: 'begin', uncertain: false, messageKey: 'error.unavailable',
    });
    expect(h.requests.some(request => request.method === 'DELETE')).toBe(false);
  });
  it.each(['owner', 'epoch', 'route'] as const)('rejects a late %s result before initiating another operation', async change => {
    const h = harness(), route = new AbortController();
    let release: ((response: Response) => void) | undefined;
    h.transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const result = h.api.delete(intent, true, () => {}, route.signal).catch(error => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (change === 'owner') h.controller.abort();
    else if (change === 'epoch') h.scope.epoch++;
    else route.abort();
    release!(json([status]));
    expect(await result).toBeInstanceOf(Error);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });
  it('keeps unexpected SQLSTATE and affirmative malformed replies unconfirmed, not generic conflicts', async () => {
    const h = harness();
    h.transport.mockImplementationOnce(async () => json([status]))
      .mockImplementationOnce(async () => json({ code: '22023', message: 'Unexpected private detail' }, 400));
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({ messageKey: 'lifecycle.unconfirmed', uncertain: true });
    const second = harness();
    second.transport.mockImplementationOnce(async () => json([status])).mockImplementationOnce(async () => json([{ ...begin[0], version: 200 }]));
    await expect(second.api.delete(intent, true, () => {})).rejects.toMatchObject({ messageKey: 'lifecycle.unconfirmed', uncertain: true });
    expect(second.requests.some(request => request.method === 'DELETE')).toBe(false);
  });
  it('requires the status observation to retain the original BEGIN server timestamp', async () => {
    const h = harness();
    h.transport.mockImplementationOnce(async () => json([status]))
      .mockImplementationOnce(async () => json(begin))
      .mockImplementationOnce(async () => json([{ ...claim, started_at: '2026-09-14T12:01:00Z' }]));
    await expect(h.api.delete(intent, true, () => {})).rejects.toMatchObject({ uncertain: true });
    expect(h.requests.some(request => request.method === 'DELETE')).toBe(false);
  });
  it('bounds stalled body cleanup and handles late cancellation without a second request', async () => {
    vi.useFakeTimers();
    const h = harness({ deleteReply: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel() { return new Promise(() => {}); },
    }), { headers: { 'content-type': 'application/json' } }) });
    const result = h.api.delete(intent, true, () => {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(lifecycleBudgetMs);
    expect(await result).toMatchObject({ uncertain: true });
    expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  });
});
