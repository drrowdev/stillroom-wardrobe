import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { PublicConfig } from '../data/config';
import type { MessageKey, Translate } from '../i18n';
import { passwordProblem, recoveryAttempt, recoveryPasswordMinimum } from './recovery';
import type { RecoveryLink } from './recovery-callback';

export function PasswordRecovery({ config, link, online, t, onReturn }: {
  config: PublicConfig; link: RecoveryLink; online: boolean; t: Translate; onReturn: (notice?: MessageKey) => void;
}) {
  const [attempt] = useState(() => recoveryAttempt(config, link));
  const state = useSyncExternalStore(attempt.subscribe, attempt.getSnapshot);
  const [confirmed, setConfirmed] = useState(false);
  // Uncontrolled, so a re-render while someone types (a language arriving) never writes an older value back.
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const clearFields = useCallback(() => {
    if (passwordRef.current) passwordRef.current.value = '';
    if (confirmationRef.current) confirmationRef.current.value = '';
  }, []);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  useEffect(() => attempt.retain(), [attempt]);
  useEffect(() => attempt.subscribe(() => {
    if (attempt.getSnapshot().phase === 'failed') {
      clearFields(); setConfirmed(false); setVisible(false); setError(null);
    }
  }), [attempt, clearFields]);
  useEffect(() => {
    document.getElementById(state.phase === 'password' ? 'recovery-password' : 'recovery-title')?.focus();
    if (state.phase === 'success') onReturn(state.notice);
  }, [state.phase, state.notice, onReturn]);
  useEffect(() => { if (error) document.getElementById('recovery-error')?.focus(); }, [error]);
  const busy = state.phase === 'updating' || state.phase === 'revoking';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!online || busy) return;
    const password = passwordRef.current?.value ?? '', confirmation = confirmationRef.current?.value ?? '';
    const problem = passwordProblem(password, confirmation);
    setError(problem);
    if (problem) return;
    try { await attempt.update(password, confirmation, clearFields); }
    finally { clearFields(); }
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
      <p className="fine muted" id="recovery-password-hint">{t('recovery.passwordHint', { minimum: recoveryPasswordMinimum })}</p>
      <div className="field">
        <label htmlFor="recovery-password">{t('recovery.newPassword')}</label>
        <div className="password-input">
          <input ref={passwordRef} id="recovery-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={busy}
            aria-invalid={Boolean(error)} aria-describedby={fieldError ?? 'recovery-password-hint'} />
          <button type="button" disabled={busy} aria-pressed={visible} onClick={() => setVisible(!visible)}>{t(visible ? 'auth.hidePassword' : 'auth.showPassword')}</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="recovery-confirm-password">{t('recovery.repeatPassword')}</label>
        <input ref={confirmationRef} id="recovery-confirm-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={busy}
          aria-invalid={Boolean(error)} aria-describedby={fieldError ?? 'recovery-password-hint'} />
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
