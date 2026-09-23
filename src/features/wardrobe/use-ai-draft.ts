import { useEffect, useRef, useState } from 'react';
import { AiError, type AiClient } from '../../data/ai';
import { AppError } from '../../data/errors';
import type { Language } from '../../i18n';
import type { PreparedPhoto } from '../../images/process-jpeg';
import {
  beginAiAnalysis, continueAiManually, createAiDraft, editAiDraftField, expireAiDraft, failAiAnalysis,
  prepareAiGeneration, presentAiDraft, receiveAiResult, refuseAiSave, aiSaveClaim,
  type AiContext, type AiDraftState, type AiTransition, type SavedAiBaseline,
} from '../../domain/ai-draft';
import { garmentFields, newGarmentDraft, sameValue, type GarmentDraft } from '../../domain/garment-fields';
import { canAnalyze, type AiAnalysisReply, type AiCode } from '../../domain/ai-controls';
import { defaultDescription } from '../../domain/item-details';

export type AiPhase = 'none' | 'off' | 'working' | 'stillWorking' | 'ready' | 'failed' | 'unclear' | 'limit' | 'needsCheck' | 'manual';
export const terminalReasons = ['DISCARDED', 'EXPIRED', 'FAILED', 'UNAVAILABLE', 'INVALID_FACTS'] as const;
export type TerminalReason = typeof terminalReasons[number];
export type AiPhaseInput = Readonly<{
  status: AiDraftState['status'] | null; code: AiCode | null; reason: TerminalReason | null;
  working: boolean; polling: 'active' | 'exhausted' | null; manual: boolean; applied: boolean;
}>;
function unreachable(value: never): never { void value; throw new AppError('aiC.unavailable'); }
export function phaseForCode(code: AiCode): 'failed' | 'off' | 'limit' {
  switch (code) {
    case 'CONSENT_REQUIRED': case 'UNCONFIGURED': case 'INACTIVE': case 'CONFIG_CHANGED': return 'off';
    case 'ALLOWANCE': return 'limit';
    // A rate limit is short-lived: it uses the neutral failure line, never the monthly-limit line.
    case 'RATE_LIMIT':
    case 'OK': case 'UNAVAILABLE': case 'UNAUTHENTICATED': case 'INVALID_INPUT': case 'CONFLICT': case 'ACTIVE_DRAFT':
    case 'TERMINAL': case 'TOO_LARGE': case 'UNSUPPORTED_MEDIA': case 'ANALYSIS_FAILED': case 'TIMEOUT': return 'failed';
    default: return unreachable(code);
  }
}
export function phaseForTerminal(reason: TerminalReason): 'failed' {
  switch (reason) {
    case 'DISCARDED': case 'EXPIRED': case 'FAILED': case 'UNAVAILABLE': case 'INVALID_FACTS': return 'failed';
    default: return unreachable(reason);
  }
}
// Precedence: applied AI values need a checked save or "Keep these details"; a dispatched request keeps checking the
// same request; then the reply code (allowance before generic failures). An inactive status check never overrides these.
export function aiPhase(input: AiPhaseInput): AiPhase {
  const { status } = input;
  if (status === null || status === 'invalidated') return 'none';
  if (input.manual) return 'manual';
  switch (status) {
    case 'ready': return 'ready';
    case 'expired': case 'cancelled': case 'failed': case 'unclear':
      if (input.applied) return 'needsCheck';
      if (status === 'unclear') return 'unclear';
      break;
    case 'pending':
      if (input.applied) return 'needsCheck';
      if (input.working || input.polling === 'active') return 'working';
      if (input.polling === 'exhausted') return 'stillWorking';
      break;
    case 'idle':
      if (input.working) return 'working';
      break;
    default: return unreachable(status);
  }
  if (input.reason) return phaseForTerminal(input.reason);
  if (input.code) return phaseForCode(input.code);
  return status === 'pending' ? 'stillWorking' : status === 'idle' ? 'none' : 'failed';
}
export const statusPollDelaysMs = [2000, 4000, 8000, 8000, 7000] as const;
export const statusPollDeadlineMs = 30000;
// Same-request status checks only: single-flight, at most five, all within a hard deadline that aborts any call still open.
export function pollStatus(check: (signal: AbortSignal) => Promise<'continue' | 'done'>, onExhausted: () => void): () => void {
  let stopped = false, calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let open: AbortController | null = null;
  const stop = () => {
    stopped = true;
    clearTimeout(timer); clearTimeout(deadline);
    open?.abort(); open = null;
  };
  const deadline = setTimeout(() => { if (!stopped) { stop(); onExhausted(); } }, statusPollDeadlineMs);
  const schedule = () => {
    if (stopped) return;
    const delay = statusPollDelaysMs[calls];
    if (delay === undefined) { stop(); onExhausted(); return; }
    timer = setTimeout(() => { void run(); }, delay);
  };
  const run = async () => {
    if (stopped) return;
    calls += 1;
    const controller = new AbortController();
    open = controller;
    let step: 'continue' | 'done';
    try { step = await check(controller.signal); } catch { step = 'continue'; }
    if (stopped || open !== controller) return;
    open = null;
    if (step === 'done') stop(); else schedule();
  };
  schedule();
  return stop;
}
type View = {
  state: AiDraftState | null; draft: GarmentDraft; description: string; descriptionEdited: boolean;
  manual: boolean; working: boolean; checking: boolean; applied: boolean;
  code: AiCode | null; reason: TerminalReason | null; polling: 'active' | 'exhausted' | null;
};
function mutable(state: AiDraftState): GarmentDraft {
  if (!state.draft) throw new AppError('aiC.unavailable');
  return { raw: { ...state.draft.raw, colours: [...state.draft.raw.colours], seasons: [...state.draft.raw.seasons],
    style_tags: [...state.draft.raw.style_tags], tags: [...state.draft.raw.tags] },
    intent: { ...state.draft.intent }, priceLanguage: state.draft.priceLanguage };
}
const reasonOf = (value: string | undefined): TerminalReason | null => terminalReasons.find((reason) => reason === value) ?? null;
export const ambiguousCodes: readonly AiCode[] = ['TIMEOUT', 'UNAVAILABLE'];
const implicitPhases: readonly AiPhase[] = ['off', 'stillWorking', 'failed', 'unclear', 'limit'];
export function useAiDraft(ai: AiClient, currency: string, language: Language, baseline?: SavedAiBaseline) {
  const [view, setView] = useState<View>(() => ({ state: null, draft: newGarmentDraft(currency, language, baseline?.values),
    description: baseline ? defaultDescription(baseline.values.title, baseline.values.colours, language) : '',
    descriptionEdited: false, manual: false, working: false, checking: false, applied: false,
    code: null, reason: null, polling: null }));
  const current = useRef(view);
  const work = useRef<AbortController | null>(null);
  const checkWork = useRef<AbortController | null>(null);
  const poll = useRef({ stop: () => {}, token: 0 });
  const currentLanguage = useRef(language);
  useEffect(() => { currentLanguage.current = language; }, [language]);
  const put = (next: View) => { current.current = next; setView(next); };
  // A linked description follows the name and colours; any edit to it, including clearing it, unlinks it for this draft.
  const follow = (previous: GarmentDraft, next: View): View => next.descriptionEdited
    || sameValue(previous.raw.title, next.draft.raw.title) && sameValue(previous.raw.colours, next.draft.raw.colours) ? next
    : { ...next, description: defaultDescription(next.draft.raw.title, next.draft.raw.colours, currentLanguage.current) };
  const apply = (transition: AiTransition) => {
    if (transition.status === 'invalid') throw new AppError('aiC.unavailable');
    if (transition.status === 'updated') {
      const previous = current.current.draft;
      put(follow(previous, { ...current.current, state: transition.state, draft: mutable(transition.state) }));
    }
  };
  function stopPolling() {
    poll.current.stop();
    checkWork.current?.abort();
    poll.current = { stop: () => {}, token: poll.current.token + 1 };
  }
  useEffect(() => {
    const clear = () => { work.current?.abort(); stopPolling(); };
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
      if (expired.status === 'updated') put({ ...current.current, state: expired.state });
    }, Math.max(0, state.result.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [view.state, ai]);
  // Only a still-pending request accepts a reply; anything later is ignored.
  function receive(reply: AiAnalysisReply) {
    const state = current.current.state;
    if (state?.status !== 'pending') return;
    if (reply.code !== 'OK') {
      apply(failAiAnalysis(state, state.context));
      put({ ...current.current, code: reply.code, reason: reply.code === 'TERMINAL' ? reasonOf(reply.reason) : null, polling: null });
      return;
    }
    if (reply.status === 'dispatched') return;
    const received = receiveAiResult(state, state.context, reply.result, Date.now());
    apply(received);
    if (received.status !== 'updated') {
      apply(failAiAnalysis(state, state.context));
      put({ ...current.current, code: 'TERMINAL', reason: 'EXPIRED', polling: null });
      return;
    }
    const ready = current.current.state;
    if (ready?.status === 'ready' && ready.result) {
      apply(presentAiDraft(ready, ready.context, currentLanguage.current));
      put({ ...current.current, applied: true, code: null, reason: null, polling: null });
    } else put({ ...current.current, polling: null });
  }
  function startPolling(context: AiContext) {
    stopPolling();
    const token = poll.current.token;
    const matches = () => poll.current.token === token && current.current.state?.context?.requestId === context.requestId;
    put({ ...current.current, polling: 'active' });
    const stop = pollStatus(async (signal) => {
      const reply = await ai.analysisStatus(context, AbortSignal.any([signal, ai.scope.signal]));
      if (signal.aborted || ai.scope.signal.aborted || !matches()) return 'done';
      receive(reply);
      return current.current.state?.status === 'pending' ? 'continue' : 'done';
    }, () => {
      if (!matches() || ai.scope.signal.aborted) return;
      poll.current = { stop: () => {}, token: token + 1 };
      put({ ...current.current, polling: 'exhausted' });
    });
    poll.current = { stop, token };
  }
  async function commitPhoto(photo: PreparedPhoto) {
    stopPolling();
    work.current?.abort();
    const controller = new AbortController();
    work.current = controller;
    const signal = AbortSignal.any([controller.signal, ai.scope.signal, AbortSignal.timeout(25000)]);
    const previous = current.current.state;
    const context = { ownerId: ai.scope.ownerId, epoch: ai.scope.epoch,
      draftId: previous?.context?.draftId ?? crypto.randomUUID(), requestId: crypto.randomUUID(),
      generation: (previous?.context?.generation ?? 0) + 1, imageSha256: photo.mainSha256 };
    put({ ...current.current, manual: false, working: true, checking: false, applied: false, code: null, reason: null, polling: null });
    if (previous?.context) apply(prepareAiGeneration(previous, previous.context, context));
    else {
      const created = createAiDraft(current.current.draft, context, baseline);
      if (!created.ok) { put({ ...current.current, working: false, code: 'UNAVAILABLE' }); return; }
      put({ ...current.current, state: created.state });
    }
    let began = false;
    try {
      if (previous?.context && previous.status !== 'idle' && previous.status !== 'cancelled') await ai.discard(previous.context, signal);
      const status = await ai.status(signal);
      if (signal.aborted) throw new AiError('TIMEOUT');
      if (!canAnalyze(status)) { put({ ...current.current, code: status.code === 'OK' ? 'INACTIVE' : status.code }); return; }
      const state = current.current.state;
      if (!state?.context) throw new AppError('aiC.unavailable');
      apply(beginAiAnalysis(state, context));
      began = true;
      const reply = await ai.analyze(context, photo, signal);
      if (!signal.aborted && current.current.state?.context?.requestId === context.requestId) {
        receive(reply);
        if (current.current.state?.status === 'pending') startPolling(context);
      }
    } catch (error) {
      if (!controller.signal.aborted && !ai.scope.signal.aborted && current.current.state?.context?.requestId === context.requestId) {
        const code: AiCode = error instanceof AiError ? error.code : 'UNAVAILABLE';
        const state = current.current.state;
        // A timeout, reset, truncated or malformed reply may follow an accepted POST: keep checking that same request
        // instead of offering a new analysis. Only definitive codes and terminal status replies end it.
        if (began && ambiguousCodes.includes(code) && state?.status === 'pending') startPolling(context);
        else {
          if (state?.status === 'pending') apply(failAiAnalysis(state, state.context));
          put({ ...current.current, code });
        }
      }
    } finally {
      if (!controller.signal.aborted && !ai.scope.signal.aborted) put({ ...current.current, working: false });
    }
  }
  // "Try again" while still working: one more status check for the same request, never a new analysis.
  async function checkStatus() {
    const state = current.current.state;
    const now = current.current;
    if (!state?.context || state.status !== 'pending' || now.working || now.checking || now.manual || now.polling === 'active') return;
    const context = state.context;
    const token = poll.current.token;
    const controller = new AbortController();
    checkWork.current = controller;
    put({ ...current.current, checking: true });
    try {
      const reply = await ai.analysisStatus(context, AbortSignal.any([controller.signal, ai.scope.signal]));
      if (!controller.signal.aborted && poll.current.token === token && current.current.state?.context?.requestId === context.requestId) receive(reply);
    } catch { /* stays "still working"; the user can check again */ }
    finally { if (!controller.signal.aborted && !ai.scope.signal.aborted) put({ ...current.current, checking: false }); }
  }
  // "Keep these details" and the implicit manual save: no analysis call; the request is discarded in the background.
  function manual() {
    stopPolling();
    work.current?.abort();
    const state = current.current.state;
    if (!state?.context) return;
    apply(continueAiManually(state, state.context));
    put({ ...current.current, manual: true, working: false, checking: false, polling: null });
    if (state.status !== 'idle' && state.status !== 'cancelled') void ai.discard(state.context).catch(() => undefined);
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
    put(follow(current.current.draft, { ...current.current, state, draft: next }));
  }
  const state = view.state;
  const phase = aiPhase({ status: state?.status ?? null, code: view.code, reason: view.reason, working: view.working,
    polling: view.polling, manual: view.manual, applied: view.applied });
  const noAi = !!state?.context && !view.applied && !state.presentation && Object.keys(state.derivation).length === 0;
  const implicitManual = implicitPhases.includes(phase) && noAi;
  return { ...view, phase, implicitManual, commitPhoto, checkStatus, continueManual: manual, edit,
    refuseSave: () => {
      stopPolling();
      work.current?.abort();
      const latest = current.current.state;
      if (latest?.context) apply(refuseAiSave(latest, latest.context));
      put({ ...current.current, manual: false, working: false, checking: false, polling: null });
    },
    editDescription: (description: string) => put({ ...current.current, description, descriptionEdited: true }),
    snapshot: () => current.current,
    stop: () => {
      stopPolling();
      work.current?.abort();
      put({ ...current.current, working: false, checking: false, polling: null });
    },
    canSave: phase === 'manual' || implicitManual
      || phase === 'ready' && !!state?.context && aiSaveClaim(state, state.context, Date.now()).status === 'ready',
  };
}
