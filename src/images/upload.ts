import type { AppClient } from '../data/client';
import type { OwnerScope } from '../auth/session';
import type { DraftDetails } from '../domain/wardrobe';
import { isRecord } from '../domain/wardrobe';
import type { PreparedPhoto } from './process-jpeg';
import { AppError, requireSuccess, throwIfAborted } from '../data/errors';

export type SaveStage = 'capture.reserving' | 'capture.uploading' | 'capture.finishing';
export type SaveAttempt = {
  itemId: string; imageId: string; details: DraftDetails; photo: PreparedPhoto; currency: string;
};
export function newSaveAttempt(details: DraftDetails, photo: PreparedPhoto, currency: string): SaveAttempt {
  return { itemId: crypto.randomUUID(), imageId: crypto.randomUUID(), details: { ...details }, photo, currency };
}
function duplicate(error: unknown): boolean {
  return isRecord(error) && (error.code === '23505' || String(error.statusCode) === '409'
    || error.error === 'Duplicate' || error.message === 'The resource already exists');
}
function matches(actual: unknown, expected: Record<string, unknown>): boolean {
  return isRecord(actual) && Object.entries(expected).every(([key, value]) => actual[key] === value);
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
  const { details, photo } = attempt;
  const item = { id: attempt.itemId, owner_id: scope.ownerId, title: details.title, category: details.category, currency: attempt.currency };
  onStage('capture.reserving');
  const created = await client.from('items').insert(item).abortSignal(scope.signal);
  throwIfAborted(scope.signal);
  if (created.error) {
    if (!duplicate(created.error)) requireSuccess(created.error);
    const existing = await client.from('items').select('id,owner_id,title,category,currency,deleted_at')
      .eq('id', attempt.itemId).eq('owner_id', scope.ownerId).abortSignal(scope.signal).maybeSingle();
    requireSuccess(existing.error);
    if (!matches(existing.data, { ...item, deleted_at: null })) throw new AppError('error.conflict');
  }
  const metadata = {
    id: attempt.imageId, owner_id: scope.ownerId, item_id: attempt.itemId,
    main_bytes: photo.main.size, thumb_bytes: photo.thumb.size,
    main_sha256: photo.mainSha256, thumb_sha256: photo.thumbSha256,
    width: photo.width, height: photo.height, alt_text: details.altText,
  };
  const reserved = await client.from('item_images').insert(metadata).abortSignal(scope.signal);
  throwIfAborted(scope.signal);
  if (reserved.error) {
    if (!duplicate(reserved.error)) requireSuccess(reserved.error);
    const existing = await client.from('item_images').select('*').eq('id', attempt.imageId)
      .eq('owner_id', scope.ownerId).abortSignal(scope.signal).maybeSingle();
    requireSuccess(existing.error);
    if (!matches(existing.data, metadata)) throw new AppError('error.conflict');
    if (existing.data?.state === 'ready') return;
    if (existing.data?.state !== 'pending') throw new AppError('error.conflict');
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
