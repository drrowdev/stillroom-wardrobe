import { describe, expect, it } from 'vitest';
import { buildStatistics, costPerWear, costTable, wearSummaries, type StatisticsItem, type WearDay } from '../../src/domain/statistics';
import { summarizeWear } from '../../src/data/wear-history';
import { costPerWearText, lastWornText, wearCountText } from '../../src/features/statistics/wear-text';
import { translate, type Language, type MessageKey } from '../../src/i18n';

const owner = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const worn = (itemId: string | null, localDate: string, extra: Partial<WearDay> = {}): WearDay => ({ itemId, localDate, state: 'worn', deleted: false, ...extra });
const item = (n: number, extra: Partial<StatisticsItem> = {}): StatisticsItem => ({
  id: id(n), title: `Item ${n}`, lifecycle: 'active', purchasePrice: null, currency: 'EUR', ...extra,
});

describe('I13 wear counts (R08)', () => {
  it('counts distinct local days: two looks on one day count once, plans and removed looks never count', () => {
    const summaries = wearSummaries([id(1), id(2)], [
      worn(id(1), '2026-09-01'), worn(id(1), '2026-09-01'), worn(id(1), '2026-09-03'),
      worn(id(1), '2026-09-09', { state: 'planned' }), worn(id(1), '2026-09-10', { deleted: true }),
      worn(null, '2026-09-11'), worn(id(99), '2026-09-12'),
    ]);
    expect(summaries.get(id(1))).toEqual({ count: 2, lastWorn: '2026-09-03' });
    expect(summaries.get(id(2))).toEqual({ count: 0, lastWorn: null });
    expect(summaries.has(id(99))).toBe(false);
  });
  it('orders last worn by the stored date string, not by insertion order', () => {
    expect(wearSummaries([id(1)], [worn(id(1), '2026-12-31'), worn(id(1), '2026-02-01')]).get(id(1))?.lastWorn).toBe('2026-12-31');
  });
  it('rejects an invalid stored date instead of counting it', () => {
    for (const localDate of ['2026-02-30', '2026-9-1', '0000-01-01', '']) expect(() => wearSummaries([id(1)], [worn(id(1), localDate)])).toThrow();
  });
  it('is the same count the wardrobe sorts use', () => {
    const rows = ['2026-09-01', '2026-09-01', '2026-09-04'].map((date, n) => ({
      id: id(100 + n), owner_id: owner, item_id: id(1), event_id: id(1000 + n),
      event: { id: id(1000 + n), owner_id: owner, local_date: date, state: 'worn', deleted_at: null },
    }));
    const history = summarizeWear(rows, { ownerId: owner, epoch: 1 }, [{ id: id(1), ownerId: owner }]);
    expect(history.items.get(id(1))).toEqual(wearSummaries([id(1)], rows.map(row => worn(id(1), row.event.local_date))).get(id(1)));
    expect(history.items.get(id(1))).toEqual({ count: 2, lastWorn: '2026-09-04' });
  });
});

