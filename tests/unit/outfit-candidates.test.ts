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

describe('candidate formal add-ons (OUTFITGEN-QUALITY2)', () => {
  const casual = { formality: 1, colours: ['black'] }, formal = { formality: 3, colours: ['navy'] };
  const allSeasons = ['spring', 'summer', 'autumn', 'winter'];
  it('rank a layer by how its formality fits the core: formal core with a blazer above casual core with it, casual layer on casual core above both', () => {
    counter = 1;
    const [ct, cb, cf] = [make('top', casual), make('bottom', casual), make('footwear', casual)];
    const [ft, fb, ff] = [make('top', formal), make('bottom', formal), make('footwear', formal)];
    const blazer = make('layer', { ...formal, seasons: allSeasons }), hoodie = make('layer', { ...casual, seasons: allSeasons });
    const casualPlusBlazer = softScore([ct, cb, cf, blazer]), formalPlusBlazer = softScore([ft, fb, ff, blazer]);
    expect(formalPlusBlazer).toBeGreaterThan(casualPlusBlazer);
    expect(softScore([ct, cb, cf, hoodie])).toBeGreaterThan(casualPlusBlazer);
    // A smart-casual blazer over a casual core is lowered, not buried: the gap of two costs less than a formal core's whole formality term.
    expect(casualPlusBlazer).toBeGreaterThan(softScore([ct, cb, cf, hoodie]) - 0.1);
    // An add-on with no known formality changes nothing.
    const unknown = make('layer', { ...formal, formality: null, seasons: allSeasons });
    expect(softScore([ct, cb, cf, unknown])).toBe(softScore([ct, cb, cf, make('layer', { ...casual, seasons: allSeasons, formality: null })]));
  });
  it('give a formal layer\'s own list the formal garments first when they exist', () => {
    counter = 1;
    const tops = [make('top', casual), make('top', casual), make('top', formal)];
    const bottoms = [make('bottom', casual), make('bottom', casual), make('bottom', formal)];
    const shoes = [make('footwear', casual), make('footwear', formal)];
    const blazer = make('layer', { ...formal, seasons: allSeasons });
    const items = [...tops, ...bottoms, ...shoes, blazer];
    const sets = anchorSets(blazer, items, none);
    expect(sets[0]!.ids).toEqual(expect.arrayContaining([tops[2]!.id, bottoms[2]!.id, shoes[1]!.id, blazer.id]));
    expect(sets.every((set) => set.ids.includes(blazer.id))).toBe(true);
  });
  it('keep a look with the formal layer or jacket in every other garment\'s list, even when casual layers fit the top better', () => {
    counter = 1;
    const tops = [make('top', casual), make('top', casual)];
    const bottoms = Array.from({ length: 5 }, () => make('bottom', casual));
    const shoes = [make('footwear', casual), make('footwear', casual)];
    const hoodies = Array.from({ length: 3 }, () => make('layer', { ...casual, seasons: allSeasons }));
    const bombers = Array.from({ length: 3 }, () => make('outerwear', { ...casual, seasons: allSeasons, warmth: 2 }));
    const blazer = make('layer', { ...formal, seasons: allSeasons });
    const items = [...tops, ...bottoms, ...shoes, ...hoodies, ...bombers, blazer];
    for (const anchor of [tops[0]!, bottoms[2]!, shoes[0]!]) {
      const sets = anchorSets(anchor, items, none);
      expect(sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perAnchor);
      expect(sets.some((set) => set.ids.includes(blazer.id))).toBe(true);
      expect(sets.some((set) => !set.addOn) && sets.some((set) => set.addOn)).toBe(true);
      const perBase = new Map<string, number>();
      for (const set of sets) perBase.set(set.base, (perBase.get(set.base) ?? 0) + 1);
      expect(Math.max(...perBase.values())).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
    }
  });
  it('never offer a formal layer or jacket over shorts or a graphic top, in any list, and give it no look when no sensible pairing exists', () => {
    counter = 1;
    const plainTops = [make('top', casual), make('top', { ...casual, colours: ['white'] })], graphic = make('top', { ...casual, pattern: 'graphic' });
    const trousers = [make('bottom', casual), make('bottom', { ...casual, colours: ['khaki'] })], shorts = make('bottom', { ...casual, garmentLength: 'short', seasons: ['summer'] });
    const shoes = [make('footwear', casual), make('footwear', { ...casual, colours: ['white'] })];
    const blazer = make('layer', { ...formal, seasons: allSeasons }), overcoat = make('outerwear', { ...formal, seasons: ['autumn', 'winter'], colours: ['grey'] });
    const items = [...plainTops, graphic, ...trousers, shorts, ...shoes, blazer, overcoat];
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const anchor of items) {
      for (const set of anchorSets(anchor, items, none)) {
        const members = set.ids.map((entry) => byId.get(entry)!);
        if (!members.some((item) => item.id === blazer.id || item.id === overcoat.id)) continue;
        expect(members.some((item) => item.garmentLength === 'short' || item.pattern === 'graphic')).toBe(false);
      }
    }
    expect(anchorSets(blazer, items, none).length).toBeGreaterThan(0);
    expect(anchorSets(graphic, items, none).every((set) => !set.ids.includes(blazer.id) && !set.ids.includes(overcoat.id))).toBe(true);
    // A wardrobe whose only tops are graphic and only bottoms shorts: the blazer simply has none (and is still finite and assessable).
    counter = 1;
    const bad = [make('top', { ...casual, pattern: 'graphic' }), make('bottom', { ...casual, garmentLength: 'short' }), make('footwear', casual), make('layer', { ...formal, seasons: allSeasons })];
    expect(anchorSets(bad[3]!, bad, none)).toEqual([]);
    expect(anchorSets(bad[0]!, bad, none).every((set) => !set.ids.includes(bad[3]!.id))).toBe(true);
    expect(anchorSets(bad[0]!, bad, none).length).toBeGreaterThan(0);
  });
  it('replace a list\'s only casual add-on with the formal one when the base cap leaves no free place (bare + casual layer + blazer on one base)', () => {
    counter = 1;
    const top = make('top', { ...casual, colours: ['navy'] }), trousers = make('bottom', { ...casual, colours: ['grey'] }), shoes = make('footwear', { ...casual, colours: ['white'] });
    const hoodie = make('layer', { ...casual, colours: ['grey'], seasons: allSeasons }), blazer = make('layer', { ...formal, seasons: allSeasons });
    const sets = anchorSets(top, [top, trousers, shoes, hoodie, blazer], none);
    expect(sets.some((set) => set.ids.includes(blazer.id))).toBe(true);
    expect(sets.some((set) => !set.addOn)).toBe(true);
    expect(sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
  });
  it('choose the formal candidate after bans: a banned blazer leaves the overcoat in every list that can have one', () => {
    counter = 1;
    const top = make('top', { ...casual, colours: ['navy'] });
    const trousers = ['grey', 'khaki', 'brown', 'olive', 'black'].map((c) => make('bottom', { ...casual, colours: [c] }));
    const shoes = make('footwear', { ...casual, colours: ['white'] });
    const hoodies = [make('layer', { ...casual, seasons: allSeasons }), make('layer', { ...casual, colours: ['grey'], seasons: allSeasons })];
    const jackets = [make('outerwear', { ...casual, warmth: 2 }), make('outerwear', { ...casual, colours: ['olive'], warmth: 2 })];
    const blazer = make('layer', { ...formal, seasons: allSeasons }), overcoat = make('outerwear', { ...formal, colours: ['grey'], seasons: allSeasons, warmth: 3 });
    const items = [top, ...trousers, shoes, ...hoodies, ...jackets, blazer, overcoat];
    const bans: CandidateBans = { pairs: new Set([pairKeyOf(top.id, blazer.id)]), disliked: new Set() };
    const sets = anchorSets(top, items, bans);
    expect(sets.some((set) => set.ids.includes(blazer.id))).toBe(false);
    expect(sets.some((set) => set.ids.includes(overcoat.id))).toBe(true);
    expect(sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perAnchor);
    // The overcoat's own list still has valid pairings with it.
    expect(anchorSets(overcoat, items, bans).length).toBeGreaterThan(0);
  });
  it('keep a bare look and a formal one when two add-on looks saturate the only base (bans leave one formal jacket per shoe)', () => {
    counter = 1;
    const dressed = { seasons: allSeasons };
    const top = make('top', { formality: 3, colours: ['navy'], ...dressed }), trousers = make('bottom', { formality: 4, colours: ['navy'], ...dressed });
    const navyShoes = make('footwear', { formality: null, colours: ['navy'], ...dressed }), greyShoes = make('footwear', { formality: null, colours: ['grey'], ...dressed });
    const jackets = [make('outerwear', { ...formal, warmth: 2, ...dressed }), make('outerwear', { ...formal, colours: ['grey'], warmth: 2, ...dressed }), make('outerwear', { ...formal, colours: ['black'], warmth: 2, ...dressed })];
    const items = [top, trousers, navyShoes, greyShoes, ...jackets];
    const bans: CandidateBans = { pairs: new Set([pairKeyOf(top.id, jackets[0]!.id), pairKeyOf(navyShoes.id, jackets[1]!.id)]), disliked: new Set() };
    const sets = anchorSets(top, items, bans);
    expect(sets.some((set) => !set.addOn)).toBe(true);
    expect(sets.some((set) => set.addOn && set.ids.some((entry) => jackets.some((jacket) => jacket.id === entry)))).toBe(true);
    expect(sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
  });
  it('keep a bare look and the formal one when casual add-ons would take both places of the base', () => {
    counter = 1;
    const top = make('top', { ...casual, colours: ['navy'] }), trousers = make('bottom', { ...casual, colours: ['grey'] }), shoes = make('footwear', { ...casual, colours: ['white'] });
    const hoodies = [make('layer', { ...casual, colours: ['grey'], favourite: true, seasons: allSeasons }), make('layer', { ...casual, colours: ['black'], favourite: true, seasons: allSeasons })];
    const blazer = make('layer', { ...formal, seasons: allSeasons });
    const sets = anchorSets(top, [top, trousers, shoes, ...hoodies, blazer], none);
    expect(sets.some((set) => !set.addOn)).toBe(true);
    expect(sets.some((set) => set.ids.includes(blazer.id))).toBe(true);
    expect(sets.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
  });
  it('change nothing for a wardrobe with no formal layer or jacket', () => {
    counter = 1;
    const items = [make('top', casual), make('top', casual), ...Array.from({ length: 4 }, () => make('bottom', casual)), make('footwear', casual),
      make('layer', { ...casual, seasons: allSeasons }), make('outerwear', { ...casual, warmth: 2 })];
    const sets = anchorSets(items[0]!, items, none);
    expect(sets).toHaveLength(CANDIDATE_LIMITS.perAnchor);
    expect(sets.every((set) => valid(set.ids, items))).toBe(true);
  });
});

describe('candidate quality rules (OUTFITGEN-QUALITY1)', () => {
  const look = (ids: readonly string[], items: readonly CandidateItem[]) => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return ids.filter((entry) => byId.get(entry)!.category !== 'footwear').sort().join('|');
  };
  const baseOf = (ids: readonly string[], items: readonly CandidateItem[]) => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return ids.filter((entry) => ['top', 'bottom', 'one_piece'].includes(byId.get(entry)!.category)).sort().join('|');
  };
  it('treat sets that differ only by footwear as one idea, and still vary the shoes from look to look', () => {
    const items = wardrobe(3, 6, 4, 2, 3);
    const sets = anchorSets(items[0]!, items, none);
    expect(sets.length).toBe(CANDIDATE_LIMITS.perAnchor);
    expect(new Set(sets.map((set) => look(set.ids, items))).size).toBe(sets.length);
    const shoes = new Set(sets.flatMap((set) => set.ids.filter((entry) => items.find((item) => item.id === entry)!.category === 'footwear')));
    expect(shoes.size).toBeGreaterThanOrEqual(2);
  });
  it('picks the better-scoring shoe when the scores really differ', () => {
    counter = 1;
    const top = make('top', { colours: ['navy'], pattern: 'striped' }), bottom = make('bottom', { colours: ['navy'], pattern: 'checked' });
    const plain = make('footwear', { colours: ['white'] }), loud = make('footwear', { colours: ['red'], pattern: 'floral' });
    const sets = anchorSets(top, [top, bottom, plain, loud], none);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.ids).toContain(plain.id);
    expect(sets[0]!.ids).not.toContain(loud.id);
  });
  it('offer at most two looks of one top and bottoms to an anchor while other bases are available', () => {
    const items = wardrobe(2, 8, 2, 2, 4);
    const sets = anchorSets(items[0]!, items, none);
    expect(sets).toHaveLength(CANDIDATE_LIMITS.perAnchor);
    const perBase = new Map<string, number>();
    for (const set of sets) perBase.set(baseOf(set.ids, items), (perBase.get(baseOf(set.ids, items)) ?? 0) + 1);
    expect(Math.max(...perBase.values())).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
    expect(perBase.size).toBeGreaterThanOrEqual(Math.ceil(CANDIDATE_LIMITS.perAnchor / CANDIDATE_LIMITS.perBase));
    expect(sets.every((set) => set.base === baseOf(set.ids, items))).toBe(true);
  });
  it('keep the base cap in a small wardrobe and return fewer sets rather than a third look of one base', () => {
    const items = wardrobe(1, 1, 1, 0, 3);
    const sets = anchorSets(items[0]!, items, none);
    expect(sets).toHaveLength(CANDIDATE_LIMITS.perBase);
    expect(new Set(sets.map((set) => set.base)).size).toBe(1);
  });
  it('spread a short list over every base that exists, never over-filling one while another is unused (the swap and the fill keep the cap)', () => {
    counter = 1;
    const top = make('top'), bottoms = [make('bottom', { colours: ['navy'] }), make('bottom', { colours: ['brown'] }), make('bottom', { colours: ['grey'] })];
    const shoes = make('footwear');
    const jackets = [make('outerwear', { favourite: true }), make('outerwear', { favourite: true })];
    const items = [top, ...bottoms, shoes, ...jackets];
    const sets = anchorSets(top, items, none);
    const perBase = new Map<string, number>();
    for (const set of sets) perBase.set(set.base, (perBase.get(set.base) ?? 0) + 1);
    expect(Math.max(...perBase.values())).toBeLessThanOrEqual(CANDIDATE_LIMITS.perBase);
    expect(perBase.size).toBe(3);
    expect(sets).toHaveLength(CANDIDATE_LIMITS.perAnchor);
    expect(sets.some((set) => !set.addOn) && sets.some((set) => set.addOn)).toBe(true);
  });
  it('rank a short bottom under a warm jacket, and a jacket out of season, below the same outfit without the clash', () => {
    const top = make('top', { seasons: ['spring', 'summer', 'autumn'] }), shoes = make('footwear', { seasons: ['spring', 'summer', 'autumn'] });
    const trousers = make('bottom', { seasons: ['spring', 'summer', 'autumn'], garmentLength: 'regular' });
    const shorts = make('bottom', { seasons: ['spring', 'summer', 'autumn'], garmentLength: 'short' });
    const bomber = make('outerwear', { seasons: ['spring', 'summer', 'autumn'], warmth: 3 });
    expect(softScore([top, shorts, shoes, bomber])).toBeLessThan(softScore([top, trousers, shoes, bomber]));
    expect(softScore([top, shorts, shoes])).toBe(softScore([top, trousers, shoes]));
    const parka = make('outerwear', { seasons: ['winter'], warmth: 3 });
    expect(softScore([top, trousers, shoes, parka])).toBeLessThan(softScore([top, trousers, shoes, bomber]));
    // A short bottom under a light jacket is not a clash.
    const shell = make('outerwear', { seasons: ['spring', 'summer', 'autumn'], warmth: 1 });
    expect(softScore([top, shorts, shoes, shell])).toBe(softScore([top, trousers, shoes, shell]));
  });
  it('does not look at what was judged or seen: an anchor list is the same whatever the owner has done', async () => {
    const items = withBytes(wardrobe(6, 6, 3, 2, 3));
    const first = anchorSets(items[0]!, items, none);
    const batch = await buildBatch({ items, anchors: [items[0]!.id], known: new Set(), bans: none });
    expect(batch.sets.length).toBeGreaterThan(0);
    expect(batch.sets.map((set) => set.key).every((key) => first.some((set) => set.key === key))).toBe(true);
    const again = await buildBatch({ items, anchors: [items[0]!.id], known: new Set(batch.sets.map((set) => set.signature)), bans: none });
    expect(again.sets.some((set) => batch.sets.some((done) => done.signature === set.signature))).toBe(false);
  });
});
