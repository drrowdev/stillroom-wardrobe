import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { ItemLifecycleClient, LifecycleError } from '../../data/item-lifecycle';
import { AppError, errorKey } from '../../data/errors';
import { preparedDeletionIntent, reversibleDeletion, type PreparedDeletionIntent, type DeletionOperation, type DeletionStatus, type LifecycleSnapshot, type TrashIntent, type UndoItem } from '../../domain/item-lifecycle';
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
    <div id="delete-item-body"><p>{t(plural === 'one' ? 'lifecycle.photos_one' : 'lifecycle.photos_other', { count: new Intl.NumberFormat(locales[language]).    format(preview.photo_count) })}</p>
          <p>{t('lifecycle.history')}</p><p>{t('deletion.garmentWarning')}</p></div>
    <div className="settings-actions"><button type="button" autoFocus className="button button-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      <button type="button" className="button button-danger" disabled={busy} onClick={onConfirm}>{t('lifecycle.delete')}</button></div>
  </dialog>;
}
export function Trash(props: Shared & { language: Language; onBack: () => void; onChanged: () => void; onDeleting: (itemId: string) => void }) {
  const { lifecycle, scope, images, online, t, language } = props;
  const action = useAction(scope, online);
  const { run } = action;
  const [rows, setRows] = useState<DeletionStatus[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [intent, setIntent] = useState<PreparedDeletionIntent | null>(null);
  const [operation, setOperation] = useState<DeletionOperation | null>(null);
  const [operations, setOperations] = useState<DeletionOperation[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const [restore, setRestore] = useState<TrashIntent | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const cancelledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (action.busy || intent || operation || !cancelledFocus.current) return;
    const target = document.getElementById(`deletion-review-${cancelledFocus.current}`);
    cancelledFocus.current = null;
    if (target instanceof HTMLButtonElement && !target.disabled) target.focus();
    else document.getElementById('trash-title')?.focus();
  }, [action.busy, intent, operation]);
  const load = useCallback(async (signal: AbortSignal, after: string | null) => {
    const page = await lifecycle.list(after, signal);
    const receipts = page.rows.length ? await lifecycle.operations(page.rows.map(row => row.id), signal) : [];
    if (signal.aborted) return;
    setOperations(old => after ? [...old.filter(row => !page.rows.some(value => value.id === row.itemId)), ...receipts] : receipts);
    setRows(old => after ? [...old.filter(row => !page.rows.some(value => value.id === row.id)), ...page.rows] : page.rows);
    setNext(page.next); setLoaded(true);
  }, [lifecycle]);
  useEffect(() => { if (!loaded) void run(signal => load(signal, null)); }, [run, load, loaded]);
  function removeRow(id: string) {
    setRows(old => old.filter(row => row.id !== id)); setIntent(null); setRestore(null); setOperation(null); setUncertain(false);
    setOperations(old => old.filter(row => row.itemId !== id)); setDialog(false);
    props.onChanged(); document.getElementById('trash-title')?.focus();
  }
  function observed(receipt: DeletionOperation) {
    setUncertain(false); setOperation(receipt);
    setOperations(old => [...old.filter(row => row.itemId !== receipt.itemId), receipt]);
    if (receipt.phase === 'completed') { removeRow(receipt.itemId); setNotice('deletion.deleted'); }
    else if (receipt.phase === 'cancelled') { setIntent(null); setOperation(null); setDialog(false); setOperations(old => old.filter(row => row.itemId !== receipt.itemId)); }
  }
  async function prepare(signal: AbortSignal, deletion: PreparedDeletionIntent) {
    const receipt = await lifecycle.prepareDeletion(deletion, signal);
    if (!signal.aborted) { observed(receipt); if (receipt.phase === 'prepared') setDialog(true); }
  }
  async function finish(signal: AbortSignal, receipt: DeletionOperation, authorize: boolean) {
    setUncertain(true);
    props.onDeleting(receipt.itemId);
    const result = await lifecycle.continueDeletion(receipt, authorize, paths => images.invalidate(paths), signal);
    if (!signal.aborted) observed(result);
  }
  function cancel() {
    if (!operation || uncertain || !reversibleDeletion(operation)) return;
    setDialog(false);
    void action.run(async signal => {
      const result = await lifecycle.cancelPreparation(operation, signal);
      if (!signal.aborted) {
        cancelledFocus.current = result.itemId;
        observed(result);
      }
    });
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
      <h2>{intent.preview.title}</h2><p>{t(uncertain ? 'deletion.uncertain' : operation?.phase === 'blocked_preflight' ? 'deletion.blocked'
        : operation?.phase === 'preparing' || !operation ? 'deletion.preparing' : 'lifecycle.paused')}</p>
      <button className="button button-secondary" disabled={action.busy || !online} onClick={() => { void action.run(async signal => {
        const receipt = await lifecycle.operationStatus(intent.preview.id, intent.requestId, signal);
        if (!receipt) throw new AppError('lifecycle.unconfirmed');
        if (!signal.aborted) observed(receipt);
      }); }}>{t('lifecycle.check')}</button>
      {(!operation || operation.phase === 'preparing') && !uncertain && <button className="button button-secondary" disabled={action.busy || !online}
        onClick={() => { void action.run(signal => prepare(signal, intent)); }}>{t('common.retry')}</button>}
      {operation?.phase === 'prepared' && !uncertain && <button className="button button-danger" disabled={action.busy || !online}
        onClick={() => setDialog(true)}>{t('deletion.prepare')}</button>}
      {operation && ['authorized', 'removing_registered'].includes(operation.phase) && !uncertain && <button className="button button-danger" disabled={action.busy || !online}
        onClick={() => { void action.run(signal => finish(signal, operation, false)); }}>{t('lifecycle.resume')}</button>}
      {operation && reversibleDeletion(operation) && !uncertain && <button className="text-button" disabled={action.busy || !online} onClick={cancel}>{t('deletion.cancel')}</button>}
    </section>}
    {!loaded && !action.error && <p role="status">{t('common.loading')}</p>}
    {loaded && !rows.length && <p>{t('trash.empty')}</p>}
    <ul className="trash-list">{rows.map(row => <li className="settings-card" key={row.id}>
      <h2>{row.title}</h2>
      {row.request_id || operations.some(receipt => receipt.itemId === row.id) ? <button type="button" className="button button-secondary" disabled={locked || !online} onClick={() => {
        void action.run(async signal => {
          const current = await lifecycle.statusOf(row.id, signal);
          const existing = operations.find(receipt => receipt.itemId === row.id);
          const deletion = existing ? { preview: current, epoch: scope.epoch, requestId: existing.requestId } : preparedDeletionIntent(current, scope.epoch);
          if (signal.aborted) return;
          setIntent(deletion); setNotice(null);
          if (existing) {
            const receipt = await lifecycle.operationStatus(row.id, existing.requestId, signal);
            if (!receipt) throw new AppError('lifecycle.unconfirmed');
            if (!signal.aborted) observed(receipt);
          } else await prepare(signal, deletion);
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
        <button id={`deletion-review-${row.id}`} type="button" className="text-button" disabled={locked || !online} onClick={event => { deleteTrigger.current = event.currentTarget; void action.run(async signal => {
          setNotice(null);
          const current = await lifecycle.statusOf(row.id, signal);
          if (current.request_id || !current.deleted_at) throw new LifecycleError('read', false, 'error.conflict');
          if (signal.aborted) return;
          const deletion = preparedDeletionIntent(current, scope.epoch);
          setIntent(deletion); setOperation(null); setUncertain(false);
          await prepare(signal, deletion);
        }); }}>{t('deletion.prepare')}</button>
      </div>}
    </li>)}</ul>
    {next && <button className="button button-secondary" disabled={locked || !online} onClick={() => { void action.run(signal => load(signal, next)); }}>{t('wardrobe.more')}</button>}
    {dialog && intent && operation?.phase === 'prepared' && !uncertain && <DeleteDialog preview={intent.preview}
      busy={action.busy} t={t} language={language} returnFocus={deleteTrigger.current} onCancel={cancel} onConfirm={() => {
      void action.run(async signal => {
        setDialog(false);
        await finish(signal, operation, true);
      });
    }} />}
  </section>;
}
