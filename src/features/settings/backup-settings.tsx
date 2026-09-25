import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import { errorKey, isAborted } from '../../data/errors';
import { buildPart, metadataFile, prepareExport, type PreparedExport } from '../../data/export';
import { BACKUP_LIMITS, partFileName } from '../../domain/export-format';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';

type Props = { client: AppClient; scope: OwnerScope; language: Language; online: boolean; t: Translate };
type State = { kind: 'idle' } | { kind: 'preparing'; plain: boolean } | { kind: 'ready'; prepared: PreparedExport; done: ReadonlySet<number> }
  | { kind: 'failed'; message: MessageKey };

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// The passphrase lives only in this component's memory while parts are being downloaded; it is never stored or sent.
export function BackupSettings({ client, scope, language, online, t }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [entering, setEntering] = useState(false);
  const [invalid, setInvalid] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (entering) field.current?.focus(); }, [entering]);
  // Signing out or switching account drops the snapshot, any photos in memory and the passphrase.
  useEffect(() => {
    const clear = () => {
      request.current?.abort(); request.current = null;
      setState({ kind: 'idle' }); setEntering(false); setPassphrase(''); setRepeat(''); setInvalid(null); setWorking(null);
    };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope]);
  useEffect(() => { if (state.kind === 'failed' || invalid) alert.current?.focus(); }, [state, invalid]);
  const count = (key: 'backup.items' | 'backup.photos', value: number) => t(
    new Intl.PluralRules(locales[language]).select(value) === 'one' ? `${key}_one` : `${key}_other`,
    { count: new Intl.NumberFormat(locales[language]).format(value) });

  function reset() {
    request.current?.abort(); request.current = null;
    setState({ kind: 'idle' }); setEntering(false); setPassphrase(''); setRepeat(''); setInvalid(null); setWorking(null);
  }
  function fail(error: unknown) {
    if (scope.signal.aborted || isAborted(error)) return;
    setPassphrase(''); setRepeat(''); setWorking(null); setEntering(false);
    setState({ kind: 'failed', message: errorKey(error) });
  }
  async function prepare(plain: boolean) {
    if (!plain) {
      const problem: MessageKey | null = passphrase.length < BACKUP_LIMITS.passphrase ? 'backup.short' : passphrase !== repeat ? 'backup.mismatch' : null;
      setInvalid(problem);
      if (problem) return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: 'preparing', plain });
    try {
      const prepared = await prepareExport(client, scope, controller.signal);
      if (controller.signal.aborted || scope.signal.aborted) return;
      if (plain) { save(metadataFile(prepared), `stillroom-${prepared.exportId}.json`); setState({ kind: 'idle' }); return; }
      setEntering(false);
      setState({ kind: 'ready', prepared, done: new Set() });
    } catch (error) { fail(error); }
  }
  async function download(prepared: PreparedExport, index: number) {
    const controller = request.current ?? new AbortController();
    request.current = controller;
    setWorking(index);
    try {
      const blob = await buildPart(client, scope, prepared, index, passphrase, controller.signal);
      if (controller.signal.aborted || scope.signal.aborted) return;
      save(blob, partFileName(prepared.exportId, index));
      setWorking(null);
      setState(current => current.kind === 'ready' ? { ...current, done: new Set([...current.done, index]) } : current);
    } catch (error) { fail(error); }
  }

  const busy = state.kind === 'preparing' || working !== null;
  const complete = state.kind === 'ready' && state.done.size === state.prepared.partCount;
  return <section className="settings-card backup-card" aria-labelledby="backup-heading">
    <h2 id="backup-heading">{t('backup.title')}</h2>
    <p className="muted fine">{t('backup.intro')}</p>
    <p className="muted fine">{t('backup.excluded')}</p>
    {(state.kind === 'idle' || state.kind === 'preparing') && <>
      {!entering && <button type="button" className="button button-primary" disabled={busy || !online}
        onClick={() => { setEntering(true); }}>{t('backup.create')}</button>}
      {entering && <form className="stack" noValidate onSubmit={event => { event.preventDefault(); void prepare(false); }}>
        <div className="field">
          <label htmlFor="backup-passphrase">{t('backup.passphrase')}</label>
          <input id="backup-passphrase" type="password" ref={field} autoComplete="new-password" value={passphrase} disabled={busy}
            aria-describedby="backup-passphrase-hint" aria-invalid={invalid === 'backup.short' || undefined}
            onChange={event => { setPassphrase(event.target.value); setInvalid(null); }} />
          <p className="fine muted" id="backup-passphrase-hint">{t('backup.passphraseHint')}</p>
        </div>
        <div className="field">
          <label htmlFor="backup-repeat">{t('backup.repeat')}</label>
          <input id="backup-repeat" type="password" autoComplete="new-password" value={repeat} disabled={busy}
            aria-invalid={invalid === 'backup.mismatch' || undefined} onChange={event => { setRepeat(event.target.value); setInvalid(null); }} />
        </div>
        {invalid && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(invalid)}</p>}
        <button className="button button-primary" disabled={busy || !online} aria-busy={state.kind === 'preparing' && !state.plain || undefined}>{t('backup.create')}</button>
        <button type="button" className="text-button" disabled={busy} onClick={reset}>{t('common.cancel')}</button>
      </form>}
      <div className="stack backup-plain">
        <button type="button" className="button button-secondary" disabled={busy || !online} aria-describedby="backup-plain-note"
          aria-busy={state.kind === 'preparing' && state.plain || undefined} onClick={() => { void prepare(true); }}>{t('backup.json')}</button>
        <p className="fine muted" id="backup-plain-note">{t('backup.jsonNote')}</p>
      </div>
      {state.kind === 'preparing' && <p role="status">{t('backup.preparing')}</p>}
    </>}
    {state.kind === 'ready' && <div className="stack">
      <ol className="backup-parts">
        {Array.from({ length: state.prepared.partCount }, (_, index) => <li key={index}>
          <button type="button" className="button button-secondary" disabled={busy || !online} aria-busy={working === index || undefined}
            onClick={() => { void download(state.prepared, index); }}>{t('backup.part', { n: index + 1, total: state.prepared.partCount })}</button>
          {state.done.has(index) && <span className="backup-part-done">{t('backup.partDone')}</span>}
        </li>)}
      </ol>
      <p role="status">{complete ? t('backup.done', { items: count('backup.items', state.prepared.items), photos: count('backup.photos', state.prepared.photos) })
        : working !== null ? t('backup.preparing') : ''}</p>
      <button type="button" className="text-button" onClick={reset}>{t(complete ? 'backup.finish' : 'common.cancel')}</button>
    </div>}
    {state.kind === 'failed' && <div className="stack">
      <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(state.message)}</p>
      <button type="button" className="button button-secondary" onClick={reset}>{t('backup.startAgain')}</button>
    </div>}
    {!online && <p role="status">{t('backup.offline')}</p>}
  </section>;
}
