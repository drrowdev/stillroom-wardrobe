import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionController, OwnerScope } from '../../auth/session';
import { AiError, type AiClient } from '../../data/ai';
import type { ProfileRow } from '../../data/rows';
import { errorKey } from '../../data/errors';
import { aiCardState, aiNoticeProfile, aiPolicyBinding, type AiStatus } from '../../domain/ai-controls';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, MessageKey, Translate } from '../../i18n';

type Props = { ai: AiClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow;
  busy: boolean; unresolved: boolean; online: boolean; language: Language; t: Translate };
type Pending = 'on' | 'off' | 'retry' | null;
// Status is read on load, focus, visibility and reconnect; those reads never write. Only Turn on and Turn off change consent.
export function AiSettings({ ai, controller, scope, profile, busy, unresolved, online, language, t }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const sequence = useRef(0);
  const latch = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const card = aiCardState({ status, loadFailed, unresolved });
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
  async function change(enabled: boolean, pressed: HTMLElement) {
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
  const title: MessageKey = card.state === 'on' ? 'aiC.enabled' : card.state === 'off' || card.state === 'renew' ? 'aiC.disabled' : 'aiC.settings';
  const repeated = error === 'aiC.reconcile' && card.state === 'unconfirmed'
    || error === 'aiC.changed' && (card.state === 'renew' || card.state === 'unavailable');
  return <section className="settings-card ai-card" aria-labelledby="ai-consent-title" aria-busy={card.state === 'loading' || pending !== null}>
    <div role="status" className="ai-state">
      <h2 id="ai-consent-title" ref={heading} tabIndex={-1}>{t(title)}</h2>
      {card.state === 'unconfirmed' && <p>{t('aiC.reconcile')}</p>}
      {card.state === 'loadFailed' && <p>{t('aiC.loadFailed')}</p>}
      {card.state === 'unavailable' && <p>{t('aiC.inactive')}</p>}
      {card.state === 'renew' && <p>{t('aiC.changed')}</p>}
      {card.state === 'on' && status && <p className="ai-usage">{t('aiC.usage', { used: usdCents(status.usage.accountedMicro, language, 'used'), limit })}</p>}
      {card.state === 'on' && status?.usage.warning && <p className="notice">{t('aiC.warning')}</p>}
    </div>
    {(card.state === 'off' || card.state === 'renew') && <p>{t('aiC.offSummary', { limit })}</p>}
    {card.details && <details className="ai-details">
      <summary>{t('aiC.details')}</summary>
      <dl className="ai-notice fine">
        <dt>{t('aiC.processing')}</dt>
        <dd>{t(notice === 'google' ? 'aiC.notice' : 'aiC.azureNotice')}</dd>
        <dt>{t('aiC.retentionTitle')}</dt>
        <dd><p>{t(notice === 'google' ? 'aiC.trainingNotice' : 'aiC.azureTrainingNotice')}</p><p>{t('aiC.retentionNotice')}</p></dd>
        <dt>{t('aiC.chargesTitle')}</dt>
        <dd><p>{t('aiC.allowanceNotice')}</p><p>{t('aiC.usageNotice')}</p><p>{t('aiC.optOutNotice')}</p></dd>
      </dl>
    </details>}
    {(card.turnOn || card.turnOff || card.retry) && <div className="settings-actions">
      {card.turnOn && <button type="button" className="button button-primary" disabled={disabled}
        onClick={(event) => { void change(true, event.currentTarget); }}>{t(pending === 'on' ? 'common.saving' : 'aiC.enable')}</button>}
      {card.turnOff && <button type="button" className={card.turnOn ? 'text-button' : 'button button-secondary'} disabled={disabled}
        onClick={(event) => { void change(false, event.currentTarget); }}>{t(pending === 'off' ? 'common.saving' : 'aiC.disable')}</button>}
      {card.retry && <button type="button" className="button button-secondary" disabled={!online || busy || pending !== null}
        onClick={(event) => { if (card.state === 'unconfirmed') void reconcile(event.currentTarget); else read(true); }}>{t('common.retry')}</button>}
    </div>}
    {error && !repeated && <p role="alert" className="notice notice-error">{t(error)}</p>}
  </section>;
}