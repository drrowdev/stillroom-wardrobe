import { useEffect, useState } from 'react';
import { pluralText, type Language, type Translate } from '../../i18n';
import type { BulkNotice, BulkTrash } from './use-bulk-trash';

export function BulkBar({ bulk, online, onCancel, language, t }: { bulk: BulkTrash; online: boolean; onCancel: () => void; language: Language; t: Translate }) {
  return <div className="bulk-bar">
    <p role="status" className="bulk-count">{pluralText(language, 'wardrobe.selected', bulk.selected.size)}</p>
    {bulk.failed > 0 && <p role="alert" className="bulk-failed">{pluralText(language, 'wardrobe.bulkFailed', bulk.failed)}</p>}
    {!online && <p className="bulk-offline">{t('common.offline')}</p>}
    <div className="bulk-actions">
      <button type="button" className="button button-primary" disabled={!bulk.selected.size || bulk.busy !== null || !online} onClick={bulk.trash}>
        {t('wardrobe.moveSelected')}</button>
      <button type="button" className="button button-secondary" disabled={bulk.busy !== null} onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  </div>;
}

export function BulkUndoNotice({ notice, busy, online, onUndo, language, t }: {
  notice: BulkNotice; busy: boolean; online: boolean; onUndo: () => void; language: Language; t: Translate;
}) {
  const expiresAt = notice.kind === 'trashed' ? notice.expiresAt : 0;
  const [expired, setExpired] = useState(() => performance.now() >= expiresAt);
  useEffect(() => {
    if (notice.kind !== 'trashed') return;
    const update = () => {
      if (performance.now() >= expiresAt) {
        if (document.activeElement?.id === 'bulk-undo') document.getElementById('wardrobe-title')?.focus();
        setExpired(true);
      }
    };
    const timer = setTimeout(update, Math.max(0, expiresAt - performance.now()));
    window.addEventListener('focus', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [notice.kind, expiresAt]);
  return <div className="notice lifecycle-undo">
    {notice.kind === 'trashed'
      ? <p role="status">{pluralText(language, 'wardrobe.bulkTrashed', notice.count)}</p>
      : <p role="alert">{pluralText(language, 'wardrobe.bulkRestoreFailed', notice.count)}</p>}
    {notice.kind === 'trashed' && !expired && <button id="bulk-undo" type="button" className="text-button" disabled={busy || !online}
      onClick={() => { if (performance.now() >= expiresAt) setExpired(true); else onUndo(); }}>{t('common.undo')}</button>}
    <a className="text-button" href="#/trash">{t('nav.trash')}</a>
  </div>;
}
