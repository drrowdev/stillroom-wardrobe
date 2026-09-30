import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, Translate } from '../../i18n';
import { featureSwitch } from './ai-features-model';
import { ConsentSheet, FeatureRow } from './feature-row';
import { useConsentSheet } from './use-consent-sheet';
import '../../i18n/tryon';
import { readTryOnStatus, TRYON_NOTICE_KEYS, tryOnViewOf, writeTryOnConsent, type TryOnStore } from './tryon-store';

type Props = { store: TryOnStore | null; busy: boolean; online: boolean; language: Language; t: Translate };

// Status is read on arrival, focus, visibility and reconnect, never while the profile is being saved; reads never write.
// Turn off stays available whenever consent is on, including when try-on is paused, not activated or unavailable.
export function TryOnSettings({ store, busy, online, language, t }: Props) {
  if (!store) return null;
  return <Card store={store} busy={busy} online={online} language={language} t={t} />;
}
function Card({ store, busy, online, language, t }: Props & { store: TryOnStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => { store.setBusy(busy); }, [store, busy]);
  useEffect(() => {
    void readTryOnStatus(store, 'passive');
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void readTryOnStatus(store, 'passive'); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [store]);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const pressed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const button = pressed.current;
    if (!button || state.writing || state.reading) return;
    pressed.current = null;
    if (!button.isConnected && !store.scope.signal.aborted) heading.current?.focus();
  });
  const view = tryOnViewOf(store, state);
  const sheet = useConsentSheet(view.turnOn, state.writing);
  if (view.kind === 'hidden') return null;
  const status = state.read.kind === 'ready' ? state.read.status : null;
  const policy = status?.policy ?? null;
  const disabled = !online || busy || state.writing;
  const details = view.kind === 'off' || view.kind === 'renew' || view.kind === 'on' || view.kind === 'paused';
  const control = featureSwitch(view.turnOn, view.turnOff);
  const change = (enabled: boolean, button: HTMLElement | null) => { pressed.current = button; return writeTryOnConsent(store, enabled); };
  const allowance = policy?.tryOnAllowanceMicro ?? null;
  const value = view.kind === 'on' && status?.usage && allowance ? t('aiC.usage', { used: usdCents(status.usage.tryOnMicro, language, 'used'), limit: usdCents(allowance, language, 'limit') })
    : (view.kind === 'off' || view.kind === 'renew') && allowance ? t('aiF.upTo', { limit: usdCents(allowance, language, 'limit') }) : null;
  const noticeList = <div className="ai-notice fine">{TRYON_NOTICE_KEYS.map((key) => <p key={key}>{t(key)}</p>)}</div>;
  const line = view.kind === 'loadFailed' ? 'tryonC.loadFailed' : view.kind === 'unresolved' ? 'stylist.unresolved'
    : view.kind === 'paused' ? 'tryonC.pausedText' : view.kind === 'renew' ? 'tryonC.changed' : null;
  return <FeatureRow id="tryon-heading" headingRef={heading} switchRef={switchButton} title={t('tryonC.settings')} description={t('tryonC.offSummary')}
    value={value} busy={state.writing} control={control} switchDisabled={disabled}
    onSwitch={() => { if (control.checked) void change(false, switchButton.current); else sheet.show(); }}
    status={<>
      {line && <p>{t(line)}</p>}
      {state.writing && <p>{t('common.saving')}</p>}
    </>}
    actions={(view.turnOn && view.turnOff || view.kind === 'loadFailed' || view.kind === 'unresolved') && <div className="settings-actions">
      {view.turnOn && view.turnOff && <button id="tryon-turn-off" type="button" className="text-button" disabled={disabled}
        onClick={(event) => { void change(false, event.currentTarget); }}>{t(state.writing ? 'common.saving' : 'aiC.disable')}</button>}
      {(view.kind === 'loadFailed' || view.kind === 'unresolved') && <button type="button" className="button button-secondary"
        disabled={!online || busy || state.reading || state.writing}
        onClick={(event) => { pressed.current = event.currentTarget; void readTryOnStatus(store, 'active'); }}>{t('common.retry')}</button>}
    </div>}
    error={state.settingsError && !(state.settingsError === 'tryonC.changed' && view.kind === 'renew')
      && <p role="alert" className="notice notice-error">{t(state.settingsError)}</p>}
    notice={details ? noticeList : null}
    sheet={sheet.open ? <ConsentSheet id="tryon" title={t('tryonC.turnOnTitle')} notice={noticeList} writing={state.writing}
      disabled={disabled} t={t} onCancel={sheet.close} onConfirm={() => { void change(true, switchButton.current).finally(sheet.close); }} /> : null}
    t={t} />;
}
