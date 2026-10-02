import { describe, expect, it } from 'vitest';
import type { GarmentValues } from '../../src/domain/garment-fields';
import { itemFacts } from '../../src/features/wardrobe/item-facts';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n/all';

const t = (language: Language) => (key: MessageKey, parameters?: Record<string, string | number>) => translate(language, key, parameters);

const base: GarmentValues = {
  title: 'Blue shirt', category: 'top', subcategory: null, colours: [], pattern: null, sleeve_length: null, garment_length: null,
  brand: null, size_label: null, material: null, seasons: [], formality: null, warmth: null, min_temp: null, max_temp: null,
  rain_rating: null, windproof: null, upper_coverage: null, lower_coverage: null, style_tags: [], tags: [], purchase_date: null,
  purchase_price: null, notes: '', currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active',
  exclude_suggestions: false, wear_more: false,
};

describe('item view facts', () => {
  it('always shows category, colours and seasons, and nothing else for a bare item', () => {
    for (const language of languages) {
      const facts = itemFacts(base, language, t(language));
      expect(facts.map((fact) => fact.field)).toEqual(['category', 'colours', 'seasons']);
      expect(facts[0]?.value).toBe(translate(language, 'categoryOne.top'));
      expect(facts[1]?.value).toBe(translate(language, 'item.notSet'));
      expect(facts[2]?.value).toBe(translate(language, 'item.notSet'));
    }
  });

  it('adds only the optional fields that have a value, in form order, with translated labels', () => {
    const values: GarmentValues = {
      ...base, colours: ['navy', 'white'], seasons: ['summer'], subcategory: 'Oxford', pattern: 'striped', brand: 'Acme',
      size_label: 'M', material: 'Cotton', formality: 2, warmth: 1, purchase_price: '49.90', purchase_date: '2026-03-04',
      tags: ['work'], style_tags: ['smart'], notes: 'Iron low', favourite: true,
    };
    const facts = itemFacts(values, 'en', t('en'));
    expect(facts.map((fact) => fact.field)).toEqual([
      'category', 'colours', 'seasons', 'subcategory', 'pattern', 'brand', 'size_label', 'material', 'formality', 'warmth',
      'purchase_price', 'purchase_date', 'tags', 'notes', 'status',
    ]);
    const value = (field: string) => facts.find((fact) => fact.field === field)?.value;
    expect(value('colours')).toBe(`${translate('en', 'colour.navy')}, ${translate('en', 'colour.white')}`);
    expect(value('seasons')).toBe(translate('en', 'season.summer'));
    expect(value('pattern')).toBe(translate('en', 'pattern.striped'));
    expect(value('warmth')).toBe(translate('en', 'warmth.light'));
    expect(value('purchase_price')).toMatch(/49[.,]90/);
    expect(value('purchase_date')).toMatch(/2026/);
    expect(value('tags')).toBe('work, smart');
    expect(value('status')).toBe(translate('en', 'item.favourite'));
    expect(facts.find((fact) => fact.field === 'brand')?.label).toBe(translate('en', 'item.brand'));
  });

  it('skips blank text and shows legacy or unknown stored values as they are', () => {
    const values = {
      ...base, category: 'cape', colours: ['unknown', 'mauve'], seasons: ['monsoon'], pattern: 'plaid', brand: '  ', notes: '',
      formality: 9, warmth: 7, purchase_price: 'abc', currency: 'ZZZ', purchase_date: 'not-a-date',
    } as unknown as GarmentValues;
    const facts = itemFacts(values, 'fi', t('fi'));
    const value = (field: string) => facts.find((fact) => fact.field === field)?.value;
    expect(value('category')).toBe('cape');
    expect(value('colours')).toBe(`${translate('fi', 'colour.unknown')}, mauve`);
    expect(value('seasons')).toBe('monsoon');
    expect(value('pattern')).toBe('plaid');
    expect(value('formality')).toBe('9');
    expect(value('warmth')).toBe('7');
    expect(value('purchase_price')).toBeTruthy();
    expect(value('purchase_date')).toBeTruthy();
    expect(facts.some((fact) => fact.field === 'brand' || fact.field === 'notes')).toBe(false);
  });

  it('names a lifecycle other than active next to Favourite', () => {
    const facts = itemFacts({ ...base, favourite: true, lifecycle: 'archived' }, 'sv', t('sv'));
    expect(facts.at(-1)).toEqual({
      field: 'status', label: translate('sv', 'item.status'),
      value: `${translate('sv', 'item.favourite')}, ${translate('sv', 'lifecycle.archived')}`,
    });
  });
});
