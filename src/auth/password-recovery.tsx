import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { PublicConfig } from '../data/config';
import { locales, type Language, type MessageKey, type Translate } from '../i18n';
import {
  passwordProblem, recoveryAttempt, recoveryError, recoveryPasswordMaximumBytes,
  recoveryPasswordMinimum, recoveryRequestWait, requestRecovery,
} from './recovery';
import type { RecoveryLink } from './recovery-callback';
import { logoutKey } from './session';

export function RecoveryRequest({ config, t, language, online, onReturn }: {
  config: PublicConfig; t: Translate; language: Language; online: boolean; onReturn: () => void;
}) {
  const [email, setEmail] = useState('');
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
      await requestRecovery(config, email, signal);
      if (!signal.aborted) { setAcknowledged(true); setEmail(''); }
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
        <input id="recovery-email" type="email" autoComplete="username" required maxLength={320}
          spellCheck={false} autoCapitalize="none" value={email} disabled={busy}
          onChange={event => setEmail(event.target.value)} />
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

export function PasswordRecovery({ config, link, online, t, onReturn }: {
  config: PublicConfig; link: RecoveryLink; online: boolean; t: Translate; onReturn: (notice?: MessageKey) => void;
}) {
  const [attempt] = useState(() => recoveryAttempt(config, link));
  const state = useSyncExternalStore(attempt.subscribe, attempt.getSnapshot);
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  useEffect(() => attempt.retain(), [attempt]);
  useEffect(() => attempt.subscribe(() => {
    if (attempt.getSnapshot().phase === 'failed') {
      setPassword(''); setConfirmation(''); setConfirmed(false); setVisible(false); setError(null);
    }
  }), [attempt]);
  useEffect(() => {
    document.getElementById(state.phase === 'password' ? 'recovery-password' : 'recovery-title')?.focus();
    if (state.phase === 'success') onReturn(state.notice);
  }, [state.phase, state.notice, onReturn]);
  useEffect(() => { if (error) document.getElementById('recovery-error')?.focus(); }, [error]);
  const busy = state.phase === 'updating' || state.phase === 'revoking';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!online || busy) return;
    const problem = passwordProblem(password, confirmation);
    setError(problem);
    if (problem) return;
    try { await attempt.update(password, confirmation, () => { setPassword(''); setConfirmation(''); }); }
    finally { setPassword(''); setConfirmation(''); }
  }
  const fieldError = error ? 'recovery-error' : undefined;
  return <section className="entry-card recovery-card" aria-labelledby="recovery-title">
    <h1 id="recovery-title" tabIndex={-1}>{t(state.phase === 'confirm' ? 'recovery.confirmTitle' : 'recovery.passwordTitle')}</h1>
    {!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}
    {state.phase === 'verifying' && <p role="status">{t('recovery.verifying')}</p>}
    {state.phase === 'confirm' && <div className="stack">
      <p>{t('recovery.target', { email: state.email! })}</p>
      <label className="recovery-confirm">
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        <span>{t('recovery.confirm')}</span>
      </label>
      <button type="button" className="button button-primary" disabled={!confirmed || !online} onClick={() => attempt.confirm()}>{t('recovery.continue')}</button>
      <button type="button" className="button button-quiet" onClick={() => onReturn()}>{t('recovery.notMine')}</button>
    </div>}
    {(state.phase === 'password' || state.phase === 'updating') && <form className="stack login-form" onSubmit={event => { void submit(event); }}>
      <p className="fine muted" id="recovery-password-hint">{t('recovery.passwordHint', { minimum: recoveryPasswordMinimum, maximum: recoveryPasswordMaximumBytes })}</p>
      <div className="field">
        <label htmlFor="recovery-password">{t('recovery.newPassword')}</label>
        <div className="password-input">
          <input id="recovery-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={busy}
            aria-invalid={Boolean(error)} aria-describedby={fieldError ?? 'recovery-password-hint'}
            value={password} onChange={event => setPassword(event.target.value)} />
          <button type="button" disabled={busy} aria-pressed={visible} onClick={() => setVisible(!visible)}>{t(visible ? 'auth.hidePassword' : 'auth.showPassword')}</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="recovery-confirm-password">{t('recovery.repeatPassword')}</label>
        <input id="recovery-confirm-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={busy}
          aria-invalid={Boolean(error)} aria-describedby={fieldError ?? 'recovery-password-hint'}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      </div>
      {error && <p id="recovery-error" role="alert" tabIndex={-1} className="notice notice-error">{t(error)}</p>}
      <p className="fine muted">{t('recovery.revocationHelp')}</p>
      <button type="submit" className="button button-primary" disabled={!online || busy}>{t(busy ? 'recovery.updating' : 'recovery.update')}</button>
      {busy && <p role="status">{t('recovery.updating')}</p>}
    </form>}
    {state.phase === 'revoking' && <p role="status">{t('recovery.revoking')}</p>}
    {state.phase === 'failed' && <p role="alert" className="notice notice-error">{t(state.notice ?? 'recovery.invalid', state.minimum ? { minimum: state.minimum } : undefined)}</p>}
    {state.phase !== 'confirm' && <button type="button" className="button button-quiet button-wide"
      onClick={() => onReturn(state.phase === 'revoking' ? 'recovery.revocationUncertain' : busy ? 'recovery.uncertain' : undefined)}>{t('recovery.return')}</button>}
    <p className="fine muted">{t('recovery.memoryOnly')}</p>
  </section>;
}
