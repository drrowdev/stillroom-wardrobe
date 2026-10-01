import { useRef, useState, type ReactNode } from 'react';
import type { Translate } from '../../i18n';
import { Icon } from '../../app/icon';
import '../../styles/wardrobe-flow.css';

export const photoMenuId = 'photo-menu';

/** Before a photo exists: one primary "Choose photo" and a secondary "Take photo". */
export function PhotoChoice({ t, disabled, chooseId, onLibrary, onCamera }: {
  t: Translate; disabled: boolean; chooseId?: string; onLibrary: () => void; onCamera: () => void;
}) {
  return <div className="photo-actions capture-step-actions">
    <button id={chooseId} className="button button-primary" type="button" disabled={disabled} onClick={onLibrary}><Icon name="photo" />{t('capture.library')}</button>
    <button className="button button-quiet" type="button" disabled={disabled} onClick={onCamera}><Icon name="camera" />{t('capture.camera')}</button>
  </div>;
}

/**
 * "Photo options": a disclosure (not an ARIA menu) holding plain buttons in DOM order. Escape closes it and returns focus
 * to the toggle; pressing one of its buttons closes it too, and the action decides where focus goes next.
 */
export function PhotoMenu({ t, disabled, children }: { t: Translate; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); toggle.current?.focus(); };
  return <div className="photo-actions photo-menu"
    onKeyDown={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={toggle} id={photoMenuId} className="button button-secondary" type="button" disabled={disabled}
      aria-expanded={open && !disabled} aria-controls={`${photoMenuId}-panel`} onClick={() => setOpen(value => !value)}>
      <Icon name="photo" />{t('capture.photoOptions')}</button>
    <div id={`${photoMenuId}-panel`} className="photo-menu-panel" hidden={!open || disabled}
      onClick={(event) => { if (event.target instanceof Element && event.target.closest('button')) close(); }}>
      {children}
    </div>
  </div>;
}
