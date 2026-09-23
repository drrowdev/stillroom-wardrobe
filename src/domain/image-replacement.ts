import type { OwnerScope } from '../auth/session';
import type { Json } from '../data/database.types';
import { AppError, throwIfAborted } from '../data/errors';
import type { PreparedPhoto } from '../images/process-jpeg';
import { aiSaveClaim, savedAiEligibility, type AiDraftState, type AiSaveClaim } from './ai-draft';
import { fieldAssertion, maximumFieldRevision, parseFieldProvenance, provenanceFields } from './attribute-provenance';
import { freezeValues, garmentFields, garmentPayload, newGarmentDraft, sameValue, validateGarmentDraft, type GarmentDraft } from './garment-fields';
import { validDescription, type ImageBaseline, type ItemBaseline } from './item-details';
import { isRecord, isUuid } from './wardrobe';

export type ImageChangeIntent = {
  requestId: string; itemId: string; imageId: string; expectedVersion: number;
  currentImageId: string; descriptionVersion: number; item: Record<string, Json>;
  image: { id: string; main_bytes: number; thumb_bytes: number; main_sha256: string; thumb_sha256: string;
    width: number; height: number; alt_text: string };
  claim: Json; sourceImageId: string | null;
};
export type ImageChangeAttempt = {
  ownerId: string; epoch: number; intent: ImageChangeIntent; photo: PreparedPhoto;
};
export type ImageChangeReceipt = {
  requestId: string; itemId: string; imageId: string; kind: 'replacement' | 'recovery';
  state: 'reserved' | 'completed' | 'cancelled'; fingerprint: string; completedVersion: number | null;
};
export type RecoveryVersion = {
  id: string; ownerId: string; itemId: string; mainPath: string; thumbPath: string; altText: string;
  mainBytes: number; thumbBytes: number; mainSha256: string; thumbSha256: string;
  width: number; height: number; retiredAt: string; eligible: boolean;
};
const positive = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function conflict(): never { throw new AppError('error.conflict'); }

