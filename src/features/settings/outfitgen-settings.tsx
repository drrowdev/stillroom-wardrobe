import { useEffect, useRef } from 'react';
import { outfitGenLimits } from '../../domain/outfitgen-app';
import type { Translate } from '../../i18n';
import '../../i18n/outfitgen';
import { readStatus, statusOf, viewOf, writeConsent, type OutfitGenStore } from '../outfitgen/outfitgen-store';
import { useOutfitGen, useOutfitGenStatus } from '../outfitgen/use-outfitgen';
import { featureSwitch } from './ai-features-model';
import { ConsentSheet, FeatureRow } from './feature-row';
import { useConsentSheet } from './use-consent-sheet';

type Props = { store: OutfitGenStore; busy: boolean; online: boolean; t: Translate };

/** The Settings card. It is absent until the backend has outfit generation; Turn off stays available whenever consent is on. */
export function OutfitGenSettings({ store, busy, online, t }: Props) {
  useOutfitGenStatus(store);
  const state = useOutfitGen(store);
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
  const limits = status ? outfitGenLimits(status) : null;
  const disabled = !online || busy || state.writing;
  const control = featureSwitch(view.turnOn, view.turnOff);
  const details = view.kind === 'off' || view.kind === 'renew' || view.kind === 'on' || view.kind === 'paused';
  const change = (enabled: boolean, button: HTMLElement | null) => { pressed.current = button; return writeConsent(store, enabled); };
  const noticeList = <dl className="ai-notice fine">
    <dt>{t('stylistC.fieldsTitle')}</dt>
    <dd><p>{t('outfitgenC.sent')}</p><p>{t('outfitgenC.when')}</p><p>{t('outfitgenC.pictures')}</p></dd>
    <dt>{t('stylistC.processing')}</dt>
    <dd>{t('outfitgenC.processing')}</dd>
    <dt>{t('aiC.retentionTitle')}</dt>
    <dd><p>{t('aiC.azureTrainingNotice')}</p><p>{t('outfitgenC.stored')}</p></dd>
    <dt>{t('aiC.chargesTitle')}</dt>
    <dd><p>{t('outfitgenC.charges')}</p><p>{t('outfitgenC.optOut2')}</p></dd>
  </dl>;
  const line = view.kind === 'loadFailed' ? 'outfitgenC.loadFailed' : view.kind === 'unresolved' ? 'stylist.unresolved'
    : view.kind === 'unavailable' ? 'outfitgenC.unavailable' : view.kind === 'paused' ? 'outfitgenC.paused' : view.kind === 'renew' ? 'outfitgenC.changed' : null;
  const limitLine = view.kind !== 'on' ? null : limits?.reached ? 'outfitgenC.limit' : limits?.warning ? 'stylist.sharedWarning' : null;
  return <FeatureRow id="outfitgen-heading" headingRef={heading} switchRef={switchButton} title={t('outfitgenC.settings')}
    description={t('outfitgenC.description')} busy={state.writing} control={control} switchDisabled={disabled}
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
        onClick={(event) => { pressed.current = event.currentTarget; void readStatus(store, 'fresh'); }}>{t('common.retry')}</button>}
    </div>}
    error={state.settingsError && !(state.settingsError === 'outfitgenC.changed' && view.kind === 'renew')
      && <p role="alert" className="notice notice-error">{t(state.settingsError)}</p>}
    notice={details ? noticeList : null}
    sheet={sheet.open ? <ConsentSheet id="outfitgen" title={t('outfitgenC.turnOnTitle')} notice={noticeList} writing={state.writing}
      disabled={disabled} t={t} onCancel={sheet.close}
      onConfirm={() => { void change(true, switchButton.current).finally(sheet.close); }} /> : null}
    t={t} />;
}
