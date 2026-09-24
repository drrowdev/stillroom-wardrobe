import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import { loadWardrobe, parseWardrobeRows, timestampOrder } from '../../src/data/items';
import { emptyFacets, filterItems, ordinal, searchIndex, sortItems } from '../../src/features/wardrobe/search';
import { summarizeWear } from '../../src/data/wear-history';
import type { WardrobeItem } from '../../src/domain/wardrobe';

const owner = '10000000-0000-4000-8000-000000000001';
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(n: number, patch: Partial<WardrobeItem> = {}): WardrobeItem {
  return {
    id: uuid(n), ownerId: owner, title: `Item ${n}`, category: 'top', createdAt: '2026-09-01T00:00:00Z',
    imageId: uuid(n + 1000), mainPath: `${owner}/${uuid(n)}/${uuid(n + 1000)}/main.jpg`,
    thumbPath: `${owner}/${uuid(n)}/${uuid(n + 1000)}/thumb.jpg`, altText: '',
    favourite: false, availability: 'ready', lifecycle: 'active', excludeSuggestions: false,
    brand: null, tags: [], colours: [], seasons: [], formality: null, purchasePrice: null, currency: 'EUR', ...patch,
  };
}
describe('owned wardrobe search and facets', () => {
  const shirt = fixture(1, { title: 'A\u0308ä Ö Å shirt', brand: 'Nordic', tags: ['Soft', 'linen'], colours: ['olive'], seasons: ['winter'], formality: 0, favourite: true });
  it('uses NFC, Nordic case folding, AND terms and current relevant taxonomy only', () => {
    for (const language of ['en', 'fi', 'sv'] as const) {
      expect(filterItems([shirt], '  ÄÄ nordic SOFT ', emptyFacets(), language)).toEqual([shirt]);
      expect(filterItems([shirt], 'aa', emptyFacets(), language)).toEqual([]);
      expect(filterItems([shirt], 'Nordic missing', emptyFacets(), language)).toEqual([]);
    }
    expect(filterItems([shirt], 'yläosat oliivinvihreä', emptyFacets(), 'fi')).toEqual([shirt]);
    expect(filterItems([shirt], 'överdelar olivgrön', emptyFacets(), 'sv')).toEqual([shirt]);
    expect(filterItems([shirt], 'black', emptyFacets(), 'en')).toEqual([]);
    expect(filterItems([shirt], 'tops', emptyFacets(), 'fi')).toEqual([]);
    expect(filterItems([shirt], '  ', emptyFacets(), 'en')).toEqual([shirt]);
    expect(searchIndex(shirt, 'en')).not.toContain(shirt.id);
    expect(filterItems([shirt], 'soft'.padEnd(512, ' ') + 'missing', emptyFacets(), 'en')).toEqual([shirt]);
  });
  it('combines all seven facets, OR within and AND across, without suggestion filtering', () => {
    const item = { ...shirt, availability: 'laundry' as const, lifecycle: 'archived' as const, excludeSuggestions: true };
    const facets = { category: ['top', 'bottom'], colour: ['olive', 'red'], season: ['winter', 'summer'],
      formality: ['0', '4'], availability: ['laundry'], lifecycle: ['archived'], favourite: 'yes' as const };
    expect(filterItems([item], 'linen', facets, 'en')).toEqual([item]);
    for (const key of ['category', 'colour', 'season', 'formality', 'availability', 'lifecycle'] as const) {
      expect(filterItems([item], '', { ...facets, [key]: ['nonmatching'] }, 'en')).toEqual([]);
    }
    expect(filterItems([item], '', { ...facets, favourite: 'no' }, 'en')).toEqual([]);
  });
  it('finds the added colours by their localized names and facet code', () => {
    const coat = fixture(5, { title: 'Coat', category: 'outerwear', colours: ['burgundy', 'light_blue'] });
    expect(filterItems([coat], 'burgundy', emptyFacets(), 'en')).toEqual([coat]);
    expect(filterItems([coat], 'light blue', emptyFacets(), 'en')).toEqual([coat]);
    expect(filterItems([coat], 'viininpunainen', emptyFacets(), 'fi')).toEqual([coat]);
    expect(filterItems([coat], 'vinröd', emptyFacets(), 'sv')).toEqual([coat]);
    expect(filterItems([coat], 'ljusblå', emptyFacets(), 'sv')).toEqual([coat]);
    expect(filterItems([coat], 'light_blue', emptyFacets(), 'en')).toEqual([]);
    expect(filterItems([coat], '', { ...emptyFacets(), colour: ['burgundy'] }, 'en')).toEqual([coat]);
    expect(filterItems([coat], '', { ...emptyFacets(), colour: ['brown'] }, 'en')).toEqual([]);
  });
  it('keeps legacy colour text, duplicates and missing facts separate', () => {
    const unknown = fixture(2), mixed = fixture(3, { colours: ['unknown', 'red'] });
    const legacy = fixture(4, { colours: ['長'.repeat(70)], tags: ['retained', 'retained'] });
    const values = [unknown, mixed, legacy];
    expect(filterItems(values, 'not specified', emptyFacets(), 'en')).toEqual([unknown, mixed]);
    expect(filterItems(values, 'unknown', emptyFacets(), 'en')).toEqual([]);
    expect(filterItems(values, '', { ...emptyFacets(), colour: ['unknown'] }, 'en')).toEqual([unknown, mixed]);
    expect(filterItems(values, '', { ...emptyFacets(), season: ['winter'] }, 'en')).toEqual([]);
    expect(filterItems(values, '', { ...emptyFacets(), formality: ['unknown'] }, 'en')).toEqual(values);
    expect(filterItems(values, '長'.repeat(45), emptyFacets(), 'en')).toEqual([legacy]);
    expect(legacy.tags).toEqual(['retained', 'retained']);
  });
  it('sorts 500 items stably without mutating source; names use the selected locale', () => {
    const items = Array.from({ length: 500 }, (_, n) => fixture(500 - n, { title: 'Same' }));
    const original = [...items];
    expect(sortItems(items, 'newest', 'en')).toEqual(original);
    expect(sortItems(items, 'name', 'fi').map(item => item.id)).toEqual(items.map(item => item.id).sort(ordinal));
    expect(items).toEqual(original);
    const nordic = [fixture(1, { title: 'Ö' }), fixture(2, { title: 'Å' }), fixture(3, { title: 'Z' })];
    expect(sortItems(nordic, 'name', 'sv').map(item => item.title)).toEqual(['Z', 'Å', 'Ö']);
    expect(filterItems(items, 'same', emptyFacets(), 'en')).toHaveLength(500);
  });
  it('keeps zero and finite decimal amounts in their currency and null prices in one trailing UUID group', () => {
    const items = [
      fixture(6, { purchasePrice: null, currency: 'AAA' }), fixture(1, { purchasePrice: null, currency: 'ZZZ' }),
      fixture(4, { purchasePrice: '10.10', currency: 'EUR' }), fixture(3, { purchasePrice: '2.02', currency: 'EUR' }),
      fixture(2, { purchasePrice: '0.00', currency: 'EUR' }), fixture(5, { purchasePrice: '1.00', currency: 'USD' }),
    ];
    expect(sortItems(items, 'price', 'fi').map(item => item.id)).toEqual([2, 3, 4, 5, 1, 6].map(uuid));
    expect(() => sortItems([fixture(1, { purchasePrice: 'NaN' }), fixture(2, { purchasePrice: '0.00' })], 'price', 'en')).toThrow();
    expect(() => sortItems([fixture(1, { purchasePrice: 'NaN' })], 'price', 'en')).toThrow();
  });
  it('wear modes refuse missing snapshots and order zero, count, date and UUID independently', () => {
    const items = [fixture(3), fixture(2), fixture(1)];
    const scope = { ownerId: owner, epoch: 1 };
    const rows = [1, 2, 3].map((n) => ({
      id: uuid(100 + n), owner_id: owner, item_id: uuid(n === 3 ? 2 : 1), event_id: uuid(200 + n),
      event: { id: uuid(200 + n), owner_id: owner, state: 'worn', deleted_at: null, local_date: `2026-09-0${n}` },
    }));
    const history = summarizeWear(rows, scope, items);
    expect(() => sortItems(items, 'leastWorn', 'en')).toThrow();
    expect(sortItems(items, 'leastWorn', 'en', history).map(item => item.id)).toEqual([3, 2, 1].map(uuid));
    expect(sortItems(items, 'lastWorn', 'en', history).map(item => item.id)).toEqual([2, 1, 3].map(uuid));
    expect(() => sortItems([fixture(9)], 'lastWorn', 'en', history)).toThrow();
  });
});

