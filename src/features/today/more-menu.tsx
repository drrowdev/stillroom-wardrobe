import type { ReactNode, RefObject } from 'react';

export const moreOptionsId = 'today-more-options';

// "More options": a disclosure (not an ARIA menu) holding plain buttons in DOM order, like the photo options. Escape
// closes it and returns focus to the toggle; the actions inside decide where focus goes next.
export function MoreMenu({ label, open, disabled, toggle, onOpen, children }: {
  label: string; open: boolean; disabled: boolean; toggle: RefObject<HTMLButtonElement | null>; onOpen: (open: boolean) => void; children: ReactNode;
}) {
  return <div className="today-menu"
    onKeyDown={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpen(false); toggle.current?.focus(); } }}>
    <button ref={toggle} id={moreOptionsId} type="button" className="button button-quiet today-menu-toggle" aria-label={label}
      aria-expanded={open && !disabled} aria-controls={`${moreOptionsId}-panel`} disabled={disabled} onClick={() => onOpen(!open)}>
      <span aria-hidden="true">…</span></button>
    <div id={`${moreOptionsId}-panel`} className="today-menu-panel" hidden={!open || disabled}>{children}</div>
  </div>;
}
