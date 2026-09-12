import { isUuid } from './wardrobe';
import { presentAiFacts } from './ai-presentation';
import {
  editGarmentField, freezeValues, garmentFields, initialRawFields, sameValue, validateGarmentDraft,
  type GarmentDraft, type GarmentField, type GarmentValues, type RawFields,
} from './garment-fields';
import {
  aiFields, aiKind, hasOnlyDataKeys, isAiCounter, isAiTimestamp, isAssertedAiValue, isImageSha256, parseAiResult,
  type AiField, type AiKind, type AiResult, type DeepReadonly,
} from './ai-analysis';

export type AiContext = Readonly<{
  ownerId: string; epoch: number; draftId: string; generation: number; requestId: string; imageSha256: string;
}>;
export type AiDerivation = DeepReadonly<Partial<{
  [K in AiField]: { value: NonNullable<GarmentValues[K]>; kind: AiKind<K> };
}>>;
export type AiSaveClaim = DeepReadonly<{
  requestId: string; draftId: string; generation: number; imageSha256: string; fields: AiDerivation;
}>;
export type AiInvalidation = 'logout' | 'owner_changed' | 'discarded' | 'saved';
type ActiveDraft = DeepReadonly<{
  status: 'idle' | 'pending' | 'ready' | 'unclear' | 'failed' | 'cancelled' | 'expired';
  context: AiContext; draft: GarmentDraft; derivation: AiDerivation; result: AiResult | null;
  presentation?: { title: string; tags: string[] };
}>;
export type AiDraftState = ActiveDraft | Readonly<{
  status: 'invalidated'; reason: AiInvalidation; context: null; draft: null; derivation: null; result: null;
}>;
export type AiIgnoredReason = 'invalidated' | 'owner' | 'epoch' | 'draft' | 'generation' | 'request' | 'photo'
  | 'ineligible_state' | 'expired_result' | 'future_result' | 'not_expired';
export type AiDraftFailure = 'INVALID_CONTEXT' | 'INVALID_RESULT' | 'INVALID_DRAFT' | 'INVALID_TRANSITION' | 'CLAIM_CONFLICT';
export type AiTransition =
  | { status: 'updated'; state: AiDraftState }
  | { status: 'ignored'; state: AiDraftState; reason: AiIgnoredReason }
  | { status: 'invalid'; state: AiDraftState; code: AiDraftFailure };

