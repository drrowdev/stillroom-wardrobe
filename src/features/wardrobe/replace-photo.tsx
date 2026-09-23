import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { AiClient } from '../../data/ai';
import { AnalyzedSaveRefusedError, AppError, errorKey } from '../../data/errors';
import { DiscardDialog, type BeforeDiscard } from '../../app/dialog';
import { newImageChangeAttempt, matchImageChangeReceipt, type ImageChangeAttempt, type ImageChangeReceipt, type RecoveryVersion } from '../../domain/image-replacement';
import type { ItemBaseline, ImageBaseline } from '../../domain/item-details';
import { validDescription } from '../../domain/item-details';
import { newGarmentDraft } from '../../domain/garment-fields';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import { ImageChangeClient } from '../../images/replace';
import type { PrivateImages } from '../../images/private-images';
import { prepareImage } from '../../images/process-image';
import { ImagePreparationError, type PreparedPhoto } from '../../images/process-jpeg';
import { CropEditor } from '../../images/crop-editor';
import { ORIGINAL_EDIT, type PhotoEdit } from '../../images/crop';
import type { SaveStage } from '../../images/upload';
import { useAiDraft } from './use-ai-draft';
import { ItemForm } from './item-form';

type Props = {
  client: AppClient; scope: OwnerScope; ai: AiClient; images: PrivateImages;
  item: ItemBaseline; image: ImageBaseline; online: boolean; t: Translate; language: Language;
  mode: 'replacement' | 'recovery'; onClose: () => void; onSaved: () => void;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onBeforeDiscard: (handler: BeforeDiscard | null) => void;
};
function usePreview(photo: PreparedPhoto | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) { setUrl(null); return; }
    const url = URL.createObjectURL(photo.main);
    setUrl(url); return () => URL.revokeObjectURL(url);
  }, [photo]);
  return url;
}
function useChange(props: Props, discardDraft: BeforeDiscard) {
  const changes = useMemo(() => new ImageChangeClient(props.client, props.scope), [props.client, props.scope]);
  const lifetime = useRef(new AbortController());
  const latch = useRef(false);
  const [attempt, setAttempt] = useState<ImageChangeAttempt | null>(null);
  const [pending, setPending] = useState<ImageChangeReceipt[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SaveStage | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [discard, setDiscard] = useState(false);
  const receipt = useRef<ImageChangeReceipt | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const discardFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void changes.requests(props.item.id, controller.signal).then(rows => {
      if (!controller.signal.aborted && !props.scope.signal.aborted) { setPending(rows); setReady(true); }
    }, error => { if (!controller.signal.aborted && !props.scope.signal.aborted) setError(errorKey(error)); });
    return () => controller.abort();
  }, [changes, props.item.id, props.scope]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error, busy]);
  function confirmed() {
    props.images.invalidate([props.image.mainPath, props.image.thumbPath]);
    props.onSaved();
  }
  const beforeDiscard: BeforeDiscard = async () => {
    if (latch.current || props.scope.signal.aborted) return 'unresolved';
    latch.current = true; setBusy(true);
    try {
      if (attempt) {
        const status = await changes.status(attempt.intent.itemId, attempt.intent.requestId, lifetime.current.signal);
        if (!status) return 'unresolved';
        const checked = matchImageChangeReceipt(status, attempt, receipt.current ?? undefined);
        const outcome = checked.state === 'reserved' ? await changes.cancel(checked, lifetime.current.signal) : checked;
        if (outcome.state === 'completed') { confirmed(); return 'saved'; }
        if (outcome.state !== 'cancelled') return 'unresolved';
      }
      return await discardDraft();
    } catch { return 'unresolved'; }
    finally { latch.current = false; if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    props.onBeforeDiscard(beforeDiscard);
    return () => props.onBeforeDiscard(null);
  });
  async function save(create: () => ImageChangeAttempt, refused?: () => void) {
    if (latch.current || !props.online || !ready || pending.length || props.scope.signal.aborted) return;
    latch.current = true; setBusy(true); setError(null);
    let current = attempt;
    try {
      current ??= create();
      setAttempt(current);
      await changes.save(current, setStage, value => { receipt.current = value; }, lifetime.current.signal);
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) { confirmed(); props.onClose(); }
    } catch (error) {
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) {
        if (error instanceof AnalyzedSaveRefusedError && current?.intent.claim !== null && receipt.current === null
          && error.itemId === current?.intent.itemId && error.imageId === current.intent.imageId && refused) {
          setAttempt(null); refused();
        } else setError(errorKey(error));
      }
    } finally {
      latch.current = false;
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) { setBusy(false); setStage(null); }
    }
  }
  async function cancelPending(row: ImageChangeReceipt) {
    if (latch.current || !props.online) return;
    latch.current = true; setBusy(true); setError(null);
    try {
      const outcome = await changes.cancel(row, lifetime.current.signal);
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) {
        if (outcome.state === 'completed') { confirmed(); props.onClose(); }
        else setPending(rows => rows.filter(value => value.requestId !== row.requestId));
      }
    } catch (error) { if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setError(errorKey(error)); }
    finally { latch.current = false; if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setBusy(false); }
  }
  return { changes, attempt, busy, stage, save, ready: ready && pending.length === 0,
    frozen: attempt !== null || busy || !ready || pending.length > 0,
    cancel: () => { discardFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDiscard(true); },
    feedback: <>
      {!ready && !error && <p role="status">{props.t('common.loading')}</p>}
      {pending.length > 0 && <section className="notice" aria-label={props.t('imageChange.pending')}>
        <p>{props.t('imageChange.pending')}</p>
        {pending.map((row, index) => <button key={row.requestId} className="button button-secondary" type="button" disabled={busy || !props.online}
          onClick={() => { void cancelPending(row); }}>{props.t('imageChange.cancelPending', { number: new Intl.NumberFormat(locales[props.language]).format(index + 1) })}</button>)}
      </section>}
      {error && <div ref={alert} role="alert" tabIndex={-1} className="notice notice-error"><p>{props.t(error)}</p>
        {attempt && <p>{props.t('imageChange.uncertain')}</p>}
        {!ready && <button type="button" className="text-button" onClick={props.onClose}>{props.t('common.back')}</button>}
      </div>}
      {discard && <DiscardDialog title={props.t('common.unsaved')} t={props.t} beforeConfirm={beforeDiscard}
        onConfirm={props.onClose} onCancel={() => { setDiscard(false); requestAnimationFrame(() => discardFocus.current?.focus()); }}>
        <p>{props.t('imageChange.discard')}</p>
      </DiscardDialog>}
    </>,
  };
}
function Frame({ props, children }: { props: Props; children: ReactNode }) {
  useEffect(() => { document.getElementById('image-change-title')?.focus(); }, []);
  return <section className="image-change" aria-labelledby="image-change-title">
    <h2 id="image-change-title" tabIndex={-1}>{props.t(props.mode === 'replacement' ? 'imageChange.replace' : 'imageChange.recover')}</h2>
    {children}
  </section>;
}
function Replacement(props: Props) {
  const analysis = useAiDraft(props.ai, props.item.values.currency, props.language, { values: props.item.values, provenance: props.item.provenance });
  const change = useChange(props, async () => {
    analysis.stop();
    const state = analysis.snapshot().state;
    if (state?.context && state.status !== 'idle' && state.status !== 'cancelled') await props.ai.discard(state.context);
    return 'cancelled';
  });
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [full, setFull] = useState<PreparedPhoto | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>(ORIGINAL_EDIT);
  const [editing, setEditing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const original = useRef<Blob | null>(null);
  const work = useRef<AbortController | null>(null);
  const preparation = useRef<Promise<void>>(Promise.resolve());
  const library = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null);
  const preview = usePreview(photo), fullPreview = usePreview(full);
  const { onDirty } = props;
  useEffect(() => {
    onDirty(photo !== null || preparing || !!Object.keys(analysis.draft.intent).length || analysis.descriptionEdited,
      change.attempt !== null, change.busy || preparing);
    return () => onDirty(false, false, false);
  }, [photo, preparing, analysis.draft.intent, analysis.descriptionEdited, change.attempt, change.busy, onDirty]);
  useEffect(() => {
    const clear = () => { work.current?.abort(); original.current = null; };
    props.scope.signal.addEventListener('abort', clear, { once: true });
    return () => { clear(); props.scope.signal.removeEventListener('abort', clear); };
  }, [props.scope]);
  async function prepare(source: Blob, next: PhotoEdit, replacing: boolean) {
    if (change.frozen) return;
    work.current?.abort(); analysis.stop();
    const controller = new AbortController(); work.current = controller;
    const signal = AbortSignal.any([controller.signal, props.scope.signal]);
    setPreparing(true); setError(null);
    const previous = preparation.current;
    preparation.current = (async () => {
      await previous;
      if (signal.aborted) return;
      try {
        const value = await prepareImage(source, signal, next);
        if (signal.aborted) return;
        setPhoto(value); setEdit(next); setEditing(false);
        if (replacing) setFull(value);
        void analysis.commitPhoto(value);
        if (!replacing) requestAnimationFrame(() => document.getElementById('image-change-edit')?.focus());
      } catch (error) {
        if (!signal.aborted) setError(error instanceof ImagePreparationError
          ? error.code === 'tooLarge' ? 'photo.prepareTooLarge' : error.code === 'unsupported' ? 'photo.prepareUnsupported'
            : error.code === 'unavailable' ? 'photo.prepareUnavailable' : 'photo.invalid' : 'photo.invalid');
      } finally { if (!signal.aborted) setPreparing(false); }
    })();
    await preparation.current;
  }
  function choose(file?: File) {
    if (!file || change.frozen || preparing) return;
    original.current = file; setPhoto(null); setFull(null); setEditing(false);
    void prepare(file, ORIGINAL_EDIT, true);
  }
  const { t } = props;
  const formBaseline = { ...props.item.values };
  for (const [field, entry] of Object.entries(analysis.state?.derivation ?? {})) {
    if (entry) Object.assign(formBaseline, { [field]: typeof entry.value === 'object' ? [...entry.value] : entry.value });
  }
  if (!analysis.draft.intent.tags && analysis.state?.status !== 'invalidated' && analysis.state?.eligibility?.tags) {
    formBaseline.tags = [...analysis.draft.raw.tags];
  }
  return <Frame props={props}>
    <form className="capture-layout" noValidate onSubmit={event => {
      event.preventDefault();
      if (!photo || preparing || editing || !change.attempt && !analysis.canSave) return;
      void change.save(() => {
        const view = analysis.snapshot();
        if (!view.manual && !view.state) throw new AppError('error.conflict');
        return newImageChangeAttempt(props.item, props.image, view.draft, view.description, photo, props.scope,
          view.manual ? undefined : view.state!);
      }, analysis.refuseSave);
    }}>
      <div className="photo-panel">
        {editing && full && fullPreview ? <CropEditor preview={fullPreview} width={full.width} height={full.height}
          accepted={edit} preparing={preparing} t={t} onApply={next => { if (original.current) void prepare(original.current, next, false); }}
          onCancel={() => { work.current?.abort(); setPreparing(false); setEditing(false); requestAnimationFrame(() => document.getElementById('image-change-edit')?.focus()); }} />
          : <div className="capture-photo">{preview ? <img src={preview} alt={analysis.description || props.item.title} /> : <p>{t('capture.photo')}</p>}</div>}
        <input ref={library} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1}
          aria-label={t('capture.library')} disabled={change.frozen || preparing} onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
        <input ref={camera} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" tabIndex={-1}
          aria-label={t('capture.camera')} disabled={change.frozen || preparing} onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
        <div className="photo-actions">
          <button className="button button-secondary" type="button" disabled={change.frozen || preparing} onClick={() => library.current?.click()}>{t('capture.library')}</button>
          <button className="button button-quiet" type="button" disabled={change.frozen || preparing} onClick={() => camera.current?.click()}>{t('capture.camera')}</button>
          {photo && !editing && <button id="image-change-edit" className="button button-secondary" type="button"
            disabled={change.frozen || preparing} onClick={() => setEditing(true)}>{t('photo.edit')}</button>}
        </div>
        {preparing && <p role="status">{t('capture.preparing')}</p>}
        {error && <p role="alert" className="notice notice-error">{t(error)}</p>}
        <p className="privacy-note">{t('aiC.photoNotice')}</p>
      </div>
      <div className="details-panel">
        {analysis.notice && <p role="status" className="notice">{t(analysis.notice)}</p>}
        {photo && !change.attempt && <div className="settings-actions">
          <button type="button" className="text-button" disabled={!props.online || change.frozen || analysis.working || analysis.manual}
            onClick={() => { void analysis.checkStatus(); }}>{t('aiC.checkStatus')}</button>
          <button type="button" className="button button-secondary" disabled={change.frozen || analysis.manual}
            onClick={() => { void analysis.continueManual(); }}>{t('aiC.continueManual')}</button>
          <button type="button" className="text-button" disabled={!props.online || change.frozen || analysis.working || preparing || editing}
            onClick={() => { void analysis.commitPhoto(photo); }}>{t('aiC.newAnalysis')}</button>
        </div>}
        <ItemForm draft={analysis.draft} baseline={formBaseline} provenance={props.item.provenance} onChange={analysis.edit}
          language={props.language} t={t} prefix="item" locked={change.frozen} currency={props.item.values.currency}
          aiDerived={analysis.state?.derivation ?? {}}>
          <div className="field"><label htmlFor="image-change-caption">{t('item.altText')}</label>
            <textarea id="image-change-caption" rows={3} value={analysis.description} readOnly={change.frozen}
              aria-invalid={validDescription(analysis.description) === null} onChange={event => analysis.editDescription(event.target.value)} /></div>
        </ItemForm>
        {change.feedback}
        <div className="save-actions">
          <button className="button button-primary" type="submit" disabled={!props.online || change.busy || !change.ready || !photo || preparing || editing || !change.attempt && !analysis.canSave}>
            {t(change.stage ?? (change.attempt ? 'common.retry' : 'imageChange.save'))}</button>
          <button className="button button-quiet" type="button" disabled={change.busy || preparing} onClick={change.cancel}>{t('common.cancel')}</button>
        </div>
      </div>
    </form>
  </Frame>;
}
function Recovery(props: Props) {
  const change = useChange(props, async () => 'cancelled');
  const [versions, setVersions] = useState<RecoveryVersion[]>([]);
  const [after, setAfter] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RecoveryVersion | null>(null);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const lifetime = useRef(new AbortController());
  const latch = useRef(false);
  const preview = usePreview(photo);
  const { onDirty } = props;
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { onDirty(selected !== null, change.attempt !== null, change.busy || busy); return () => onDirty(false, false, false); },
    [selected, change.attempt, change.busy, busy, onDirty]);
  async function load() {
    if (latch.current || !props.online) return;
    latch.current = true; setBusy(true); setError(null);
    try {
      const rows = await change.changes.versions(props.item.id, after, lifetime.current.signal);
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) {
        setVersions(old => after ? [...old, ...rows] : rows); setAfter(rows.length === 40 ? rows.at(-1)!.id : undefined); setLoaded(true);
      }
    } catch (error) { if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setError(errorKey(error)); }
    finally { latch.current = false; if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setBusy(false); }
  }
  async function select(row: RecoveryVersion) {
    if (latch.current || !props.online || change.frozen || !row.eligible) return;
    latch.current = true; setBusy(true); setError(null);
    try {
      const photo = await change.changes.recoverPhoto(row, lifetime.current.signal);
      if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) {
        setSelected(row); setPhoto(photo); setDescription(row.altText);
      }
    } catch (error) { if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setError(errorKey(error)); }
    finally { latch.current = false; if (!lifetime.current.signal.aborted && !props.scope.signal.aborted) setBusy(false); }
  }
  const { t } = props;
  return <Frame props={props}>
    <p>{t('imageChange.recoveryHelp')}</p>
    {!loaded && <button className="button button-secondary" disabled={!props.online || busy || change.frozen} onClick={() => { void load(); }}>{t('imageChange.loadVersions')}</button>}
    <ul className="recovery-versions">{versions.map(row => <li key={row.id}>
      <button className="button button-secondary" disabled={!row.eligible || !props.online || busy || change.frozen} aria-pressed={selected?.id === row.id}
        onClick={() => { void select(row); }}>{new Intl.DateTimeFormat(locales[props.language], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.retiredAt))}</button>
      {!row.eligible && <span>{t('imageChange.expired')}</span>}
    </li>)}</ul>
    {loaded && !versions.length && <p>{t('imageChange.noVersions')}</p>}
    {loaded && after && <button className="button button-secondary" disabled={busy || change.frozen || !props.online} onClick={() => { void load(); }}>{t('wardrobe.more')}</button>}
    {busy && <p role="status">{t('common.loading')}</p>}
    {photo && <div className="recovery-preview">
      {preview && <img src={preview} alt={description || props.item.title} />}
      <div className="field"><label htmlFor="image-change-caption">{t('item.altText')}</label>
        <textarea id="image-change-caption" rows={3} readOnly={change.frozen} value={description}
          aria-invalid={validDescription(description) === null} onChange={event => setDescription(event.target.value)} /></div>
    </div>}
    {error && <p role="alert" className="notice notice-error">{t(error)}</p>}
    {change.feedback}
    <div className="save-actions">
      <button className="button button-primary" disabled={!photo || !selected || !props.online || !change.ready || change.busy || busy}
        onClick={() => { if (selected && photo) void change.save(() => newImageChangeAttempt(props.item, props.image,
          newGarmentDraft(props.item.values.currency, props.language, props.item.values), description, photo, props.scope, undefined, selected)); }}>
        {t(change.stage ?? (change.attempt ? 'common.retry' : 'imageChange.saveRecovery'))}</button>
      <button className="button button-quiet" disabled={change.busy || busy} onClick={change.cancel}>{t('common.cancel')}</button>
    </div>
  </Frame>;
}
export function ReplacePhoto(props: Props) {
  return props.mode === 'replacement' ? <Replacement {...props} /> : <Recovery {...props} />;
}
