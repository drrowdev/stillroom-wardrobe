import { categories, categoryKeys, type WardrobeItem } from '../../domain/wardrobe';
import { colours } from '../../domain/preferences';
import { availability, lifecycle, seasons } from '../../domain/garment-fields';
import { occasionOptions } from '../../domain/item-details';
import { type Language, type MessageKey, type Translate } from '../../i18n';
import { colourLabel, ordinal, type Facets } from './search';

export type FacetKey = 'category' | 'colour' | 'season' | 'formality' | 'availability' | 'lifecycle';
export type FacetGroup = { key: FacetKey; label: string; options: (readonly [code: string, label: string])[] };
export type FacetChip = { group: FacetKey | 'favourite'; code: string; label: string };
export const favouriteChoices = ['all', 'yes', 'no'] as const;
export const favouriteKey = (code: Facets['favourite']): MessageKey => code === 'all' ? 'wardrobe.allFavourites' : code === 'yes' ? 'item.yes' : 'item.no';

// The filter sheet and the active-filter chips share these groups, options and labels, so the two cannot drift apart.
export function facetGroups(items: readonly WardrobeItem[], language: Language, t: Translate): FacetGroup[] {
  const freeColours = [...new Set(items.flatMap(item => item.colours))]
    .filter(code => code !== 'unknown' && !colours.some(colour => colour === code)).sort(ordinal);
  const colourOptions = [...colours, 'unknown', ...freeColours];
  return [
    { key: 'category', label: t('item.category'), options: categories.map(code => [code, t(categoryKeys[code])] as const) },
    { key: 'colour', label: t('item.colour'), options: colourOptions.map(code => [code, colourLabel(code, language)] as const) },
    { key: 'season', label: t('item.season'), options: seasons.map(code => [code, t(`season.${code}`)] as const) },
    { key: 'formality', label: t('item.formality'), options: [...occasionOptions.map(([code, key]) => [code, t(key)] as const), ['unknown', t('item.unknown')] as const] },
    { key: 'availability', label: t('item.availability'), options: availability.map(code => [code, t(`availability.${code}`)] as const) },
    { key: 'lifecycle', label: t('item.status'), options: lifecycle.map(code => [code, t(`lifecycle.${code}`)] as const) },
  ];
}

// Values that only make sense with their group name ("3", "Ready", "Not specified") carry it as a prefix.
const prefixed = (group: FacetKey, code: string) => group === 'formality' || group === 'availability' || code === 'unknown';

// One chip per active value, in the sheet's group and option order whatever the order of selection. A selected value
// that is no longer offered (a free colour whose last item was deleted) still filters, so it is shown last in its group.
export function facetChips(groups: readonly FacetGroup[], facets: Facets, language: Language, t: Translate): FacetChip[] {
  const chips: FacetChip[] = [];
  for (const group of groups) {
    const selected = facets[group.key];
    const listed = group.options.filter(([code]) => selected.includes(code));
    const stale = selected.filter(code => !group.options.some(([option]) => option === code));
    for (const [code, label] of [...listed, ...stale.map(code => [code, group.key === 'colour' ? colourLabel(code, language) : code] as const)]) {
      chips.push({ group: group.key, code, label: prefixed(group.key, code) ? t('wardrobe.facetValue', { group: group.label, value: label }) : label });
    }
  }
  if (facets.favourite !== 'all') {
    chips.push({ group: 'favourite', code: facets.favourite, label: t('wardrobe.facetValue', { group: t('item.favourite'), value: t(favouriteKey(facets.favourite)) }) });
  }
  return chips;
}

// Exactly what unticking the box (or choosing "All items" for Favourite) does.
export function withoutChip(facets: Facets, chip: Pick<FacetChip, 'group' | 'code'>): Facets {
  if (chip.group === 'favourite') return { ...facets, favourite: 'all' };
  return { ...facets, [chip.group]: facets[chip.group].filter(entry => entry !== chip.code) };
}

export function toggled(facets: Facets, group: FacetKey, code: string, checked: boolean): Facets {
  const selected = facets[group];
  return { ...facets, [group]: checked ? [...selected, code] : selected.filter(entry => entry !== code) };
}