describe('I13 cost per wear (R08)', () => {
  it('divides the stored price by the counted days without rounding', () => {
    expect(costPerWear('100.00', 3)).toBeCloseTo(33.333333, 5);
    expect(costPerWear('0.00', 2)).toBe(0);
    expect(costPerWear('19.99', 1)).toBe(19.99);
  });
  it('has no value for an unknown price or an item not worn yet', () => {
    expect(costPerWear(null, 4)).toBeNull();
    expect(costPerWear('50.00', 0)).toBeNull();
  });
  it('rejects a price that is not a stored two-decimal amount', () => {
    for (const price of ['1e3', '12.5', '-1.00', 'NaN']) expect(() => costPerWear(price, 1)).toThrow();
  });
  it('keeps currencies apart and never combines them', () => {
    const items = [item(1, { purchasePrice: '60.00', currency: 'EUR' }), item(2, { purchasePrice: '90.00', currency: 'USD' }),
      item(3, { purchasePrice: '30.00', currency: 'EUR' }), item(4), item(5, { purchasePrice: '10.00', currency: 'SEK' })];
    const stats = buildStatistics(items, wearSummaries(items.map(row => row.id), [
      worn(id(1), '2026-09-01'), worn(id(1), '2026-09-02'), worn(id(2), '2026-09-01'), worn(id(4), '2026-09-01'),
    ]));
    expect(stats.currencies).toEqual(['EUR', 'SEK', 'USD']);
    expect(stats.unpriced).toBe(1);
    const eur = costTable(stats, 'EUR');
    expect(eur.map(row => [row.id, row.currency, row.costPerWear])).toEqual([[id(1), 'EUR', 30], [id(3), 'EUR', null]]);
    expect(costTable(stats, 'USD').map(row => [row.id, row.costPerWear])).toEqual([[id(2), 90]]);
    expect(costTable(stats, 'SEK').map(row => [row.id, row.costPerWear])).toEqual([[id(5), null]]);
    expect(costTable(stats, 'GBP')).toEqual([]);
    expect(Object.keys(stats).some(key => /total/i.test(key))).toBe(false);
  });
  it('rounds only for display, in the item currency and the chosen language', () => {
    expect(costPerWearText('100.00', 3, 'EUR', 'fi')).toBe(new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR' }).format(33.33));
    expect(costPerWearText('0.00', 2, 'USD', 'en')).toBe(new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD' }).format(0));
  });
  it('rounds once, to each currency\'s own minor units, from the exact quotient', () => {
    const amount = (text: string) => text.replace(/[^\d.]/g, '');
    expect(costPerWearText('2.01', 2, 'EUR', 'en')).toBe('€1.01');
    expect(amount(costPerWearText('1.00', 3, 'KWD', 'en'))).toBe('0.333');
    expect(amount(costPerWearText('100.00', 201, 'JPY', 'en'))).toBe('0');
    expect(amount(costPerWearText('0.03', 2, 'EUR', 'en'))).toBe('0.02');
    for (const [price, count] of [['1e3', 1], ['1.00', 0], ['1.00', 1.5]] as const) expect(() => costPerWearText(price, count, 'EUR', 'en')).toThrow();
  });
});

describe('I13 lists', () => {
  const items = [
    item(1, { title: 'Coat' }), item(2, { title: 'Shirt' }), item(3, { title: 'Jeans' }), item(4, { title: 'Scarf' }),
    item(5, { title: 'Old dress', lifecycle: 'archived' }), item(6, { title: 'Boots' }),
  ];
  const stats = buildStatistics(items, wearSummaries(items.map(row => row.id), [
    worn(id(1), '2026-09-01'), worn(id(1), '2026-09-02'), worn(id(1), '2026-09-03'),
    worn(id(2), '2026-09-01'), worn(id(2), '2026-09-05'), worn(id(3), '2026-09-04'), worn(id(5), '2026-09-01'),
  ]));
  it('ranks active items by distinct days, and lists active items not worn yet', () => {
    expect(stats.mostWorn.map(row => row.title)).toEqual(['Coat', 'Shirt', 'Jeans']);
    expect(stats.leastWorn).toEqual([]);
    expect(stats.unworn.map(row => row.title)).toEqual(['Boots', 'Scarf']);
  });
  it('keeps an archived item history in the table but not in the lists', () => {
    expect(stats.items.find(row => row.id === id(5))).toMatchObject({ active: false, count: 1 });
    expect([...stats.mostWorn, ...stats.unworn].some(row => row.id === id(5))).toBe(false);
  });
  it('shows least worn without repeating the most worn', () => {
    const many = Array.from({ length: 8 }, (_, n) => item(n + 1));
    const days = many.flatMap((row, n) => Array.from({ length: n + 1 }, (_, day) => worn(row.id, `2026-09-${String(day + 1).padStart(2, '0')}`)));
    const ranked = buildStatistics(many, wearSummaries(many.map(row => row.id), days));
    expect(ranked.mostWorn.map(row => row.count)).toEqual([8, 7, 6, 5, 4]);
    expect(ranked.leastWorn.map(row => row.count)).toEqual([1, 2, 3]);
  });
});

describe('I13 wording', () => {
  const t = (language: Language) => (key: MessageKey, parameters?: Record<string, string | number>) => translate(language, key, parameters);
  it('says "Not worn yet" at zero and pluralizes in each language', () => {
    expect(wearCountText(0, 'en', t('en'))).toBe('Not worn yet');
    expect(wearCountText(1, 'en', t('en'))).toBe('1 wear');
    expect(wearCountText(3, 'fi', t('fi'))).toBe('3 käyttökertaa');
    expect(wearCountText(1, 'sv', t('sv'))).toBe('1 användning');
  });
  it('shows the stored local date as the same calendar day', () => {
    expect(lastWornText('2026-09-01', 'en', t('en'))).toBe(`Last worn ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-09-01T12:00:00Z'))}`);
    expect(lastWornText('2026-12-31', 'fi', t('fi'))).toContain('2026');
    expect(lastWornText('2026-12-31', 'fi', t('fi'))).toContain('31');
  });
});
