import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { isRecord, isUuid, type WardrobeItem } from '../domain/wardrobe';
import { validDateOnly } from '../i18n/format';
import { timestampOrder } from './items';

export type WearSummary = { count: number; lastWorn: string | null };
export type WearHistory = {
  ownerId: string;
  epoch: number;
  items: ReadonlyMap<string, WearSummary>;
};
export const wearProjection = 'id,owner_id,item_id,event_id,event:wear_events!wear_event_items_owner_id_event_id_fkey!inner(id,owner_id,local_date,state,deleted_at)';

export function summarizeWear(rows: readonly unknown[], scope: Pick<OwnerScope, 'ownerId' | 'epoch'>, items: readonly WardrobeItem[]): WearHistory {
  if (!isUuid(scope.ownerId) || items.some(item => item.ownerId !== scope.ownerId || !isUuid(item.id))
    || new Set(items.map(item => item.id)).size !== items.length) throw new AppError('wardrobe.historyUnavailable');
  const dates = new Map(items.map(item => [item.id, new Set<string>()]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || !isUuid(row.id) || seen.has(row.id) || row.owner_id !== scope.ownerId
      || !isUuid(row.event_id) || !(row.item_id === null || isUuid(row.item_id)) || !isRecord(row.event)) throw new AppError('wardrobe.historyUnavailable');
    seen.add(row.id);
    const event = row.event;
    if (event.id !== row.event_id || event.owner_id !== scope.ownerId || typeof event.local_date !== 'string'
      || !validDateOnly(event.local_date) || (event.state !== 'worn' && event.state !== 'planned')
      || !(event.deleted_at === null || typeof event.deleted_at === 'string')) throw new AppError('wardrobe.historyUnavailable');
    if (event.deleted_at !== null) timestampOrder(event.deleted_at);
    if (event.state === 'worn' && event.deleted_at === null && row.item_id !== null) dates.get(row.item_id)?.add(event.local_date);
  }
  return {
    ownerId: scope.ownerId, epoch: scope.epoch,
    items: new Map([...dates].map(([id, days]) => [id, { count: days.size, lastWorn: [...days].sort().at(-1) ?? null }])),
  };
}

export async function loadWearHistory(client: AppClient, scope: OwnerScope, items: readonly WardrobeItem[], signal: AbortSignal = scope.signal): Promise<WearHistory> {
  const ownerId = scope.ownerId, epoch = scope.epoch;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  const lifetime = AbortSignal.any([scope.signal, signal, deadline.signal]);
  const rows: unknown[] = [];
  let cursor: string | null = null;
  const check = () => {
    throwIfAborted(lifetime);
    if (scope.ownerId !== ownerId || scope.epoch !== epoch) throw new AppError('wardrobe.historyUnavailable');
  };
  try {
    for (;;) {
      check();
      let query = client.from('wear_event_items').select(wearProjection)
        .eq('owner_id', scope.ownerId).eq('event.owner_id', scope.ownerId)
        .eq('event.state', 'worn').is('event.deleted_at', null).not('item_id', 'is', null)
        .order('id', { ascending: true }).limit(500);
      if (cursor) query = query.gt('id', cursor);
      const { data, error } = await query.abortSignal(lifetime);
      check();
      requireSuccess(error);
      if (!Array.isArray(data) || data.length > 500) throw new AppError('wardrobe.historyUnavailable');
      for (const row of data as unknown[]) {
        if (!isRecord(row) || !isUuid(row.id) || cursor !== null && row.id <= cursor) throw new AppError('wardrobe.historyUnavailable');
        cursor = row.id;
      }
      rows.push(...data);
      if (data.length < 500) return summarizeWear(rows, scope, items);
    }
  } catch {
    throwIfAborted(scope.signal);
    throwIfAborted(signal);
    throw new AppError('wardrobe.historyUnavailable');
  } finally { clearTimeout(timer); }
}
