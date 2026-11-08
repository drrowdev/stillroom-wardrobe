import { describe, expect, it } from 'vitest';
import { OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { parseOutfitGenStatus, type GenerateReply, type OutfitGenStatus } from '../../src/domain/outfitgen-app';
import {
  PASS_LIMITS, passCeiling, passLines, passNext, passReply, passSending, passTotal, type PassLocal, type PassMemory, type PassStop,
} from '../../src/domain/outfitgen-pass';

const BUDGET = { monthlyAllowanceMicro: '50000000', usedMicro: '0', remainingMicro: '50000000', warning: false };
function status(over: Record<string, unknown> = {}, enabled = true, code = 'OK'): OutfitGenStatus {
  return parseOutfitGenStatus({ code, period: '2026-11', serverTimeMs: Date.parse('2026-11-20T00:00:00Z'),
    consent: { enabled, noticeRevision: enabled ? OUTFITGEN_NOTICE_REVISION : null, consentedAt: enabled ? '2026-11-01T00:00:00Z' : null },
    policy: { activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST, modelId: OUTFITGEN_MODEL, maxRequestMicro: '373402' },
    budget: BUDGET, pending: 0, unassessed: 10, autoUnassessed: 10, autoCallsLeft: 3, live: false, cooldownUntilMs: null, ...over })!;
}
const local = (over: Partial<PassLocal> = {}): PassLocal => ({ online: true, visible: true, stopped: false, settling: false, runnable: true, ...over });
const ok = (over: Partial<Extract<GenerateReply, { code: 'OK' }>> = {}): GenerateReply => ({ code: 'OK', suggested: 1, judged: 5, remaining: true, ...over });
/** A memory after `calls` calls that left `unassessed` garments, as passNext would hand it on. */
const after = (over: Partial<PassMemory> = {}): PassMemory => ({ start: 10, done: 0, unassessed: 10, judged: 4, calls: 1, found: 0, failures: 0, stalls: 0, ...over });
const stopOf = (mem: PassMemory | null, s: OutfitGenStatus | null, l: PassLocal = local()) => passNext(mem, s, l).stop;

describe('a pass over the unchecked garments: how many calls it may make', () => {
  it('is bounded by the wardrobe and never by the server cap of 40', () => {
    expect([0, 1, 5, 19, 20, 100, 1000].map(passCeiling)).toEqual([2, 4, 12, 40, 40, 40, 40]);
    expect(PASS_LIMITS.maxCalls).toBe(40);
  });
});

describe('a pass over the unchecked garments: whether the next call may be sent', () => {
  it('starts from the first status and is allowed when everything is in order', () => {
    const first = passNext(null, status(), local());
    expect(first.stop).toBeNull();
    expect(first.mem).toMatchObject({ start: 10, done: 0, unassessed: 10, calls: 0 });
  });
  it('lets the first call through even when every garment is checked (the earlier manual run), then ends', () => {
    const first = passNext(null, status({ unassessed: 0 }), local());
    expect(first.stop).toBeNull();
    expect(stopOf(passSending(first.mem!), status({ unassessed: 0 }))).toBe('done');
    // A failed first call is not "done": it is tried once more.
    expect(stopOf({ ...passSending(first.mem!), failures: 1 }, status({ unassessed: 0 }))).toBeNull();
  });
  it('re-reads consent every time and fails closed', () => {
    expect(stopOf(null, status({}, false, 'CONSENT_REQUIRED'))).toBe('consent');
    expect(stopOf(after(), status({}, false, 'CONSENT_REQUIRED'))).toBe('consent');
    expect(stopOf(after(), status({}, true, 'INACTIVE'))).toBe('unavailable');
    expect(stopOf(after(), null)).toBe('unavailable');
    expect(stopOf(after(), status(), local({ runnable: false }))).toBe('consent');
    expect(stopOf(after(), status(), local({ settling: true }))).toBe('notSent');
  });
  it('stops for the user, the network, a hidden page, the budget, a live call, a full list and the ceiling', () => {
    const mem = after({ unassessed: 8, done: 2 });
    expect(stopOf(mem, status({ unassessed: 8 }), local({ stopped: true }))).toBe('user');
    expect(stopOf(mem, status({ unassessed: 8 }), local({ online: false }))).toBe('offline');
    expect(stopOf(mem, status({ unassessed: 8 }), local({ visible: false }))).toBe('hidden');
    expect(stopOf(mem, status({ unassessed: 8, budget: { ...BUDGET, usedMicro: '49900000', remainingMicro: '100000' } }))).toBe('limit');
    expect(stopOf(mem, status({ unassessed: 8, live: true }))).toBe('live');
    expect(stopOf(mem, status({ unassessed: 8, pending: 40 }))).toBe('full');
    expect(stopOf(after({ unassessed: 8, done: 2, calls: passCeiling(10) }), status({ unassessed: 8 }))).toBe('ceiling');
    expect(stopOf(after({ unassessed: 8, done: 2, calls: passCeiling(10) - 1 }), status({ unassessed: 8 }))).toBeNull();
  });
  it('keeps 15 percent of the month free for calls after the first, but not for the first', () => {
    const near = { monthlyAllowanceMicro: '50000000', usedMicro: '42500000', remainingMicro: '7500000', warning: false };
    expect(stopOf(null, status({ budget: near }))).toBeNull();
    expect(stopOf(after({ unassessed: 8, done: 2 }), status({ unassessed: 8, budget: near }))).toBe('reserve');
    const room = { monthlyAllowanceMicro: '50000000', usedMicro: '30000000', remainingMicro: '20000000', warning: false };
    expect(stopOf(after({ unassessed: 8, done: 2 }), status({ unassessed: 8, budget: room }))).toBeNull();
  });
  it('counts garments checked, and grows the total when a garment is added meanwhile', () => {
    const step = passNext(after({ unassessed: 10 }), status({ unassessed: 7 }), local());
    expect(step.mem).toMatchObject({ done: 3, unassessed: 7 });
    expect(passTotal(step.mem!)).toBe(10);
    const more = passNext(step.mem, status({ unassessed: 8 }), local());
    expect(more.mem).toMatchObject({ done: 3, unassessed: 8 });
    expect(passTotal(more.mem!)).toBe(11);
  });
  it('stops after two calls in a row that judged nothing and checked no garment', () => {
    const idle = after({ judged: 0 });
    const one = passNext(idle, status(), local());
    expect(one).toMatchObject({ stop: null, mem: { stalls: 1 } });
    expect(passNext({ ...one.mem!, judged: 0 }, status(), local()).stop).toBe('stalled');
    // Judging sets, or checking a garment, is progress even when the other is zero.
    expect(passNext(after({ judged: 3, stalls: 1 }), status(), local())).toMatchObject({ stop: null, mem: { stalls: 0 } });
    expect(passNext(after({ judged: 0, stalls: 1 }), status({ unassessed: 9 }), local())).toMatchObject({ stop: null, mem: { stalls: 0 } });
  });
});

describe('a pass over the unchecked garments: what each reply means', () => {
  const sent = (over: Partial<PassMemory> = {}) => passSending(after({ calls: 0, ...over }));
  it('goes on while garments remain, adds up what was found and ends when the server says nothing remains', () => {
    const one = passReply(sent(), ok({ suggested: 2, judged: 6 }));
    expect(one).toMatchObject({ stop: null, mem: { found: 2, judged: 6, calls: 1, failures: 0 } });
    expect(passReply(one.mem, ok({ suggested: 1, remaining: false }))).toMatchObject({ stop: 'done', mem: { found: 3 } });
  });
  it.each<[GenerateReply['code'], PassStop]>([
    ['PENDING_FULL', 'full'], ['BUSY', 'busy'], ['RATE_LIMIT', 'rate'], ['COOLDOWN', 'rate'], ['ALLOWANCE', 'limit'], ['PAUSED', 'paused'],
    ['CONSENT_REQUIRED', 'consent'], ['INACTIVE', 'unavailable'], ['UNCONFIGURED', 'unavailable'], ['CONFIG_CHANGED', 'unavailable'],
    ['UNAVAILABLE', 'unavailable'], ['UNAUTHENTICATED', 'unavailable'], ['NOT_SENT', 'notSent'],
  ])('ends the pass on %s', (code, expected) => {
    expect(passReply(sent(), { code } as GenerateReply).stop).toBe(expected);
  });
  it('takes a call that was never sent back, and ends only on the second failure in a row', () => {
    expect(passReply(sent(), { code: 'NOT_SENT' }).mem.calls).toBe(0);
    for (const code of ['FAILED', 'TIMEOUT', 'FILTERED', 'CONFLICT', 'TERMINAL', 'TOO_LARGE'] as const) {
      const first = passReply(sent(), { code });
      expect(first).toMatchObject({ stop: null, mem: { failures: 1 } });
      expect(passReply(first.mem, { code }).stop).toBe('failed');
      expect(passReply(first.mem, ok()).mem.failures).toBe(0);
    }
  });
  it('never makes more calls than the ceiling, whatever the replies and statuses are', () => {
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const codes: GenerateReply['code'][] = ['FAILED', 'TIMEOUT', 'BUSY', 'RATE_LIMIT', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK'];
    for (let run = 0; run < 400; run++) {
      const start = Math.floor(random() * 120);
      let unassessed = start, mem: PassMemory | null = null, calls = 0, total = start;
      for (let guard = 0; guard < 500; guard++) {
        if (random() < 0.1) { unassessed++; total++; }
        const step = passNext(mem, status({ unassessed }), local());
        mem = step.mem;
        if (step.stop !== null) break;
        mem = passSending(mem!);
        calls++;
        const code = codes[Math.floor(random() * codes.length)]!;
        const reply: GenerateReply = code === 'OK' ? ok({ judged: Math.floor(random() * 4), suggested: 0, remaining: random() < 0.95 })
          : { code } as GenerateReply;
        if (code === 'OK' && random() < 0.5) unassessed = Math.max(0, unassessed - 1);
        const result = passReply(mem, reply);
        mem = result.mem;
        if (result.stop !== null) break;
      }
      expect(calls).toBeLessThanOrEqual(Math.min(PASS_LIMITS.maxCalls, 2 * total + 2));
    }
  });
});

describe('a pass over the unchecked garments: what it says at the end', () => {
  it('says all clothes were checked, and how many outfits were found', () => {
    expect(passLines('done', after({ found: 9, unassessed: 0, done: 10 }))).toEqual([{ key: 'outfitgen.passAll' }, { key: 'outfitgen.found_other', count: 9 }]);
    expect(passLines('done', after({ unassessed: 0, done: 10 }))).toEqual([{ key: 'outfitgen.passAll' }, { key: 'outfitgen.nothingNew' }]);
  });
  it('reads like the earlier manual run when there was nothing left to check', () => {
    expect(passLines('done', after({ start: 0, unassessed: 0, found: 1 }))).toEqual([{ key: 'outfitgen.found_other', count: 1 }]);
    expect(passLines('done', after({ start: 0, unassessed: 0 }))).toEqual([{ key: 'outfitgen.nothingNew' }]);
  });
  it('says how far it got and the one reason it stopped', () => {
    const mem = after({ done: 12, unassessed: 18, found: 4 });
    const progress = { key: 'outfitgen.passSummary_other', count: 30, done: 12 };
    expect(passLines('rate', mem)).toEqual([progress, { key: 'outfitgen.found_other', count: 4 }, { key: 'outfitgen.rateLimit' }]);
    expect(passLines('user', after({ done: 12, unassessed: 18 }))).toEqual([progress, { key: 'outfitgen.passContinue' }]);
    for (const [stop, key] of [['full', 'outfitgen.full'], ['limit', 'outfitgenC.limit'], ['reserve', 'outfitgen.passReserve'], ['paused', 'aiGuard.paused'],
      ['busy', 'outfitgen.busy'], ['live', 'outfitgen.busy'], ['failed', 'outfitgen.failed'], ['consent', 'outfitgen.off'], ['hidden', 'outfitgen.passContinue']] as const) {
      expect(passLines(stop, after({ done: 12, unassessed: 18 })).at(-1)).toEqual({ key });
    }
  });
  it('says only the reason when no call was sent, and nothing for a call that was never sent', () => {
    expect(passLines('limit', null)).toEqual([{ key: 'outfitgenC.limit' }]);
    expect(passLines('consent', after({ calls: 0 }))).toEqual([{ key: 'outfitgen.off' }]);
    expect(passLines('notSent', after({ calls: 0 }))).toEqual([]);
  });
});
