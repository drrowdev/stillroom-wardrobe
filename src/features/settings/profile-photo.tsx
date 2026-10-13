import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tryOnReady } from '../../data/tryon';
import type { Language, Translate } from '../../i18n';
import '../../i18n/tryon';
import { BODY_ASPECT } from '../../images/body-photo';
import { CropEditor } from '../../images/crop-editor';
import { ConfirmDialog } from '../outfits/try-on/try-on-parts';
import { useBodyPhotoPicker } from '../outfits/try-on/use-body-photo';
import { deletionDate } from '../outfits/use-try-on';
import { goToSettings } from './go-to-settings';
import { loadPersonPhoto, readPersonPhoto, removePersonPhoto, savePersonPhoto } from './tryon-photo';
import { readTryOnStatus, tryOnViewOf, type TryOnStore } from './tryon-store';

type Props = { store: TryOnStore | null; online: boolean; language: Language; t: Translate };
type Shown = { kind: 'hidden' | 'loading' | 'unusable' | 'failed' } | { kind: 'ready'; url: string };

const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
const refusals: readonly string[] = ['CONSENT_REQUIRED', 'INACTIVE', 'UNCONFIGURED', 'UNAVAILABLE'];

/**
 * PHOTO2: the owner's one saved reference photo under Settings > Profile. Adding or replacing uses the same choose, crop and
 * encode flow as the try-on screen and an explicit Save; Remove needs only an approved owner. The saved bytes are fetched only
 * when the owner asks to see them, held in this component and dropped when hidden or unmounted.
 */
export function ProfilePhoto({ store, ...rest }: Props) {
  return store ? <Block store={store} {...rest} /> : null;
}

