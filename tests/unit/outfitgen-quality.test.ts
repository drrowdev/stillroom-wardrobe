import { describe, expect, it } from 'vitest';
import { anchorSets, buildBatch, softScore, type CandidateBans, type CandidateCategory, type CandidateItem } from '../../src/domain/outfit-candidates';
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

type Judge = (set: readonly CandidateItem[]) => { decision: 'good' | 'skip'; baseScore: number; fullScore: number };
// The lenient stand-in of QUALITY1: every set the soft score likes is a good 9.
const lenient: Judge = (members) => ({ decision: softScore([...members]) >= 0.7 ? 'good' : 'skip', baseScore: 9, fullScore: 9 });

async function pass(options: { maxSuggestedPerCall?: number; items?: CandidateItem[]; judge?: Judge; bar?: number; kept?: string[][] } = {}) {
  const maxSuggestedPerCall = options.maxSuggestedPerCall ?? Infinity;
  const judge = options.judge ?? lenient;
  const bar = options.bar ?? 8;
  const items = (options.items ?? wardrobe()).map((item) => ({ ...item, imageBytes: 100_000 }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const categoryOf = (value: string) => byId.get(value)?.category;
  const none: CandidateBans = { pairs: new Set(), disliked: new Set() };
  const known = new Set<string>(), covered = new Set<string>();
  const lookOf = (ids: readonly string[]) => ({ base: ids.filter((entry) => ['top', 'bottom', 'one_piece'].includes(byId.get(entry)!.category)),
    garments: ids.filter((entry) => byId.get(entry)!.category !== 'footwear') });
  const anchors = items.map((item) => item.id);
  const pending: string[][] = [];
  const keptLooks = (options.kept ?? []).map(lookOf);
  const judgedSets: string[][] = [];
  const scores: number[] = [];
  let calls = 0, judged = 0;
  while (covered.size < anchors.length && calls < 200) {
    const batch = await buildBatch({ items, anchors: anchors.filter((entry) => !covered.has(entry)), known, bans: none });
    if (!batch.sets.length && !batch.covered.length) break;
    if (batch.sets.length) {
      calls++;
      judged += batch.sets.length;
      const verdicts = batch.sets.map((set) => judge(set.ids.map((entry) => byId.get(entry)!)));
      scores.push(...verdicts.map((verdict) => Math.min(verdict.baseScore, verdict.fullScore)));
      judgedSets.push(...batch.sets.map((set) => set.ids));
      const { chosen } = selectSuggestions({ sets: batch.sets.map((set) => set.ids), verdicts, bar, seen: { pending: pending.map(lookOf), kept: keptLooks },
        room: 100 - pending.length, categoryOf });
      expect(chosen.filter(Boolean).length).toBeLessThanOrEqual(maxSuggestedPerCall);
      batch.sets.forEach((set, index) => { known.add(set.signature); if (chosen[index]) pending.push(set.ids); });
    }
    for (const entry of batch.covered) covered.add(entry);
  }
  return { items, byId, categoryOf, calls, judged, judgedSets, scores, pending, covered: covered.size, anchors: anchors.length };
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

// A wardrobe shaped like the owner's (OUTFITGEN-QUALITY2): mostly neutral casual pieces, two Business blazers (layers) among casual layers and
// jackets, and, optionally, the few smart pieces a real wardrobe may have. Nothing here is real data.
const ownerShaped = (smart: boolean) => {
  counter = 1;
  const allYear = { seasons: ['spring', 'summer', 'autumn', 'winter'] };
  return [
    make('top', 'black'), make('top', 'black'), make('top', 'white'), make('top', 'navy', { pattern: 'graphic' }), make('top', 'khaki'),
    ...['khaki', 'brown', 'navy', 'olive', 'grey', 'black'].map((c) => make('bottom', c)), make('bottom', 'olive', { garmentLength: 'short', seasons: ['summer'] }),
    make('footwear', 'white'), make('footwear', 'grey'),
    make('layer', 'navy', { formality: 3, ...allYear }), make('layer', 'grey', { formality: 3, ...allYear }), make('layer', 'black'), make('layer', 'olive'),
    ...['olive', 'olive', 'black', 'khaki', 'brown', 'navy'].map((c) => make('outerwear', c, { warmth: 3 })),
    ...(smart ? [make('top', 'light_blue', { formality: 3 }), make('bottom', 'grey', { formality: 3 }), make('footwear', 'brown', { formality: 3 })] : []),
  ];
};
// A deterministic stand-in judge on the judge's own scale: the soft score (formality included) sets the level, so tonal and mismatched
// looks stay at 6 or below, plain agreeing looks are 7, and one in four of those (by a stable hash of the set) is 8 or more.
const byFit: Judge = (members) => {
  const fit = softScore([...members]);
  const hash = [...members.map((item) => item.id).sort().join('')].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 9973, 7);
  const score = fit >= 0.995 ? (hash % 4 === 0 ? 8 : 7) : fit >= 0.9 ? 6 : 5;
  return { decision: score >= 8 ? 'good' : 'skip', baseScore: score, fullScore: score };
};
const formalIds = (items: readonly CandidateItem[]) => new Set(items.filter((item) => (item.category === 'layer' || item.category === 'outerwear') && (item.formality ?? 0) >= 3).map((item) => item.id));
const tally = (sets: readonly (readonly string[])[], pick: (ids: readonly string[]) => readonly string[]) => {
  const counts = new Map<string, number>();
  for (const ids of sets) for (const key of new Set(pick(ids))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

describe('offline evaluation of QUALITY2 (7s, caps, blazers), same loop and stand-in judges', () => {
  it('lets 7s through without one more call or judged set: the bar only changes what is kept', { timeout: 30_000 }, async () => {
    const at8 = await pass({ items: ownerShaped(true), judge: byFit, bar: 8 });
    const at7 = await pass({ items: ownerShaped(true), judge: byFit, bar: SELECTION_LIMITS.minScore });
    expect(at7.covered).toBe(at7.anchors);
    expect(at7.calls).toBe(at8.calls);
    expect(at7.judged).toBe(at8.judged);
    // The previous generator needed 26 calls on this wardrobe (0.96 per garment): the same loop, measured before this change.
    expect(at7.calls).toBeLessThanOrEqual(26);
    expect(at8.pending.length).toBeGreaterThan(0);
    expect(at7.pending.length).toBeGreaterThan(at8.pending.length);
    // Plain 7s are kept, and the 8s are almost all still kept.
    expect(at7.scores.filter((score) => score === 7).length).toBeGreaterThan(0);
    // Almost every 8 is still kept (measured 14 of 15 on this wardrobe: an early plain look can use up a base or garment cap that a later 8 needed).
    const kept8 = at8.pending.filter((ids) => at7.pending.some((other) => other.join() === ids.join())).length;
    expect(kept8).toBeGreaterThanOrEqual(Math.ceil(at8.pending.length * 0.85));
  });

  it('offers and judges looks with a Business blazer, formal ones among them, where the wardrobe has formal pieces', { timeout: 30_000 }, async () => {
    const items = ownerShaped(true);
    const result = await pass({ items, judge: byFit, bar: SELECTION_LIMITS.minScore });
    const formal = formalIds(items);
    const withBlazer = result.judgedSets.filter((ids) => ids.some((entry) => formal.has(entry)));
    expect(withBlazer.length).toBeGreaterThanOrEqual(16);
    const formalCore = (ids: readonly string[]) => ids.filter((entry) => ['top', 'bottom', 'footwear'].includes(result.categoryOf(entry)!)
      && (result.byId.get(entry)!.formality ?? 0) >= 3).length;
    expect(withBlazer.some((ids) => formalCore(ids) === 3)).toBe(true);
    // Never a blazer or overcoat over shorts or a graphic top.
    for (const ids of withBlazer) {
      for (const entry of ids) {
        const item = result.byId.get(entry)!;
        expect(item.garmentLength === 'short' || item.pattern === 'graphic').toBe(false);
      }
    }
    expect(result.pending.some((ids) => ids.some((entry) => formal.has(entry)))).toBe(true);
    expect(result.calls).toBeLessThanOrEqual(26);
  });

  it('keeps blazers in the judged sets even with no formal tops, bottoms or shoes (smart casual), at no extra calls per garment', { timeout: 30_000 }, async () => {
    const result = await pass({ items: ownerShaped(false), judge: byFit, bar: SELECTION_LIMITS.minScore });
    const formal = formalIds(result.items);
    expect(result.judgedSets.filter((ids) => ids.some((entry) => formal.has(entry))).length).toBeGreaterThanOrEqual(14);
    expect(result.calls).toBeLessThanOrEqual(21);
    // Every sensible top and bottom's own list has a look with a blazer, so no such garment is judged without one; shorts and a graphic top get none.
    const sensible = (item: CandidateItem) => item.garmentLength !== 'short' && item.pattern !== 'graphic';
    for (const anchor of result.items.filter((item) => item.category === 'top' || item.category === 'bottom')) {
      const sets = anchorSets(anchor, result.items, { pairs: new Set(), disliked: new Set() });
      expect(sets.some((set) => set.ids.some((entry) => formal.has(entry)))).toBe(sensible(anchor));
    }
  });

  it('does not close a garment because of what the owner kept: a top in many kept looks is still suggested, and the waiting caps hold', { timeout: 30_000 }, async () => {
    const items = ownerShaped(true);
    const top = items[0]!, bottoms = items.filter((item) => item.category === 'bottom'), shoes = items.filter((item) => item.category === 'footwear');
    const kept = Array.from({ length: 11 }, (_, index) => [top.id, bottoms[index % bottoms.length]!.id, shoes[index % 2]!.id]);
    const result = await pass({ items, judge: byFit, bar: SELECTION_LIMITS.minScore, kept });
    const garments = tally(result.pending, (ids) => ids.filter((entry) => result.categoryOf(entry) !== 'footwear'));
    expect(garments.get(top.id) ?? 0).toBeGreaterThan(0);
    expect(Math.max(...garments.values())).toBeLessThanOrEqual(SELECTION_LIMITS.perGarment);
    // The base cap counts waiting and kept together: no base that got a waiting suggestion ends above the cap.
    const bases = tally([...result.pending, ...kept], (ids) => [baseKeyOf(ids, result.categoryOf)!]);
    for (const ids of result.pending) expect(bases.get(baseKeyOf(ids, result.categoryOf)!)!).toBeLessThanOrEqual(SELECTION_LIMITS.perBase);
  });
});
