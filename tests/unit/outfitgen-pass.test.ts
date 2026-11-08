import { describe, expect, it } from 'vitest';
import { OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { parseOutfitGenStatus, type GenerateReply, type OutfitGenStatus } from '../../src/domain/outfitgen-app';
import {
  PASS_LIMITS, passCeiling, passLines, passNext, passReply, passSendGate, passSending, type PassLocal, type PassMemory, type PassStop,
} from '../../src/domain/outfitgen-pass';

const BUDGET = { monthlyAllowanceMicro: '50000000', usedMicro: '0', remainingMicro: '50000000', warning: false };
function status(over: Record<string, unknown> = {}, enabled = true, code = 'OK'): OutfitGenStatus {
  return parseOutfitGenStatus({ code, period: '2026-11', serverTimeMs: Date.parse('2026-11-20T00:00:00Z'),
    consent: { enabled, noticeRevision: enabled ? OUTFITGEN_NOTICE_REVISION : null, consentedAt: enabled ? '2026-11-01T00:00:00Z' : null },
    policy: { activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST, modelId: OUTFITGEN_MODEL, maxRequestMicro: '373402' },
    budget: BUDGET, pending: 0, unassessed: 10, autoUnassessed: 10, autoCallsLeft: 3, live: false, cooldownUntilMs: null, ...over })!;
}
const local = (over: Partial<PassLocal> = {}): PassLocal => ({ online: true, visible: true, stopped: null, settling: false, runnable: true, ...over });
const ok = (over: Partial<Extract<GenerateReply, { code: 'OK' }>> = {}): GenerateReply => ({ code: 'OK', suggested: 1, judged: 5, remaining: true, ...over });
/** A memory after one call that left `unassessed` garments, as passNext would hand it on. */
const after = (over: Partial<PassMemory> = {}): PassMemory => ({ start: 10, unassessed: 10, calls: 1, found: 0, stalls: 0, ...over });
const stopOf = (mem: PassMemory | null, s: OutfitGenStatus | null, l: PassLocal = local()) => passNext(mem, s, l).stop;

describe('a pass over the unchecked garments: how many calls it may make', () => {
  it('is bounded by the wardrobe (one garment needs at most eight calls) and by the server cap of 200 a day; none unchecked means one call', () => {
    expect([0, 1, 2, 5, 24, 25, 26, 100].map(passCeiling)).toEqual([1, 8, 16, 40, 192, 200, 200, 200]);
    expect(PASS_LIMITS.maxCalls).toBe(200);
  });
});

describe('a pass over the unchecked garments: whether the next call may be sent', () => {
  it('starts from the first status and is allowed when everything is in order', () => {
    const first = passNext(null, status(), local());
    expect(first.stop).toBeNull();
    expect(first.mem).toMatchObject({ start: 10, unassessed: 10, calls: 0 });
  });
  it('with nothing unchecked makes exactly one call (the earlier manual run) and then ends', () => {
    const first = passNext(null, status({ unassessed: 0 }), local());
    expect(first.stop).toBeNull();
    expect(stopOf(passSending(first.mem!), status({ unassessed: 0 }))).toBe('done');
    expect(passCeiling(first.mem!.start)).toBe(1);
  });
  it('re-reads consent every time and fails closed', () => {
    expect(stopOf(null, status({}, false, 'CONSENT_REQUIRED'))).toBe('consent');
    expect(stopOf(after(), status({}, false, 'CONSENT_REQUIRED'))).toBe('consent');
    expect(stopOf(after(), status({}, true, 'INACTIVE'))).toBe('unavailable');
    expect(stopOf(after(), null)).toBe('unavailable');
    expect(stopOf(after(), status(), local({ runnable: false }))).toBe('consent');
    expect(stopOf(after(), status(), local({ settling: true }))).toBe('notSent');
  });
  it('stops for the owner, for leaving the screen and for the page going away before anything else is read', () => {
    for (const why of ['user', 'away', 'hidden'] as const) {
      expect(stopOf(after(), status(), local({ stopped: why }))).toBe(why);
      expect(stopOf(after(), null, local({ stopped: why }))).toBe(why);
    }
  });
  it('stops for the network, a hidden page, the budget, a live call, a full list and the ceiling', () => {
    const mem = after({ unassessed: 8 });
    expect(stopOf(mem, status({ unassessed: 8 }), local({ online: false }))).toBe('offline');
    expect(stopOf(mem, status({ unassessed: 8 }), local({ visible: false }))).toBe('hidden');
    expect(stopOf(mem, status({ unassessed: 8, budget: { ...BUDGET, usedMicro: '49900000', remainingMicro: '100000' } }))).toBe('limit');
    expect(stopOf(mem, status({ unassessed: 8, live: true }))).toBe('live');
    expect(stopOf(mem, status({ unassessed: 8, pending: 40 }))).toBe('full');
    expect(stopOf(after({ start: 2, unassessed: 2, calls: passCeiling(2) }), status({ unassessed: 1 }))).toBe('ceiling');
    expect(stopOf(after({ start: 2, unassessed: 2, calls: passCeiling(2) - 1 }), status({ unassessed: 1 }))).toBeNull();
  });
  it('keeps 15 percent of the month free for calls after the first, but not for the first', () => {
    const near = { monthlyAllowanceMicro: '50000000', usedMicro: '42500000', remainingMicro: '7500000', warning: false };
    expect(stopOf(null, status({ budget: near }))).toBeNull();
    expect(stopOf(after({ unassessed: 8 }), status({ unassessed: 8, budget: near }))).toBe('reserve');
    const room = { monthlyAllowanceMicro: '50000000', usedMicro: '30000000', remainingMicro: '20000000', warning: false };
    expect(stopOf(after({ unassessed: 8 }), status({ unassessed: 8, budget: room }))).toBeNull();
  });
  it('uses the outfit policy request size, not another purpose, in the reserve arithmetic', () => {
    // 15 % of 50,000,000 is 7,500,000: with 7,900,000 left a 373,402 reservation fits (7,526,598 left), a 500,000 one does not.
    const left = { monthlyAllowanceMicro: '50000000', usedMicro: '42100000', remainingMicro: '7900000', warning: false };
    const policy = (max: string) => ({ activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST, modelId: OUTFITGEN_MODEL, maxRequestMicro: max });
    expect(stopOf(after({ unassessed: 8 }), status({ unassessed: 8, budget: left, policy: policy('373402') }))).toBeNull();
    expect(stopOf(after({ unassessed: 8 }), status({ unassessed: 8, budget: left, policy: policy('500000') }))).toBe('reserve');
  });
  it('counts progress only from a fresh fall of the unchecked count, and stops after eight successful calls without one', () => {
    const fell = passNext(after({ unassessed: 10, stalls: 5 }), status({ unassessed: 9 }), local());
    expect(fell).toMatchObject({ stop: null, mem: { unassessed: 9, stalls: 0 } });
    const same = passNext(after({ unassessed: 10, stalls: 6 }), status({ unassessed: 10 }), local());
    expect(same).toMatchObject({ stop: null, mem: { stalls: 7 } });
    expect(passNext(same.mem, status({ unassessed: 10 }), local())).toMatchObject({ stop: 'stalled', mem: { stalls: 8 } });
    // More unchecked than before (a garment was added) is not progress either.
    expect(passNext(after({ unassessed: 10, stalls: 7 }), status({ unassessed: 11 }), local()).stop).toBe('stalled');
  });
  it('the send gate re-checks reserve, live, pending and the guard from the newest status, and the first call keeps its own rules', () => {
    const near = { monthlyAllowanceMicro: '50000000', usedMicro: '42500000', remainingMicro: '7500000', warning: false };
    expect(passSendGate(status({ budget: near }), false, false)).toBe('reserve');
    expect(passSendGate(status({ budget: near }), true, false)).toBeNull();
    expect(passSendGate(status({ live: true }), true, false)).toBe('live');
    expect(passSendGate(status({ pending: 40 }), false, false)).toBe('full');
    expect(passSendGate(status(), false, true)).toBe('paused');
    expect(passSendGate(status(), true, true)).toBeNull();
    expect(passSendGate(status(), false, false)).toBeNull();
    expect(passSendGate(null, true, false)).toBe('unavailable');
  });
  it('a garment that needs five calls is not cut short (neither by progress nor by the ceiling)', () => {
    let mem = passNext(null, status({ unassessed: 1 }), local()).mem!;
    let calls = 0;
    for (let guard = 0; guard < 10; guard++) {
      mem = passSending(mem); calls++;
      const result = passReply(mem, ok({ judged: 3 }));
      mem = result.mem;
      expect(result.stop).toBeNull();
      const step = passNext(mem, status({ unassessed: calls < 5 ? 1 : 0 }), local());
      mem = step.mem!;
      if (step.stop !== null) { expect(step.stop).toBe('done'); break; }
    }
    expect(calls).toBe(5);
  });
});

describe('a pass over the unchecked garments: what each reply means', () => {
  const sent = (over: Partial<PassMemory> = {}) => passSending(after({ calls: 0, ...over }));
  it('goes on while garments remain, adds up what was found and ends when the server says nothing remains', () => {
    const one = passReply(sent(), ok({ suggested: 2, judged: 6 }));
    expect(one).toMatchObject({ stop: null, mem: { found: 2, calls: 1 } });
    expect(passReply(one.mem, ok({ suggested: 1, remaining: false }))).toMatchObject({ stop: 'done', mem: { found: 3 } });
  });
  it.each<[GenerateReply['code'], PassStop]>([
    ['PENDING_FULL', 'full'], ['BUSY', 'busy'], ['RATE_LIMIT', 'rate'], ['COOLDOWN', 'rate'], ['ALLOWANCE', 'limit'], ['PAUSED', 'paused'],
    ['CONSENT_REQUIRED', 'consent'], ['INACTIVE', 'unavailable'], ['UNCONFIGURED', 'unavailable'], ['CONFIG_CHANGED', 'unavailable'],
    ['UNAVAILABLE', 'unavailable'], ['UNAUTHENTICATED', 'unavailable'], ['NOT_SENT', 'notSent'],
    ['FAILED', 'failed'], ['TIMEOUT', 'failed'], ['FILTERED', 'failed'], ['CONFLICT', 'failed'], ['TERMINAL', 'failed'], ['TOO_LARGE', 'failed'],
  ])('ends the pass on %s', (code, expected) => {
    expect(passReply(sent(), { code } as GenerateReply).stop).toBe(expected);
  });
  it('takes a call that was never sent back', () => {
    expect(passReply(sent(), { code: 'NOT_SENT' }).mem.calls).toBe(0);
  });
  it('never makes more calls than the ceiling, whatever the replies and statuses are', () => {
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 400; run++) {
      const start = Math.floor(random() * 30);
      let unassessed = start, mem: PassMemory | null = null, calls = 0;
      for (let guard = 0; guard < 500; guard++) {
        if (random() < 0.1) unassessed++;
        const step = passNext(mem, status({ unassessed }), local());
        mem = step.mem;
        if (step.stop !== null) break;
        mem = passSending(mem!);
        calls++;
        const reply: GenerateReply = random() < 0.9 ? ok({ judged: Math.floor(random() * 4), suggested: 0, remaining: random() < 0.95 }) : { code: 'FAILED' };
        if (reply.code === 'OK' && random() < 0.3) unassessed = Math.max(0, unassessed - 1);
        const result = passReply(mem, reply);
        mem = result.mem;
        if (result.stop !== null) break;
      }
      expect(calls).toBeLessThanOrEqual(passCeiling(start));
    }
  });
});

