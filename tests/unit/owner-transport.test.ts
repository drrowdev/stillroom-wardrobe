import { describe, expect, it, vi } from 'vitest';
import { exportPolicy, ownerTransport, REQUEST_TIMEOUT_MS, RESTORE_RPCS, restorePolicy } from '../../scripts/owner-transport.mjs';
import { imageColumns } from '../../src/data/restore';
import { itemDetailColumns } from '../../src/domain/item-details';

const origin = 'http://127.0.0.1:54321';
const key = 'sb_publishable_abcdefghijkl';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const item = '44444444-4444-4444-8444-444444444444';
const image = '55555555-5555-4555-8555-555555555555';

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
function gate(policy: typeof restorePolicy, signedIn = true) {
  const state: { owner: string | null; refused: boolean } = { owner: signedIn ? owner : null, refused: false };
  const fetchImpl = vi.fn(async () => new Response('{}'));
  const seen: string[] = [];
  const guarded = ownerTransport({ origin, key, fetchImpl, state, policy, refusal: () => new Error('refused'),
    observe: ({ method, path, search }: { method: string; path: string; search: string }) => seen.push(`${method} ${path}${search}`) });
  const allowed = async (path: string, init: Init = {}) => {
    try {
      await guarded(`${origin}${path}`, { ...init, headers: { apikey: key, ...init.headers } });
      return true;
    } catch { return false; }
  };
  return { state, fetchImpl, seen, guarded, allowed };
}
const json = (value: unknown) => JSON.stringify(value);
const photo = (variant = 'main', who = owner) => `/storage/v1/object/wardrobe/${who}/${item}/${image}/${variant}.jpg`;
const itemsQuery = `?select=id,owner_id,version&owner_id=eq.${owner}&id=in.(${item})`;

