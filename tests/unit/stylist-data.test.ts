import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import { StylistClient } from '../../src/data/stylist';
import { STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_REVIEW_EXPIRES } from '../../src/domain/stylist';
import { parseStylistStatus, type StylistAnswer, type StylistStatus } from '../../src/domain/stylist-controls';
import { StylistStore } from '../../src/features/stylist/stylist-store';
import { canSend, clear, readStatus, send, viewOf, writeConsent } from '../../src/features/stylist/use-stylist';
import { testAccessToken } from './test-token';

const owner = '10000000-0000-4000-8000-000000000001';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test_only', version: 'test' };
function raw(code = 'OK', enabled = true) {
  return { code, period: '2026-10', serverTimeMs: STYLIST_REVIEW_EXPIRES - 86_400_000,
    consent: { enabled, noticeRevision: enabled ? 1 : null, consentedAt: enabled ? '2026-10-01T00:00:00Z' : null },
    policy: code === 'UNCONFIGURED' ? null : { activated: true, noticeRevision: 1, manifestId: STYLIST_MANIFEST, modelId: STYLIST_MODEL,
      maxRequestMicro: '129360', stylistAllowanceMicro: '5000000', totalAllowanceMicro: '17940000', maxRequestsPerHour: 20 },
    usage: { stylistMicro: '0', totalMicro: '0', stylistLastHour: 0, warning: false } };
}
const status = (code = 'OK', enabled = true) => parseStylistStatus(raw(code, enabled))!;
function supabase() {
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const session: Session = { access_token: testAccessToken(owner), refresh_token: 'fictional-unit-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  return client;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ST1b stylist client', () => {
  it('treats only the missing-function reply as not installed', async () => {
    const scope = { ownerId: owner, epoch: 1, signal: new AbortController().signal };
    const stylist = new StylistClient(supabase(), config, scope);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'PGRST202', message: 'not found' }, { status: 404 }));
    await expect(stylist.stylistStatus()).resolves.toEqual({ kind: 'missing' });
    fetcher.mockResolvedValueOnce(Response.json({ message: 'not found' }, { status: 404 }));
    await expect(stylist.stylistStatus()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json({ code: 'PGRST301' }, { status: 401 }));
    await expect(stylist.stylistStatus()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json({ ...raw(), extra: 1 }));
    await expect(stylist.stylistStatus()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json(raw()));
    await expect(stylist.stylistStatus()).resolves.toMatchObject({ kind: 'ready', status: { code: 'OK' } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${config.url}/rest/v1/rpc/stylist_status`);
    expect(init?.credentials).toBe('omit');
  });

  it('sends the notice revision with consent and keeps unknown outcomes apart from refusals', async () => {
    const scope = { ownerId: owner, epoch: 1, signal: new AbortController().signal };
    const stylist = new StylistClient(supabase(), config, scope);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json(raw()));
    await expect(stylist.stylistConsent(true)).resolves.toMatchObject({ kind: 'applied' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ p_enabled: true, p_notice_revision: 1 });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'CONFIG_CHANGED' }));
    await expect(stylist.stylistConsent(false)).resolves.toEqual({ kind: 'refused', code: 'CONFIG_CHANGED' });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ p_enabled: false, p_notice_revision: null });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'SOMETHING' }));
    await expect(stylist.stylistConsent(true)).rejects.toThrow();
    fetcher.mockRejectedValueOnce(new TypeError('network'));
    await expect(stylist.stylistConsent(true)).rejects.toThrow();
  });

  it('maps chat replies and failures to closed codes', async () => {
    const scope = { ownerId: owner, epoch: 1, signal: new AbortController().signal };
    const stylist = new StylistClient(supabase(), config, scope);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const body = { requestId: '11111111-1111-4111-8111-111111111111', message: 'hi', history: [], occasion: null, season: null, weather: null };
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', reply: 'Try these', outfits: [] }));
    await expect(stylist.chat(body)).resolves.toEqual({ code: 'OK', reply: 'Try these', outfits: [] });
    expect(fetcher.mock.calls[0]![0]).toBe(`${config.url}/functions/v1/stylist-chat`);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual(body);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'RATE_LIMIT' }, { status: 429 }));
    await expect(stylist.chat(body)).resolves.toEqual({ code: 'RATE_LIMIT' });
    fetcher.mockRejectedValueOnce(new TypeError('network'));
    await expect(stylist.chat(body)).resolves.toEqual({ code: 'FAILED' });
  });
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const abort = new AbortController();
  const store = new StylistStore(supabase(), config, { ownerId: owner, epoch: 1, signal: abort.signal });
  const reads: Deferred<{ kind: 'ready'; status: StylistStatus } | { kind: 'missing' }>[] = [];
  const writes: Deferred<{ kind: 'applied'; status: StylistStatus }>[] = [];
  const chats: { body: unknown; reply: Deferred<StylistAnswer>; signal?: AbortSignal }[] = [];
  const fake = {
    stylistStatus: vi.fn(() => { const d = deferred<{ kind: 'ready'; status: StylistStatus } | { kind: 'missing' }>(); reads.push(d); return d.promise; }),
    stylistConsent: vi.fn(() => { const d = deferred<{ kind: 'applied'; status: StylistStatus }>(); writes.push(d); return d.promise; }),
    chat: vi.fn((body: unknown, signal?: AbortSignal) => { const reply = deferred<StylistAnswer>(); chats.push({ body, reply, signal }); return reply.promise; }),
  };
  store.api = fake as unknown as StylistClient;
  return { store, abort, reads, writes, chats, fake };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ST1b stylist ordering (M3)', () => {
  it('ignores a read that started before a consent write, even if it lands later', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await first;
    expect(viewOf(h.store.get()).kind).toBe('off');
    // A second read is held; the consent write waits for it and supersedes it.
    const held = readStatus(h.store, 'active');
    const write = writeConsent(h.store, true);
    await tick();
    expect(h.fake.stylistConsent).not.toHaveBeenCalled();
    h.reads[1]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await held;
    await tick();
    expect(h.fake.stylistConsent).toHaveBeenCalledTimes(1);
    h.writes[0]!.resolve({ kind: 'applied', status: status('OK', true) });
    await write;
    expect(viewOf(h.store.get()).kind).toBe('on');
    // The applied write returned the new status, so no further read is needed.
    await tick();
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps an uncertain consent write unresolved until a later read succeeds', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await first;
    const write = writeConsent(h.store, true);
    await tick();
    h.writes[0]!.reject(new Error('unknown'));
    await write;
    expect(viewOf(h.store.get())).toMatchObject({ kind: 'unresolved', send: false, turnOn: false });
    h.reads[1]!.reject(new Error('still offline'));
    await tick(); await tick();
    expect(viewOf(h.store.get()).kind).toBe('unresolved');
    const retry = readStatus(h.store, 'active');
    h.reads[2]!.resolve({ kind: 'ready', status: status('OK', true) });
    await retry;
    expect(viewOf(h.store.get()).kind).toBe('on');
  });

  it('defers passive reads during profile writes and does not trust a read that failed meanwhile', async () => {
    const h = harness();
    h.store.setBusy(true);
    await readStatus(h.store, 'passive');
    expect(h.fake.stylistStatus).not.toHaveBeenCalled();
    h.store.setBusy(false);
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(1);
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await tick(); await tick();
    expect(viewOf(h.store.get()).kind).toBe('on');
    // A read already running when a profile save starts is left to finish; its failure is not shown.
    const running = readStatus(h.store, 'active');
    h.store.setBusy(true);
    h.reads[1]!.reject(new Error('lock'));
    await running;
    expect(viewOf(h.store.get()).kind).toBe('on');
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(2);
    h.store.setBusy(false);
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(3);
    h.reads[2]!.resolve({ kind: 'ready', status: status('INACTIVE', true) });
    await tick(); await tick();
    expect(viewOf(h.store.get()).kind).toBe('paused');
  });

  it('drops a reply that arrives after Clear and leaves the newer request in flight', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    h.store.update({ draft: 'First question' });
    const old = send(h.store, { online: true, season: 'autumn', weather: null });
    expect(h.store.get().pending).toBe('First question');
    clear(h.store);
    expect(h.chats[0]!.signal?.aborted).toBe(true);
    h.store.update({ draft: 'Second question' });
    const next = send(h.store, { online: true, season: 'autumn', weather: null });
    expect(h.store.inflight).not.toBeNull();
    h.chats[0]!.reply.resolve({ code: 'OK', reply: 'Old reply', outfits: [] });
    await old;
    // The old request's cleanup must not clear the newer request.
    expect(h.store.inflight).not.toBeNull();
    expect(h.store.get()).toMatchObject({ turns: [], pending: 'Second question' });
    h.chats[1]!.reply.resolve({ code: 'OK', reply: 'New reply', outfits: [] });
    await next;
    expect(h.store.get().turns.map((turn) => turn.text)).toEqual(['Second question', 'New reply']);
    expect(h.store.inflight).toBeNull();
  });

  it('drops everything when the owner scope ends', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    h.store.update({ draft: 'Question' });
    const pending = send(h.store, { online: true, season: null, weather: null });
    h.abort.abort();
    expect(h.chats[0]!.signal?.aborted).toBe(true);
    h.chats[0]!.reply.resolve({ code: 'OK', reply: 'Late', outfits: [] });
    await pending;
    expect(h.store.get().turns).toEqual([]);
    await expect(readStatus(h.store, 'active')).resolves.toBeNull();
  });

  it('rereads status after an allowance refusal and names only the reached limit (M5)', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    h.store.update({ draft: 'Question' });
    const sent = send(h.store, { online: true, season: null, weather: null });
    h.chats[0]!.reply.resolve({ code: 'ALLOWANCE' });
    await tick();
    // The allowance was raised before the reread, so no limit is named.
    h.reads[1]!.resolve({ kind: 'ready', status: status('OK', true) });
    await sent;
    expect(h.store.get()).toMatchObject({ draft: 'Question', pending: null, error: { key: 'stylist.failed', retry: true } });
  });

  it('blocks sending while Turn off is pending', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    h.store.update({ draft: 'Question' });
    expect(canSend(h.store.get())).toBe(true);
    const write = writeConsent(h.store, false);
    expect(canSend(h.store.get())).toBe(false);
    await send(h.store, { online: true, season: null, weather: null });
    expect(h.fake.chat).not.toHaveBeenCalled();
    h.writes[0]!.resolve({ kind: 'applied', status: status('CONSENT_REQUIRED', false) });
    await write;
    expect(canSend(h.store.get())).toBe(false);
    expect(viewOf(h.store.get()).kind).toBe('off');
  });

  it('holds an active read asked for during a withdrawal until it completes, so it cannot restore On', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    const write = writeConsent(h.store, false);
    await tick();
    expect(h.fake.stylistConsent).toHaveBeenCalledTimes(1);
    // Retry, a fresh reread and a passive focus read all arrive while the write is running.
    const active = readStatus(h.store, 'active');
    const fresh = readStatus(h.store, 'fresh');
    void readStatus(h.store, 'passive');
    await tick();
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(1);
    h.writes[0]!.resolve({ kind: 'applied', status: status('CONSENT_REQUIRED', false) });
    await write;
    await tick();
    expect(viewOf(h.store.get()).kind).toBe('off');
    // The waiting reads start only now, and share one request that postdates the write.
    expect(h.fake.stylistStatus).toHaveBeenCalledTimes(2);
    h.reads[1]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await active; await fresh;
    expect(viewOf(h.store.get())).toMatchObject({ kind: 'off', send: false });
  });

  it('checks the permission again after the read it waited for, and does not write for an unsupported policy', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await first;
    const held = readStatus(h.store, 'active');
    const write = writeConsent(h.store, true);
    const unsupported = status('CONSENT_REQUIRED', false);
    h.reads[1]!.resolve({ kind: 'ready', status: { ...unsupported, policy: { ...unsupported.policy!, modelId: 'another-model' } } });
    await held;
    await write;
    expect(h.fake.stylistConsent).not.toHaveBeenCalled();
    expect(viewOf(h.store.get())).toMatchObject({ kind: 'unavailable', turnOn: false });
    expect(h.store.get().writing).toBe(false);
  });

  it('keeps an unknown consent change unresolved across a missing RPC, a failure and a status without consent', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    const write = writeConsent(h.store, false);
    await tick();
    h.writes[0]!.reject(new Error('unknown'));
    await write;
    expect(viewOf(h.store.get()).kind).toBe('unresolved');
    await tick();
    h.reads[1]!.resolve({ kind: 'missing' });
    await tick(); await tick();
    expect(viewOf(h.store.get()).kind).toBe('unresolved');
    const failing = readStatus(h.store, 'active');
    h.reads[2]!.reject(new Error('network'));
    await failing;
    expect(viewOf(h.store.get()).kind).toBe('unresolved');
    const noConsent = readStatus(h.store, 'active');
    h.reads[3]!.resolve({ kind: 'ready', status: parseStylistStatus({ code: 'UNAVAILABLE' })! });
    await noConsent;
    expect(viewOf(h.store.get()).kind).toBe('unresolved');
    const settled = readStatus(h.store, 'active');
    h.reads[4]!.resolve({ kind: 'ready', status: status('CONSENT_REQUIRED', false) });
    await settled;
    expect(viewOf(h.store.get()).kind).toBe('off');
  });

  it('wipes a populated conversation and its status when the owner scope ends', async () => {
    const h = harness();
    const first = readStatus(h.store, 'active');
    h.reads[0]!.resolve({ kind: 'ready', status: status('OK', true) });
    await first;
    h.store.update({ draft: 'Question' });
    const sent = send(h.store, { online: true, season: null, weather: null });
    h.chats[0]!.reply.resolve({ code: 'OK', reply: 'Reply', outfits: [] });
    await sent;
    h.store.update({ draft: 'Unsent words', occasion: 'business' });
    const later = readStatus(h.store, 'active');
    const seen: string[] = [];
    h.store.subscribe(() => { seen.push(h.store.get().draft); });
    h.abort.abort();
    expect(seen).toEqual(['']);
    expect(h.store.get()).toMatchObject({ turns: [], draft: '', pending: null, occasion: 'everyday', read: { kind: 'unknown' },
      known: false, error: null, announce: null });
    h.reads[1]!.resolve({ kind: 'ready', status: status('OK', true) });
    await later;
    expect(h.store.get().read).toEqual({ kind: 'unknown' });
    expect(h.store.readPromise).toBeNull();
  });
});
