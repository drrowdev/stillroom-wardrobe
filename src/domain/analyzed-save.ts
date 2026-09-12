import type { OwnerScope } from '../auth/session';
import { AppError, throwIfAborted } from '../data/errors';
import type { PreparedPhoto } from '../images/process-jpeg';
import type { SaveAttempt } from '../images/upload';
import { aiSaveClaim, type AiContext, type AiDraftState, type AiSaveClaim } from './ai-draft';
import { analyzedSaveProvenance, provenanceFields, type ProvenanceField, type ProvenanceKind } from './attribute-provenance';
import { freezeValues, garmentPayload, initialRawFields, sameValue, validateGarmentDraft, type GarmentDraft } from './garment-fields';
import { validDescription } from './item-details';

export type AnalyzedSaveAttempt = SaveAttempt & { claim: AiSaveClaim | null };
function compose(draft: GarmentDraft, claim: AiSaveClaim | null, altText: string, photo: PreparedPhoto, scope: OwnerScope): AnalyzedSaveAttempt {
  throwIfAborted(scope.signal);
  const { values } = validateGarmentDraft(draft);
  if (!values) throw new AppError('detail.invalidFields');
  const description = validDescription(altText);
  if (description === null) throw new AppError('detail.invalidDescription');
  const kinds: Partial<Record<ProvenanceField, ProvenanceKind>> = {};
  const defaults = initialRawFields(values.currency);
  for (const field of provenanceFields) {
    const derived = claim?.fields[field as keyof AiSaveClaim['fields']];
    if (draft.intent[field]) kinds[field] = 'user';
    else if (derived) {
      if (!sameValue(values[field], derived.value)) throw new AppError('error.conflict');
      kinds[field] = derived.kind;
    } else if (!sameValue(draft.raw[field], defaults[field])) kinds[field] = 'unknown';
  }
  return freezeValues({
    itemId: crypto.randomUUID(), imageId: crypto.randomUUID(), values: structuredClone(values),
    payload: { ...garmentPayload(values), field_provenance: analyzedSaveProvenance(kinds) },
    altText: description, photo: { ...photo }, ownerId: scope.ownerId, epoch: scope.epoch,
    claim: claim === null ? null : structuredClone(claim),
  });
}

export function newAnalyzedSaveAttempt(
  state: AiDraftState, context: AiContext, altText: string, photo: PreparedPhoto, scope: OwnerScope, nowMs: number,
): AnalyzedSaveAttempt {
  throwIfAborted(scope.signal);
  const result = aiSaveClaim(state, context, nowMs);
  if (result.status !== 'ready' || state.status === 'invalidated' || context.ownerId !== scope.ownerId
    || context.epoch !== scope.epoch || photo.mainSha256 !== result.claim.imageSha256) throw new AppError('error.conflict');
  const draft: GarmentDraft = {
    raw: { ...state.draft.raw, colours: [...state.draft.raw.colours], seasons: [...state.draft.raw.seasons],
      style_tags: [...state.draft.raw.style_tags], tags: [...state.draft.raw.tags] },
    intent: { ...state.draft.intent }, priceLanguage: state.draft.priceLanguage,
  };
  return compose(draft, result.claim, altText, photo, scope);
}

// A separately invoked choice, never an automatic downgrade of an expired claim.
export function newUnverifiedSaveAttempt(draft: GarmentDraft, altText: string, photo: PreparedPhoto, scope: OwnerScope): AnalyzedSaveAttempt {
  return compose(draft, null, altText, photo, scope);
}
