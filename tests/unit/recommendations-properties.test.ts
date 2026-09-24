import { describe, expect, it } from 'vitest';
import { colours } from '../../src/domain/preferences';
import { combinationKey, limits, pairKey, recommend, type EngineContext, type EngineItem } from '../../src/domain/recommendations';
import { occasions } from '../../src/domain/outfits';
import { categories, type Category } from '../../src/domain/wardrobe';
import { translate, languages } from '../../src/i18n';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

// Seeded PRNG so every run and machine sees the same catalogs.
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function uuid(next: () => number): string {
  const hex = () => Math.floor(next() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`;
}
function catalog(seed: number, size: number, ownerId = owner): EngineItem[] {
  const next = random(seed);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  return Array.from({ length: size }, () => ({
    id: uuid(next), ownerId, category: pick(categories) as Category, colours: [pick([...colours, 'unknown'])],
    seasons: seasons.filter(() => next() < 0.6),
    formality: next() < 0.2 ? null : Math.floor(next() * 5), warmth: next() < 0.5 ? null : Math.floor(next() * 5),
    lowerCoverage: next() < 0.5 ? null : Math.floor(next() * 3), minTemp: null, maxTemp: null, rainRating: null, windproof: null,
    favourite: next() < 0.2, availability: next() < 0.9 ? 'ready' : 'laundry', lifecycle: next() < 0.95 ? 'active' : 'archived',
    excludeSuggestions: next() < 0.05, deleted: next() < 0.05,
  }));
}
const contexts: EngineContext[] = occasions.flatMap(occasion => (['spring', 'summer', 'autumn', 'winter'] as const).map(season => ({ ownerId: owner, occasion, season })));

describe('recommendation properties over seeded catalogs', () => {
  it('holds the hard rules, limits and determinism for every seed and context', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const items = catalog(seed, 10 + seed * 3);
      const byId = new Map(items.map(item => [item.id, item]));
      const next = random(seed * 7);
      const eligibleIds = items.filter(item => item.availability === 'ready' && item.lifecycle === 'active' && !item.deleted && !item.excludeSuggestions).map(item => item.id);
      const excludedPairs = Array.from({ length: 3 }, () => [eligibleIds[Math.floor(next() * eligibleIds.length)]!, eligibleIds[Math.floor(next() * eligibleIds.length)]!] as const)
        .filter(([a, b]) => a !== b);
      for (const context of contexts) {
        const input = { items, context, excludedPairs };
        const result = recommend(input);
        expect(recommend(input)).toEqual(result);
        expect(recommend({ ...input, items: [...items].reverse() })).toEqual(result);
        expect(result.suggestions.length).toBeLessThanOrEqual(limits.suggestions);
        expect(result.expansions).toBeLessThanOrEqual(limits.passBudget * 2);
        const cores = new Set<string>();
        for (const suggestion of result.suggestions) {
          expect(new Set(suggestion.itemIds).size).toBe(suggestion.itemIds.length);
          expect(suggestion.key).toBe(combinationKey(suggestion.itemIds));
          expect(cores.has(suggestion.coreKey)).toBe(false);
          cores.add(suggestion.coreKey);
          const pieces = suggestion.itemIds.map(id => byId.get(id)!);
          for (const piece of pieces) {
            expect(piece.ownerId).toBe(owner);
            expect(piece.availability === 'ready' && piece.lifecycle === 'active' && !piece.deleted && !piece.excludeSuggestions && piece.category !== 'accessory').toBe(true);
          }
          const pairs = new Set(excludedPairs.map(([a, b]) => pairKey(a, b)));
          for (const a of pieces) for (const b of pieces) if (a !== b) expect(pairs.has(pairKey(a.id, b.id))).toBe(false);
          const cats = pieces.map(piece => piece.category);
          if (suggestion.completeness === 'complete') {
            expect(cats.includes('footwear') && (cats.includes('one_piece') || cats.includes('top') && cats.includes('bottom'))).toBe(true);
          }
          if (suggestion.completeness === 'complete' && (context.occasion === 'business' || context.occasion === 'formal')) {
            const target = context.occasion === 'business' ? 3 : 4;
            for (const piece of pieces) if (piece.category !== 'layer' && piece.category !== 'outerwear') expect(piece.formality).toBeGreaterThanOrEqual(target - 1);
          }
        }
        for (let i = 1; i < result.suggestions.length; i++) {
          const [a, b] = [result.suggestions[i - 1]!, result.suggestions[i]!];
          expect(a.score > b.score || a.score === b.score && a.key < b.key).toBe(true);
        }
      }
    }
  }, 30_000);

  it('adding 500 foreign records leaves owned results identical', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const items = catalog(seed, 60);
      const foreign = catalog(seed + 1000, 500, other).map(item => ({ ...item, favourite: true, formality: 2 }));
      for (const context of contexts.slice(0, 8)) {
        expect(recommend({ items: [...foreign, ...items], context })).toEqual(recommend({ items, context }));
      }
    }
  });

  it('language is not an input: rankings are identical whichever language is displayed', () => {
    const items = catalog(42, 80);
    const baseline = recommend({ items, context: contexts[5]! });
    for (const language of languages) {
      expect(translate(language, 'nav.outfits').length).toBeGreaterThan(0);
      expect(recommend({ items, context: contexts[5]! })).toEqual(baseline);
    }
  });

  it('stays within the beam and expansion budget at 500 items', () => {
    const items = catalog(7, 500);
    for (const context of contexts) {
      const result = recommend({ items, context });
      expect(result.passes).toBeLessThanOrEqual(2);
      expect(result.expansions).toBeLessThanOrEqual(limits.passBudget * result.passes);
      expect(result.status).toBe('ideas');
    }
  });
});
