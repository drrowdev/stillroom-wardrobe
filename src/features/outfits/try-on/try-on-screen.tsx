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
import { loadPersonPhoto, readPersonPhoto, saveConfirmed, startPersonPhotoSave } from '../../settings/tryon-photo';
import { SavedPhotoCard } from '../../settings/saved-photo-card';
import { useOutfit } from '../use-outfits';
import { browserEnvironment, failureAction, ideaSelection, itemName, slotKey, TryOnRun, tryOnSelection, useTryOnStatus, type FailureKind, type RunPhase } from '../use-try-on';
import { ConfirmDialog, TryOnPicture } from './try-on-parts';
import { useBodyPhotoPicker } from './use-body-photo';

type Common = { client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate; onBack: () => void };
type Props = Common & { id: string | null; armed: boolean; onArmUsed: () => void };

const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/**
 * Route `#/outfits/<id>/try-on`: opened by the Try on button, it starts one try-on chain at once from the saved photo (or asks for a
 * photo first). Opened any other way (reload, pasted link, history) it waits for the owner to press Try on, so nothing is spent unasked.
 */
export function TryOnScreen(props: Props) {
  const { client, scope, id, online, t } = props;
  const store = tryOnStoreFor(client, scope);
  const status = useTryOnStatus(store);
  const view = useOutfit(client, scope, id, online, 0);
  const [run, setRun] = useState<TryOnRun | null>(null);
  // The button press that opened this screen is used up here, once: this screen and no later one starts a chain by itself.
  const [armed, setArmed] = useState(props.armed);
  const { onArmUsed } = props;
  useEffect(() => { onArmUsed(); }, [onArmUsed]);
  // After Start again the garments are read once more; the old selection (which may be what the server refused) is never reused.
  const [freshAfter, setFreshAfter] = useState<number | null>(null);
  const waitingFresh = freshAfter !== null && view.seq < freshAfter;
  const [refocus, setRefocus] = useState(false);
  const refresh = () => { setArmed(true); setRefocus(true); setFreshAfter(view.reload()); };
  // Owned here rather than by the flow, so a remount of that view never ends a running chain.
  useEffect(() => () => run?.abandon(), [run]);
  const record = view.data?.record ?? null;
  const title = record ? t('tryon.title', { name: record.title }) : t('tryon.open');
  const flow = (selection: TryOnSelection | null) => store && <TryOnFlow {...props} armed={armed} refocus={refocus} store={store} components={view.data?.components ?? new Map()}
    selection={selection} run={run} onRun={setRun} onRefresh={refresh}
    create={record ? (steps, photo) => new TryOnRun(store.api, store, browserEnvironment(), record.id, steps, photo) : null} />;
  let body;
  if (run && store) body = flow(null);
  else if (waitingFresh) body = view.error && !view.loading
    ? <div className="notice notice-error" role="alert"><span>{t(view.error)}</span><button type="button" className="text-button" disabled={!online} onClick={() => setFreshAfter(view.reload())}>{t('common.retry')}</button></div>
    : <p role="status">{t('common.loading')}</p>;
  else if (id === null || view.data !== null && record === null) body = <p className="notice notice-error" role="alert">{t('outfits.unavailable')}</p>;
  else if (!view.data || !record) body = view.error
    ? <div className="notice notice-error" role="alert"><span>{t(view.error)}</span><button type="button" className="text-button" disabled={!online} onClick={view.reload}>{t('common.retry')}</button></div>
    : <p role="status">{t('common.loading')}</p>;
  else if (!store || status === null) body = <><p role="status">{t('common.loading')}</p>{store && <SavedPhotoCard store={store} online={online} language={props.language} t={t} />}</>;
  else if (!tryOnReady(status)) body = <>
    <p className="notice" role="status">{t(status.code === 'CONSENT_REQUIRED' ? 'tryon.failure.turnedOff' : 'tryon.failure.unavailable')}</p>
    <SavedPhotoCard store={store} online={online} language={props.language} t={t} />
  </>;
  else body = flow(tryOnSelection(record, view.data.components));
  return <section className="detail-page tryon-page" aria-labelledby="tryon-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); run?.abandon(); props.onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="tryon-title" tabIndex={-1}>{title}</h1></header>
    {body}
  </section>;
}

