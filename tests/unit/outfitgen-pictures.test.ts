import { describe, expect, it } from 'vitest';
import {
  addStepSample, classifyFailure, estimateMinutesLeft, noReserved, PICTURE_LIMITS, pictureBlock, pictureIndex, pictureKey, pictureTargets, plannedKey,
  removableResults, reserveBlock, reservedGate, slowStepMs, type PictureInputs, type PictureResult,
} from '../../src/domain/outfitgen-pictures';
import { parseSuggestionList } from '../../src/domain/outfitgen-app';

const ID = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = (id: number, itemIds: number[], completedAtMs: number, outfitId: string | null = null): PictureResult =>
  ({ id: ID(id), outfitId, itemIds: itemIds.map(ID), completedAtMs });

describe('finding a picture by its planned garments (OUTFITGEN2)', () => {
  it('keys a set by its sorted garments, whatever their order', () => {
    expect(pictureKey([ID(3), ID(1), ID(2)])).toBe(pictureKey([ID(1), ID(2), ID(3)]));
    expect(pictureKey([ID(1), ID(2)])).not.toBe(pictureKey([ID(1), ID(3)]));
  });
  it('keys the planned steps, and refuses a plan too short to show an outfit or longer than six steps', () => {
    expect(plannedKey([{ itemId: ID(2) }, { itemId: ID(1) }])).toBe(pictureKey([ID(1), ID(2)]));
    expect(plannedKey([{ itemId: ID(1) }])).toBeNull();
    expect(plannedKey([])).toBeNull();
    expect(plannedKey(Array.from({ length: 7 }, (_, at) => ({ itemId: ID(at + 1) })))).toBeNull();
  });
  it('indexes idea pictures only, newest first per set, and ignores a saved outfit\'s try-ons', () => {
    const index = pictureIndex([result(1, [1, 2], 100), result(2, [2, 1], 300), result(3, [1, 2], 200, ID(99)), result(4, [3, 4], 50)]);
    expect([...index.keys()].sort()).toEqual([pictureKey([ID(1), ID(2)]), pictureKey([ID(3), ID(4)])].sort());
    expect(index.get(pictureKey([ID(1), ID(2)]))!.id).toBe(ID(2));
  });
});

describe('what Remove deletes (OUTFITGEN2)', () => {
  const key = pictureKey([ID(1), ID(2)]);
  it('deletes idea pictures of exactly that set that finished after the suggestion was created', () => {
    const results = [result(1, [1, 2], 500), result(2, [2, 1], 1_000), result(3, [1, 2, 3], 2_000), result(4, [1, 3], 2_000)];
    expect(removableResults(results, key, 500)).toEqual([ID(1), ID(2)]);
  });
  it('keeps older pictures, other sets and a saved outfit\'s try-ons', () => {
    const results = [result(1, [1, 2], 499), result(2, [1, 2], 600, ID(99)), result(3, [5, 6], 600)];
    expect(removableResults(results, key, 500)).toEqual([]);
  });
  it('takes a picture the owner made by hand of the same set inside that window (the two cannot be told apart)', () => {
    expect(removableResults([result(1, [1, 2], 900)], key, 500)).toEqual([ID(1)]);
  });
});

