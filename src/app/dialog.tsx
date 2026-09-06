import { useEffect, useRef, type ReactNode } from 'react';
import type { Translate } from '../i18n';

type Props = { title: string; children: ReactNode; onCancel: () => void; onConfirm: () => void; t: Translate };
export function DiscardDialog({ title, children, onCancel, onConfirm, t }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="discard-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id="discard-title">{title}</h2>
      <div className="muted">{children}</div>
      <div className="dialog-actions">
        <button className="button button-primary" type="button" autoFocus onClick={onCancel}>{t('common.continueEditing')}</button>
        <button className="button button-danger" type="button" onClick={onConfirm}>{t('common.discard')}</button>
      </div>
    </dialog>
  );
}
