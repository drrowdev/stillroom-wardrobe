import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { OwnerScope } from '../../../auth/session';
import type { AppClient } from '../../../data/client';
import { tryOnReady } from '../../../data/tryon';
import type { OutfitComponent } from '../../../domain/outfits';
import type { TryOnSelection, TryOnStep } from '../../../domain/tryon';
import type { Language, MessageKey, Translate } from '../../../i18n';
import '../../../i18n/tryon';
import { BODY_ASPECT, type BodyPhoto } from '../../../images/body-photo';
import { CropEditor } from '../../../images/crop-editor';
import { tryOnStoreFor, type TryOnStore } from '../../settings/tryon-store';
import { loadPersonPhoto, readPersonPhoto, removePersonPhoto, savePersonPhoto, type LoadedPersonPhoto } from '../../settings/tryon-photo';
import { SavedPhotoCard } from '../../settings/saved-photo-card';
import { useOutfit } from '../use-outfits';
import { browserEnvironment, deletionDate, failureAction, ideaSelection, itemName, slotKey, TryOnRun, tryOnSelection, useTryOnStatus, type FailureKind, type RunPhase } from '../use-try-on';
import { ConfirmDialog, TryOnPicture } from './try-on-parts';
import { useBodyPhotoPicker } from './use-body-photo';

type Common = { client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate; onBack: () => void };
type Props = Common & { id: string | null };

const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** Route `#/outfits/<id>/try-on`: the garments, a photo of the owner, then one try-on chain. */
export function TryOnScreen(props: Props) {
  const { client, scope, id, online, t } = props;
  const store = tryOnStoreFor(client, scope);
  const status = useTryOnStatus(store);
  const view = useOutfit(client, scope, id, online, 0);
  const [run, setRun] = useState<TryOnRun | null>(null);
  // Owned here rather than by the keyed run view, so a remount of that view never ends a running chain.
  useEffect(() => () => run?.abandon(), [run]);
  const record = view.data?.record ?? null;
  const title = record ? t('tryon.title', { name: record.title }) : t('tryon.open');
  let body;
  if (run && store) body = <RunView key={run.id} {...props} store={store} run={run} components={view.data?.components ?? new Map()}
    onRestart={() => { run.abandon(); setRun(null); view.reload(); focus('tryon-choose'); }}
    onClose={() => { run.abandon(); props.onBack(); }} />;
  else if (id === null || view.data !== null && record === null) body = <p className="notice notice-error" role="alert">{t('outfits.unavailable')}</p>;
  else if (!view.data || !record) body = view.error
    ? <div className="notice notice-error" role="alert"><span>{t(view.error)}</span><button type="button" className="text-button" disabled={!online} onClick={view.reload}>{t('common.retry')}</button></div>
    : <p role="status">{t('common.loading')}</p>;
  else if (!store || status === null) body = <><p role="status">{t('common.loading')}</p>{store && <SavedPhotoCard store={store} online={online} language={props.language} t={t} />}</>;
  else if (!tryOnReady(status)) body = <>
    <p className="notice" role="status">{t(status.code === 'CONSENT_REQUIRED' ? 'tryon.failure.turnedOff' : 'tryon.failure.unavailable')}</p>
    <SavedPhotoCard store={store} online={online} language={props.language} t={t} />
  </>;
  else body = <Setup {...props} store={store} components={view.data.components} selection={tryOnSelection(record, view.data.components)}
    onStart={(steps, photo) => {
      const next = new TryOnRun(store.api, store, browserEnvironment(), record.id, steps, photo.bytes);
      setRun(next);
      next.start();
      focus('tryon-progress-title');
    }} />;
  return <section className="detail-page tryon-page" aria-labelledby="tryon-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); run?.abandon(); props.onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="tryon-title" tabIndex={-1}>{title}</h1></header>
    {body}
  </section>;
}