describe('strict paged wardrobe metadata', () => {
  function raw(n: number) {
    const item = fixture(n);
    return { id: item.id, owner_id: owner, title: item.title, category: item.category, created_at: item.createdAt, deleted_at: null,
      favourite: false, availability: 'ready', lifecycle: 'active', exclude_suggestions: false, brand: null, tags: [], colours: [],
      seasons: [], formality: null, purchase_price: null, currency: 'EUR' };
  }
  function image(n: number) {
    const item = fixture(n);
    return { id: item.imageId, owner_id: owner, item_id: item.id, state: 'ready', main_path: item.mainPath, thumb_path: item.thumbPath, alt_text: '' };
  }
  it.each([500, 501])('loads %i complete rows through explicit advancing owner keysets', async count => {
    const requests: URL[] = [];
    const rows = Array.from({ length: count }, (_, n) => raw(count - n));
    const images = Array.from({ length: count }, (_, n) => image(n + 1));
    const client = createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_unit_fixture', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async input => {
        const url = new URL(String(input)); requests.push(url);
        const isItems = url.pathname.endsWith('/items');
        const source = isItems ? rows : images;
        const later = url.searchParams.has(isItems ? 'or' : 'id');
        return new Response(JSON.stringify(source.slice(later ? 500 : 0, later ? 1000 : 500)), { status: 200 });
      } },
    });
    const result = await loadWardrobe(client, { ownerId: owner, epoch: 1, signal: new AbortController().signal });
    expect(result).toHaveLength(count);
    expect(requests).toHaveLength(4);
    expect(requests.every(url => url.searchParams.get('owner_id') === `eq.${owner}` && url.searchParams.get('limit') === '500')).toBe(true);
    expect(requests[1]!.searchParams.get('or')).toContain(`id.lt.${rows[499]!.id}`);
    expect(requests[3]!.searchParams.get('id')).toBe(`gt.${images[499]!.id}`);
  });
  it('rejects nonadvancing pages, invalid shape and invalid dates rather than hanging or reporting empty', async () => {
    let calls = 0;
    const rows = Array.from({ length: 500 }, (_, n) => raw(500 - n));
    const client = createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_unit_fixture', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async () => { calls++; return new Response(JSON.stringify(rows)); } },
    });
    await expect(loadWardrobe(client, { ownerId: owner, epoch: 1, signal: new AbortController().signal })).rejects.toThrow();
    expect(calls).toBe(2);
    expect(() => parseWardrobeRows({}, [], owner)).toThrow();
    expect(() => timestampOrder('2026-02-30T01:00:00Z')).toThrow();
    expect(timestampOrder('2026-09-01T00:00:00.000002Z') > timestampOrder('2026-09-01T00:00:00.000001Z')).toBe(true);
    expect(parseWardrobeRows([], [], owner)).toEqual([]);
    expect(() => parseWardrobeRows([{ ...raw(1), deleted_at: undefined }], [image(1)], owner)).toThrow();
    expect(() => parseWardrobeRows([raw(1)], [{ ...image(1), state: 'invented' }], owner)).toThrow();
    expect(parseWardrobeRows([raw(1)], [], owner)).toEqual([]);
  });
});
