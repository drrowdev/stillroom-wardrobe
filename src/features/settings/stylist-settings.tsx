import { useEffect, useRef } from 'react';
import { stylistLimits } from '../../domain/stylist-controls';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, Translate } from '../../i18n';
import type { StylistStore } from '../stylist/stylist-store';
import { readStatus, statusOf, useStylist, useStylistStatus, viewOf, writeConsent } from '../stylist/use-stylist';
import { featureSwitch } from './ai-features-model';
import { ConsentSheet, FeatureRow } from './feature-row';
import { useConsentSheet } from './use-consent-sheet';

type Props = { store: StylistStore; busy: boolean; online: boolean; language: Language; t: Translate };
// Status is read on arrival, focus, visibility and reconnect, never while the profile is being saved; reads never write.
// Turn off stays available whenever consent is on, even when the stylist can't be used or this app version can't turn it on.
export function StylistSettings({ store, busy, online, language, t }: Props) {
  useStylistStatus(store);
  const state = useStylist(store);
  const view = viewOf(state);
  const status = statusOf(state);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const pressed = useRef<HTMLElement | null>(null);
  // After a pressed button is replaced, focus moves to the heading so it isn't lost. Passive refreshes never move focus.
  useEffect(() => {
    const button = pressed.current;
    if (!button || state.writing || state.reading) return;
    pressed.current = null;
    if (!button.isConnected && !store.scope.signal.aborted) heading.current?.focus();
  });
  const sheet = useConsentSheet(view.turnOn, state.writing);
  if (!view.card) return null;
  const policy = status?.policy ?? null;
  const budget = status?.budget ?? null;
  const limits = status ? stylistLimits(status) : null;
  const limit = budget ? usdCents(budget.monthlyAllowanceMicro, language, 'limit') : '';
  const stylistLimit = limit;
  const disabled = !online || busy || state.writing;
  const details = view.kind === 'off' || view.kind === 'renew' || view.kind === 'on' || view.kind === 'paused';
  const control = featureSwitch(view.turnOn, view.turnOff);
  const change = (enabled: boolean, button: HTMLElement | null) => { pressed.current = button; return writeConsent(store, enabled); };
  const value = (view.kind === 'off' || view.kind === 'renew') && budget ? t('aiF.upTo', { limit }) : null;
  const noticeList = <dl className="ai-notice fine">
    <dt>{t('stylistC.fieldsTitle')}</dt>
    <dd>{t('stylistC.fields')}</dd>
    <dt>{t('stylistC.processing')}</dt>
    <dd>{t('stylistC.azureNotice')}</dd>
    <dt>{t('aiC.retentionTitle')}</dt>
    <dd><p>{t('stylistC.trainingNotice')}</p><p>{t('stylistC.retention')}</p></dd>
    <dt>{t('aiC.chargesTitle')}</dt>
    <dd><p>{t('stylistC.chargeNotice')}</p><p>{t('stylistC.usageNotice')}</p><p>{t('stylistC.optOut')}</p></dd>
  </dl>;
  const line = view.kind === 'loadFailed' ? 'stylistC.loadFailed' : view.kind === 'unresolved' ? 'stylist.unresolved'
    : view.kind === 'unavailable' ? 'stylist.unavailable' : view.kind === 'paused' ? 'stylist.paused' : view.kind === 'renew' ? 'stylistC.changed' : null;
  const limitLine = view.kind !== 'on' || !budget || !policy ? null : limits?.reached ? 'stylist.limitShared'
    : limits?.warning ? 'stylist.sharedWarning' : null;
  return <FeatureRow id="stylist-heading" headingRef={heading} switchRef={switchButton} title={t('stylistC.settings')}
    description={t('stylistC.description')} value={value} busy={state.writing} control={control} switchDisabled={disabled}
    onSwitch={() => { if (control.checked) void change(false, switchButton.current); else sheet.show(); }}
    status={<>
      {line && <p>{t(line)}</p>}
      {limitLine && <p className="notice">{t(limitLine)}</p>}
      {state.writing && <p>{t('common.saving')}</p>}
    </>}
    actions={(view.turnOn && view.turnOff || view.kind === 'loadFailed' || view.kind === 'unresolved') && <div className="settings-actions">
      {view.turnOn && view.turnOff && <button type="button" className="text-button" disabled={disabled}
        onClick={(event) => { void change(false, event.currentTarget); }}>{t(state.writing ? 'common.saving' : 'aiC.disable')}</button>}
      {(view.kind === 'loadFailed' || view.kind === 'unresolved') && <button type="button" className="button button-secondary"
        disabled={!online || busy || state.reading || state.writing}
        onClick={(event) => { pressed.current = event.currentTarget; void readStatus(store, 'active'); }}>{t('common.retry')}</button>}
    </div>}
    error={state.settingsError && !(state.settingsError === 'stylistC.changed' && view.kind === 'renew')
      && <p role="alert" className="notice notice-error">{t(state.settingsError)}</p>}
    notice={details ? noticeList : null}
    sheet={sheet.open ? <ConsentSheet id="stylist" title={t('stylistC.turnOnTitle')} summary={t('stylistC.offSummary', { stylistLimit, limit })}
      notice={noticeList} writing={state.writing} disabled={disabled} t={t} onCancel={sheet.close}
      onConfirm={() => { void change(true, switchButton.current).finally(sheet.close); }} /> : null}
    t={t} />;
}
