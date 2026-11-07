import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiClient } from '../../data/ai';
import { AI_GUARD_RESUMED_EVENT, type AiGuardStatus } from '../../domain/ai-guard';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, Translate } from '../../i18n';

type Props = { ai: AiClient; language: Language; online: boolean; t: Translate };

/**
 * AI-GUARD1: shown at the top of the AI features card only while the spending guard has paused the account. It is read when
 * Settings opens and when the page returns, never written by a read; Resume is the owner's explicit choice. A failed read
 * says nothing (the guard is an emergency stop, not a status the owner needs to watch).
 */
export function AiGuardNotice({ ai, language, online, t }: Props) {
  const [status, setStatus] = useState<AiGuardStatus | null>(null);
  const [resuming, setResuming] = useState(false);
  const [failed, setFailed] = useState(false);
  const reading = useRef<AbortController | null>(null);
  // Set when the owner pressed Resume: once the notice has actually left the page, focus goes to the page title.
  const refocus = useRef(false);
  const read = useCallback(async (): Promise<AiGuardStatus | null> => {
    reading.current?.abort();
    const controller = reading.current = new AbortController();
    try {
      const result = await ai.guardStatus(controller.signal);
      if (controller.signal.aborted) return null;
      setStatus(result.kind === 'ready' ? result.status : null);
      // A confirmed unpaused account re-opens whatever stopped on PAUSED, however the pause ended (a Resume whose reply was lost included).
      if (result.kind === 'ready' && !result.status.paused) window.dispatchEvent(new Event(AI_GUARD_RESUMED_EVENT));
      return result.kind === 'ready' ? result.status : null;
    } catch { return null; /* a failed read keeps what is shown */ }
  }, [ai]);
  useEffect(() => {
    if (status?.paused || !refocus.current) return;
    refocus.current = false;
    document.getElementById('settings-title')?.focus();
  }, [status]);
  useEffect(() => {
    void read();
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void read(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      reading.current?.abort();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [read]);
  const resume = async () => {
    setResuming(true); setFailed(false); refocus.current = true;
    try {
      const result = await ai.resumeGuard();
      if (result !== 'OK') setFailed(true);
    } catch { setFailed(true); }
    // The status read decides what happened, whatever the Resume reply was.
    const after = await read();
    // Still paused (or unknown): the pressed button stays, so focus stays on it.
    if (after?.paused !== false) refocus.current = false;
    setResuming(false);
  };
  if (!status?.paused) return null;
  return <section className="notice ai-guard" aria-labelledby="ai-guard-title">
    <h3 id="ai-guard-title">{t('aiGuard.title')}</h3>
    <p>{t('aiGuard.body')}</p>
    <p className="fine">{t('aiGuard.amounts', { spent: usdCents(status.spentMicro, language, 'used'), limit: usdCents(status.limitMicro, language, 'limit') })}</p>
    {failed && <p role="alert" className="notice notice-error">{t('aiGuard.resumeFailed')}</p>}
    <button id="ai-guard-resume" type="button" className="button button-primary" disabled={!online || resuming}
      onClick={() => { void resume(); }}>{t(resuming ? 'common.saving' : 'aiGuard.resume')}</button>
  </section>;
}