/** An unsaved Today or Stylist idea: its garments are kept in memory by the app for this route only and nothing is saved. */
export type TryOnIdeaSeed = { itemIds: readonly string[]; components: ReadonlyMap<string, OutfitComponent> };

/** Routes `#/today/try-on` and `#/stylist/try-on`: Show on me starts one try-on chain at once; it names the garments, not an outfit. */
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
  // The idea held in memory is itself the owner's request for this try-on.
  const flow = (picked: TryOnSelection | null) => store && idea && <TryOnFlow {...props} store={store} components={idea.components} armed
    selection={picked} run={run} onRun={setRun}
    create={(steps, photo) => new TryOnRun(store.api, store, browserEnvironment(), { itemIds: steps.map(step => step.itemId) }, steps, photo)} />;
  let body;
  if (run && store && idea) body = flow(null);
  else if (!idea || !selection || !store || status === null) body = <><p role="status">{t('common.loading')}</p>{store && <SavedPhotoCard store={store} online={props.online} language={props.language} t={t} />}</>;
  else if (!tryOnReady(status)) body = <>
    <p className="notice" role="status">{t(status.code === 'CONSENT_REQUIRED' ? 'tryon.failure.turnedOff' : 'tryon.failure.unavailable')}</p>
    <SavedPhotoCard store={store} online={props.online} language={props.language} t={t} />
  </>;
  else body = flow(selection);
  return <section className="detail-page tryon-page" aria-labelledby="tryon-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); run?.abandon(); onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="tryon-title" tabIndex={-1}>{t('tryon.open')}</h1></header>
    {body}
  </section>;
}

type FlowProps = Common & {
  store: TryOnStore; components: ReadonlyMap<string, OutfitComponent>;
  /** `null` while a run exists: the planned steps then come from the run itself. */
  selection: TryOnSelection | null; run: TryOnRun | null; onRun: (run: TryOnRun | null) => void;
  create: ((steps: TryOnStep[], photo: Uint8Array<ArrayBuffer>) => TryOnRun) | null;
  armed: boolean; refocus?: boolean; onRefresh?: () => void;
};
/** The photo offered for saving while a run is going: held only until it is saved, or the run ends. */
type Offer = { photo: BodyPhoto | null; done: boolean };
type Again = 'same' | 'photo' | 'restart';

function TryOnFlow(props: FlowProps) {
  const { run, onRun } = props;
  const [go, setGo] = useState(props.armed);
  const [forcePicker, setForcePicker] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  // Set once the owner has pressed Try again, Start again or Choose another photo: the pressed button is gone, so focus is placed.
  const [refocus, setRefocus] = useState(props.refocus ?? false);
  function again(mode: Again) {
    run?.abandon();
    onRun(null);
    setOffer(null); setForcePicker(mode === 'photo'); setGo(true); setRefocus(true);
    if (mode === 'restart') props.onRefresh?.();
  }
  if (run) return <RunView key={run.id} {...props} run={run} offer={offer} onOffer={setOffer} onAgain={again} />;
  if (!props.selection || !props.create) return null;
  return <Prepare {...props} selection={props.selection} create={props.create} go={go} forcePicker={forcePicker} refocus={refocus} onGo={() => setGo(true)} onOffer={setOffer} />;
}

type Stored = { kind: 'idle' | 'loading' | 'none' | 'unknown' | 'unusable' | 'failed' } | { kind: 'ready'; bytes: Uint8Array<ArrayBuffer> };

