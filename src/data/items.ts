import { isCategory, isRecord, isUuid, type WardrobeItem } from '../domain/wardrobe';
import type { AppClient } from './client';
import type { OwnerScope } from '../auth/session';
import { AppError, requireSuccess, throwIfAborted } from './errors';

export function parseWardrobeRows(items: unknown, images: unknown, ownerId: string): WardrobeItem[] {
  if (!Array.isArray(items) || !Array.isArray(images)) throw new AppError('error.unavailable');
  return items.flatMap((item: unknown) => {
    if (!isRecord(item) || item.owner_id !== ownerId || !isUuid(item.id)
      || !isCategory(item.category) || typeof item.title !== 'string' || typeof item.created_at !== 'string') {
      throw new AppError('error.unavailable');
    }
    if (item.deleted_at !== null) return [];
    const image: unknown = images.find((candidate: unknown) =>
      isRecord(candidate) && candidate.item_id === item.id && candidate.owner_id === ownerId && candidate.state === 'ready');
    if (!image) return [];
    if (!isRecord(image) || !isUuid(image.id) || typeof image.alt_text !== 'string'
      || image.main_path !== `${ownerId}/${item.id}/${image.id}/main.jpg`
      || image.thumb_path !== `${ownerId}/${item.id}/${image.id}/thumb.jpg`) throw new AppError('error.unavailable');
    return [{
      id: item.id, ownerId, title: item.title, category: item.category, createdAt: item.created_at,
      imageId: image.id, mainPath: String(image.main_path), thumbPath: String(image.thumb_path), altText: image.alt_text,
    }];
  });
}

export async function loadWardrobe(client: AppClient, scope: OwnerScope): Promise<WardrobeItem[]> {
  const items: unknown[] = [];
  const images: unknown[] = [];
  let itemCursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    throwIfAborted(scope.signal);
    let query = client.from('items').select('id,owner_id,title,category,created_at,deleted_at')
      .eq('owner_id', scope.ownerId).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(500);
    if (itemCursor) query = query.or(`created_at.lt.${itemCursor.createdAt},and(created_at.eq.${itemCursor.createdAt},id.lt.${itemCursor.id})`);
    const { data, error } = await query.abortSignal(scope.signal);
    throwIfAborted(scope.signal);
    requireSuccess(error);
    if (!Array.isArray(data)) throw new AppError('error.unavailable');
    items.push(...data);
    if (data.length < 500) break;
    const last = data.at(-1);
    if (!last || !isUuid(last.id) || !/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(last.created_at)) throw new AppError('error.unavailable');
    itemCursor = { createdAt: last.created_at, id: last.id };
  }
  let imageCursor: string | null = null;
  for (;;) {
    let query = client.from('item_images')
      .select('id,owner_id,item_id,state,main_path,thumb_path,alt_text')
      .eq('owner_id', scope.ownerId).eq('state', 'ready').order('id').limit(500);
    if (imageCursor) query = query.gt('id', imageCursor);
    const { data, error } = await query.abortSignal(scope.signal);
    throwIfAborted(scope.signal);
    requireSuccess(error);
    if (!Array.isArray(data)) throw new AppError('error.unavailable');
    images.push(...data);
    if (data.length < 500) break;
    const last = data.at(-1);
    if (!last || !isUuid(last.id)) throw new AppError('error.unavailable');
    imageCursor = last.id;
  }
  return parseWardrobeRows(items, images, scope.ownerId);
}
