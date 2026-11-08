import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import type { OutfitGenClient } from '../../src/data/outfitgen';
import { AI_GUARD_RESUMED_EVENT } from '../../src/domain/ai-guard';
import { OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { passLines } from '../../src/domain/outfitgen-pass';
import {
  AUTO_COOLDOWN_MS, autoBlock, outfitGenView, parseDecision, parseGenerateReply, parseOutfitGenStatus, parseSuggestionList,
  type AutoLocal, type GenerateReply, type OutfitGenStatus,
} from '../../src/domain/outfitgen-app';
import {
  OutfitGenStore, keepSuggestion, pausePass, readList, readStatus, removeSuggestion, runAuto, runPass, stopPass, undoRemoval, viewOf, writeConsent,
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
    consent: { enabled, noticeRevision: enabled ? OUTFITGEN_NOTICE_REVISION : null, consentedAt: enabled ? '2026-11-01T00:00:00Z' : null },
    policy: code === 'UNCONFIGURED' ? null : { activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST, modelId: OUTFITGEN_MODEL, maxRequestMicro: '373402' },
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
    // A count above the server's cap is read as it is, so it can never hide Settings or Turn off.
    expect(parseOutfitGenStatus(raw({ pending: 41 }))).toMatchObject({ code: 'OK', pending: 41 });
    expect(outfitGenView({ kind: 'ready', status: status({ pending: 41 }) }, true, false)).toMatchObject({ kind: 'on', turnOff: true, card: true });
    expect(autoBlock(status({ pending: 41 }), local())).toBe('full');
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
    expect(parseDecision({ code: 'PENDING_FULL' }, 'undo')).toEqual({ code: 'PENDING_FULL', outfitId: null });
    expect(parseDecision({ code: 'OK', replayed: true }, 'remove')).toEqual({ code: 'OK', outfitId: null });
    expect(parseDecision({ code: 'STALE', x: 1 }, 'keep')).toBeNull();
    expect(parseDecision({ code: 'NOPE' }, 'undo')).toBeNull();
    expect(parseGenerateReply(200, { code: 'OK', suggested: 2, judged: 5, remaining: true })).toEqual({ code: 'OK', suggested: 2, judged: 5, remaining: true });
    expect(parseGenerateReply(200, { code: 'OK', suggested: 2 })).toEqual({ code: 'FAILED' });
    expect(parseGenerateReply(429, { code: 'COOLDOWN' })).toEqual({ code: 'COOLDOWN' });
    expect(parseGenerateReply(503, { code: 'SOMETHING' })).toEqual({ code: 'FAILED' });
    expect(parseGenerateReply(403, { code: 'PAUSED' })).toEqual({ code: 'PAUSED' });
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
const suggestion = (n: number) => ({ id: `30000000-0000-4000-8000-00000000000${n}`, itemIds: [ids[0]!, ids[1]!], title: `Set ${n}`, reason: 'Calm.', occasion: 'smart' as const, score: 9, createdAtMs: 1_000 });
function harness(statuses: OutfitGenStatus[] = [status()]) {
  const abort = new AbortController();
  const store = new OutfitGenStore(supabase(), config, { ownerId: owner, epoch: 1, signal: abort.signal });
  const queue = [...statuses];
  // What the server holds; the decisions below change it, as the real ones do.
  const server = [suggestion(1), suggestion(2)];
  const everything = [suggestion(1), suggestion(2)];
  const drop = (id: string) => { const at = server.findIndex((entry) => entry.id === id); if (at >= 0) server.splice(at, 1); };
  const fake = {
    outfitGenStatus: vi.fn(async () => ({ kind: 'ready' as const, status: queue.length > 1 ? queue.shift()! : queue[0]! })),
    outfitGenConsent: vi.fn(async (enabled: boolean) => ({ kind: 'applied' as const, status: status({}, 'OK', enabled).consent!.enabled ? status() : status({}, 'CONSENT_REQUIRED', false) })),
    list: vi.fn(async () => ({ kind: 'ok' as const, suggestions: [...server] })),
    keep: vi.fn<(id: string, outfit: string) => Promise<{ code: 'OK'; outfitId: string }>>(async (id) => { drop(id); return { code: 'OK', outfitId: ids[3]! }; }),
    remove: vi.fn(async (id: string) => { drop(id); return { code: 'OK' as const, outfitId: null }; }),
    undoRemove: vi.fn(async (id: string) => { if (!server.some((entry) => entry.id === id)) server.push(everything.find((entry) => entry.id === id)!); return { code: 'OK' as const, outfitId: null }; }),
    generate: vi.fn<(input: { requestId: string; mode: string; language: string }, signal?: AbortSignal, before?: () => string | null) => Promise<GenerateReply>>(
      async (...args) => (args[2]?.() ? { code: 'NOT_SENT' } : { code: 'OK', suggested: 1, judged: 4, remaining: false })),
  };
  store.api = fake as unknown as OutfitGenClient;
  return { store, abort, fake, server };
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
  it('stops automatic runs on PAUSED until Resume, and a manual run says so plainly (AI-GUARD1)', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const h = harness();
    h.fake.generate.mockResolvedValue({ code: 'PAUSED' });
    await runAuto(h.store, 'en');
    expect(h.store.guardPaused).toBe(true);
    // Even after the local cooldown would have ended, no automatic run is sent.
    h.store.failedAtMs = null;
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(passLines('paused', null, null).map((n) => n.key)).toEqual(['aiGuard.paused']);
    events.dispatchEvent(new Event(AI_GUARD_RESUMED_EVENT));
    expect(h.store.guardPaused).toBe(false);
    h.fake.generate.mockResolvedValue({ code: 'OK', suggested: 1, judged: 4, remaining: false });
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(2);
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
    await runPass(h.store, 'en');
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
    const h = harness([status(), status(), status({ unassessed: 0 })]);
    await readStatus(h.store);
    await runPass(h.store, 'sv');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(h.fake.generate.mock.calls[0]![0]).toMatchObject({ mode: 'manual', language: 'sv' });
    expect(h.store.get().notices.map((n) => n.key)).toEqual(['outfitgen.passAll', 'outfitgen.found_other']);
  });
  it('does not run manually without consent or over the limit', async () => {
    const off = harness([status({}, 'CONSENT_REQUIRED', false)]);
    await readStatus(off.store);
    await runPass(off.store, 'en');
    const limit = harness([status({ budget: { ...BUDGET, usedMicro: '17900000', remainingMicro: '40000' } })]);
    await readStatus(limit.store);
    await runPass(limit.store, 'en');
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
    // The server still holds the card when Keep is only busy.
    refused.fake.list.mockResolvedValue({ kind: 'ok', suggestions: [suggestion(1)] });
    refused.store.update({ list: { kind: 'ready', suggestions: [suggestion(1)] } });
    refused.fake.keep.mockResolvedValueOnce({ code: 'BUSY', outfitId: null } as never);
    await keepSuggestion(refused.store, suggestion(1).id);
    await tick();
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
      expect(run).toHaveBeenCalledWith('en', expect.any(Function));
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
      expect(run).toHaveBeenCalledWith('sv', expect.any(Function));
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

describe('suggested outfits: consent changes, newer Saves and ordering', () => {
  beforeEach(() => page());
  it('sends nothing when Turn off is requested while the status read is in flight', async () => {
    const h = harness();
    await readStatus(h.store);
    const read = deferred<{ kind: 'ready'; status: OutfitGenStatus }>();
    h.fake.outfitGenStatus.mockReturnValueOnce(read.promise);
    const run = runAuto(h.store, 'en');
    await tick();
    const off = writeConsent(h.store, false);
    read.resolve({ kind: 'ready', status: status() });
    await Promise.all([run, off]);
    expect(h.fake.generate).not.toHaveBeenCalled();
    expect(h.fake.outfitGenConsent).toHaveBeenCalledWith(false);
    expect(h.store.failedAtMs).toBeNull();
  });
  it('checks again right before the request: a change after the status read stops it, with no cooldown and no call counted', async () => {
    const h = harness();
    h.fake.generate.mockImplementationOnce(async (...args) => {
      h.store.update({ writing: true });
      return args[2]?.() ? { code: 'NOT_SENT' } : { code: 'OK', suggested: 1, judged: 1, remaining: false };
    });
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(h.store.failedAtMs).toBeNull();
    expect(h.store.autoCalls).toBe(0);
    expect(h.store.get().notices).toEqual([]);
  });
  it('stops an automatic run that a newer Save has superseded', async () => {
    const h = harness();
    let newest = true;
    h.fake.generate.mockImplementationOnce(async (...args) => { newest = false; return args[2]?.() ? { code: 'NOT_SENT' } : { code: 'OK', suggested: 1, judged: 1, remaining: false }; });
    await runAuto(h.store, 'en', () => newest);
    expect(h.store.autoCalls).toBe(0);
    const stale = harness();
    await runAuto(stale.store, 'en', () => false);
    expect(stale.fake.generate).not.toHaveBeenCalled();
  });
  it('a manual run takes a fresh status first and sends nothing when consent is gone', async () => {
    const h = harness([status(), status({}, 'CONSENT_REQUIRED', false)]);
    await readStatus(h.store);
    await runPass(h.store, 'en');
    expect(h.fake.outfitGenStatus).toHaveBeenCalledTimes(2);
    expect(h.fake.generate).not.toHaveBeenCalled();
    expect(h.store.get().notices.map((n) => n.key)).toEqual(['outfitgen.off']);
    expect(h.store.get().running).toBeNull();
    const writing = harness();
    await readStatus(writing.store);
    writing.store.update({ writing: true });
    await runPass(writing.store, 'en');
    expect(writing.fake.generate).not.toHaveBeenCalled();
  });
  it('an older list read cannot bring back a card that was decided meanwhile', async () => {
    const h = harness();
    await readList(h.store);
    const stale = deferred<{ kind: 'ok'; suggestions: ReturnType<typeof suggestion>[] }>();
    h.fake.list.mockReturnValueOnce(stale.promise);
    const reading = readList(h.store, 'fresh');
    await tick();
    await keepSuggestion(h.store, suggestion(1).id);
    stale.resolve({ kind: 'ok', suggestions: [suggestion(1), suggestion(2)] });
    await reading;
    await tick();
    await readList(h.store, 'fresh');
    expect(h.store.get().list.suggestions.map((s) => s.id)).toEqual([suggestion(2).id]);
    // The same holds for Remove, and the snapshot after a decision is a new read.
    const calls = h.fake.list.mock.calls.length;
    await removeSuggestion(h.store, suggestion(2).id);
    await tick();
    expect(h.fake.list.mock.calls.length).toBeGreaterThan(calls);
    expect(h.store.get().list.suggestions).toEqual([]);
  });
  it('a refused decision still ends with a list read, so a refresh it overlapped is not lost', async () => {
    const h = harness();
    await readList(h.store);
    const keep = deferred<{ code: 'BUSY'; outfitId: null }>();
    h.fake.keep.mockReturnValueOnce(keep.promise as never);
    const deciding = keepSuggestion(h.store, suggestion(1).id);
    await tick();
    // A run finishes and refreshes the list while Keep is still waiting; the server now holds a third card.
    h.server.push(suggestion(3));
    const refresh = deferred<{ kind: 'ok'; suggestions: ReturnType<typeof suggestion>[] }>();
    h.fake.list.mockReturnValueOnce(refresh.promise);
    const reading = readList(h.store, 'fresh');
    await tick();
    keep.resolve({ code: 'BUSY', outfitId: null });
    await deciding;
    refresh.resolve({ kind: 'ok', suggestions: [suggestion(1), suggestion(2), suggestion(3)] });
    await reading;
    await tick();
    await tick();
    expect(h.store.get().notices[0]!.key).toBe('outfitgen.decideBusy');
    expect(h.store.get().list.suggestions.map((s) => s.id).sort()).toEqual([suggestion(1).id, suggestion(2).id, suggestion(3).id]);
  });
  it('keeps the removal offered when Undo finds the list full', async () => {
    const h = harness();
    await readList(h.store);
    await removeSuggestion(h.store, suggestion(1).id);
    h.fake.undoRemove.mockResolvedValueOnce({ code: 'PENDING_FULL', outfitId: null } as never);
    await undoRemoval(h.store);
    expect(h.store.get().notices.map((n) => n.key)).toEqual(['outfitgen.full', 'outfitgen.removed']);
    expect(h.store.get().removed?.id).toBe(suggestion(1).id);
    await undoRemoval(h.store);
    expect(h.store.get().removed).toBeNull();
  });
  it('makes no run from a trigger that a newer Save superseded while it was loading', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const loaded = deferred<{ run: typeof run }>();
      const trigger = new OutfitGenTrigger({ ownerId: owner, epoch: 1, signal: new AbortController().signal }, () => loaded.promise, () => 'en');
      trigger.noteSaved();
      await vi.advanceTimersByTimeAsync(90_000);
      trigger.noteSaved();
      loaded.resolve({ run });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(run).toHaveBeenCalledTimes(1);
      const current = (run.mock.calls[0] as unknown as [string, () => boolean])[1];
      expect(current()).toBe(true);
      trigger.noteSaved();
      expect(current()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('suggested outfits: one press works through the garments', () => {
  beforeEach(() => page());
  type Hs = ReturnType<typeof harness>;
  const primed = (statuses: OutfitGenStatus[]) => {
    const h = harness(statuses);
    h.store.update({ read: { kind: 'ready', status: statuses[0]! }, known: true });
    return h;
  };
  const left = (n: number, over: Record<string, unknown> = {}) => status({ unassessed: n, ...over });
  const more = (suggested = 1, judged = 5): GenerateReply => ({ code: 'OK', suggested, judged, remaining: true });
  const last = (suggested = 1): GenerateReply => ({ code: 'OK', suggested, judged: 3, remaining: false });
  const keys = (h: Hs) => h.store.get().notices.map((n) => n.key);
  /**
   * Replies like the real client: a request only counts as sent (a "post") when the last check right before it passes, which
   * happens after `gate` (the client's own awaits, such as authentication) has been released.
   */
  function wire(h: Hs, replies: GenerateReply[], gate?: Deferred<void>) {
    const posts: GenerateReply[] = [];
    h.fake.generate.mockImplementation(async (_input, _signal, before) => {
      if (gate) await gate.promise;
      if (before?.()) return { code: 'NOT_SENT' };
      const reply = replies.shift() ?? last(0);
      posts.push(reply);
      return reply;
    });
    return posts;
  }
  const doc = (visibilityState = 'visible') => {
    const target = Object.assign(new EventTarget(), { visibilityState });
    const win = new EventTarget();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('document', target);
    vi.stubGlobal('window', win);
    return { target, win, hide: () => { target.visibilityState = 'hidden'; target.dispatchEvent(new Event('visibilitychange')); },
      show: () => { target.visibilityState = 'visible'; target.dispatchEvent(new Event('visibilitychange')); } };
  };

  it('calls one at a time until nothing is left, shows what is left, and says "all checked" only after a final read of zero', async () => {
    const h = primed([left(6), left(4), left(2), left(0)]);
    h.fake.generate.mockResolvedValueOnce(more(2)).mockResolvedValueOnce(more(1)).mockResolvedValueOnce(last(3));
    const seen: string[] = [];
    h.store.subscribe(() => { const p = h.store.get().pass; if (p) seen.push(`${p.left}/${p.found}`); });
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(3);
    const requests = h.fake.generate.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(new Set(requests).size).toBe(3);
    expect(h.fake.generate.mock.calls.every((call) => (call[0] as { mode: string }).mode === 'manual')).toBe(true);
    expect(seen).toContain('6/0');
    expect(seen).toContain('4/2');
    expect(h.store.get().notices).toMatchObject([{ key: 'outfitgen.passAll' }, { key: 'outfitgen.found_other', count: 6 }]);
    expect(h.store.get()).toMatchObject({ running: null, pass: null });
    expect(h.store.passActive).toBe(false);
  });
  it('does not claim everything was checked when the final status read fails', async () => {
    const h = primed([left(2), left(2)]);
    h.fake.generate.mockResolvedValueOnce(last(1));
    h.fake.outfitGenStatus.mockImplementationOnce(async () => ({ kind: 'ready' as const, status: left(2) }))
      .mockImplementation(async () => { throw new Error('offline'); });
    await runPass(h.store, 'en');
    expect(keys(h)).toEqual(['outfitgen.found_other', 'outfitgen.passUnconfirmed']);
  });
  it('shows what it found after each call, before the next one', async () => {
    const h = primed([left(4), left(2)]);
    const lists: number[] = [];
    h.fake.generate.mockImplementationOnce(async () => { lists.push(h.fake.list.mock.calls.length); return more(); })
      .mockImplementationOnce(async () => { lists.push(h.fake.list.mock.calls.length); return last(); });
    await runPass(h.store, 'en');
    expect(lists[1]! - lists[0]!).toBeGreaterThanOrEqual(1);
  });
  it('never starts a second pass while one is going, and an automatic run in flight is said plainly (BUSY)', async () => {
    const h = primed([left(4)]);
    const reply = deferred<GenerateReply>();
    h.fake.generate.mockReturnValueOnce(reply.promise);
    const first = runPass(h.store, 'en');
    await tick();
    await runPass(h.store, 'en');
    await runAuto(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    reply.resolve(last());
    await first;
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    const auto = primed([left(4)]);
    auto.store.autoActive = true;
    await runPass(auto.store, 'en');
    expect(auto.fake.generate).not.toHaveBeenCalled();
    expect(keys(auto)).toEqual(['outfitgen.busy']);
    expect(auto.store.autoActive).toBe(true);
  });

  describe('the last check right before the request leaves (after the client has awaited its own authentication)', () => {
    const interferences: [string, (h: Hs, env: ReturnType<typeof doc>) => void][] = [
      ['Stop', (h) => stopPass(h.store)],
      ['leaving the screen', (h) => pausePass(h.store)],
      ['the page being hidden', (_h, env) => env.hide()],
      ['the page going away (pagehide)', (_h, env) => { env.win.dispatchEvent(new Event('pagehide')); }],
      ['consent being turned off', (h) => h.store.update({ read: { kind: 'ready', status: status({}, 'CONSENT_REQUIRED', false) } })],
      ['the monthly budget being used up', (h) => h.store.update({ read: { kind: 'ready', status: left(6, { budget: { ...BUDGET, usedMicro: '17900000', remainingMicro: '40000' } }) } })],
      ['a consent change being written', (h) => { h.store.update({ writing: true }); }],
      ['the owner scope ending', (h) => h.abort.abort()],
    ];
    it('sends the request when nothing changed (control)', async () => {
      doc();
      const h = primed([left(6)]);
      const gate = deferred<void>();
      const posts = wire(h, [last()], gate);
      const run = runPass(h.store, 'en');
      await tick();
      gate.resolve();
      await run;
      expect(posts).toHaveLength(1);
    });
    it.each(interferences)('sends nothing when %s happens during the delay, and nothing later either', async (_name, interfere) => {
      const env = doc();
      const h = primed([left(6)]);
      const gate = deferred<void>();
      const posts = wire(h, [more(), more(), last()], gate);
      const run = runPass(h.store, 'en');
      await tick();
      interfere(h, env);
      gate.resolve();
      await run;
      env.show();
      await tick();
      expect(posts).toHaveLength(0);
    });
  });

  it('Stop lets the call in flight finish and sends nothing more', async () => {
    doc();
    const h = primed([left(6)]);
    const reply = deferred<GenerateReply>();
    h.fake.generate.mockReturnValueOnce(reply.promise);
    const run = runPass(h.store, 'en');
    await tick();
    stopPass(h.store);
    expect(h.store.get().pass?.stopping).toBe(true);
    reply.resolve(more(2));
    await run;
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(h)).toEqual(['outfitgen.passStopped_other', 'outfitgen.found_other', 'outfitgen.passContinue']);
    expect(h.store.get().pass).toBeNull();
  });
  it('a page hidden during a call ends the pass for good: coming back, or a restored page, never restarts it', async () => {
    for (const how of ['visibility', 'pagehide'] as const) {
      const env = doc();
      const h = primed([left(6), left(5), left(4)]);
      const reply = deferred<GenerateReply>();
      h.fake.generate.mockReturnValueOnce(reply.promise).mockResolvedValue(more());
      const run = runPass(h.store, 'en');
      await tick();
      if (how === 'visibility') env.hide(); else env.win.dispatchEvent(new Event('pagehide'));
      env.show();
      env.win.dispatchEvent(new Event('pageshow'));
      reply.resolve(more());
      await run;
      env.show();
      await tick();
      expect(h.fake.generate).toHaveBeenCalledTimes(1);
      expect(keys(h)).toContain('outfitgen.passContinue');
    }
  });
  it('leaving the screen pauses a running pass and returning does not restart it', async () => {
    doc();
    const h = primed([left(6), left(5)]);
    const reply = deferred<GenerateReply>();
    h.fake.generate.mockReturnValueOnce(reply.promise).mockResolvedValue(more());
    const run = runPass(h.store, 'en');
    await tick();
    pausePass(h.store);
    reply.resolve(more());
    await run;
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(h)).toContain('outfitgen.passContinue');
    pausePass(h.store);
    expect(h.store.passActive).toBe(false);
  });
  it('ends when the owner signs out, and shows and sends nothing afterwards', async () => {
    const h = primed([left(6)]);
    const reply = deferred<GenerateReply>();
    h.fake.generate.mockReturnValueOnce(reply.promise);
    const run = runPass(h.store, 'en');
    await tick();
    h.abort.abort();
    reply.resolve(more());
    await run;
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(h.store.get().notices).toEqual([]);
    expect(h.store.get().pass).toBeNull();
  });
  it.each<[string, GenerateReply, string]>([
    ['the list is full', { code: 'PENDING_FULL' }, 'outfitgen.full'],
    ['another check is running (for example a picture holding the same owner lock)', { code: 'BUSY' }, 'outfitgen.busy'],
    ['the server limits the calls', { code: 'RATE_LIMIT' }, 'outfitgen.rateLimit'],
    ['the cooldown applies', { code: 'COOLDOWN' }, 'outfitgen.rateLimit'],
    ['the monthly budget is used', { code: 'ALLOWANCE' }, 'outfitgenC.limit'],
    ['the spending guard has paused', { code: 'PAUSED' }, 'aiGuard.paused'],
    ['consent was withdrawn', { code: 'CONSENT_REQUIRED' }, 'outfitgen.off'],
    ['a call fails', { code: 'FAILED' }, 'outfitgen.failed'],
    ['a reply is lost', { code: 'TIMEOUT' }, 'outfitgen.failed'],
  ])('stops, with its own line and no further call, when %s', async (_name, reply, key) => {
    const h = primed([left(6), left(5), left(4)]);
    const posts = wire(h, [more(), reply, more()]);
    await runPass(h.store, 'en');
    expect(posts).toHaveLength(2);
    expect(keys(h).at(-1)).toBe(key);
    expect(keys(h)[0]).toBe('outfitgen.passStopped_other');
    expect(h.store.get().notices[0]).toMatchObject({ count: 4 });
  });
  it('a failure on the very first call stops at once, refreshes what the server holds, and is never repeated', async () => {
    const h = primed([left(6)]);
    h.fake.generate.mockResolvedValue({ code: 'FAILED' });
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(h.fake.list.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(keys(h).at(-1)).toBe('outfitgen.failed');
  });
  it('after a lost reply nothing continues while the server may still hold the call, and a later press goes on once it has settled', async () => {
    const h = primed([left(6), left(6, { live: true })]);
    h.fake.generate.mockResolvedValueOnce({ code: 'TIMEOUT' });
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(h)).toEqual(['outfitgen.busy']);
    // It settled: the next press goes on (a failed settlement is no different: it simply leaves the garments unchecked).
    const settled = primed([left(6)]);
    settled.fake.generate.mockResolvedValueOnce({ code: 'TIMEOUT' }).mockResolvedValueOnce(last());
    await runPass(settled.store, 'en');
    await runPass(settled.store, 'en');
    expect(settled.fake.generate).toHaveBeenCalledTimes(2);
  });
  it('stops, before the next call, when consent is gone, the network is gone or the list is full', async () => {
    const off = primed([left(6), status({ unassessed: 5 }, 'CONSENT_REQUIRED', false)]);
    off.fake.generate.mockResolvedValueOnce(more());
    await runPass(off.store, 'en');
    expect(off.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(off)).toContain('outfitgen.off');

    const offline = primed([left(6), left(5)]);
    offline.fake.generate.mockImplementationOnce(async () => { page(false); return more(); });
    await runPass(offline.store, 'en');
    expect(offline.fake.generate).toHaveBeenCalledTimes(1);

    page();
    const full = primed([left(6), left(5, { pending: 40 })]);
    full.fake.generate.mockResolvedValueOnce(more());
    await runPass(full.store, 'en');
    expect(full.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(full).at(-1)).toBe('outfitgen.full');
  });
  it('stops when another window or device already has a call live, at the start and between calls', async () => {
    const start = primed([left(6, { live: true })]);
    await runPass(start.store, 'en');
    expect(start.fake.generate).not.toHaveBeenCalled();
    expect(keys(start)).toEqual(['outfitgen.busy']);
    const between = primed([left(6), left(5, { live: true })]);
    between.fake.generate.mockResolvedValueOnce(more());
    await runPass(between.store, 'en');
    expect(between.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(between).at(-1)).toBe('outfitgen.busy');
  });
  it('stops short of the reserve of the monthly budget, but not before the first call', async () => {
    const near = { ...BUDGET, usedMicro: '15000000', remainingMicro: '2940000' };
    const h = primed([left(6, { budget: near })]);
    h.fake.generate.mockResolvedValue(more());
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(h).at(-1)).toBe('outfitgen.passReserve');
  });
  it('with nothing unchecked makes one call, even if the reply says more is left', async () => {
    const h = primed([left(0)]);
    h.fake.generate.mockResolvedValue(more(1));
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(1);
    expect(keys(h)).toEqual(['outfitgen.found_other']);
  });
  it('goes on through five calls for one garment, since only a fresh fall of the count is progress', async () => {
    const h = primed([left(1), left(1), left(1), left(1), left(1), left(0)]);
    h.fake.generate.mockResolvedValueOnce(more(0, 4)).mockResolvedValueOnce(more(0, 4)).mockResolvedValueOnce(more(0, 4)).mockResolvedValueOnce(more(0, 4)).mockResolvedValueOnce(last(1));
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(5);
    expect(keys(h)[0]).toBe('outfitgen.passAll');
  });
  it('judging sets without the unchecked count falling is not progress: eight calls end the pass at its safety limit', async () => {
    const h = primed([left(20)]);
    h.fake.generate.mockResolvedValue(more(0, 6));
    await runPass(h.store, 'en');
    expect(h.fake.generate).toHaveBeenCalledTimes(8);
    expect(keys(h).at(-1)).toBe('outfitgen.passSafety');
  });
  it('is bounded by the wardrobe even if every reply says more is left and the count keeps falling', async () => {
    let n = 2;
    const h = primed([left(2)]);
    h.fake.outfitGenStatus.mockImplementation(async () => ({ kind: 'ready' as const, status: left(Math.max(1, n--)) }));
    h.fake.generate.mockResolvedValue(more(0, 2));
    await runPass(h.store, 'en');
    expect(h.fake.generate.mock.calls.length).toBeLessThanOrEqual(16);
    expect(h.store.passActive).toBe(false);
  });
});