/** The saved reference photo's bytes for one try-on, fetched only while `enabled` and dropped as soon as it is not. */
function useSavedPhoto(store: TryOnStore, enabled: boolean) {
  const saved = useSyncExternalStore(store.subscribePhoto, store.getPhoto);
  const savedAt = saved.saved?.savedAtMs ?? null;
  const readKnown = saved.read !== 'unknown';
  // A failed status read with nothing confirmed: a photo may or may not exist, so it is never treated as "none".
  const statusUnknown = saved.read === 'failed' && saved.saved === null;
  const [stored, setStored] = useState<Stored>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (enabled) void readPersonPhoto(store); }, [store, enabled]);
  useEffect(() => {
    if (!enabled || !readKnown) { setStored({ kind: 'idle' }); return; }
    if (statusUnknown) { setStored({ kind: 'unknown' }); return; }
    if (savedAt === null) { setStored({ kind: 'none' }); return; }
    const controller = new AbortController();
    setStored({ kind: 'loading' });
    void loadPersonPhoto(store, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ready') setStored({ kind: 'ready', bytes: result.bytes });
      // A save, removal or consent change moved the state while this was in flight: read it again instead of using the bytes.
      else if (result.kind === 'stale') { if (!store.disposed) { void readPersonPhoto(store); setAttempt((value) => value + 1); } }
      else { setStored({ kind: result.kind }); if (result.kind === 'none') void readPersonPhoto(store); }
    });
    return () => controller.abort();
  }, [store, enabled, savedAt, readKnown, statusUnknown, attempt]);
  const retry = () => { if (statusUnknown) void readPersonPhoto(store); else setAttempt((value) => value + 1); };
  return { saved, stored, statusUnknown, retry };
}

