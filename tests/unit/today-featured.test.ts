import { describe, expect, it } from 'vitest';
import { pageStart, pinPage, restorePinned, transitionToken, weatherRunId } from '../../src/features/today/featured';
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

// Walks Today the way the screen does: every idea of a page together, then Show other ideas with the page's core keys skipped.
function walk(pages: number) {
  const skip = new Set<string>();
  const result: string[][] = [];
  for (let page = 0; page < pages; page++) {
    const found = recommend({ items: wardrobe, context, skip: new Set(skip) });
    if (found.status !== 'ideas') break;
    const keys = found.suggestions.map(s => s.key);
    result.push(pinPage(keys, pageStart(token)).shown as string[]);
    for (const s of found.suggestions) skip.add(s.coreKey);
  }
  return result;
}

describe('the ideas shown together on Today', () => {
  it('shows three ideas a page, none twice across pages, deterministically', () => {
    const pages = walk(3);
    expect(pages.map(page => page.length)).toEqual([3, 3, 3]);
    expect(new Set(pages.flat()).size).toBe(9);
    expect(walk(3)).toEqual(pages);
  });

  it('offers three different outfits: no shared garment set, and no two that differ by one garment only on the first page', () => {
    const found = recommend({ items: wardrobe, context });
    expect(found.suggestions).toHaveLength(3);
    const cores = found.suggestions.map(s => s.coreKey);
    expect(new Set(cores).size).toBe(3);
    for (const [index, first] of found.suggestions.entries()) {
      for (const second of found.suggestions.slice(index + 1)) {
        const apart = first.itemIds.filter(id => !second.itemIds.includes(id)).length;
        expect(apart).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('shows what exists when fewer than three ideas can be made', () => {
    const small = [item('top', ['white']), item('bottom', ['navy']), item('footwear', ['black'])];
    const found = recommend({ items: small, context });
    expect(found.suggestions).toHaveLength(1);
    expect(pinPage(found.suggestions.map(s => s.key), pageStart(token)).shown).toHaveLength(1);
  });
});

describe('the pinned page', () => {
  it('shows what the list holds before it is armed, without pinning', () => {
    const idle = pageStart(token, false);
    const early = pinPage(['a', 'b', 'c'], idle);
    expect(early.state).toBe(idle);
    expect(early.shown).toEqual(['a', 'b', 'c']);
  });

  it('pins the first non-empty list once armed, and nothing while the list is empty', () => {
    const start = pageStart(token);
    const empty = pinPage([], start);
    expect(empty.state).toBe(start);
    expect(empty.shown).toEqual([]);
    const pinned = pinPage(['a', 'b', 'c'], start);
    expect(pinned.state.keys).toEqual(['a', 'b', 'c']);
    expect(pinned.shown).toEqual(['a', 'b', 'c']);
  });

  it('drops a card that leaves the list but never reorders or adds one while another pinned card stays', () => {
    const { state } = pinPage(['a', 'b', 'c'], pageStart(token));
    expect(pinPage(['a', 'c'], state).shown).toEqual(['a', 'c']);
    expect(pinPage(['c', 'd', 'b', 'a'], state).shown).toEqual(['a', 'b', 'c']);
    expect(pinPage(['a', 'b', 'c'], state).state).toBe(state);
  });

  it('pins the ideas not shown before once every pinned idea has gone, and is empty when there are none', () => {
    const { state } = pinPage(['a', 'b', 'c'], pageStart(token));
    const moved = pinPage(['d', 'e'], pinPage(['d', 'e'], state).state);
    expect(moved.shown).toEqual(['d', 'e']);
    const replaced = pinPage(['d', 'e'], state);
    expect(replaced.shown).toEqual(['d', 'e']);
    expect(replaced.state.seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pinPage(['a', 'b'], replaced.state).shown).toEqual([]);
    expect(pinPage([], state).shown).toEqual([]);
  });

  it('brings a dropped card back in its place when it returns to the list', () => {
    const { state } = pinPage(['a', 'b', 'c'], pageStart(token));
    expect(pinPage(['a', 'c'], state).shown).toEqual(['a', 'c']);
    expect(pinPage(['a', 'b', 'c'], state).shown).toEqual(['a', 'b', 'c']);
  });

  it('restores an undone idea into a page a refresh has since replaced, in the slot its place in the list gives it', () => {
    const first = pinPage(['a', 'b', 'c'], pageStart(token)).state;
    // "a" is dismissed, then a refresh leaves only d and e: they are pinned in place of the page.
    const replaced = pinPage(['d', 'e'], first);
    expect(replaced.shown).toEqual(['d', 'e']);
    // Undo brings "a" back to the list; without restoring it the pinned d and e would keep it off the page.
    expect(pinPage(['a', 'd', 'e'], replaced.state).shown).toEqual(['d', 'e']);
    const restored = restorePinned(replaced.state, 'a', ['a', 'd', 'e']);
    expect(pinPage(['a', 'd', 'e'], restored).shown).toEqual(['a', 'd', 'e']);
    expect(restorePinned(replaced.state, 'a', ['d', 'a', 'e']).keys).toEqual(['d', 'a', 'e']);
    expect(restorePinned(replaced.state, 'a', ['d', 'e', 'a']).keys).toEqual(['d', 'e', 'a']);
  });

  it('restores nothing that is already pinned, not in the list, or on a page not yet pinned', () => {
    const { state } = pinPage(['a', 'b'], pageStart(token));
    expect(restorePinned(state, 'a', ['a', 'b'])).toBe(state);
    expect(restorePinned(state, 'z', ['a', 'b'])).toBe(state);
    const start = pageStart(token);
    expect(restorePinned(start, 'a', ['a'])).toBe(start);
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
