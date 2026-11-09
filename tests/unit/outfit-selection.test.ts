import { describe, expect, it } from 'vitest';
import { SELECTION_LIMITS, baseKeyOf, perCallLimit, selectSuggestions, verdictScore, type SelectionCategory, type SelectionSeen,
  type SelectionVerdict } from '../../src/domain/outfit-selection';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Garments 1-6 tops, 11-16 bottoms, 21-22 shoes, 31-33 outerwear, 41 layer, 51 one-piece.
const categories: Record<number, SelectionCategory> = {};
for (let n = 1; n <= 6; n++) categories[n] = 'top';
for (let n = 11; n <= 16; n++) categories[n] = 'bottom';
for (const n of [21, 22]) categories[n] = 'footwear';
for (const n of [31, 32, 33]) categories[n] = 'outerwear';
categories[41] = 'layer'; categories[51] = 'one_piece';
const categoryOf = (value: string) => categories[Number(value.slice(-12))];
const set = (...numbers: number[]) => numbers.map(id);
const none: SelectionSeen = { pending: [], kept: [], removed: [] };
const good = (base = 9, full = 9): SelectionVerdict => ({ decision: 'good', baseScore: base, fullScore: full });
const skip: SelectionVerdict = { decision: 'skip', baseScore: 4, fullScore: 4 };
const pick = (sets: number[][], verdicts: SelectionVerdict[], seen: SelectionSeen = none) =>
  selectSuggestions({ sets: sets.map((entry) => set(...entry)), verdicts, bar: 8, seen, categoryOf });
const chosen = (flags: boolean[]) => flags.flatMap((flag, index) => (flag ? [index] : []));
const seenOf = (pending: number[][] = [], kept: number[][] = [], removed: number[][] = []): SelectionSeen => ({
  pending: pending.map((entry) => set(...entry)), kept: kept.map((entry) => set(...entry)), removed: removed.map((entry) => set(...entry)) });

describe('suggestion scoring', () => {
  it('stores the weaker of the base score and the whole-look score', () => {
    expect(verdictScore({ baseScore: 5, fullScore: 9 })).toBe(5);
    expect(verdictScore({ baseScore: 9, fullScore: 6 })).toBe(6);
    expect(verdictScore({ baseScore: 8, fullScore: 8 })).toBe(8);
  });
  it('allows a quarter of the candidates, rounded up, and never more than four', () => {
    expect([1, 3, 4, 5, 8, 9, 16, 17, 24].map(perCallLimit)).toEqual([1, 1, 1, 2, 2, 3, 4, 4, 4]);
    expect(SELECTION_LIMITS).toEqual({ perCallMax: 4, perBase: 2, perBaseCall: 1, perGarment: 6 });
  });
  it('keys a base by its top and bottoms or its one-piece, ignoring shoes and layers, and refuses a set with an unknown garment', () => {
    expect(baseKeyOf(set(1, 11, 21), categoryOf)).toBe(baseKeyOf(set(1, 11, 22, 31), categoryOf));
    expect(baseKeyOf(set(1, 11, 21), categoryOf)).not.toBe(baseKeyOf(set(2, 11, 21), categoryOf));
    expect(baseKeyOf(set(51, 21), categoryOf)).toBe(id(51));
    expect(baseKeyOf([id(1), id(999)], categoryOf)).toBeNull();
  });
});

