import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pairScore } from '../../src/domain/colour-pairs';
import {
  combinationKey, combinationSignature, combineScore, componentsFor, eligible, limits, recommend, seasonForDate, warmthTarget,
  type EngineContext, type EngineItem,
} from '../../src/domain/recommendations';
import type { Category } from '../../src/domain/wardrobe';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let serial = 0;
function item(category: Category, extra: Partial<EngineItem> = {}): EngineItem {
  serial++;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`, ownerId: owner, category, colours: ['black'],
    seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 1, warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null,
    rainRating: null, windproof: null, favourite: false, availability: 'ready', lifecycle: 'active', excludeSuggestions: false, deleted: false,
    ...extra,
  };
}
const context: EngineContext = { ownerId: owner, occasion: 'everyday', season: 'summer' };
function basic() {
  return { top: item('top', { colours: ['white'] }), bottom: item('bottom', { colours: ['navy'] }), shoes: item('footwear') };
}

describe('score arithmetic (blueprint 09 fixtures)', () => {
  it('fixture A is 88.5, B is 67, and A without weather renormalizes to 88', () => {
    const a = { W: 0.9, O: 1, C: 0.9, S: 1, N: 0.8, U: 0.7, F: 0.5, P: 1 };
    const b = { W: 0.7, O: 0.95, C: 0.8, S: 0.6, N: 0.2, U: 0.3, F: 1, P: 0.5 };
    expect(combineScore(a)).toBeCloseTo(88.5, 10);
    expect(combineScore(b)).toBeCloseTo(67, 10);
    expect(combineScore(a)).toBeGreaterThan(combineScore(b));
    expect(combineScore({ ...a, W: undefined })).toBeCloseTo(88, 10);
  });

  it('computes the active v1 components for a known outfit', () => {
    const { top, bottom, shoes } = basic();
    const favourite = { ...top, favourite: true };
    const parts = componentsFor([favourite, bottom, shoes], context, new Set());
    expect(parts).toEqual({ W: 1, O: 1, C: 1, F: 1 / 3, P: 0.5 });
    expect(parts.S).toBeUndefined(); expect(parts.N).toBeUndefined(); expect(parts.U).toBeUndefined();
    const liked = componentsFor([top, bottom, shoes], context, new Set([combinationKey([top.id, bottom.id, shoes.id])]));
    expect(liked.P).toBe(0.75);
  });

  it('drops unknown formality from the occasion component and deactivates it when nothing is known', () => {
    const top = item('top', { formality: 3 }), bottom = item('bottom', { formality: null }), shoes = item('footwear', { formality: null });
    expect(componentsFor([top, bottom, shoes], { ...context, occasion: 'business' }, new Set()).O).toBe(1);
    expect(componentsFor([top, bottom, shoes], { ...context, occasion: 'everyday' }, new Set()).O).toBe(0);
    const unknown = componentsFor([{ ...top, formality: null }, bottom, shoes], context, new Set());
    expect('O' in unknown).toBe(false);
  });

  it('uses season fit alone without a temperature, and warmth fit only when every clothing warmth is known', () => {
    const top = item('top', { seasons: ['summer'], warmth: 1 }), bottom = item('bottom', { seasons: ['winter'], warmth: 1 }), shoes = item('footwear');
    expect(componentsFor([top, bottom, shoes], context, new Set()).W).toBe(0.5);
    // Warmth 2 against a target of 3 at 20 °C: (1 − 1/6) × 0.9 + 0.5 × 0.1.
    expect(componentsFor([top, bottom, shoes], { ...context, temperatureC: 20 }, new Set()).W).toBeCloseTo((5 / 6) * 0.9 + 0.05, 10);
    expect(componentsFor([top, { ...bottom, warmth: null }, shoes], { ...context, temperatureC: 20 }, new Set()).W).toBe(0.5);
    expect([30, 20, 12, 5, 0].map(warmthTarget)).toEqual([1, 3, 6, 10, 14]);
  });
});

describe('colour pairs', () => {
  it('scores neutrals, identical hues, adjacent hues, other pairs and unknowns, in either order', () => {
    expect(pairScore('navy', 'orange')).toBe(1);
    expect(pairScore('beige', 'khaki')).toBe(1);
    expect(pairScore('red', 'red')).toBe(0.8);
    expect(pairScore('teal', 'green')).toBe(0.85);
    expect(pairScore('green', 'teal')).toBe(0.85);
    expect(pairScore('pink', 'green')).toBe(0.6);
    expect(pairScore('unknown', 'red')).toBe(0.5);
    expect(pairScore('mauve', 'black')).toBe(0.5);
  });
});

describe('keys, signatures and seasons', () => {
  it('sorts and deduplicates IDs, and the signature matches the SQL formula', async () => {
    const ids = ['b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'];
    expect(combinationKey([...ids, ids[0]!])).toBe(`${ids[1]}|${ids[0]}`);
    const expected = createHash('sha256').update(`${ids[1]}|${ids[0]}`, 'utf8').digest('hex');
    expect(await combinationSignature(ids)).toBe(expected);
    expect(await combinationSignature([...ids].reverse())).toBe(expected);
  });

  it('maps dates to northern-hemisphere seasons', () => {
    expect(['2026-03-01', '2026-05-31', '2026-06-01', '2026-09-24', '2026-12-01', '2027-02-28'].map(seasonForDate))
      .toEqual(['spring', 'spring', 'summer', 'autumn', 'winter', 'winter']);
  });
});

describe('eligibility and hard rules', () => {
  it('never suggests laundry, archived, trashed, excluded, accessory or foreign items, even favourites', () => {
    const { top, bottom, shoes } = basic();
    const hidden = [
      item('top', { availability: 'laundry', favourite: true }), item('top', { lifecycle: 'archived', favourite: true }),
      item('top', { deleted: true, favourite: true }), item('top', { excludeSuggestions: true, favourite: true }),
      item('top', { ownerId: other, favourite: true }), item('accessory', { favourite: true }),
    ];
    for (const hide of hidden) expect(eligible(hide, context)).toBe(false);
    const result = recommend({ items: [...hidden, top, bottom, shoes], context });
    expect(result.status).toBe('ideas');
    expect(result.suggestions.map(s => s.itemIds)).toEqual([[top.id, bottom.id, shoes.id]]);
  });

  it('rejects an exact disliked combination even when it would score highest', () => {
    const { top, bottom, shoes } = basic();
    const plain = item('top', { colours: ['pink'], seasons: ['winter'], formality: 4 });
    const input = { items: [top, bottom, shoes, plain], context };
    expect(recommend(input).suggestions[0]!.itemIds).toContain(top.id);
    const result = recommend({ ...input, feedback: [{ itemIds: [shoes.id, top.id, bottom.id], vote: -1 as const }] });
    expect(result.suggestions.map(s => s.key)).toEqual([combinationKey([plain.id, bottom.id, shoes.id])]);
  });

  it('never combines a canonical excluded pair', () => {
    const { top, bottom, shoes } = basic();
    const second = item('bottom', { colours: ['pink'] });
    const result = recommend({ items: [top, bottom, shoes, second], context, excludedPairs: [[bottom.id, top.id]] });
    expect(result.suggestions.map(s => s.itemIds)).toEqual([[top.id, second.id, shoes.id]]);
  });

  it('ignores feedback that refers to items outside the current catalog', () => {
    const { top, bottom, shoes } = basic();
    const foreign = '99999999-9999-4999-8999-999999999999';
    const result = recommend({ items: [top, bottom, shoes], context, feedback: [{ itemIds: [top.id, foreign], vote: -1 }] });
    expect(result.suggestions).toHaveLength(1);
  });

  it('business and formal need every core piece within one step and a median at the target; unknown formality is named', () => {
    const business = { ...context, occasion: 'business' as const };
    const top = item('top', { formality: 3 }), bottom = item('bottom', { formality: 3 }), shoes = item('footwear', { formality: 2 });
    expect(recommend({ items: [top, bottom, shoes], context: business }).status).toBe('ideas');
    const low = recommend({ items: [top, bottom, { ...shoes, formality: 1 }], context: business });
    expect(low.status).toBe('none');
    const median = recommend({ items: [{ ...top, formality: 2 }, bottom, shoes], context: business });
    expect(median.status).toBe('none');
    const unknown = recommend({ items: [top, bottom, { ...shoes, formality: null }], context: business });
    expect(unknown.status).toBe('none');
    expect(unknown.missingDetails).toEqual(['formality']);
    expect(recommend({ items: [top, bottom, { ...shoes, formality: null }], context }).status).toBe('ideas');
  });
});

describe('templates, partial and empty results', () => {
  it('returns empty with no eligible clothes', () => {
    expect(recommend({ items: [], context }).status).toBe('empty');
    expect(recommend({ items: [item('accessory'), item('top', { availability: 'laundry' })], context }).status).toBe('empty');
  });

  it('offers a lone top as a partial start and names the missing categories', () => {
    const top = item('top');
    const result = recommend({ items: [top], context });
    expect(result.status).toBe('partial');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ itemIds: [top.id], completeness: 'partial', missingSlots: ['bottom', 'footwear'] });
  });

  it('never repeats a disliked or already shown partial start, and moves on to another piece', () => {
    const top = item('top');
    expect(recommend({ items: [top], context, feedback: [{ itemIds: [top.id], vote: -1 }] }).status).toBe('none');
    expect(recommend({ items: [top], context, skip: new Set([combinationKey([top.id])]) }).status).toBe('none');
    const second = item('top', { colours: ['green'] });
    const first = recommend({ items: [top, second], context }).suggestions[0]!;
    const shown = new Set([first.coreKey]);
    const next = recommend({ items: [top, second], context, skip: shown });
    expect(next.status).toBe('partial');
    expect(next.suggestions[0]!.itemIds).not.toEqual(first.itemIds);
    shown.add(next.suggestions[0]!.coreKey);
    expect(recommend({ items: [top, second], context, skip: shown }).status).toBe('none');
    const disliked = recommend({ items: [top, second], context, feedback: [{ itemIds: first.itemIds, vote: -1 }] });
    expect(disliked.suggestions[0]!.itemIds).not.toEqual(first.itemIds);
  });

  it('retries a partial start past the first eight pieces before reporting none', () => {
    const tops = Array.from({ length: 9 }, () => item('top'));
    const skip = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const result = recommend({ items: tops, context, skip });
      expect(result.status).toBe('partial');
      skip.add(result.suggestions[0]!.coreKey);
    }
    const ninth = recommend({ items: tops, context, skip });
    expect(ninth.status).toBe('partial');
    expect(ninth.passes).toBe(2);
    expect(skip.has(ninth.suggestions[0]!.coreKey)).toBe(false);
    const feedback = [...skip].map(key => ({ itemIds: [key], vote: -1 as const }));
    expect(recommend({ items: tops, context, feedback }).suggestions[0]!.coreKey).toBe(ninth.suggestions[0]!.coreKey);
    skip.add(ninth.suggestions[0]!.coreKey);
    expect(recommend({ items: tops, context, skip }).status).toBe('none');
  });

  it('prefers the template with the most pieces for a partial result', () => {
    const dress = item('one_piece');
    expect(recommend({ items: [dress], context }).suggestions[0]!.missingSlots).toEqual(['footwear']);
    const shoes = item('footwear');
    expect(recommend({ items: [shoes], context }).suggestions[0]!.missingSlots).toEqual(['top', 'bottom']);
  });

  it('shows one result for one complete outfit and never invents variety', () => {
    const { top, bottom, shoes } = basic();
    const result = recommend({ items: [top, bottom, shoes], context });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ completeness: 'complete', missingSlots: [], rulesVersion: 'rules-v1' });
  });

  it('fills a one-piece template without a separate top or bottom', () => {
    const dress = item('one_piece', { colours: ['red'] }), shoes = item('footwear');
    const result = recommend({ items: [dress, shoes], context });
    expect(result.suggestions.map(s => s.itemIds)).toEqual([[dress.id, shoes.id]]);
    expect('C' in result.suggestions[0]!.components).toBe(false);
  });

  it('adds a layer only in autumn or winter and only when it improves the outfit', () => {
    const { top, bottom, shoes } = basic();
    const cardigan = item('layer', { seasons: ['autumn'] });
    expect(recommend({ items: [top, bottom, shoes, cardigan], context }).suggestions[0]!.itemIds).not.toContain(cardigan.id);
    const autumn = { ...context, season: 'autumn' as const };
    const summerItems = [{ ...top, seasons: ['summer'] }, { ...bottom, seasons: ['summer'] }, shoes];
    expect(recommend({ items: [...summerItems, cardigan], context: autumn }).suggestions[0]!.itemIds).toEqual([top.id, bottom.id, cardigan.id, shoes.id]);
    expect(recommend({ items: [top, bottom, shoes, cardigan], context: autumn }).suggestions[0]!.itemIds).not.toContain(cardigan.id);
    // A disliked core stays a seed: adding an improving layer makes a different, allowed combination.
    const seeded = recommend({ items: [...summerItems, cardigan], context: autumn, feedback: [{ itemIds: [top.id, bottom.id, shoes.id], vote: -1 }] });
    expect(seeded.suggestions.map(s => s.itemIds)).toEqual([[top.id, bottom.id, cardigan.id, shoes.id]]);
    const both = recommend({ items: [...summerItems, cardigan], context: autumn, feedback: [
      { itemIds: [top.id, bottom.id, shoes.id], vote: -1 }, { itemIds: [top.id, bottom.id, cardigan.id, shoes.id], vote: -1 }] });
    expect(both.status).toBe('none');
  });

  it('never forces a coat on a cold day indoors', () => {
    const { top, bottom, shoes } = basic();
    const coat = item('outerwear', { seasons: ['winter'], warmth: 4 });
    const result = recommend({ items: [top, bottom, shoes, coat], context: { ...context, setting: 'indoors', temperatureC: -5 } });
    expect(result.suggestions[0]!.completeness).toBe('complete');
    expect(result.suggestions[0]!.itemIds).not.toContain(coat.id);
  });
});

describe('weather rules stay inactive without weather and apply when it is supplied', () => {
  const cold: EngineContext = { ...context, season: 'winter', setting: 'outdoors', temperatureC: 0 };
  it('cold outdoors requires outerwear and ankle coverage, and names unknown coverage', () => {
    const top = item('top'), jeans = item('bottom', { lowerCoverage: 2 }), shorts = item('bottom', { lowerCoverage: 0 }), shoes = item('footwear');
    const coat = item('outerwear');
    const result = recommend({ items: [top, jeans, shorts, shoes, coat], context: cold });
    expect(result.suggestions.map(s => s.itemIds)).toEqual([[top.id, jeans.id, coat.id, shoes.id]]);
    const unknown = recommend({ items: [top, { ...jeans, lowerCoverage: null }, shoes, coat], context: cold });
    expect(unknown.suggestions[0]).toMatchObject({ completeness: 'partial', missingDetails: ['coverage'] });
    const noCoat = recommend({ items: [top, jeans, shoes], context: cold });
    expect(noCoat.suggestions[0]).toMatchObject({ completeness: 'partial', missingSlots: ['outerwear'] });
  });

  it('rain and wind need a protective layer or outerwear; unknown protection is named, never assumed', () => {
    const { top, bottom, shoes } = basic();
    const rainy: EngineContext = { ...context, setting: 'outdoors', rainProbability: 80 };
    const shell = item('layer', { rainRating: 1 }), plain = item('outerwear', { rainRating: 0 });
    expect(recommend({ items: [top, bottom, shoes, shell, plain], context: rainy }).suggestions[0]!.itemIds).toContain(shell.id);
    const unknown = recommend({ items: [top, bottom, shoes, { ...plain, rainRating: null }], context: rainy });
    expect(unknown.suggestions[0]).toMatchObject({ completeness: 'partial', missingSlots: ['outerwear'], missingDetails: ['rain'] });
    const windy = recommend({ items: [top, bottom, shoes, item('layer', { windproof: null })], context: { ...context, setting: 'outdoors', windMetresPerSecond: 12 } });
    expect(windy.missingDetails).toEqual(['wind']);
    expect(recommend({ items: [top, bottom, shoes], context: { ...rainy, setting: 'indoors' } }).suggestions[0]!.completeness).toBe('complete');
  });

  it('honours explicit temperature limits outdoors only', () => {
    const { top, bottom, shoes } = basic();
    const warmTop = item('top', { maxTemp: 10, colours: ['red'] });
    const hot = { ...context, setting: 'outdoors' as const, temperatureC: 28 };
    expect(recommend({ items: [warmTop, bottom, shoes], context: hot }).status).toBe('partial');
    expect(recommend({ items: [warmTop, bottom, shoes], context: { ...hot, setting: 'indoors' } }).status).toBe('ideas');
    expect(recommend({ items: [top, bottom, shoes], context: hot }).status).toBe('ideas');
  });
});

describe('ranking, diversity and paging', () => {
  function wardrobe() {
    const tops = [item('top', { colours: ['white'] }), item('top', { colours: ['pink'] }), item('top', { colours: ['green'] })];
    const bottoms = [item('bottom', { colours: ['navy'] }), item('bottom', { colours: ['red'] })];
    const shoes = [item('footwear'), item('footwear', { colours: ['brown'] })];
    return [...tops, ...bottoms, ...shoes];
  }

  it('returns at most three ideas, each differing in at least one core item, ordered by score then key', () => {
    const result = recommend({ items: wardrobe(), context });
    expect(result.suggestions).toHaveLength(limits.suggestions);
    const cores = result.suggestions.map(s => s.coreKey);
    expect(new Set(cores).size).toBe(3);
    for (let i = 1; i < result.suggestions.length; i++) {
      const [a, b] = [result.suggestions[i - 1]!, result.suggestions[i]!];
      expect(a.score > b.score || a.score === b.score && a.key < b.key).toBe(true);
    }
  });

  it('prefers two differences between ideas when the wardrobe allows it', () => {
    const cores = recommend({ items: wardrobe(), context }).suggestions.map(s => s.coreKey.split('|'));
    for (const a of cores) for (const b of cores) if (a !== b) expect(a.filter(id => !b.includes(id)).length).toBeGreaterThanOrEqual(2);
  });

  it('skips shown ideas for the next page and reports none when exhausted', () => {
    const items = wardrobe();
    const shown = new Set<string>();
    const pages: string[][] = [];
    for (let page = 0; page < 10; page++) {
      const result = recommend({ items, context, skip: shown });
      if (result.status === 'none') break;
      pages.push(result.suggestions.map(s => s.coreKey));
      for (const s of result.suggestions) shown.add(s.coreKey);
    }
    expect(pages.flat()).toHaveLength(3 * 2 * 2);
    expect(new Set(pages.flat()).size).toBe(12);
  });

  function large() {
    const colours = ['white', 'pink', 'green', 'navy', 'red', 'brown'] as const;
    return [
      ...colours.slice(0, 3).map(colour => item('top', { colours: [colour] })),
      ...colours.slice(3).map(colour => item('bottom', { colours: [colour] })),
      ...colours.map(colour => item('footwear', { colours: [colour] })),
    ];
  }

  it('pages through every one of more than 40 combinations before reporting none', () => {
    const items = large();
    const shown = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const result = recommend({ items, context, skip: shown });
      if (result.status === 'none') break;
      for (const s of result.suggestions) shown.add(s.coreKey);
    }
    expect(shown.size).toBe(3 * 3 * 6);
  });

  it('keeps disliked cores out of the result beam even when an added coat would not improve them', () => {
    const autumn: EngineContext = { ...context, season: 'autumn' };
    const items = [
      ...Array.from({ length: 3 }, () => item('top')), ...Array.from({ length: 3 }, () => item('bottom')),
      ...Array.from({ length: 6 }, () => item('footwear')), item('outerwear'),
    ];
    const ranked: string[] = [];
    const shown = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const result = recommend({ items, context: autumn, skip: shown });
      if (result.status === 'none') break;
      for (const s of result.suggestions) { shown.add(s.coreKey); ranked.push(s.key); }
    }
    expect(ranked).toHaveLength(54);
    expect(ranked.every(key => key.split('|').length === 3)).toBe(true);
    const dislikedKeys = ranked.slice(0, 44);
    const result = recommend({ items, context: autumn, feedback: dislikedKeys.map(key => ({ itemIds: key.split('|'), vote: -1 as const })) });
    expect(result.status).toBe('ideas');
    for (const s of result.suggestions) expect(dislikedKeys).not.toContain(s.key);
  });

  it.each(['summer', 'autumn', 'winter'] as const)('still finds ideas in %s when more than 40 of the combinations are disliked', season => {
    const seasonal: EngineContext = { ...context, season };
    const items = large();
    const ranked: string[] = [];
    const shown = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const result = recommend({ items, context: seasonal, skip: shown });
      if (result.status === 'none') break;
      for (const s of result.suggestions) { shown.add(s.coreKey); ranked.push(s.key); }
    }
    expect(ranked).toHaveLength(54);
    const dislikedKeys = ranked.slice(0, 44);
    const feedback = dislikedKeys.map(key => ({ itemIds: key.split('|'), vote: -1 as const }));
    const result = recommend({ items, context: seasonal, feedback });
    expect(result.status).toBe('ideas');
    for (const s of result.suggestions) expect(dislikedKeys).not.toContain(s.key);
  });

  it('gives reasons as language-neutral keys and parameters', () => {
    const { top, bottom, shoes } = basic();
    const result = recommend({ items: [{ ...top, favourite: true }, bottom, shoes], context });
    expect(result.suggestions[0]!.reasons).toEqual([
      { key: 'season', parameters: { season: 'summer' } }, { key: 'occasion', parameters: { occasion: 'everyday' } },
    ]);
    const liked = recommend({ items: [top, bottom, shoes], context, feedback: [{ itemIds: [top.id, bottom.id, shoes.id], vote: 1 }] });
    expect(liked.suggestions[0]!.components.P).toBe(0.75);
  });

  it('breaks equal scores by item UUID', () => {
    const shoes = item('footwear'), bottom = item('bottom');
    const high = item('top', { id: 'ffffffff-0000-4000-8000-000000000001' }), low = item('top', { id: '00000000-ffff-4000-8000-000000000001' });
    const result = recommend({ items: [high, low, bottom, shoes], context });
    expect(result.suggestions[0]!.itemIds[0]).toBe(low.id);
  });
});
