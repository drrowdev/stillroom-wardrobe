import { useEffect, useRef } from 'react';
import type { Translate } from '../../i18n';

export function OutfitLeaveDialog({ unresolved, onStay, onLeave, t }: { unresolved: boolean; onStay: () => void; onLeave: () => void; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog outfit-leave" aria-labelledby="outfit-leave-title" onCancel={(event) => { event.preventDefault(); onStay(); }}>
    <h2 id="outfit-leave-title">{t('outfits.leaveTitle')}</h2>
    <div className="muted"><p>{t(unresolved ? 'outfits.leaveUnresolved' : 'outfits.discardBody')}</p></div>
    <div className="dialog-actions">
      <button className="button button-primary" type="button" autoFocus onClick={onStay}>{t('common.continueEditing')}</button>
      <button className="button button-danger" type="button" onClick={onLeave}>{t('outfits.leave')}</button>
    </div>
  </dialog>;
}
