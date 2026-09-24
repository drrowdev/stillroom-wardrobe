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

export type VoteAttempt = { ownerId: string; epoch: number; key: string; choice: Vote | null };
export type WriteOutcome = 'done' | 'rejected' | 'unknown';

// Only a definite database refusal proves nothing was stored. A lost or failed response may have committed.
export function classifyVoteError(error: unknown, status?: number): Exclude<WriteOutcome, 'done'> {
  if (typeof status === 'number' && (status === 0 || status >= 500)) return 'unknown';
  if (!isRecord(error)) return 'unknown';
  const code = String(error.code ?? '');
  return ['42501', '23514', '23502', '23503', 'P0001', 'PGRST301', 'PGRST302'].includes(code) ? 'rejected' : 'unknown';
}

function owned(scope: OwnerScope, signal: AbortSignal, attempt: VoteAttempt) {
  throwIfAborted(signal);
  if (scope.ownerId !== attempt.ownerId || scope.epoch !== attempt.epoch) throw new DOMException('Cancelled', 'AbortError');
}

// The server trigger checks ownership, sorts the IDs and derives the signature that the conflict target uses.
export async function writeVote(client: AppClient, scope: OwnerScope, attempt: VoteAttempt, signal: AbortSignal): Promise<WriteOutcome> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, attempt);
  const ids = attempt.key.split('|');
  const signature = attempt.choice === null ? await combinationSignature(ids) : '';
  owned(scope, lifetime, attempt);
  let result;
  try {
    result = attempt.choice === null
      ? await client.from('suggestion_feedback').delete().eq('owner_id', attempt.ownerId).eq('signature', signature).abortSignal(lifetime)
      : await client.from('suggestion_feedback')
        .upsert({ owner_id: attempt.ownerId, item_ids: combinationKey(ids).split('|'), vote: attempt.choice }, { onConflict: 'owner_id,signature' })
        .abortSignal(lifetime);
  } catch {
    owned(scope, lifetime, attempt);
    return 'unknown';
  }
  owned(scope, lifetime, attempt);
  return result.error ? classifyVoteError(result.error, result.status) : 'done';
}

export function parseStoredVote(rows: unknown, ownerId: string, key: string): Vote | null {
  const [row, extra] = parseFeedbackRows(rows, ownerId);
  if (extra || row && combinationKey(row.itemIds) !== key) throw new AppError('error.unavailable');
  return row?.vote ?? null;
}

export async function readVote(client: AppClient, scope: OwnerScope, attempt: VoteAttempt, signal: AbortSignal): Promise<Vote | null> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, attempt);
  const signature = await combinationSignature(attempt.key.split('|'));
  owned(scope, lifetime, attempt);
  const { data, error } = await client.from('suggestion_feedback').select('id,owner_id,item_ids,signature,vote')
    .eq('owner_id', attempt.ownerId).eq('signature', signature).limit(2).abortSignal(lifetime);
  owned(scope, lifetime, attempt);
  requireSuccess(error);
  return parseStoredVote(data, attempt.ownerId, attempt.key);
}
