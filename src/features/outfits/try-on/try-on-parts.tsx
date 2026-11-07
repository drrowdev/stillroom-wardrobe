import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TryOnClient } from '../../../data/tryon';
import type { Translate } from '../../../i18n';
import '../../../i18n/tryon';

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

/** Full-screen view of one picture: fit to the screen or at full size to scroll, pinch or pan. The caller owns the Blob URL. */
function PictureViewer({ url, alt, t, onClose }: { url: string; alt: string; t: Translate; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    close.current?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="viewer" aria-label={alt} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="viewer-scroll" data-zoomed={full ? '' : undefined} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <img src={url} alt={alt} onClick={() => setFull(value => !value)} />
    </div>
    <div className="viewer-actions">
      <button type="button" className="button button-secondary" onClick={() => setFull(value => !value)}>{t(full ? 'tryon.zoomFit' : 'tryon.zoomIn')}</button>
      <button ref={close} id="tryon-viewer-close" type="button" className="button button-primary" onClick={onClose}>{t('common.close')}</button>
    </div>
  </dialog>;
}

type Picture = { kind: 'loading' } | { kind: 'shown'; url: string } | { kind: 'failed' } | { kind: 'deleted' };

/**
 * One saved try-on: the picture (a Blob URL revoked on replace and unmount), its label and Delete with a confirm. It stays until
 * the owner deletes it; it leaves the view when the server no longer has it.
 */
export function TryOnPicture({ api, result, t, online, idPrefix, children, onDeleted, readOnly, alt }: {
  api: TryOnClient; result: { id: string }; t: Translate; online: boolean;
  idPrefix: string; children?: ReactNode; onDeleted?: () => void;
  /** A picture shown on a suggestion card: no Delete (pictures are deleted under Try-ons, or with Remove). */
  readOnly?: boolean; alt?: string;
}) {
  const [picture, setPicture] = useState<Picture>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const gone = picture.kind === 'deleted';
  useEffect(() => {
    if (gone) return;
    const controller = new AbortController();
    let url: string | null = null;
    setPicture({ kind: 'loading' });
    (async () => {
      const image = await api.resultImage(result.id, controller.signal);
      if (controller.signal.aborted) return;
      if (image.kind === 'code') { setPicture(image.code === 'NOT_FOUND' ? { kind: 'deleted' } : { kind: 'failed' }); return; }
      url = URL.createObjectURL(new Blob([image.bytes], { type: 'image/jpeg' }));
      setPicture({ kind: 'shown', url });
    })().catch(() => { if (!controller.signal.aborted) setPicture({ kind: 'failed' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [api, result.id, attempt, gone]);
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
    {picture.kind === 'shown' ? <button ref={zoomButton} type="button" className="tryon-zoom" aria-label={t('tryon.zoomOpen')} onClick={() => setViewing(true)}>
      <img src={picture.url} alt={alt ?? t('tryon.resultAlt')} width={1024} height={1280} /></button>
      : picture.kind === 'failed' ? <div className="notice notice-error" role="alert"><span>{t('tryon.resultFailed')}</span>
        <button type="button" className="text-button" disabled={!online} onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></div>
      : <p role="status">{t('tryon.loadingResult')}</p>}
    <figcaption>{t('tryon.madeWith')}</figcaption>
    {deleteFailed && <div className="notice notice-error" role="alert"><span>{t('tryon.deleteFailed')}</span></div>}
    {(!readOnly || children) && <div className="outfit-actions">
      {!readOnly && <button ref={deleteButton} id={`${idPrefix}-delete`} type="button" className="button button-secondary" disabled={!online || deleting}
        onClick={() => setConfirming(true)}>{t('common.delete')}</button>}
      {children}
    </div>}
    {deleting && <p className="muted" role="status">{t('common.saving')}</p>}
    {viewing && picture.kind === 'shown' && <PictureViewer url={picture.url} alt={alt ?? t('tryon.resultAlt')} t={t}
      onClose={() => { setViewing(false); requestAnimationFrame(() => zoomButton.current?.focus()); }} />}
    {confirming && <ConfirmDialog id={`${idPrefix}-confirm`} title={t('tryon.deleteTitle')} confirm={t('common.delete')} cancel={t('common.cancel')} danger
      onConfirm={remove} onCancel={() => { setConfirming(false); requestAnimationFrame(() => deleteButton.current?.focus()); }} />}
  </figure>;
}
