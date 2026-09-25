import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope, SessionController, SessionState } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import { profileFields, sameProfileFields, type ProfileFields } from '../../domain/preferences';
import { errorKey, isAborted } from '../../data/errors';
import type { Language, MessageKey, Translate } from '../../i18n';
import { LanguageSettings } from '../settings/language-settings';
import { AiSettings } from '../settings/ai-settings';
import { WeatherSettings } from '../settings/weather-settings';
import { BackupSettings } from '../settings/backup-settings';
import { RestoreSettings } from '../settings/restore-settings';
import type { AiClient } from '../../data/ai';
import { currencyOptions, timeZoneOptions } from './profile-options';

// Style preferences stay stored but are not shown until suggestions use them (ADR20).
type Props = { client: AppClient; ai: AiClient; unresolved: boolean; controller: SessionController; scope: OwnerScope; profile: ProfileRow; change: SessionState['profileChange']; busy: boolean; language: Language; online: boolean; t: Translate; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void; onBack: () => void };
const fieldLabels = { display_name: 'profile.displayName', timezone: 'profile.timezone', currency: 'profile.currency' } as const;
const fieldErrors = { display_name: 'settings.invalidName', timezone: 'settings.invalidTimezone', currency: 'settings.invalidCurrency' } as const;
export function ProfileScreen({ client, ai, unresolved, controller, scope, profile, change, busy, language, online, t, onDirty, onBack }: Props) {
  const [base, setBase] = useState(profile);
  const [seen, setSeen] = useState(profile);
  const [fields, setFields] = useState<ProfileFields>(() => profileFields(profile));
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [reading, setReading] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) summary.current?.focus(); }, [error]);
  const timezones = useMemo(() => timeZoneOptions(language, [base.timezone, fields.timezone]), [language, base.timezone, fields.timezone]);
  const currencies = useMemo(() => currencyOptions(language, [base.currency, fields.currency]), [language, base.currency, fields.currency]);
  const dirty = !sameProfileFields(fields, base);
  const shownError: MessageKey | null = error === 'settings.invalidTimezone' && !timezones ? 'settings.enterTimezone'
    : error === 'settings.invalidCurrency' && !currencies ? 'settings.enterCurrency' : error;
  if (seen !== profile) {
    setSeen(profile);
    if (!dirty) { setBase(profile); setFields(profileFields(profile)); }
    else if ((change?.kind === 'language' || change?.kind === 'weather') && change.previous.version === base.version
      && sameProfileFields(change.previous, base) && sameProfileFields(profile, base)) setBase(profile);
    else if (change?.kind === 'ai' && change.previous.version === base.version && profile.version === base.version + 1
      && sameProfileFields(change.previous, base) && sameProfileFields(profile, base)
      && change.previous.ui_language === base.ui_language && profile.ui_language === base.ui_language) setBase(profile);
  }
  useEffect(() => {
    onDirty(dirty, false, busy || reading);
    return () => onDirty(false, false, false);
  }, [dirty, busy, reading, onDirty]);
  function fail(problem: unknown) {
    if (scope.signal.aborted || isAborted(problem)) return;
    setError(errorKey(problem));
    summary.current?.focus();
  }
  async function save() {
    setError(null); setSaved(false);
    try {
      const row = await controller.saveProfile(scope, base, { kind: 'profile', fields });
      if (scope.signal.aborted) return;
      setBase(row); setFields(profileFields(row)); setSaved(true);
    } catch (problem) { fail(problem); }
  }
  async function reload(preserve: boolean) {
    setReading(true); setSaved(false);
    try {
      const row = await controller.reloadProfile(scope);
      if (scope.signal.aborted) return;
      setBase(row); if (!preserve) setFields(profileFields(row)); setError(null);
    } catch (problem) { fail(problem); }
    finally { if (!scope.signal.aborted) setReading(false); }
  }
  return <div className="settings-page">
    <button className="text-button" onClick={onBack}>{t('common.back')}</button>
    <header className="settings-heading"><h1 id="settings-title" tabIndex={-1}>{t('nav.settings')}</h1></header>
    <div className="settings-grid">
      <section className="settings-card" aria-labelledby="profile-heading">
        <h2 id="profile-heading">{t('profile.title')}</h2><p className="muted fine">{t('settings.profileHint')}</p>
        <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="stack">
          {(['display_name', 'timezone', 'currency'] as const).map((field) => {
            const options = field === 'timezone' ? timezones : field === 'currency' ? currencies : null;
            const common = { id: `profile-${field}`, value: fields[field], disabled: busy || reading,
              'aria-invalid': error === fieldErrors[field] || field === 'timezone' && error === 'settings.serverTimezone',
              onChange: (event: { target: { value: string } }) => { setFields({ ...fields, [field]: event.target.value }); setSaved(false); } };
            return <div className="field" key={field}>
              <label htmlFor={`profile-${field}`}>{t(fieldLabels[field])}</label>
              {options ? <select {...common} style={{ contain: 'paint' }}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                : <input {...common} autoComplete={field === 'display_name' ? 'nickname' : 'off'} />}
            </div>;
          })}
          {shownError && <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error"><p>{t(shownError)}</p>{error === 'error.conflict' && <div className="settings-actions">
            <button type="button" className="text-button" disabled={!online || busy || reading} onClick={() => { void reload(false); }}>{t('settings.reload')}</button>
            <button type="button" className="text-button" disabled={!online || busy || reading} onClick={() => { void reload(true); }}>{t('settings.keepEdits')}</button>
          </div>}</div>}
          <button className="button button-primary" disabled={!online || busy || reading || !dirty}>{t(busy ? 'common.saving' : 'settings.saveProfile')}</button>
          {saved && <p className="settings-success" role="status">{t('settings.profileSaved')}</p>}
        </form>
      </section>
      <section className="settings-card" aria-labelledby="settings-language-heading"><h2 id="settings-language-heading">{t('language.label')}</h2>
        <LanguageSettings controller={controller} scope={scope} profile={profile} language={language} busy={busy || reading} online={online} t={t} />
        <p className="privacy-note">{t('profile.privacy')}</p>
      </section>
      <WeatherSettings controller={controller} scope={scope} profile={profile} busy={busy || reading} language={language} online={online} t={t} />
      <AiSettings ai={ai} controller={controller} scope={scope} profile={profile} busy={busy || reading}
        unresolved={unresolved} language={language} online={online} t={t} />
      <BackupSettings client={client} scope={scope} language={language} online={online} t={t} />
      <RestoreSettings client={client} scope={scope} language={language} online={online} t={t} />
    </div>
  </div>;
}
