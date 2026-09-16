import { isCategory, isRecord, isUuid, type WardrobeItem } from '../domain/wardrobe';
import type { AppClient } from './client';
import type { OwnerScope } from '../auth/session';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { availability, lifecycle, seasons, textLimits, collectionLimits } from '../domain/garment-fields';
import { canonicalPrice, validDateOnly } from '../i18n/format';

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && [...value].length <= maximum;
}
function collection(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((entry: unknown) => typeof entry === 'string' && !entry.includes('\0'));
}
export function timestampOrder(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('error.unavailable');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDateOnly(match[1]!) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || !Number.isFinite(Date.parse(value))) throw new AppError('error.unavailable');
  // Postgres microseconds must not collapse to millisecond ties at a page boundary.
  return new Date(value).toISOString() + (match[5] ?? '').padEnd(6, '0').slice(3);
}

export function parseWardrobeRows(items: unknown, images: unknown, ownerId: string): WardrobeItem[] {
  if (!isUuid(ownerId) || !Array.isArray(items) || !Array.isArray(images)) throw new AppError('error.unavailable');
  const ready = new Map<string, { id: string; mainPath: string; thumbPath: string; altText: string }>();
  for (const image of images as unknown[]) {
    if (!isRecord(image) || image.owner_id !== ownerId || !isUuid(image.id) || !isUuid(image.item_id)) throw new AppError('error.unavailable');
    if (image.state === 'pending' || image.state === 'retired') continue;
    if (image.state !== 'ready') throw new AppError('error.unavailable');
    if (!text(image.alt_text, 240) || image.main_path !== `${ownerId}/${image.item_id}/${image.id}/main.jpg`
      || image.thumb_path !== `${ownerId}/${image.item_id}/${image.id}/thumb.jpg` || ready.has(image.item_id)) throw new AppError('error.unavailable');
    ready.set(image.item_id, { id: image.id, mainPath: String(image.main_path), thumbPath: String(image.thumb_path), altText: image.alt_text });
  }
  const seen = new Set<string>();
  return items.flatMap((item: unknown) => {
    if (!isRecord(item) || item.owner_id !== ownerId || !isUuid(item.id)
      || !isCategory(item.category) || !text(item.title, textLimits.title) || !item.title.length || typeof item.created_at !== 'string'
      || seen.has(item.id)) {
      throw new AppError('error.unavailable');
    }
    seen.add(item.id);
    timestampOrder(item.created_at);
    if (item.deleted_at !== null) {
      if (typeof item.deleted_at !== 'string') throw new AppError('error.unavailable');
      return [];
    }
    const available = availability.find(value => value === item.availability);
    const state = lifecycle.find(value => value === item.lifecycle);
    if (!available || !state || typeof item.favourite !== 'boolean' || typeof item.exclude_suggestions !== 'boolean') throw new AppError('error.unavailable');
    if (!(item.brand === null || text(item.brand, textLimits.brand))
      || !collection(item.tags, collectionLimits.tags) || new TextEncoder().encode(item.tags.join(',')).byteLength > 512
      || !collection(item.colours, collectionLimits.colours) || !collection(item.seasons, collectionLimits.seasons)
      || !item.seasons.every(code => seasons.some(season => season === code))
      || !(item.formality === null || typeof item.formality === 'number' && Number.isInteger(item.formality) && item.formality >= 0 && item.formality <= 4)
      || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) throw new AppError('error.unavailable');
    let price: string | null;
    try { price = item.purchase_price === null ? null : canonicalPrice(item.purchase_price); }
    catch { throw new AppError('error.unavailable'); }
    const image = ready.get(item.id);
    if (!image) return [];
    return [{
      id: item.id, ownerId, title: item.title, category: item.category, createdAt: item.created_at,
      imageId: image.id, mainPath: image.mainPath, thumbPath: image.thumbPath, altText: image.altText,
      favourite: item.favourite, availability: available, lifecycle: state, excludeSuggestions: item.exclude_suggestions,
      brand: item.brand, tags: [...item.tags], colours: [...item.colours], seasons: [...item.seasons],
      formality: item.formality, purchasePrice: price, currency: item.currency,
    }];
  });
}

export async function loadWardrobe(client: AppClient, scope: OwnerScope, signal: AbortSignal = scope.signal): Promise<WardrobeItem[]> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const items: unknown[] = [];
  const images: unknown[] = [];
  let itemCursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    throwIfAborted(lifetime);
    let query = client.from('items').select('id,owner_id,title,category,created_at,deleted_at,favourite,availability,lifecycle,exclude_suggestions,brand,tags,colours,seasons,formality,purchase_price,currency')
      .eq('owner_id', scope.ownerId).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(500);
    if (itemCursor) query = query.or(`created_at.lt.${itemCursor.createdAt},and(created_at.eq.${itemCursor.createdAt},id.lt.${itemCursor.id})`);
    const { data, error } = await query.abortSignal(lifetime);
    throwIfAborted(lifetime);
    requireSuccess(error);
    if (!Array.isArray(data) || data.length > 500) throw new AppError('error.unavailable');
    for (const row of data) {
      if (!isUuid(row.id)) throw new AppError('error.unavailable');
      const order = timestampOrder(row.created_at);
      if (itemCursor && (order > timestampOrder(itemCursor.createdAt)
        || order === timestampOrder(itemCursor.createdAt) && row.id >= itemCursor.id)) throw new AppError('error.unavailable');
      itemCursor = { createdAt: row.created_at, id: row.id };
    }
    items.push(...data);
    if (data.length < 500) break;
  }
  let imageCursor: string | null = null;
  for (;;) {
    throwIfAborted(lifetime);
    let query = client.from('item_images')
      .select('id,owner_id,item_id,state,main_path,thumb_path,alt_text')
      .eq('owner_id', scope.ownerId).eq('state', 'ready').order('id').limit(500);
    if (imageCursor) query = query.gt('id', imageCursor);
    const { data, error } = await query.abortSignal(lifetime);
    throwIfAborted(lifetime);
    requireSuccess(error);
    if (!Array.isArray(data) || data.length > 500) throw new AppError('error.unavailable');
    for (const row of data) {
      if (!isUuid(row.id) || imageCursor !== null && row.id <= imageCursor) throw new AppError('error.unavailable');
      imageCursor = row.id;
    }
    images.push(...data);
    if (data.length < 500) break;
  }
  return parseWardrobeRows(items, images, scope.ownerId);
}
