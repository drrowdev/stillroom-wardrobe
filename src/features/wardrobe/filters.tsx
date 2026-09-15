import { categories, categoryKeys, type WardrobeItem } from '../../domain/wardrobe';
import { colours } from '../../domain/preferences';
import { availability, lifecycle, seasons } from '../../domain/garment-fields';
import { locales, type Language, type Translate } from '../../i18n';
import { colourLabel, ordinal, type Facets } from './search';

type Props = { items: readonly WardrobeItem[]; value: Facets; onChange: (value: Facets) => void; language: Language; t: Translate };
export function WardrobeFilters({ items, value, onChange, language, t }: Props) {
  const freeColours = [...new Set(items.flatMap(item => item.colours))]
    .filter(code => code !== 'unknown' && !colours.some(colour => colour === code)).sort(ordinal);
  const colourOptions = [...colours, 'unknown', ...freeColours];
  const groups = [
    { key: 'category', label: t('item.category'), options: categories.map(code => [code, t(categoryKeys[code])] as const) },
    { key: 'colour', label: t('item.colour'), options: colourOptions.map(code => [code, colourLabel(code, language)] as const) },
    { key: 'season', label: t('item.season'), options: seasons.map(code => [code, t(`season.${code}`)] as const) },
    { key: 'formality', label: t('item.formality'), options: [...Array.from({ length: 5 }, (_, number) => [String(number), new Intl.NumberFormat(locales[language]).format(number)] as const), ['unknown', t('item.unknown')] as const] },
    { key: 'availability', label: t('item.availability'), options: availability.map(code => [code, t(`availability.${code}`)] as const) },
    { key: 'lifecycle', label: t('item.status'), options: lifecycle.map(code => [code, t(`lifecycle.${code}`)] as const) },
  ] as const;
  return <details className="wardrobe-filters">
    <summary>{t('common.filters')}</summary>
    <div className="wardrobe-facet-grid">
      {groups.map(group => <fieldset key={group.key}><legend>{group.label}</legend>
        {group.options.map(([code, label]) => <label className="wardrobe-choice" key={code}>
          <input type="checkbox" name={group.key} value={code} checked={value[group.key].includes(code)} onChange={event => {
            const selected = value[group.key];
            onChange({ ...value, [group.key]: event.target.checked ? [...selected, code] : selected.filter(entry => entry !== code) });
          }} /><span>{label}</span>
        </label>)}
      </fieldset>)}
      <fieldset><legend>{t('item.favourite')}</legend>
        {(['all', 'yes', 'no'] as const).map(code => <label className="wardrobe-choice" key={code}>
          <input type="radio" name="favourite" value={code} checked={value.favourite === code} onChange={() => onChange({ ...value, favourite: code })} />
          <span>{t(code === 'all' ? 'wardrobe.allFavourites' : code === 'yes' ? 'item.yes' : 'item.no')}</span>
        </label>)}
      </fieldset>
    </div>
    <button className="text-button" type="button" onClick={() => onChange({ category: [], colour: [], season: [], formality: [], availability: [], lifecycle: [], favourite: 'all' })}>{t('common.clearFilters')}</button>
  </details>;
}
