import { useEffect, useRef } from 'react';
import { stylistLimits } from '../../domain/stylist-controls';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, MessageKey, Translate } from '../../i18n';
import type { StylistStore } from '../stylist/stylist-store';
import { readStatus, statusOf, useStylist, useStylistStatus, viewOf, writeConsent } from '../stylist/use-stylist';

type Props = { store: StylistStore; busy: boolean; online: boolean; language: Language; t: Translate };
// Status is read on arrival, focus, visibility and reconnect, never while the profile is being saved; reads never write.
// Turn off stays available whenever consent is on, even when the stylist can't be used or this app version can't turn it on.
export function StylistSettings({ store, busy, online, language, t }: Props) {
  useStylistStatus(store);
  const state = useStylist(store);
  const view = viewOf(state);
  const status = statusOf(state);
  const heading = useRef<HTMLHeadingElement>(null);
  const pressed = useRef<HTMLElement | null>(null);
  // After a pressed button is replaced, focus moves to the heading so it isn't lost. Passive refreshes never move focus.
  useEffect(() => {
    const button = pressed.current;
    if (!button || state.writing || state.reading) return;
    pressed.current = null;
    if (!button.isConnected && !store.scope.signal.aborted) heading.current?.focus();
  });
  if (!view.card) return null;
  const policy = status?.policy ?? null;
  const limits = status ? stylistLimits(status) : null;
  const stylistLimit = policy ? usdCents(policy.stylistAllowanceMicro, language, 'limit') : '';
  const limit = policy ? usdCents(policy.totalAllowanceMicro, language, 'limit') : '';
  const disabled = !online || busy || state.writing;
  const title: MessageKey = view.kind === 'on' ? 'stylistC.enabled' : view.kind === 'off' || view.kind === 'renew' ? 'stylistC.disabled'
    : view.kind === 'paused' ? 'stylistC.paused' : 'stylistC.settings';
  const details = view.kind === 'off' || view.kind === 'renew' || view.kind === 'on' || view.kind === 'paused';
  const change = (enabled: boolean, button: HTMLElement) => { pressed.current = button; void writeConsent(store, enabled); };
  return <section className="settings-card ai-card" aria-labelledby="stylist-heading" aria-busy={state.writing}>
    <div role="status" className="ai-state">
      <h2 id="stylist-heading" ref={heading} tabIndex={-1}>{t(title)}</h2>
      {view.kind === 'loadFailed' && <p>{t('stylistC.loadFailed')}</p>}
      {view.kind === 'unresolved' && <p>{t('stylist.unresolved')}</p>}
      {view.kind === 'unavailable' && <p>{t('stylist.unavailable')}</p>}
      {view.kind === 'paused' && <p>{t('stylist.paused')}</p>}
      {view.kind === 'renew' && <p>{t('stylistC.changed')}</p>}
      {view.kind === 'on' && status?.usage && policy && <>
        <p className="ai-usage">{t('stylistC.usage', { used: usdCents(status.usage.stylistMicro, language, 'used'), limit: stylistLimit })}</p>
        <p className="ai-usage">{t('stylistC.sharedUsage', { used: usdCents(status.usage.totalMicro, language, 'used'), limit })}</p>
        {limits?.own ? <p className="notice">{t('stylist.limitOwn')}</p> : limits?.shared ? <p className="notice">{t('stylist.limitShared')}</p>
          : limits?.ownWarning ? <p className="notice">{t('stylist.warning')}</p> : limits?.sharedWarning ? <p className="notice">{t('stylist.sharedWarning')}</p> : null}
      </>}
    </div>
    {(view.kind === 'off' || view.kind === 'renew') && <p>{t('stylistC.offSummary', { stylistLimit, limit })}</p>}
    {details && <details className="ai-details">
      <summary>{t('aiC.details')}</summary>
      <dl className="ai-notice fine">
        <dt>{t('stylistC.fieldsTitle')}</dt>
        <dd>{t('stylistC.fields')}</dd>
        <dt>{t('stylistC.processing')}</dt>
        <dd>{t('stylistC.azureNotice')}</dd>
        <dt>{t('aiC.retentionTitle')}</dt>
        <dd><p>{t('stylistC.trainingNotice')}</p><p>{t('stylistC.retention')}</p></dd>
        <dt>{t('aiC.chargesTitle')}</dt>
        <dd><p>{t('stylistC.chargeNotice')}</p><p>{t('stylistC.usageNotice')}</p><p>{t('stylistC.optOut')}</p></dd>
      </dl>
    </details>}
    {(view.turnOn || view.turnOff || view.kind === 'loadFailed' || view.kind === 'unresolved') && <div className="settings-actions">
      {view.turnOn && <button type="button" className="button button-primary" disabled={disabled}
        onClick={(event) => change(true, event.currentTarget)}>{t(state.writing ? 'common.saving' : 'aiC.enable')}</button>}
      {view.turnOff && <button type="button" className={view.turnOn ? 'text-button' : 'button button-secondary'} disabled={disabled}
        onClick={(event) => change(false, event.currentTarget)}>{t(state.writing ? 'common.saving' : 'aiC.disable')}</button>}
      {(view.kind === 'loadFailed' || view.kind === 'unresolved') && <button type="button" className="button button-secondary"
        disabled={!online || busy || state.reading || state.writing}
        onClick={(event) => { pressed.current = event.currentTarget; void readStatus(store, 'active'); }}>{t('common.retry')}</button>}
    </div>}
    {state.settingsError && !(state.settingsError === 'stylistC.changed' && view.kind === 'renew') && <p role="alert" className="notice notice-error">{t(state.settingsError)}</p>}
  </section>;
}
