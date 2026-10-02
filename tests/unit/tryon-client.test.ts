import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import {
  parseCancel, parseChainStatus, parseResultImage, parseResults, parseTryOnStatus, tryOnReady, tryOnView, TryOnClient, TryOnError,
  type CancelResult, type ChainStatus, type StepInput, type StepResponse,
} from '../../src/data/tryon';
import { TRYON_LIMITS, TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION, type TryOnStep } from '../../src/domain/tryon';
import {
  RECONCILE_EVERY_MS, RECONCILE_FOR_MS, RUN_LIFETIME_MS, TryOnRun, failureAction, type RunEnvironment, type TryOnApi,
} from '../../src/features/outfits/use-try-on';
import { readTryOnStatus, TryOnStore, tryOnViewOf } from '../../src/features/settings/tryon-store';
import { testAccessToken } from './test-token';

const SERVER = Date.parse('2026-10-05T12:00:00Z');
const OUTFIT = '10000000-0000-4000-8000-000000000001';
const ID = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = (over: Record<string, unknown> = {}) => ({
  activated: true, noticeRevision: TRYON_NOTICE_REVISION, manifestId: TRYON_MANIFEST, modelId: TRYON_MODEL,
  maxRequestMicro: '400000', tryOnAllowanceMicro: '5000000', totalAllowanceMicro: '20000000', maxRequestsPerHour: 20,
  maxSteps: 3, maxResults: 20, resultDays: 7, providerAvailable: true, ...over,
});
const statusRaw = (over: Record<string, unknown> = {}, policyOver: Record<string, unknown> = {}) => ({
  code: 'OK', period: '2026-10', serverTimeMs: SERVER,
  consent: { enabled: true, noticeRevision: TRYON_NOTICE_REVISION, consentedAt: '2026-10-01T00:00:00Z' },
  policy: policy(policyOver), results: 0,
  usage: { tryOnMicro: '0', totalMicro: '0', tryOnLastHour: 0, warning: false }, ...over,
});
const off = { enabled: false, noticeRevision: null, consentedAt: null };

