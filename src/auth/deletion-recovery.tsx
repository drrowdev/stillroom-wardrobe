import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../data/client';
import type { OwnerScope, SessionController } from './session';
import { deleteAccount } from '../data/delete-account';
import { isAborted } from '../data/errors';
import type { MessageKey, Translate } from '../i18n';

type Props = {
  client: AppClient; controller: SessionController; scope: OwnerScope; deletion: 'in_progress' | 'retry' | 'contact';
  online: boolean; t: Translate; onSignOut: () => void;
};
const notices: Record<Props['deletion'], MessageKey | null> = { retry: null, in_progress: 'delete.inProgress', contact: 'delete.contact' };

// Shown when a frozen account signs in with its deletion unfinished. It needs no profile or data access:
// the password goes only to the deletion function, which continues the existing job.
export function DeletionRecovery({ client, controller, scope, deletion, online, t, onSignOut }: Props) {
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (problem) alert.current?.focus(); }, [problem]);

  async function submit() {
    if (!password || working || deletion === 'contact') return;
    setWorking(true); setProblem(null);
    try {
      const result = await deleteAccount(client, scope, password, scope.signal);
      if (scope.signal.aborted) return;
      if (result === 'complete') { await controller.signOut(true, 'delete.done'); return; }
      if (result === 'signed_out') { await controller.signOut(true); return; }
      if (result === 'in_progress' || result === 'retry' || result === 'contact') controller.deletionState(scope, result);
      setProblem(result === 'password' ? 'delete.wrongPassword' : result === 'retry' ? 'delete.retry'
        : result === 'in_progress' || result === 'contact' ? null : 'delete.failed');
    } catch (error) {
      if (!scope.signal.aborted && !isAborted(error)) setProblem('delete.failed');
    } finally {
      if (!scope.signal.aborted) { setPassword(''); setWorking(false); }
    }
  }

  const notice = notices[deletion];
  const ready = online && !working && password.length > 0 && deletion !== 'contact';
  return <section className="entry-card" aria-labelledby="deletion-recovery-title">
    <h1 id="deletion-recovery-title" ref={heading} tabIndex={-1}>{t('delete.recoveryTitle')}</h1>
    <p className="muted">{t('delete.recoveryBody')}</p>
    {!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}
    {notice && <p role="status" className="notice">{t(notice)}</p>}
    <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {deletion !== 'contact' && <div className="field">
        <label htmlFor="deletion-recovery-password">{t('delete.password')}</label>
        <input id="deletion-recovery-password" type="password" autoComplete="current-password" value={password} disabled={working}
          aria-invalid={problem === 'delete.wrongPassword' || undefined} onChange={(event) => { setPassword(event.target.value); }} />
      </div>}
      {problem && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(problem)}</p>}
      {deletion !== 'contact' && <button className="button button-danger" disabled={!ready} aria-busy={working || undefined}>{t('delete.finish')}</button>}
      {working && <p role="status">{t('delete.working')}</p>}
      <button type="button" className="button button-quiet" disabled={working} onClick={onSignOut}>{t('auth.signOut')}</button>
    </form>
  </section>;
}
