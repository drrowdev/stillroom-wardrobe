import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { ItemLifecycleClient, LifecycleError } from '../../data/item-lifecycle';
import { AppError, errorKey } from '../../data/errors';
import { deletionIntent, type DeletionIntent, type DeletionStatus, type LifecycleSnapshot, type TrashIntent, type UndoItem } from '../../domain/item-lifecycle';
import type { ItemBaseline, ImageBaseline } from '../../domain/item-details';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';

function useAction(scope: OwnerScope, online: boolean, outer?: () => AbortSignal) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const lifetime = useRef(new AbortController());
  const latch = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); latch.current = false; };
  }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error, busy]);
  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (latch.current || !online || scope.signal.aborted) return;
    const mounted = lifetime.current.signal;
    const signal = AbortSignal.any([scope.signal, mounted, ...(outer ? [outer()] : [])]);
    latch.current = true; setBusy(true); setError(null);
    try { await operation(signal); }
    catch (problem) { if (!scope.signal.aborted && !mounted.aborted) setError(errorKey(problem)); }
    finally { if (!scope.signal.aborted && !mounted.aborted) { latch.current = false; setBusy(false); } }
  }, [scope, online, outer]);
  return { busy, error, alert, run };
}
type Shared = { lifecycle: ItemLifecycleClient; scope: OwnerScope; online: boolean; t: Translate; images: PrivateImages };
function Failure({ action, t }: { action: ReturnType<typeof useAction>; t: Translate }) {
  return action.error && <div className="notice notice-error" role="alert" tabIndex={-1} ref={action.alert}>{t(action.error)}</div>;
}
export function TrashAction(props: Shared & {
  item: ItemBaseline; image: ImageBaseline; blocked: boolean; onState: (busy: boolean, pending: boolean) => void;
  onTrashed: (item: LifecycleSnapshot) => void;
}) {
  const { lifecycle, scope, online, t, images, onState } = props;
  const action = useAction(scope, online);
  const [intent, setIntent] = useState<TrashIntent | null>(null);
  useEffect(() => { onState(action.busy, intent !== null); return () => onState(false, false); }, [action.busy, intent, onState]);
  function confirmed(item: LifecycleSnapshot) {
    images.invalidate([props.image.mainPath, props.image.thumbPath]);
    setIntent(null); onState(false, false); props.onTrashed(item);
  }
  return <section className="settings-card lifecycle-actions" aria-label={t('item.trash')}>
    <Failure action={action} t={t} />
    {intent ? <button type="button" className="button button-secondary" disabled={action.busy || !online}
      onClick={() => { void action.run(async signal => { const row = await lifecycle.checkChange(intent, signal); if (!signal.aborted) confirmed(row); }); }}>{t('lifecycle.check')}</button>
      : <button type="button" className="button button-secondary" disabled={props.blocked || action.busy || !online}
        onClick={() => {
          if (props.blocked) return;
          void action.run(async signal => {
            onState(true, false);
            try {
              const row = await lifecycle.change(props.item.id, true, props.item.version, setIntent, signal, { item: props.item, image: props.image });
              if (!signal.aborted) confirmed(row);
            } catch (problem) {
              if (!signal.aborted && problem instanceof LifecycleError && !problem.uncertain) setIntent(null);
              throw problem;
            }
          });
        }}>{t('item.trash')}</button>}
  </section>;
}
export function UndoNotice({ undo, visible, routeSignal, ...props }: Shared & { undo: UndoItem; visible: boolean; routeSignal: () => AbortSignal; onRestored: () => void }) {
  const { t, lifecycle, scope, online } = props;
  const action = useAction(scope, online, routeSignal);
  const [expired, setExpired] = useState(() => performance.now() >= undo.expiresAt);
  const [intent, setIntent] = useState<TrashIntent | null>(null);
  useEffect(() => {
    const update = () => {
      if (performance.now() >= undo.expiresAt) {
        if (document.activeElement?.id === 'lifecycle-undo') document.getElementById('wardrobe-title')?.focus();
        setExpired(true);
      }
    };
    const timer = setTimeout(update, Math.max(0, undo.expiresAt - performance.now()));
    window.addEventListener('focus', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [undo]);
  return <div className="notice lifecycle-undo" hidden={!visible}>
    <p role="status">{t('item.trashed')}</p><Failure action={action} t={t} />
    {intent ? <button className="text-button" disabled={action.busy || !online} onClick={() => { void action.run(async signal => {
      await lifecycle.checkChange(intent, signal); if (!signal.aborted) props.onRestored();
    }); }}>{t('lifecycle.check')}</button> : !expired && <button id="lifecycle-undo" className="text-button" disabled={action.busy || !online}
      onClick={() => {
        if (performance.now() >= undo.expiresAt) { setExpired(true); return; }
        void action.run(async signal => {
          try {
            await lifecycle.change(undo.item.id, false, undo.item.version, setIntent, signal);
            if (!signal.aborted) props.onRestored();
          } catch (problem) {
            if (!scope.signal.aborted && problem instanceof LifecycleError && !problem.uncertain) setIntent(null);
            throw problem;
          }
        });
      }}>{t('common.undo')}</button>}
    <a className="text-button" href="#/trash">{t('nav.trash')}</a>
  </div>;
}

function DeleteDialog({ preview, busy, t, language, returnFocus, onCancel, onConfirm }: {
  preview: DeletionStatus; busy: boolean; t: Translate; language: Language; returnFocus: HTMLButtonElement | null; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
      else document.getElementById('trash-title')?.focus();
    };
  }, [returnFocus]);
  const plural = new Intl.PluralRules(locales[language]).select(preview.photo_count);
  return <dialog ref={dialog} className="dialog lifecycle-dialog" aria-labelledby="delete-item-heading" aria-describedby="delete-item-body"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="delete-item-heading">{t('lifecycle.deleteTitle', { name: preview.title })}</h2>
    <div id="delete-item-body"><p>{t(plural === 'one' ? 'lifecycle.photos_one' : 'lifecycle.photos_other', { count: new Intl.NumberFormat(locales[language]).format(preview.photo_count) })}</p>
      <p>{t('lifecycle.history')}</p><p>{t('lifecycle.noUndo')}</p></div>
    <div className="settings-actions"><button type="button" autoFocus className="button button-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      <button type="button" className="button button-danger" disabled={busy} onClick={onConfirm}>{t('lifecycle.delete')}</button></div>
  </dialog>;
}
export function Trash(props: Shared & { language: Language; onBack: () => void; onChanged: () => void }) {
  const { lifecycle, scope, images, online, t, language } = props;
  const action = useAction(scope, online);
  const [rows, setRows] = useState<DeletionStatus[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<DeletionStatus | null>(null);
  const [intent, setIntent] = useState<DeletionIntent | null>(null);
  const [observed, setObserved] = useState(false);
  const [restore, setRestore] = useState<TrashIntent | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const load = useCallback(async (signal: AbortSignal, after: string | null) => {
    const page = await lifecycle.list(after, signal);
    if (signal.aborted) return;
    setRows(old => after ? [...old.filter(row => !page.rows.some(value => value.id === row.id)), ...page.rows] : page.rows);
    setNext(page.next); setLoaded(true);
  }, [lifecycle]);
  useEffect(() => { if (!loaded) void action.run(signal => load(signal, null)); }, [action.run, load, loaded]);
  function removeRow(id: string) {
    setRows(old => old.filter(row => row.id !== id)); setIntent(null); setRestore(null); setObserved(false);
    props.onChanged(); document.getElementById('trash-title')?.focus();
  }
  async function finish(signal: AbortSignal, deletion: DeletionIntent, start: boolean) {
    setObserved(false);
    await lifecycle.delete(deletion, start, paths => images.invalidate(paths), signal);
    if (!signal.aborted) { removeRow(deletion.preview.id); setNotice('lifecycle.deleted'); }
  }
  const locked = action.busy || intent !== null || restore !== null;
  return <section className="trash-page" aria-labelledby="trash-title">
    <button className="text-button" onClick={props.onBack}>{t('common.back')}</button>
    <div className="page-heading"><h1 id="trash-title" tabIndex={-1}>{t('nav.trash')}</h1>
      <button className="text-button" disabled={!online || action.busy} onClick={() => { void action.run(signal => load(signal, null)); }}>{t('common.refresh')}</button></div>
    <p className="muted">{t('trash.retention')}</p>
    <Failure action={action} t={t} />
    {notice && <p role="status" className="notice">{t(notice)}</p>}
    {restore && <button className="button button-secondary" disabled={action.busy || !online} onClick={() => { void action.run(async signal => {
      await lifecycle.checkChange(restore, signal); if (!signal.aborted) { removeRow(restore.baseline.id); setNotice('lifecycle.restored'); }
    }); }}>{t('lifecycle.check')}</button>}
    {intent && <section className="settings-card lifecycle-resume" aria-label={intent.preview.title}>
      <h2>{intent.preview.title}</h2><p>{t('lifecycle.paused')}</p>
      <button className="button button-secondary" disabled={action.busy || !online} onClick={() => { void action.run(async signal => {
        setObserved(false);
        await lifecycle.checkDeletion(intent, signal); if (!signal.aborted) setObserved(true);
      }); }}>{t('lifecycle.check')}</button>
      {observed && <button className="button button-danger" disabled={action.busy || !online}
        onClick={() => { void action.run(signal => finish(signal, intent, false)); }}>{t('lifecycle.resume')}</button>}
    </section>}
    {!loaded && !action.error && <p role="status">{t('common.loading')}</p>}
    {loaded && !rows.length && <p>{t('trash.empty')}</p>}
    <ul className="trash-list">{rows.map(row => <li className="settings-card" key={row.id}>
      <h2>{row.title}</h2>
      {row.request_id ? <button type="button" className="button button-secondary" disabled={locked || !online} onClick={() => {
        void action.run(async signal => {
          const current = await lifecycle.statusOf(row.id, signal);
          if (!signal.aborted) { setIntent(deletionIntent(current, scope.epoch)); setObserved(false); setNotice(null); }
        });
      }}>{t('lifecycle.check')}</button> : <div className="settings-actions">
        <button type="button" className="button button-secondary" disabled={locked || !online} onClick={() => { void action.run(async signal => {
          setNotice(null);
          try {
            await lifecycle.change(row.id, false, row.version, setRestore, signal);
            if (!signal.aborted) { removeRow(row.id); setNotice('lifecycle.restored'); }
          } catch (problem) {
            if (!signal.aborted && problem instanceof LifecycleError && !problem.uncertain) setRestore(null);
            throw problem;
          }
        }); }}>{t('trash.restore')}</button>
        <button type="button" className="text-button" disabled={locked || !online} onClick={event => { deleteTrigger.current = event.currentTarget; void action.run(async signal => {
          setNotice(null);
          const current = await lifecycle.statusOf(row.id, signal);
          if (current.request_id || !current.deleted_at) throw new LifecycleError('read', false, 'error.conflict');
          if (current.cleanup_blocked) throw new AppError('lifecycle.blocked');
          if (!signal.aborted) setDialog(current);
        }); }}>{t('lifecycle.delete')}</button>
      </div>}
    </li>)}</ul>
    {next && <button className="button button-secondary" disabled={locked || !online} onClick={() => { void action.run(signal => load(signal, next)); }}>{t('wardrobe.more')}</button>}
    {dialog && <DeleteDialog preview={dialog} busy={action.busy} t={t} language={language} returnFocus={deleteTrigger.current} onCancel={() => setDialog(null)} onConfirm={() => {
      void action.run(async signal => {
        setDialog(null);
        const deletion = deletionIntent(dialog, scope.epoch);
        setIntent(deletion);
        await finish(signal, deletion, true);
      });
    }} />}
  </section>;
}
