import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import { validDescription } from '../../domain/item-details';
import { ItemForm } from './item-form';
import { Icon } from '../../app/icon';
import type { Language, MessageKey, Translate } from '../../i18n';
import { LazyBoundary } from '../../app/lazy';
import { lazyNamed } from '../../app/lazy-load';
import type { AiClient } from '../../data/ai';
import { AnalysisStatus } from './analysis-status';
import type { BeforeDiscard } from '../../app/dialog';
import { BackgroundNote, BackgroundStatus, ReanalyseNote } from './background';
import { preparingMessage } from './use-background';
import { EnhancementStatus } from './enhancement-status';
import { PhotoChoice, PhotoMenu } from './photo-actions';
import { loadImaging, preparationErrors, usePhotoDraft } from './use-photo-draft';

const CropEditor = lazyNamed(() => import('../../images/crop-editor'), 'CropEditor');
const photoErrors = new Set<MessageKey>([...Object.values(preparationErrors), 'chunk.failed']);
function focusGarmentField(id: string): void {
  const input = document.getElementById(id);
  let ancestor = input?.parentElement;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  requestAnimationFrame(() => input?.focus());
}
type Props = {
  client: AppClient; scope: OwnerScope; currency: string; online: boolean; t: Translate; language: Language;
  onSaved: () => void; onBack: () => void; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  ai: AiClient; onBeforeDiscard: (handler: BeforeDiscard | null) => void;
};
function CameraHelp({ t }: { t: Translate }) {
  return <details className="copy-details"><summary>{t('photo.cameraHelp')}</summary><p>{t('photo.cameraFallback')}</p></details>;
}
const focusFor = (id: string, kind: 'element' | 'field') => {
  if (kind === 'field') focusGarmentField(id); else document.getElementById(id)?.focus();
};
export function AddItem({ client, scope, currency, online, t, language, onSaved, onBack, onDirty, ai, onBeforeDiscard }: Props) {
  const [cameraTrouble, setCameraTrouble] = useState(false);
  const photoDraft = usePhotoDraft({ client, scope, currency, online, language, ai, onSaved, onDirty, onBeforeDiscard,
    focus: focusFor, onCommitted: () => setCameraTrouble(false) });
  const {
    photo, preview, provisional, provisionalPreview, fullPhoto, fullPreview, editing, review, acceptedEdit, initialCurrency,
    analysis, background, enhancement, draft, altText, title, preparing, stage, error, invalid, attempt, busy, frozen,
    advanced, focusTarget, choose, acceptReview, cancelReview, reviewOriginal, useOriginalBackground, cancelEdit,
  } = photoDraft;
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const lastSource = useRef<'library' | 'camera' | null>(null);
  useEffect(() => { loadImaging().catch(() => undefined); CropEditor.preload().catch(() => undefined); }, []);
  useEffect(() => {
    if (!focusTarget.current || editing || preparing) return;
    const target = focusTarget.current;
    focusTarget.current = null;
    // Never pull focus away from a field the user has moved to while the photo was being prepared.
    const active = document.activeElement;
    if (active && !active.closest('.photo-panel') && active.matches('input, select, textarea, button, summary, a[href], [contenteditable="true"]')) return;
    document.getElementById(target)?.focus();
  }, [editing, preparing, advanced, photo, focusTarget]);
  useEffect(() => {
    if (error && photoErrors.has(error) && lastSource.current === 'camera') setCameraTrouble(true);
  }, [error]);
  useEffect(() => {
    // A dismissed camera (also a dark or denied one) offers the camera help; older browsers only report failures.
    const input = camera.current;
    const dismissed = () => setCameraTrouble(true);
    input?.addEventListener('cancel', dismissed);
    return () => input?.removeEventListener('cancel', dismissed);
  }, []);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await photoDraft.submit();
  }
  return (
    <section className="capture-page" aria-labelledby="capture-title">
      <button className="text-button back-button" type="button" onClick={onBack} disabled={busy}><Icon name="arrow" />{t('wardrobe.back')}</button>
      <div className="page-heading"><div><h1 id="capture-title" tabIndex={-1}>{t('capture.title')}</h1></div></div>
      <form className={`capture-layout${advanced ? '' : ' capture-step-photo'}`} onSubmit={(event) => { void submit(event); }} noValidate>
        <div className="photo-panel">
          {editing && fullPhoto && fullPreview && !provisional ? <LazyBoundary t={t}
            action={<button id="crop-leave" className="button button-quiet" type="button" onClick={review ? cancelReview : cancelEdit}>{t('photo.cancelCrop')}</button>}>
            <CropEditor preview={fullPreview} width={fullPhoto.width} height={fullPhoto.height}
              accepted={acceptedEdit} preparing={preparing} t={t}
              onApply={photoDraft.applyCrop}
              onCancel={review ? cancelReview : cancelEdit} onAccept={review ? acceptReview : undefined} /></LazyBoundary>
          : (!editing || provisional) && <div className={`capture-photo ${(provisionalPreview ?? preview) ? 'has-photo' : ''}`} aria-busy={preparing}>
            {provisionalPreview ? <img src={provisionalPreview} alt={altText || title || t('capture.photo')} />
            : preview ? <img src={preview} alt={altText || title || t('capture.photo')} /> : preparing ? <div className="photo-prompt"><span className="spinner" /><p role="status">{t(preparingMessage(background.state, background.downloading, 'capture.preparing'))}</p></div> : <div className="photo-prompt"><span className="photo-prompt-icon"><Icon name="photo" /></span><h2>{t('capture.photo')}</h2><p>{t('capture.photoHint')}</p><BackgroundNote t={t} language={language} /></div>}
          </div>}
          <input ref={library} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label={t('capture.library')} disabled={frozen} onChange={(event) => { lastSource.current = 'library'; void choose(event.target.files?.[0]); event.target.value = ''; }} />
          <input ref={camera} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" tabIndex={-1} aria-label={t('capture.camera')} disabled={frozen} onChange={(event) => { lastSource.current = 'camera'; void choose(event.target.files?.[0]); event.target.value = ''; }} />
          {/* Before a photo, and after a replacement fails, the two choices stay outside any disclosure. */}
          {!photo && !review && !editing && <PhotoChoice t={t} disabled={frozen || preparing} chooseId="choose-photo"
            onLibrary={() => library.current?.click()} onCamera={() => camera.current?.click()} />}
          {photo && !editing && <PhotoMenu t={t} disabled={frozen || preparing}>
            <button className="button button-quiet" type="button" disabled={frozen || preparing} onClick={() => library.current?.click()}><Icon name="photo" />{t('capture.replace')}</button>
            <button className="button button-quiet" type="button" disabled={frozen || preparing} onClick={() => camera.current?.click()}><Icon name="camera" />{t('capture.camera')}</button>
            {fullPhoto && fullPreview && <button id="edit-photo" className="button button-quiet" type="button"
              disabled={frozen || preparing} aria-expanded={editing} onClick={photoDraft.startEditing}><Icon name="crop" />{t('photo.edit')}</button>}
            {!provisional && <BackgroundStatus placement="menu" state={background.state} analysed={analysis.phase !== 'off' && analysis.phase !== 'none'}
              disabled={frozen || preparing || busy} t={t} onUseOriginal={useOriginalBackground} />}
            <EnhancementStatus placement="menu" view={enhancement.view} disabled={frozen || preparing || busy} t={t}
              onSkip={enhancement.skip} onRevert={photoDraft.revert} />
            <ReanalyseNote t={t} show={(enhancement.view.enhanced && !enhancement.view.working) || (!provisional && background.state === 'removed' && analysis.phase !== 'off' && analysis.phase !== 'none')} />
            {cameraTrouble && <CameraHelp t={t} />}
          </PhotoMenu>}
          {review && editing && !provisional && <BackgroundStatus state="removed" review analysed={false} disabled={frozen || preparing || busy} t={t} onUseOriginal={reviewOriginal} />}
          {!editing && !provisional && <BackgroundStatus state={background.state} analysed={analysis.phase !== 'off' && analysis.phase !== 'none'}
            disabled={frozen || preparing || busy} t={t} onUseOriginal={useOriginalBackground} />}
          {(!editing || provisional) && <EnhancementStatus view={enhancement.view} disabled={frozen || preparing || busy} t={t}
            onSkip={enhancement.skip} onRevert={photoDraft.revert} onCancelCrop={provisional?.crop ? cancelEdit : undefined} />}
          {(editing || preparing) && !enhancement.view.working && <p id="photo-pending" tabIndex={-1} role="status" className="notice">{t(preparing ? 'photo.pendingPreparation' : 'photo.pendingCrop')}</p>}
          {invalid && !photo && <p className="field-error">{t('common.required')}</p>}
          {error && (!advanced || !photo) && <div className="notice notice-error" role="alert"><p>{t(error)}</p></div>}
          {cameraTrouble && !photo && <CameraHelp t={t} />}
          {!advanced && <button className="text-button capture-step-cancel" type="button" onClick={onBack} disabled={busy}>{t('common.cancel')}</button>}
        </div>
        {advanced && <div className="details-panel">
          <div className="details-heading"><h2 id="capture-basics" tabIndex={-1}>{t('capture.detailsTitle')}</h2></div>
          {photo && !frozen && <AnalysisStatus phase={analysis.phase} checking={analysis.checking} t={t}
            disabled={!online || busy || preparing || editing}
            onRetry={photoDraft.retryAnalysis}
            onCheck={() => { void analysis.checkStatus(); }}
            onKeep={photoDraft.keepDetails} />}
          <ItemForm draft={draft} onChange={photoDraft.editDraft} language={language} t={t} prefix="item" locked={frozen} currency={initialCurrency} showErrors={invalid}
            aiDerived={analysis.state?.status === 'ready' ? analysis.state.derivation : analysis.state ? {} : undefined}>
            <div className="field"><label htmlFor="item-alt">{t('item.altText')}</label>
              <textarea id="item-alt" rows={3} value={altText} readOnly={frozen} onChange={(event) => photoDraft.editDescription(event.target.value)}
                aria-invalid={validDescription(altText) === null} aria-describedby={validDescription(altText) === null ? 'alt-error' : 'alt-help'} />
              <p className="fine muted" id="alt-help">{t('capture.descriptionHelp')}</p>
              {validDescription(altText) === null && <p id="alt-error" role="alert" className="notice notice-error">{t('detail.invalidDescription')}</p>}
            </div>
          </ItemForm>
          {error && advanced && photo && <div className="notice notice-error" role="alert"><p>{t(error)}</p>{attempt && <p>{t('capture.retryNote')}</p>}</div>}
          {frozen && !busy && <p className="fine muted">{t('capture.frozen')}</p>}
          <div className="save-actions"><button className="button button-primary button-wide" type="submit" disabled={!online || busy || preparing || editing || !attempt && !analysis.canSave}>{busy ? <span className="spinner" /> : <Icon name="check" />}{t(stage ?? (attempt ? 'common.retry' : 'capture.save'))}</button><button className="button button-quiet" type="button" onClick={onBack} disabled={busy}>{t('common.cancel')}</button></div>
          {stage && <p className="sr-only" role="status">{t(stage)}</p>}
        </div>}
      </form>
    </section>
  );
}
