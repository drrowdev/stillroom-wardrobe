import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope, SessionController } from '../../auth/session';
import { deleteAccount } from '../../data/delete-account';
import { isAborted } from '../../data/errors';
import type { MessageKey, Translate } from '../../i18n';

type Props = { client: AppClient; controller: SessionController; scope: OwnerScope; online: boolean; t: Translate };
const messages: Record<string, MessageKey> = {
  password: 'delete.wrongPassword', retry: 'delete.retry', in_progress: 'delete.inProgress', contact: 'delete.contact', failed: 'delete.failed',
};

// The password is held only while the request runs; it is never stored and is cleared after every attempt.
export function DeleteAccountSettings({ client, controller, scope, online, t }: Props) {
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const clear = () => { request.current?.abort(); request.current = null; setPassword(''); setUnderstood(false); setPhrase(''); setWorking(false); setProblem(null); setOpen(false); };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope]);
  useEffect(() => { if (problem) alert.current?.focus(); }, [problem]);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);

  function cancel() { setOpen(false); setPassword(''); setUnderstood(false); setPhrase(''); setProblem(null); }

  function backupFirst() {
    const target = document.querySelector<HTMLElement>('.backup-card button');
    target?.scrollIntoView({ block: 'center' });
    target?.focus();
  }
  const expected = t('delete.phraseValue');
  const phraseMatches = phrase.trim().toLocaleLowerCase() === expected.toLocaleLowerCase();
  async function submit() {
    if (!password || !understood || !phraseMatches || working) return;
    const controllerSignal = new AbortController();
    request.current = controllerSignal;
    setWorking(true); setProblem(null);
    try {
      const result = await deleteAccount(client, scope, password, controllerSignal.signal);
      if (controllerSignal.signal.aborted || scope.signal.aborted) return;
      if (result === 'complete') { await controller.signOut(true, 'delete.done'); return; }
      if (result === 'signed_out') { await controller.signOut(true); return; }
      setProblem(messages[result] ?? 'delete.failed');
    } catch (error) {
      if (!scope.signal.aborted && !isAborted(error)) setProblem('delete.failed');
    } finally {
      if (!scope.signal.aborted) { setPassword(''); setWorking(false); }
      if (request.current === controllerSignal) request.current = null;
    }
  }

  const ready = online && !working && password.length > 0 && understood && phraseMatches && problem !== 'delete.contact';
  return <section className="settings-card delete-card" aria-labelledby="delete-heading">
    <h2 id="delete-heading">{t('delete.title')}</h2>
    <p>{t('delete.body')}</p>
    <p className="muted fine">{t('delete.limits')}</p>
    <div className="stack delete-actions">
      <button type="button" className="text-button" onClick={backupFirst}>{t('delete.backupFirst')}</button>
      {!open && <button type="button" className="button button-danger" disabled={!online} onClick={() => { setOpen(true); }}>{t('delete.title')}</button>}
    </div>
    {open && <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="field">
        <label htmlFor="delete-password">{t('delete.password')}</label>
        <input id="delete-password" ref={field} type="password" autoComplete="current-password" value={password} disabled={working}
          aria-invalid={problem === 'delete.wrongPassword' || undefined} onChange={(event) => { setPassword(event.target.value); }} />
      </div>
      <label className="check">
        <input type="checkbox" checked={understood} disabled={working} onChange={(event) => { setUnderstood(event.target.checked); }} />
        <span>{t('delete.confirm')}</span>
      </label>
      <div className="field">
        <label htmlFor="delete-phrase">{t('delete.phraseLabel', { phrase: expected })}</label>
        <input id="delete-phrase" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} disabled={working}
          onChange={(event) => { setPhrase(event.target.value); }} />
      </div>
      {problem && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(problem)}</p>}
      <button className="button button-danger" disabled={!ready} aria-busy={working || undefined}>{t('delete.button')}</button>
      {working && <p role="status">{t('delete.working')}</p>}
      <button type="button" className="text-button" disabled={working} onClick={cancel}>{t('common.cancel')}</button>
    </form>}
  </section>;
}
