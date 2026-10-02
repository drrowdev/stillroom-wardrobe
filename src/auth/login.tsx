import { useRef, useState, type FormEvent } from 'react';
import type { SessionController } from './session';
import type { Translate } from '../i18n';
import { Icon } from '../app/icon';

export function Login({ controller, online, t, onRecovery, onAuthActivity }: { controller: SessionController; online: boolean; t: Translate; onRecovery: () => void; onAuthActivity: () => void }) {
  // Uncontrolled: a re-render (a language arriving while someone types) never writes an older value back over the field.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [remember, setRemember] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!online || busy) return;
    onAuthActivity();
    setFailed(false);
    setBusy(true);
    try {
      await controller.signIn(emailRef.current?.value ?? '', passwordRef.current?.value ?? '', remember && controller.canRemember);
      if (passwordRef.current) passwordRef.current.value = '';
    }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return (
    <section className="entry-card" aria-labelledby="login-title">
      <div className="small-mark"><Icon name="wardrobe" /></div>
      <h1 id="login-title" tabIndex={-1}>{t('auth.signIn')}</h1>
      <form className="stack login-form" onChange={onAuthActivity} onSubmit={(event) => { void submit(event); }}>
        <div className="field">
          <label htmlFor="email">{t('auth.email')}</label>
          <input ref={emailRef} id="email" name="email" type="email" autoComplete="username" required disabled={busy} spellCheck={false} autoCapitalize="none" />
        </div>
        <div className="field">
          <label htmlFor="password">{t('auth.password')}</label>
          <div className="password-input">
            <input ref={passwordRef} id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required disabled={busy} />
            <button type="button" onClick={() => setVisible(!visible)} aria-pressed={visible}>{t(visible ? 'auth.hidePassword' : 'auth.showPassword')}</button>
          </div>
        </div>
        {controller.canRemember && <label className="check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />{t('auth.remember')}</label>}
        {failed && <p role="alert" className="notice notice-error">{t('auth.failed')}</p>}
        <button className="button button-primary button-wide" type="submit" disabled={!online || busy}>
          {busy ? <span className="spinner" /> : null}{t(busy ? 'auth.signingIn' : 'auth.signIn')}
        </button>
      </form>
      <button type="button" className="text-button" disabled={busy} onClick={onRecovery}>{t('recovery.forgot')}</button>
      <p className="fine muted">{t('auth.passwordHelp')}</p>
      <div className="entry-footer"><Icon name="lock" /><span>{t('auth.invited')}</span></div>
    </section>
  );
}
