import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../app/icon';
import { LazyBoundary } from '../../app/lazy';
import { lazyNamed } from '../../app/lazy-load';
import type { Language, Translate } from '../../i18n';
import type { Facets } from './search';
import type { WardrobeItem } from '../../domain/wardrobe';

const FilterSheet = lazyNamed(() => import('./filter-sheet'), 'FilterSheet');

type Props = {
  items: readonly WardrobeItem[]; value: Facets; onChange: (value: Facets) => void; count: number;
  announcer: ReactNode; onClose: () => void; language: Language; t: Translate;
};
// The Filters sheet. The dialog, its heading and Close are part of the start page, so the sheet is always named,
// focusable and closable; only its body and footer load on demand (filter-sheet.tsx), with loading and error states.
export function FilterDialog({ items, value, onChange, count, announcer, onClose, language, t }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    document.getElementById('filter-sheet-title')?.focus();
    return () => {
      if (!dialog.open) return;
      // Removed without being closed (the list emptied, or the page was left): put focus back on the page if it was here.
      const lost = !dialog.isConnected || dialog.contains(document.activeElement);
      dialog.close();
      if (lost) document.getElementById('wardrobe-title')?.focus();
    };
  }, []);
  const close = () => ref.current?.close();
  // Tab and Shift+Tab wrap inside the sheet in every browser, instead of leaving for the browser's own controls.
  const wrap = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, a[href]')].filter(control => !control.matches(':disabled') && control.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    if (!first || !last) return;
    if (event.shiftKey && (active === first || active?.id === 'filter-sheet-title')) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  return <dialog ref={ref} className="filter-sheet" aria-labelledby="filter-sheet-title" onClose={() => { if (!ref.current?.open) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={wrap}>
    <div className="filter-sheet-panel">
      <div className="filter-sheet-header">
        <h2 id="filter-sheet-title" tabIndex={-1}>{t('common.filters')}</h2>
        {announcer}
        <button type="button" className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={close}><Icon name="close" /></button>
      </div>
      <div className="filter-sheet-body">
        <LazyBoundary t={t}><FilterSheet items={items} value={value} onChange={onChange} count={count} onDone={close} language={language} t={t} /></LazyBoundary>
      </div>
    </div>
  </dialog>;
}