describe('which candidates become suggestions', () => {
  it('needs a good verdict whose weaker score reaches the bar', () => {
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], [5, 15, 21], [6, 16, 21]];
    expect(chosen(pick(sets, [good(), good(7, 9), good(9, 7), skip, { decision: 'skip', baseScore: 10, fullScore: 10 }, good(8, 8)]))).toEqual([0, 5]);
  });
  it('keeps only a few per call, best score first, then best base score, then call order', () => {
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], [5, 15, 21], [6, 16, 21], [1, 12, 22], [2, 13, 22], [3, 14, 22], [4, 15, 22], [5, 16, 22], [6, 11, 22]];
    const verdicts = sets.map(() => good(8, 8));
    // All twelve are good; a call of twelve candidates may keep three, and the ties go to the earliest.
    expect(chosen(pick(sets, verdicts))).toEqual([0, 1, 2]);
    verdicts[7] = good(10, 10); verdicts[3] = good(9, 9); verdicts[9] = good(9, 10);
    expect(chosen(pick(sets, verdicts))).toEqual([3, 7, 9]);
    verdicts[4] = good(10, 9);
    expect(chosen(pick(sets, verdicts))).toEqual([3, 4, 7]);
  });
  it('keeps one look per top and bottoms in a call, the best of them', () => {
    const sets = [[1, 11, 21], [1, 11, 22, 31], [1, 11, 21, 41], ...Array.from({ length: 9 }, (_, index) => [2 + (index % 5), 12 + (index % 5), 21])];
    const verdicts = sets.map(() => good(8, 8));
    verdicts[1] = good(9, 9);
    // Without the cap the three looks of the first base would take the three places; with it only the best of them does.
    expect(chosen(pick(sets, verdicts))).toEqual([1, 3, 4]);
  });
  it('counts waiting, kept and removed looks toward the per-base cap of two, each on its own', () => {
    const pad = Array.from({ length: 8 }, () => [6, 16, 21]);
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], ...pad];
    const verdicts = [...sets.slice(0, 4).map(() => good()), ...pad.map(() => skip)];
    const kept = (seen: SelectionSeen) => chosen(pick(sets, verdicts, seen));
    expect(kept(none)).toEqual([0, 1, 2]);
    expect(kept(seenOf([[1, 11, 22]]))).toEqual([0, 1, 2]);
    expect(kept(seenOf([[1, 11, 22]], [[1, 11, 22, 31]]))).toEqual([1, 2, 3]);
    expect(kept(seenOf([], [[1, 11, 22]], [[1, 11, 21, 33]]))).toEqual([1, 2, 3]);
    expect(kept(seenOf([], [], [[1, 11, 22], [1, 11, 21]]))).toEqual([1, 2, 3]);
    // Another base is unaffected, and a set the owner has with one unknown garment matches nothing.
    expect(kept(seenOf([[1, 12, 21], [1, 12, 22]]))).toEqual([0, 1, 2]);
    expect(kept({ pending: [[id(1), id(11), id(999)], [id(1), id(11), id(999)]], kept: [], removed: [] })).toEqual([0, 1, 2]);
  });
  it('caps waiting suggestions per garment but never counts shoes, and kept or removed looks do not count for garments', () => {
    const crowded = Array.from({ length: SELECTION_LIMITS.perGarment }, (_, index) => [1, 11 + index, 21]);
    const pad = Array.from({ length: 9 }, () => [6, 16, 21]);
    const sets = [[1, 12, 22], [2, 12, 22], [2, 13, 21], ...pad];
    const verdicts = [...sets.slice(0, 3).map(() => good()), ...pad.map(() => skip)];
    const kept = (seen: SelectionSeen) => chosen(pick(sets, verdicts, seen));
    // The first top already sits in six waiting suggestions: its look is blocked, the others are not (the bottom 12 is only in one).
    expect(kept(seenOf(crowded))).toEqual([1, 2]);
    expect(kept(seenOf(crowded.slice(0, SELECTION_LIMITS.perGarment - 1)))).toEqual([0, 1, 2]);
    // Shoes are never limited: twelve waiting suggestions in the same shoes block nothing.
    expect(kept(seenOf(Array.from({ length: 12 }, (_, index) => [3 + (index % 3), 14 + (index % 3), 21])))).toEqual([0, 1, 2]);
    const elsewhere = Array.from({ length: SELECTION_LIMITS.perGarment }, () => [1, 16, 21]);
    expect(kept(seenOf([], elsewhere, elsewhere))).toEqual([0, 1, 2]);
  });
  it('is deterministic and keeps within the room even when every candidate is good', () => {
    const sets = Array.from({ length: 8 }, (_, index) => [1 + (index % 6), 11 + (index % 6), index % 2 ? 22 : 21]);
    const first = pick(sets, sets.map(() => good()));
    expect(pick(sets, sets.map(() => good()))).toEqual(first);
    expect(chosen(first)).toEqual([0, 1]);
    expect(chosen(first).length).toBe(perCallLimit(sets.length));
  });
});
