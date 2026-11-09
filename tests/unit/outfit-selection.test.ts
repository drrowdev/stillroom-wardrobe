import { describe, expect, it } from 'vitest';
import { SELECTION_LIMITS, baseKeyOf, perCallLimit, rankCandidates, selectSuggestions, verdictScore, type SeenLook, type SelectionCategory,
  type SelectionSeen, type SelectionVerdict } from '../../src/domain/outfit-selection';

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
const none: SelectionSeen = { pending: [], kept: [] };
const good = (base = 9, full = 9): SelectionVerdict => ({ decision: 'good', baseScore: base, fullScore: full });
const skip: SelectionVerdict = { decision: 'skip', baseScore: 4, fullScore: 4 };
// What the database reports for one existing suggestion: its base ids and its garments other than shoes.
const look = (...numbers: number[]): SeenLook => ({
  base: numbers.filter((n) => ['top', 'bottom', 'one_piece'].includes(categories[n]!)).map(id),
  garments: numbers.filter((n) => categories[n] !== 'footwear').map(id) });
const seenOf = (pending: number[][] = [], kept: number[][] = []): SelectionSeen => ({ pending: pending.map((entry) => look(...entry)), kept: kept.map((entry) => look(...entry)) });
const run = (sets: number[][], verdicts: SelectionVerdict[], seen: SelectionSeen = none, room = 100) =>
  selectSuggestions({ sets: sets.map((entry) => set(...entry)), verdicts, bar: 8, seen, room, categoryOf });
const chosen = (sets: number[][], verdicts: SelectionVerdict[], seen: SelectionSeen = none, room = 100) =>
  run(sets, verdicts, seen, room).chosen.flatMap((flag, index) => (flag ? [index] : []));

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
  it('ranks by the weaker score, then the base score, then the order of the call', () => {
    const verdicts = [good(8, 8), good(10, 9), good(9, 9), good(9, 10), good(8, 10), skip];
    expect(rankCandidates(verdicts)).toEqual([1, 2, 3, 0, 4, 5]);
  });
});

