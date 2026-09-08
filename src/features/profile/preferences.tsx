import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import type { PreferencesRow } from '../../data/rows';
import { fetchPreferences, savePreferences } from '../../data/preferences';
import { errorKey, isAborted } from '../../data/errors';
import { colours, preferenceFields, styleTagLimit, type PreferenceFields } from '../../domain/preferences';
import { categories, categoryKeys, isCategory } from '../../domain/wardrobe';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';

type Props = { client: AppClient; scope: OwnerScope; t: Translate; language: Language; online: boolean; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void };
export function Preferences({ client, scope, t, language, online, onDirty, onBusy }: Props) {
  const [base, setBase] = useState<PreferencesRow | null>(null);
  const [fields, setFields] = useState<PreferenceFields | null>(null);
  const [tag, setTag] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) summary.current?.focus(); }, [error]);
  const dirty = Boolean(tag || fields && base && JSON.stringify(fields) !== JSON.stringify(preferenceFields(base)));
  useEffect(() => {
    let active = true;
    void fetchPreferences(client, scope).then((row) => {
      if (active) { setBase(row); setFields(preferenceFields(row)); }
    }).catch((problem: unknown) => {
      if (active && !scope.signal.aborted && !isAborted(problem)) setError(errorKey(problem));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, scope]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  function fail(problem: unknown) {
    if (scope.signal.aborted || isAborted(problem)) return;
    setError(errorKey(problem));
    summary.current?.focus();
  }
  function change(next: PreferenceFields) { setFields(next); setSaved(false); }
  async function reload(preserve: boolean) {
    setBusy(true); setSaved(false);
    try {
      const row = await fetchPreferences(client, scope);
      if (scope.signal.aborted) return;
      setBase(row); if (!preserve) { setFields(preferenceFields(row)); setTag(''); } setError(null);
    } catch (problem) { fail(problem); }
    finally { if (!scope.signal.aborted) setBusy(false); }
  }
  async function save() {
    if (!base || !fields) return;
    if (tag) { setError('settings.addTagFirst'); summary.current?.focus(); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      const row = await savePreferences(client, scope, base, fields);
      if (scope.signal.aborted) return;
      setBase(row); setFields(preferenceFields(row)); setSaved(true);
    } catch (problem) { fail(problem); }
    finally { if (!scope.signal.aborted) setBusy(false); }
  }
  function addTag() {
    if (!fields) return;
    if (!tag.trim() || [...tag].length > styleTagLimit || fields.style_tags.length >= 8 || fields.style_tags.includes(tag)) {
      setError('settings.invalidTag'); summary.current?.focus(); return;
    }
    change({ ...fields, style_tags: [...fields.style_tags, tag] }); setTag(''); setError(null);
  }
  const number = (value: number) => new Intl.NumberFormat(locales[language]).format(value);
  return <section className="settings-card settings-preferences" aria-labelledby="preferences-heading">
    <h2 id="preferences-heading">{t('profile.style')}</h2><p className="muted">{t('settings.optionalHint')}</p>
    {loading && <p role="status">{t('common.loading')}</p>}
    <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="stack">
      {fields && <>
        <fieldset className="settings-group" disabled={busy}><legend>{t('settings.styleTags')}</legend>
          <p className="muted fine">{t('settings.tagHint', { limit: number(styleTagLimit) })}</p>
          <div className="settings-chips">{fields.style_tags.map((value, index) => <button type="button" key={`${index}-${value}`} className="settings-chip" aria-label={t('settings.removeTag', { tag: value })} onClick={() => change({ ...fields, style_tags: fields.style_tags.filter((_, i) => i !== index) })}>{value}<span aria-hidden="true"> ×</span></button>)}</div>
          <div className="settings-tag-entry"><div className="field"><label htmlFor="style-tag">{t('settings.newTag')}</label><input id="style-tag" value={tag} onChange={(event) => { setTag(event.target.value); setSaved(false); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} /></div><button type="button" className="button button-secondary" onClick={addTag}>{t('settings.addTag')}</button></div>
        </fieldset>
        {(['preferred_colours', 'excluded_categories'] as const).map((key) => {
          const choices: readonly string[] = key === 'preferred_colours' ? colours : categories;
          const unknown = fields[key].filter((value) => !choices.includes(value));
          const limit = key === 'preferred_colours' ? 8 : 7;
          return <fieldset className="settings-group" disabled={busy} key={key}>
            <legend>{t(key === 'preferred_colours' ? 'profile.colours' : 'settings.excludedCategories')}</legend>
            <p className="muted fine">{t('settings.selectionHint', { limit: number(limit) })}</p>
            <div className="settings-chips">{choices.map((value) => {
              const selected = fields[key].includes(value);
              const label = key === 'excluded_categories' && isCategory(value) ? t(categoryKeys[value]) : t(`colour.${value}` as MessageKey);
              return <button key={value} type="button" className="settings-chip" aria-pressed={selected} disabled={!selected && fields[key].length >= limit} onClick={() => change({ ...fields, [key]: selected ? fields[key].filter((entry) => entry !== value) : [...fields[key], value] })}>{label}</button>;
            })}</div>
            {unknown.length > 0 && <><p className="muted fine">{t('settings.unknownValues')}</p><div className="settings-chips">{unknown.map((value, index) => <button key={`${index}-${value}`} type="button" className="settings-chip" aria-label={t('settings.removeTag', { tag: value })} onClick={() => change({ ...fields, [key]: fields[key].filter((entry) => entry !== value) })}>{value}<span aria-hidden="true"> ×</span></button>)}</div></>}
          </fieldset>;
        })}
        <div className="settings-numbers">{([
          ['minimum_upper_coverage', 'settings.upperCoverage', 0, 2],
          ['minimum_lower_coverage', 'settings.lowerCoverage', 0, 2],
          ['cold_sensitivity', 'settings.coldSensitivity', -2, 2],
          ['repeat_gap_days', 'profile.repeatGap', 0, 14],
        ] as const).map(([key, label, min, max]) => <div className="field" key={key}><label htmlFor={key}>{t(label)}</label>
          <select id={key} value={fields[key]} disabled={busy} onChange={(event) => change({ ...fields, [key]: Number(event.target.value) })}>
            {Array.from({ length: max - min + 1 }, (_, index) => min + index).map((value) => <option key={value} value={value}>{number(value)}</option>)}
          </select>
          <p className="muted fine">{t(key.includes('coverage') ? 'settings.coverageHint' : key === 'cold_sensitivity' ? 'settings.coldHint' : 'settings.repeatHint')}</p>
        </div>)}</div>
      </>}
      {error && <div ref={summary} role="alert" tabIndex={-1} className="notice notice-error"><p>{t(error)}</p>
        {(error === 'error.conflict' || !fields) && <div className="settings-actions"><button type="button" className="text-button" disabled={!online || busy} onClick={() => { void reload(false); }}>{t('settings.reload')}</button>
          {fields && <button type="button" className="text-button" disabled={!online || busy} onClick={() => { void reload(true); }}>{t('settings.keepEdits')}</button>}</div>}
      </div>}
      {fields && <button className="button button-primary" disabled={!online || busy || !dirty}>{t(busy ? 'common.saving' : 'settings.savePreferences')}</button>}
      {saved && <p className="settings-success" role="status">{t('settings.preferencesSaved')}</p>}
    </form>
  </section>;
}