/** An unsaved Today idea: its garments are kept in memory by the app for this route only and nothing is saved. */
export type TryOnIdeaSeed = { itemIds: readonly string[]; components: ReadonlyMap<string, OutfitComponent> };

/** Route `#/today/try-on`: the idea's garments, a photo of the owner, then one try-on chain that names the garments, not an outfit. */
export function IdeaTryOnScreen(props: Common & { idea: TryOnIdeaSeed | null }) {
  const { client, scope, idea, t, onBack } = props;
  const store = tryOnStoreFor(client, scope);
  const status = useTryOnStatus(store);
  const selection = useMemo(() => idea ? ideaSelection(idea.itemIds, idea.components) : null, [idea]);
  const [run, setRun] = useState<TryOnRun | null>(null);
  useEffect(() => () => run?.abandon(), [run]);
  // After a reload or a pasted link the idea is gone and there is nothing to try on.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a missing idea sends the owner back
  useEffect(() => { if (!idea) onBack(); }, [idea]);
  let body;
  if (run && store && idea) body = <RunView key={run.id} {...props} store={store} run={run} components={idea.components}
    onRestart={() => { run.abandon(); setRun(null); focus('tryon-choose'); }}
    onClose={() => { run.abandon(); onBack(); }} />;
  else if (!idea || !selection || !store || status === null) body = <><p role="status">{t('common.loading')}</p>{store && <SavedPhotoCard store={store} online={props.online} language={props.language} t={t} />}</>;
  else if (!tryOnReady(status)) body = <>
    <p className="notice" role="status">{t(status.code === 'CONSENT_REQUIRED' ? 'tryon.failure.turnedOff' : 'tryon.failure.unavailable')}</p>
    <SavedPhotoCard store={store} online={props.online} language={props.language} t={t} />
  </>;
  else body = <Setup {...props} store={store} components={idea.components} selection={selection}
    onStart={(steps, photo) => {
      const next = new TryOnRun(store.api, store, browserEnvironment(), { itemIds: steps.map(step => step.itemId) }, steps, photo.bytes);
      setRun(next);
      next.start();
      focus('tryon-progress-title');
    }} />;
  return <section className="detail-page tryon-page" aria-labelledby="tryon-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); run?.abandon(); onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="tryon-title" tabIndex={-1}>{t('tryon.open')}</h1></header>
    {body}
  </section>;
}

type SetupProps = Common & {
  store: TryOnStore; selection: TryOnSelection; components: ReadonlyMap<string, OutfitComponent>;
  onStart: (steps: TryOnStep[], photo: BodyPhoto) => void;
};
type Stored = { kind: 'idle' | 'loading' | 'none' | 'unknown' | 'unusable' | 'failed' } | { kind: 'ready'; photo: Extract<LoadedPersonPhoto, { kind: 'ready' }>; url: string };

