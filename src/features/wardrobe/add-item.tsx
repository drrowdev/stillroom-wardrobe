import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import { categories, categoryKeys, validateDetails } from '../../domain/wardrobe';
import { Icon } from '../../app/icon';
import type { MessageKey, Translate } from '../../i18n';
import { ImagePreparationError, type PreparedPhoto } from '../../images/process-jpeg';
import { prepareImage } from '../../images/process-image';
import { CropEditor } from '../../images/crop-editor';
import { ORIGINAL_EDIT, type PhotoEdit } from '../../images/crop';
import type { ImagePreparationDetails, ImagePreparationStage } from '../../images/jpeg';
import { newSaveAttempt, saveItem, type SaveAttempt, type SaveStage } from '../../images/upload';
import { errorKey, isAborted } from '../../data/errors';

const preparationErrors: Record<ImagePreparationError['code'], MessageKey> = {
  unsupported: 'photo.prepareUnsupported',
  tooLarge: 'photo.prepareTooLarge',
  invalid: 'photo.invalid',
  unavailable: 'photo.prepareUnavailable',
};
const preparationStages: Record<ImagePreparationStage, MessageKey> = {
  source: 'photo.stageSource', decode: 'photo.stageDecode', mainEncode: 'photo.stageMainEncode',
  thumbEncode: 'photo.stageThumbEncode', outputCheck: 'photo.stageOutputCheck', hash: 'photo.stageHash',
};
const preparationReasons: Record<ImagePreparationDetails['reason'], MessageKey> = {
  unsupported: 'photo.reasonUnsupported', tooLarge: 'photo.reasonTooLarge',
  invalid: 'photo.reasonInvalid', unavailable: 'photo.reasonUnavailable',
};
type Props = {
  client: AppClient; scope: OwnerScope; currency: string; online: boolean; t: Translate;
  onSaved: () => void; onBack: () => void; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
};
export function AddItem({ client, scope, currency, online, t, onSaved, onBack, onDirty }: Props) {
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fullPhoto, setFullPhoto] = useState<PreparedPhoto | null>(null);
  const [fullPreview, setFullPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [acceptedEdit, setAcceptedEdit] = useState<PhotoEdit>(ORIGINAL_EDIT);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [altText, setAltText] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [stage, setStage] = useState<SaveStage | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [preparationDetails, setPreparationDetails] = useState<ImagePreparationDetails | null>(null);
  const [showPreparationDetails, setShowPreparationDetails] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const preparationWork = useRef<Promise<void>>(Promise.resolve());
  const original = useRef<Blob | null>(null);
  const focusEditorButton = useRef(false);
  const busy = stage !== null;
  const frozen = attempt !== null;
  const dirty = preparing || photo !== null || Boolean(title || category || altText);
  useEffect(() => { onDirty(dirty, frozen, busy); }, [dirty, frozen, busy, onDirty]);
  useEffect(() => {
    if (focusEditorButton.current && !editing && !preparing) {
      focusEditorButton.current = false;
      document.getElementById('edit-photo')?.focus();
    }
  }, [editing, preparing]);
  useEffect(() => {
    const clear = () => { preparation.current?.abort(); original.current = null; };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { clear(); scope.signal.removeEventListener('abort', clear); };
  }, [scope]);
  useEffect(() => {
    if (!photo) { setPreview(null); return; }
    const url = URL.createObjectURL(photo.main);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    if (!fullPhoto) { setFullPreview(null); return; }
    const url = URL.createObjectURL(fullPhoto.main);
    setFullPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [fullPhoto]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function choose(file: File | undefined): Promise<void> {
    if (!file || frozen || scope.signal.aborted) return;
    original.current = file;
    setEditing(false);
    setFullPhoto(null);
    setAcceptedEdit(ORIGINAL_EDIT);
    setPhoto(null);
    await prepare(file, ORIGINAL_EDIT, true);
  }
  async function prepare(file: Blob, edit: PhotoEdit, replacing = false): Promise<void> {
    if (frozen || scope.signal.aborted) return;
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setPreparing(true);
    setError(null);
    setPreparationDetails(null);
    setShowPreparationDetails(false);
    const previous = preparationWork.current;
    const work = (async () => {
      await previous;
      if (signal.aborted) return;
      try {
        const prepared = await prepareImage(file, signal, edit);
        if (!signal.aborted) {
          setPhoto(prepared);
          if (replacing) setFullPhoto(prepared);
          setAcceptedEdit(edit);
          setEditing(false);
          if (!replacing) focusEditorButton.current = true;
        }
      } catch (problem) {
        if (!signal.aborted && !isAborted(problem)) {
          if (replacing) original.current = null;
          setError(problem instanceof ImagePreparationError ? preparationErrors[problem.code] : 'photo.invalid');
          if (problem instanceof ImagePreparationError && problem.stage) {
            setPreparationDetails({ stage: problem.stage, reason: problem.code });
          }
        }
      } finally { if (!signal.aborted) setPreparing(false); }
    })();
    preparationWork.current = work;
    await work;
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (editing || preparing) {
      document.getElementById(editing ? 'crop-editor-title' : 'photo-pending')?.focus();
      return;
    }
    if (busy || !online) return;
    const details = validateDetails(title, category, altText);
    if (!photo || !details) {
      setInvalid(true);
      document.getElementById(!photo ? 'choose-photo' : !title.trim() ? 'item-title' : !category ? 'item-category' : 'item-alt')?.focus();
      return;
    }
    const current = attempt ?? newSaveAttempt(details, photo, currency);
    setAttempt(current);
    setInvalid(false);
    setError(null);
    try {
      await saveItem(client, scope, current, setStage);
      if (!scope.signal.aborted) {
        original.current = null;
        setPhoto(null);
        setFullPhoto(null);
        onSaved();
      }
    } catch (problem) {
      if (!scope.signal.aborted && !isAborted(problem)) setError(errorKey(problem));
    } finally { if (!scope.signal.aborted) setStage(null); }
  }
  return (
    <section className="capture-page" aria-labelledby="capture-title">
      <button className="text-button back-button" type="button" onClick={onBack} disabled={busy}><Icon name="arrow" />{t('wardrobe.back')}</button>
      <div className="page-heading"><div><p className="eyebrow">{t('capture.eyebrow')}</p><h1 id="capture-title" tabIndex={-1}>{t('capture.title')}</h1><p className="muted">{t('capture.subtitle')}</p></div></div>
      <form className="capture-layout" onSubmit={(event) => { void submit(event); }} noValidate>
        <div className="photo-panel">
          <div className={`capture-photo ${preview ? 'has-photo' : ''}`} aria-busy={preparing}>
            {preview ? <img src={preview} alt={altText || title || t('capture.photo')} /> : preparing ? <div className="photo-prompt"><span className="spinner" /><p role="status">{t('capture.preparing')}</p></div> : <div className="photo-prompt"><span className="photo-prompt-icon"><Icon name="photo" /></span><h2>{t('capture.photo')}</h2><p>{t('capture.photoHint')}</p></div>}
          </div>
          <input ref={library} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label={t('capture.library')} disabled={frozen} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
          <input ref={camera} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" tabIndex={-1} aria-label={t('capture.camera')} disabled={frozen} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
          <div className="photo-actions"><button id="choose-photo" className="button button-secondary" type="button" disabled={frozen || preparing} onClick={() => library.current?.click()}><Icon name="photo" />{t(photo ? 'capture.replace' : 'capture.library')}</button><button className="button button-quiet" type="button" disabled={frozen || preparing} onClick={() => camera.current?.click()}><Icon name="camera" />{t('capture.camera')}</button></div>
          {fullPhoto && fullPreview && <button id="edit-photo" className="button button-secondary" type="button"
            disabled={frozen || preparing} aria-expanded={editing} onClick={() => setEditing(true)}>{t('photo.edit')}</button>}
          {editing && fullPhoto && fullPreview && <CropEditor preview={fullPreview} width={fullPhoto.width} height={fullPhoto.height}
            accepted={acceptedEdit} preparing={preparing} t={t}
            onApply={(edit) => { if (original.current) void prepare(original.current, edit); }}
            onCancel={() => {
              preparation.current?.abort();
              setPreparing(false);
              setEditing(false);
              setError(null);
              focusEditorButton.current = true;
            }} />}
          {(editing || preparing) && <p id="photo-pending" tabIndex={-1} role="status" className="notice">{t(preparing ? 'photo.pendingPreparation' : 'photo.pendingCrop')}</p>}
          {invalid && !photo && <p className="field-error">{t('common.required')}</p>}
          <p className="privacy-note"><Icon name="lock" />{t('capture.local')}</p>
          <p className="fine muted">{t('photo.cameraFallback')}</p>
          {preparationDetails && <>
            <button className="text-button" type="button" aria-expanded={showPreparationDetails} aria-controls="preparation-details" onClick={() => setShowPreparationDetails(!showPreparationDetails)}>{t(showPreparationDetails ? 'photo.hideDetails' : 'photo.showDetails')}</button>
            <section id="preparation-details" aria-label={t('photo.details')} hidden={!showPreparationDetails}>
              <p>{t(preparationStages[preparationDetails.stage])}</p>
              <p>{t(preparationReasons[preparationDetails.reason])}</p>
            </section>
          </>}
        </div>
        <div className="details-panel">
          <div className="details-heading"><span className="section-number" aria-hidden="true">01</span><h2>{t('capture.detailsTitle')}</h2></div>
          <p className="fine muted">{t('capture.manualNote')}</p>
          <div className="field">
            <label htmlFor="item-title">{t('item.title')}</label>
            <input id="item-title" value={title} placeholder={t('capture.namePlaceholder')} maxLength={100} readOnly={frozen} onChange={(event) => setTitle(event.target.value)} aria-invalid={invalid && !title.trim()} aria-describedby={invalid && !title.trim() ? 'title-error' : undefined} />
            {invalid && !title.trim() && <span id="title-error" className="field-error">{t('common.required')}</span>}
          </div>
          <div className="field">
            <label htmlFor="item-category">{t('item.category')}</label>
            <select id="item-category" value={category} disabled={frozen} onChange={(event) => setCategory(event.target.value)} aria-invalid={invalid && !category} aria-describedby={invalid && !category ? 'category-error' : undefined}>
              <option value="">{t('capture.selectCategory')}</option>
              {categories.map((value) => <option key={value} value={value}>{t(categoryKeys[value])}</option>)}
            </select>
            {invalid && !category && <span id="category-error" className="field-error">{t('common.required')}</span>}
          </div>
          <details className="optional-details"><summary>{t('item.details')}<span>{t('common.optional')}</span></summary><div className="field"><label htmlFor="item-alt">{t('item.altText')}</label><textarea id="item-alt" rows={3} value={altText} maxLength={240} readOnly={frozen} onChange={(event) => setAltText(event.target.value)} aria-describedby="alt-help" /><p className="fine muted" id="alt-help">{t('capture.descriptionHelp')}</p></div></details>
          {error && <div className="notice notice-error" role="alert"><p>{t(error)}</p>{attempt && <p>{t('capture.retryNote')}</p>}</div>}
          {frozen && !busy && <p className="fine muted">{t('capture.frozen')}</p>}
          <div className="save-actions"><button className="button button-primary button-wide" type="submit" disabled={!online || busy || preparing || editing}>{busy ? <span className="spinner" /> : <Icon name="check" />}{t(stage ?? (attempt ? 'common.retry' : 'capture.save'))}</button><button className="button button-quiet" type="button" onClick={onBack} disabled={busy}>{t('common.cancel')}</button></div>
          {stage && <p className="sr-only" role="status">{t(stage)}</p>}
        </div>
      </form>
    </section>
  );
}