export function parseImageChangeReceipt(value: unknown, itemId: string, requestId?: string): ImageChangeReceipt {
  if (!isRecord(value) || Object.keys(value).length !== 7 || value.itemId !== itemId
    || !isUuid(value.requestId) || requestId !== undefined && value.requestId !== requestId || !isUuid(value.imageId)
    || value.kind !== 'replacement' && value.kind !== 'recovery'
    || value.state !== 'reserved' && value.state !== 'completed' && value.state !== 'cancelled'
    || !hash(value.fingerprint)
    || (value.state === 'completed' ? !positive(value.completedVersion, Number.MAX_SAFE_INTEGER) : value.completedVersion !== null)) conflict();
  return freezeValues({ requestId: value.requestId, itemId, imageId: value.imageId, kind: value.kind,
    state: value.state, fingerprint: value.fingerprint, completedVersion: value.completedVersion as number | null });
}
export function matchImageChangeReceipt(value: unknown, attempt: ImageChangeAttempt, previous?: ImageChangeReceipt): ImageChangeReceipt {
  const { intent } = attempt;
  const receipt = parseImageChangeReceipt(value, intent.itemId, intent.requestId);
  if (receipt.imageId !== intent.imageId || receipt.kind !== (intent.sourceImageId ? 'recovery' : 'replacement')
    || receipt.state === 'completed' && receipt.completedVersion !== intent.expectedVersion + 1
    || previous && (receipt.fingerprint !== previous.fingerprint
      || previous.state !== 'reserved' && receipt.state !== previous.state)) conflict();
  return receipt;
}
export function parseRecoveryVersions(value: unknown, ownerId: string, itemId: string, after?: string): RecoveryVersion[] {
  if (!isUuid(ownerId) || !isUuid(itemId) || after !== undefined && !isUuid(after)
    || !Array.isArray(value) || value.length > 40) conflict();
  let last = after ?? '';
  return value.map((row: unknown) => {
    if (!isRecord(row) || Object.keys(row).length !== 2 || typeof row.eligible !== 'boolean' || !isRecord(row.image)) conflict();
    const im = row.image;
    if (Object.keys(im).length !== 16 || !isUuid(im.id) || im.id <= last || im.owner_id !== ownerId || im.item_id !== itemId
      || im.state !== 'retired' || typeof im.retired_at !== 'string' || !Number.isFinite(Date.parse(im.retired_at))
      || typeof im.created_at !== 'string' || !Number.isFinite(Date.parse(im.created_at))
      || !positive(im.description_version, maximumFieldRevision) || typeof im.alt_text !== 'string'
      || [...im.alt_text].length > 240 || im.alt_text.includes('\0')
      || im.main_path !== `${ownerId}/${itemId}/${im.id}/main.jpg` || im.thumb_path !== `${ownerId}/${itemId}/${im.id}/thumb.jpg`
      || !positive(im.main_bytes, 512000) || !positive(im.thumb_bytes, 61440)
      || !positive(im.width, 1600) || !positive(im.height, 1600) || !hash(im.main_sha256) || !hash(im.thumb_sha256)) conflict();
    last = im.id;
    return freezeValues({ id: im.id, ownerId, itemId, mainPath: String(im.main_path), thumbPath: String(im.thumb_path),
      altText: im.alt_text, mainBytes: im.main_bytes, thumbBytes: im.thumb_bytes, mainSha256: im.main_sha256,
      thumbSha256: im.thumb_sha256, width: im.width, height: im.height, retiredAt: im.retired_at, eligible: row.eligible });
  });
}
function claimJson(claim: AiSaveClaim | null): Json {
  if (!claim) return null;
  const fields: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(claim.fields)) {
    if (!entry) conflict();
    fields[key] = { kind: entry.kind, value: typeof entry.value === 'object' ? [...entry.value] : entry.value };
  }
  return { requestId: claim.requestId, draftId: claim.draftId, generation: claim.generation, imageSha256: claim.imageSha256, fields };
}
function composeItem(baseline: ItemBaseline, draft: GarmentDraft, claim: AiSaveClaim | null): Record<string, Json> {
  const original = newGarmentDraft(baseline.values.currency, 'en', baseline.values);
  const eligibility = savedAiEligibility({ values: baseline.values, provenance: baseline.provenance });
  const validation = structuredClone(draft);
  // Validation admits changed derived values without changing the user's actual intent.
  for (const field of garmentFields) if (!sameValue(draft.raw[field], original.raw[field])) {
    if (!draft.intent[field] && !eligibility[field]) conflict();
    validation.intent[field] = true;
  }
  const { values } = validateGarmentDraft(validation, baseline.values);
  if (!values) throw new AppError('detail.invalidFields');
  const provenance = parseFieldProvenance(baseline.provenance);
  for (const field of provenanceFields) {
    const prior = fieldAssertion(provenance, field);
    const changed = !sameValue(values[field], baseline.values[field]);
    const derived = claim?.fields[field as keyof AiSaveClaim['fields']];
    if (derived && (draft.intent[field] || !eligibility[field] || !sameValue(values[field], derived.value))) conflict();
    const raw = draft.raw[field];
    const cleared = raw === '' || Array.isArray(raw) && raw.length === 0;
    const confirmed = draft.intent[field] && (changed || cleared || prior.kind !== 'user');
    if (!changed && !confirmed && !derived) continue;
    if (prior.revision >= maximumFieldRevision) conflict();
    provenance[field] = { kind: confirmed ? 'user' : derived ? derived.kind : 'unknown', revision: prior.revision + 1 };
  }
  return { ...garmentPayload(values), field_provenance: provenance };
}
export function newImageChangeAttempt(
  baseline: ItemBaseline, image: ImageBaseline, draft: GarmentDraft, description: string, photo: PreparedPhoto,
  scope: OwnerScope, state?: AiDraftState, recovery?: RecoveryVersion,
): ImageChangeAttempt {
  throwIfAborted(scope.signal);
  const text = validDescription(description);
  if (text === null) throw new AppError('detail.invalidDescription');
  if (baseline.ownerId !== scope.ownerId || image.ownerId !== scope.ownerId || image.itemId !== baseline.id
    || !isUuid(baseline.id) || !isUuid(image.id) || !positive(baseline.version, Number.MAX_SAFE_INTEGER - 1)
    || !positive(image.version, maximumFieldRevision)) conflict();
  let claim: AiSaveClaim | null = null;
  if (state) {
    const result = aiSaveClaim(state, state.context, Date.now());
    if (result.status !== 'ready' || state.context?.ownerId !== scope.ownerId || state.context.epoch !== scope.epoch
      || result.claim.imageSha256 !== photo.mainSha256 || !sameValue(draft, state.draft)) conflict();
    claim = result.claim;
  }
  if (!positive(photo.main.size, 512000) || !positive(photo.thumb.size, 61440)
    || !positive(photo.width, 1600) || !positive(photo.height, 1600) || !hash(photo.mainSha256) || !hash(photo.thumbSha256)) conflict();
  if (recovery && (state || !recovery.eligible || recovery.ownerId !== scope.ownerId || recovery.itemId !== baseline.id
    || recovery.id === image.id || photo.main.size !== recovery.mainBytes || photo.thumb.size !== recovery.thumbBytes
    || photo.mainSha256 !== recovery.mainSha256 || photo.thumbSha256 !== recovery.thumbSha256
    || photo.width !== recovery.width || photo.height !== recovery.height)) conflict();
  const imageId = crypto.randomUUID();
  return freezeValues({ ownerId: scope.ownerId, epoch: scope.epoch, photo: { ...photo }, intent: {
    requestId: crypto.randomUUID(), itemId: baseline.id, imageId, expectedVersion: baseline.version,
    currentImageId: image.id, descriptionVersion: image.version,
    item: recovery ? { ...garmentPayload(baseline.values), field_provenance: structuredClone(baseline.provenance) }
      : composeItem(baseline, draft, claim),
    image: { id: imageId, main_bytes: photo.main.size, thumb_bytes: photo.thumb.size, main_sha256: photo.mainSha256,
      thumb_sha256: photo.thumbSha256, width: photo.width, height: photo.height, alt_text: text },
    claim: claimJson(claim), sourceImageId: recovery?.id ?? null,
  } });
}
