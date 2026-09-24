import type { OwnerScope } from '../auth/session';
import { combinationKey, combinationSignature, type EngineFeedback } from '../domain/recommendations';
import { isRecord, isUuid } from '../domain/wardrobe';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';

export type Vote = 1 | -1;
export type SuggestionInputs = { excludedPairs: [string, string][]; feedback: EngineFeedback[] };

const page = 500;
const lowerUuid = (value: unknown): value is string => isUuid(value) && value === value.toLowerCase();

export function parseRuleRows(rows: unknown, ownerId: string): [string, string][] {
  if (!Array.isArray(rows)) throw new AppError('error.unavailable');
  return rows.map((row: unknown): [string, string] => {
    if (!isRecord(row) || row.owner_id !== ownerId || !lowerUuid(row.id) || !lowerUuid(row.item_low) || !lowerUuid(row.item_high)
      || !(row.item_low < row.item_high)) throw new AppError('error.unavailable');
    return [row.item_low, row.item_high];
  });
}
export function parseFeedbackRows(rows: unknown, ownerId: string): EngineFeedback[] {
  if (!Array.isArray(rows)) throw new AppError('error.unavailable');
  const seen = new Set<string>();
  return rows.map((row: unknown): EngineFeedback => {
    if (!isRecord(row) || row.owner_id !== ownerId || !lowerUuid(row.id) || !Array.isArray(row.item_ids)
      || row.item_ids.length < 1 || row.item_ids.length > 12 || !row.item_ids.every(lowerUuid)
      || new Set(row.item_ids).size !== row.item_ids.length || (row.vote !== 1 && row.vote !== -1)
      || typeof row.signature !== 'string' || !/^[0-9a-f]{64}$/.test(row.signature)) throw new AppError('error.unavailable');
    const key = combinationKey(row.item_ids as string[]);
    if (seen.has(key)) throw new AppError('error.unavailable');
    seen.add(key);
    return { itemIds: key.split('|'), vote: row.vote };
  });
}

async function readAll(client: AppClient, scope: OwnerScope, table: 'combination_rules' | 'suggestion_feedback', columns: string, signal: AbortSignal) {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    throwIfAborted(signal);
    let query = client.from(table).select(columns).eq('owner_id', scope.ownerId).order('id').limit(page);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query.abortSignal(signal);
    throwIfAborted(signal);
    requireSuccess(error);
    if (!Array.isArray(data) || data.length > page) throw new AppError('error.unavailable');
    for (const row of data as unknown[]) {
      if (!isRecord(row) || !lowerUuid(row.id) || cursor !== null && row.id <= cursor) throw new AppError('error.unavailable');
      cursor = row.id;
    }
    rows.push(...data);
    if (data.length < page) return rows;
  }
}

export async function loadSuggestionInputs(client: AppClient, scope: OwnerScope, signal: AbortSignal): Promise<SuggestionInputs> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const [rules, feedback] = await Promise.all([
    readAll(client, scope, 'combination_rules', 'id,owner_id,item_low,item_high', lifetime),
    readAll(client, scope, 'suggestion_feedback', 'id,owner_id,item_ids,signature,vote', lifetime),
  ]);
  return { excludedPairs: parseRuleRows(rules, scope.ownerId), feedback: parseFeedbackRows(feedback, scope.ownerId) };
}

// The server trigger checks ownership, sorts the IDs and derives the signature that the conflict target uses.
export async function setVote(client: AppClient, scope: OwnerScope, itemIds: readonly string[], vote: Vote, signal: AbortSignal): Promise<void> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  throwIfAborted(lifetime);
  const { error } = await client.from('suggestion_feedback')
    .upsert({ owner_id: scope.ownerId, item_ids: combinationKey(itemIds).split('|'), vote }, { onConflict: 'owner_id,signature' })
    .abortSignal(lifetime);
  throwIfAborted(lifetime);
  requireSuccess(error);
}
export async function clearVote(client: AppClient, scope: OwnerScope, itemIds: readonly string[], signal: AbortSignal): Promise<void> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const signature = await combinationSignature(itemIds);
  throwIfAborted(lifetime);
  const { error } = await client.from('suggestion_feedback').delete()
    .eq('owner_id', scope.ownerId).eq('signature', signature).abortSignal(lifetime);
  throwIfAborted(lifetime);
  requireSuccess(error);
}
