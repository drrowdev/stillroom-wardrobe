import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Language, Translate } from '../../i18n';
import '../../i18n/tryon';
import { ConfirmDialog } from '../outfits/try-on/try-on-parts';
import { deletionDate } from '../outfits/use-try-on';
import { readPersonPhoto, removePersonPhoto } from './tryon-photo';
import type { TryOnStore } from './tryon-store';

type Props = { store: TryOnStore; online: boolean; language: Language; t: Translate };

/**
 * The owner's saved reference photo (TRYON-PHOTO1): when it exists, when it was saved, and Remove. It needs only an approved
 * owner, so it stays reachable while try-on is off, paused, past review or not supported, and it renders outside every
 * readiness check. After a removal it stays as a one-line confirmation so focus has somewhere to go.
 */
export function SavedPhotoCard({ store, online, language, t }: Props) {
  const photo = useSyncExternalStore(store.subscribePhoto, store.getPhoto);
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void readPersonPhoto(store);
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void readPersonPhoto(store); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [store]);
  useEffect(() => { if (photo.saved) setRemoved(false); }, [photo.saved]);
  // After the confirm dialog has closed (some engines restore focus to the removed button), focus moves to the card's title.
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => heading.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const unknown = photo.read === 'failed' && !photo.saved;
  if (!photo.saved && !removed && !unknown) return null;
  const busy = photo.busy === 'remove';
  async function remove() {
    setConfirming(false);
    const gone = await removePersonPhoto(store);
    if (gone) setRemoved(true);
    else requestAnimationFrame(() => removeButton.current?.focus());
  }
  return <section className="settings-card feature-row" aria-labelledby="tryon-photo-heading" aria-busy={busy}>
    <div className="feature-main">
      <div className="feature-text">
        <h3 id="tryon-photo-heading" ref={heading} tabIndex={-1}>{t('tryon.savedPhoto')}</h3>
        {photo.saved && <p className="feature-description">{t('tryon.photoSavedOn', { date: deletionDate(photo.saved.savedAtMs, language) })}</p>}
      </div>
    </div>
    <div role="status" className="ai-state">
      {busy && <p>{t('common.saving')}</p>}
      {removed && !photo.saved && !unknown && <p>{t('tryon.photoRemoved')}</p>}
    </div>
    {unknown && <p role="alert" className="notice notice-error">{t('tryon.photoStatusFailed')}</p>}
    {(photo.saved || unknown) && <div className="settings-actions">
      {unknown && <button id="tryon-photo-retry" type="button" className="text-button" disabled={!online || busy}
        onClick={() => { void readPersonPhoto(store); }}>{t('common.retry')}</button>}
      <button ref={removeButton} id="tryon-photo-remove" type="button" className="text-button" disabled={!online || busy}
        onClick={() => setConfirming(true)}>{t('tryon.removePhoto')}</button>
    </div>}
    {photo.error === 'remove' && <p role="alert" className="notice notice-error">{t('tryon.removePhotoFailed')}</p>}
    {confirming && <ConfirmDialog id="tryon-photo-confirm" title={t('tryon.removePhotoTitle')} text={t('tryon.removePhotoText')}
      confirm={t('tryon.removePhoto')} cancel={t('common.cancel')} danger
      onConfirm={() => { void remove(); }} onCancel={() => { setConfirming(false); requestAnimationFrame(() => removeButton.current?.focus()); }} />}
  </section>;
}