describe('closed try-on replies', () => {
  it('parses the status and refuses extra or inconsistent fields', () => {
    expect(parseTryOnStatus(statusRaw())?.code).toBe('OK');
    expect(parseTryOnStatus({ code: 'UNAVAILABLE' })?.policy).toBeNull();
    expect(parseTryOnStatus({ code: 'OK' })).toBeNull();
    expect(parseTryOnStatus({ ...statusRaw(), extra: 1 })).toBeNull();
    expect(parseTryOnStatus(statusRaw({ consent: { enabled: true, noticeRevision: null, consentedAt: null } }))).toBeNull();
    expect(parseTryOnStatus(statusRaw({}, { maxSteps: 4 }))).toBeNull();
    expect(parseTryOnStatus(statusRaw({}, { resultDays: 30 }))).toBeNull();
    expect(parseTryOnStatus(statusRaw({ policy: null }))).toBeNull();
  });
  it('offers Try on only when activated, consented, supported and available', () => {
    expect(tryOnReady(parseTryOnStatus(statusRaw()))).toBe(true);
    expect(tryOnReady(parseTryOnStatus(statusRaw({}, { activated: false })))).toBe(false);
    expect(tryOnReady(parseTryOnStatus(statusRaw({}, { providerAvailable: false })))).toBe(false);
    expect(tryOnReady(parseTryOnStatus(statusRaw({}, { modelId: 'other' })))).toBe(false);
    expect(tryOnReady(parseTryOnStatus(statusRaw({ consent: off, code: 'CONSENT_REQUIRED' })))).toBe(false);
    expect(tryOnReady(parseTryOnStatus(statusRaw({ serverTimeMs: Date.parse('2027-01-01T00:00:00Z') })))).toBe(false);
    expect(tryOnReady(null)).toBe(false);
  });
  it('keeps Turn off whenever consent is on and hides the card when there is nothing to turn on', () => {
    const ready = (raw: unknown) => ({ kind: 'ready' as const, status: parseTryOnStatus(raw)! });
    expect(tryOnView(ready(statusRaw()), false, false, true)).toEqual({ kind: 'on', turnOn: false, turnOff: true });
    expect(tryOnView(ready(statusRaw({ consent: off, code: 'CONSENT_REQUIRED' })), false, false, false))
      .toEqual({ kind: 'off', turnOn: true, turnOff: false });
    expect(tryOnView(ready(statusRaw({ consent: off, code: 'INACTIVE' }, { activated: false })), false, false, false).kind).toBe('hidden');
    expect(tryOnView(ready(statusRaw({}, { activated: false })), false, false, true)).toEqual({ kind: 'paused', turnOn: false, turnOff: true });
    expect(tryOnView({ kind: 'missing' }, false, false, false).kind).toBe('hidden');
    expect(tryOnView({ kind: 'failed' }, false, true, true)).toEqual({ kind: 'loadFailed', turnOn: false, turnOff: true });
    expect(tryOnView(ready(statusRaw()), true, true, true)).toEqual({ kind: 'unresolved', turnOn: false, turnOff: true });
  });
  it('treats an unavailable status as unknown consent: known-on consent keeps Turn off', () => {
    const unavailable = { kind: 'ready' as const, status: parseTryOnStatus({ code: 'UNAVAILABLE' })! };
    expect(tryOnView(unavailable, false, true, true)).toEqual({ kind: 'paused', turnOn: false, turnOff: true });
    expect(tryOnView(unavailable, false, false, false).kind).toBe('hidden');
  });
  it('parses chain status, Stop, results and result images strictly', () => {
    const chain = { code: 'OK', state: 'running', nextStep: 2, steps: [{ slot: 'top', itemId: ID(1) }], activeAttempt: false,
      resultId: null, expiresAtMs: SERVER };
    expect(parseChainStatus(chain)).toMatchObject({ kind: 'chain', state: 'running', nextStep: 2 });
    expect(parseChainStatus({ ...chain, state: 'paused' })).toBeNull();
    expect(parseChainStatus({ ...chain, steps: [{ slot: 'layer', itemId: ID(1) }] })).toBeNull();
    expect(parseChainStatus({ code: 'NOT_FOUND' })).toEqual({ kind: 'code', code: 'NOT_FOUND' });
    expect(parseCancel({ code: 'COMPLETED', resultId: ID(2) })).toEqual({ code: 'COMPLETED', resultId: ID(2) });
    expect(parseCancel({ code: 'CANCELLED', resultId: null })).toBeNull();
    expect(parseCancel({ code: 'OTHER' })).toBeNull();
    const result = { id: ID(3), outfitId: OUTFIT, itemIds: [ID(1)], bytes: 100, completedAtMs: SERVER, expiresAtMs: SERVER + 1 };
    expect(parseResults({ code: 'OK', results: [result] })).toHaveLength(1);
    expect(parseResults({ code: 'OK', results: [{ ...result, bytes: 600_000 }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: [{ ...result, itemIds: [] }] })).toBeNull();
    const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));
    expect(parseResultImage({ code: 'OK', jpegBase64: jpeg, bytes: 4 })?.kind).toBe('image');
    expect(parseResultImage({ code: 'OK', jpegBase64: jpeg, bytes: 5 })).toBeNull();
    expect(parseResultImage({ code: 'OK', jpegBase64: btoa('GIF89a'), bytes: 6 })).toBeNull();
    expect(parseResultImage({ code: 'NOT_FOUND' })).toEqual({ kind: 'code', code: 'NOT_FOUND' });
  });
});