describe('what may start a chain (OUTFITGEN2)', () => {
  const ready: PictureInputs = { consentOn: true, consentChanging: false, guardPaused: false, tryOnReady: true, sessionStopped: false, photo: 'saved',
    online: true, visible: true, foreground: false, cooldownUntilMs: null, nowMs: 1_000 };
  it('allows a chain only when every condition holds', () => {
    expect(pictureBlock(ready)).toBeNull();
  });
  it('names the first reason, in the order a person would fix them', () => {
    expect(pictureBlock({ ...ready, consentChanging: true })).toBe('unresolved');
    expect(pictureBlock({ ...ready, consentOn: false, tryOnReady: false })).toBe('consent');
    expect(pictureBlock({ ...ready, guardPaused: true, tryOnReady: false })).toBe('guard');
    expect(pictureBlock({ ...ready, tryOnReady: false })).toBe('tryOn');
    expect(pictureBlock({ ...ready, sessionStopped: true })).toBe('tryOn');
    expect(pictureBlock({ ...ready, photo: 'none' })).toBe('photo');
    expect(pictureBlock({ ...ready, photo: 'unknown' })).toBe('unresolved');
    expect(pictureBlock({ ...ready, online: false })).toBe('offline');
    expect(pictureBlock({ ...ready, visible: false })).toBe('hidden');
    expect(pictureBlock({ ...ready, foreground: true })).toBe('foreground');
    expect(pictureBlock({ ...ready, cooldownUntilMs: 2_000 })).toBe('cooldown');
    expect(pictureBlock({ ...ready, cooldownUntilMs: 1_000 })).toBeNull();
  });
});

describe('which suggestion gets a picture next (OUTFITGEN2)', () => {
  const list = [{ id: 'a', key: 'ka' }, { id: 'b', key: 'kb' }, { id: 'c', key: null }, { id: 'd', key: 'kd' }, { id: 'e', key: 'ka' }];
  const state = (over: Partial<Parameters<typeof pictureTargets>[1]> = {}) => ({ have: new Map(), attempts: new Map<string, number>(),
    skipped: new Set<string>(), excluded: new Set<string>(), ...over });
  it('goes in list order and skips a suggestion without a plan, and one that shares a planned set with an earlier one', () => {
    expect(pictureTargets(list, state()).map((entry) => entry.id)).toEqual(['a', 'b', 'd']);
  });
  it('skips what already has a picture, what was skipped, and what the owner is deciding', () => {
    expect(pictureTargets(list, state({ have: new Map([['kb', 1]]), skipped: new Set(['d']) })).map((entry) => entry.id)).toEqual(['a']);
    // The twin with the same planned set stands in for an excluded one, so the set still gets its picture.
    expect(pictureTargets(list, state({ excluded: new Set(['a', 'd']) })).map((entry) => entry.id)).toEqual(['b', 'e']);
  });
  it('tries a failed outfit once more after the others, and never a third time', () => {
    expect(pictureTargets(list, state({ attempts: new Map([['a', 1]]) })).map((entry) => entry.id)).toEqual(['b', 'd', 'a']);
    expect(pictureTargets(list, state({ attempts: new Map([['a', PICTURE_LIMITS.maxAttempts]]) })).map((entry) => entry.id)).toEqual(['b', 'd', 'e']);
  });
});

describe('what each failure means for the queue (OUTFITGEN2)', () => {
  it('stops the whole queue for BUSY, the allowance, consent, a full list and the spending guard, with the right cooldown', () => {
    expect(classifyFailure('busy', true, false)).toEqual({ kind: 'stop', reason: 'busy', forMs: PICTURE_LIMITS.busyStopMs });
    expect(classifyFailure('allowance', true, false)).toEqual({ kind: 'stop', reason: 'allowance', forMs: PICTURE_LIMITS.stopMs });
    expect(classifyFailure('turnedOff', true, false)).toEqual({ kind: 'stop', reason: 'consent', forMs: null });
    expect(classifyFailure('resultsFull', true, false)).toEqual({ kind: 'stop', reason: 'full', forMs: PICTURE_LIMITS.stopMs });
    expect(classifyFailure('paused', true, false)).toEqual({ kind: 'stop', reason: 'guard', forMs: null });
  });
  it('skips a filtered outfit and counts the other failures as an attempt', () => {
    expect(classifyFailure('filtered', true, false)).toEqual({ kind: 'skip' });
    for (const kind of ['failed', 'lost', 'mismatch'] as const) expect(classifyFailure(kind, true, false)).toEqual({ kind: 'retry' });
    expect(classifyFailure('unavailable', true, false)).toEqual({ kind: 'retry' });
  });
  it('stops the queue for the cooldown when a refusal comes before the claim went through (claimed is false), and counts nothing for its own gate', () => {
    expect(classifyFailure('unavailable', false, false)).toEqual({ kind: 'stop', reason: 'failed', forMs: PICTURE_LIMITS.stopMs });
    // After a successful claim the same outcome is an unknown step, which counts as one attempt.
    expect(classifyFailure('unavailable', true, false)).toEqual({ kind: 'retry' });
    expect(classifyFailure('failed', true, true)).toEqual({ kind: 'defer' });
    expect(classifyFailure('unavailable', true, true)).toEqual({ kind: 'defer' });
  });
});

