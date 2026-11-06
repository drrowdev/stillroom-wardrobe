import { describe, expect, it } from 'vitest';
import { colours, } from '../../src/domain/preferences';
import { neutralColours, pairScore } from '../../src/domain/colour-pairs';
import { CANDIDATE_LIMITS, anchorSets, buildBatch, colourPairScore, pairKeyOf, setKey, signatureOf, softScore, type CandidateBans,
  type CandidateCategory, type CandidateItem } from '../../src/domain/outfit-candidates';
import { combinationKey, combinationSignature } from '../../src/domain/recommendations';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const none: CandidateBans = { pairs: new Set(), disliked: new Set() };
let counter = 1;
const make = (category: CandidateCategory, over: Partial<CandidateItem> = {}): CandidateItem => ({ id: id(counter++), category,
  colours: ['navy'], pattern: 'solid', seasons: ['autumn'], formality: 2, favourite: false, ...over });
const wardrobe = (tops: number, bottoms: number, shoes: number, layers = 0, outer = 0, dresses = 0) => {
  counter = 1;
  return [...Array.from({ length: tops }, () => make('top')), ...Array.from({ length: bottoms }, () => make('bottom')),
    ...Array.from({ length: shoes }, () => make('footwear')), ...Array.from({ length: layers }, () => make('layer')),
    ...Array.from({ length: outer }, () => make('outerwear')), ...Array.from({ length: dresses }, () => make('one_piece'))];
};
const withBytes = (items: readonly CandidateItem[], bytes = 100_000) => items.map((item) => ({ ...item, imageBytes: bytes }));
const valid = (set: readonly string[], items: readonly CandidateItem[]) => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const count = (category: CandidateCategory) => set.filter((entry) => byId.get(entry)!.category === category).length;
  const core = count('footwear') === 1 && ((count('one_piece') === 1 && count('top') === 0 && count('bottom') === 0)
    || (count('top') === 1 && count('bottom') === 1 && count('one_piece') === 0));
  return core && count('layer') <= 1 && count('outerwear') <= 1 && new Set(set).size === set.length;
};

describe('candidate keys and colour table', () => {
  it('uses the canonical key and signature of the recommendation engine', async () => {
    const ids = [id(3), id(1), id(2), id(1)];
    expect(setKey(ids)).toBe(combinationKey(ids));
    expect(await signatureOf(ids)).toBe(await combinationSignature(ids));
  });
  it('mirrors the colour pairing of the app for every colour pair', () => {
    for (const a of [...colours, 'unknown']) for (const b of [...colours, 'unknown']) expect(colourPairScore(a, b)).toBe(pairScore(a, b));
    expect(neutralColours.has('navy')).toBe(true);
  });
  it('orders sets only: pattern clashes lower the score and a favourite raises it', () => {
    const a = make('top', { pattern: 'striped' }), b = make('bottom', { pattern: 'checked' }), c = make('footwear', { pattern: 'floral' });
    expect(softScore([make('top'), make('bottom'), make('footwear')])).toBeGreaterThan(softScore([a, b, c]));
    expect(softScore([make('top', { favourite: true }), make('bottom'), make('footwear')])).toBeGreaterThan(softScore([make('top'), make('bottom'), make('footwear')]));
  });
});

describe('anchor candidate lists', () => {
  it('are finite, valid, deterministic, contain the anchor and never exceed the per-anchor bound', () => {
    const items = wardrobe(20, 15, 8, 4, 3, 2);
    for (const anchor of [items[0]!, items[20]!, items[36]!, items[40]!, items[44]!, items[46]!]) {
      const first = anchorSets(anchor, items, none);
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perAnchor);
      expect(anchorSets(anchor, items, none)).toEqual(first);
      for (const set of first) { expect(set.ids).toContain(anchor.id); expect(valid(set.ids, items)).toBe(true); }
      expect(new Set(first.map((set) => set.key)).size).toBe(first.length);
    }
  });
  it('do not grow with the wardrobe: all-pairs matching never happens', () => {
    const small = anchorSets(wardrobe(5, 5, 3)[0]!, wardrobe(5, 5, 3), none);
    const big = wardrobe(80, 60, 30, 10, 10, 10);
    expect(anchorSets(big[0]!, big, none).length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perAnchor);
    expect(small.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perAnchor);
  });
  it('give every new garment candidates, including one that is mid-ranked or has unknown details', () => {
    const items = wardrobe(10, 10, 5, 3, 2);
    const odd = make('top', { colours: ['unknown'], formality: null, seasons: ['summer'], pattern: 'animal' });
    const all = [...items, odd];
    expect(anchorSets(odd, all, none).length).toBeGreaterThan(0);
    const layer = all.find((item) => item.category === 'layer')!;
    expect(anchorSets(layer, all, none).every((set) => set.addOn)).toBe(true);
    expect(anchorSets(layer, all, none).length).toBeGreaterThan(0);
  });
  it('offer a bare outfit and add-on variants, and some exploration beyond the top scores', () => {
    counter = 1;
    const cycle = ['navy', 'red', 'green', 'pink', 'beige', 'yellow'];
    const items = wardrobe(12, 12, 6, 3, 3).map((item, index) => ({ ...item, colours: [cycle[index % cycle.length]!] }));
    const sets = anchorSets(items[0]!, items, none);
    expect(sets.some((set) => !set.addOn)).toBe(true);
    expect(sets.some((set) => set.addOn)).toBe(true);
    const scores = sets.map((set) => set.score);
    expect(Math.min(...scores)).toBeLessThan(Math.max(...scores));
    expect(sets[0]!.score).toBe(Math.max(...scores));
  });
  it('apply only validity and explicit owner bans, never inferred taste', () => {
    const items = wardrobe(3, 3, 2);
    const [top, bottom] = [items[0]!, items[3]!];
    const banned: CandidateBans = { pairs: new Set([pairKeyOf(top.id, bottom.id)]), disliked: new Set() };
    expect(anchorSets(top, items, banned).every((set) => !(set.ids.includes(top.id) && set.ids.includes(bottom.id)))).toBe(true);
    const some = anchorSets(top, items, none)[0]!;
    const dislikes: CandidateBans = { pairs: new Set(), disliked: new Set([some.key]) };
    expect(anchorSets(top, items, dislikes).map((set) => set.key)).not.toContain(some.key);
    // A warm winter coat, a summer top and a formal shoe are all still offered together: no season or formality gate.
    const odd = [make('top', { seasons: ['summer'], formality: 0 }), make('bottom', { seasons: ['winter'], formality: 4 }), make('footwear', { formality: null })];
    expect(anchorSets(odd[0]!, odd, none)).toHaveLength(1);
  });
  it('produce nothing when no valid outfit exists', () => {
    const items = wardrobe(3, 0, 0);
    expect(anchorSets(items[0]!, items, none)).toEqual([]);
  });
});