describe('a pass over the unchecked garments: what it says at the end', () => {
  it('says all eligible garments were checked only after a final read that shows none left', () => {
    expect(passLines('done', after({ found: 9 }), 0)).toEqual([{ key: 'outfitgen.passAll' }, { key: 'outfitgen.found_other', count: 9 }]);
    expect(passLines('done', after(), 0)).toEqual([{ key: 'outfitgen.passAll' }, { key: 'outfitgen.nothingNew' }]);
    // The final read failed: nothing is claimed.
    expect(passLines('done', after({ found: 2 }), null).map((line) => line.key)).toEqual(['outfitgen.found_other', 'outfitgen.passUnconfirmed']);
    // The server said nothing remained but garments are left (one was added meanwhile): the count is said.
    expect(passLines('done', after(), 3)).toEqual([{ key: 'outfitgen.passStopped_other', count: 3 }, { key: 'outfitgen.passContinue' }]);
  });
  it('reads like the earlier manual run when there was nothing left to check', () => {
    expect(passLines('done', after({ start: 0, unassessed: 0, found: 1 }), 0)).toEqual([{ key: 'outfitgen.found_other', count: 1 }]);
    expect(passLines('done', after({ start: 0, unassessed: 0 }), 0)).toEqual([{ key: 'outfitgen.nothingNew' }]);
  });
  it('says how many are left, from the final read, and the one reason it stopped', () => {
    const left = { key: 'outfitgen.passStopped_other', count: 18 };
    expect(passLines('rate', after({ unassessed: 20, found: 4 }), 18)).toEqual([left, { key: 'outfitgen.found_other', count: 4 }, { key: 'outfitgen.rateLimit' }]);
    expect(passLines('user', after({ unassessed: 20 }), 18)).toEqual([left, { key: 'outfitgen.passContinue' }]);
    // Without a final read the last count read before the call stands.
    expect(passLines('user', after({ unassessed: 20 }), null)[0]).toEqual({ key: 'outfitgen.passStopped_other', count: 20 });
    for (const [stop, key] of [['full', 'outfitgen.full'], ['limit', 'outfitgenC.limit'], ['reserve', 'outfitgen.passReserve'], ['paused', 'aiGuard.paused'],
      ['busy', 'outfitgen.busy'], ['live', 'outfitgen.busy'], ['failed', 'outfitgen.failed'], ['consent', 'outfitgen.off'], ['hidden', 'outfitgen.passContinue'],
      ['away', 'outfitgen.passContinue'], ['ceiling', 'outfitgen.passSafety'], ['stalled', 'outfitgen.passSafety']] as const) {
      expect(passLines(stop, after({ unassessed: 20 }), 18).at(-1)).toEqual({ key });
    }
  });
  it('says only the reason when no call was sent, and nothing for a call that was never sent', () => {
    expect(passLines('limit', null, null)).toEqual([{ key: 'outfitgenC.limit' }]);
    expect(passLines('consent', after({ calls: 0 }), null)).toEqual([{ key: 'outfitgen.off' }]);
    expect(passLines('notSent', after({ calls: 0 }), null)).toEqual([]);
  });
});
