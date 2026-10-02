import { describe, expect, it } from 'vitest';
import { languages, translate, type Language, type Translate } from '../../src/i18n/all';
import type { WardrobeItem } from '../../src/domain/wardrobe';
import { emptyFacets, filterItems, type Facets } from '../../src/features/wardrobe/search';
import { facetChips, facetGroups, toggled, withoutChip } from '../../src/features/wardrobe/facet-labels';

const tr = (language: Language): Translate => (key, parameters) => translate(language, key, parameters);
const items = (colours: string[][]) => colours.map(list => ({ colours: list }) as unknown as WardrobeItem);
const setup = (language: Language = 'en', colours: string[][] = [['olive'], ['teal-ish'], ['amber-ish']]) => {
  const t = tr(language);
  const groups = facetGroups(items(colours), language, t);
  return { t, groups, chips: (facets: Facets) => facetChips(groups, facets, language, t) };
};

describe('facet groups', () => {
  it('keep the filter groups, option order and free colours (sorted, after the fixed colours)', () => {
    const { groups } = setup();
    expect(groups.map(group => group.key)).toEqual(['category', 'colour', 'season', 'formality', 'availability', 'lifecycle']);
    const colourCodes = groups[1]!.options.map(([code]) => code);
    expect(colourCodes.slice(-3)).toEqual(['unknown', 'amber-ish', 'teal-ish']);
    expect(groups[3]!.options.map(([code]) => code)).toEqual(['0', '1', '2', '3', '4', 'unknown']);
  });
});

describe('active-filter chips', () => {
  it('follow the group and option order whatever order the values were chosen in', () => {
    const { chips } = setup();
    let facets = emptyFacets();
    for (const [group, code] of [['season', 'winter'], ['category', 'footwear'], ['colour', 'olive'], ['category', 'top'], ['season', 'spring']] as const) {
      facets = toggled(facets, group, code, true);
    }
    expect(chips(facets).map(chip => `${chip.group}:${chip.code}`)).toEqual(['category:top', 'category:footwear', 'colour:olive', 'season:spring', 'season:winter']);
  });

  it('show a selected value that is no longer offered last in its group, with the colour label', () => {
    const { chips } = setup('en', [['olive']]);
    const facets = { ...emptyFacets(), colour: ['gone-colour', 'olive'] };
    expect(chips(facets).map(chip => chip.label)).toEqual([translate('en', 'colour.olive'), 'gone-colour']);
  });

  it('prefix values that need their group: dress code, availability, favourite and unknown', () => {
    const { chips } = setup();
    const facets: Facets = { ...emptyFacets(), category: ['top'], colour: ['unknown'], formality: ['3', 'unknown'], availability: ['ready'], lifecycle: ['archived'], favourite: 'yes' };
    const en = (key: Parameters<Translate>[0]) => translate('en', key);
    const pair = (group: Parameters<Translate>[0], value: string) => `${en(group)}: ${value}`;
    expect(chips(facets).map(chip => chip.label)).toEqual([
      en('category.top'), pair('item.colour', en('colour.unknown')), pair('item.formality', '3'), pair('item.formality', en('item.unknown')),
      pair('item.availability', en('availability.ready')), en('lifecycle.archived'), pair('item.favourite', en('item.yes')),
    ]);
    expect(chips({ ...emptyFacets(), favourite: 'no' }).map(chip => chip.label)).toEqual([`${translate('en', 'item.favourite')}: ${translate('en', 'item.no')}`]);
    expect(chips(emptyFacets())).toEqual([]);
  });

  it('removing a chip is exactly unticking its box, and gives the same results', () => {
    const { chips } = setup();
    const facets: Facets = { ...emptyFacets(), category: ['top', 'bottom'], colour: ['olive', 'gone'], season: ['winter'], favourite: 'yes' };
    for (const chip of chips(facets)) {
      const expected = chip.group === 'favourite' ? { ...facets, favourite: 'all' as const } : toggled(facets, chip.group, chip.code, false);
      expect(withoutChip(facets, chip)).toEqual(expected);
    }
    const pool = [
      { colours: ['olive'], category: 'top', seasons: ['winter'], favourite: true },
      { colours: ['navy'], category: 'bottom', seasons: [], favourite: false },
    ].map((item, index) => ({ id: String(index), title: `Item ${index}`, brand: null, tags: [], formality: null, availability: 'ready', lifecycle: 'active', ...item }) as unknown as WardrobeItem);
    const chip = chips(facets).find(entry => entry.group === 'favourite')!;
    expect(filterItems(pool, '', withoutChip(facets, chip), 'en')).toEqual(filterItems(pool, '', { ...facets, favourite: 'all' }, 'en'));
  });
});

describe('new filter copy', () => {
  it('has every language, with the plural forms and placeholders', () => {
    for (const language of languages) {
      expect(translate(language, 'wardrobe.showItems_one', { count: '1' })).toContain('1');
      expect(translate(language, 'wardrobe.showItems_other', { count: '5' })).toContain('5');
      expect(translate(language, 'wardrobe.removeFilter', { filter: 'X' })).toContain('X');
      expect(translate(language, 'wardrobe.facetValue', { group: 'G', value: 'V' })).toBe('G: V');
      expect(translate(language, 'wardrobe.filtersActive', { count: '2' })).toContain('(2)');
    }
  });
});