function Prepare({ store, selection, components, online, t, create, go, forcePicker, refocus, onGo, onOffer, onRun }: FlowProps & {
  selection: TryOnSelection; create: NonNullable<FlowProps['create']>; go: boolean; forcePicker: boolean; refocus: boolean; onGo: () => void;
  onOffer: (offer: Offer | null) => void;
}) {
  const count = selection.steps.length;
  const started = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { saved, stored, statusUnknown, retry } = useSavedPhoto(store, go && !forcePicker && count > 0);
  const picker = useBodyPhotoPicker({ onFocus: (target) => focus(target === 'edit' ? 'tryon-edit' : 'tryon-choose') });
  const { source, sourceUrl, edit, editing, preparing, photo, error, clear } = picker;
  function begin(bytes: Uint8Array<ArrayBuffer>, offer: BodyPhoto | null, moveFocus: boolean) {
    started.current = true;
    const next = create(selection.steps, bytes);
    onRun(next);
    onOffer(offer ? { photo: offer, done: false } : null);
    next.start();
    if (moveFocus || refocus || document.activeElement === document.body) focus('tryon-progress');
  }
  // A saved photo starts the run by itself, once; offline it only waits for the owner's next press.
  useEffect(() => {
    if (!go || forcePicker || count === 0 || stored.kind !== 'ready' || started.current) return;
    if (!online) return;
    begin(stored.bytes, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- begin only reads this render's props
  }, [go, forcePicker, count, stored, online]);
  // A photo chosen here starts the run as soon as it is cropped; the owner may then keep it for next time.
  const offerable = saved.read !== 'unknown' && !statusUnknown && saved.saved === null;
  useEffect(() => {
    if (!photo || preparing || editing || started.current || !online) return;
    const chosen = photo;
    clear();
    begin(chosen.bytes, offerable ? chosen : null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- begin only reads this render's props
  }, [photo, preparing, editing, online]);
  const waiting = !forcePicker && !photo && (stored.kind === 'idle' || stored.kind === 'loading' || stored.kind === 'ready');
  const showPicker = go && count > 0 && !waiting;
  // After Try again or Choose another photo the pressed button is gone: focus goes to the photo choice.
  useEffect(() => { if (showPicker && (refocus || document.activeElement === document.body)) focus('tryon-choose'); }, [showPicker, refocus]);
  const list = <>
    <ul className="tryon-garments">
      {selection.steps.map(step => <li key={step.itemId}>{t('tryon.slotLine', { slot: t(slotKey(step.slot)), name: itemName(components, step.itemId, t) })}</li>)}
    </ul>
    {selection.notIncluded.length > 0 && <p className="muted">{t('tryon.notIncluded', { names: selection.notIncluded.map(item => itemName(components, item, t)).join(', ') })}</p>}
    {selection.optional.length > 0 && <p className="muted">{t('tryon.optionalLine', { names: selection.optional.map(item => itemName(components, item, t)).join(', ') })}</p>}
  </>;
  if (count === 0) return <p className="notice" role="status">{t('tryon.noGarments')}</p>;
  if (!go) return <div className="stack">
    {list}
    {!online && <p className="notice" role="status">{t('tryon.offlineStart')}</p>}
    <div className="outfit-actions">
      <button id="tryon-start" type="button" className="button button-primary" disabled={!online} onClick={onGo}>{t('tryon.open')}</button>
    </div>
  </div>;
  if (waiting) return <div className="stack">{list}<p role="status" aria-busy="true">{t(online ? 'common.loading' : 'tryon.offlineStart')}</p></div>;
  const problem: MessageKey | null = forcePicker || photo ? null : stored.kind === 'unknown' ? 'tryon.photoStatusFailed'
    : stored.kind === 'unusable' ? 'tryon.photoUnusableSaved' : stored.kind === 'failed' ? 'tryon.photoLoadFailed' : null;
  return <div className="stack">
    {list}
    <div className="photo-panel">
      {editing && source && sourceUrl && edit ? <CropEditor preview={sourceUrl} width={source.width} height={source.height} accepted={edit}
        preparing={preparing} t={t} aspect={BODY_ASPECT} applyUnchanged={!photo} onApply={(next) => { void picker.apply(next); }} onCancel={picker.cancelEdit} />
        : <div className="capture-photo tryon-photo" aria-busy={preparing}>
          {preparing || photo ? <p role="status">{t(preparing ? 'tryon.preparing' : 'tryon.offlineStart')}</p> : <p className="muted" id="tryon-photo-tip">{t('tryon.photoTip')}</p>}
        </div>}
      <input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label={t('tryon.choosePhoto')}
        onChange={(event) => { void picker.choose(event.target.files?.[0]); event.target.value = ''; }} />
      {!editing && <div className="photo-actions">
        <button id="tryon-choose" type="button" className="button button-primary" disabled={preparing} aria-describedby={photo ? undefined : 'tryon-photo-tip'}
          onClick={() => input.current?.click()}>{t(photo || forcePicker ? 'tryon.changePhoto' : 'tryon.choosePhoto')}</button>
        {(stored.kind === 'failed' || stored.kind === 'unknown') && !forcePicker && !photo && <button id="tryon-photo-retry" type="button" className="button button-quiet" disabled={!online}
          onClick={retry}>{t('common.retry')}</button>}
      </div>}
      {problem && <p className="notice notice-error" role="alert">{t(problem)}</p>}
      {error && <p className="notice notice-error" role="alert">{t(error)}</p>}
    </div>
  </div>;
}

const failureKey = (failure: FailureKind): MessageKey => `tryon.failure.${failure}` as MessageKey;

function RunView({ run, store, components, online, t, offer, onOffer, onAgain, onBack }: FlowProps & {
  run: TryOnRun; offer: Offer | null; onOffer: (offer: Offer | null) => void; onAgain: (mode: Again) => void;
}) {
  const phase: RunPhase = useSyncExternalStore(run.subscribe, run.get);
  const [confirming, setConfirming] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase.kind === 'failed') focus('tryon-failure-title');
    else if (phase.kind === 'result' || phase.kind === 'stopped') focus('tryon-title');
  }, [phase.kind]);
  // The photo offered for saving is dropped as soon as the run is over.
  useEffect(() => { if (offer?.photo && phase.kind !== 'running' && phase.kind !== 'checking' && phase.kind !== 'stopping') onOffer(null); }, [phase.kind, offer, onOffer]);
  const steps = run.steps, total = steps.length;
  // The finished picture is already kept under Try-ons until the owner deletes it.
  if (phase.kind === 'result') return <div className="stack">
    {phase.alreadyFinished && <p role="status">{t('tryon.alreadyFinished')}</p>}
    <TryOnPicture api={store.api} result={{ id: phase.resultId }} t={t} online={online} idPrefix="tryon-result">
      <button id="tryon-again" type="button" className="button button-secondary" onClick={() => onAgain('same')}>{t('tryon.tryAgain')}</button>
      <button id="tryon-done" type="button" className="button button-primary" onClick={onBack}>{t('tryon.done')}</button>
    </TryOnPicture>
  </div>;
  if (phase.kind === 'stopped') return <div className="stack">
    <p role="status">{t('tryon.stopped')}</p>
    <div className="outfit-actions">
      <button type="button" className="button button-primary" onClick={() => onAgain('same')}>{t('tryon.tryAgain')}</button>
      <button type="button" className="button button-secondary" onClick={onBack}>{t('common.close')}</button>
    </div>
  </div>;
  if (phase.kind === 'failed') {
    const action = failureAction[phase.failure];
    return <div className="notice notice-error stack">
      <h2 id="tryon-failure-title" tabIndex={-1}>{t(failureKey(phase.failure))}</h2>
      <div className="outfit-actions">
        {action === 'retry' && <button type="button" className="button button-primary" disabled={!online} onClick={() => run.start()}>{t('common.retry')}</button>}
        {action === 'photo' && <button type="button" className="button button-primary" onClick={() => onAgain('photo')}>{t('tryon.changePhoto')}</button>}
        {action === 'restart' && <button type="button" className="button button-primary" onClick={() => onAgain('restart')}>{t('tryon.startAgain')}</button>}
        <button type="button" className="button button-secondary" onClick={onBack}>{t('common.close')}</button>
      </div>
    </div>;
  }
  const index = phase.kind === 'ready' ? 0 : phase.index;
  const name = itemName(components, steps[index]!.itemId, t);
  const line = phase.kind === 'stopping' ? t('tryon.stopping')
    : phase.kind === 'running' && phase.waiting ? t('tryon.waiting')
    : phase.kind === 'checking' ? t(phase.offline ? 'tryon.offline' : 'tryon.checking')
    : total === 1 ? t('tryon.addingOne', { name }) : t('tryon.adding', { name, step: index + 1, total });
  return <div className="stack">
    <div className="tryon-progress" aria-busy="true">
      <ProgressFrame run={run} />
      <div className="tryon-bar" aria-hidden="true">
        {steps.map((step, at) => <span key={step.itemId} data-state={at < index ? 'done' : at === index ? 'now' : 'waiting'} />)}
      </div>
    </div>
    <p id="tryon-progress" tabIndex={-1} aria-live="polite" role="status">{line}</p>
    {offer && <KeepPhoto store={store} offer={offer} online={online} t={t} onOffer={onOffer} />}
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

