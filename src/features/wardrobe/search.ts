import { categoryKeys, type WardrobeItem } from '../../domain/wardrobe';
import { colours } from '../../domain/preferences';
import { locales, translate, type Language } from '../../i18n';
import type { WearHistory } from '../../data/wear-history';
import { AppError } from '../../data/errors';
import { canonicalPrice } from '../../i18n/format';

export const sorts = ['newest', 'name', 'leastWorn', 'lastWorn', 'price'] as const;
export type WardrobeSort = typeof sorts[number];
export type Facets = {
  category: string[]; colour: string[]; season: string[]; formality: string[];
  availability: string[]; lifecycle: string[]; favourite: 'all' | 'yes' | 'no';
};
export const emptyFacets = (): Facets => ({
  category: [], colour: [], season: [], formality: [], availability: [], lifecycle: [], favourite: 'all',
});
export const wearSort = (sort: WardrobeSort): boolean => sort === 'leastWorn' || sort === 'lastWorn';
export const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function colourLabel(code: string, language: Language): string {
  const known = colours.find(colour => colour === code);
  return known ? translate(language, `colour.${known}`) : code === 'unknown' ? translate(language, 'colour.unknown') : code;
}
function fold(text: string, language: Language): string { return text.normalize('NFC').toLocaleLowerCase(locales[language]); }
export function searchIndex(item: WardrobeItem, language: Language): string {
  const labels = item.colours.length ? item.colours.map(colour => colourLabel(colour, language)) : [colourLabel('unknown', language)];
  return fold([item.title, item.brand ?? '', ...item.tags, translate(language, categoryKeys[item.category]), ...labels].join('\n'), language);
}
export function filterItems(items: readonly WardrobeItem[], query: string, facets: Facets, language: Language): WardrobeItem[] {
  const terms = fold(query.slice(0, 512), language).trim().split(/\s+/).filter(Boolean);
  const matches = (selected: readonly string[], values: readonly string[]) => !selected.length || selected.some(value => values.includes(value));
  return items.filter(item => {
    const index = searchIndex(item, language);
    return terms.every(term => index.includes(term))
    && matches(facets.category, [item.category])
    && matches(facets.colour, item.colours.length ? item.colours : ['unknown'])
    && matches(facets.season, item.seasons)
    && matches(facets.formality, [item.formality === null ? 'unknown' : String(item.formality)])
    && matches(facets.availability, [item.availability]) && matches(facets.lifecycle, [item.lifecycle])
    && (facets.favourite === 'all' || item.favourite === (facets.favourite === 'yes'));
  });
}
export function sortItems(items: readonly WardrobeItem[], sort: WardrobeSort, language: Language, history: WearHistory | null = null): WardrobeItem[] {
  if (sort === 'newest') return [...items];
  if (wearSort(sort) && (!history || items.some(item => item.ownerId !== history.ownerId || !history.items.has(item.id)))) {
    throw new AppError('wardrobe.historyUnavailable');
  }
  const collator = new Intl.Collator(locales[language]);
  const cents = (value: string) => Number(canonicalPrice(value).replace('.', ''));
  const amounts = new Map<string, number>();
  if (sort === 'price') {
    for (const item of items) if (item.purchasePrice !== null) amounts.set(item.id, cents(item.purchasePrice));
  }
  return [...items].sort((a, b) => {
    let order = 0;
    if (sort === 'name') order = collator.compare(a.title.normalize('NFC'), b.title.normalize('NFC'));
    else if (sort === 'price') {
      order = a.purchasePrice === null ? b.purchasePrice === null ? 0 : 1 : b.purchasePrice === null ? -1
        : ordinal(a.currency, b.currency) || amounts.get(a.id)! - amounts.get(b.id)!;
    } else {
      const left = history!.items.get(a.id)!, right = history!.items.get(b.id)!;
      order = sort === 'leastWorn' ? left.count - right.count : ordinal(right.lastWorn ?? '', left.lastWorn ?? '');
    }
    return order || ordinal(a.id, b.id);
  });
}
