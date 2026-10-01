import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope, SessionController, SessionState } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import { profileFields, sameProfileFields, type ProfileFields } from '../../domain/preferences';
import { errorKey, isAborted } from '../../data/errors';
import type { Language, MessageKey, Translate } from '../../i18n';
import { LanguageSettings } from '../settings/language-settings';
import { AiFeatures } from '../settings/ai-features';
import { SettingsNav, type SettingsSection } from '../settings/settings-nav';
import type { StylistStore } from '../stylist/stylist-store';
import { WeatherSettings } from '../settings/weather-settings';
import { BackupSettings } from '../settings/backup-settings';
import { RestoreSettings } from '../settings/restore-settings';
import { DeleteAccountSettings } from '../settings/delete-account';
import { InstallHint } from '../settings/install-hint';
import { AvoidedPairs } from '../settings/avoided-pairs';
import type { PrivateImages } from '../../images/private-images';
import type { AiClient } from '../../data/ai';
import { currencyOptions, timeZoneOptions } from './profile-options';
import { DataHub, type DataTask } from '../settings/data-hub';
import '../../styles/data-flow.css';

// Style preferences stay stored but are not shown until suggestions use them (ADR20).
type Props = { client: AppClient; ai: AiClient; stylist: StylistStore; images: PrivateImages; unresolved: boolean; controller: SessionController; scope: OwnerScope; profile: ProfileRow; change: SessionState['profileChange']; busy: boolean; language: Language; online: boolean; t: Translate; version: string; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void; onBack: () => void; onSignOut: () => void };
const fieldLabels = { display_name: 'profile.displayName', timezone: 'profile.timezone', currency: 'profile.currency' } as const;
const fieldErrors = { display_name: 'settings.invalidName', timezone: 'settings.invalidTimezone', currency: 'settings.invalidCurrency' } as const;
const [profileSection, aiSection, wardrobeSection, dataSection, accountSection] = [
  { id: 'settings-profile', label: 'settings.sectionProfile' },
  { id: 'settings-ai', label: 'settings.sectionAi' },
  { id: 'settings-wardrobe', label: 'settings.sectionWardrobe' },
  { id: 'settings-data', label: 'settings.sectionData' },
  { id: 'settings-account', label: 'settings.sectionAccount' },
] as const satisfies readonly SettingsSection[];
const sections: readonly SettingsSection[] = [profileSection, aiSection, wardrobeSection, dataSection, accountSection];
function Section({ of: { id, label }, t, children }: { of: SettingsSection; t: Translate; children: ReactNode }) {
  return <section id={id} className="settings-section" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`} tabIndex={-1}>{t(label)}</h2>
    {children}
  </section>;
}
export function ProfileScreen({ client, ai, stylist, images, unresolved, controller, scope, profile, change, busy, language, online, t, version, onDirty, onBack, onSignOut }: Props) {
  const [base, setBase] = useState(profile);
  const [seen, setSeen] = useState(profile);
  const [fields, setFields] = useState<ProfileFields>(() => profileFields(profile));
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [reading, setReading] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) summary.current?.focus(); }, [error]);
  // Backup, restore and account deletion open as task views inside Settings. Each tool stays mounted, so a request in
  // flight survives a change of view, but renders nothing while another view is shown.
  const [task, setTask] = useState<DataTask | null>(null);
  const [toolBusy, setToolBusy] = useState<Record<DataTask, boolean>>({ backup: false, restore: false, delete: false });
  const working = toolBusy.backup || toolBusy.restore || toolBusy.delete;
  const backupBusy = useCallback((value: boolean) => setToolBusy(current => current.backup === value ? current : { ...current, backup: value }), []);
  const restoreBusy = useCallback((value: boolean) => setToolBusy(current => current.restore === value ? current : { ...current, restore: value }), []);
  const deleteBusy = useCallback((value: boolean) => setToolBusy(current => current.delete === value ? current : { ...current, delete: value }), []);
  const returnTo = useRef<DataTask | null>(null);
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target) document.getElementById(target)?.focus();
  }, [task]);
  function openTask(next: DataTask) {
    if (working) return;
    if (task === null) returnTo.current = next;
    focusTarget.current = `${next}-heading`;
    setTask(next);
  }
  function closeTask() {
    if (working || task === null) return;
    focusTarget.current = `data-row-${returnTo.current ?? task}`;
    setTask(null);
  }
  useEffect(() => {
    const reset = () => setTask(null);
    scope.signal.addEventListener('abort', reset, { once: true });
    return () => scope.signal.removeEventListener('abort', reset);
  }, [scope]);
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
  // A running backup, restore or deletion holds every way out of Settings, as a profile save does.
  useEffect(() => {
    onDirty(dirty, false, busy || reading || working);
    return () => onDirty(false, false, false);
  }, [dirty, busy, reading, working, onDirty]);
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
    <button className="text-button" disabled={task !== null && working} onClick={task === null ? onBack : closeTask}>{t('common.back')}</button>
    <header className="settings-heading"><h1 id="settings-title" tabIndex={-1}>{t('nav.settings')}</h1></header>
    <div className={task === null ? 'settings-layout' : 'settings-layout settings-layout-task'}>
      <SettingsNav sections={sections} t={t} hidden={task !== null} />
      <div className="settings-sections" hidden={task !== null}>
        <Section of={profileSection} t={t}>
          <div className="settings-group-card">
            <div className="settings-card profile-card">
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
                <p className="muted fine">{t('settings.profileHint')}</p>
                {shownError && <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error"><p>{t(shownError)}</p>{error === 'error.conflict' && <div className="settings-actions">
                  <button type="button" className="text-button" disabled={!online || busy || reading} onClick={() => { void reload(false); }}>{t('settings.reload')}</button>
                  <button type="button" className="text-button" disabled={!online || busy || reading} onClick={() => { void reload(true); }}>{t('settings.keepEdits')}</button>
                </div>}</div>}
                <div className="settings-save"><button className="button button-primary" disabled={!online || busy || reading || !dirty}>{t(busy ? 'common.saving' : 'settings.saveProfile')}</button></div>
                {saved && <p className="settings-success" role="status">{t('settings.profileSaved')}</p>}
              </form>
            </div>
            <div className="settings-card" aria-labelledby="settings-language-heading" role="group">
              <h3 id="settings-language-heading">{t('language.label')}</h3>
              <LanguageSettings controller={controller} scope={scope} profile={profile} language={language} busy={busy || reading} online={online} t={t} />
              <p className="privacy-note">{t('profile.privacy')}</p>
            </div>
          </div>
        </Section>
        <Section of={aiSection} t={t}>
          <AiFeatures client={client} ai={ai} controller={controller} scope={scope} profile={profile} stylist={stylist}
            busy={busy || reading} unresolved={unresolved} language={language} online={online} t={t} />
        </Section>
        <Section of={wardrobeSection} t={t}>
          <div className="settings-group-card">
            <WeatherSettings controller={controller} scope={scope} profile={profile} busy={busy || reading} language={language} online={online} t={t} />
            <AvoidedPairs client={client} scope={scope} images={images} language={language} online={online} t={t} />
          </div>
        </Section>
        <Section of={dataSection} t={t}>
          <DataHub t={t} disabled={working} onOpen={openTask} />
        </Section>
        <Section of={accountSection} t={t}>
          <div className="settings-group-card">
            <InstallHint t={t} />
            <div className="settings-card account-sign-out">
              <button type="button" className="button button-secondary" onClick={onSignOut}>{t('auth.signOut')}</button>
              <p className="fine muted app-version">{t('settings.version', { version })}</p>
            </div>
          </div>
        </Section>
      </div>
      <div className="settings-task" hidden={task === null}>
        <BackupSettings client={client} scope={scope} language={language} online={online} t={t} active={task === 'backup'} onBusy={backupBusy} />
        <RestoreSettings client={client} scope={scope} language={language} online={online} t={t} active={task === 'restore'} onBusy={restoreBusy} />
        <DeleteAccountSettings client={client} controller={controller} scope={scope} online={online} t={t} active={task === 'delete'}
          onBusy={deleteBusy} onBackupFirst={() => openTask('backup')} />
      </div>
    </div>
  </div>;
}