const contextKeys = ['ownerId', 'epoch', 'draftId', 'generation', 'requestId', 'imageSha256'] as const;
function validContext(input: unknown): input is AiContext {
  return hasOnlyDataKeys(input, contextKeys) && isUuid(input.ownerId) && isAiTimestamp(input.epoch)
    && isUuid(input.draftId) && isAiCounter(input.generation) && isUuid(input.requestId) && isImageSha256(input.imageSha256);
}
function mismatch(left: AiContext, right: AiContext): AiIgnoredReason | null {
  if (left.ownerId !== right.ownerId) return 'owner';
  if (left.epoch !== right.epoch) return 'epoch';
  if (left.draftId !== right.draftId) return 'draft';
  if (left.generation !== right.generation) return 'generation';
  if (left.requestId !== right.requestId) return 'request';
  if (left.imageSha256 !== right.imageSha256) return 'photo';
  return null;
}
function guard(state: AiDraftState, current: unknown): Exclude<AiTransition, { status: 'updated' }> | null {
  if (!validContext(current)) return { status: 'invalid', state, code: 'INVALID_CONTEXT' };
  if (state.status === 'invalidated') return { status: 'ignored', state, reason: 'invalidated' };
  const reason = mismatch(state.context, current);
  return reason ? { status: 'ignored', state, reason } : null;
}
function copyDraft(draft: DeepReadonly<GarmentDraft>): GarmentDraft {
  return { raw: { ...draft.raw, colours: [...draft.raw.colours], seasons: [...draft.raw.seasons],
    style_tags: [...draft.raw.style_tags], tags: [...draft.raw.tags] }, intent: { ...draft.intent }, priceLanguage: draft.priceLanguage };
}
function updated(state: AiDraftState): AiTransition {
  return { status: 'updated', state: freezeValues(state) };
}
function projectedValue(value: DeepReadonly<NonNullable<GarmentValues[AiField]>>): string | string[] {
  return Array.isArray(value) ? [...value] : String(value);
}
export function createAiDraft(draft: GarmentDraft, context: unknown):
  { ok: true; state: AiDraftState } | { ok: false; code: 'INVALID_CONTEXT' | 'INVALID_DRAFT' } {
  if (!validContext(context)) return { ok: false, code: 'INVALID_CONTEXT' };
  try {
    if (!hasOnlyDataKeys(draft, ['raw', 'intent', 'priceLanguage']) || !hasOnlyDataKeys(draft.raw, garmentFields)
      || !hasOnlyDataKeys(draft.intent, garmentFields, [])) return { ok: false, code: 'INVALID_DRAFT' };
    validateGarmentDraft(draft);
    for (const key of garmentFields) {
      const value = draft.raw[key];
      if (['colours', 'seasons', 'style_tags', 'tags'].includes(key)
        ? !Array.isArray(value) || !value.every((entry) => typeof entry === 'string')
        : typeof value !== 'string') return { ok: false, code: 'INVALID_DRAFT' };
    }
    return { ok: true, state: freezeValues({
      status: 'idle', context: { ...context }, draft: copyDraft(draft), derivation: {}, result: null,
    }) };
  } catch {
    return { ok: false, code: 'INVALID_DRAFT' };
  }
}
export function beginAiAnalysis(state: AiDraftState, current: unknown): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status !== 'idle') return { status: 'ignored', state, reason: 'ineligible_state' };
  return updated({ ...state, status: 'pending' });
}
export function receiveAiResult(state: AiDraftState, current: unknown, input: unknown, nowMs: number): AiTransition {
  const parsed = parseAiResult(input);
  if (!parsed.ok) return { status: 'invalid', state, code: parsed.code };
  if (!isAiTimestamp(nowMs)) return { status: 'invalid', state, code: 'INVALID_CONTEXT' };
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status !== 'pending') return { status: 'ignored', state, reason: 'ineligible_state' };
  const result = parsed.value;
  const reason = mismatch(state.context, { ...state.context, ...result });
  if (reason) return { status: 'ignored', state, reason };
  if (nowMs < result.createdAtMs) return { status: 'ignored', state, reason: 'future_result' };
  if (nowMs >= result.expiresAtMs) return { status: 'ignored', state, reason: 'expired_result' };
  if (result.facts.outcome === 'unclear') return updated({ ...state, status: 'unclear', result: null });
  const draft = copyDraft(state.draft);
  const defaults = initialRawFields(draft.raw.currency);
  const derivation: AiDerivation = {};
  for (const field of aiFields) {
    const value = result.facts.fields[field];
    if (!isAssertedAiValue(value) || draft.intent[field] || !sameValue(draft.raw[field], defaults[field])) continue;
    Object.assign(draft.raw, { [field]: projectedValue(value!) });
    Object.assign(derivation, { [field]: { value: Array.isArray(value) ? [...value] : value, kind: aiKind(field) } });
  }
  return updated({ ...state, status: 'ready', draft, derivation, result });
}
export function editAiDraftField<K extends GarmentField>(
  state: AiDraftState, current: unknown, field: K, value: RawFields[K], language: GarmentDraft['priceLanguage'],
): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status === 'invalidated') return { status: 'ignored', state, reason: 'invalidated' };
  const draft = editGarmentField(copyDraft(state.draft), field, value, language);
  const derivation = { ...state.derivation };
  if (aiFields.some((key) => key === field)) delete derivation[field as AiField];
  return updated({ ...state, draft, derivation });
}
export function presentAiDraft(state: AiDraftState, current: AiContext, language: GarmentDraft['priceLanguage']): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status !== 'ready' || !state.result || state.presentation) return { status: 'ignored', state, reason: 'ineligible_state' };
  const presentation = presentAiFacts(state.result.facts, language);
  const draft = copyDraft(state.draft);
  if (!draft.intent.title && draft.raw.title === '') draft.raw.title = presentation.title;
  if (!draft.intent.tags && draft.raw.tags.length === 0) draft.raw.tags = [...presentation.tags];
  return updated({ ...state, draft, presentation: { title: presentation.title, tags: presentation.tags } });
}
// An explicit new generation is also required for retry; no request is allocated here.
export function prepareAiGeneration(state: AiDraftState, current: unknown, next: unknown): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (!validContext(next)) return { status: 'invalid', state, code: 'INVALID_CONTEXT' };
  if (state.status === 'invalidated') return { status: 'ignored', state, reason: 'invalidated' };
  if (next.ownerId !== state.context.ownerId || next.epoch !== state.context.epoch || next.draftId !== state.context.draftId
    || next.generation <= state.context.generation || next.requestId === state.context.requestId) {
    return { status: 'invalid', state, code: 'INVALID_TRANSITION' };
  }
  const draft = copyDraft(state.draft);
  const defaults = initialRawFields(draft.raw.currency);
  for (const field of aiFields) {
    const previous = state.derivation[field];
    if (previous && !draft.intent[field] && sameValue(draft.raw[field], projectedValue(previous.value))) {
      Object.assign(draft.raw, { [field]: defaults[field] });
    }
  }
  if (state.presentation) {
    if (!draft.intent.title && draft.raw.title === state.presentation.title) draft.raw.title = '';
    if (!draft.intent.tags && sameValue(draft.raw.tags, state.presentation.tags)) draft.raw.tags = [];
  }
  return updated({ status: 'idle', context: { ...next }, draft, derivation: {}, result: null });
}
export function expireAiDraft(state: AiDraftState, current: unknown, nowMs: number): AiTransition {
  if (!isAiTimestamp(nowMs)) return { status: 'invalid', state, code: 'INVALID_CONTEXT' };
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status !== 'ready' || !state.result) return { status: 'ignored', state, reason: 'ineligible_state' };
  if (nowMs < state.result.expiresAtMs) return { status: 'ignored', state, reason: 'not_expired' };
  return updated({ ...state, status: 'expired', result: null });
}
export function failAiAnalysis(state: AiDraftState, current: unknown): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status !== 'pending') return { status: 'ignored', state, reason: 'ineligible_state' };
  return updated({ ...state, status: 'failed', result: null });
}
export function continueAiManually(state: AiDraftState, current: unknown): AiTransition {
  const blocked = guard(state, current);
  if (blocked) return blocked;
  if (state.status === 'invalidated') return { status: 'ignored', state, reason: 'invalidated' };
  return updated({ ...state, status: 'cancelled', result: null });
}
export function invalidateAiDraft(reason: AiInvalidation): AiDraftState {
  return freezeValues({ status: 'invalidated', reason, context: null, draft: null, derivation: null, result: null });
}