/** The frame shown while the picture is made: the owner's photo from memory, dimmed, or a plain tint when the run no longer holds it. */
function ProgressFrame({ run }: { run: TryOnRun }) {
  const [url, setUrl] = useState<string | null>(null);
  // Taken once when the frame appears: the run releases its copy as soon as it stops, the frame goes with it.
  useEffect(() => {
    const bytes = run.referencePhoto;
    if (!bytes) return;
    const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [run]);
  return <div className="tryon-frame" aria-hidden="true">{url && <img src={url} alt="" />}</div>;
}

/** One quiet offer, while the picture is being made, to keep the photo chosen just now as the saved reference photo. */
function KeepPhoto({ store, offer, online, t, onOffer }: { store: TryOnStore; offer: Offer; online: boolean; t: Translate; onOffer: (offer: Offer | null) => void }) {
  const state = useSyncExternalStore(store.subscribePhoto, store.getPhoto);
  if (offer.done) return state.error === null ? <p role="status">{t('tryon.photoSaved')}</p> : null;
  const photo = offer.photo;
  async function keep() {
    if (!photo) return;
    const attempt = startPersonPhotoSave(store, photo);
    if (saveConfirmed(store, attempt, await attempt.result)) onOffer({ photo: null, done: true });
  }
  return <>
    <div className="photo-actions">
      <button id="tryon-keep-photo" type="button" className="button button-quiet" disabled={!online || state.busy !== null} onClick={() => { void keep(); }}>
        {t(state.busy === 'save' ? 'common.saving' : 'tryon.keepPhoto')}</button>
    </div>
    {state.error === 'save' && <p className="notice notice-error" role="alert">{t('tryon.photoSaveFailed')}</p>}
  </>;
}