function Block({ store, online, language, t }: Props & { store: TryOnStore }) {
  const photo = useSyncExternalStore(store.subscribePhoto, store.getPhoto);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const view = tryOnViewOf(store, state);
  const ready = state.read.kind === 'ready' && tryOnReady(state.read.status);
  const [note, setNote] = useState<{ kind: 'saved'; at: number; generation: number } | { kind: 'removed' } | null>(null);
  const [refused, setRefused] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [show, setShow] = useState(false);
  const [shown, setShown] = useState<Shown>({ kind: 'hidden' });
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusSave = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const problem = useRef<HTMLParagraphElement>(null);
  const picker = useBodyPhotoPicker({
    onFocus: (target) => focus(target === 'edit' ? 'profile-photo-edit' : 'profile-photo-add'),
    onPrepared: () => { focusSave.current = true; },
    onReset: () => setRefused(false),
  });
  const { photo: chosen, preparing, editing, source, sourceUrl, edit } = picker;
  const savedAt = photo.saved?.savedAtMs ?? null;
  const unknown = photo.read === 'failed' && !photo.saved;
  const busy = photo.busy !== null;

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
  useEffect(() => {
    const drop = () => picker.clear();
    store.scope.signal.addEventListener('abort', drop, { once: true });
    return () => store.scope.signal.removeEventListener('abort', drop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `clear` is stable
  }, [store]);
  // A refused file or crop is announced as an alert; keep it in view even when the crop editor is taller than the screen.
  useEffect(() => { if (picker.error) problem.current?.scrollIntoView({ block: 'nearest' }); }, [picker.error]);
  useEffect(() => {
    if (preparing || !chosen || !focusSave.current) return;
    focusSave.current = false;
    document.getElementById('profile-photo-save')?.focus();
  }, [preparing, chosen]);
  // After a confirm dialog has closed (some engines restore focus to the removed button), focus moves to the heading.
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => heading.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [note]);
  useEffect(() => {
    if (!show) { setShown({ kind: 'hidden' }); return; }
    if (savedAt === null) { setShow(false); return; }
    const controller = new AbortController();
    let url: string | null = null;
    setShown({ kind: 'loading' });
    void loadPersonPhoto(store, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ready') {
        url = URL.createObjectURL(new Blob([result.bytes], { type: 'image/jpeg' }));
        setShown({ kind: 'ready', url });
      // A save, removal or consent change moved the state while this was in flight: read it again instead of using the bytes.
      } else if (result.kind === 'stale') {
        if (!store.disposed) { void readPersonPhoto(store); setAttempt((value) => value + 1); }
      } else if (result.kind === 'none') { setShow(false); void readPersonPhoto(store); }
      else setShown({ kind: result.kind });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [store, show, savedAt, attempt]);

  // "Photo saved." belongs to the photo that save confirmed: a removal, replacement, consent withdrawal or newer save (the store's
  // photo generation) ends it, even when the state read that follows fails.
  const confirmed = note?.kind === 'saved' && photo.saved?.savedAtMs === note.at && store.photoGeneration === note.generation;
  const removedNote = note?.kind === 'removed';
  const wanted = photo.saved !== null || unknown || confirmed || removedNote || chosen !== null || editing || ready || view.turnOn;
  if (!wanted) return null;
  const canChoose = ready && photo.read !== 'unknown' && !unknown;
  const hasSaved = photo.saved !== null;

  function choose(file: File | undefined) {
    if (!file) return;
    setNote(null); setShow(false);
    void picker.choose(file);
  }
  async function save() {
    if (!chosen) return;
    setRefused(false);
    const result = await savePersonPhoto(store, chosen);
    if (result === 'saved') {
      const at = store.getPhoto().saved?.savedAtMs;
      picker.clear();
      setNote(at === undefined ? null : { kind: 'saved', at, generation: store.photoGeneration });
      return;
    }
    if (refusals.includes(result)) { setRefused(true); void readTryOnStatus(store, 'active'); }
    requestAnimationFrame(() => document.getElementById('profile-photo-save')?.focus());
  }
  async function remove() {
    setConfirming(false);
    if (await removePersonPhoto(store)) { setNote({ kind: 'removed' }); setShow(false); picker.clear(); }
    else requestAnimationFrame(() => removeButton.current?.focus());
  }
  const saveError = photo.error === 'save' ? (refused ? 'tryonC.photoSaveRefused' : 'tryonC.photoSaveFailed') : null;
  const noRoom = !ready && !view.turnOn && state.read.kind !== 'unknown';
  return <section className="settings-card profile-photo" aria-labelledby="profile-photo-heading" aria-busy={busy || preparing}>
    <h3 id="profile-photo-heading" ref={heading} tabIndex={-1}>{t('tryonC.photoHeading')}</h3>
    {picker.error && <p ref={problem} role="alert" className="notice notice-error">{t(picker.error)}</p>}
    <input ref={input} id="profile-photo-input" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1}
      aria-label={t('tryon.choosePhoto')} onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} />
    {editing && source && sourceUrl && edit
      ? <div className="photo-panel"><CropEditor preview={sourceUrl} width={source.width} height={source.height} accepted={edit}
        preparing={preparing} t={t} aspect={BODY_ASPECT} applyUnchanged={!chosen} onApply={(next) => { void picker.apply(next); }} onCancel={picker.cancelEdit} /></div>
      : <>
        {picker.photoUrl ? <img className="profile-photo-preview" src={picker.photoUrl} alt={t('tryon.photoReady')} width={1024} height={1280} />
          : shown.kind === 'ready' && <img className="profile-photo-preview" src={shown.url} alt={t('tryon.savedPhoto')} width={1024} height={1280} />}
        {hasSaved && !chosen && <p className="muted">{t('tryon.photoSavedOn', { date: deletionDate(photo.saved!.savedAtMs, language) })}</p>}
        {!hasSaved && !unknown &&         !chosen && !removedNote && photo.read !== 'unknown' && <p className="muted">{t('tryonC.photoEmpty')}</p>}
                {hasSaved && !chosen && <p className="muted fine">{t('tryonC.photoPrivate')}</p>}
        {!ready && view.turnOn && <p className="muted">{t('tryonC.photoNeedsOn')}</p>}
        {noRoom && <p className="muted">{t('tryon.failure.unavailable')}</p>}
        <div role="status" className="ai-state">
          {busy && <p>{t('common.saving')}</p>}
          {preparing && <p>{t('tryon.preparing')}</p>}
          {shown.kind === 'loading' && <p>{t('common.loading')}</p>}
          {confirmed && !chosen && <p>{t('tryon.photoSaved')}</p>}
          {removedNote && !hasSaved && !unknown && <p>{t('tryon.photoRemoved')}</p>}
        </div>
        {unknown && <p role="alert" className="notice notice-error">{t('tryon.photoStatusFailed')}</p>}
        {saveError && <p role="alert" className="notice notice-error">{t(saveError)}</p>}
        {photo.error === 'remove' && <p role="alert" className="notice notice-error">{t('tryon.removePhotoFailed')}</p>}
        {shown.kind === 'failed' && <p role="alert" className="notice notice-error">{t('tryon.photoLoadFailed')}</p>}
        {shown.kind === 'unusable' && <p role="alert" className="notice notice-error">{t('tryon.photoUnusableSaved')}</p>}
        <div className="settings-actions">
          {chosen && canChoose && <button id="profile-photo-save" type="button" className="button button-primary" disabled={!online || preparing || busy}
            onClick={() => { void save(); }}>{t(photo.busy === 'save' ? 'common.saving' : 'tryon.savePhoto')}</button>}
          {chosen && picker.source && <button id="profile-photo-edit" type="button" className="button button-secondary" disabled={preparing || busy}
            onClick={picker.startEditing}>{t('tryon.editCrop')}</button>}
          {chosen && <button id="profile-photo-cancel" type="button" className="text-button" disabled={busy}
            onClick={() => { picker.clear(); focus('profile-photo-add'); }}>{t('common.cancel')}</button>}
          {!chosen && canChoose && <button id="profile-photo-add" type="button" className="button button-secondary" disabled={!online || preparing || busy}
            onClick={() => input.current?.click()}>{t(hasSaved ? 'tryonC.photoReplace' : 'tryonC.photoAdd')}</button>}
          {!ready && view.turnOn && <button id="profile-photo-turn-on" type="button" className="button button-secondary"
            onClick={() => goToSettings('tryon-heading')}>{t('tryonC.photoTurnOn')}</button>}
          {!chosen && hasSaved && <button id="profile-photo-show" type="button" className="text-button" disabled={!online || busy} aria-expanded={show}
            onClick={() => setShow((value) => !value)}>{t(show ? 'tryonC.photoHide' : 'tryonC.photoShow')}</button>}
          {!chosen && (unknown || shown.kind === 'failed') && <button id="profile-photo-retry" type="button" className="text-button" disabled={!online || busy}
            onClick={() => { if (unknown) void readPersonPhoto(store); else setAttempt((value) => value + 1); }}>{t('common.retry')}</button>}
          {!chosen && (hasSaved || unknown) && <button ref={removeButton} id="profile-photo-remove" type="button" className="text-button" disabled={!online || busy}
            onClick={() => setConfirming(true)}>{t('tryon.removePhoto')}</button>}
        </div>
      </>}
    {confirming && <ConfirmDialog id="profile-photo-remove-confirm" title={t('tryon.removePhotoTitle')} text={t('tryon.removePhotoText')}
      confirm={t('tryon.removePhoto')} cancel={t('common.cancel')} danger
      onConfirm={() => { void remove(); }} onCancel={() => { setConfirming(false); requestAnimationFrame(() => removeButton.current?.focus()); }} />}
  </section>;
}
