import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import { errorKey, isAborted } from '../../data/errors';
import { checkBackup, RestoreRecheckError, restoreReport, runRestore, type RestorePreview, type RestoreProgress, type RestoreResult } from '../../data/restore';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';

type Props = { client: AppClient; scope: OwnerScope; language: Language; online: boolean; t: Translate };
// 'recheck' shows the form again after a photo changed since Check, without the preview it can no longer run; 'incomplete'
// keeps the result when blocked items remain. `report` keeps what a run that stopped early did write.
type State = { kind: 'idle'; recheck?: true; report?: RestoreResult | null } | { kind: 'checking' } | { kind: 'preview'; preview: RestorePreview }
  | { kind: 'restoring'; preview: RestorePreview; progress: RestoreProgress | null }
  | { kind: 'stopped'; preview: RestorePreview; failed: number | null; blocked: number; report: RestoreResult | null } | { kind: 'done'; result: RestoreResult }
  | { kind: 'incomplete'; result: RestoreResult } | { kind: 'failed'; message: MessageKey };

// The passphrase and chosen files stay in this component's memory only; they are never stored or sent.
export function RestoreSettings({ client, scope, language, online, t }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [files, setFiles] = useState<File[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const clear = () => {
      request.current?.abort(); request.current = null;
      setState({ kind: 'idle' }); setFiles([]); setPassphrase(''); setOpen(false);
    };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (state.kind === 'failed' || state.kind === 'stopped' || state.kind === 'incomplete' || state.kind === 'idle' && state.recheck) alert.current?.focus();
  }, [state]);
  const number = (value: number) => new Intl.NumberFormat(locales[language]).format(value);
  const plural = (key: 'backup.items' | 'restore.outfits' | 'restore.reencoded', value: number) => t(
    new Intl.PluralRules(locales[language]).select(value) === 'one' ? `${key}_one` : `${key}_other`, { count: number(value) });

  function reset() {
    request.current?.abort(); request.current = null;
    setState({ kind: 'idle' }); setFiles([]); setPassphrase(''); setOpen(false);
  }
  function next() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    return controller;
  }
  async function check() {
    const controller = next();
    setState({ kind: 'checking' });
    try {
      const preview = await checkBackup(client, scope, files, passphrase, controller.signal);
      if (controller.signal.aborted || scope.signal.aborted) return;
      setState({ kind: 'preview', preview });
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      setState({ kind: 'failed', message: errorKey(error) });
    }
  }
  async function restore(preview: RestorePreview) {
    const controller = next();
    setState({ kind: 'restoring', preview, progress: null });
    try {
      const result = await runRestore(client, scope, preview, controller.signal, progress => {
        if (!controller.signal.aborted) setState({ kind: 'restoring', preview, progress });
      });
      if (controller.signal.aborted || scope.signal.aborted) return;
      // Anything not confirmed can be continued by running the same restore again.
      if (result.failed > 0) { setState({ kind: 'stopped', preview, failed: result.failed + result.deferred, blocked: result.blocked, report: result }); return; }
      setFiles([]); setPassphrase('');
      // Blocked items can't be finished from this backup, so running it again is not offered.
      setState(result.blocked > 0 ? { kind: 'incomplete', result } : { kind: 'done', result });
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      // The preview no longer matches the backup: nothing more is written, and the backup has to be checked again.
      const report = restoreReport();
      if (error instanceof RestoreRecheckError) { setOpen(true); setState({ kind: 'idle', recheck: true, report }); return; }
      setState({ kind: 'stopped', preview, failed: null, blocked: 0, report });
    }
  }

  const busy = state.kind === 'checking' || state.kind === 'restoring';
  const ready = files.length > 0 && passphrase.length > 0;
  return <section className="settings-card restore-card" aria-labelledby="restore-heading">
    <h2 id="restore-heading">{t('restore.title')}</h2>
    <p className="muted fine">{t('restore.intro')}</p>
    {state.kind === 'idle' && !open && <button type="button" className="button button-secondary" disabled={!online}
      onClick={() => { setOpen(true); }}>{t('restore.open')}</button>}
    {(state.kind === 'idle' && open || state.kind === 'checking') && <form className="stack" noValidate
      onSubmit={event => { event.preventDefault(); if (ready) void check(); }}>
      {state.kind === 'idle' && state.recheck && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t('restore.recheck')}</p>}
      <div className="field">
        <label htmlFor="restore-files">{t('restore.files')}</label>
        <input id="restore-files" ref={input} type="file" multiple accept=".enc,.json,application/octet-stream,application/json"
          disabled={busy} aria-describedby="restore-files-hint"
          onChange={event => { setFiles(Array.from(event.target.files ?? [])); }} />
        <p className="fine muted" id="restore-files-hint">{t('restore.filesHint')}</p>
      </div>
      <div className="field">
        <label htmlFor="restore-passphrase">{t('backup.passphrase')}</label>
        <input id="restore-passphrase" type="password" autoComplete="current-password" value={passphrase} disabled={busy}
          onChange={event => { setPassphrase(event.target.value); }} />
      </div>
      <button className="button button-primary" disabled={busy || !online || !ready} aria-busy={state.kind === 'checking' || undefined}>
        {t('restore.check')}</button>
      <button type="button" className="text-button" disabled={busy} onClick={reset}>{t('common.cancel')}</button>
      {state.kind === 'checking' && <p role="status">{t('restore.checking')}</p>}
    </form>}
    {(state.kind === 'preview' || state.kind === 'restoring' || state.kind === 'stopped') && <div className="stack">
      <p>{t('restore.madeOn', { date: new Intl.DateTimeFormat(locales[language], { dateStyle: 'long' })
        .format(new Date(state.preview.backup.data.createdAt)) })}</p>
      <p>{t('restore.contents', { items: plural('backup.items', state.preview.items.length),
        outfits: plural('restore.outfits', state.preview.counts.outfits) })}</p>
      <ul className="restore-counts">
        <li>{t('restore.add', { n: number(state.preview.counts.add) })}</li>
        {state.preview.counts.same > 0 && <li>{t('restore.same', { n: number(state.preview.counts.same) })}</li>}
        {state.preview.counts.conflicts > 0 && <li>{t('restore.conflicts', { n: number(state.preview.counts.conflicts) })}</li>}
        {state.preview.counts.trash > 0 && <li>{t('restore.inTrash', { n: number(state.preview.counts.trash) })}</li>}
        {state.preview.counts.reencoded > 0 && <li>{plural('restore.reencoded', state.preview.counts.reencoded)}</li>}
      </ul>
      {state.preview.otherAccount && <p className="notice">{t('restore.otherAccount')}</p>}
      <p className="muted fine">{t('restore.kept')}</p>
      {state.preview.backup.data.attributions > 0 && <p className="muted fine">{t('restore.attributions')}</p>}
      {state.kind === 'stopped' && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t('restore.stopped')}</p>}
      {state.kind === 'stopped' && state.failed !== null && <p>{t('restore.notRestored', { n: number(state.failed) })}</p>}
      {state.kind === 'stopped' && state.blocked > 0 && <p>{t('restore.blocked', { n: number(state.blocked) })}</p>}
      <p role="status">{state.kind === 'restoring'
        ? t('restore.progress', { n: number(Math.min((state.progress?.done ?? 0) + 1, state.progress?.total ?? state.preview.items.length) || 0),
          total: number(state.progress?.total ?? state.preview.items.length) }) : ''}</p>
      <button type="button" className="button button-primary" disabled={busy || !online}
        aria-busy={state.kind === 'restoring' || undefined} onClick={() => { void restore(state.preview); }}>
        {t(state.kind === 'stopped' ? 'restore.again' : 'restore.start')}</button>
      <button type="button" className="text-button" disabled={busy} onClick={reset}>{t('common.cancel')}</button>
    </div>}
    {state.kind === 'done' && <div className="stack">
      <p role="status">{t('restore.done')}</p>
      {state.result.conflicts + state.result.outfitConflicts + state.result.historyConflicts > 0 && <p>{t('restore.conflicts',
        { n: number(state.result.conflicts + state.result.outfitConflicts + state.result.historyConflicts) })}</p>}
      {state.result.trash > 0 && <p>{t('restore.inTrash', { n: number(state.result.trash) })}</p>}
      <button type="button" className="button button-secondary" onClick={reset}>{t('backup.finish')}</button>
    </div>}
    {state.kind === 'incomplete' && <div className="stack">
      <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t('restore.incomplete')}</p>
      <p>{t('restore.blocked', { n: number(state.result.blocked) })}</p>
      {state.result.deferred > 0 && <p>{t('restore.notRestored', { n: number(state.result.deferred) })}</p>}
      <button type="button" className="button button-secondary" onClick={reset}>{t('backup.finish')}</button>
    </div>}
    {state.kind === 'failed' && <div className="stack">
      <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(state.message)}</p>
      <button type="button" className="button button-secondary" onClick={reset}>{t('backup.startAgain')}</button>
    </div>}
    {!online && <p role="status">{t('restore.offline')}</p>}
  </section>;
}
