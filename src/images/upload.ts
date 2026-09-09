import type { AppClient } from '../data/client';
import type { OwnerScope } from '../auth/session';
import { isRecord } from '../domain/wardrobe';
import { maximumFieldRevision, sameFieldProvenance } from '../domain/attribute-provenance';
import { buildGarmentWrite, freezeValues, garmentFields, garmentPayload, sameValue, type GarmentDraft, type GarmentPayload, type GarmentValues } from '../domain/garment-fields';
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
  throwIfAborted(scope.signal);
  if (attempt.ownerId !== scope.ownerId || attempt.epoch !== scope.epoch) throw new AppError('error.conflict');
  const { photo } = attempt;
  const item = { ...attempt.payload, id: attempt.itemId, owner_id: scope.ownerId };
  const fieldProvenance = attempt.payload.field_provenance;
  onStage('capture.reserving');
  const created = await client.from('items').insert({ ...item, field_provenance: fieldProvenance }).abortSignal(scope.signal);
  throwIfAborted(scope.signal);
  if (created.error) {
    if (!duplicate(created.error)) requireSuccess(created.error);
    const columns: string = `id,owner_id,version,deleted_at,field_provenance,${garmentFields.join(',')}`;
    const existing = await client.from('items').select(columns)
      .eq('id', attempt.itemId).eq('owner_id', scope.ownerId).abortSignal(scope.signal).maybeSingle();
    requireSuccess(existing.error);
    throwIfAborted(scope.signal);
    const row: unknown = existing.data;
    if (!isRecord(row) || !matches(row, { ...item, deleted_at: null, version: 1 })
      || !sameFieldProvenance(row.field_provenance, fieldProvenance)) throw new AppError('error.conflict');
  }
  const metadata = {
    id: attempt.imageId, owner_id: scope.ownerId, item_id: attempt.itemId,
    main_bytes: photo.main.size, thumb_bytes: photo.thumb.size,
    main_sha256: photo.mainSha256, thumb_sha256: photo.thumbSha256,
    width: photo.width, height: photo.height, alt_text: attempt.altText,
  };
  const reserved = await client.from('item_images').insert(metadata).abortSignal(scope.signal);
  throwIfAborted(scope.signal);
  if (reserved.error) {
    if (!duplicate(reserved.error)) requireSuccess(reserved.error);
    const existing = await client.from('item_images').select('*').eq('id', attempt.imageId)
      .eq('owner_id', scope.ownerId).abortSignal(scope.signal).maybeSingle();
    requireSuccess(existing.error);
    throwIfAborted(scope.signal);
    if (!matches(existing.data, { ...metadata, retired_at: null,
      main_path: `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}/main.jpg`,
      thumb_path: `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}/thumb.jpg`,
    }) || typeof existing.data?.description_version !== 'number' || !Number.isInteger(existing.data.description_version)
      || existing.data.description_version < 1 || existing.data.description_version > maximumFieldRevision) throw new AppError('error.conflict');
    if (existing.data?.state === 'ready') return;
    if (existing.data?.state !== 'pending' || existing.data.description_version !== 1) throw new AppError('error.conflict');
  }
  const prefix = `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}`;
  onStage('capture.uploading');
  await ensureFile(client, `${prefix}/thumb.jpg`, photo.thumb, photo.thumbSha256, scope);
  await ensureFile(client, `${prefix}/main.jpg`, photo.main, photo.mainSha256, scope);
  throwIfAborted(scope.signal);
  onStage('capture.finishing');
  const committed = await client.rpc('commit_image', { p_image_id: attempt.imageId }).abortSignal(scope.signal);
  throwIfAborted(scope.signal);
  requireSuccess(committed.error);
}
