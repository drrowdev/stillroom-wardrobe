import { describe, expect, it } from 'vitest';
import { featuredStart, next, reconcile, transitionToken, weatherRunId, type Featured } from '../../src/features/today/featured';
import { recommend, type EngineContext, type EngineItem } from '../../src/domain/recommendations';
import type { Category } from '../../src/domain/wardrobe';

const owner = '11111111-1111-4111-8111-111111111111';
let serial = 0;
function item(category: Category, colours: string[]): EngineItem {
  serial++;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`, ownerId: owner, category, colours,
    seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 1, warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null,
    rainRating: null, windproof: null, favourite: false, availability: 'ready', lifecycle: 'active', excludeSuggestions: false, deleted: false,
  };
}
const context: EngineContext = { ownerId: owner, occasion: 'everyday', season: 'summer' };
const tones = ['white', 'black', 'navy', 'grey', 'beige', 'blue', 'green'];
const wardrobe = [
  ...tones.map(tone => item('top', [tone])), ...['navy', 'black', 'beige'].map(tone => item('bottom', [tone])), item('footwear', ['white']), item('footwear', ['black']),
];
const token = transitionToken(0, 'everyday', 'summer', 'null');
const pin = (keys: readonly string[], state: Featured) => reconcile(keys, state);

// Walks Today the way the screen does: Show another inside a page, then the next page with the whole page's core keys skipped.
function walk(pages: number) {
  const skip = new Set<string>();
  const shown: string[] = [];
  let page = 0;
  let result = recommend({ items: wardrobe, context, skip });
  let state = pin(result.suggestions.map(s => s.key), featuredStart(token)).state;
  for (;;) {
    const keys = result.suggestions.map(s => s.key);
    const view = reconcile(keys, state);
    if (view.shown.kind === 'idea') shown.push(view.shown.key);
    const following = next(keys, view.state);
    if (following !== 'page') { state = following; continue; }
    if (++page === pages) break;
    for (const s of result.suggestions) skip.add(s.coreKey);
    result = recommend({ items: wardrobe, context, skip: new Set(skip) });
    if (result.status !== 'ideas') break;
    state = featuredStart(transitionToken(page, 'everyday', 'summer', 'null'), state.number + 1);
  }
  return shown;
}

describe('featured idea on Today', () => {
  it('walks exactly the engine page order across three pages, deterministically', () => {
    const expected: string[] = [];
    const skip = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const result = recommend({ items: wardrobe, context, skip: new Set(skip) });
      expect(result.status).toBe('ideas');
      expected.push(...result.suggestions.map(s => s.key));
      for (const s of result.suggestions) skip.add(s.coreKey);
    }
    expect(expected).toHaveLength(9);
    expect(walk(3)).toEqual(expected);
    expect(walk(3)).toEqual(walk(3));
  });

  it('features nothing before it is armed, then pins the first idea', () => {
    const idle = featuredStart(token, 1, false);
    const early = reconcile(['a', 'b'], idle);
    expect(early.state).toBe(idle);
    expect(early.shown).toEqual({ kind: 'idea', key: 'a', number: 1 });
    const armed = reconcile(['a', 'b'], featuredStart(token));
    expect(armed.state.current).toBe('a');
    expect(armed.shown).toEqual({ kind: 'idea', key: 'a', number: 1 });
  });

  it('keeps the current idea when an earlier one disappears or the order changes', () => {
    let state = reconcile(['a', 'b', 'c'], featuredStart(token)).state;
    state = next(['a', 'b', 'c'], state) as Featured;
    expect(state.current).toBe('b');
    const dropped = reconcile(['b', 'c'], state);
    expect(dropped.state).toBe(state);
    expect(dropped.shown).toEqual({ kind: 'idea', key: 'b', number: 2 });
    const reordered = reconcile(['c', 'd', 'b'], state);
    expect(reordered.shown).toEqual({ kind: 'idea', key: 'b', number: 2 });
    expect(next(['c', 'd', 'b'], state)).toMatchObject({ current: 'c', number: 3, seen: ['a', 'b'] });
  });

  it('shows the first unseen idea when the current one disappears, and is gone when none is left', () => {
    let state = reconcile(['a', 'b', 'c'], featuredStart(token)).state;
    state = next(['a', 'b', 'c'], state) as Featured;
    const moved = reconcile(['a', 'c'], state);
    expect(moved.shown).toEqual({ kind: 'idea', key: 'c', number: 2 });
    expect(moved.state.seen).toEqual(['a', 'b']);
    const gone = reconcile(['a'], state);
    expect(gone.shown).toEqual({ kind: 'gone' });
    expect(gone.state.seen).toEqual(['a']);
    expect(next(['a'], state)).toBe('page');
  });

  it('keeps a hidden idea featured: it stays in the list as a collapsed card', () => {
    const state = reconcile(['a', 'b'], featuredStart(token)).state;
    expect(reconcile(['a', 'b'], state).shown).toEqual({ kind: 'idea', key: 'a', number: 1 });
  });

  it('asks for the next page at the end of a page and starts again on a new token', () => {
    let state = reconcile(['a', 'b'], featuredStart(token)).state;
    state = next(['a', 'b'], state) as Featured;
    expect(next(['a', 'b'], state)).toBe('page');
    const fresh = featuredStart(transitionToken(1, 'everyday', 'summer', 'null'), state.number + 1);
    expect(reconcile(['c', 'd'], fresh).shown).toEqual({ kind: 'idea', key: 'c', number: 3 });
  });

  it('changes the transition token only for paging, occasion, season or applied weather', () => {
    const weather = weatherRunId({});
    const base = transitionToken(0, 'everyday', 'summer', weather);
    expect(transitionToken(0, 'everyday', 'summer', weatherRunId({}))).toBe(base);
    expect(transitionToken(1, 'everyday', 'summer', weather)).not.toBe(base);
    expect(transitionToken(0, 'business', 'summer', weather)).not.toBe(base);
    expect(transitionToken(0, 'everyday', 'winter', weather)).not.toBe(base);
    expect(transitionToken(0, 'everyday', 'summer', weatherRunId({ setting: 'indoors' }))).not.toBe(base);
  });

  it('builds the weather id from the same fields as useSuggestions', () => {
    expect(weatherRunId({ setting: 'outdoors', temperatureC: 4, rainProbability: 60, windMetresPerSecond: 9 })).toBe(JSON.stringify(['outdoors', 4, 60, 9]));
    expect(weatherRunId({})).toBe(JSON.stringify([null, null, null, null]));
  });
});
