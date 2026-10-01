import '../../styles/filter-sheet.css';
import { useMemo } from 'react';
import { translate, locales, type Language, type Translate } from '../../i18n';
import type { WardrobeItem } from '../../domain/wardrobe';
import { emptyFacets, type Facets } from './search';
import { facetGroups, favouriteChoices, favouriteKey, toggled } from './facet-labels';

export { FilterChips } from './filter-chips';

type Props = { items: readonly WardrobeItem[]; value: Facets; onChange: (value: Facets) => void; count: number; onDone: () => void; language: Language; t: Translate };
// The body and footer of the Filters sheet. The dialog, its heading and Close are in the start page (filter-dialog.tsx),
// so the sheet can be named, focused and closed while this part is loading or if it fails to load.
export function FilterSheet({ items, value, onChange, count, onDone, language, t }: Props) {
  const groups = useMemo(() => facetGroups(items, language, t), [items, language, t]);
  const plural = new Intl.PluralRules(locales[language]).select(count);
  const show = translate(language, plural === 'one' ? 'wardrobe.showItems_one' : 'wardrobe.showItems_other', { count: new Intl.NumberFormat(locales[language]).format(count) });
  return <>
    <div className="wardrobe-facet-grid">
      {groups.map(group => <fieldset key={group.key}><legend>{group.label}</legend>
        {group.options.map(([code, label]) => <label className="wardrobe-choice" key={code}>
          <input type="checkbox" name={group.key} value={code} checked={value[group.key].includes(code)} onChange={event => onChange(toggled(value, group.key, code, event.target.checked))} /><span>{label}</span>
        </label>)}
      </fieldset>)}
      <fieldset><legend>{t('item.favourite')}</legend>
        {favouriteChoices.map(code => <label className="wardrobe-choice" key={code}>
          <input type="radio" name="favourite" value={code} checked={value.favourite === code} onChange={() => onChange({ ...value, favourite: code })} />
          <span>{t(favouriteKey(code))}</span>
        </label>)}
      </fieldset>
    </div>
    <div className="filter-sheet-footer">
      <button className="text-button" type="button" onClick={() => onChange(emptyFacets())}>{t('common.clearFilters')}</button>
      <button className="button button-primary" type="button" onClick={onDone}>{show}</button>
    </div>
  </>;
}
