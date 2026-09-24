import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { isUuid } from '../domain/wardrobe';
import { timestampOrder } from './items';
import {
  classifySaveError, compareSaved, componentColumns, componentImageColumns, confirmsVersion, outfitColumns, parseComponents, parseOutfitRow, saveArguments,
  type OutfitComponent, type OutfitRecord, type SaveAttempt, type SaveOutcome, type SaveResult,
} from '../domain/outfits';

const pageSize = 500;
const chunkSize = 100;

function owned(scope: OwnerScope, signal: AbortSignal, ownerId: string, epoch: number) {
  throwIfAborted(signal);
  if (scope.ownerId !== ownerId || scope.epoch !== epoch) throw new DOMException('Cancelled', 'AbortError');
}
function parse<T>(read: () => T): T {
  try { return read(); } catch { throw new AppError('error.unavailable'); }
}

export async function loadOutfits(client: AppClient, scope: OwnerScope, signal: AbortSignal): Promise<OutfitRecord[]> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const result: OutfitRecord[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    throwIfAborted(lifetime);
    let query = client.from('outfits').select(outfitColumns).eq('owner_id', scope.ownerId).is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(pageSize);
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const { data, error } = await query.abortSignal(lifetime);
    throwIfAborted(lifetime);
    requireSuccess(error);
    if (!Array.isArray(data) || data.length > pageSize) throw new AppError('error.unavailable');
    for (const row of data as unknown[]) {
      const record = parse(() => parseOutfitRow(row, scope.ownerId));
      const order = timestampOrder(record.createdAt);
      if (record.deletedAt !== null || result.some(value => value.id === record.id) || cursor && (order > timestampOrder(cursor.createdAt)
        || order === timestampOrder(cursor.createdAt) && record.id >= cursor.id)) throw new AppError('error.unavailable');
      cursor = { createdAt: record.createdAt, id: record.id };
      result.push(record);
    }
    if (data.length < pageSize) return result;
  }
}

// Reads the parent even when soft-deleted so an unknown save can be told apart from a removed outfit.
export async function loadOutfit(client: AppClient, scope: OwnerScope, id: string, signal: AbortSignal): Promise<OutfitRecord | null> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  throwIfAborted(lifetime);
  if (!isUuid(id) || id !== id.toLowerCase()) return null;
  const { data, error } = await client.from('outfits').select(outfitColumns).eq('owner_id', scope.ownerId).eq('id', id)
    .abortSignal(lifetime).maybeSingle();
  throwIfAborted(lifetime);
  requireSuccess(error);
  if (data === null) return null;
  const record = parse(() => parseOutfitRow(data, scope.ownerId));
  if (record.id !== id) throw new AppError('error.unavailable');
  return record;
}

export async function loadComponents(client: AppClient, scope: OwnerScope, ids: readonly string[], signal: AbortSignal): Promise<Map<string, OutfitComponent>> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const unique = [...new Set(ids)];
  if (unique.some(id => !isUuid(id))) throw new AppError('error.unavailable');
  const result = new Map<string, OutfitComponent>();
  for (let start = 0; start < unique.length; start += chunkSize) {
    const chunk = unique.slice(start, start + chunkSize);
    throwIfAborted(lifetime);
    const [items, images] = await Promise.all([
      client.from('items').select(componentColumns).eq('owner_id', scope.ownerId).in('id', chunk).abortSignal(lifetime),
      client.from('item_images').select(componentImageColumns).eq('owner_id', scope.ownerId).in('item_id', chunk)
        .eq('state', 'ready').is('retired_at', null).abortSignal(lifetime),
    ]);
    throwIfAborted(lifetime);
    requireSuccess(items.error); requireSuccess(images.error);
    for (const [id, component] of parse(() => parseComponents(chunk, items.data, images.data, scope.ownerId))) result.set(id, component);
  }
  return result;
}

export type SaveReply = { kind: 'saved'; version: number } | { kind: SaveResult };

export async function saveOutfit(client: AppClient, scope: OwnerScope, attempt: SaveAttempt, signal: AbortSignal): Promise<SaveReply> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  let result;
  try {
    result = await client.rpc('save_outfit', saveArguments(attempt)).abortSignal(lifetime);
  } catch {
    owned(scope, lifetime, attempt.ownerId, attempt.epoch);
    return { kind: 'unknown' };
  }
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  if (result.error) return { kind: classifySaveError(result.error, result.status) };
  const value: unknown = result.data;
  return confirmsVersion(attempt, value) ? { kind: 'saved', version: value as number } : { kind: 'unknown' };
}

export async function rereadSave(client: AppClient, scope: OwnerScope, attempt: SaveAttempt, signal: AbortSignal): Promise<{ outcome: SaveOutcome; record: OutfitRecord | null }> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  const record = await loadOutfit(client, scope, attempt.id, lifetime);
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  return { outcome: compareSaved(attempt, record), record };
}
