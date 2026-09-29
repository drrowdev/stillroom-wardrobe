import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { OwnerScope } from '../../../auth/session';
import type { AppClient } from '../../../data/client';
import { tryOnReady } from '../../../data/tryon';
import type { OutfitComponent, OutfitRecord } from '../../../domain/outfits';
import type { TryOnStep } from '../../../domain/tryon';
import type { Language, MessageKey, Translate } from '../../../i18n';
import { BODY_ASPECT, BodyPhotoError, admitBodySource, prepareBodyPhoto, type BodyPhoto, type BodySource } from '../../../images/body-photo';
import { largestAspectCrop, type PhotoEdit } from '../../../images/crop';
import { CropEditor } from '../../../images/crop-editor';
import { tryOnStoreFor, type TryOnStore } from '../../settings/tryon-store';
import { useOutfit } from '../use-outfits';
import { browserEnvironment, failureAction, itemName, slotKey, TryOnRun, tryOnSelection, useTryOnStatus, type FailureKind, type RunPhase } from '../use-try-on';
import { ConfirmDialog, TryOnPicture } from './try-on-parts';

type Props = { client: AppClient; scope: OwnerScope; id: string | null; online: boolean; language: Language; t: Translate; onBack: () => void };

const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
const photoMessage = (error: unknown): MessageKey | null => {
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return error instanceof BodyPhotoError && error.code === 'small' ? 'tryon.photoSmall' : 'tryon.photoUnusable';
};

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
  else if (!store || status === null) body = <p role="status">{t('common.loading')}</p>;
  else if (!tryOnReady(status)) body = <p className="notice" role="status">{t(status.code === 'CONSENT_REQUIRED' ? 'tryon.failure.turnedOff' : 'tryon.failure.unavailable')}</p>;
  else body = <Setup {...props} store={store} components={view.data.components} record={record}
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

type SetupProps = Props & {
  store: TryOnStore; record: OutfitRecord; components: ReadonlyMap<string, OutfitComponent>;
  onStart: (steps: TryOnStep[], photo: BodyPhoto) => void;
};
function Setup({ record, components, online, t, onStart }: SetupProps) {
  const selection = useMemo(() => tryOnSelection(record, components), [record, components]);
  const input = useRef<HTMLInputElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const focusStart = useRef(false);
  const [source, setSource] = useState<BodySource | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [edit, setEdit] = useState<PhotoEdit | null>(null);
  const [editing, setEditing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photo, setPhoto] = useState<BodyPhoto | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  useEffect(() => () => preparation.current?.abort(), []);
  // The start button is enabled only once preparation has finished, so focus moves there after that render.
  useEffect(() => {
    if (preparing || !photo || !focusStart.current) return;
    focusStart.current = false;
    document.getElementById('tryon-start')?.focus();
  }, [preparing, photo]);
  const clear = useCallback(() => {
    preparation.current?.abort();
    setSource(null); setSourceUrl(null); setEdit(null); setEditing(false); setPreparing(false); setPhoto(null); setPhotoUrl(null);
  }, []);
  async function choose(file: File | undefined) {
    if (!file) return;
    clear(); setError(null);
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    try {
      const admitted = await admitBodySource(file, controller.signal);
      if (controller.signal.aborted) return;
      setSource(admitted);
      setSourceUrl(URL.createObjectURL(admitted.blob));
      setEdit({ turns: 0, crop: largestAspectCrop(admitted.width, admitted.height, 0, BODY_ASPECT) });
      setEditing(true);
    } catch (failure) {
      const message = photoMessage(failure);
      if (message && !controller.signal.aborted) { setError(message); focus('tryon-choose'); }
    } finally {
      if (preparation.current === controller) setPreparing(false);
    }
  }
  async function apply(next: PhotoEdit) {
    if (!source) return;
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true); setError(null);
    try {
      const prepared = await prepareBodyPhoto(source, next, controller.signal);
      if (controller.signal.aborted) return;
      setEdit(next); setPhoto(prepared); setEditing(false);
      setPhotoUrl(URL.createObjectURL(new Blob([prepared.bytes], { type: 'image/jpeg' })));
      focusStart.current = true;
    } catch (failure) {
      const message = photoMessage(failure);
      if (message && !controller.signal.aborted) setError(message);
    } finally {
      if (preparation.current === controller) setPreparing(false);
    }
  }
  function cancelEdit() {
    setEditing(false);
    if (!photo) clear();
    focus(photo ? 'tryon-edit' : 'tryon-choose');
  }
  const count = selection.steps.length;
  return <div className="stack">
    <ul className="tryon-garments" aria-label={t('tryon.steps')}>
      {selection.steps.map(step => <li key={step.itemId}>{t('tryon.slotLine', { slot: t(slotKey(step.slot)), name: itemName(components, step.itemId, t) })}</li>)}
    </ul>
    {selection.notIncluded.length > 0 && <p className="muted">{t('tryon.notIncluded', { names: selection.notIncluded.map(item => itemName(components, item, t)).join(', ') })}</p>}
    {!count ? <p className="notice" role="status">{t('tryon.noGarments')}</p> : <>
      <div className="photo-panel">
        {editing && source && sourceUrl && edit ? <CropEditor preview={sourceUrl} width={source.width} height={source.height} accepted={edit}
          preparing={preparing} t={t} aspect={BODY_ASPECT} applyUnchanged={!photo} onApply={(next) => { void apply(next); }} onCancel={cancelEdit} />
          : <div className={`capture-photo tryon-photo ${photoUrl ? 'has-photo' : ''}`} aria-busy={preparing}>
            {photoUrl ? <img src={photoUrl} alt={t('tryon.photoReady')} width={1024} height={1280} />
              : preparing ? <p role="status">{t('tryon.preparing')}</p>
              : <p className="muted" id="tryon-photo-tip">{t('tryon.photoTip')}</p>}
          </div>}
        <input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label={t('tryon.choosePhoto')}
          onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
        {!editing && <div className="photo-actions">
          <button id="tryon-choose" type="button" className="button button-secondary" disabled={preparing} aria-describedby={photoUrl ? undefined : 'tryon-photo-tip'}
            onClick={() => input.current?.click()}>{t(photo ? 'tryon.changePhoto' : 'tryon.choosePhoto')}</button>
          {photo && source && <button id="tryon-edit" type="button" className="button button-quiet" disabled={preparing} onClick={() => setEditing(true)}>{t('tryon.editCrop')}</button>}
        </div>}
        {error && <p className="notice notice-error" role="alert">{t(error)}</p>}
      </div>
      {photo && !editing && <div className="stack">
        <p className="muted" id="tryon-limit">{t('tryon.limitLine')}</p>
        <button id="tryon-start" type="button" className="button button-primary" aria-describedby="tryon-limit" disabled={!online || preparing}
          onClick={() => { const bytes = photo; clear(); onStart(selection.steps, bytes); }}>
          {count === 1 ? t('tryon.startOne') : t('tryon.startMany', { count })}</button>
      </div>}
    </>}
  </div>;
}

const failureKey = (failure: FailureKind): MessageKey => `tryon.failure.${failure}` as MessageKey;

function RunView({ run, store, components, language, online, t, onRestart, onClose }: Props & {
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