// Untrusted preparation only: a future checked Save must authenticate and compare the server receipt and photo.
export function aiSaveClaim(state: AiDraftState, current: unknown, nowMs: number):
  | { status: 'ready'; claim: AiSaveClaim }
  | { status: 'none'; reason: AiIgnoredReason }
  | { status: 'invalid'; code: AiDraftFailure } {
  if (!isAiTimestamp(nowMs)) return { status: 'invalid', code: 'INVALID_CONTEXT' };
  const blocked = guard(state, current);
  if (blocked) return blocked.status === 'invalid' ? { status: 'invalid', code: blocked.code } : { status: 'none', reason: blocked.reason };
  if (state.status !== 'ready' || !state.result) return { status: 'none', reason: 'ineligible_state' };
  if (nowMs < state.result.createdAtMs) return { status: 'none', reason: 'future_result' };
  if (nowMs >= state.result.expiresAtMs) return { status: 'none', reason: 'expired_result' };
  const reason = mismatch(state.context, { ...state.context, ...state.result });
  if (reason) return { status: 'none', reason };
  const fields: AiDerivation = {};
  for (const field of aiFields) {
    const entry = state.derivation[field];
    if (!entry) continue;
    if (state.draft.intent[field] || !sameValue(state.draft.raw[field], projectedValue(entry.value))
      || !sameValue(entry.value, state.result.facts.fields[field]) || entry.kind !== aiKind(field)) {
      return { status: 'invalid', code: 'CLAIM_CONFLICT' };
    }
    Object.assign(fields, { [field]: { value: Array.isArray(entry.value) ? [...entry.value] : entry.value, kind: entry.kind } });
  }
  return { status: 'ready', claim: freezeValues({
    requestId: state.context.requestId, draftId: state.context.draftId, generation: state.context.generation,
    imageSha256: state.context.imageSha256, fields,
  }) };
}
