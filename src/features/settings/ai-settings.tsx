import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionController, OwnerScope } from '../../auth/session';
import { AiError, type AiClient } from '../../data/ai';
import type { ProfileRow } from '../../data/rows';
import { errorKey } from '../../data/errors';
import { aiCardState, aiNoticeProfile, aiPolicyBinding, type AiStatus } from '../../domain/ai-controls';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, MessageKey, Translate } from '../../i18n';
import { featureSwitch } from './ai-features-model';
import { ConsentSheet, FeatureRow } from './feature-row';
import { useConsentSheet } from './use-consent-sheet';

type Props = { ai: AiClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow;
  busy: boolean; unresolved: boolean; online: boolean; language: Language; t: Translate;
  /** Reports each status and load failure for the shared spending summary. */ onSpend?: (status: AiStatus | null, loadFailed: boolean) => void };
type Pending = 'on' | 'off' | 'retry' | null;
// Status is read on load, focus, visibility and reconnect; those reads never write. Only the sheet's Turn on and the switch's
// (or renew's) Turn off change consent.
export function AiSettings({ ai, controller, scope, profile, busy, unresolved, online, language, t, onSpend }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const sequence = useRef(0);
  const latch = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const card = aiCardState({ status, loadFailed, unresolved });
  useEffect(() => { onSpend?.(status, loadFailed); }, [onSpend, status, loadFailed]);
  const read = useCallback((supersede: boolean) => {
    if (scope.signal.aborted || latch.current) return;
    if (reading.current) {
      if (!supersede) return;
      reading.current.abort();
    }
    const own = new AbortController(), signal = AbortSignal.any([scope.signal, own.signal]), at = ++sequence.current;
    reading.current = own;
    void ai.status(signal).then((next) => {
      if (!signal.aborted && at === sequence.current) { setStatus(next); setLoadFailed(false); }
    }, () => {
      if (!signal.aborted && at === sequence.current) setLoadFailed(true);
    }).finally(() => { if (reading.current === own) reading.current = null; });
  }, [ai, scope]);
  useEffect(() => { read(true); }, [read, profile.version]);
  useEffect(() => () => { reading.current?.abort(); reading.current = null; }, []);
  // After a pressed button is replaced, focus moves to the heading so it isn't lost. Passive refreshes never move focus.
  const pressedButton = useRef<HTMLElement | null>(null);
  const keepFocus = useCallback((pressed: HTMLElement | null) => { pressedButton.current = pressed; }, []);
  useEffect(() => {
    const pressed = pressedButton.current;
    if (!pressed || pending !== null) return;
    pressedButton.current = null;
    if (!pressed.isConnected && !scope.signal.aborted) heading.current?.focus();
  });
  const reconcile = useCallback(async (pressed: HTMLElement | null) => {
    // The live value, because an 'online' event can run this before the online prop has re-rendered.
    if (latch.current || busy || !navigator.onLine || scope.signal.aborted) return;
    latch.current = true; ++sequence.current; reading.current?.abort(); reading.current = null;
    if (pressed) { setPending('retry'); setError(null); }
    try {
      const next = await controller.reconcileAiConsent(scope, ai);
      if (!scope.signal.aborted) { setStatus(next); setLoadFailed(false); setError(null); }
    } catch (failure) { if (!scope.signal.aborted && pressed) setError(errorKey(failure)); }
    finally {
      latch.current = false;
      if (!scope.signal.aborted) { setPending(null); if (pressed) keepFocus(pressed); }
    }
  }, [ai, busy, controller, keepFocus, scope]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || busy) return;
      if (unresolved) void reconcile(null);
      else read(false);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [busy, read, reconcile, unresolved]);
  async function change(enabled: boolean, pressed: HTMLElement | null) {
    if (latch.current || busy || !online || !status || (enabled ? !card.turnOn : !card.turnOff)) return;
    const binding = enabled ? aiPolicyBinding(scope, status) : null;
    latch.current = true; ++sequence.current; reading.current?.abort(); reading.current = null;
    setPending(enabled ? 'on' : 'off'); setError(null);
    let changed = false;
    try {
      const next = await controller.saveAiConsent(scope, profile, ai, enabled, enabled ? status.policy?.noticeRevision ?? null : null, binding);
      if (!scope.signal.aborted) { setStatus(next); setLoadFailed(false); }
    } catch (failure) {
      if (scope.signal.aborted) return;
      changed = failure instanceof AiError && failure.code === 'CONFIG_CHANGED';
      setError(changed ? 'aiC.changed' : errorKey(failure));
    } finally {
      latch.current = false;
      if (!scope.signal.aborted) { setPending(null); keepFocus(pressed); if (changed) read(true); }
    }
  }
  const policy = status?.policy ?? null;
  const notice = aiNoticeProfile(policy);
  const limit = policy ? usdCents(policy.monthlyAllowanceMicro, language, 'limit') : '';
  const disabled = !online || busy || pending !== null;
  // The sheet shows this notice for this policy; any change to either closes it without writing.
  const sheet = useConsentSheet(card.turnOn, pending === 'on', status ? `${notice}|${aiPolicyBinding(scope, status)}` : null);
  const control = featureSwitch(card.turnOn, card.turnOff);
  const repeated = error === 'aiC.reconcile' && card.state === 'unconfirmed'
    || error === 'aiC.changed' && (card.state === 'renew' || card.state === 'unavailable');
  const noticeList = <dl className="ai-notice fine">
    <dt>{t('aiC.processing')}</dt>
    <dd>{t(notice === 'google' ? 'aiC.notice' : 'aiC.azureNotice')}</dd>
    <dt>{t('aiC.retentionTitle')}</dt>
    <dd><p>{t(notice === 'google' ? 'aiC.trainingNotice' : 'aiC.azureTrainingNotice')}</p><p>{t('aiC.retentionNotice')}</p></dd>
    <dt>{t('aiC.chargesTitle')}</dt>
    <dd><p>{t('aiC.allowanceNotice')}</p><p>{t('aiC.usageNotice')}</p><p>{t('aiC.optOutNotice')}</p></dd>
  </dl>;
  const state: MessageKey | null = card.state === 'unconfirmed' ? 'aiC.reconcile' : card.state === 'loadFailed' ? 'aiC.loadFailed'
    : card.state === 'unavailable' ? 'aiC.inactive' : card.state === 'renew' ? 'aiC.changed' : null;
  return <FeatureRow id="ai-consent-title" headingRef={heading} switchRef={switchButton} title={t('aiC.settings')}
    description={t('aiC.description')} value={null} busy={card.state === 'loading' || pending !== null}
    control={control} switchDisabled={disabled}
    onSwitch={() => { if (control.checked) void change(false, switchButton.current); else sheet.show(); }}
    status={<>
      {state && <p>{t(state)}</p>}
      {pending !== null && pending !== 'retry' && <p>{t('common.saving')}</p>}
    </>}
    actions={(card.retry || card.turnOn && card.turnOff) && <div className="settings-actions">
      {card.turnOn && card.turnOff && <button type="button" className="text-button" disabled={disabled}
        onClick={(event) => { void change(false, event.currentTarget); }}>{t(pending === 'off' ? 'common.saving' : 'aiC.disable')}</button>}
      {card.retry && <button type="button" className="button button-secondary" disabled={!online || busy || pending !== null}
        onClick={(event) => { if (card.state === 'unconfirmed') void reconcile(event.currentTarget); else read(true); }}>{t('common.retry')}</button>}
    </div>}
    error={error && !repeated && <p role="alert" className="notice notice-error">{t(error)}</p>}
    notice={card.details ? noticeList : null}
    sheet={sheet.open && status ? <ConsentSheet id="ai-consent" title={t('aiC.turnOnTitle')} summary={t('aiC.offSummary', { limit })}
      notice={noticeList} writing={pending === 'on'} disabled={disabled} t={t} onCancel={sheet.close}
      onConfirm={() => { void change(true, switchButton.current).finally(sheet.close); }} /> : null}
    t={t} />;
}
