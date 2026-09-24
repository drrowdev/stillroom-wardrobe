import { useState, type ReactNode } from 'react';
import { colours } from '../../domain/preferences';
import type { FieldProvenance } from '../../domain/attribute-provenance';
import {
  collectionLimits, editGarmentField, enumFields, seasons, textLimits, validateGarmentDraft,
  type GarmentDraft, type GarmentField, type GarmentValues, type RawFields,
} from '../../domain/garment-fields';
import { addTag, moreFields, occasionOptions, tagBudgetFull, tagLength, visibleFields, warmthOptions } from '../../domain/item-details';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { AiDerivation } from '../../domain/ai-draft';

// Only visibleFields and moreFields are shown. Every other column stays in the draft untouched, so a save never changes it.
const labels: Partial<Record<GarmentField, MessageKey>> = {
  title: 'item.title', category: 'item.category', colours: 'item.colours', seasons: 'item.seasons',
  subcategory: 'item.type', pattern: 'item.pattern', brand: 'item.brand', size_label: 'item.size',
  material: 'item.material', formality: 'item.occasion', warmth: 'item.warmth', purchase_price: 'item.price',
  purchase_date: 'item.purchaseDate', notes: 'item.notes', tags: 'item.tags', style_tags: 'item.tags',
  favourite: 'item.favourite',
};
type Props = {
  draft: GarmentDraft; onChange: (draft: GarmentDraft) => void; baseline?: GarmentValues; provenance?: FieldProvenance;
  language: Language; t: Translate; prefix: 'item' | 'detail'; locked: boolean; currency: string;
  showErrors?: boolean; children?: ReactNode;
  aiDerived?: AiDerivation;
};
export function ItemForm({ draft, onChange, baseline, language, t, prefix, locked, showErrors = false, children, aiDerived }: Props) {
  const [tagText, setTagText] = useState('');
  const [tagNotice, setTagNotice] = useState<string | null>(null);
  const { errors } = validateGarmentDraft(draft, baseline);
  const change = <K extends GarmentField>(key: K, value: RawFields[K]) => onChange(editGarmentField(draft, key, value, language));
  const invalid = (key: GarmentField) => Boolean(errors[key] && (showErrors || draft.intent[key] || prefix === 'detail'));
  const textProps = { readOnly: prefix === 'item' && locked, disabled: prefix === 'detail' && locked };
  const aria = (key: GarmentField, id: string) => ({ 'aria-invalid': invalid(key), 'aria-describedby': invalid(key) ? `${id}-error` : undefined });
  const marker = (key: GarmentField) => {
    const derived = aiDerived && !draft.intent[key] ? Object.entries(aiDerived).find(([field]) => field === key)?.[1] : undefined;
    return derived ? <span className="field-marker">{t(derived.kind === 'ai_observed' ? 'aiC.markSuggested' : 'aiC.markEstimated')}</span> : null;
  };
  // Say what is wrong when the field knows it; otherwise ask the user to check the field.
  const reason = (key: GarmentField, label: string): string => {
    if (key === 'title' && prefix === 'detail') return t('detail.invalidFields');
    const raw = draft.raw[key];
    if (key in textLimits && typeof raw === 'string') {
      const limit = textLimits[key as keyof typeof textLimits];
      if ([...raw.trim()].length > limit) return t('item.tooLong', { count: new Intl.NumberFormat(locales[language]).format(limit) });
      if (key === 'title' && !raw.trim()) return t('common.required');
    }
    return t('item.invalidField', { field: label });
  };
  const error = (key: GarmentField, id: string, label: string) => invalid(key)
    ? <p id={`${id}-error`} role="alert" className="notice notice-error">{reason(key, label)}</p>
    : null;
  const labelled = (key: GarmentField, control: ReactNode, extra?: ReactNode) => {
    const id = `${prefix}-${key}`, label = t(labels[key]!);
    return <div className="field garment-field" key={key}>
      <div className="field-label"><label htmlFor={id}>{label}</label>{marker(key)}</div>{control}{extra}{error(key, id, label)}
    </div>;
  };
  const text = (key: 'title' | 'subcategory' | 'brand' | 'size_label' | 'material') => labelled(key,
    <input id={`${prefix}-${key}`} value={draft.raw[key]} {...textProps} {...aria(key, `${prefix}-${key}`)}
      placeholder={key === 'title' && prefix === 'item' ? t('capture.namePlaceholder') : undefined}
      onChange={(event) => change(key, event.target.value)} />);
  const select = (key: GarmentField, options: ReadonlyArray<readonly [string, string]>, empty: MessageKey | null) => {
    const raw = draft.raw[key] as string;
    const legacy = raw !== '' && !options.some(([value]) => value === raw);
    return labelled(key, <select id={`${prefix}-${key}`} value={raw} disabled={locked} {...aria(key, `${prefix}-${key}`)}
      onChange={(event) => change(key, event.target.value)}>
      {empty && <option value="">{t(empty)}</option>}
      {legacy && <option value={raw}>{raw}</option>}
      {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>);
  };
  const colourChips = () => {
    const id = `${prefix}-colours`, label = t('item.colours'), values = draft.raw.colours;
    const full = values.length >= collectionLimits.colours;
    const name = (code: string) => colours.some((value) => value === code) || code === 'unknown' ? t(`colour.${code}` as MessageKey) : code;
    return <div className="field garment-field" key="colours">
      <div className="field-label"><span id={`${id}-label`} className="garment-label">{label}</span>{marker('colours')}</div>
      <div id={id} tabIndex={-1} className="chip-list" role="group" aria-labelledby={`${id}-label`} {...aria('colours', id)}>
        {values.map((value, index) => <span key={`${value}-${index}`} className="chip">{name(value)}
          <button type="button" className="chip-remove" disabled={locked} aria-label={t('item.removeColour', { colour: name(value) })}
            onClick={() => change('colours', values.filter((_, at) => at !== index))}><span aria-hidden="true">×</span></button></span>)}
        <select id={`${id}-add`} value="" disabled={locked || full} aria-label={t('item.addColour')}
          aria-describedby={full ? `${id}-limit` : undefined}
          onChange={(event) => { if (event.target.value) change('colours', [...values, event.target.value]); }}>
          <option value="">{t('item.addColour')}</option>
          {colours.filter((code) => !values.includes(code)).map((code) => <option key={code} value={code}>{name(code)}</option>)}
        </select>
      </div>
      {full && <p id={`${id}-limit`} className="fine muted">{t('item.colourLimit')}</p>}
      {error('colours', id, label)}
    </div>;
  };
  const seasonBoxes = () => {
    const id = `${prefix}-seasons`, label = t('item.seasons'), values = draft.raw.seasons;
    return <fieldset id={id} tabIndex={-1} className="field garment-field season-set" key="seasons" {...aria('seasons', id)}>
      <legend>{label}{marker('seasons')}</legend>
      <div className="check-row">{seasons.map((code) => <label key={code} className="check">
        <input type="checkbox" id={`${id}-${code}`} checked={values.includes(code)} disabled={locked}
          onChange={(event) => change('seasons', event.target.checked ? [...values, code] : values.filter((value) => value !== code))} />
        {t(`season.${code}`)}</label>)}</div>
      {values.filter((value) => !seasons.some((code) => code === value)).map((value) => <span key={value} className="chip">{value}</span>)}
      {error('seasons', id, label)}
    </fieldset>;
  };
  const tagArea = () => {
    const id = `${prefix}-tags`, label = t('item.tags'), tags = draft.raw.tags, style = draft.raw.style_tags;
    const full = tagBudgetFull(tags, style);
    const submit = () => {
      const result = addTag(tagText, tags, style);
      if (result.status === 'added') { change('tags', result.tags); setTagText(''); setTagNotice(null); }
      else if (result.status === 'duplicate') setTagNotice(t('item.tagDuplicate'));
      else if (result.status === 'full') setTagNotice(t('item.tagLimit'));
      else if (result.status === 'invalid') setTagNotice(t('item.textLimit', { count: new Intl.NumberFormat(locales[language]).format(tagLength) }));
    };
    const hint = full ? t('item.tagLimit') : tagNotice;
    return <div className="field garment-field" key="tags">
      <div className="field-label"><label htmlFor={`${id}-new`}>{label}</label></div>
      <div id={id} tabIndex={-1} className="chip-list" aria-invalid={invalid('tags') || invalid('style_tags')}
        aria-describedby={invalid('tags') || invalid('style_tags') ? `${id}-error` : undefined}>
        {tags.map((value, index) => <span key={`t-${index}`} className="chip">{value}
          <button type="button" className="chip-remove" disabled={locked} aria-label={t('item.removeTag', { tag: value })}
            onClick={() => change('tags', tags.filter((_, at) => at !== index))}><span aria-hidden="true">×</span></button></span>)}
        {style.map((value, index) => <span key={`s-${index}`} className="chip"><span aria-hidden="true">{value}</span>
          <span className="sr-only">{t('item.styleWord', { tag: value })}</span>
          <button type="button" className="chip-remove" disabled={locked} aria-label={t('item.removeStyleWord', { tag: value })}
            onClick={() => change('style_tags', style.filter((_, at) => at !== index))}><span aria-hidden="true">×</span></button></span>)}
      </div>
      <div className="tag-entry">
        <input id={`${id}-new`} value={tagText} disabled={locked || full} aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => { setTagText(event.target.value); setTagNotice(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
        <button type="button" className="button button-secondary" disabled={locked || full || !tagText.trim()} onClick={submit}>{t('item.addTag')}</button>
      </div>
      {hint && <p id={`${id}-hint`} className="fine muted" role="status">{hint}</p>}
      {(invalid('tags') || invalid('style_tags')) && <p id={`${id}-error`} role="alert" className="notice notice-error">{t('item.invalidField', { field: label })}</p>}
    </div>;
  };
  const warmth = warmthOptions(draft.raw.warmth);
  const renderField = (key: typeof visibleFields[number] | typeof moreFields[number]): ReactNode => {
    switch (key) {
      case 'title': case 'subcategory': case 'brand': case 'size_label': case 'material': return text(key);
      case 'category': return select('category', enumFields.category.map((code) => [code, t(`categoryOne.${code}`)] as const), 'capture.selectCategory');
      case 'colours': return colourChips();
      case 'seasons': return seasonBoxes();
      case 'pattern': return select('pattern', enumFields.pattern.map((code) => [code, t(`pattern.${code}`)] as const), 'item.notSet');
      case 'formality': return select('formality', occasionOptions.map(([value, key]) => [value, t(key)] as const), 'item.notSet');
      case 'warmth': return select('warmth', warmth.map(([value, key]) => [value, t(key)] as const), 'item.notSet');
      case 'purchase_price': return labelled('purchase_price', <div className="price-entry">
        <input id={`${prefix}-purchase_price`} value={draft.raw.purchase_price} inputMode="decimal" {...textProps}
          {...aria('purchase_price', `${prefix}-purchase_price`)} onChange={(event) => change('purchase_price', event.target.value)} />
        <span className="price-currency">{draft.raw.currency}</span></div>);
      case 'purchase_date': return labelled('purchase_date', <input id={`${prefix}-purchase_date`} type="date" value={draft.raw.purchase_date}
        {...textProps} {...aria('purchase_date', `${prefix}-purchase_date`)} onChange={(event) => change('purchase_date', event.target.value)} />);
      case 'notes': return labelled('notes', <textarea id={`${prefix}-notes`} rows={3} value={draft.raw.notes} {...textProps}
        {...aria('notes', `${prefix}-notes`)} onChange={(event) => change('notes', event.target.value)} />);
      case 'tags': return tagArea();
      case 'favourite': return <div className="field garment-field" key="favourite"><label className="check">
        <input type="checkbox" id={`${prefix}-favourite`} checked={draft.raw.favourite === 'true'} disabled={locked}
          onChange={(event) => change('favourite', event.target.checked ? 'true' : 'false')} />{t('item.favourite')}</label></div>;
    }
  };
  return <>
    {visibleFields.map(renderField)}
    <details className="optional-details">
      <summary>{t('item.moreDetails')}</summary>
      <div className="garment-grid">{moreFields.map(renderField)}</div>
      {children}
    </details>
  </>;
}
