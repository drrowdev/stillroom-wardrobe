import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TryOnClient } from '../../../data/tryon';
import type { Language, Translate } from '../../../i18n';
import '../../../i18n/tryon';
import { deletionDate } from '../use-try-on';

/** A modal confirm: the browser traps focus; the caller returns focus to the control that opened it. */
export function ConfirmDialog({ id, title, text, confirm, cancel, danger, onConfirm, onCancel }: {
  id: string; title: string; text?: string; confirm: string; cancel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby={`${id}-title`} aria-describedby={text ? `${id}-text` : undefined}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    {text && <div className="muted"><p id={`${id}-text`}>{text}</p></div>}
    <div className="dialog-actions">
      <button className="button button-secondary" type="button" autoFocus onClick={onCancel}>{cancel}</button>
      <button id={`${id}-confirm`} className={`button ${danger ? 'button-danger' : 'button-primary'}`} type="button" onClick={onConfirm}>{confirm}</button>
    </div>
  </dialog>;
}

type Picture = { kind: 'loading' } | { kind: 'shown'; url: string } | { kind: 'failed' } | { kind: 'deleted' };

/**
 * One saved try-on: the picture (a Blob URL revoked on replace and unmount), its label and Delete with a confirm. It
 * leaves the view at its expiry time or when the server no longer has it.
 */
export function TryOnPicture({ api, result, language, t, online, idPrefix, children, onDeleted }: {
  api: TryOnClient; result: { id: string; expiresAtMs: number | null }; language: Language; t: Translate; online: boolean;
  idPrefix: string; children?: ReactNode; onDeleted?: () => void;
}) {
  const [picture, setPicture] = useState<Picture>({ kind: 'loading' });
  const [expires, setExpires] = useState<number | null>(result.expiresAtMs);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const gone = picture.kind === 'deleted';
  useEffect(() => {
    if (gone) return;
    const controller = new AbortController();
    let url: string | null = null;
    setPicture({ kind: 'loading' });
    (async () => {
      let expiry = result.expiresAtMs;
      if (expiry === null) {
        const list = await api.results(controller.signal);
        if (controller.signal.aborted) return;
        const found = list === 'missing' ? undefined : list.find(entry => entry.id === result.id);
        if (!found) { setPicture({ kind: 'deleted' }); return; }
        expiry = found.expiresAtMs;
      }
      setExpires(expiry);
      const image = await api.resultImage(result.id, controller.signal);
      if (controller.signal.aborted) return;
      if (image.kind === 'code') { setPicture(image.code === 'NOT_FOUND' ? { kind: 'deleted' } : { kind: 'failed' }); return; }
      url = URL.createObjectURL(new Blob([image.bytes], { type: 'image/jpeg' }));
      setPicture({ kind: 'shown', url });
    })().catch(() => { if (!controller.signal.aborted) setPicture({ kind: 'failed' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [api, result.id, result.expiresAtMs, attempt, gone]);
  useEffect(() => {
    if (expires === null || gone) return;
    const remaining = expires - Date.now();
    if (remaining <= 0) { setPicture({ kind: 'deleted' }); return; }
    const timer = setTimeout(() => setPicture({ kind: 'deleted' }), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expires, gone]);
  // The latest callback, so a parent re-render with a new closure doesn't report the same removal again.
  const deleted = useRef(onDeleted);
  deleted.current = onDeleted;
  useEffect(() => { if (gone) deleted.current?.(); }, [gone]);
  function remove() {
    setConfirming(false); setDeleting(true); setDeleteFailed(false);
    api.deleteResult(result.id).then(() => { setDeleting(false); setPicture({ kind: 'deleted' }); }, () => {
      setDeleting(false); setDeleteFailed(true);
      requestAnimationFrame(() => deleteButton.current?.focus());
    });
  }
  if (gone) return <p className="notice" role="status">{t('tryon.deleted')}</p>;
  return <figure className="tryon-result stack">
    {picture.kind === 'shown' ? <img src={picture.url} alt={t('tryon.resultAlt')} width={1024} height={1280} />
      : picture.kind === 'failed' ? <div className="notice notice-error" role="alert"><span>{t('tryon.resultFailed')}</span>
        <button type="button" className="text-button" disabled={!online} onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></div>
      : <p role="status">{t('tryon.loadingResult')}</p>}
    {expires !== null && <figcaption>{t('tryon.madeWith', { date: deletionDate(expires, language) })}</figcaption>}
    {deleteFailed && <div className="notice notice-error" role="alert"><span>{t('tryon.deleteFailed')}</span></div>}
    <div className="outfit-actions">
      <button ref={deleteButton} id={`${idPrefix}-delete`} type="button" className="button button-secondary" disabled={!online || deleting}
        onClick={() => setConfirming(true)}>{t('common.delete')}</button>
      {children}
    </div>
    {deleting && <p className="muted" role="status">{t('common.saving')}</p>}
    {confirming && <ConfirmDialog id={`${idPrefix}-confirm`} title={t('tryon.deleteTitle')} confirm={t('common.delete')} cancel={t('common.cancel')} danger
      onConfirm={remove} onCancel={() => { setConfirming(false); requestAnimationFrame(() => deleteButton.current?.focus()); }} />}
  </figure>;
}
