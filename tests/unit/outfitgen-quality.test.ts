import { describe, expect, it } from 'vitest';
import { buildBatch, softScore, type CandidateBans, type CandidateCategory, type CandidateItem } from '../../src/domain/outfit-candidates';
import { SELECTION_LIMITS, baseKeyOf, selectSuggestions } from '../../src/domain/outfit-selection';

// An offline evaluation of the generator and the selection together, with no provider and no real data: a synthetic wardrobe shaped
// like a small real one (few tops and shoes, many bottoms and jackets, mostly neutral colours) goes through the same loop a whole-wardrobe
// press runs (real buildBatch, real selectSuggestions, the waiting list fed back as `seen`) with a deterministic stand-in for the judge.
// It measures how the candidates are chosen and capped, never whether an outfit looks good: that is the owner's trial.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 1;
const make = (category: CandidateCategory, colour: string, over: Partial<CandidateItem> = {}): CandidateItem => ({ id: id(counter++), category,
  colours: [colour], pattern: 'solid', seasons: ['spring', 'autumn'], formality: 1, favourite: false, ...over });
const wardrobe = () => {
  counter = 1;
  return [
    make('top', 'black'), make('top', 'black'), make('top', 'navy', { pattern: 'graphic' }), make('top', 'brown'), make('top', 'white'),
    ...['brown', 'navy', 'grey', 'olive', 'khaki', 'blue', 'navy'].map((c, index) => make('bottom', c, index === 6 ? { seasons: ['summer'], garmentLength: 'short' } : {})),
    make('footwear', 'white'), make('footwear', 'grey'), make('layer', 'black'),
    ...['olive', 'olive', 'olive', 'black', 'black', 'khaki', 'grey', 'black'].map((c) => make('outerwear', c, { warmth: 3 })),
  ];
};

async function pass(maxSuggestedPerCall = Infinity) {
  const items = wardrobe().map((item) => ({ ...item, imageBytes: 100_000 }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const categoryOf = (value: string) => byId.get(value)?.category;
  const none: CandidateBans = { pairs: new Set(), disliked: new Set() };
  const known = new Set<string>(), covered = new Set<string>();
  const lookOf = (ids: readonly string[]) => ({ base: ids.filter((entry) => ['top', 'bottom', 'one_piece'].includes(byId.get(entry)!.category)),
    garments: ids.filter((entry) => byId.get(entry)!.category !== 'footwear') });
  const anchors = items.map((item) => item.id);
  const pending: string[][] = [];
  let calls = 0, judged = 0;
  while (covered.size < anchors.length && calls < 200) {
    const batch = await buildBatch({ items, anchors: anchors.filter((entry) => !covered.has(entry)), known, bans: none });
    if (!batch.sets.length && !batch.covered.length) break;
    if (batch.sets.length) {
      calls++;
      judged += batch.sets.length;
      // The stand-in judge likes every set the soft score already likes, which is a lenient judge on purpose: the caps must hold anyway.
      const verdicts = batch.sets.map((set) => ({ decision: softScore(set.ids.map((entry) => byId.get(entry)!)) >= 0.7 ? 'good' as const : 'skip' as const,
        baseScore: 9, fullScore: 9 }));
      const { chosen } = selectSuggestions({ sets: batch.sets.map((set) => set.ids), verdicts, bar: 8, seen: { pending: pending.map(lookOf), kept: [] },
        room: 100 - pending.length, categoryOf });
      expect(chosen.filter(Boolean).length).toBeLessThanOrEqual(maxSuggestedPerCall);
      batch.sets.forEach((set, index) => { known.add(set.signature); if (chosen[index]) pending.push(set.ids); });
    }
    for (const entry of batch.covered) covered.add(entry);
  }
  return { items, byId, categoryOf, calls, judged, pending, covered: covered.size, anchors: anchors.length };
}

describe('offline evaluation of candidate generation and selection (synthetic wardrobe, stand-in judge)', () => {
  it('finishes the whole wardrobe in a bounded number of calls, at or below the cost of the generator it replaces', async () => {
    const result = await pass();
    expect(result.covered).toBe(result.anchors);
    // Measured on this fixture with the same loop: 20 calls (0.87 per garment) before OUTFITGEN-QUALITY1, 19 after.
    expect(result.calls / result.items.length).toBeLessThanOrEqual(0.9);
    expect(result.judged).toBeGreaterThan(result.calls);
  });

  it('keeps the list varied: at most two looks per top+bottoms and no garment in more than the per-garment cap of waiting suggestions', async () => {
    const result = await pass();
    expect(result.pending.length).toBeGreaterThanOrEqual(10);
    const perBase = new Map<string, number>(), perGarment = new Map<string, number>();
    for (const ids of result.pending) {
      const key = baseKeyOf(ids, result.categoryOf)!;
      perBase.set(key, (perBase.get(key) ?? 0) + 1);
      for (const entry of ids) if (result.categoryOf(entry) !== 'footwear') perGarment.set(entry, (perGarment.get(entry) ?? 0) + 1);
    }
    expect(Math.max(...perBase.values())).toBeLessThanOrEqual(SELECTION_LIMITS.perBase);
    expect(Math.max(...perGarment.values())).toBeLessThanOrEqual(SELECTION_LIMITS.perGarment);
    // Near-duplicates (a look whose top+bottoms another look already has) are at most half of the list by construction.
    expect(1 - perBase.size / result.pending.length).toBeLessThanOrEqual(0.5);
    // Both pairs of shoes are used: collapsing footwear variants does not turn every look into the same shoes.
    const shoes = new Set(result.pending.flatMap((ids) => ids.filter((entry) => result.categoryOf(entry) === 'footwear')));
    expect(shoes.size).toBe(2);
  });

  it('would not keep the list varied without the caps (the evaluation is not vacuous)', async () => {
    const result = await pass();
    const wide = new Map<string, number>();
    // The same stand-in judge with no selection at all: every set it likes becomes a suggestion.
    const items = result.items;
    const none: CandidateBans = { pairs: new Set(), disliked: new Set() };
    const known = new Set<string>(), covered = new Set<string>();
    const liked: string[][] = [];
    while (covered.size < items.length) {
      const batch = await buildBatch({ items, anchors: items.map((item) => item.id).filter((entry) => !covered.has(entry)), known, bans: none });
      if (!batch.sets.length && !batch.covered.length) break;
      for (const set of batch.sets) { known.add(set.signature); if (softScore(set.ids.map((entry) => result.byId.get(entry)!)) >= 0.7) liked.push(set.ids); }
      for (const entry of batch.covered) covered.add(entry);
    }
    for (const ids of liked) { const key = baseKeyOf(ids, result.categoryOf)!; wide.set(key, (wide.get(key) ?? 0) + 1); }
    expect(Math.max(...wide.values())).toBeGreaterThan(SELECTION_LIMITS.perBase);
    expect(liked.length).toBeGreaterThan(result.pending.length * 2);
  });
});