function Setup({ store, selection, components, online, language, t, onStart }: SetupProps) {
  const input = useRef<HTMLInputElement>(null);
  const focusStart = useRef(false);
  const [savedThis, setSavedThis] = useState(false);
  const picker = useBodyPhotoPicker({
    onFocus: (target) => focus(target === 'edit' ? 'tryon-edit' : 'tryon-choose'),
    onPrepared: () => { setSavedThis(false); focusStart.current = true; },
    onReset: () => setSavedThis(false),
  });
  const { source, sourceUrl, edit, editing, preparing, photo, photoUrl, error } = picker;
  // TRYON-PHOTO1: the saved reference photo. Its bytes are fetched here for this screen only and dropped with it.
  const saved = useSyncExternalStore(store.subscribePhoto, store.getPhoto);
  const savedAt = saved.saved?.savedAtMs ?? null;
  const [stored, setStored] = useState<Stored>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [removedNote, setRemovedNote] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const photoChosen = photo !== null;
  const readKnown = saved.read !== 'unknown';
  // A failed status read with nothing confirmed: a photo may or may not exist, so it is never treated as "none".
  const statusUnknown = saved.read === 'failed' && saved.saved === null;
  useEffect(() => { void readPersonPhoto(store); }, [store]);
  useEffect(() => {
    if (photoChosen) return;
    if (!readKnown) { setStored({ kind: 'idle' }); return; }
    if (statusUnknown) { setStored({ kind: 'unknown' }); return; }
    if (savedAt === null) { setStored({ kind: 'none' }); return; }
    const controller = new AbortController();
    let url: string | null = null;
    setStored({ kind: 'loading' });
    void loadPersonPhoto(store, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ready') {
        url = URL.createObjectURL(new Blob([result.bytes], { type: 'image/jpeg' }));
        setStored({ kind: 'ready', photo: result, url });
      // A save, removal or consent change moved the state while this was in flight: read it again instead of using the bytes.
      } else if (result.kind === 'stale') {
        if (!store.disposed) { void readPersonPhoto(store); setAttempt((value) => value + 1); }
      } else { setStored({ kind: result.kind }); if (result.kind === 'none') void readPersonPhoto(store); }
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [store, savedAt, readKnown, statusUnknown, photoChosen, attempt]);
  const active: BodyPhoto | null = photo ?? (stored.kind === 'ready' ? stored.photo : null);
  // The start button is enabled only once preparation has finished, so focus moves there after that render.
  useEffect(() => {
    if (preparing || !active || !focusStart.current) return;
    focusStart.current = false;
    document.getElementById('tryon-start')?.focus();
  }, [preparing, active]);
  const { clear } = picker;
  const choose = (file: File | undefined) => { if (file) setRemovedNote(false); return picker.choose(file); };
  const apply = picker.apply, cancelEdit = picker.cancelEdit;
  async function keepPhoto() {
    if (!photo) return;
    const result = await savePersonPhoto(store, photo);
    if (result === 'saved') setSavedThis(true);
  }
  async function removeSaved() {
    setRemoving(false);
    if (await removePersonPhoto(store)) { setRemovedNote(true); focus('tryon-choose'); }
    else requestAnimationFrame(() => removeButton.current?.focus());
  }
  const count = selection.steps.length;
  const shownUrl = photoUrl ?? (stored.kind === 'ready' ? stored.url : null);
  const waiting = !photo && (stored.kind === 'idle' || stored.kind === 'loading') && (!readKnown || savedAt !== null);
  const storedProblem: MessageKey | null = photo ? null : stored.kind === 'unknown' ? 'tryon.photoStatusFailed' : stored.kind === 'unusable' ? 'tryon.photoUnusableSaved' : stored.kind === 'failed' ? 'tryon.photoLoadFailed' : null;
  return <div className="stack">
    {count > 0 && <p id="tryon-subset" className="tryon-subset">{t('tryon.subset')}</p>}
    <ul className="tryon-garments" aria-label={t('tryon.steps')} aria-describedby={count > 0 ? 'tryon-subset' : undefined}>
      {selection.steps.map(step => <li key={step.itemId}>{t('tryon.slotLine', { slot: t(slotKey(step.slot)), name: itemName(components, step.itemId, t) })}</li>)}
    </ul>
    {selection.notIncluded.length > 0 && <p className="muted">{t('tryon.notIncluded', { names: selection.notIncluded.map(item => itemName(components, item, t)).join(', ') })}</p>}
    {!count ? <p className="notice" role="status">{t('tryon.noGarments')}</p> : <>
      <div className="photo-panel">
        {editing && source && sourceUrl && edit ? <CropEditor preview={sourceUrl} width={source.width} height={source.height} accepted={edit}
          preparing={preparing} t={t} aspect={BODY_ASPECT} applyUnchanged={!photo} onApply={(next) => { void apply(next); }} onCancel={cancelEdit} />
          : <div className={`capture-photo tryon-photo ${shownUrl ? 'has-photo' : ''}`} aria-busy={preparing || waiting}>
            {shownUrl ? <img src={shownUrl} alt={t(photo ? 'tryon.photoReady' : 'tryon.savedPhoto')} width={1024} height={1280} />
              : preparing || waiting ? <p role="status">{t(preparing ? 'tryon.preparing' : 'common.loading')}</p>
              : <p className="muted" id="tryon-photo-tip">{t('tryon.photoTip')}</p>}
          </div>}
        <input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label={t('tryon.choosePhoto')}
          onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
        {!editing && !photo && stored.kind === 'ready' && saved.saved && <p className="muted" id="tryon-saved-caption">{t('tryon.photoSavedOn', { date: deletionDate(saved.saved.savedAtMs, language) })}</p>}
        {!editing && <div className="photo-actions">
          <button id="tryon-choose" type="button" className="button button-secondary" disabled={preparing} aria-describedby={shownUrl ? undefined : 'tryon-photo-tip'}
            onClick={() => input.current?.click()}>{t(active ? 'tryon.changePhoto' : 'tryon.choosePhoto')}</button>
          {photo && source && <button id="tryon-edit" type="button" className="button button-quiet" disabled={preparing} onClick={() => picker.startEditing()}>{t('tryon.editCrop')}</button>}
          {photo && !savedThis && readKnown && !statusUnknown && <button id="tryon-save-photo" type="button" className="button button-quiet" disabled={!online || preparing || saved.busy !== null}
            onClick={() => { void keepPhoto(); }}>{t(saved.busy === 'save' ? 'common.saving' : savedAt !== null ? 'tryon.replacePhoto' : 'tryon.savePhoto')}</button>}
          {!photo && (saved.saved || statusUnknown) && <button ref={removeButton} id="tryon-remove-photo" type="button" className="button button-quiet" disabled={!online || saved.busy !== null}
            onClick={() => setRemoving(true)}>{t('tryon.removePhoto')}</button>}
          {(storedProblem === 'tryon.photoLoadFailed' || statusUnknown) && <button id="tryon-photo-retry" type="button" className="button button-quiet" disabled={!online}
            onClick={() => { if (statusUnknown) void readPersonPhoto(store); else setAttempt((value) => value + 1); }}>{t('common.retry')}</button>}
        </div>}
        {photo && statusUnknown && <p className="notice notice-error" role="alert">{t('tryon.photoStatusFailed')}</p>}
        {photo && savedThis && saved.error === null && <p role="status">{t('tryon.photoSaved')}</p>}
        {removedNote && !saved.saved && <p role="status">{t('tryon.photoRemoved')}</p>}
        {saved.error === 'save' && <p className="notice notice-error" role="alert">{t('tryon.photoSaveFailed')}</p>}
        {saved.error === 'remove' && <p className="notice notice-error" role="alert">{t('tryon.removePhotoFailed')}</p>}
        {storedProblem && <p className="notice notice-error" role="alert">{t(storedProblem)}</p>}
        {error && <p className="notice notice-error" role="alert">{t(error)}</p>}
        {removing && <ConfirmDialog id="tryon-remove-photo-confirm" title={t('tryon.removePhotoTitle')} text={t('tryon.removePhotoText')}
          confirm={t('tryon.removePhoto')} cancel={t('common.cancel')} danger onConfirm={() => { void removeSaved(); }}
          onCancel={() => { setRemoving(false); requestAnimationFrame(() => removeButton.current?.focus()); }} />}
      </div>
      {active && !editing && <div className="stack">
        <p className="muted" id="tryon-limit">{t('tryon.limitLine')}</p>
        <button id="tryon-start" type="button" className="button button-primary" aria-describedby="tryon-limit" disabled={!online || preparing}
          onClick={() => { const bytes = active; clear(); onStart(selection.steps, bytes); }}>
          {count === 1 ? t('tryon.startOne') : t('tryon.startMany', { count })}</button>
      </div>}
    </>}
  </div>;
}

const failureKey = (failure: FailureKind): MessageKey => `tryon.failure.${failure}` as MessageKey;

function RunView({ run, store, components, language, online, t, onRestart, onClose }: Common & {
  run: TryOnRun; store: TryOnStore; components: ReadonlyMap<string, OutfitComponent>;
  onRestart: () => void; onClose: () => void;
}) {
  const phase: RunPhase = useSyncExternalStore(run.subscribe, run.get);
  const [confirming, setConfirming] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase.kind === 'failed') focus('tryon-failure-title');
    else if (phase.kind === 'result' || phase.kind === 'stopped') focus('tryon-title');
  }, [phase.kind]);
  const total = run.steps.length;
  if (phase.kind === 'result') return <div className="stack">
    {phase.alreadyFinished && <p role="status">{t('tryon.alreadyFinished')}</p>}
    <TryOnPicture api={store.api} result={{ id: phase.resultId, expiresAtMs: phase.expiresAtMs }} language={language} t={t} online={online} idPrefix="tryon-result">
      <button id="tryon-done" type="button" className="button button-primary" onClick={onClose}>{t('tryon.done')}</button>
    </TryOnPicture>
  </div>;
  if (phase.kind === 'stopped') return <div className="stack">
    <p role="status">{t('tryon.stopped')}</p>
    <div className="outfit-actions"><button type="button" className="button button-secondary" onClick={onClose}>{t('common.close')}</button></div>
  </div>;
  if (phase.kind === 'failed') {
    const action = failureAction[phase.failure];
    return <div className="notice notice-error stack">
      <h2 id="tryon-failure-title" tabIndex={-1}>{t(failureKey(phase.failure))}</h2>
      <div className="outfit-actions">
        {action === 'retry' && <button type="button" className="button button-primary" disabled={!online} onClick={() => run.start()}>{t('common.retry')}</button>}
        {action === 'photo' && <button type="button" className="button button-primary" onClick={onRestart}>{t('tryon.changePhoto')}</button>}
        {action === 'restart' && <button type="button" className="button button-primary" onClick={onRestart}>{t('tryon.startAgain')}</button>}
        <button type="button" className="button button-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </div>;
  }
  const index = phase.kind === 'ready' ? 0 : phase.index;
  const slot = (at: number) => t(slotKey(run.steps[at]!.slot));
  const line = phase.kind === 'stopping' ? t('tryon.stopping')
    : phase.kind === 'checking' ? t(phase.offline ? 'tryon.offline' : 'tryon.checking')
    : t('tryon.progress', { step: index + 1, total, slot: slot(index) });
  return <div className="stack">
    <h2 id="tryon-progress-title" tabIndex={-1}>{t('tryon.steps')}</h2>
    <ol className="tryon-steps">
      {run.steps.map((step, at) => <li key={step.itemId} aria-current={at === index ? 'step' : undefined}>
        {t(at < index ? 'tryon.stepDone' : at === index ? 'tryon.stepNow' : 'tryon.stepWaiting', { slot: slot(at) })}
        <span className="muted">{[' ', itemName(components, step.itemId, t)].join('· ')}</span>
      </li>)}
    </ol>
    <p aria-live="polite" role="status">{line}</p>
    <div className="outfit-actions">
      <button ref={stopButton} id="tryon-stop" type="button" className="button button-secondary" disabled={phase.kind === 'stopping'}
        onClick={() => setConfirming(true)}>{t('tryon.stop')}</button>
    </div>
    {confirming && <ConfirmDialog id="tryon-stop-confirm" title={t('tryon.stopTitle')} text={t('tryon.stopText')} confirm={t('tryon.stopConfirm')}
      cancel={t('tryon.keepGoing')} danger
      onConfirm={() => { setConfirming(false); void run.stop(); focus('tryon-title'); }}
      onCancel={() => { setConfirming(false); requestAnimationFrame(() => stopButton.current?.focus()); }} />}
  </div>;
}
