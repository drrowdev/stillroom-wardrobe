import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { Language, Translate } from '../../i18n';
import type { WardrobeItem } from '../../domain/wardrobe';
import { emptyFacets, type Facets } from './search';
import { facetChips, facetGroups, withoutChip } from './facet-labels';

type Props = { items: readonly WardrobeItem[]; value: Facets; onChange: (value: Facets) => void; filters: RefObject<HTMLButtonElement | null>; language: Language; t: Translate };
// The active filters, each removable. Part of the Filters sheet's chunk: filters can only be set from the sheet.
// After a removal focus moves to the next chip, else the previous one, else Filters.
export function FilterChips({ items, value, onChange, filters, language, t }: Props) {
  const groups = useMemo(() => facetGroups(items, language, t), [items, language, t]);
  const chips = facetChips(groups, value, language, t);
  const list = useRef<HTMLUListElement>(null);
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = pending.current;
    if (index === null) return;
    pending.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('.filter-chip');
    (buttons?.[index] ?? filters.current)?.focus();
  });
  if (!chips.length) return null;
  return <div className="filter-chips">
    <ul ref={list} aria-label={t('wardrobe.activeFilters')}>
      {chips.map((chip, index) => <li key={`${chip.group}:${chip.code}`}>
        <button type="button" className="filter-chip" aria-label={t('wardrobe.removeFilter', { filter: chip.label })} onClick={() => {
          // The chips unmount with the last filter, so focus moves to Filters first.
          if (chips.length === 1) filters.current?.focus();
          else pending.current = index < chips.length - 1 ? index : index - 1;
          onChange(withoutChip(value, chip));
        }}><span>{chip.label}</span><span aria-hidden="true" className="filter-chip-remove">×</span></button>
      </li>)}
    </ul>
    <button type="button" className="text-button" onClick={() => { filters.current?.focus(); onChange(emptyFacets()); }}>{t('common.clearFilters')}</button>
  </div>;
}
