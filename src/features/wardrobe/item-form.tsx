import { useState, type ReactNode } from 'react';
import { colours } from '../../domain/preferences';
import { fieldAssertion, provenanceFields, type FieldProvenance } from '../../domain/attribute-provenance';
import {
  booleanFields, collectionLimits, editGarmentField, enumFields, initialRawFields, integerRanges, seasons, textLimits, validateGarmentDraft,
  type GarmentDraft, type GarmentField, type GarmentValues, type RawFields,
} from '../../domain/garment-fields';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { AiDerivation } from '../../domain/ai-draft';

const labels: Record<GarmentField, MessageKey> = {
  title: 'item.title', category: 'item.category', subcategory: 'item.subcategory', colours: 'item.colour',
  pattern: 'item.pattern', sleeve_length: 'item.sleeveLength', garment_length: 'item.garmentLength',
  brand: 'item.brand', size_label: 'item.size', material: 'item.material', seasons: 'item.season',
  formality: 'item.formality', warmth: 'item.warmth', min_temp: 'item.minTemp', max_temp: 'item.maxTemp',
  rain_rating: 'item.rainRating', windproof: 'item.windproof', upper_coverage: 'item.upperCoverage',
  lower_coverage: 'item.lowerCoverage', style_tags: 'settings.styleTags', tags: 'item.tags',
  purchase_date: 'item.purchaseDate', purchase_price: 'item.price', notes: 'item.notes', currency: 'profile.currency',
  favourite: 'item.favourite', availability: 'item.availability', lifecycle: 'item.status',
  exclude_suggestions: 'item.excludeSuggestions', wear_more: 'suggestion.wearMore',
};
const groups: Array<{ label: MessageKey; fields: GarmentField[] }> = [
  { label: 'item.appearanceGroup', fields: ['subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length', 'brand', 'size_label', 'material'] },
  { label: 'item.comfortGroup', fields: ['seasons', 'formality', 'warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage'] },
  { label: 'item.personalGroup', fields: ['style_tags', 'tags', 'purchase_date', 'purchase_price', 'notes'] },
  { label: 'item.defaultsGroup', fields: ['currency', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more'] },
];
function optionKey(field: string, value: string): MessageKey {
  const prefix = field === 'sleeve_length' ? 'sleeve' : field === 'garment_length' ? 'length' : field;
  return `${prefix}.${value}` as MessageKey;
}
type Props = {
  draft: GarmentDraft; onChange: (draft: GarmentDraft) => void; baseline?: GarmentValues; provenance?: FieldProvenance;
  language: Language; t: Translate; prefix: 'item' | 'detail'; locked: boolean; currency: string;
  showErrors?: boolean; children?: ReactNode;
  aiDerived?: AiDerivation;
};
export function ItemForm({ draft, onChange, baseline, provenance, language, t, prefix, locked, currency, showErrors = false, children, aiDerived }: Props) {
  const [expanded, setExpanded] = useState<Partial<Record<MessageKey, boolean>>>({});
  const { errors } = validateGarmentDraft(draft, baseline);
  const defaults = initialRawFields(currency);
  const number = (value: number) => new Intl.NumberFormat(locales[language]).format(value);
  const change = <K extends GarmentField>(key: K, value: RawFields[K]) => onChange(editGarmentField(draft, key, value, language));
  const field = (key: GarmentField) => {
    const id = `${prefix}-${key}`, label = t(labels[key]), raw = draft.raw[key];
    const invalid = Boolean(errors[key] && (showErrors || draft.intent[key] || prefix === 'detail'));
    const textProps = { readOnly: prefix === 'item' && locked, disabled: prefix === 'detail' && locked };
    const aria = { 'aria-invalid': invalid, 'aria-describedby': invalid ? `${id}-error` : prefix === 'detail' && key === 'title' ? undefined : `${id}-help` };
    const optional = key !== 'title' && key !== 'category' && !['currency', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more'].includes(key);
    const assertion = provenanceFields.find((value) => value === key);
    let control: ReactNode;
    let hint: ReactNode = t('common.optional');
    if (key === 'colours' || key === 'seasons' || key === 'style_tags' || key === 'tags') {
      const values = draft.raw[key];
      const options: readonly string[] | null = key === 'colours' ? [...colours, 'unknown'] : key === 'seasons' ? seasons : null;
      hint = t('item.collectionHint', { count: number(collectionLimits[key]) });
      control = <div id={id} tabIndex={-1} className="garment-collection" {...aria}>
        {values.map((value, index) => <div key={index} className="garment-chip">
          {options ? <span>{options.includes(value) ? t(optionKey(key === 'colours' ? 'colour' : 'season', value)) : value}</span>
            : <input value={value} aria-label={label} {...textProps} {...aria}
              onChange={(event) => change(key, values.map((entry, at) => at === index ? event.target.value : entry))} />}
          <button type="button" className="text-button" disabled={locked} onClick={() => change(key, values.filter((_, at) => at !== index))}
            aria-label={t('item.removeValue', { index: number(index + 1), field: label })}>{t('item.remove')}</button>
        </div>)}
        {options ? <select value="" disabled={locked || values.length >= collectionLimits[key]} aria-label={t('item.addValue', { field: label })}
          onChange={(event) => { if (event.target.value) change(key, [...values, event.target.value]); }}>
          <option value="">{t('item.addValue', { field: label })}</option>
          {options.filter((value) => !values.includes(value)).map((value) => <option key={value} value={value}>{t(optionKey(key === 'colours' ? 'colour' : 'season', value))}</option>)}
        </select> : <button type="button" className="text-button" disabled={locked || values.length >= collectionLimits[key]} onClick={() => change(key, [...values, ''])}>{t('item.addValue', { field: label })}</button>}
      </div>;
    } else if (key in enumFields) {
      const options = enumFields[key as keyof typeof enumFields];
      hint = optional ? t('item.unknown') : t('common.required');
      control = <select id={id} value={raw} disabled={locked} {...aria} onChange={(event) => change(key, event.target.value)}>
        {(optional || key === 'category') && <option value="">{t(optional ? 'item.unknown' : 'capture.selectCategory')}</option>}
        {options.map((value) => <option key={value} value={value}>{t(optionKey(key, value))}</option>)}
      </select>;
    } else if (booleanFields.some((value) => value === key)) {
      hint = optional ? t('item.unknown') : t('common.required');
      control = <select id={id} value={raw} disabled={locked} {...aria} onChange={(event) => change(key, event.target.value)}>
        {optional && <option value="">{t('item.unknown')}</option>}
        <option value="true">{t('item.yes')}</option><option value="false">{t('item.no')}</option>
      </select>;
    } else {
      if (key in textLimits) hint = t('item.textLimit', { count: number(textLimits[key as keyof typeof textLimits]) });
      if (key in integerRanges) {
        const [min, max] = integerRanges[key as keyof typeof integerRanges];
        hint = t('item.numberRange', { min: number(min), max: number(max) });
      }
      if (key === 'purchase_price') hint = t('item.priceHint');
      if (key === 'purchase_date') hint = t('item.dateHint');
      if (key === 'currency') hint = t('settings.invalidCurrency');
      control = key === 'notes' ? <textarea id={id} rows={3} value={raw} {...textProps} {...aria} onChange={(event) => change(key, event.target.value)} />
        : <input id={id} value={raw} {...textProps} {...aria} inputMode={key === 'purchase_price' ? 'decimal' : key in integerRanges ? 'numeric' : 'text'}
          placeholder={key === 'title' && prefix === 'item' ? t('capture.namePlaceholder') : undefined}
          onChange={(event) => change(key, event.target.value)} />;
    }
    return <div className="field garment-field" key={key}>
      {Array.isArray(raw) ? <span className="garment-label">{label}</span> : <label htmlFor={id}>{label}</label>}{control}
      <p id={`${id}-help`} className="fine muted">{hint}</p>
      {invalid && <p id={`${id}-error`} role="alert" className="notice notice-error">{t(key === 'title' && prefix === 'detail' ? 'detail.invalidFields' : 'item.invalidField', { field: label })}</p>}
      {provenance && assertion && fieldAssertion(provenance, assertion).kind !== 'user' && <span className="fine muted">{t('detail.unverified')}</span>}
      {aiDerived && assertion && !draft.intent[key] && <span className="fine muted">{t(Object.entries(aiDerived).some(([field, value]) => field === key && value?.kind === 'ai_observed')
        ? 'aiC.observed' : Object.entries(aiDerived).some(([field]) => field === key) ? 'aiC.estimate' : 'aiC.unknown')}</span>}
      {key !== 'title' && key !== 'category' && <button className="text-button" type="button" disabled={locked}
        onClick={() => change(key, defaults[key])}>{t(optional ? 'item.clearField' : 'item.resetField', { field: label })}</button>}
    </div>;
  };
  return <>
    {field('title')}{field('category')}
    <details className="optional-details">
      <summary>{t('item.details')}<span>{t('common.optional')}</span></summary>
      {children}
      {groups.map((group) => <div className="garment-group" key={group.label}>
        <button className="text-button garment-toggle" type="button" aria-expanded={Boolean(expanded[group.label])}
          aria-controls={`${prefix}-${group.fields[0]}-group`}
          onClick={() => setExpanded((previous) => ({ ...previous, [group.label]: !previous[group.label] }))}>{t(group.label)}</button>
        <div id={`${prefix}-${group.fields[0]}-group`} className="garment-grid" hidden={!expanded[group.label]}>{group.fields.map(field)}</div>
      </div>)}
    </details>
  </>;
}
