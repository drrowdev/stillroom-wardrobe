import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PublicConfig } from '../data/config';
import { locales, type Language, type MessageKey, type Translate } from '../i18n';
import { recoveryError, recoveryRequestWait, requestRecovery } from './recovery';
import { logoutKey } from './session';

export function RecoveryRequest({ config, t, language, online, onReturn }: {
  config: PublicConfig; t: Translate; language: Language; online: boolean; onReturn: () => void;
}) {
  // Uncontrolled, so a re-render while someone types (a language arriving) never writes an older value back.
  const emailRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [wait, setWait] = useState(recoveryRequestWait);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    request.current = abort;
    const cancel = () => { abort.abort(); onReturn(); };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(logoutKey) : null;
    if (channel) channel.onmessage = cancel;
    const storage = (event: StorageEvent) => { if (event.key === logoutKey && event.newValue) cancel(); };
    window.addEventListener('storage', storage);
    document.getElementById('recovery-title')?.focus();
    const timer = setInterval(() => setWait(recoveryRequestWait()), 1000);
    return () => { abort.abort(); clearInterval(timer); channel?.close(); window.removeEventListener('storage', storage); };
  }, [onReturn]);
  useEffect(() => { if (error) document.getElementById('recovery-error')?.focus(); }, [error]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const signal = request.current?.signal;
    if (busy || !online || recoveryRequestWait() || !signal || signal.aborted) return;
    setBusy(true); setError(null); setAcknowledged(false);
    try {
      await requestRecovery(config, emailRef.current?.value ?? '', signal);
      if (!signal.aborted) { setAcknowledged(true); if (emailRef.current) emailRef.current.value = ''; }
    } catch (problem) { if (!signal.aborted) setError(recoveryError(problem)); }
    finally { if (!signal.aborted) { setBusy(false); setWait(recoveryRequestWait()); } }
  }
  return <section className="entry-card recovery-card" aria-labelledby="recovery-title">
    <h1 id="recovery-title" tabIndex={-1}>{t('recovery.requestTitle')}</h1>
    <p className="muted">{t('recovery.requestHelp')}</p>
    {!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}
    <form className="stack login-form" onSubmit={event => { void submit(event); }}>
      <div className="field">
        <label htmlFor="recovery-email">{t('auth.email')}</label>
        <input ref={emailRef} id="recovery-email" name="email" type="email" autoComplete="username" required maxLength={320}
          spellCheck={false} autoCapitalize="none" disabled={busy} />
      </div>
      {error && <p id="recovery-error" tabIndex={-1} role="alert" className="notice notice-error">{t(error)}</p>}
      {acknowledged && <p role="status" className="notice notice-success">{t('recovery.acknowledgement')}</p>}
      <button type="submit" className="button button-primary button-wide" disabled={busy || !online || wait > 0}>
        {t(busy ? 'recovery.requesting' : 'recovery.send')}
      </button>
      {wait > 0 && <p className="fine muted">{t('recovery.wait', { seconds: new Intl.NumberFormat(locales[language]).format(wait) })}</p>}
      <button type="button" className="button button-quiet" onClick={onReturn}>{t('recovery.return')}</button>
    </form>
  </section>;
}
