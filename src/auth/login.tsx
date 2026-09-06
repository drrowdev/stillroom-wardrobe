import { useState, type FormEvent } from 'react';
import type { SessionController } from './session';
import type { Translate } from '../i18n';
import { Icon } from '../app/icon';

export function Login({ controller, online, t, onRecovery }: { controller: SessionController; online: boolean; t: Translate; onRecovery: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!online || busy) return;
    setFailed(false);
    setBusy(true);
    try { await controller.signIn(email, password); setPassword(''); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return (
    <section className="entry-card" aria-labelledby="login-title">
      <div className="small-mark"><Icon name="wardrobe" /></div>
      <h1 id="login-title" tabIndex={-1}>{t('auth.welcome')}</h1>
      <p className="muted">{t('auth.subtitle')}</p>
      <form className="stack login-form" onSubmit={(event) => { void submit(event); }}>
        <div className="field">
          <label htmlFor="email">{t('auth.email')}</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy} spellCheck={false} autoCapitalize="none" />
        </div>
        <div className="field">
          <label htmlFor="password">{t('auth.password')}</label>
          <div className="password-input">
            <input id="password" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
            <button type="button" onClick={() => setVisible(!visible)} aria-pressed={visible}>{t(visible ? 'auth.hidePassword' : 'auth.showPassword')}</button>
          </div>
        </div>
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