describe('owner transport', () => {
  it('requires a policy, and sends only to the one origin with the publishable key and no redirects, cookies or cache', async () => {
    expect(() => ownerTransport({ origin, key, fetchImpl: fetch, state: {}, refusal: () => new Error('x') } as never)).toThrow(TypeError);
    const { fetchImpl, guarded, allowed, state } = gate(restorePolicy);
    expect(await allowed('/rest/v1/rpc/save_outfit', { method: 'POST' })).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    await expect(guarded(`${origin}/rest/v1/rpc/save_outfit`, { method: 'POST', headers: { apikey: 'sb_publishable_otherkeyzz' } })).rejects.toThrow('refused');
    expect(state.refused).toBe(true);
    for (const address of ['http://127.0.0.1:54322/rest/v1/rpc/save_outfit', 'http://user:pw@127.0.0.1:54321/rest/v1/rpc/save_outfit',
      `${origin}/rest/v1/rpc/save_outfit#x`]) {
      await expect(guarded(address, { method: 'POST', headers: { apikey: key } })).rejects.toThrow('refused');
    }
    await expect(guarded({ url: `${origin}/rest/v1/rpc/save_outfit` } as never, { method: 'POST' })).rejects.toThrow('refused');
  });

  it('leaves the export policy as it was: the two export RPCs and authenticated downloads of the owner\'s photos', async () => {
    const { allowed } = gate(exportPolicy);
    expect(await allowed('/auth/v1/token?grant_type=password', { method: 'POST' })).toBe(true);
    expect(await allowed('/rest/v1/rpc/export_manifest', { method: 'POST' })).toBe(true);
    expect(await allowed('/rest/v1/rpc/item_attribution_history', { method: 'POST' })).toBe(true);
    expect(await allowed(`/storage/v1/object/authenticated/wardrobe/${owner}/${item}/${image}/main.jpg`)).toBe(true);
    expect(await allowed(`/storage/v1/object/authenticated/wardrobe/${other}/${item}/${image}/main.jpg`)).toBe(false);
    for (const rpc of RESTORE_RPCS) expect(await allowed(`/rest/v1/rpc/${rpc}`, { method: 'POST' })).toBe(false);
    expect(await allowed(photo(), { method: 'POST', headers: { 'x-upsert': 'false' } })).toBe(false);
    expect(await allowed('/functions/v1/finalize-image-change', { method: 'POST', body: json({ action: 'complete', intent: {} }) })).toBe(false);
  });

  it('allows the restore\'s exact requests: sign-in, refresh, sign-out, its RPCs, owner reads and the owner\'s new photo files', async () => {
    const { allowed, seen } = gate(restorePolicy);
    expect(await allowed('/auth/v1/token?grant_type=password', { method: 'POST' })).toBe(true);
    expect(await allowed('/auth/v1/token?grant_type=refresh_token', { method: 'POST' })).toBe(true);
    expect(await allowed('/auth/v1/logout?scope=local', { method: 'POST' })).toBe(true);
    for (const rpc of RESTORE_RPCS) expect(await allowed(`/rest/v1/rpc/${rpc}`, { method: 'POST', body: '{}' })).toBe(true);
    expect(await allowed(`/rest/v1/items${itemsQuery}`)).toBe(true);
    expect(await allowed(`/rest/v1/item_images?select=id,item_id&owner_id=eq.${owner}&item_id=in.(${item},${image})`)).toBe(true);
    // The restore's own column lists, which include names with digits such as main_sha256.
    expect(await allowed(`/rest/v1/items?select=${itemDetailColumns}&owner_id=eq.${owner}&id=in.(${item})`)).toBe(true);
    expect(await allowed(`/rest/v1/item_images?select=${imageColumns}&owner_id=eq.${owner}&item_id=in.(${item})`)).toBe(true);
    expect(await allowed(`/rest/v1/item_images?select=id,9main&owner_id=eq.${owner}&item_id=in.(${item})`)).toBe(false);
    expect(await allowed(`/rest/v1/wear_events?select=id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at&owner_id=eq.${owner}&id=eq.${item}`)).toBe(true);
    expect(await allowed('/rest/v1/wear_events', { method: 'POST', body: json({ id: item, owner_id: owner }) })).toBe(true);
    expect(await allowed('/rest/v1/combination_rules?on_conflict=owner_id,item_low,item_high', { method: 'POST', body: json({ owner_id: owner }) })).toBe(true);
    expect(await allowed('/rest/v1/suggestion_feedback?on_conflict=owner_id,signature', { method: 'POST', body: json({ owner_id: owner }) })).toBe(true);
    // Upload, then the duplicate-upload download that compares what is already stored.
    expect(await allowed(photo('main'), { method: 'POST', headers: { 'x-upsert': 'false' } })).toBe(true);
    expect(await allowed(photo('thumb'))).toBe(true);
    const finalize = { action: 'complete', intent: { itemId: item, sourceImageId: null, claim: null } };
    expect(await allowed('/functions/v1/finalize-image-change', { method: 'POST', headers: { authorization: 'Bearer token' }, body: json(finalize) })).toBe(true);
    expect(seen).toHaveLength(22);
  });

  it('refuses every other method, query, path, owner and body', async () => {
    const { allowed } = gate(restorePolicy);
    const refused = [
      ['/auth/v1/token?grant_type=password&x=1', { method: 'POST' }],
      ['/auth/v1/logout?scope=global', { method: 'POST' }],
      ['/auth/v1/signup', { method: 'POST' }],
      ['/rest/v1/rpc/cancel_image_change', { method: 'POST' }],
      ['/rest/v1/rpc/image_change_requests', { method: 'POST' }],
      ['/rest/v1/rpc/image_recovery_versions', { method: 'POST' }],
      ['/rest/v1/rpc/export_manifest', { method: 'POST' }],
      ['/rest/v1/rpc/save_outfit?x=1', { method: 'POST' }],
      ['/rest/v1/rpc/save_outfit', { method: 'GET' }],
      [`/rest/v1/items${itemsQuery}`, { method: 'PATCH' }],
      [`/rest/v1/items${itemsQuery}`, { method: 'DELETE' }],
      [`/rest/v1/items?select=*&owner_id=eq.${owner}&id=in.(${item})`, {}],
      [`/rest/v1/items?select=id&owner_id=eq.${other}&id=in.(${item})`, {}],
      [`/rest/v1/items?select=id&owner_id=eq.${owner}`, {}],
      [`/rest/v1/items?select=id&owner_id=eq.${owner}&id=in.(${item})&limit=1`, {}],
      [`/rest/v1/items?select=id&owner_id=eq.${owner}&owner_id=eq.${owner}&id=in.(${item})`, {}],
      [`/rest/v1/items?select=id&owner_id=eq.${owner}&id=in.(${Array.from({ length: 101 }, () => item).join(',')})`, {}],
      [`/rest/v1/wear_events?select=id&owner_id=eq.${owner}&id=eq.${item}`, {}],
      ['/rest/v1/wear_events', { method: 'POST', body: json({ id: item, owner_id: other }) }],
      ['/rest/v1/wear_events', { method: 'POST', body: json([{ id: item, owner_id: owner }]) }],
      ['/rest/v1/wear_events?on_conflict=id', { method: 'POST', body: json({ owner_id: owner }) }],
      ['/rest/v1/combination_rules', { method: 'POST', body: json({ owner_id: owner }) }],
      ['/rest/v1/suggestion_feedback?on_conflict=signature', { method: 'POST', body: json({ owner_id: owner }) }],
      ['/rest/v1/profiles', { method: 'POST', body: json({ owner_id: owner }) }],
      ['/rest/v1/ai_consents', { method: 'POST', body: json({ owner_id: owner }) }],
      [photo('main', other), { method: 'POST', headers: { 'x-upsert': 'false' } }],
      [photo('main'), { method: 'POST', headers: { 'x-upsert': 'true' } }],
      [photo('main'), { method: 'POST' }],
      [photo('main'), { method: 'PUT', headers: { 'x-upsert': 'false' } }],
      [photo('main'), { method: 'DELETE' }],
      [`${photo('main')}?download=1`, {}],
      [`/storage/v1/object/wardrobe/${owner}/${item}/${image}/other.jpg`, {}],
      [`/storage/v1/object/authenticated/wardrobe/${owner}/${item}/${image}/main.jpg`, {}],
      [`/storage/v1/object/public/wardrobe/${owner}/${item}/${image}/main.jpg`, {}],
      ['/functions/v1/finalize-image-change', { method: 'POST', headers: { authorization: 'Bearer t' },
        body: json({ action: 'complete', intent: { sourceImageId: image, claim: null } }) }],
      ['/functions/v1/finalize-image-change', { method: 'POST', headers: { authorization: 'Bearer t' },
        body: json({ action: 'complete', intent: { sourceImageId: null, claim: { id: item } } }) }],
      ['/functions/v1/finalize-image-change', { method: 'POST', headers: { authorization: 'Bearer t' },
        body: json({ action: 'cancel', intent: { sourceImageId: null, claim: null } }) }],
      ['/functions/v1/finalize-image-change', { method: 'POST', headers: { authorization: 'Bearer t' },
        body: json({ action: 'complete', intent: { sourceImageId: null, claim: null }, extra: 1 }) }],
      ['/functions/v1/finalize-image-change', { method: 'POST', body: json({ action: 'complete', intent: { sourceImageId: null, claim: null } }) }],
      ['/functions/v1/finalize-image-change?x=1', { method: 'POST', headers: { authorization: 'Bearer t' },
        body: json({ action: 'complete', intent: { sourceImageId: null, claim: null } }) }],
      ['/functions/v1/analyze-item-photo', { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' }],
      ['/functions/v1/finalize-item-save', { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' }],
    ] as const;
    for (const [path, init] of refused) expect(await allowed(path, init as Init), `${(init as Init).method ?? 'GET'} ${path}`).toBe(false);
  });

  it('refuses raw paths that only normalize to an allowed one: dot segments, encoded dots and backslashes', async () => {
    const { allowed, fetchImpl } = gate(restorePolicy);
    const upload = { method: 'POST', headers: { 'x-upsert': 'false' } };
    const base = `/storage/v1/object/wardrobe/${owner}/${item}/${image}`;
    expect(await allowed(`${base}/main.jpg`, upload)).toBe(true);
    const sent = fetchImpl.mock.calls.length;
    const variants = [
      `/storage/v1/object/wardrobe/${other}/../${owner}/${item}/${image}/main.jpg`,
      `${base}/./main.jpg`,
      `/storage/v1/object/wardrobe/${other}/%2e%2e/${owner}/${item}/${image}/main.jpg`,
      `/storage/v1/object/wardrobe/${other}/%2E./${owner}/${item}/${image}/main.jpg`,
      `/storage/v1/object/wardrobe/${other}\\..\\${owner}/${item}/${image}/main.jpg`,
      `/storage/v1/object\\wardrobe/${owner}/${item}/${image}/main.jpg`,
      `/rest/v1/rpc/../rpc/save_outfit`,
    ];
    for (const path of variants) {
      expect(new URL(`${origin}${path}`).pathname.includes('..')).toBe(false);
      expect(await allowed(path, upload.method === 'POST' && path.startsWith('/rest') ? { method: 'POST' } : upload), path).toBe(false);
    }
    expect(fetchImpl.mock.calls.length).toBe(sent);
  });
  it('allows nothing but sign-in before the session is known', async () => {
    const { allowed } = gate(restorePolicy, false);
    expect(await allowed('/auth/v1/token?grant_type=password', { method: 'POST' })).toBe(true);
    expect(await allowed('/rest/v1/rpc/save_outfit', { method: 'POST' })).toBe(false);
    expect(await allowed(photo())).toBe(false);
  });
});
