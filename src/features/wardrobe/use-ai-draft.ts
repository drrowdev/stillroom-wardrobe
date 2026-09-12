import { useEffect, useRef, useState } from 'react';
import type { AiClient } from '../../data/ai';
import { errorKey, AppError } from '../../data/errors';
import type { Language, MessageKey } from '../../i18n';
import type { PreparedPhoto } from '../../images/process-jpeg';
import {
  beginAiAnalysis, continueAiManually, createAiDraft, editAiDraftField, expireAiDraft, failAiAnalysis,
  prepareAiGeneration, presentAiDraft, receiveAiResult, aiSaveClaim, type AiDraftState, type AiTransition,
} from '../../domain/ai-draft';
import { garmentFields, newGarmentDraft, sameValue, type GarmentDraft } from '../../domain/garment-fields';
import { canAnalyze, type AiAccounting, type AiAnalysisReply } from '../../domain/ai-controls';
import { presentAiFacts } from '../../domain/ai-presentation';

type View = {
  state: AiDraftState | null; draft: GarmentDraft; description: string; descriptionEdited: boolean;
  descriptionDerived: string | null; manual: boolean; working: boolean; notice: MessageKey | null;
  accounting: AiAccounting | null;
};
function mutable(state: AiDraftState): GarmentDraft {
  if (!state.draft) throw new AppError('aiC.unavailable');
  return { raw: { ...state.draft.raw, colours: [...state.draft.raw.colours], seasons: [...state.draft.raw.seasons],
    style_tags: [...state.draft.raw.style_tags], tags: [...state.draft.raw.tags] },
    intent: { ...state.draft.intent }, priceLanguage: state.draft.priceLanguage };
}
export function useAiDraft(ai: AiClient, currency: string, language: Language) {
  const [view, setView] = useState<View>(() => ({ state: null, draft: newGarmentDraft(currency, language),
    description: '', descriptionEdited: false, descriptionDerived: null, manual: false, working: false,
    notice: null, accounting: null }));
  const current = useRef(view);
  const work = useRef<AbortController | null>(null);
  const currentLanguage = useRef(language);
  useEffect(() => { currentLanguage.current = language; }, [language]);
  const put = (next: View) => { current.current = next; setView(next); };
  const apply = (transition: AiTransition) => {
    if (transition.status === 'invalid') throw new AppError('aiC.unavailable');
    if (transition.status === 'updated') put({ ...current.current, state: transition.state, draft: mutable(transition.state) });
  };
  useEffect(() => {
    const clear = () => { work.current?.abort(); };
    ai.scope.signal.addEventListener('abort', clear, { once: true });
    return () => { clear(); ai.scope.signal.removeEventListener('abort', clear); };
  }, [ai]);
  useEffect(() => {
    const state = view.state;
    if (state?.status !== 'ready' || !state.result) return;
    const timer = setTimeout(() => {
      const latest = current.current.state;
      if (latest?.status !== 'ready' || latest.context.requestId !== state.context.requestId || ai.scope.signal.aborted) return;
      const expired = expireAiDraft(latest, latest.context, Date.now());
      if (expired.status === 'updated') {
        const next = { ...current.current, state: expired.state, notice: 'aiC.expired' as const };
        current.current = next; setView(next);
      }
    }, Math.max(0, state.result.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [view.state, ai]);
  function receive(reply: AiAnalysisReply) {
    const state = current.current.state;
    if (!state || state.status === 'invalidated') return;
    if (reply.code !== 'OK') {
      apply(state.status === 'ready' ? continueAiManually(state, state.context) : failAiAnalysis(state, state.context));
      put({ ...current.current, notice: reply.code === 'TERMINAL' ? 'aiC.expired' : 'aiC.unavailable' });
      return;
    }
    put({ ...current.current, accounting: reply.accounting });
    if (state.status === 'ready') return;
    if (reply.status === 'dispatched') { put({ ...current.current, notice: 'aiC.pending' }); return; }
    const received = receiveAiResult(state, state.context, reply.result, Date.now());
    apply(received);
    if (received.status !== 'updated') { put({ ...current.current, notice: 'aiC.expired' }); return; }
    const ready = current.current.state;
    if (ready?.status === 'ready' && ready.result) {
      const presentation = presentAiFacts(ready.result.facts, currentLanguage.current);
      apply(presentAiDraft(ready, ready.context, currentLanguage.current));
      const next = current.current;
      put({ ...next, description: next.descriptionEdited ? next.description : presentation.description,
        descriptionDerived: presentation.description, notice: 'aiC.ready' });
    } else put({ ...current.current, notice: 'aiC.unclear' });
  }
  async function commitPhoto(photo: PreparedPhoto) {
    const manualFallback = current.current.manual;
    work.current?.abort();
    const controller = new AbortController();
    work.current = controller;
    const signal = AbortSignal.any([controller.signal, ai.scope.signal, AbortSignal.timeout(25000)]);
    const previous = current.current.state;
    const context = { ownerId: ai.scope.ownerId, epoch: ai.scope.epoch,
      draftId: previous?.context?.draftId ?? crypto.randomUUID(), requestId: crypto.randomUUID(),
      generation: (previous?.context?.generation ?? 0) + 1, imageSha256: photo.mainSha256 };
    if (previous?.context) apply(prepareAiGeneration(previous, previous.context, context));
    else {
      const created = createAiDraft(current.current.draft, context);
      if (!created.ok) { put({ ...current.current, notice: 'aiC.unavailable' }); return; }
      put({ ...current.current, state: created.state });
    }
    put({ ...current.current, manual: false, working: true, accounting: null, notice: 'aiC.checking',
      description: current.current.descriptionEdited ? current.current.description : '', descriptionDerived: null });
    let began = false;
    try {
      if (previous?.context && previous.status !== 'idle' && previous.status !== 'cancelled') await ai.discard(previous.context, signal);
      const status = await ai.status(signal);
      if (signal.aborted) throw new AppError('aiC.uncertain');
      if (!canAnalyze(status)) { put({ ...current.current, manual: manualFallback, notice: manualFallback ? 'aiC.manual' : 'aiC.manualRequired' }); return; }
      const state = current.current.state;
      if (!state?.context) throw new AppError('aiC.unavailable');
      apply(beginAiAnalysis(state, context));
      began = true;
      const reply = await ai.analyze(context, photo, signal);
      if (!signal.aborted && current.current.state?.context?.requestId === context.requestId) receive(reply);
    } catch (error) {
      if (!controller.signal.aborted && !ai.scope.signal.aborted) put({ ...current.current, manual: !began && manualFallback, notice: errorKey(error) });
    } finally {
      if (!controller.signal.aborted && !ai.scope.signal.aborted) put({ ...current.current, working: false });
    }
  }
  async function checkStatus() {
    const state = current.current.state;
    if (!state?.context || current.current.working || current.current.manual) return;
    const controller = new AbortController(); work.current = controller;
    const signal = AbortSignal.any([controller.signal, ai.scope.signal]);
    put({ ...current.current, working: true });
    try {
      const result = await ai.analysisStatus(state.context, signal);
      if (!signal.aborted && current.current.state?.context?.requestId === state.context.requestId) receive(result);
    } catch (error) { if (!signal.aborted) put({ ...current.current, notice: errorKey(error) }); }
    finally { if (!signal.aborted) put({ ...current.current, working: false }); }
  }
  async function manual() {
    work.current?.abort();
    const state = current.current.state;
    if (!state?.context) return;
    apply(continueAiManually(state, state.context));
    put({ ...current.current, manual: true, working: false, notice: 'aiC.manual' });
    try { if (state.status !== 'idle' && state.status !== 'cancelled') await ai.discard(state.context); }
    catch { if (!ai.scope.signal.aborted && current.current.state?.context?.requestId === state.context.requestId) put({ ...current.current, notice: 'aiC.discardUnconfirmed' }); }
  }
  function edit(next: GarmentDraft) {
    let state = current.current.state;
    if (state?.context) {
      for (const field of garmentFields) {
        if (sameValue(next.raw[field], current.current.draft.raw[field]) && next.intent[field] === current.current.draft.intent[field]) continue;
        const result: AiTransition = editAiDraftField(state, state.context, field, next.raw[field], next.priceLanguage);
        if (result.status !== 'updated') throw new AppError('aiC.unavailable');
        state = result.state;
        if (!state.context) throw new AppError('aiC.unavailable');
      }
    }
    put({ ...current.current, state, draft: next });
  }
  return { ...view, commitPhoto, checkStatus, continueManual: manual, edit,
    editDescription: (description: string) => put({ ...current.current, description, descriptionEdited: true }),
    snapshot: () => current.current,
    stop: () => {
      work.current?.abort();
      put({ ...current.current, working: false,
        notice: current.current.state?.status === 'pending' ? 'aiC.uncertain' : current.current.notice });
    },
    canSave: view.manual || !!view.state?.context && aiSaveClaim(view.state, view.state.context, Date.now()).status === 'ready',
  };
}
