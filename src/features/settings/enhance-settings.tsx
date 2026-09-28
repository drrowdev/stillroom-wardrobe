import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, MessageKey, Translate } from '../../i18n';
import { ENHANCE_NOTICE_KEYS, enhanceViewOf, readEnhanceStatus, writeEnhanceConsent, type EnhanceStore } from './enhance-store';

type Props = { store: EnhanceStore | null; busy: boolean; online: boolean; language: Language; t: Translate };


// Status is read on arrival, focus, visibility and reconnect, never while the profile is being saved; reads never write.
// Turn off stays available whenever consent is on, including when enhancement is paused, not activated or unavailable.
export function EnhanceSettings({ store, busy, online, language, t }: Props) {
  if (!store) return null;
  return <Card store={store} busy={busy} online={online} language={language} t={t} />;
}
function Card({ store, busy, online, language, t }: Props & { store: EnhanceStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => { store.setBusy(busy); }, [store, busy]);
  useEffect(() => {
    void readEnhanceStatus(store, 'passive');
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void readEnhanceStatus(store, 'passive'); };
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
  const pressed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const button = pressed.current;
    if (!button || state.writing || state.reading) return;
    pressed.current = null;
    if (!button.isConnected && !store.scope.signal.aborted) heading.current?.focus();
  });
  const view = enhanceViewOf(store, state);
  if (view.kind === 'hidden') return null;
  const status = state.read.kind === 'ready' ? state.read.status : null;
  const policy = status?.policy ?? null;
  const disabled = !online || busy || state.writing;
  const title: MessageKey = view.kind === 'on' ? 'enhanceC.enabled' : view.kind === 'off' || view.kind === 'renew' ? 'enhanceC.disabled'
    : view.kind === 'paused' ? 'enhanceC.paused' : 'enhanceC.settings';
  const details = view.kind === 'off' || view.kind === 'renew' || view.kind === 'on' || view.kind === 'paused';
  const change = (enabled: boolean, button: HTMLElement) => { pressed.current = button; void writeEnhanceConsent(store, enabled); };
  return <section className="settings-card ai-card" aria-labelledby="enhance-heading" aria-busy={state.writing}>
    <div role="status" className="ai-state">
      <h2 id="enhance-heading" ref={heading} tabIndex={-1}>{t(title)}</h2>
      {view.kind === 'loadFailed' && <p>{t('enhanceC.loadFailed')}</p>}
      {view.kind === 'unresolved' && <p>{t('stylist.unresolved')}</p>}
      {view.kind === 'paused' && <p>{t('enhanceC.pausedText')}</p>}
      {view.kind === 'renew' && <p>{t('enhanceC.changed')}</p>}
      {view.kind === 'on' && status?.usage && policy && <p className="ai-usage">{t('enhanceC.usage', {
        used: usdCents(status.usage.enhanceMicro, language, 'used'), limit: usdCents(policy.enhanceAllowanceMicro, language, 'limit') })}</p>}
    </div>
    {(view.kind === 'off' || view.kind === 'renew') && <p>{t('enhanceC.offSummary')}</p>}
    {details && <details className="ai-details">
      <summary>{t('aiC.details')}</summary>
      <div className="ai-notice fine">{ENHANCE_NOTICE_KEYS.map((key) => <p key={key}>{t(key)}</p>)}</div>
    </details>}
    {(view.turnOn || view.turnOff || view.kind === 'loadFailed' || view.kind === 'unresolved') && <div className="settings-actions">
      {view.turnOn && <button id="enhance-turn-on" type="button" className="button button-primary" disabled={disabled}
        onClick={(event) => change(true, event.currentTarget)}>{t(state.writing ? 'common.saving' : 'aiC.enable')}</button>}
      {view.turnOff && <button id="enhance-turn-off" type="button" className={view.turnOn ? 'text-button' : 'button button-secondary'} disabled={disabled}
        onClick={(event) => change(false, event.currentTarget)}>{t(state.writing ? 'common.saving' : 'aiC.disable')}</button>}
      {(view.kind === 'loadFailed' || view.kind === 'unresolved') && <button type="button" className="button button-secondary"
        disabled={!online || busy || state.reading || state.writing}
        onClick={(event) => { pressed.current = event.currentTarget; void readEnhanceStatus(store, 'active'); }}>{t('common.retry')}</button>}
    </div>}
    {state.settingsError && !(state.settingsError === 'enhanceC.changed' && view.kind === 'renew')
      && <p role="alert" className="notice notice-error">{t(state.settingsError)}</p>}
  </section>;
}