describe('which candidates become suggestions', () => {
  it('needs a good verdict whose weaker score reaches the bar', () => {
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], [5, 15, 21], [6, 16, 21]];
    expect(chosen(sets, [good(), good(7, 9), good(9, 7), skip, { decision: 'skip', baseScore: 10, fullScore: 10 }, good(8, 8)])).toEqual([0, 5]);
  });
  it('keeps only a few per call, best score first, then best base score, then call order', () => {
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], [5, 15, 21], [6, 16, 21], [1, 12, 22], [2, 13, 22], [3, 14, 22], [4, 15, 22], [5, 16, 22], [6, 11, 22]];
    const verdicts = sets.map(() => good(8, 8));
    // All twelve are good; a call of twelve candidates may keep three, and the ties go to the earliest.
    expect(chosen(sets, verdicts)).toEqual([0, 1, 2]);
    verdicts[7] = good(10, 10); verdicts[3] = good(9, 9); verdicts[9] = good(9, 10);
    expect(chosen(sets, verdicts)).toEqual([3, 7, 9]);
    verdicts[4] = good(10, 9);
    expect(chosen(sets, verdicts)).toEqual([3, 4, 7]);
  });
  it('keeps one look per top and bottoms in a call, the best of them', () => {
    const sets = [[1, 11, 21], [1, 11, 22, 31], [1, 11, 21, 41], ...Array.from({ length: 9 }, (_, index) => [2 + (index % 5), 12 + (index % 5), 21])];
    const verdicts = sets.map(() => good(8, 8));
    verdicts[1] = good(9, 9);
    // Without the cap the three looks of the first base would take the three places; with it only the best of them does.
    expect(chosen(sets, verdicts)).toEqual([1, 3, 4]);
  });
  it('counts waiting and kept looks toward the per-base cap of two, each on its own', () => {
    const pad = Array.from({ length: 8 }, () => [6, 16, 21]);
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], ...pad];
    const verdicts = [...sets.slice(0, 4).map(() => good()), ...pad.map(() => skip)];
    expect(chosen(sets, verdicts, none)).toEqual([0, 1, 2]);
    expect(chosen(sets, verdicts, seenOf([[1, 11, 22]]))).toEqual([0, 1, 2]);
    expect(chosen(sets, verdicts, seenOf([[1, 11, 22]], [[1, 11, 22, 31]]))).toEqual([1, 2, 3]);
    expect(chosen(sets, verdicts, seenOf([[1, 11, 22], [1, 11, 21, 33]]))).toEqual([1, 2, 3]);
    expect(chosen(sets, verdicts, seenOf([], [[1, 11, 22], [1, 11, 21, 33]]))).toEqual([1, 2, 3]);
    // Another base is unaffected.
    expect(chosen(sets, verdicts, seenOf([[1, 12, 21], [1, 12, 22]]))).toEqual([0, 1, 2]);
  });
  it('does not count removed sets: the selection has no way to see them, so a base the owner removed twice is still welcome', () => {
    const pad = Array.from({ length: 8 }, () => [6, 16, 21]);
    const sets = [[1, 11, 21, 31], ...pad];
    const verdicts = [good(), ...pad.map(() => skip)];
    // Two removed variants of the same top and bottoms (21 with 32 and 22 with 33) are exact-set bans in the plan, not history here.
    expect(Object.keys(none)).toEqual(['pending', 'kept']);
    expect(chosen(sets, verdicts, none)).toEqual([0]);
    expect(chosen(sets, verdicts, seenOf([[1, 11, 21, 32]]))).toEqual([0]);
  });
  it('caps waiting and kept suggestions per garment, never counts shoes, and is not fooled by a set outside the candidate pool', () => {
    const crowded = Array.from({ length: SELECTION_LIMITS.perGarment }, (_, index) => [1, 11 + index, 21]);
    const pad = Array.from({ length: 9 }, () => [6, 16, 21]);
    const sets = [[1, 12, 22], [2, 12, 22], [2, 13, 21], ...pad];
    const verdicts = [...sets.slice(0, 3).map(() => good()), ...pad.map(() => skip)];
    // The first top already sits in six waiting suggestions: its look is blocked, the others are not.
    expect(chosen(sets, verdicts, seenOf(crowded))).toEqual([1, 2]);
    // Kept suggestions count too, three waiting and three kept making six.
    expect(chosen(sets, verdicts, seenOf(crowded.slice(0, 3), crowded.slice(3)))).toEqual([1, 2]);
    expect(chosen(sets, verdicts, seenOf(crowded.slice(0, SELECTION_LIMITS.perGarment - 1)))).toEqual([0, 1, 2]);
    // Shoes are never limited: twelve waiting suggestions in the same shoes block nothing.
    expect(chosen(sets, verdicts, seenOf(Array.from({ length: 12 }, (_, index) => [3 + (index % 3), 14 + (index % 3), 21])))).toEqual([0, 1, 2]);
    // The database reports each look by its base and garments, so a look whose shoes (or any garment) are not among the candidates still counts.
    const outside = { pending: crowded.map((entry) => ({ base: [id(1), id(entry[1]!)], garments: [id(1), id(entry[1]!), id(999)] })), kept: [] };
    expect(chosen(sets, verdicts, outside)).toEqual([1, 2]);
  });
  it('never keeps more than the room left on the waiting list, and declines the rest rather than dropping them', () => {
    const pad = Array.from({ length: 8 }, () => [6, 16, 21]);
    const sets = [[1, 11, 21], [2, 12, 21], [3, 13, 21], [4, 14, 21], ...pad];
    const verdicts = [...sets.slice(0, 4).map(() => good()), ...pad.map(() => skip)];
    expect(chosen(sets, verdicts, none, 3)).toEqual([0, 1, 2]);
    expect(chosen(sets, verdicts, none, 2)).toEqual([0, 1]);
    expect(chosen(sets, verdicts, none, 1)).toEqual([0]);
    expect(chosen(sets, verdicts, none, 0)).toEqual([]);
    // Every candidate keeps its place in the ranking, so each can be recorded (the others as declined).
    expect(run(sets, verdicts, none, 1).order).toHaveLength(sets.length);
  });
  it('gives the room to the better candidate when several tie on score: the one with the stronger base', () => {
    const pad = Array.from({ length: 10 }, () => [6, 16, 21]);
    const sets = [[1, 11, 21], [2, 12, 21], ...pad];
    // Both are good at 8; the second has the stronger base look, so with room for one it is the one kept (call order would keep the first).
    const verdicts = [good(8, 9), good(9, 8), ...pad.map(() => skip)];
    expect(verdictScore(verdicts[0]!)).toBe(verdictScore(verdicts[1]!));
    expect(chosen(sets, verdicts, none, 1)).toEqual([1]);
    expect(run(sets, verdicts, none, 1).order.slice(0, 2)).toEqual([1, 0]);
    // With equal base scores too, call order decides.
    const equal = [good(8, 8), good(8, 8), ...pad.map(() => skip)];
    expect(chosen(sets, equal, none, 1)).toEqual([0]);
  });
  it('is deterministic and keeps within the room even when every candidate is good', () => {
    const sets = Array.from({ length: 8 }, (_, index) => [1 + (index % 6), 11 + (index % 6), index % 2 ? 22 : 21]);
    const first = run(sets, sets.map(() => good()));
    expect(run(sets, sets.map(() => good()))).toEqual(first);
    expect(chosen(sets, sets.map(() => good()))).toEqual([0, 1]);
    expect(first.chosen.filter(Boolean).length).toBe(perCallLimit(sets.length));
  });
});
