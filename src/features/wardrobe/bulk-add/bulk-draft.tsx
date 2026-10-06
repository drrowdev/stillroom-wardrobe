import { useEffect, useRef, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AppClient } from '../../../data/client';
import type { AiClient } from '../../../data/ai';
import type { OwnerScope } from '../../../auth/session';
import type { BeforeDiscard } from '../../../app/dialog';
import type { Language, MessageKey, Translate } from '../../../i18n';
import { validDescription } from '../../../domain/item-details';
import { Icon } from '../../../app/icon';
import { LazyBoundary } from '../../../app/lazy';
import { lazyNamed } from '../../../app/lazy-load';
import { ItemForm } from '../item-form';
import { AnalysisStatus } from '../analysis-status';
import { BackgroundStatus, ReanalyseNote } from '../background';
import { EnhancementStatus } from '../enhancement-status';
import { PhotoMenu } from '../photo-actions';
import { usePhotoDraft, type BulkPipeline } from '../use-photo-draft';

const CropEditor = lazyNamed(() => import('../../../images/crop-editor'), 'CropEditor');
export type DraftStatus = 'preparing' | 'removing' | 'cleaning' | 'filling' | 'saving' | 'ready' | 'attention';
const statusKey: Record<Exclude<DraftStatus, 'saving'>, MessageKey> = {
  preparing: 'bulk.preparing', removing: 'bulk.removing', cleaning: 'bulk.cleaning', filling: 'bulk.filling',
  ready: 'bulk.ready', attention: 'bulk.attention',
};
/** What the screen needs from one draft: its status, whether Save all may save it, and its own submit and discard. */
export type DraftHandle = { status: DraftStatus; saveable: boolean; save: () => Promise<void> };
export type DraftLink = Readonly<{
  report: (handle: DraftHandle) => void;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onBeforeDiscard: (handler: BeforeDiscard | null) => void;
  onSaved: () => void;
}>;
type Props = {
  take: () => File | undefined; client: AppClient; scope: OwnerScope; ai: AiClient; currency: string;
  language: Language; t: Translate; online: boolean; pipeline: BulkPipeline; paused: boolean;
  view: 'card' | 'editor' | 'hidden'; host: HTMLElement | null; link: DraftLink; cardId: string;
  onOpen: () => void; onClose: () => void; onRemove: () => void;
};
function focusField(id: string, kind: 'element' | 'field') {
  const target = document.getElementById(id);
  if (kind === 'field') for (let node = target?.parentElement; node; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
  requestAnimationFrame(() => target?.focus());
}

/** One photo of the batch: the same draft pipeline as single Add, shown as a card or, when opened, as its editor. */
export function BulkDraft({ take, client, scope, ai, currency, language, t, online, pipeline, paused, view, host, link, cardId,
  onOpen, onClose, onRemove }: Props) {
  const draft = usePhotoDraft({ client, scope, currency, online, language, ai, onSaved: link.onSaved, onDirty: link.onDirty,
    onBeforeDiscard: link.onBeforeDiscard, focus: focusField, bulk: pipeline });
  const { photo, preview, provisional, provisionalPreview, fullPhoto, fullPreview, editing, acceptedEdit, initialCurrency,
    analysis, background, enhancement, draft: values, altText, title, preparing, stage, error, invalid, attempt, busy, frozen,
    expiredHold, cleanupReason, refilling, refillNote } = draft;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void draft.choose(take());
  });
  const submit = useRef(draft.submit);
  submit.current = draft.submit;
  // Save all and the item's own Save share one submit: a save already running is awaited, never sent again.
  const running = useRef<Promise<void> | null>(null);
  const save = useRef(() => running.current ??= submit.current().finally(() => { running.current = null; }));
  const status: DraftStatus = stage || busy ? 'saving'
    : enhancement.view.working || provisional ? 'cleaning'
      : background.state === 'working' || background.state === 'keeping' ? 'removing'
        : preparing || !photo && !error ? 'preparing'
          : analysis.phase === 'working' || analysis.phase === 'stillWorking' ? 'filling'
            : expiredHold || error || invalid || !photo || !attempt && !analysis.canSave ? 'attention' : 'ready';
  const saveable = online && !busy && !preparing && !editing && !expiredHold && !!photo && (attempt ? true : status === 'ready');
  useEffect(() => { link.report({ status, saveable, save: save.current }); }, [link, status, saveable]);
  const blocked = !online || busy || preparing || editing;
  const retryCleanup = cleanupReason === 'busy' || cleanupReason === 'ambiguous';
  const name = title.trim() || t('bulk.untitled');
  const category = values.raw.category ? t(`categoryOne.${values.raw.category}` as MessageKey) : null;
  const saveLabel = t(attempt ? 'common.retry' : 'common.save');

  if (view === 'hidden' || view === 'editor' && !host) return null;
  if (view === 'card') {
    return <li className="bulk-card" data-source={draft.holdsFile() ? 'file' : 'photo'}>
      <button id={cardId} type="button" className="bulk-card-open" onClick={onOpen}>
        <span className="bulk-thumb">{preview ? <img src={preview} alt="" /> : <span className="spinner" aria-hidden="true" />}</span>
        <span className="bulk-card-text">
          <span id={`${cardId}-name`} className="bulk-card-title">{name}</span>
          {category && <span className="bulk-card-meta">{category}</span>}
          <span className={`bulk-status bulk-status-${status}`}>{status === 'saving' ? t('common.saving') : t(statusKey[status])}</span>
          {error && <span className="bulk-card-meta">{t('bulk.saveFailed')}</span>}
        </span>
        <span className="bulk-card-edit">{t('common.edit')}<Icon name="chevron" /></span>
      </button>
      <div className="bulk-card-actions">
        <button type="button" className="button button-secondary" disabled={!saveable}
          aria-describedby={`${cardId}-name`} onClick={() => { void save.current(); }}>{saveLabel}</button>
        <button type="button" className="button button-quiet" disabled={busy} aria-describedby={`${cardId}-name`}
          onClick={onRemove}>{t('bulk.remove')}</button>
      </div>
    </li>;
  }
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await save.current();
  }
  return createPortal(
    <section className="bulk-editor" aria-labelledby="bulk-edit-title">
      <button className="text-button back-button" type="button" onClick={onClose}><Icon name="arrow" />{t('bulk.backToList')}</button>
      <div className="page-heading"><div><h1 id="bulk-edit-title" tabIndex={-1}>{name}</h1></div></div>
      <form className="capture-layout" onSubmit={(event) => { void onSubmit(event); }} noValidate>
        <div className="photo-panel">
          {editing && fullPhoto && fullPreview && !provisional ? <LazyBoundary t={t}
            action={<button className="button button-quiet" type="button" onClick={draft.cancelEdit}>{t('photo.cancelCrop')}</button>}>
            <CropEditor preview={fullPreview} width={fullPhoto.width} height={fullPhoto.height}
              accepted={acceptedEdit} preparing={preparing} t={t} onApply={draft.applyCrop} onCancel={draft.cancelEdit} /></LazyBoundary>
          : <div className={`capture-photo ${(provisionalPreview ?? preview) ? 'has-photo' : ''}`} aria-busy={preparing}>
            {(provisionalPreview ?? preview) ? <img src={provisionalPreview ?? preview ?? ''} alt={altText || title || t('capture.photo')} />
              : <div className="photo-prompt"><span className="spinner" /><p role="status">{t(statusKey[status === 'saving' ? 'preparing' : status])}</p></div>}
          </div>}
          {photo && !editing && <PhotoMenu t={t} disabled={frozen || preparing}>
            {fullPhoto && fullPreview && <button id="edit-photo" className="button button-quiet" type="button"
              disabled={frozen || preparing} aria-expanded={editing} onClick={draft.startEditing}><Icon name="crop" />{t('photo.edit')}</button>}
            {!provisional && <BackgroundStatus placement="menu" state={background.state} analysed={analysis.phase !== 'off' && analysis.phase !== 'none'}
              disabled={frozen || preparing || busy} t={t} onUseOriginal={draft.useOriginalBackground} />}
            <EnhancementStatus placement="menu" view={enhancement.view} disabled={frozen || preparing || busy} t={t}
              onSkip={enhancement.skip} onRevert={draft.revert} />
            <ReanalyseNote t={t} show={(enhancement.view.enhanced && !enhancement.view.working) || (!provisional && background.state === 'removed' && analysis.phase !== 'off' && analysis.phase !== 'none')} />
          </PhotoMenu>}
          {!editing && !provisional && <BackgroundStatus state={background.state} analysed={analysis.phase !== 'off' && analysis.phase !== 'none'}
            disabled={frozen || preparing || busy} t={t} onUseOriginal={draft.useOriginalBackground} />}
          {(!editing || provisional) && <EnhancementStatus view={enhancement.view} disabled={frozen || preparing || busy} t={t}
            onSkip={enhancement.skip} onRevert={draft.revert} onCancelCrop={provisional?.crop ? draft.cancelEdit : undefined} />}
          {retryCleanup && !frozen && !preparing && <button type="button" className="text-button" disabled={blocked} onClick={draft.retryCleanup}>{t('common.retry')}</button>}
          {(editing || preparing) && !enhancement.view.working && <p id="photo-pending" tabIndex={-1} role="status" className="notice">{t(preparing ? 'photo.pendingPreparation' : 'photo.pendingCrop')}</p>}
          {error && !photo && <div className="notice notice-error" role="alert"><p>{t(error)}</p></div>}
        </div>
        {photo && <div className="details-panel">
          <div className="details-heading"><h2 id="capture-basics" tabIndex={-1}>{t('capture.detailsTitle')}</h2></div>
          {expiredHold && <div id="cleanup-expired" className="notice" tabIndex={-1} role="status">
            <p>{t('bulk.expired')}</p>
            <div className="analysis-actions">
              <button type="button" className="button button-secondary" disabled={busy || refilling} onClick={draft.keepExpired}>{t('aiC.keep')}</button>
              <button type="button" className="text-button" disabled={blocked || paused || refilling} onClick={draft.fillAgain}>{t('bulk.fillAgain')}</button>
            </div>
            {refillNote && <p className="fine">{t(refillNote)}</p>}
          </div>}
          {!frozen && !expiredHold && <AnalysisStatus phase={analysis.phase} checking={analysis.checking} t={t}
            disabled={blocked} retryDisabled={paused}
            onRetry={draft.retryAnalysis} onCheck={() => { void analysis.checkStatus(); }} onKeep={draft.keepDetails} />}
          {paused && <p className="fine muted">{t('bulk.paused')}</p>}
          <ItemForm draft={values} onChange={draft.editDraft} language={language} t={t} prefix="item" locked={frozen || refilling} currency={initialCurrency} showErrors={invalid}
            aiDerived={analysis.state?.status === 'ready' ? analysis.state.derivation : analysis.state ? {} : undefined}>
            <div className="field"><label htmlFor="item-alt">{t('item.altText')}</label>
              <textarea id="item-alt" rows={3} value={altText} readOnly={frozen || refilling} onChange={(event) => draft.editDescription(event.target.value)}
                aria-invalid={validDescription(altText) === null} aria-describedby={validDescription(altText) === null ? 'alt-error' : 'alt-help'} />
              <p className="fine muted" id="alt-help">{t('capture.descriptionHelp')}</p>
              {validDescription(altText) === null && <p id="alt-error" role="alert" className="notice notice-error">{t('detail.invalidDescription')}</p>}
            </div>
          </ItemForm>
          {error && <div className="notice notice-error" role="alert"><p>{t(error)}</p>{attempt && <p>{t('capture.retryNote')}</p>}</div>}
          {frozen && !busy && <p className="fine muted">{t('capture.frozen')}</p>}
          <div className="save-actions">
            <button className="button button-primary button-wide" type="submit" disabled={blocked || expiredHold || !attempt && !analysis.canSave}>
              {busy ? <span className="spinner" /> : <Icon name="check" />}{t(stage ?? (attempt ? 'common.retry' : 'capture.save'))}</button>
            <button className="button button-quiet" type="button" onClick={onRemove} disabled={busy}>{t('bulk.remove')}</button>
          </div>
          {stage && <p className="sr-only" role="status">{t(stage)}</p>}
        </div>}
      </form>
    </section>, host!,
  );
}
