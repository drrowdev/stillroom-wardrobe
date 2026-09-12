import { useEffect, useRef, useState } from 'react';
import type { SessionController, OwnerScope } from '../../auth/session';
import type { AiClient } from '../../data/ai';
import type { ProfileRow } from '../../data/rows';
import { errorKey } from '../../data/errors';
import { supportedAiPolicy, type AiStatus } from '../../domain/ai-controls';
import { microUsd } from '../../domain/ai-presentation';
import type { Language, MessageKey, Translate } from '../../i18n';

type Props = { ai: AiClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow;
  busy: boolean; unresolved: boolean; online: boolean; language: Language; t: Translate };
export function AiSettings({ ai, controller, scope, profile, busy, unresolved, online, language, t }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [reading, setReading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const sequence = useRef(0);
  const latch = useRef(false);
  useEffect(() => {
    const signal = new AbortController(), at = ++sequence.current;
    void ai.status(signal.signal).then((next) => {
      if (!signal.signal.aborted && at === sequence.current) { setStatus(next); setError(null); }
    }, (failure: unknown) => {
      if (!signal.signal.aborted && !scope.signal.aborted && at === sequence.current) setError(errorKey(failure));
    });
    return () => signal.abort();
  }, [ai, scope, profile.version]);
  async function change(enabled: boolean) {
    if (latch.current || busy || reading || !online || unresolved || !status || enabled && !agreed) return;
    latch.current = true; ++sequence.current; setError(null);
    try {
      const next = await controller.saveAiConsent(scope, profile, ai, enabled, enabled ? status.policy?.noticeRevision ?? null : null);
      if (!scope.signal.aborted) { setStatus(next); setAgreed(false); }
    } catch (failure) { if (!scope.signal.aborted) setError(errorKey(failure)); }
    finally { latch.current = false; }
  }
  async function reconcile() {
    if (latch.current || busy || !online) return;
    latch.current = true; ++sequence.current; setReading(true); setError(null);
    try {
      const next = await controller.reconcileAiConsent(scope, ai);
      if (!scope.signal.aborted) setStatus(next);
    } catch (failure) { if (!scope.signal.aborted) setError(errorKey(failure)); }
    finally { latch.current = false; if (!scope.signal.aborted) setReading(false); }
  }
  const supported = status && supportedAiPolicy(status);
  return <section className="settings-card" aria-labelledby="ai-consent-title" aria-busy={busy || reading}>
    <h2 id="ai-consent-title">{t('aiC.settings')}</h2>
    <p>{t('aiC.notice')}</p><p className="fine muted">{t('aiC.allowanceNotice')}</p>
    <p role="status">{t(unresolved ? 'aiC.reconcile' : busy || reading ? 'aiC.controlPending'
      : !supported ? 'aiC.inactive' : status?.consent.enabled ? 'aiC.enabled' : 'aiC.disabled')}</p>
    {status?.policy && <dl>
      <dt>{t('aiC.model')}</dt><dd>{status.policy.modelId}</dd>
      <dt>{t('aiC.allowance')}</dt><dd>{microUsd(status.policy.monthlyAllowanceMicro, language)}</dd>
      <dt>{t('aiC.accounted')}</dt><dd>{microUsd(status.usage.accountedMicro, language)}</dd>
    </dl>}
    {status?.usage.warning && <p className="notice">{t('aiC.warning')}</p>}
    <label><input type="checkbox" checked={agreed} disabled={!supported || busy || reading || unresolved}
      onChange={(event) => setAgreed(event.target.checked)} />{t('aiC.agree')}</label>
    <div className="settings-actions">
      <button className="button button-primary" disabled={!online || busy || reading || unresolved || !supported || !agreed}
        onClick={() => { void change(true); }}>{t('aiC.enable')}</button>
      <button className="button button-secondary" disabled={!online || busy || reading || unresolved || !status?.consent.enabled}
        onClick={() => { void change(false); }}>{t('aiC.disable')}</button>
      <button className="text-button" disabled={!online || busy || reading} onClick={() => { void reconcile(); }}>{t('aiC.checkConsent')}</button>
    </div>
    {error && <p role="alert" className="notice notice-error">{t(error)}</p>}
  </section>;
}