describe('the server-side single-flight gate (OUTFITGEN2, PICTURES-WAIT1)', () => {
  const observe = (stored: number, ready: number, at: number, memory = noReserved) => reservedGate(memory, stored, ready, at);
  it('lets a chain start when every stored or reserved picture is a ready one', () => {
    expect(observe(5, 5, 0)).toEqual({ wait: false, memory: { baseline: 0, lastStatus: 5, sinceMs: null } });
  });
  it('takes the first gap as ordinary, so stored pictures of deleted outfits never stall the queue', () => {
    // The owner's account: 4 stored pictures, 2 of them belong to Trashed outfits, so 2 are listed.
    const first = observe(4, 2, 0);
    expect(first.wait).toBe(false);
    expect(first.memory.baseline).toBe(2);
    // Every later look at the same numbers goes on too, however long the page stays open.
    let memory = first.memory;
    for (const at of [1_000, 61_000, PICTURE_LIMITS.reservedWaitMs * 3]) {
      const next = observe(4, 2, at, memory);
      expect(next.wait).toBe(false);
      memory = next.memory;
    }
  });
  it('waits once the stored count rises above the baseline: a chain started somewhere else', () => {
    const first = observe(4, 2, 0);
    const started = observe(5, 2, 10_000, first.memory);
    expect(started.wait).toBe(true);
    expect(started.memory.sinceMs).toBe(10_000);
    // The wait is kept across later looks, also when the number no longer rises.
    expect(observe(5, 2, 70_000, started.memory).wait).toBe(true);
    expect(observe(5, 2, 10_000 + PICTURE_LIMITS.reservedWaitMs - 1, started.memory).wait).toBe(true);
  });
  it('goes on when the chain ends, and gives up waiting for rows that outlive a chain', () => {
    const waiting = observe(5, 2, 10_000, observe(4, 2, 0).memory);
    // The chain finished: its picture is ready, the gap is back at the baseline.
    expect(observe(5, 3, 20_000, waiting.memory)).toEqual({ wait: false, memory: { baseline: 2, lastStatus: 5, sinceMs: null } });
    // The row expired: the gap is back at the baseline.
    expect(observe(4, 2, 20_000, waiting.memory).wait).toBe(false);
    // Nothing changed for longer than a chain can live: taken as stored pictures.
    const expired = observe(5, 2, 10_000 + PICTURE_LIMITS.reservedWaitMs, waiting.memory);
    expect(expired.wait).toBe(false);
    expect(expired.memory.baseline).toBe(3);
  });
  it('does not mistake the queue\'s own picture for another chain', () => {
    const first = observe(4, 2, 0);
    // A chain ended: one more stored row and one more ready picture.
    expect(observe(5, 3, 1_000, first.memory)).toEqual({ wait: false, memory: { baseline: 2, lastStatus: 5, sinceMs: null } });
  });
  it('adopts a gap that grew without the stored count rising: an outfit moved to the Trash', () => {
    const first = observe(4, 3, 0);
    const trashed = observe(4, 1, 1_000, first.memory);
    expect(trashed).toEqual({ wait: false, memory: { baseline: 3, lastStatus: 4, sinceMs: null } });
    // Restored again: the baseline follows the gap down.
    expect(observe(4, 3, 2_000, trashed.memory).memory.baseline).toBe(1);
  });
  it('adopts a lower gap at once, and a fresh page starts from what it sees first', () => {
    const first = observe(6, 2, 0);
    expect(observe(4, 2, 1_000, first.memory).memory.baseline).toBe(2);
    expect(observe(6, 2, 0, noReserved).wait).toBe(false);
  });
});

