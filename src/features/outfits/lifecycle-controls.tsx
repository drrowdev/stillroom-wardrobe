import { useEffect, useRef, useState } from 'react';
import { pluralText, type Language, type Translate } from '../../i18n';
import type { OutfitLifecycle } from './use-outfit-lifecycle';

export function OutfitLifecycleDialog({ title, body, action, lifecycle, online, t, onCancel, onConfirm }: {
  title: string; body: string; action: string; lifecycle: OutfitLifecycle; online: boolean; t: Translate;
  onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (returnFocus?.isConnected && !returnFocus.matches(':disabled')) returnFocus.focus();
      else document.getElementById(location.hash === '#/trash' ? 'trash-title' : 'outfits-title')?.focus();
    };
  }, [returnFocus]);
  return <dialog ref={dialog} className="dialog lifecycle-dialog" aria-labelledby="outfit-lifecycle-title" aria-describedby="outfit-lifecycle-body"
    aria-busy={lifecycle.busy} onCancel={event => { event.preventDefault(); if (!lifecycle.busy) onCancel(); }}>
    <h2 id="outfit-lifecycle-title">{title}</h2><p id="outfit-lifecycle-body">{body}</p>
    <div className="dialog-actions">
      <button type="button" autoFocus className="button button-secondary" disabled={lifecycle.busy} onClick={onCancel}>{t('common.cancel')}</button>
      <button type="button" className="button button-danger" disabled={!online || lifecycle.locked} onClick={onConfirm}>{action}</button>
    </div>
  </dialog>;
}

export function OutfitLifecycleNotice({ lifecycle, online, language, t }: {
  lifecycle: OutfitLifecycle; online: boolean; language: Language; t: Translate;
}) {
  const expiresAt = lifecycle.notice?.expiresAt ?? 0;
  const [expired, setExpired] = useState(() => performance.now() >= expiresAt);
  useEffect(() => {
    const update = () => {
      setExpired(performance.now() >= expiresAt);
      if (performance.now() >= expiresAt && document.activeElement?.id === 'outfit-undo') document.getElementById('main')?.focus();
    };
    update();
    const timer = setTimeout(update, Math.max(0, expiresAt - performance.now()));
    window.addEventListener('focus', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [expiresAt]);
  const problems = [...new Set(lifecycle.failures.map(failure => failure.key))];
  return <>
    {lifecycle.busy && <p role="status">{t('common.saving')}</p>}
    {lifecycle.failures.length > 0 && <div className="notice notice-error" role="alert">
      <span>{pluralText(language, 'outfitTrash.failed', lifecycle.failures.length)} {problems.map(key => t(key)).join(' ')}</span>
      {lifecycle.unknown.length > 0 && <button type="button" className="text-button" disabled={!online || lifecycle.busy}
        onClick={() => { void lifecycle.check(); }}>{t('lifecycle.check')}</button>}
    </div>}
    {lifecycle.notice && lifecycle.notice.records.length > 0 && <div className="notice lifecycle-undo">
      <p role="status">{pluralText(language, 'outfitTrash.moved', lifecycle.notice.records.length)}</p>
      {!expired && <button id="outfit-undo" type="button" className="text-button" disabled={!online || lifecycle.undoBlocked}
        onClick={() => { if (performance.now() >= expiresAt) setExpired(true); else void lifecycle.undo(); }}>{t('common.undo')}</button>}
      <a className="text-button" href="#/trash">{t('nav.trash')}</a>
      <button type="button" className="text-button" aria-label={t('common.close')} disabled={lifecycle.busy} onClick={lifecycle.dismiss}>{t('common.close')}</button>
    </div>}
  </>;
}
