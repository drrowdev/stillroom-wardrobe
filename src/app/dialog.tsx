import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Translate } from '../i18n';

export type BeforeDiscard = () => Promise<'saved' | 'cancelled' | 'unresolved'>;
type Props = { title: string; children: ReactNode; onCancel: () => void; onConfirm: () => void; t: Translate; beforeConfirm?: BeforeDiscard };
export function DiscardDialog({ title, children, onCancel, onConfirm, t, beforeConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latch = useRef(false);
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  async function confirm() {
    if (latch.current) return;
    latch.current = true; setBusy(true);
    try {
      const outcome = beforeConfirm ? await beforeConfirm() : 'cancelled';
      if (outcome === 'unresolved') setUnresolved(true);
      else onConfirm();
    } catch { setUnresolved(true); }
    finally { latch.current = false; setBusy(false); }
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="discard-title" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!latch.current) onCancel(); }}>
      <h2 id="discard-title">{title}</h2>
      <div className="muted">{children}</div>
      {busy && <p role="status">{t('aiC.cancelling')}</p>}
      {unresolved && <p role="alert">{t('aiC.leaveWarning')}</p>}
      <div className="dialog-actions">
        <button className="button button-primary" type="button" disabled={busy} autoFocus onClick={onCancel}>{t('common.continueEditing')}</button>
        <button className="button button-danger" type="button" disabled={busy} onClick={() => { void confirm(); }}>{t('common.discard')}</button>
        {unresolved && <button className="button button-quiet" type="button" disabled={busy} onClick={onConfirm}>{t('aiC.leave')}</button>}
      </div>
    </dialog>
  );
}
