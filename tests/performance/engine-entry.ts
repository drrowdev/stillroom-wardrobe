import { colours } from '../../src/domain/preferences';
import { occasions } from '../../src/domain/outfits';
import { recommend, type EngineContext, type EngineItem } from '../../src/domain/recommendations';
import { categories, type Category } from '../../src/domain/wardrobe';

// Bundled into an IIFE by the performance global setup, so the engine runs in the browser under CPU throttling.
const owner = '11111111-1111-4111-8111-111111111111';

// Seeded PRNG so every run and machine sees the same 500-item catalog (as in recommendations-properties.test.ts).
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function catalog(seed: number, size: number): EngineItem[] {
  const next = random(seed);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');
  return Array.from({ length: size }, () => ({
    id: `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`, ownerId: owner, category: pick(categories) as Category,
    colours: [pick([...colours, 'unknown'])], seasons: ['spring', 'summer', 'autumn', 'winter'].filter(() => next() < 0.6),
    formality: next() < 0.2 ? null : Math.floor(next() * 5), warmth: next() < 0.5 ? null : Math.floor(next() * 5),
    lowerCoverage: next() < 0.5 ? null : Math.floor(next() * 3), minTemp: null, maxTemp: null,
    rainRating: next() < 0.5 ? null : Math.floor(next() * 3), windproof: next() < 0.5 ? null : next() < 0.5,
    favourite: next() < 0.2, availability: next() < 0.9 ? 'ready' : 'laundry', lifecycle: next() < 0.95 ? 'active' : 'archived',
    excludeSuggestions: next() < 0.05, deleted: next() < 0.05,
  }));
}

const items = catalog(7, 500);
const contexts: EngineContext[] = [
  ...occasions.flatMap((occasion) => (['spring', 'summer', 'autumn', 'winter'] as const).map((season) => ({ ownerId: owner, occasion, season }))),
  { ownerId: owner, occasion: 'everyday', season: 'winter', setting: 'outdoors', temperatureC: -8, rainProbability: 0.8, windMetresPerSecond: 12 },
  { ownerId: owner, occasion: 'business', season: 'autumn', setting: 'outdoors', temperatureC: 6, rainProbability: 0.9, windMetresPerSecond: 3 },
  { ownerId: owner, occasion: 'smart', season: 'summer', setting: 'outdoors', temperatureC: 27, rainProbability: 0.1, windMetresPerSecond: 1 },
];

/** Times one recommend() call per context, the first one cold, and returns milliseconds per call. */
export function timeAll(): { items: number; timings: Array<{ context: string; ms: number; status: string }> } {
  const timings = contexts.map((context) => {
    const start = performance.now();
    const result = recommend({ items, context });
    const ms = performance.now() - start;
    if (result.suggestions.length === 0) throw new Error(`No ideas for ${context.occasion}/${context.season}`);
    return { context: `${context.occasion}/${context.season}${context.setting ? '/outdoors' : ''}`, ms, status: result.status };
  });
  return { items: items.length, timings };
}