type Scripted = StepResponse | Error | 'hold';
class Harness {
  now = 0;
  isOnline = true;
  onlineCallbacks: (() => void)[] = [];
  resumeCallbacks: (() => void)[] = [];
  timers: { at: number; callback: () => void; live: boolean }[] = [];
  steps: StepInput[] = [];
  stepReplies: Scripted[] = [];
  chainReplies: (ChainStatus | Error)[] = [];
  chainReads = 0;
  cancels: string[] = [];
  cancelReply: CancelResult = { code: 'CANCELLED' };
  held: { resolve: (value: StepResponse) => void; signal: AbortSignal }[] = [];
  isCurrent = true;
  stopped = false;
  recorded: string[] = [];
  private ids = 0;
  env: RunEnvironment = {
    online: () => this.isOnline,
    whenOnline: (callback) => { this.onlineCallbacks.push(callback); return () => { this.onlineCallbacks = this.onlineCallbacks.filter((entry) => entry !== callback); }; },
    onResume: (callback) => { this.resumeCallbacks.push(callback); return () => { this.resumeCallbacks = this.resumeCallbacks.filter((entry) => entry !== callback); }; },
    setTimer: (callback, ms) => { const timer = { at: this.now + ms, callback, live: true }; this.timers.push(timer); return () => { timer.live = false; }; },
    now: () => this.now,
    uuid: () => ID(100 + (this.ids += 1)),
    sha256: async (bytes) => `hash-${bytes.length}`,
  };
  api: TryOnApi = {
    current: () => this.isCurrent,
    step: (input, signal) => {
      this.steps.push(input);
      const next = this.stepReplies.shift() ?? new TryOnError('UNAVAILABLE');
      if (next === 'hold') return new Promise((resolve) => { this.held.push({ resolve, signal }); });
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    chainStatus: () => {
      this.chainReads += 1;
      const next = this.chainReplies.shift() ?? { kind: 'code', code: 'UNAVAILABLE' };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    cancel: (chainId) => { this.cancels.push(chainId); return Promise.resolve(this.cancelReply); },
  };
  session = { stopped: () => this.stopped, recordStep: (outcome: string) => { this.recorded.push(outcome); } };
  run(steps: TryOnStep[] = [{ slot: 'top', itemId: ID(1) }, { slot: 'bottom', itemId: ID(2) }, { slot: 'footwear', itemId: ID(3) }]) {
    return new TryOnRun(this.api, this.session, this.env, OUTFIT, steps, new Uint8Array(new ArrayBuffer(10)));
  }
  async advance(ms: number) {
    this.now += ms;
    for (const timer of this.timers.filter((entry) => entry.live && entry.at <= this.now)) { timer.live = false; timer.callback(); }
    await flush();
  }
}
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const picture = (size: number): StepResponse => ({ kind: 'intermediate', body: new Uint8Array(new ArrayBuffer(size)), sha256: `hash-${size}` });
const plan: TryOnStep[] = [{ slot: 'top', itemId: ID(1) }, { slot: 'bottom', itemId: ID(2) }, { slot: 'footwear', itemId: ID(3) }];
const chain = (over: Partial<Extract<ChainStatus, { kind: 'chain' }>>): ChainStatus => ({ kind: 'chain', state: 'running', nextStep: 1,
  steps: plan, activeAttempt: false, resultId: null, expiresAtMs: 0, ...over });

describe('the try-on run (rev4 §2.3-§3.2)', () => {
  it('sends each step once, chains the previous picture and drops everything at the result', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), { kind: 'result', resultId: ID(9), expiresAtMs: 5 }];
    const run = h.run();
    run.start();
    await flush();
    expect(h.steps.map((step) => [step.step, step.person.length, step.outfitId ?? null, step.chainId]))
      .toEqual([[1, 10, OUTFIT, run.id], [2, 20, null, run.id], [3, 30, null, run.id]]);
    expect(new Set(h.steps.map((step) => step.requestId)).size).toBe(3);
    expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), expiresAtMs: 5, alreadyFinished: false });
    expect(run.holdsPicture()).toBe(false);
    expect(h.recorded).toEqual(['ok', 'ok', 'ok']);
  });
  it('settles a picture whose hash does not match, or a result before the last step, from the chain status', async () => {
    const h = new Harness();
    h.stepReplies = [{ kind: 'intermediate', body: new Uint8Array(new ArrayBuffer(20)), sha256: 'other' }];
    h.chainReplies = [chain({ nextStep: 2 })];
    const run = h.run();
    run.start();
    await flush();
    // The server went on to step 2, but the picture can't be used: nothing is sent again.
    expect(h.chainReads).toBe(1);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'lost' });
    expect(h.steps).toHaveLength(1);
    expect(run.holdsPicture()).toBe(false);
    const early = new Harness();
    early.stepReplies = [{ kind: 'result', resultId: ID(9), expiresAtMs: 5 }];
    early.chainReplies = [chain({ nextStep: 1 })];
    const second = early.run();
    second.start();
    await flush();
    expect(early.chainReads).toBe(1);
    expect(second.get()).toEqual({ kind: 'failed', index: 0, failure: 'failed' });
    expect(early.recorded).toEqual(['failed']);
  });
  it('an unusable picture from the last step, or a failure after the finish, shows the saved result', async () => {
    for (const last of [picture(40), { kind: 'code', code: 'FAILED' } as StepResponse, { kind: 'code', code: 'TIMEOUT' } as StepResponse,
      { kind: 'code', code: 'OUTPUT_REJECTED' } as StepResponse]) {
      const h = new Harness();
      h.stepReplies = [picture(20), picture(30), last];
      h.chainReplies = [chain({ state: 'complete', nextStep: 4, resultId: ID(9) })];
      const run = h.run();
      run.start();
      await flush();
      expect(h.chainReads).toBe(1);
      expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), expiresAtMs: null, alreadyFinished: false });
      expect(h.steps).toHaveLength(3);
      expect(run.holdsPicture()).toBe(false);
    }
  });
  it('a missing picture hash is checked, not retried: the server decides', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), { kind: 'code', code: 'OUTPUT_REJECTED' }];
    h.chainReplies = [chain({ nextStep: 3 })];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'lost' });
    expect(h.steps).toHaveLength(2);
  });
  it('a failed step is offered again only when the chain status shows it was not taken', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), { kind: 'code', code: 'FAILED' }];
    h.chainReplies = [chain({ nextStep: 2 })];
    const run = h.run();
    run.start();
    await flush();
    expect(h.chainReads).toBe(1);
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'failed' });
    expect(run.holdsPicture()).toBe(true);
    expect(h.recorded).toEqual(['ok', 'failed']);
  });
  it('a chain with a different plan cannot go on', async () => {
    const h = new Harness();
    h.stepReplies = [new TryOnError('UNAVAILABLE')];
    h.chainReplies = [chain({ nextStep: 1, steps: [{ slot: 'top', itemId: ID(7) }] })];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'mismatch' });
    expect(run.holdsPicture()).toBe(false);
  });
  it('holds no picture after the chain lifetime, after a retryable failure or while offline', async () => {
    const h = new Harness();
    h.stepReplies = [{ kind: 'code', code: 'BUSY' }];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'busy' });
    expect(run.holdsPicture()).toBe(true);
    await h.advance(RUN_LIFETIME_MS + 60_000);
    expect(run.holdsPicture()).toBe(false);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    run.start();
    await flush();
    expect(h.steps).toHaveLength(1);
    const offline = new Harness();
    offline.stepReplies = [new TryOnError('UNAVAILABLE')];
    offline.isOnline = false;
    const second = offline.run();
    second.start();
    await flush();
    expect(second.get()).toEqual({ kind: 'checking', index: 0, offline: true });
    // Timers may not have run while the page was hidden: coming back after 31 minutes checks the clock.
    offline.now += RUN_LIFETIME_MS + 60_000;
    offline.resumeCallbacks.forEach((callback) => callback());
    await flush();
    expect(second.holdsPicture()).toBe(false);
    expect(second.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    expect(offline.onlineCallbacks).toHaveLength(0);
    expect(offline.resumeCallbacks).toHaveLength(0);
    offline.isOnline = true;
    await offline.advance(RECONCILE_EVERY_MS);
    expect(offline.chainReads).toBe(0);
    expect(offline.steps).toHaveLength(1);
  });
  it('an offline check that resumes after the lifetime sends nothing and holds nothing', async () => {
    const h = new Harness();
    h.stepReplies = [new TryOnError('UNAVAILABLE')];
    h.isOnline = false;
    const run = h.run();
    run.start();
    await flush();
    h.now += RUN_LIFETIME_MS + 60_000;
    h.isOnline = true;
    h.onlineCallbacks.splice(0).forEach((callback) => callback());
    await flush();
    expect(h.chainReads).toBe(0);
    expect(run.holdsPicture()).toBe(false);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
  });
  it('maps each closed code to what the owner can do next', async () => {
    const cases: [string, number, string][] = [['FILTERED', 0, 'filtered'], ['FILTERED', 1, 'filtered'],
      ['RATE_LIMIT', 0, 'busy'], ['BUSY', 0, 'busy'], ['ALLOWANCE', 0, 'allowance'], ['CHAIN_MISMATCH', 1, 'mismatch'], ['WITHDRAWN', 0, 'turnedOff'],
      ['RESULTS_FULL', 2, 'resultsFull'], ['INACTIVE', 0, 'unavailable']];
    for (const [code, index, failure] of cases) {
      const h = new Harness();
      h.stepReplies = [...Array.from({ length: index }, (_, n) => picture(20 + n)), { kind: 'code', code } as StepResponse];
      const run = h.run();
      run.start();
      await flush();
      expect(run.get(), code).toEqual({ kind: 'failed', index, failure });
      expect(run.holdsPicture(), code).toBe(failureAction[failure as keyof typeof failureAction] === 'retry');
    }
  });
  it('Try again sends exactly one more request for the failed step, with the same picture', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), { kind: 'code', code: 'BUSY' }, picture(30), { kind: 'result', resultId: ID(9), expiresAtMs: 5 }];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'busy' });
    run.start();
    run.start();
    await flush();
    expect(h.steps.map((step) => [step.step, step.person.length])).toEqual([[1, 10], [2, 20], [2, 20], [3, 30]]);
    expect(h.steps[1]!.requestId).not.toBe(h.steps[2]!.requestId);
    expect(run.get().kind).toBe('result');
  });
  it('never resends a step after a lost reply: it checks every 10 s and recovers the result', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), new TryOnError('TIMEOUT')];
    h.chainReplies = [chain({ activeAttempt: true, nextStep: 3 }), chain({ state: 'complete', nextStep: 4, resultId: ID(9) })];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'checking', index: 2, offline: false });
    expect(h.chainReads).toBe(1);
    await h.advance(RECONCILE_EVERY_MS);
    expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), expiresAtMs: null, alreadyFinished: false });
    expect(h.steps).toHaveLength(3);
  });
  it('reports a picture that went through but never arrived as lost, and gives up after 4 minutes', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), new TryOnError('UNAVAILABLE')];
    h.chainReplies = [chain({ nextStep: 3 })];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'lost' });
    expect(run.holdsPicture()).toBe(false);
    const slow = new Harness();
    slow.stepReplies = [new TryOnError('TIMEOUT')];
    const second = slow.run();
    second.start();
    await flush();
    for (let elapsed = 0; elapsed < RECONCILE_FOR_MS; elapsed += RECONCILE_EVERY_MS) await slow.advance(RECONCILE_EVERY_MS);
    expect(second.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    expect(slow.steps).toHaveLength(1);
    expect(slow.chainReads).toBe(RECONCILE_FOR_MS / RECONCILE_EVERY_MS + 1);
  });
  it('an unclaimed first step can be tried again; a failed later attempt counts as failed', async () => {
    const h = new Harness();
    h.stepReplies = [new TryOnError('TIMEOUT')];
    h.chainReplies = [{ kind: 'code', code: 'NOT_FOUND' }];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'failed' });
    expect(run.holdsPicture()).toBe(true);
    const later = new Harness();
    later.stepReplies = [picture(20), new TryOnError('TIMEOUT')];
    later.chainReplies = [chain({ nextStep: 2 })];
    const second = later.run();
    second.start();
    await flush();
    expect(second.get()).toEqual({ kind: 'failed', index: 1, failure: 'failed' });
    expect(later.recorded).toEqual(['ok', 'failed']);
  });
  it('waits while offline and checks again once online', async () => {
    const h = new Harness();
    h.stepReplies = [new TryOnError('UNAVAILABLE')];
    h.isOnline = false;
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'checking', index: 0, offline: true });
    expect(h.chainReads).toBe(0);
    h.isOnline = true;
    h.chainReplies = [chain({ state: 'withdrawn' })];
    h.onlineCallbacks.splice(0).forEach((callback) => callback());
    await flush();
    expect(h.chainReads).toBe(1);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'turnedOff' });
  });
  it('Stop cancels the chain; a last step that already finished shows its result', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), 'hold'];
    const run = h.run();
    run.start();
    await flush();
    await run.stop();
    expect(h.held[0]!.signal.aborted).toBe(true);
    expect(h.cancels).toEqual([run.id]);
    expect(run.get()).toEqual({ kind: 'stopped' });
    expect(run.holdsPicture()).toBe(false);
    const done = new Harness();
    done.stepReplies = [picture(20), picture(30), 'hold'];
    done.cancelReply = { code: 'COMPLETED', resultId: ID(9) };
    const second = done.run();
    second.start();
    await flush();
    await second.stop();
    expect(second.get()).toEqual({ kind: 'result', resultId: ID(9), expiresAtMs: null, alreadyFinished: true });
  });
  it('Stop without the server\'s CANCELLED or EXPIRED is never shown as stopped', async () => {
    for (const reply of [{ code: 'NOT_FOUND' }, { code: 'UNAVAILABLE' }, { code: 'STALE' }, null] as (CancelResult | null)[]) {
      const h = new Harness();
      h.stepReplies = ['hold'];
      if (reply) h.cancelReply = reply;
      else h.api.cancel = () => Promise.reject(new Error('offline'));
      const run = h.run();
      run.start();
      await flush();
      await run.stop();
      expect(run.get(), String(reply?.code)).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
      // A step reply that arrives after Stop changes nothing.
      h.held[0]!.resolve({ kind: 'result', resultId: ID(9), expiresAtMs: 5 });
      await flush();
      expect(run.get(), String(reply?.code)).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    }
    for (const code of ['CANCELLED', 'EXPIRED'] as const) {
      const h = new Harness();
      h.stepReplies = ['hold'];
      h.cancelReply = { code };
      const run = h.run();
      run.start();
      await flush();
      await run.stop();
      h.held[0]!.resolve({ kind: 'result', resultId: ID(9), expiresAtMs: 5 });
      await flush();
      expect(run.get(), code).toEqual({ kind: 'stopped' });
      expect(h.steps).toHaveLength(1);
    }
  });
  it('Stop before anything was sent sends nothing', async () => {
    const h = new Harness();
    const run = h.run();
    await run.stop();
    expect(h.cancels).toEqual([]);
    expect(run.get()).toEqual({ kind: 'stopped' });
  });
  it('drops late replies after a sign-out or account change, and after Close', async () => {
    const h = new Harness();
    h.stepReplies = ['hold'];
    const run = h.run();
    run.start();
    await flush();
    h.isCurrent = false;
    h.held[0]!.resolve(picture(20));
    await flush();
    expect(h.steps).toHaveLength(1);
    expect(run.get()).toEqual({ kind: 'running', index: 0 });
    const closed = new Harness();
    closed.stepReplies = ['hold'];
    const second = closed.run();
    second.start();
    await flush();
    second.abandon();
    expect(closed.cancels).toEqual([second.id]);
    expect(closed.held[0]!.signal.aborted).toBe(true);
    closed.held[0]!.resolve(picture(20));
    await flush();
    expect(closed.steps).toHaveLength(1);
    expect(second.holdsPicture()).toBe(false);
  });
  it('sends nothing while the session stop holds', async () => {
    const h = new Harness();
    h.stopped = true;
    const run = h.run();
    run.start();
    await flush();
    expect(h.steps).toHaveLength(0);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
  });
  it('refuses chains with no steps or more than three', () => {
    const h = new Harness();
    expect(() => h.run([])).toThrow(TryOnError);
    expect(() => h.run([{ slot: 'top', itemId: ID(1) }, { slot: 'bottom', itemId: ID(2) }, { slot: 'footwear', itemId: ID(3) },
      { slot: 'top', itemId: ID(4) }])).toThrow(TryOnError);
  });
});

