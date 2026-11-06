import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import type { OutfitGenClient } from '../../src/data/outfitgen';
import { OUTFITGEN_MANIFEST, OUTFITGEN_MODEL } from '../../src/domain/outfitgen';
import {
  AUTO_COOLDOWN_MS, autoBlock, outfitGenView, parseDecision, parseGenerateReply, parseOutfitGenStatus, parseSuggestionList,
  type AutoLocal, type GenerateReply, type OutfitGenStatus,
} from '../../src/domain/outfitgen-app';
import {
  OutfitGenStore, keepSuggestion, manualNotices, readList, readStatus, removeSuggestion, runAuto, runManual, undoRemoval, viewOf, writeConsent,
} from '../../src/features/outfitgen/outfitgen-store';
import { OutfitGenTrigger } from '../../src/features/outfitgen/outfitgen-trigger';
import { sharedFigures } from '../../src/features/settings/ai-features-model';
import { testAccessToken } from './test-token';

const owner = '10000000-0000-4000-8000-000000000001';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test_only', version: 'test' };
const ids = [1, 2, 3, 4].map((n) => `20000000-0000-4000-8000-00000000000${n}`);
const BUDGET = { monthlyAllowanceMicro: '17940000', usedMicro: '0', remainingMicro: '17940000', warning: false };

function raw(over: Record<string, unknown> = {}, code = 'OK', enabled = true) {
  return { code, period: '2026-11', serverTimeMs: Date.parse('2026-11-20T00:00:00Z'),
    consent: { enabled, noticeRevision: enabled ? 1 : null, consentedAt: enabled ? '2026-11-01T00:00:00Z' : null },
    policy: code === 'UNCONFIGURED' ? null : { activated: true, noticeRevision: 1, manifestId: OUTFITGEN_MANIFEST, modelId: OUTFITGEN_MODEL, maxRequestMicro: '373402' },
    budget: BUDGET, pending: 0, unassessed: 2, autoUnassessed: 2, autoCallsLeft: 3, live: false, cooldownUntilMs: null, ...over };
}
const status = (over: Record<string, unknown> = {}, code = 'OK', enabled = true): OutfitGenStatus => parseOutfitGenStatus(raw(over, code, enabled))!;
const local = (over: Partial<AutoLocal> = {}): AutoLocal => ({ online: true, visible: true, running: false, autoCalls: 0, failedAtMs: null, nowMs: 10_000_000, ...over });

