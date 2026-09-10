import type { AppClient } from '../data/client';
import type { OwnerScope } from '../auth/session';
import { isRecord } from '../domain/wardrobe';
import { sameFieldProvenance } from '../domain/attribute-provenance';
import { buildGarmentWrite, freezeValues, garmentPayload, sameValue, type GarmentDraft, type GarmentPayload, type GarmentValues } from '../domain/garment-fields';
import type { FieldProvenance } from '../domain/attribute-provenance';
import { validDescription } from '../domain/item-details';
import { canonicalPrice } from '../i18n/format';
import type { PreparedPhoto } from './process-jpeg';
import { AppError, requireSuccess, throwIfAborted } from '../data/errors';

export type SaveStage = 'capture.reserving' | 'capture.uploading' | 'capture.finishing';
export type SaveAttempt = {
  itemId: string; imageId: string; values: GarmentValues; payload: GarmentPayload & { field_provenance: FieldProvenance }; altText: string;
  photo: PreparedPhoto; ownerId: string; epoch: number;
};
export function newSaveAttempt(draft: GarmentDraft, altText: string, photo: PreparedPhoto, scope: OwnerScope): SaveAttempt {
  throwIfAborted(scope.signal);
  const description = validDescription(altText);
  if (description === null) throw new AppError('detail.invalidDescription');
  const { values, patch } = buildGarmentWrite(draft);
  return freezeValues({
    itemId: crypto.randomUUID(), imageId: crypto.randomUUID(), values: structuredClone(values),
    payload: { ...garmentPayload(values), field_provenance: structuredClone(patch.field_provenance) },
    altText: description, photo: { ...photo }, ownerId: scope.ownerId, epoch: scope.epoch,
  });
}
function duplicate(error: unknown): boolean {
  return isRecord(error) && (error.code === '23505' || String(error.statusCode) === '409'
    || error.error === 'Duplicate' || error.message === 'The resource already exists');
}
function matches(actual: unknown, expected: Record<string, unknown>): boolean {
  return isRecord(actual) && Object.entries(expected).every(([key, value]) => {
    if (key === 'purchase_price' && value !== null && actual[key] !== null) {
      try { return canonicalPrice(actual[key]) === canonicalPrice(value); } catch { return false; }
    }
    return sameValue(actual[key], value);
  });
}
function requireCheckedSuccess(error: unknown): void {
  if (error === null) return;
  if (isRecord(error) && error.code === '22023' && error.details === null && error.hint === null) {
    if (error.message === 'Request conflict') throw new AppError('error.conflict');
    if (error.message === 'Upload incomplete') throw new AppError('error.uploadIncomplete');
  }
  throw new AppError('error.unavailable');
}
function serverTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function reservationFingerprint(data: unknown, attempt: SaveAttempt): string {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) throw new AppError('error.conflict');
  const { item, image, fingerprint, state } = data[0];
  if (Object.keys(data[0]).length !== 4 || !isRecord(item) || !isRecord(image)
    || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)
    || (state !== 'reserved' && state !== 'completed')
    || !serverTime(item.created_at) || !serverTime(item.updated_at) || !serverTime(image.created_at)) {
    throw new AppError('error.conflict');
  }
  const expectedItem = {
    ...attempt.payload, id: attempt.itemId, owner_id: attempt.ownerId, version: 1, deleted_at: null,
    created_at: item.created_at, updated_at: item.updated_at,
  };
  const { photo } = attempt;
  const prefix = `${attempt.ownerId}/${attempt.itemId}/${attempt.imageId}`;
  const expectedImage = {
    id: attempt.imageId, owner_id: attempt.ownerId, item_id: attempt.itemId,
    main_bytes: photo.main.size, thumb_bytes: photo.thumb.size,
    main_sha256: photo.mainSha256, thumb_sha256: photo.thumbSha256,
    width: photo.width, height: photo.height, alt_text: attempt.altText,
    description_version: 1, retired_at: null, state: state === 'reserved' ? 'pending' : 'ready',
    main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, created_at: image.created_at,
  };
  if (Object.keys(item).length !== Object.keys(expectedItem).length || !matches(item, expectedItem)
    || !sameFieldProvenance(item.field_provenance, attempt.payload.field_provenance)
    || Object.keys(image).length !== Object.keys(expectedImage).length || !matches(image, expectedImage)) {
    throw new AppError('error.conflict');
  }
  return fingerprint;
}
async function ensureFile(client: AppClient, path: string, bytes: Blob, expectedHash: string, scope: OwnerScope): Promise<void> {
  throwIfAborted(scope.signal);
  const { error } = await client.storage.from('wardrobe').upload(path, bytes, {
    contentType: 'image/jpeg', upsert: false, cacheControl: '0',
  });
  throwIfAborted(scope.signal);
  if (!error) return;
  if (!duplicate(error)) { requireSuccess(error); return; }
  const existing = await client.storage.from('wardrobe').download(path, {}, { signal: scope.signal, cache: 'no-store' });
  throwIfAborted(scope.signal);
  requireSuccess(existing.error);
  if (!existing.data) throw new AppError('error.uploadIncomplete');
  const digest = await crypto.subtle.digest('SHA-256', await existing.data.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
  if (hash !== expectedHash) throw new AppError('error.conflict');
}

export async function saveItem(
  client: AppClient, scope: OwnerScope, attempt: SaveAttempt, onStage: (stage: SaveStage) => void,
): Promise<void> {
  const checkScope = () => {
    throwIfAborted(scope.signal);
    if (attempt.ownerId !== scope.ownerId || attempt.epoch !== scope.epoch) throw new AppError('error.conflict');
  };
  checkScope();
  const { photo } = attempt;
  onStage('capture.reserving');
  checkScope();
  const reserved = await client.rpc('reserve_item_save', {
    p_item: { ...attempt.payload, id: attempt.itemId },
    p_image: {
      id: attempt.imageId, main_bytes: photo.main.size, thumb_bytes: photo.thumb.size,
      main_sha256: photo.mainSha256, thumb_sha256: photo.thumbSha256,
      width: photo.width, height: photo.height, alt_text: attempt.altText,
    },
  }).abortSignal(scope.signal);
  checkScope();
  requireCheckedSuccess(reserved.error);
  const fingerprint = reservationFingerprint(reserved.data, attempt);
  const prefix = `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}`;
  onStage('capture.uploading');
  checkScope();
  await ensureFile(client, `${prefix}/thumb.jpg`, photo.thumb, photo.thumbSha256, scope);
  checkScope();
  await ensureFile(client, `${prefix}/main.jpg`, photo.main, photo.mainSha256, scope);
  checkScope();
  onStage('capture.finishing');
  checkScope();
  const committed = await client.rpc('finalize_item_save', {
    p_item_id: attempt.itemId, p_image_id: attempt.imageId, p_fingerprint: fingerprint,
  }).abortSignal(scope.signal);
  checkScope();
  requireCheckedSuccess(committed.error);
  if (committed.data !== null && committed.data !== undefined) throw new AppError('error.conflict');
}
