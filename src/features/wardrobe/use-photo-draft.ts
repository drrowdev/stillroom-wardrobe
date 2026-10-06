import { useEffect, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import { garmentFields, validateGarmentDraft, type GarmentDraft } from '../../domain/garment-fields';
import { validDescription } from '../../domain/item-details';
import type { Language, MessageKey } from '../../i18n';
import type { CropSource, ImagePreparationError, PreparedPhoto } from '../../images/process-jpeg';
import { ORIGINAL_EDIT, type PhotoEdit } from '../../images/photo-edit';
import { preloadable } from '../../app/lazy-load';
import { newSaveAttempt, saveItem, saveAnalyzedItem, type SaveStage } from '../../images/upload';
import { AnalyzedSaveRefusedError, EnhancementExpiredError, errorKey, isAborted } from '../../data/errors';
import { newAnalyzedSaveAttempt, newUnverifiedSaveAttempt, type AnalyzedSaveAttempt } from '../../domain/analyzed-save';
import type { AiClient } from '../../data/ai';
import { useAiDraft } from './use-ai-draft';
import type { BeforeDiscard } from '../../app/dialog';
import { useBackground, type PreparedWithBackground } from './use-background';
import { useEnhancement } from './use-enhancement';
import type { StageResult } from './enhancement-stage';
import { photoMenuId } from './photo-actions';

export const loadImaging = preloadable(() => import('../../images/imaging'));
export const preparationErrors: Record<ImagePreparationError['code'], MessageKey> = {
  unsupported: 'photo.prepareUnsupported',
  tooLarge: 'photo.prepareTooLarge',
  invalid: 'photo.invalid',
  unavailable: 'photo.prepareUnavailable',
};
/**
 * BG2c pre-upload review (plan rev4 §3.1): a new photo whose clean-up would be sent, held in memory with its first-pass
 * H0 and R until the crop is accepted. Nothing is committed, analysed or sent while it is open.
 */
type Review = { prepared: PreparedWithBackground; edit: PhotoEdit; controller: AbortController };
const notSent = { kind: 'skipped', line: 'none', requestId: null } as const;
export type PhotoDraftOptions = {
  client: AppClient; scope: OwnerScope; currency: string; online: boolean; language: Language; ai: AiClient;
  onSaved: () => void; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onBeforeDiscard: (handler: BeforeDiscard | null) => void;
  /** Moves focus for Save: `element` to a status or the crop editor, `field` to a garment field or the photo choice. */
  focus: (id: string, kind: 'element' | 'field') => void;
  /** Called when a prepared photo is committed to the draft. */
  onCommitted?: () => void;
};
/**
 * One photo draft from preparation to the checked save (BULK2a): preparation and background removal, the pre-upload
 * review, clean-up, one analysis of the committed photo and the save. Single Add renders it; the state is memory-only.
 */
export function usePhotoDraft({ client, scope, currency, online, language, ai, onSaved, onDirty, onBeforeDiscard, focus,
  onCommitted }: PhotoDraftOptions) {
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // A3: the settled H1 while it is being enhanced. Shown, but not committed: the committed photo, the accepted crop and
  // the settled background stay as they were until this preparation commits.
  const [provisional, setProvisional] = useState<{ photo: PreparedPhoto; crop: boolean } | null>(null);
  const [provisionalPreview, setProvisionalPreview] = useState<string | null>(null);
  const [fullPhoto, setFullPhoto] = useState<CropSource | null>(null);
  const [fullPreview, setFullPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [acceptedEdit, setAcceptedEdit] = useState<PhotoEdit>(ORIGINAL_EDIT);
  const [initialCurrency] = useState(currency);
  const analysis = useAiDraft(ai, currency, language);
  const background = useBackground(scope);
  const onlineNow = useRef(online);
  useEffect(() => { onlineNow.current = online; }, [online]);
  const expiring = useRef<() => void>(() => {});
  const enhancement = useEnhancement(client, scope, () => expiring.current());
  const { draft, description: altText } = analysis;
  const title = draft.raw.title;
  const [preparing, setPreparing] = useState(false);
  const [stage, setStage] = useState<SaveStage | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [attempt, setAttempt] = useState<AnalyzedSaveAttempt | null>(null);
  const receipt = useRef<{ attempt: AnalyzedSaveAttempt; fingerprint: string } | null>(null);
  const manualTransport = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  const mountedScope = useRef<OwnerScope | null>(null);
  const pendingCrop = useRef(false);
  const preparationWork = useRef<Promise<void>>(Promise.resolve());
  const original = useRef<Blob | null>(null);
  // Where focus goes once a committed photo or a closed crop editor is on screen: the details after the first photo,
  // then "Photo options".
  const focusTarget = useRef<'capture-basics' | typeof photoMenuId | null>(null);
  // The details appear once the first photo is ready and are never hidden again while the page is open.
  const [advanced, setAdvanced] = useState(false);
  const advancedNow = useRef(false);
  const submitLatch = useRef(false);
  const busy = stage !== null || cancelling;
  const frozen = attempt !== null;
  const dirty = preparing || review !== null || photo !== null || Object.keys(draft.intent).length > 0 || Boolean(altText);
  useEffect(() => { onDirty(dirty, frozen, busy); }, [dirty, frozen, busy, onDirty]);
  useEffect(() => {
    onBeforeDiscard(async () => {
      if (submitLatch.current || scope.signal.aborted) return 'unresolved';
      submitLatch.current = true;
      setCancelling(true);
      analysis.stop();
      try {
        if (attempt) {
          if (manualTransport.current || receipt.current?.attempt !== attempt) return 'unresolved';
          await ai.cancel(attempt, receipt.current.fingerprint);
        } else {
          const state = analysis.snapshot().state;
          if (state?.context && state.status !== 'idle' && state.status !== 'cancelled') await ai.discard(state.context);
        }
        return 'cancelled';
      } catch { return 'unresolved'; }
      finally { submitLatch.current = false; if (!scope.signal.aborted) setCancelling(false); }
    });
    return () => onBeforeDiscard(null);
  }, [analysis, ai, attempt, onBeforeDiscard, scope]);
  useEffect(() => {
    const clear = () => { preparation.current?.abort(); original.current = null; setReview(null); };
    scope.signal.addEventListener('abort', clear, { once: true });
    mountedScope.current = scope;
    return () => {
      scope.signal.removeEventListener('abort', clear);
      mountedScope.current = null;
      // A real unmount or scope change still clears; a dev StrictMode re-mount re-runs setup first and keeps live work.
      queueMicrotask(() => { if (mountedScope.current !== scope) clear(); });
    };
  }, [scope]);
  useEffect(() => {
    if (!photo) { setPreview(null); return; }
    const url = URL.createObjectURL(photo.main);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    if (!provisional) { setProvisionalPreview(null); return; }
    const url = URL.createObjectURL(provisional.photo.main);
    setProvisionalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [provisional]);
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
    if (!file || frozen || submitLatch.current || scope.signal.aborted) return;
    original.current = file;
    setEditing(false);
    setFullPhoto(null);
    setAcceptedEdit(ORIGINAL_EDIT);
    setPhoto(null);
    background.reset();
    enhancement.clear();
    await prepare(file, ORIGINAL_EDIT, true, { review: true });
  }
  /**
   * `review` opens the pre-upload review when clean-up would be sent (a newly chosen photo only). `fromReview` is the
   * review being accepted: its first pass keeps the crop editor's source (the whole oriented photo, whose coordinates
   * every edit uses), so no new crop source is made. `accepted` is that first pass, accepted with an unchanged crop:
   * it is sent as it is, without preparing again.
   */
  async function prepare(file: Blob, edit: PhotoEdit, replacing = false,
    how: { review?: boolean; fromReview?: Review; accepted?: PreparedWithBackground } = {}): Promise<void> {
    if (frozen || submitLatch.current || scope.signal.aborted) return;
    if (!how.fromReview) setReview(null);
    // Work that supersedes an unfinished new-photo preparation still owes that photo its crop preview.
    replacing ||= pendingCrop.current;
    pendingCrop.current = replacing;
    analysis.stop();
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setPreparing(true);
    setError(null);
    const previous = preparationWork.current;
    const work = (async () => {
      await previous;
      if (signal.aborted) return;
      let imaging: Awaited<ReturnType<typeof loadImaging>> | null = null;
      try {
        imaging = await loadImaging();
        // The first settled photo is analysed once: removal (or its fallback) finishes before commitPhoto.
        const prepared = how.accepted ?? await background.prepare(imaging, file, edit, signal, replacing && !how.fromReview,
          () => preparation.current === controller);
        if (signal.aborted) return;
        const cutOut = prepared.state === 'removed';
        const current = () => preparation.current === controller;
        if (how.review && cutOut) {
          const check = await enhancement.run(prepared.cleanup, { cutOut, online: onlineNow.current, signal, current, preflight: true });
          if (check.kind === 'aborted' || signal.aborted) return;
          if (check.kind === 'available') {
            setFullPhoto(prepared.crop);
            setAcceptedEdit(edit);
            setReview({ prepared, edit, controller });
            setEditing(true);
          } else commit(prepared, check, edit, replacing, null);
          return;
        }
        if (cutOut) setProvisional({ photo: prepared.photo, crop: !replacing });
        let stage;
        try {
          stage = await enhancement.run(prepared.cleanup, { cutOut, online: onlineNow.current, signal, current });
        } finally { if (cutOut) setProvisional(null); }
        // An aborted stage (crop cancel, discard, a newer photo, logout) commits nothing and starts no analysis.
        if (stage.kind !== 'aborted' && stage.kind !== 'available' && !signal.aborted) {
          commit(prepared, stage, edit, replacing, how.fromReview?.prepared.crop ?? null);
        }
      } catch (problem) {
        if (!signal.aborted && !isAborted(problem) && how.fromReview) {
          // A failed accepted crop leaves the review open and retryable: the original file, the whole-photo source and
          // the first pass stay, and the review now belongs to this (current) preparation.
          pendingCrop.current = false;
          setReview({ ...how.fromReview, controller });
          setError(!imaging ? 'chunk.failed' : problem instanceof imaging.ImagePreparationError ? preparationErrors[problem.code] : 'photo.invalid');
        } else if (!signal.aborted && !isAborted(problem)) {
          background.settle('none');
          pendingCrop.current = false;
          if (replacing) original.current = null;
          setError(!imaging ? 'chunk.failed' : problem instanceof imaging.ImagePreparationError ? preparationErrors[problem.code] : 'photo.invalid');
        }
      } finally { if (!signal.aborted) setPreparing(false); }
    })();
    preparationWork.current = work;
    await work;
  }
  /** `source` keeps an existing crop-editor source; otherwise a new photo takes this preparation's whole-photo crop. */
  function commit(prepared: PreparedWithBackground, stage: Exclude<StageResult, { kind: 'aborted' | 'available' }>, edit: PhotoEdit,
    replacing: boolean, source: CropSource | null) {
    const settled = stage.kind === 'enhanced' ? stage.photo : prepared.photo;
    setReview(null);
    setPhoto(settled);
    background.settle(prepared.state);
    enhancement.commit(stage, prepared.photo);
    void analysis.commitPhoto(settled);
    if (replacing) setFullPhoto(source ?? prepared.crop);
    pendingCrop.current = false;
    setAcceptedEdit(edit);
    setEditing(false);
    focusTarget.current = advancedNow.current ? photoMenuId : 'capture-basics';
    advancedNow.current = true;
    setAdvanced(true);
    onCommitted?.();
  }
  /** Done in the review is the acceptance, also with an unchanged crop; a changed crop is prepared again and sent. */
  function acceptReview(edit: PhotoEdit, unchanged: boolean) {
    const current = review;
    if (!current || preparation.current !== current.controller || !original.current) return;
    focusTarget.current = photoMenuId;
    void prepare(original.current, edit, true, { fromReview: current, ...(unchanged ? { accepted: current.prepared } : {}) });
  }
  /**
   * Cancel editing in the review, also while an accepted changed crop is still being prepared, keeps the new photo's
   * first pass without clean-up: no line, one analysis, nothing sent.
   */
  function cancelReview() {
    const current = review;
    if (!current) return;
    if (preparation.current !== current.controller) { preparation.current?.abort(); setPreparing(false); }
    focusTarget.current = photoMenuId;
    commit(current.prepared, notSent, current.edit, true, null);
  }
  /** "Use original background" in the review: the original photo is prepared, with nothing sent. */
  function reviewOriginal() {
    const current = review;
    if (!current || preparation.current !== current.controller || !original.current) return;
    background.keep();
    focusTarget.current = photoMenuId;
    void prepare(original.current, current.edit, true);
  }
  async function submit(): Promise<void> {
    if (editing || preparing) {
      focus(editing ? 'crop-editor-title' : 'photo-pending', 'element');
      return;
    }
    if (submitLatch.current || busy || !online || scope.signal.aborted || !attempt && !analysis.canSave) return;
    const validated = validateGarmentDraft(draft);
    if (!photo || !validated.values || validDescription(altText) === null) {
      setInvalid(true);
      const first = garmentFields.find((field) => validated.errors[field]);
      focus(!photo ? 'choose-photo' : first ? `item-${first}` : 'item-alt', 'field');
      return;
    }
    // An unreserved enhanced draft whose evidence has lapsed goes back to H1 first; Save is pressed again.
    if (!attempt && enhancement.lapsed()) { expiring.current(); return; }
    submitLatch.current = true;
    setInvalid(false);
    setError(null);
    let saving: AnalyzedSaveAttempt | null = null;
    try {
      // With no AI values in the form, Save becomes a plain manual save: checking stops before anything is awaited.
      if (!attempt && analysis.implicitManual) analysis.continueManual();
      const state = analysis.snapshot();
      if (!attempt) manualTransport.current = state.manual && !state.applied && state.state?.status !== 'invalidated'
        && !state.state?.presentation && Object.keys(state.state?.derivation ?? {}).length === 0;
      const current = attempt ?? (state.manual
        ? manualTransport.current ? Object.freeze({ ...newSaveAttempt(state.draft, state.description, photo, scope), claim: null })
          : newUnverifiedSaveAttempt(state.draft, state.description, photo, scope)
        : state.state?.context ? newAnalyzedSaveAttempt(state.state, state.state.context, state.description, photo, scope, Date.now())
          : null);
      if (!current) return;
      saving = current;
      setAttempt(current);
      enhancement.freeze();
      if (manualTransport.current) await saveItem(client, scope, current, setStage);
      else await saveAnalyzedItem(client, scope, current, setStage, (reserved, fingerprint) => {
        if (reserved === current && !scope.signal.aborted) receipt.current = { attempt: reserved, fingerprint };
      });
      if (!scope.signal.aborted) {
        original.current = null;
        setPhoto(null);
        setFullPhoto(null);
        enhancement.clear();
        onSaved();
      }
    } catch (problem) {
      if (!scope.signal.aborted && !isAborted(problem)) {
        if (problem instanceof AnalyzedSaveRefusedError && saving?.claim
          && problem.itemId === saving.itemId && problem.imageId === saving.imageId && receipt.current === null) {
          setAttempt(null);
          analysis.refuseSave();
          enhancement.thaw();
        } else if (problem instanceof EnhancementExpiredError && saving && receipt.current?.attempt !== saving) {
          // The admission refuses only a new reservation, so this attempt has none, also on a retry after a lost reply:
          // it is cleared, the draft is unreserved again and goes back to H1 once, with one new analysis.
          setAttempt(null);
          enhancement.thaw();
          revertEnhancement('generic', true);
        } else setError(errorKey(problem));
      }
    } finally { if (!scope.signal.aborted) { submitLatch.current = false; setStage(null); } }
  }
  function revertEnhancement(line: 'none' | 'generic' = 'none', afterRefusal = false) {
    if ((!afterRefusal && (frozen || submitLatch.current)) || preparing || scope.signal.aborted) return;
    const h1 = enhancement.revert(line);
    if (!h1) return;
    setPhoto(h1);
    void analysis.commitPhoto(h1);
  }
  expiring.current = () => revertEnhancement('generic');
  function useOriginalBackground() {
    if (frozen || submitLatch.current || scope.signal.aborted) return;
    // After a finished removal this is a new photo generation, analysed again.
    if (background.useOriginal() === 'again' && original.current) void prepare(original.current, acceptedEdit);
  }
  function cancelEdit() {
    preparation.current?.abort();
    setPreparing(false);
    setEditing(false);
    setError(null);
    focusTarget.current = photoMenuId;
  }
  return {
    photo, preview, provisional, provisionalPreview, fullPhoto, fullPreview, editing, review, acceptedEdit, initialCurrency,
    analysis, background, enhancement, draft, altText, title, preparing, stage, error, invalid, attempt, busy, frozen,
    advanced, focusTarget,
    choose, submit, acceptReview, cancelReview, reviewOriginal, useOriginalBackground, cancelEdit,
    startEditing: () => setEditing(true),
    revert: () => revertEnhancement(),
    applyCrop: (edit: PhotoEdit) => { if (original.current) void prepare(original.current, edit); },
    retryAnalysis: () => { if (!submitLatch.current && photo) void analysis.commitPhoto(photo); },
    keepDetails: () => { if (!submitLatch.current) analysis.continueManual(); },
    editDraft: (next: GarmentDraft) => { if (!submitLatch.current && !frozen) analysis.edit(next); },
    editDescription: (value: string) => { if (!submitLatch.current && !frozen) analysis.editDescription(value); },
  };
}