const owner = '10000000-0000-4000-8000-0000000000aa';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test_only', version: 'test' };
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
const jpegBody = (size: number) => { const bytes = new Uint8Array(size); bytes[0] = 0xff; bytes[1] = 0xd8; return bytes; };
const stepInput = (step = 1): StepInput => ({ chainId: ID(50), step, requestId: ID(51), person: jpegBody(100),
  ...(step === 1 ? { outfitId: OUTFIT } : {}) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the try-on client transport', () => {
  it('treats only the missing-function reply as no try-on, and parses the status strictly', async () => {
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'PGRST202' }, { status: 404 }));
    await expect(client.status()).resolves.toEqual({ kind: 'missing' });
    fetcher.mockResolvedValueOnce(Response.json({ message: 'nope' }, { status: 404 }));
    await expect(client.status()).rejects.toThrow(TryOnError);
    fetcher.mockResolvedValueOnce(Response.json(statusRaw()));
    await expect(client.status()).resolves.toMatchObject({ kind: 'ready', status: { code: 'OK' } });
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe(`${config.url}/rest/v1/rpc/tryon_status`);
    expect(init?.credentials).toBe('omit');
    fetcher.mockResolvedValueOnce(Response.json(statusRaw()));
    await client.consent(true);
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body))).toEqual({ p_enabled: true, p_notice_revision: TRYON_NOTICE_REVISION });
  });
  it('sends one multipart step and checks the picture hash header and size', async () => {
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const hash = 'a'.repeat(64);
    fetcher.mockResolvedValueOnce(new Response(jpegBody(200), { headers: { 'content-type': 'image/jpeg', 'X-Stillroom-TryOn-Sha256': hash } }));
    const reply = await client.step(stepInput(), new AbortController().signal);
    expect(reply).toMatchObject({ kind: 'intermediate', sha256: hash });
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()].sort()).toEqual(['chainId', 'manifestId', 'outfitId', 'person', 'requestId', 'step']);
    expect(fetcher.mock.calls[0]![0]).toBe(`${config.url}/functions/v1/try-on`);
    fetcher.mockResolvedValueOnce(new Response(jpegBody(200), { headers: { 'content-type': 'image/jpeg' } }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'OUTPUT_REJECTED' });
    fetcher.mockResolvedValueOnce(new Response(jpegBody(TRYON_LIMITS.outputBytes + 1), { headers: { 'content-type': 'image/jpeg', 'X-Stillroom-TryOn-Sha256': hash } }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'OUTPUT_REJECTED' });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: ID(9), expiresAtMs: 5 }));
    await expect(client.step(stepInput(3), new AbortController().signal)).resolves.toEqual({ kind: 'result', resultId: ID(9), expiresAtMs: 5 });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'FILTERED' }, { status: 422 }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'FILTERED' });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'SOMETHING_NEW' }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'FAILED' });
    // A truncated or unexpected reply proves nothing: it throws, so the run checks the chain instead.
    fetcher.mockResolvedValueOnce(new Response('{"code":"OK","resultId":"', { headers: { 'content-type': 'application/json' } }));
    await expect(client.step(stepInput(3), new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: 'x' }));
    await expect(client.step(stepInput(3), new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(client.step({ ...stepInput(2), outfitId: OUTFIT }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.step({ ...stepInput(), person: jpegBody(TRYON_LIMITS.personBytes + 1) }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it('gives up on a step after the 100-second client deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const pending = client.step(stepInput(), new AbortController().signal);
    const settled = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(TRYON_LIMITS.clientStepMs).toBe(100_000);
    await vi.advanceTimersByTimeAsync(TRYON_LIMITS.clientStepMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });
  it('keeps known consent and Turn off through an unavailable status, and recovers', async () => {
    const store = new TryOnStore(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json(statusRaw()));
    await readTryOnStatus(store, 'active');
    expect(tryOnViewOf(store, store.get())).toMatchObject({ kind: 'on', turnOff: true });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'UNAVAILABLE' }));
    await readTryOnStatus(store, 'active');
    expect(store.consentOn).toBe(true);
    expect(tryOnViewOf(store, store.get())).toEqual({ kind: 'paused', turnOn: false, turnOff: true });
    fetcher.mockResolvedValueOnce(Response.json(statusRaw()));
    await readTryOnStatus(store, 'active');
    expect(tryOnViewOf(store, store.get())).toMatchObject({ kind: 'on', turnOff: true });
    fetcher.mockResolvedValueOnce(Response.json(statusRaw({ consent: off, code: 'CONSENT_REQUIRED' })));
    await readTryOnStatus(store, 'active');
    expect(store.consentOn).toBe(false);
    store.dispose();
  });
  it('drops replies once the owner or session changed', async () => {
    const outer = new AbortController();
    const scope = { ownerId: owner, epoch: 1, signal: outer.signal };
    const client = new TryOnClient(supabase(), config, scope);
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise((resolve) => { answer = resolve; })));
    const pending = client.chainStatus(ID(50));
    await Promise.resolve();
    scope.epoch = 2;
    answer(Response.json({ code: 'NOT_FOUND' }));
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(client.current()).toBe(false);
    await expect(client.status()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
