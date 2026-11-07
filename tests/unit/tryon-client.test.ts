import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import {
  parseCancel, parseChainStatus, parseResultImage, parseResults, parseTryOnStatus, tryOnReady, tryOnView, TryOnClient, TryOnError,
  type CancelResult, type ChainStatus, type StepInput, type StepResponse,
} from '../../src/data/tryon';
import { TRYON_LIMITS, TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION, type TryOnStep } from '../../src/domain/tryon';
import {
  BUSY_RETRY_EVERY_MS, BUSY_RETRY_FOR_MS, HOLD_EVERY_MS, RECONCILE_EVERY_MS, RECONCILE_FOR_MS, RUN_LIFETIME_MS, TryOnRun, failureAction, ideaSelection,
  type RunEnvironment, type RunGate, type TryOnApi,
} from '../../src/features/outfits/use-try-on';
import type { OutfitComponent } from '../../src/domain/outfits';
import { readTryOnStatus, TryOnStore, tryOnViewOf } from '../../src/features/settings/tryon-store';
import { testAccessToken } from './test-token';

const SERVER = Date.parse('2026-10-05T12:00:00Z');
const OUTFIT = '10000000-0000-4000-8000-000000000001';
const ID = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = (over: Record<string, unknown> = {}) => ({
  activated: true, noticeRevision: TRYON_NOTICE_REVISION, manifestId: TRYON_MANIFEST, modelId: TRYON_MODEL,
  maxRequestMicro: '400000',
  maxSteps: 6, maxResults: 200, providerAvailable: true, ...over,
});
const statusRaw = (over: Record<string, unknown> = {}, policyOver: Record<string, unknown> = {}) => ({
  code: 'OK', period: '2026-10', serverTimeMs: SERVER,
  consent: { enabled: true, noticeRevision: TRYON_NOTICE_REVISION, consentedAt: '2026-10-01T00:00:00Z' },
  policy: policy(policyOver), results: 0,
  budget: { monthlyAllowanceMicro: '20000000', usedMicro: '0', remainingMicro: '20000000', warning: false }, ...over,
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
    expect(tryOnReady(parseTryOnStatus(statusRaw({ serverTimeMs: Date.parse('2027-01-01T00:00:00Z') })))).toBe(true);
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
    expect(parseChainStatus({ ...chain, steps: [{ slot: 'sock', itemId: ID(1) }] })).toBeNull();
    // Six steps and a next step of seven are the longest chain; one more of either is refused.
    const six = ['top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory'].map((slot, at) => ({ slot, itemId: ID(at + 1) }));
    expect(parseChainStatus({ ...chain, steps: six, nextStep: 7 })).toMatchObject({ kind: 'chain', nextStep: 7 });
    expect(parseChainStatus({ ...chain, steps: six, nextStep: 8 })).toBeNull();
    expect(parseChainStatus({ ...chain, steps: [...six, { slot: 'top', itemId: ID(7) }] })).toBeNull();
    expect(parseChainStatus({ ...chain, steps: [] })).toBeNull();
    expect(parseChainStatus({ code: 'NOT_FOUND' })).toEqual({ kind: 'code', code: 'NOT_FOUND' });
    expect(parseCancel({ code: 'COMPLETED', resultId: ID(2) })).toEqual({ code: 'COMPLETED', resultId: ID(2) });
    expect(parseCancel({ code: 'CANCELLED', resultId: null })).toBeNull();
    expect(parseCancel({ code: 'OTHER' })).toBeNull();
    const result = { id: ID(3), outfitId: OUTFIT, itemIds: [ID(1)], bytes: 100, completedAtMs: SERVER };
    expect(parseResults({ code: 'OK', results: [result] })).toHaveLength(1);
    expect(parseResults({ code: 'OK', results: [{ ...result, bytes: 600_000 }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: [{ ...result, itemIds: [] }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: [{ ...result, itemIds: [1, 2, 3, 4, 5, 6].map(ID) }] })).toHaveLength(1);
    expect(parseResults({ code: 'OK', results: [{ ...result, itemIds: [1, 2, 3, 4, 5, 6, 7].map(ID) }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: [{ ...result, expiresAtMs: SERVER }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: Array.from({ length: 200 }, () => result) })).toHaveLength(200);
    expect(parseResults({ code: 'OK', results: Array.from({ length: 201 }, () => result) })).toBeNull();
    // An unsaved idea's result has no outfit; anything else in that place is refused.
    expect(parseResults({ code: 'OK', results: [{ ...result, outfitId: null }] })).toEqual([{ ...result, outfitId: null }]);
    expect(parseResults({ code: 'OK', results: [{ ...result, outfitId: 'not-an-id' }] })).toBeNull();
    expect(parseResults({ code: 'OK', results: [{ ...result, outfitId: undefined }] })).toBeNull();
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
  refused = 0;
  foreground: [string, boolean][] = [];
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
    step: (input, signal, gate) => {
      // The client asks its caller's last question right before the POST; a refusal sends nothing.
      if (gate && !gate()) { this.refused += 1; return Promise.reject(new TryOnError('INVALID_INPUT')); }
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
  session = { stopped: () => this.stopped, recordStep: (outcome: string) => { this.recorded.push(outcome); },
    foreground: (id: string, active: boolean) => { this.foreground.push([id, active]); } };
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
const busy = (count: number): StepResponse[] => Array.from({ length: count }, () => ({ kind: 'code', code: 'BUSY' }) as StepResponse);
/** Lets the automatic BUSY retries run out, one interval at a time. */
async function exhaustBusy(h: Harness, run: TryOnRun) {
  for (let turn = 0; turn < 20 && run.get().kind === 'running'; turn += 1) await h.advance(BUSY_RETRY_EVERY_MS);
}
const plan: TryOnStep[] = [{ slot: 'top', itemId: ID(1) }, { slot: 'bottom', itemId: ID(2) }, { slot: 'footwear', itemId: ID(3) }];
const chain = (over: Partial<Extract<ChainStatus, { kind: 'chain' }>>): ChainStatus => ({ kind: 'chain', state: 'running', nextStep: 1,
  steps: plan, activeAttempt: false, resultId: null, expiresAtMs: 0, ...over });

describe('the try-on run (rev4 §2.3-§3.2)', () => {
  it('selects an idea\'s garments in the idea\'s order and lists the extra layers it leaves out', () => {
    const piece = (id: string, category: OutfitComponent['category'], extra: Partial<OutfitComponent> = {}): [string, OutfitComponent] =>
      [id, { id, state: 'current', title: id, category, colour: null, lifecycle: 'active', thumbPath: `${id}.jpg`, altText: '', ...extra }];
    const components = new Map([piece('polo', 'top'), piece('grey', 'bottom'), piece('jacket', 'outerwear'), piece('shoes', 'footwear'),
      piece('gone', 'top', { state: 'trashed' }), piece('plain', 'top', { thumbPath: null }), piece('coat', 'outerwear')]);
    expect(ideaSelection(['polo', 'grey', 'jacket', 'shoes', 'coat'], components)).toEqual({
      steps: [{ slot: 'top', itemId: 'polo' }, { slot: 'bottom', itemId: 'grey' }, { slot: 'outerwear', itemId: 'jacket' },
        { slot: 'footwear', itemId: 'shoes' }],
      notIncluded: ['coat'],
    });
    expect(ideaSelection(['gone', 'plain', 'unknown'], components).steps).toEqual([]);
  });
  it('starts an idea chain by naming its garments, not an outfit, and only on the first step', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), { kind: 'result', resultId: ID(9) }];
    const run = new TryOnRun(h.api, h.session, h.env, { itemIds: plan.map((step) => step.itemId) }, plan, new Uint8Array(new ArrayBuffer(10)));
    run.start();
    await flush();
    expect(h.steps.map((step) => [step.step, step.outfitId ?? null, step.itemIds ?? null]))
      .toEqual([[1, null, [ID(1), ID(2), ID(3)]], [2, null, null], [3, null, null]]);
    expect(run.get()).toMatchObject({ kind: 'result', resultId: ID(9) });
    expect(run.holdsPicture()).toBe(false);
  });
  it('sends each step once, chains the previous picture and drops everything at the result', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), { kind: 'result', resultId: ID(9) }];
    const run = h.run();
    run.start();
    await flush();
    expect(h.steps.map((step) => [step.step, step.person.length, step.outfitId ?? null, step.chainId]))
      .toEqual([[1, 10, OUTFIT, run.id], [2, 20, null, run.id], [3, 30, null, run.id]]);
    expect(new Set(h.steps.map((step) => step.requestId)).size).toBe(3);
    expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), alreadyFinished: false });
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
    early.stepReplies = [{ kind: 'result', resultId: ID(9) }];
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
      expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), alreadyFinished: false });
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
    h.stepReplies = Array.from({ length: 30 }, () => ({ kind: 'code', code: 'BUSY' }) as StepResponse);
    const run = h.run();
    run.start();
    await flush();
    await exhaustBusy(h, run);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'busy' });
    expect(run.holdsPicture()).toBe(true);
    await h.advance(RUN_LIFETIME_MS + 60_000);
    expect(run.holdsPicture()).toBe(false);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    run.start();
    await flush();
    expect(h.steps).toHaveLength(13);
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
      ['ALLOWANCE', 0, 'allowance'], ['CHAIN_MISMATCH', 1, 'mismatch'], ['WITHDRAWN', 0, 'turnedOff'],
      ['RESULTS_FULL', 2, 'resultsFull'], ['INACTIVE', 0, 'unavailable'], ['PAUSED', 0, 'paused'], ['PAUSED', 2, 'paused']];
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
    h.stepReplies = [picture(20), ...busy(13), picture(30), { kind: 'result', resultId: ID(9) }];
    const run = h.run();
    run.start();
    await flush();
    await exhaustBusy(h, run);
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'busy' });
    expect(h.recorded).toEqual(['ok', 'other']);
    run.start();
    run.start();
    await flush();
    expect(h.steps.map((step) => [step.step, step.person.length])).toEqual([[1, 10], ...Array.from({ length: 13 }, () => [2, 20]), [2, 20], [3, 30]]);
    expect(new Set(h.steps.map((step) => step.requestId)).size).toBe(h.steps.length);
    expect(run.get().kind).toBe('result');
  });
  it('waits and claims the refused step again by itself: one more request per retry, no action from the owner', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), picture(40), ...busy(2), { kind: 'result', resultId: ID(9) }];
    const four: TryOnStep[] = [...plan, { slot: 'outerwear', itemId: ID(4) }];
    const run = h.run(four);
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'running', index: 3, waiting: true });
    expect(h.steps.map((step) => step.step)).toEqual([1, 2, 3, 4]);
    await h.advance(BUSY_RETRY_EVERY_MS - 1);
    expect(h.steps).toHaveLength(4);
    await h.advance(1);
    expect(h.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 4]);
    expect(run.get()).toEqual({ kind: 'running', index: 3, waiting: true });
    await h.advance(BUSY_RETRY_EVERY_MS);
    expect(h.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 4, 4]);
    expect(run.get()).toMatchObject({ kind: 'result', resultId: ID(9) });
    expect(new Set(h.steps.map((step) => step.requestId)).size).toBe(6);
    expect(h.steps.every((step) => step.chainId === run.id)).toBe(true);
    expect(h.recorded).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(h.chainReads).toBe(0);
    expect(h.timers.filter((timer) => timer.live)).toHaveLength(0);
  });
  it('each step gets its own wait budget, and only BUSY waits', async () => {
    const h = new Harness();
    h.stepReplies = [...busy(5), picture(20), ...busy(5), { kind: 'code', code: 'ALLOWANCE' }];
    const run = h.run();
    run.start();
    await flush();
    for (let turn = 0; turn < 12; turn += 1) await h.advance(BUSY_RETRY_EVERY_MS);
    expect(run.get()).toEqual({ kind: 'failed', index: 1, failure: 'allowance' });
    expect(h.steps.map((step) => step.step)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(h.recorded).toEqual(['ok', 'other']);
  });
  it('stops waiting at Stop: no further claim, and the chain is cancelled', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), ...busy(5)];
    const run = h.run();
    run.start();
    await flush();
    expect(run.get()).toEqual({ kind: 'running', index: 1, waiting: true });
    await run.stop();
    await flush();
    expect(run.get()).toEqual({ kind: 'stopped' });
    expect(h.cancels).toEqual([run.id]);
    await h.advance(BUSY_RETRY_FOR_MS);
    expect(h.steps).toHaveLength(2);
    expect(run.holdsPicture()).toBe(false);
  });
  it('leaving the screen while waiting sends nothing more', async () => {
    const h = new Harness();
    h.stepReplies = [...busy(5)];
    const run = h.run();
    run.start();
    await flush();
    run.abandon();
    await h.advance(BUSY_RETRY_FOR_MS);
    expect(h.steps).toHaveLength(1);
    expect(h.timers.filter((timer) => timer.live)).toHaveLength(0);
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
    expect(run.get()).toEqual({ kind: 'result', resultId: ID(9), alreadyFinished: false });
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
    expect(second.get()).toEqual({ kind: 'result', resultId: ID(9), alreadyFinished: true });
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
      h.held[0]!.resolve({ kind: 'result', resultId: ID(9) });
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
      h.held[0]!.resolve({ kind: 'result', resultId: ID(9) });
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
  it('refuses chains with no steps or more than six', () => {
    const h = new Harness();
    expect(() => h.run([])).toThrow(TryOnError);
    const slots = ['top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory'] as const;
    const plan = (count: number) => Array.from({ length: count }, (_, at) => ({ slot: slots[at % 6]!, itemId: ID(at + 1) }));
    expect(() => h.run(plan(6))).not.toThrow();
    expect(() => h.run(plan(7))).toThrow(TryOnError);
  });
});