describe('suggested outfits: closed replies', () => {
  it('reads only the exact status shape', () => {
    expect(status()).toMatchObject({ code: 'OK', pending: 0, autoUnassessed: 2, autoCallsLeft: 3, live: false, cooldownUntilMs: null });
    expect(parseOutfitGenStatus({ code: 'UNAVAILABLE' })).toMatchObject({ code: 'UNAVAILABLE', policy: null });
    expect(parseOutfitGenStatus({ code: 'INACTIVE' })).toBeNull();
    expect(parseOutfitGenStatus({ ...raw(), extra: 1 })).toBeNull();
    expect(parseOutfitGenStatus(raw({ pending: 41 }))).toBeNull();
    expect(parseOutfitGenStatus(raw({ autoCallsLeft: 4 }))).toBeNull();
    expect(parseOutfitGenStatus(raw({ live: 'no' }))).toBeNull();
    expect(parseOutfitGenStatus(raw({ cooldownUntilMs: -1 }))).toBeNull();
    expect(parseOutfitGenStatus(raw({ policy: null }))).toBeNull();
    expect(parseOutfitGenStatus(raw({ policy: raw().policy }, 'UNCONFIGURED', false))).toBeNull();
    expect(parseOutfitGenStatus(raw({ budget: null }, 'UNCONFIGURED', false))).toMatchObject({ code: 'UNCONFIGURED' });
  });
  it('reads suggestions as plain data and refuses malformed ones', () => {
    const entry = { id: ids[0], itemIds: [ids[1], ids[2]], title: 'Calm navy', reason: 'Quiet colours.', occasion: 'smart', score: 9, createdAt: '2026-11-06T10:00:00Z' };
    expect(parseSuggestionList({ code: 'OK', suggestions: [entry] })).toMatchObject({ kind: 'ok', suggestions: [{ id: ids[0], score: 9 }] });
    expect(parseSuggestionList({ code: 'UNAVAILABLE' })).toEqual({ kind: 'unavailable' });
    for (const bad of [{ ...entry, itemIds: [ids[1]] }, { ...entry, itemIds: [ids[1], ids[1]] }, { ...entry, occasion: 'party' }, { ...entry, score: 11 },
      { ...entry, title: '' }, { ...entry, extra: 1 }, { ...entry, id: 'x' }]) {
      expect(parseSuggestionList({ code: 'OK', suggestions: [bad] })).toBeNull();
    }
    expect(parseSuggestionList({ code: 'OK', suggestions: [entry, entry] })).toBeNull();
  });
  it('reads decisions and run replies, and treats anything else as failed', () => {
    expect(parseDecision({ code: 'OK', outfitId: ids[0] }, 'keep')).toEqual({ code: 'OK', outfitId: ids[0] });
    expect(parseDecision({ code: 'OK', outfitId: 'x' }, 'keep')).toBeNull();
    expect(parseDecision({ code: 'IN_TRASH' }, 'keep')).toEqual({ code: 'IN_TRASH', outfitId: null });
    expect(parseDecision({ code: 'OK', replayed: true }, 'remove')).toEqual({ code: 'OK', outfitId: null });
    expect(parseDecision({ code: 'STALE', x: 1 }, 'keep')).toBeNull();
    expect(parseDecision({ code: 'NOPE' }, 'undo')).toBeNull();
    expect(parseGenerateReply(200, { code: 'OK', suggested: 2, judged: 5, remaining: true })).toEqual({ code: 'OK', suggested: 2, judged: 5, remaining: true });
    expect(parseGenerateReply(200, { code: 'OK', suggested: 2 })).toEqual({ code: 'FAILED' });
    expect(parseGenerateReply(429, { code: 'COOLDOWN' })).toEqual({ code: 'COOLDOWN' });
    expect(parseGenerateReply(503, { code: 'SOMETHING' })).toEqual({ code: 'FAILED' });
    expect(parseGenerateReply(200, { code: 'BUSY' })).toEqual({ code: 'FAILED' });
  });
  it('counts toward the shared monthly figure like the other purposes', () => {
    expect(sharedFigures(status())).toMatchObject({ usedMicro: '0', limitMicro: '17940000' });
  });
});

describe('suggested outfits: what each state shows', () => {
  const ready = (s: OutfitGenStatus) => ({ kind: 'ready' as const, status: s });
  it('stays inert until the backend has the feature, and never prompts an account that is not set up', () => {
    expect(outfitGenView({ kind: 'unknown' }, false, false)).toMatchObject({ kind: 'hidden', card: false, section: false });
    expect(outfitGenView({ kind: 'missing' }, false, false).card).toBe(false);
    expect(outfitGenView({ kind: 'failed' }, false, false).card).toBe(false);
    expect(outfitGenView(ready(status({}, 'UNCONFIGURED', false) ), false, false).card).toBe(false);
  });
  it('shows consent, the running state and Turn off where they belong', () => {
    expect(outfitGenView(ready(status({}, 'CONSENT_REQUIRED', false)), false, false)).toMatchObject({ kind: 'off', turnOn: true, turnOff: false, section: true, run: false });
    expect(outfitGenView(ready(status({}, 'CONSENT_REQUIRED', true)), false, false)).toMatchObject({ kind: 'renew', turnOn: true, turnOff: true });
    expect(outfitGenView(ready(status()), false, false)).toMatchObject({ kind: 'on', turnOff: true, run: true, section: true });
    expect(outfitGenView(ready(status({}, 'INACTIVE', true)), true, false)).toMatchObject({ kind: 'paused', turnOff: true, section: false });
    expect(outfitGenView({ kind: 'failed' }, true, false)).toMatchObject({ kind: 'loadFailed', section: true });
    const other = { ...status(), policy: { ...status().policy!, manifestId: 'other' } };
    expect(outfitGenView(ready(other), true, false)).toMatchObject({ kind: 'unavailable', turnOff: true, run: false });
  });
});