describe('the time estimate (PICTURES-WAIT1)', () => {
  it('uses 30 s per step before anything was measured, in whole minutes', () => {
    expect(estimateMinutesLeft([], 8)).toBe(4);
    expect(estimateMinutesLeft([], 1)).toBe(1);
    expect(estimateMinutesLeft([], 0)).toBeNull();
  });
  it('says under one minute below one', () => {
    expect(estimateMinutesLeft([20_000], 1)).toBe(0);
  });
  it('follows the measured steps, newest ten only', () => {
    expect(estimateMinutesLeft([60_000, 60_000], 5)).toBe(5);
    const samples = [...Array.from({ length: 10 }, () => 120_000), 60_000, 60_000];
    const window = samples.reduce<number[]>((acc, ms) => addStepSample(acc, ms), []);
    expect(window).toHaveLength(10);
    expect(window.slice(-2)).toEqual([60_000, 60_000]);
  });
  it('is unknown when the steps left are unknown, and ignores bad measurements', () => {
    expect(estimateMinutesLeft([60_000], null)).toBeNull();
    expect(addStepSample([1_000], Number.NaN)).toEqual([1_000]);
    expect(addStepSample([1_000], -5)).toEqual([1_000]);
    expect(estimateMinutesLeft([Number.NaN, 0], 2)).toBe(1);
  });
  it('calls a step slow after three times the average, and never before the server\'s own 90 s', () => {
    expect(slowStepMs([])).toBe(90_000);
    expect(slowStepMs([60_000])).toBe(180_000);
  });
});

describe('the budget reserve (OUTFITGEN2, D1)', () => {
  const budget = (remaining: number) => ({ monthlyAllowanceMicro: '50000000', remainingMicro: String(remaining) });
  it('keeps 15 % of the monthly allowance unreserved, counting the chain at the policy\'s per-request amount', () => {
    // 15 % of USD 50 is 7.5; four steps at 0.36 reserve 1.44.
    expect(reserveBlock(budget(9_000_000), '360000', 4)).toBe(false);
    expect(reserveBlock(budget(8_940_000), '360000', 4)).toBe(false);
    expect(reserveBlock(budget(8_939_999), '360000', 4)).toBe(true);
    expect(reserveBlock(budget(7_000_000), '360000', 1)).toBe(true);
  });
  it('falls back to the reservation constant, and never blocks an account without a budget', () => {
    expect(reserveBlock(budget(8_000_000), null, 1)).toBe(false);
    expect(reserveBlock(budget(8_000_000), null, 2)).toBe(true);
    expect(reserveBlock(null, '360000', 6)).toBe(false);
  });
});

describe('the suggestion list carries its creation time (OUTFITGEN2)', () => {
  it('parses createdAt as the server\'s clock and refuses one that is not a time', () => {
    const entry = { id: ID(1), itemIds: [ID(2), ID(3)], title: 'Calm', reason: 'Quiet.', occasion: 'smart', score: 9, createdAt: '2026-11-06T10:00:00Z' };
    expect(parseSuggestionList({ code: 'OK', suggestions: [entry] })).toMatchObject({ kind: 'ok', suggestions: [{ createdAtMs: Date.parse('2026-11-06T10:00:00Z') }] });
    expect(parseSuggestionList({ code: 'OK', suggestions: [{ ...entry, createdAt: 'yesterday' }] })).toBeNull();
  });
});
