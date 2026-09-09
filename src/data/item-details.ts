import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { isRecord, isUuid } from '../domain/wardrobe';
import {
  confirmsDescription, confirmsItem, imageDetailColumns, itemDetailColumns, parseImageBaseline, parseItemBaseline,
  type DescriptionAttempt, type ImageBaseline, type ItemAttempt, type ItemBaseline, type ItemDetail,
} from '../domain/item-details';

function owned(scope: OwnerScope, ownerId: string, epoch: number) {
  throwIfAborted(scope.signal);
  if (scope.ownerId !== ownerId || scope.epoch !== epoch) throw new AppError('detail.unavailable');
}
export async function loadItemDetail(client: AppClient, scope: OwnerScope, itemId: string): Promise<ItemDetail> {
  throwIfAborted(scope.signal);
  if (!isUuid(itemId) || itemId !== itemId.toLowerCase()) throw new AppError('detail.unavailable');
  const [item, images] = await Promise.all([
    client.from('items').select(itemDetailColumns).eq('owner_id', scope.ownerId).eq('id', itemId)
      .is('deleted_at', null).abortSignal(scope.signal).maybeSingle(),
    client.from('item_images').select(imageDetailColumns).eq('owner_id', scope.ownerId).eq('item_id', itemId)
      .eq('state', 'ready').is('retired_at', null).limit(2).abortSignal(scope.signal),
  ]);
  throwIfAborted(scope.signal);
  requireSuccess(item.error); requireSuccess(images.error);
  if (!Array.isArray(images.data) || images.data.length !== 1) throw new AppError('detail.unavailable');
  return { item: parseItemBaseline(item.data, scope.ownerId, itemId), image: parseImageBaseline(images.data[0], scope.ownerId, itemId) };
}
// Only known database rejections are definitive; transport and malformed replies stay unconfirmed.
function writeError(error: unknown): never {
  if (isRecord(error)) {
    if (error.code === '23505' || error.code === '22023' && error.message === 'Request conflict') throw new AppError('error.conflict');
    if (['42501', '22023', '23514', '23502', '23503', 'PGRST301', 'PGRST302'].includes(String(error.code))) throw new AppError('detail.rejected');
  }
  throw new AppError('detail.unconfirmed');
}
export async function saveItemFields(client: AppClient, scope: OwnerScope, attempt: ItemAttempt): Promise<ItemBaseline> {
  owned(scope, attempt.baseline.ownerId, attempt.epoch);
  let result;
  try {
    result = await client.from('items').update(attempt.patch).eq('id', attempt.baseline.id)
      .eq('owner_id', scope.ownerId).eq('version', attempt.baseline.version).is('deleted_at', null)
      .select(itemDetailColumns).abortSignal(scope.signal).maybeSingle();
  } catch { throwIfAborted(scope.signal); throw new AppError('detail.unconfirmed'); }
  throwIfAborted(scope.signal);
  if (result.error) writeError(result.error);
  if (result.data === null) throw new AppError('error.conflict');
  try {
    const row = parseItemBaseline(result.data, scope.ownerId, attempt.baseline.id);
    if (confirmsItem(row, attempt)) return row;
  } catch { /* A malformed affirmative response cannot confirm a write. */ }
  throw new AppError('detail.unconfirmed');
}
export async function saveImageDescription(client: AppClient, scope: OwnerScope, attempt: DescriptionAttempt): Promise<ImageBaseline> {
  owned(scope, attempt.baseline.ownerId, attempt.epoch);
  let result;
  try {
    result = await client.rpc('update_image_description', {
      p_image_id: attempt.baseline.id, p_expected_description_version: attempt.baseline.version, p_alt_text: attempt.text,
    }).abortSignal(scope.signal);
  } catch { throwIfAborted(scope.signal); throw new AppError('detail.unconfirmed'); }
  throwIfAborted(scope.signal);
  if (result.error) writeError(result.error);
  const row: unknown = Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : null;
  if (isRecord(row) && Object.keys(row).length === 5 && row.id === attempt.baseline.id
    && row.owner_id === scope.ownerId && row.item_id === attempt.baseline.itemId && row.alt_text === attempt.text
    && row.description_version === attempt.baseline.version + 1) {
    const image = { ...attempt.baseline, altText: row.alt_text, version: row.description_version };
    if (confirmsDescription(image, attempt)) return image;
  }
  throw new AppError('detail.unconfirmed');
}
