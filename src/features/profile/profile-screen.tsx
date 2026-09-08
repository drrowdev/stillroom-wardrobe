import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope, SessionController, SessionState } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import { profileFields, sameProfileFields, type ProfileFields } from '../../domain/preferences';
import { errorKey, isAborted } from '../../data/errors';
import type { Language, MessageKey, Translate } from '../../i18n';
import { LanguageSettings } from '../settings/language-settings';
import { Preferences } from './preferences';

type Props = { client: AppClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow; change: SessionState['profileChange']; busy: boolean; language: Language; online: boolean; t: Translate; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void; onBack: () => void };
function intlOptions(key: 'timeZone' | 'currency'): string[] {
  try { return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf(key) : []; } catch { return []; }
}
export function ProfileScreen({ client, controller, scope, profile, change, busy, language, online, t, onDirty, onBack }: Props) {
  const [base, setBase] = useState(profile);
  const [seen, setSeen] = useState(profile);
  const [fields, setFields] = useState<ProfileFields>(() => profileFields(profile));
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [reading, setReading] = useState(false);
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) summary.current?.focus(); }, [error]);
  const [timezones] = useState(() => intlOptions('timeZone'));
  const [currencies] = useState(() => intlOptions('currency'));
  const dirty = !sameProfileFields(fields, base);
  if (seen !== profile) {
    setSeen(profile);
    if (!dirty) { setBase(profile); setFields(profileFields(profile)); }
    else if (change?.kind === 'language' && change.previous.version === base.version
      && sameProfileFields(change.previous, base) && sameProfileFields(profile, base)) setBase(profile);
  }
  useEffect(() => {
    onDirty(dirty || preferencesDirty, false, busy || reading || preferencesBusy);
    return () => onDirty(false, false, false);
  }, [dirty, preferencesDirty, busy, reading, preferencesBusy, onDirty]);
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
    <header className="settings-heading"><p className="eyebrow">{t('common.private')}</p><h1 id="settings-title" tabIndex={-1}>{t('nav.settings')}</h1><p className="muted">{t('settings.intro')}</p></header>
    <div className="settings-grid">
      <section className="settings-card" aria-labelledby="profile-heading">
        <h2 id="profile-heading">{t('profile.title')}</h2><p className="muted fine">{t('settings.profileHint')}</p>
        <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="stack">
          {(['display_name', 'timezone', 'currency'] as const).map((field) => <div className="field" key={field}>
            <label htmlFor={`profile-${field}`}>{t(field === 'display_name' ? 'profile.displayName' : field === 'timezone' ? 'profile.timezone' : 'profile.currency')}</label>
            <input id={`profile-${field}`} value={fields[field]} disabled={busy || reading}
              autoComplete={field === 'display_name' ? 'nickname' : 'off'} list={field === 'display_name' ? undefined : `settings-${field}`}
              aria-invalid={error === (field === 'display_name' ? 'settings.invalidName' : field === 'timezone' ? 'settings.invalidTimezone' : 'settings.invalidCurrency') || field === 'timezone' && error === 'settings.serverTimezone'}
              onChange={(event) => { setFields({ ...fields, [field]: event.target.value }); setSaved(false); }} />
          </div>)}
          <datalist id="settings-timezone">{timezones.map((value) => <option key={value} value={value} />)}</datalist>
          <datalist id="settings-currency">{currencies.map((value) => <option key={value} value={value} />)}</datalist>
          {error && <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error"><p>{t(error)}</p>{error === 'error.conflict' && <div className="settings-actions">
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
      <Preferences client={client} scope={scope} t={t} language={language} online={online} onDirty={setPreferencesDirty} onBusy={setPreferencesBusy} />
    </div>
  </div>;
}