describe('batches', () => {
  it('respect garment, set, image byte and token bounds and send each garment once', async () => {
    const items = withBytes(wardrobe(14, 10, 6, 3, 2), 400_000);
    const batch = await buildBatch({ items, anchors: items.slice(0, 6).map((item) => item.id), known: new Set(), bans: none });
    expect(batch.sets.length).toBeGreaterThan(0);
    expect(batch.sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.maxSets);
    expect(batch.garments.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.maxGarments);
    expect(batch.imageBytes).toBeLessThanOrEqual(CANDIDATE_LIMITS.imageBytes);
    expect(batch.garments.length * 400_000).toBeLessThanOrEqual(CANDIDATE_LIMITS.imageBytes);
    expect(CANDIDATE_LIMITS.textTokens + CANDIDATE_LIMITS.imageTokens * batch.garments.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.plannedTokens);
    for (const set of batch.sets) for (const garment of set.ids) expect(batch.garments).toContain(garment);
    expect(new Set(batch.sets.map((set) => set.signature)).size).toBe(batch.sets.length);
  });
  it('eight maximum-size photos do not fit: bytes, not only the garment count, bound the batch', async () => {
    const items = withBytes(wardrobe(10, 10, 5), 512_000);
    const batch = await buildBatch({ items, anchors: [items[0]!.id], known: new Set(), bans: none });
    expect(batch.garments.length).toBeLessThanOrEqual(Math.floor(CANDIDATE_LIMITS.imageBytes / 512_000));
  });
  it('drop known sets, and an anchor ends up covered once its whole list is known or in the batch', async () => {
    const items = withBytes(wardrobe(6, 5, 3));
    const anchor = items[0]!.id;
    const first = await buildBatch({ items, anchors: [anchor], known: new Set(), bans: none });
    expect(first.covered).toEqual([anchor]);
    const known = new Set(first.sets.map((set) => set.signature));
    const second = await buildBatch({ items, anchors: [anchor], known, bans: none });
    expect(second.sets).toEqual([]);
    expect(second.covered).toEqual([anchor]);
    expect(second.uncovered).toEqual([]);
  });
  it('finish assessing every anchor in a bounded number of rounds, never advancing the target', async () => {
    const items = withBytes(wardrobe(10, 8, 4, 2, 2), 300_000);
    const anchors = items.slice(0, 9).map((item) => item.id);
    const known = new Set<string>();
    const covered = new Set<string>();
    let rounds = 0;
    for (; rounds < 30 && covered.size < anchors.length; rounds++) {
      const batch = await buildBatch({ items, anchors: anchors.filter((a) => !covered.has(a)), known, bans: none });
      for (const set of batch.sets) known.add(set.signature);
      for (const entry of batch.covered) covered.add(entry);
      if (!batch.sets.length && !batch.covered.length) break;
    }
    expect(covered.size).toBe(anchors.length);
    expect(rounds).toBeLessThan(30);
  });
  it('uses the sign override and leaves anchors that are not in the wardrobe out', async () => {
    const items = withBytes(wardrobe(3, 3, 2));
    const batch = await buildBatch({ items, anchors: [id(999), items[0]!.id], known: new Set(), bans: none, sign: async (ids) => `sig-${setKey(ids)}` });
    expect(batch.sets.every((set) => set.signature.startsWith('sig-'))).toBe(true);
    expect(batch.uncovered).toEqual([]);
  });
});