describe('a background run (OUTFITGEN2): asks before every send and yields to the owner\'s own try-on', () => {
  const background = (h: Harness, gate: (index: number) => RunGate) => new TryOnRun(h.api, h.session, h.env, { itemIds: plan.map((step) => step.itemId) },
    plan, new Uint8Array(new ArrayBuffer(10)), { gate });
  it('sends nothing, and is not started, when the gate says abort before the first send', async () => {
    const h = new Harness();
    const run = background(h, () => 'abort');
    run.start();
    await flush();
    expect(h.steps).toEqual([]);
    expect(run.chainStarted).toBe(false);
    expect(run.get()).toEqual({ kind: 'failed', index: 0, failure: 'unavailable' });
    expect(run.holdsPicture()).toBe(false);
  });
  it('does not start while a foreground try-on holds the gate, even for the first step', async () => {
    const h = new Harness();
    const run = background(h, () => 'hold');
    run.start();
    await flush();
    expect(h.steps).toEqual([]);
    expect(run.chainStarted).toBe(false);
  });
  it('waits for a held step, asks again every few seconds and sends it once the gate allows it', async () => {
    const h = new Harness();
    h.stepReplies = [picture(20), picture(30), { kind: 'result', resultId: ID(9) }];
    let verdict: RunGate = 'hold';
    const run = background(h, (index) => (index === 1 ? verdict : 'go'));
    run.start();
    await flush();
    // Step 1 went out and came back; step 2 is held back because the owner's try-on is running.
    expect(h.steps.map((step) => step.step)).toEqual([1]);
    expect(run.get()).toEqual({ kind: 'running', index: 1, waiting: true });
    expect(run.chainStarted).toBe(true);
    await h.advance(HOLD_EVERY_MS * 3);
    expect(h.steps.map((step) => step.step)).toEqual([1]);
    verdict = 'go';
    await h.advance(HOLD_EVERY_MS);
    expect(h.steps.map((step) => step.step)).toEqual([1, 2, 3]);
    expect(run.get()).toMatchObject({ kind: 'result', resultId: ID(9) });
  });  it('asks again before every BUSY retry, and stops retrying the moment the gate says abort', async () => {
    const h = new Harness();
    h.stepReplies = busy(5);
    let allowed = true;
    const run = background(h, () => (allowed ? 'go' : 'abort'));
    run.start();
    await flush();
    expect(h.steps).toHaveLength(1);
    expect(run.get()).toMatchObject({ kind: 'running', waiting: true });
    allowed = false;
    await h.advance(BUSY_RETRY_EVERY_MS);
    expect(h.steps).toHaveLength(1);
    expect(run.get()).toMatchObject({ kind: 'failed', failure: 'unavailable' });
  });
  it('holds, rather than fails, when the last check right before the POST says a foreground run began', async () => {
    const h = new Harness();
    let calls = 0;
    // The first question (before the awaits) says go; the client's own last question (right before the POST) says hold.
    const run = background(h, () => (++calls === 1 ? 'go' : 'hold'));
    run.start();
    await flush();
    expect(h.refused).toBe(1);
    expect(h.steps).toEqual([]);
    expect(run.chainStarted).toBe(false);
    expect(run.get().kind).toBe('failed');
  });
  it('a foreground run tells the session while it is sending, and a background run never does', async () => {
    const foreground = new Harness();
    foreground.stepReplies = [picture(20), picture(30), { kind: 'result', resultId: ID(9) }];
    const run = foreground.run();
    run.start();
    await flush();
    expect(foreground.foreground.map(([, active]) => active)).toEqual([true, false]);
    expect(new Set(foreground.foreground.map(([id]) => id))).toEqual(new Set([run.id]));
    const other = new Harness();
    other.stepReplies = [{ kind: 'result', resultId: ID(9) }];
    const solo = new TryOnRun(other.api, other.session, other.env, { itemIds: [ID(1)] }, [plan[0]!], new Uint8Array(new ArrayBuffer(10)), { gate: () => 'go' });
    solo.start();
    await flush();
    expect(solo.get()).toMatchObject({ kind: 'result' });
    expect(other.foreground).toEqual([]);
  });
  it('a foreground run that is abandoned while sending reports itself idle', async () => {
    const h = new Harness();
    h.stepReplies = ['hold'];
    const run = h.run();
    run.start();
    await flush();
    expect(h.foreground.at(-1)).toEqual([run.id, true]);
    run.abandon();
    expect(h.foreground.at(-1)).toEqual([run.id, false]);
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
  it('asks for results without an outfit only on the two result reads', async () => {
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', results: [] }));
    await client.results();
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', jpegBase64: jpeg, bytes: 4 }));
    await client.resultImage(ID(3));
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK' }));
    await client.deleteResult(ID(3));
    fetcher.mockResolvedValueOnce(Response.json({ code: 'CANCELLED' }));
    await client.cancel(ID(4));
    const sent = fetcher.mock.calls.map(([url, init]) => [String(url).split('/').pop(),
      new Headers(init?.headers).get('X-Stillroom-TryOn-Results-Contract'), new Headers(init?.headers).get('X-Stillroom-AI-Budget-Contract')]);
    expect(sent).toEqual([['tryon_results_v1', '2', '2'], ['tryon_result_image_v1', '2', '2'], ['tryon_delete_result', null, '2'],
      ['tryon_cancel', null, '2']]);
  });
  it('reads the largest result list the server can send: 200 results of six items, in Postgres JSON spacing', async () => {
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const entry = (at: number, items: number) => ({ id: ID(at), outfitId: OUTFIT, itemIds: Array.from({ length: items }, (_, n) => ID(n + 1)),
      bytes: TRYON_LIMITS.outputBytes, completedAtMs: 1_900_000_000_000 + at });
    // jsonb text puts a space after every colon and comma, which is what PostgREST relays.
    const spaced = (value: unknown) => JSON.stringify(value).replace(/("[^"]*":|,)(?=["[{0-9])/g, '$1 ');
    for (const items of [1, 6]) {
      const body = spaced({ code: 'OK', results: Array.from({ length: 200 }, (_, at) => entry(at + 1, items)) });
      expect(body.length).toBeGreaterThan(items === 6 ? 60_000 : 30_000);
      expect(body.length).toBeLessThan(131_072);
      fetcher.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }));
      const list = await client.results();
      expect(list === 'missing' ? 0 : list.length).toBe(200);
    }
    // A reply past the bounded allowance is still refused, however it parses.
    fetcher.mockResolvedValueOnce(new Response(' '.repeat(131_073), { headers: { 'content-type': 'application/json' } }));
    await expect(client.results()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
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
    expect(new Headers(init?.headers).get('X-Stillroom-AI-Budget-Contract')).toBe('2');
    expect(new Headers(init?.headers).get('X-Stillroom-TryOn-Results-Contract')).toBeNull();
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
    // The request names the v3 manifest; a v2 request would be refused by the Edge function as CONFIG_CHANGED.
    expect(form.get('manifestId')).toBe('azure-global-image25-sunburst-tryon-v3');
    expect(fetcher.mock.calls[0]![0]).toBe(`${config.url}/functions/v1/try-on`);
    fetcher.mockResolvedValueOnce(new Response(jpegBody(200), { headers: { 'content-type': 'image/jpeg' } }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'OUTPUT_REJECTED' });
    fetcher.mockResolvedValueOnce(new Response(jpegBody(TRYON_LIMITS.outputBytes + 1), { headers: { 'content-type': 'image/jpeg', 'X-Stillroom-TryOn-Sha256': hash } }));
    await expect(client.step(stepInput(2), new AbortController().signal)).resolves.toEqual({ kind: 'code', code: 'OUTPUT_REJECTED' });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: ID(9) }));
    await expect(client.step(stepInput(3), new AbortController().signal)).resolves.toEqual({ kind: 'result', resultId: ID(9) });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: ID(9) }));
    await expect(client.step(stepInput(6), new AbortController().signal)).resolves.toEqual({ kind: 'result', resultId: ID(9) });
    await expect(client.step(stepInput(7), new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A reply that still carries the retired expiry is not the closed shape: it proves nothing.
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: ID(9), expiresAtMs: 5 }));
    await expect(client.step(stepInput(6), new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
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
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('sends an idea\'s items as one comma-separated field, and refuses any other combination', async () => {
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const idea = (extra: Partial<StepInput> = {}, step = 1): StepInput => ({ chainId: ID(50), step, requestId: ID(51), person: jpegBody(100),
      ...(step === 1 ? { itemIds: [ID(1), ID(2)] } : {}), ...extra });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', resultId: ID(9) }));
    await client.step(idea(), new AbortController().signal);
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()].sort()).toEqual(['chainId', 'itemIds', 'manifestId', 'person', 'requestId', 'step']);
    expect(form.get('itemIds')).toBe(`${ID(1)},${ID(2)}`);
    for (const bad of [idea({ outfitId: OUTFIT }), idea({ itemIds: [] }), idea({ itemIds: [ID(1), ID(1)] }), idea({ itemIds: ['x'] }),
      idea({ itemIds: Array.from({ length: 9 }, (_, index) => ID(index + 1)) }), idea({ itemIds: undefined }), idea({ itemIds: [ID(1)] }, 2),
      idea({}, 7)]) {
      await expect(client.step(bad, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
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
  it('treats an older or newer server as unavailable until the app is reloaded, then recovers', async () => {
    const store = new TryOnStore(supabase(), config, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    // A database from before TRYON-LIMITS1 (three steps, 20 results, a result lifetime) and a manifest or notice this app does not know.
    const older = statusRaw({}, { maxSteps: 3, maxResults: 20, resultDays: 7 });
    fetcher.mockResolvedValueOnce(Response.json(older));
    await readTryOnStatus(store, 'active');
    expect(store.get().read.kind).toBe('failed');
    expect(tryOnViewOf(store, store.get())).toMatchObject({ turnOn: false });
    expect(tryOnReady(parseTryOnStatus(statusRaw({}, { manifestId: 'azure-global-image25-sunburst-tryon-v1' })))).toBe(false);
    // TRYON-PROMPT1: a database still on the v2 manifest is not accepted, even with the same notice and existing consent 3.
    const v2 = parseTryOnStatus(statusRaw({}, { manifestId: 'azure-global-image25-sunburst-tryon-v2' }));
    expect(v2?.consent).toMatchObject({ enabled: true, noticeRevision: 3 });
    expect(tryOnReady(v2)).toBe(false);
    const v3 = parseTryOnStatus(statusRaw({}, { manifestId: 'azure-global-image25-sunburst-tryon-v3' }));
    expect(v3?.consent).toMatchObject({ enabled: true, noticeRevision: 3 });
    expect(tryOnReady(v3)).toBe(true);
    expect(tryOnReady(parseTryOnStatus(statusRaw({}, { noticeRevision: TRYON_NOTICE_REVISION - 1 })))).toBe(false);
    // After the deploys, a later read (a reloaded app) parses and Try on is offered again.
    fetcher.mockResolvedValueOnce(Response.json(statusRaw()));
    await readTryOnStatus(store, 'active');
    expect(tryOnViewOf(store, store.get())).toMatchObject({ kind: 'on' });
    store.dispose();
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