describe('suggested outfits: when an automatic run may start', () => {
  it('needs consent, a supported policy, a quiet server and something new', () => {
    expect(autoBlock(status(), local())).toBeNull();
    expect(autoBlock(null, local())).toBe('consent');
    expect(autoBlock(status({}, 'CONSENT_REQUIRED', false), local())).toBe('consent');
    expect(autoBlock(status({}, 'INACTIVE', true), local())).toBe('unavailable');
    expect(autoBlock(status({ autoUnassessed: 0 }), local())).toBe('nothing-new');
    expect(autoBlock(status({ live: true }), local())).toBe('live');
    expect(autoBlock(status({ pending: 40 }), local())).toBe('full');
    expect(autoBlock(status({ autoCallsLeft: 0 }), local())).toBe('calls');
    expect(autoBlock(status({ budget: { ...BUDGET, usedMicro: '17900000', remainingMicro: '40000' } }), local())).toBe('limit');
  });
  it('waits out the server cooldown and its own after any failure', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    expect(autoBlock(status({ cooldownUntilMs: now + 1000 }), local())).toBe('cooldown');
    expect(autoBlock(status({ cooldownUntilMs: now - 1 }), local())).toBeNull();
    expect(autoBlock(status(), local({ failedAtMs: 10_000_000 - AUTO_COOLDOWN_MS + 1 }))).toBe('cooldown');
    expect(autoBlock(status(), local({ failedAtMs: 10_000_000 - AUTO_COOLDOWN_MS }))).toBeNull();
  });
  it('never runs offline, in the background, twice at once or beyond three calls', () => {
    expect(autoBlock(status(), local({ online: false }))).toBe('offline');
    expect(autoBlock(status(), local({ visible: false }))).toBe('hidden');
    expect(autoBlock(status(), local({ running: true }))).toBe('running');
    expect(autoBlock(status(), local({ autoCalls: 3 }))).toBe('calls');
  });
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function supabase() {
  const client = createClient<Database>(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const session: Session = { access_token: testAccessToken(owner), refresh_token: 'fictional-unit-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  return client;
}
const suggestion = (n: number) => ({ id: `30000000-0000-4000-8000-00000000000${n}`, itemIds: [ids[0]!, ids[1]!], title: `Set ${n}`, reason: 'Calm.', occasion: 'smart' as const, score: 9 });
function harness(statuses: OutfitGenStatus[] = [status()]) {
  const abort = new AbortController();
  const store = new OutfitGenStore(supabase(), config, { ownerId: owner, epoch: 1, signal: abort.signal });
  const queue = [...statuses];
  const fake = {
    outfitGenStatus: vi.fn(async () => ({ kind: 'ready' as const, status: queue.length > 1 ? queue.shift()! : queue[0]! })),
    outfitGenConsent: vi.fn(async (enabled: boolean) => ({ kind: 'applied' as const, status: status({}, 'OK', enabled).consent!.enabled ? status() : status({}, 'CONSENT_REQUIRED', false) })),
    list: vi.fn(async () => ({ kind: 'ok' as const, suggestions: [suggestion(1), suggestion(2)] })),
    keep: vi.fn<(id: string, outfit: string) => Promise<{ code: 'OK'; outfitId: string }>>(async () => ({ code: 'OK', outfitId: ids[3]! })),
    remove: vi.fn(async () => ({ code: 'OK' as const, outfitId: null })),
    undoRemove: vi.fn(async () => ({ code: 'OK' as const, outfitId: null })),
    generate: vi.fn<(input: { requestId: string; mode: string; language: string }) => Promise<GenerateReply>>(async () => ({ code: 'OK', suggested: 1, judged: 4, remaining: false })),
  };
  store.api = fake as unknown as OutfitGenClient;
  return { store, abort, fake };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// The runner reads the page's online and visibility state; a plain Node test has neither.
const page = (onLine = true, visibilityState = 'visible') => { vi.stubGlobal('navigator', { onLine }); vi.stubGlobal('document', { visibilityState }); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('suggested outfits: automatic runs', () => {
  beforeEach(() => page());
  it('runs once for a new garment, with the real contract and no retry on failure', async () => {
    const h = harness();
    await runAuto(h.store, 'fi');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    const [input] = h.fake.generate.mock.calls[0] as unknown as [{ requestId: string; mode: string; language: string }];
    expect(input).toMatchObject({ mode: 'auto', language: 'fi' });
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(input).sort()).toEqual(['language', 'mode', 'requestId']);
    // A failed run starts the local cooldown, so the next trigger does nothing and nothing is retried.
    const failing = harness();
    failing.fake.generate.mockResolvedValue({ code: 'FAILED' });
    await runAuto(failing.store, 'en');
    await runAuto(failing.store, 'en');
    await runAuto(failing.store, 'en');
    expect(failing.fake.generate).toHaveBeenCalledTimes(1);
  });
  it('goes on only while the server says more is left, and at most three calls in a scope', async () => {
    const h = harness();
    h.fake.generate.mockResolvedValue({ code: 'OK', suggested: 1, judged: 8, remaining: true });
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(3);
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(3);
    const done = harness();
    done.fake.generate.mockResolvedValueOnce({ code: 'OK', suggested: 0, judged: 0, remaining: true });
    await runAuto(done.store, 'en');
    expect(done.fake.generate).toHaveBeenCalledTimes(1);
  });
  it('does nothing without consent, with nothing new, offline or in the background', async () => {
    const off = harness([status({}, 'CONSENT_REQUIRED', false)]);
    await runAuto(off.store, 'en');
    const none = harness([status({ autoUnassessed: 0 })]);
    await runAuto(none.store, 'en');
    expect(off.fake.generate).not.toHaveBeenCalled();
    expect(none.fake.generate).not.toHaveBeenCalled();
    page(false);
    const offline = harness();
    await runAuto(offline.store, 'en');
    expect(offline.fake.generate).not.toHaveBeenCalled();
    page(true, 'hidden');
    const hidden = harness();
    await runAuto(hidden.store, 'en');
    expect(hidden.fake.generate).not.toHaveBeenCalled();
  });
  it('never overlaps itself and stops when the scope ends', async () => {
    const h = harness();
    const reply = deferred<GenerateReply>();
    h.fake.generate.mockReturnValueOnce(reply.promise);
    const first = runAuto(h.store, 'en');
    await tick();
    await runAuto(h.store, 'en');
    await runManual(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    h.abort.abort();
    reply.resolve({ code: 'OK', suggested: 1, judged: 1, remaining: true });
    await first;
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
  });
});

describe('suggested outfits: manual runs, consent and decisions', () => {
  beforeEach(() => page());
  it('runs one manual call per tap and says plainly what happened', async () => {
    const h = harness();
    await readStatus(h.store);
    await runManual(h.store, 'sv');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(h.fake.generate.mock.calls[0]![0]).toMatchObject({ mode: 'manual', language: 'sv' });
    expect(h.store.get().notices.map((n) => n.key)).toEqual(['outfitgen.found_other']);
    expect(manualNotices({ code: 'OK', suggested: 0, judged: 3, remaining: true }).map((n) => n.key)).toEqual(['outfitgen.nothingNew', 'outfitgen.more']);
    expect(manualNotices({ code: 'BUSY' })[0]!.key).toBe('outfitgen.busy');
    expect(manualNotices({ code: 'PENDING_FULL' })[0]!.key).toBe('outfitgen.full');
    expect(manualNotices({ code: 'FAILED' })[0]!.key).toBe('outfitgen.failed');
    expect(manualNotices({ code: 'TIMEOUT' })[0]!.key).toBe('outfitgen.failed');
  });
  it('does not run manually without consent or over the limit', async () => {
    const off = harness([status({}, 'CONSENT_REQUIRED', false)]);
    await readStatus(off.store);
    await runManual(off.store, 'en');
    const limit = harness([status({ budget: { ...BUDGET, usedMicro: '17900000', remainingMicro: '40000' } })]);
    await readStatus(limit.store);
    await runManual(limit.store, 'en');
    expect(off.fake.generate).not.toHaveBeenCalled();
    expect(limit.fake.generate).not.toHaveBeenCalled();
  });
  it('turns on and off through consent, and keeps the old state when the write is refused', async () => {
    const h = harness([status({}, 'CONSENT_REQUIRED', false)]);
    await readStatus(h.store);
    expect(viewOf(h.store.get()).turnOn).toBe(true);
    await writeConsent(h.store, true);
    expect(h.fake.outfitGenConsent).toHaveBeenCalledWith(true);
    expect(viewOf(h.store.get()).kind).toBe('on');
    h.fake.outfitGenConsent.mockRejectedValueOnce(new Error('lost'));
    await writeConsent(h.store, false);
    expect(h.store.get().unresolved).toBe(true);
  });
  it('keeps, removes and undoes through the server and drops cards the server refuses', async () => {
    const h = harness();
    await readList(h.store);
    expect(h.store.get().list.suggestions).toHaveLength(2);
    await expect(keepSuggestion(h.store, suggestion(1).id)).resolves.toEqual({ code: 'OK' });
    expect(h.store.get().list.suggestions.map((s) => s.id)).toEqual([suggestion(2).id]);
    expect(h.fake.keep.mock.calls[0]![0]).toBe(suggestion(1).id);
    expect(h.store.get().notices[0]!.key).toBe('outfitgen.kept');
    await removeSuggestion(h.store, suggestion(2).id);
    expect(h.store.get().list.suggestions).toHaveLength(0);
    expect(h.store.get().removed?.id).toBe(suggestion(2).id);
    await undoRemoval(h.store);
    expect(h.store.get().removed).toBeNull();
    expect(h.store.get().notices[0]!.key).toBe('outfitgen.restored');
    const refused = harness();
    await readList(refused.store);
    refused.fake.list.mockResolvedValue({ kind: 'ok', suggestions: [] });
    for (const [code, key] of [['STALE', 'outfitgen.stale'], ['IN_TRASH', 'outfitgen.inTrash'], ['CONFLICT', 'outfitgen.conflict']] as const) {
      refused.store.update({ list: { kind: 'ready', suggestions: [suggestion(1)] } });
      refused.fake.keep.mockResolvedValueOnce({ code, outfitId: null } as never);
      await keepSuggestion(refused.store, suggestion(1).id);
      expect(refused.store.get().notices[0]!.key).toBe(key);
      expect(refused.store.get().list.suggestions.some((s) => s.id === suggestion(1).id)).toBe(false);
    }
    refused.store.update({ list: { kind: 'ready', suggestions: [suggestion(1)] } });
    refused.fake.keep.mockResolvedValueOnce({ code: 'BUSY', outfitId: null } as never);
    await keepSuggestion(refused.store, suggestion(1).id);
    expect(refused.store.get().notices[0]!.key).toBe('outfitgen.decideBusy');
    expect(refused.store.get().list.suggestions).toHaveLength(1);
    refused.fake.undoRemove.mockResolvedValueOnce({ code: 'CONFLICT', outfitId: null } as never);
    refused.store.update({ removed: suggestion(1) });
    await undoRemoval(refused.store);
    expect(refused.store.get().notices[0]!.key).toBe('outfitgen.undoConflict');
  });
});

describe('suggested outfits: triggers', () => {
  const scope = () => ({ ownerId: owner, epoch: 1, signal: new AbortController().signal });
  it('waits 90 seconds after the last Save and makes one run for several Saves', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const trigger = new OutfitGenTrigger(scope(), async () => ({ run }), () => 'en');
      trigger.noteSaved();
      await vi.advanceTimersByTimeAsync(60_000);
      trigger.noteSaved();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('en');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('runs once when the app opens and not again', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const trigger = new OutfitGenTrigger(scope(), async () => ({ run }), () => 'sv');
      trigger.appOpen();
      trigger.appOpen();
      await vi.advanceTimersByTimeAsync(10_000);
      trigger.appOpen();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('sv');
    } finally { vi.useRealTimers(); }
  });
  it('stays silent when the store is unavailable or throws, and stops with the scope', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const run = vi.fn(async () => { throw new Error('boom'); });
      const none = new OutfitGenTrigger({ ownerId: owner, epoch: 1, signal: abort.signal }, async () => null, () => 'en');
      const throws = new OutfitGenTrigger({ ownerId: owner, epoch: 1, signal: abort.signal }, async () => ({ run }), () => 'en');
      none.noteSaved(); throws.noteSaved();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(run).toHaveBeenCalledTimes(1);
      throws.noteSaved();
      abort.abort();
      await vi.advanceTimersByTimeAsync(200_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
