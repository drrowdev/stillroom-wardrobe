import type { OwnerScope } from '../auth/session';
import { confirmsOutfitReply, reconcileOutfit, type OutfitIntent, type OutfitOutcome } from '../domain/outfit-lifecycle';
import type { AppClient } from './client';
import { throwIfAborted } from './errors';
import { loadOutfit } from './outfits';

function owned(scope: OwnerScope, intent: OutfitIntent, signal: AbortSignal) {
  throwIfAborted(signal);
  if (scope.ownerId !== intent.baseline.ownerId || scope.epoch !== intent.epoch) throw new DOMException('Cancelled', 'AbortError');
}
export async function checkOutfitAction(client: AppClient, scope: OwnerScope, intent: OutfitIntent): Promise<OutfitOutcome> {
  owned(scope, intent, scope.signal);
  try {
    const row = await loadOutfit(client, scope, intent.baseline.id, scope.signal, false);
    owned(scope, intent, scope.signal);
    return reconcileOutfit(intent, row);
  } catch {
    owned(scope, intent, scope.signal);
    return { kind: 'unknown' };
  }
}
export async function changeOutfit(client: AppClient, scope: OwnerScope, intent: OutfitIntent): Promise<OutfitOutcome> {
  owned(scope, intent, scope.signal);
  let result;
  try {
    const args = { p_id: intent.baseline.id, p_expected_version: intent.baseline.version };
    result = intent.action === 'delete'
      ? await client.rpc('delete_trashed_outfit', args).abortSignal(scope.signal).retry(false)
      : await client.rpc('set_outfit_trashed', { ...args, p_trashed: intent.action === 'trash' }).abortSignal(scope.signal).retry(false);
  } catch {
    owned(scope, intent, scope.signal);
    return checkOutfitAction(client, scope, intent);
  }
  owned(scope, intent, scope.signal);
  if (result.status >= 500) return checkOutfitAction(client, scope, intent);
  if (result.error) {
    const error = result.error;
    if (error.code === '22023') return { kind: error.message === 'Recovery expired' ? 'expired'
      : error.message === 'Try-on running' ? 'busy' : 'conflict' };
    if (error.code === '42501' || error.code === 'PGRST202' || result.status === 401 || result.status === 403) return { kind: 'unavailable' };
    return checkOutfitAction(client, scope, intent);
  }
  const row = confirmsOutfitReply(intent, result.data);
  return row === undefined ? checkOutfitAction(client, scope, intent) : { kind: 'saved', record: row };
}
