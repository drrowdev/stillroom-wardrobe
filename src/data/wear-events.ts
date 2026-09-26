import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { isRecord, isUuid } from '../domain/wardrobe';
import { validDateOnly } from '../i18n/format';
import {
  classifyWearError, compareLook, compareRemoval, confirmsWear, eventColumns, parseLook, wearArguments,
  type Look, type LookAttempt, type WearReply,
} from '../domain/wear-events';

const pageSize = 500;

function owned(scope: OwnerScope, signal: AbortSignal, ownerId: string, epoch: number) {
  throwIfAborted(signal);
  if (scope.ownerId !== ownerId || scope.epoch !== epoch) throw new DOMException('Cancelled', 'AbortError');
}
function parse(row: unknown, ownerId: string): Look {
  try { return parseLook(row, ownerId); } catch { throw new AppError('error.unavailable'); }
}

// Every current look from first to last inclusive, in date order; soft-removed looks are left out.
export async function loadLooks(client: AppClient, scope: OwnerScope, first: string, last: string, signal: AbortSignal): Promise<Look[]> {
  if (!validDateOnly(first) || !validDateOnly(last) || first > last) throw new AppError('error.unavailable');
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const ownerId = scope.ownerId, epoch = scope.epoch;
  const result: Look[] = [];
  let cursor: { date: string; id: string } | null = null;
  for (;;) {
    owned(scope, lifetime, ownerId, epoch);
    let query = client.from('wear_events').select(eventColumns).eq('owner_id', ownerId).is('deleted_at', null)
      .gte('local_date', first).lte('local_date', last).order('local_date', { ascending: true }).order('id', { ascending: true }).limit(pageSize);
    if (cursor) query = query.or(`local_date.gt.${cursor.date},and(local_date.eq.${cursor.date},id.gt.${cursor.id})`);
    const { data, error } = await query.abortSignal(lifetime);
    owned(scope, lifetime, ownerId, epoch);
    requireSuccess(error);
    if (!Array.isArray(data) || data.length > pageSize) throw new AppError('error.unavailable');
    for (const row of data as unknown[]) {
      const look = parse(row, ownerId);
      if (look.deletedAt !== null || look.localDate < first || look.localDate > last || result.some(value => value.id === look.id)
        || cursor && (look.localDate < cursor.date || look.localDate === cursor.date && look.id <= cursor.id)) throw new AppError('error.unavailable');
      cursor = { date: look.localDate, id: look.id };
      result.push(look);
    }
    if (data.length < pageSize) return result;
  }
}

// Reads one look even when removed, so an unconfirmed change can be told apart from a lost one.
export async function loadLook(client: AppClient, scope: OwnerScope, id: string, signal: AbortSignal): Promise<Look | null> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const ownerId = scope.ownerId, epoch = scope.epoch;
  owned(scope, lifetime, ownerId, epoch);
  if (!isUuid(id) || id !== id.toLowerCase()) return null;
  const { data, error } = await client.from('wear_events').select(eventColumns).eq('owner_id', ownerId).eq('id', id).abortSignal(lifetime).maybeSingle();
  owned(scope, lifetime, ownerId, epoch);
  requireSuccess(error);
  if (data === null) return null;
  const look = parse(data, ownerId);
  if (look.id !== id) throw new AppError('error.unavailable');
  return look;
}

async function reread<T>(client: AppClient, scope: OwnerScope, id: string, signal: AbortSignal, decide: (look: Look | null) => 'saved' | 'notSaved' | 'changed',
  saved: (look: Look) => T, fallback: T, notSaved: T, changed: T): Promise<T> {
  try {
    const look = await loadLook(client, scope, id, signal);
    const outcome = decide(look);
    return outcome === 'saved' && look ? saved(look) : outcome === 'notSaved' ? notSaved : changed;
  } catch (problem) {
    throwIfAborted(AbortSignal.any([scope.signal, signal]));
    if (problem instanceof DOMException && problem.name === 'AbortError') throw problem;
    return fallback;
  }
}

// Every create path (Wear today, the plan dialog) keeps its attempt here, per owner session, until the server's answer is
// known. The kept ID and payload never change, and every retry reads the look back by that ID before sending anything,
// so a lost reply can never record the look twice. A new owner scope starts empty.
export type CreateReply = WearReply | { kind: 'exists'; look: Look };
const pendingCreates = new WeakMap<OwnerScope, Map<string, LookAttempt>>();
export function pendingCreate(scope: OwnerScope, key: string): LookAttempt | null {
  if (scope.signal.aborted) return null;
  return pendingCreates.get(scope)?.get(key) ?? null;
}
// Only a create the server has definitely not stored may be dropped, so the owner can start a different one.
export function dropPendingCreate(scope: OwnerScope, key: string) {
  pendingCreates.get(scope)?.delete(key);
}
// Kept attempts hold private text, so they are cleared as soon as the owner scope ends (logout or a UID change).
function keepCreate(scope: OwnerScope, key: string, attempt: LookAttempt | null) {
  let entries = pendingCreates.get(scope);
  if (!attempt) { entries?.delete(key); return; }
  if (scope.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!entries) {
    const created = new Map<string, LookAttempt>();
    entries = created;
    pendingCreates.set(scope, created);
    scope.signal.addEventListener('abort', () => { created.clear(); pendingCreates.delete(scope); }, { once: true });
  }
  entries.set(key, attempt);
}

// Read-only: a row with this ID that belongs to the owner means the create was stored, even if it has changed since.
async function readCreate(client: AppClient, scope: OwnerScope, attempt: LookAttempt, signal: AbortSignal, missing: CreateReply): Promise<CreateReply> {
  try {
    const look = await loadLook(client, scope, attempt.id, signal);
    if (look === null) return missing;
    return compareLook(attempt, look) === 'saved' ? { kind: 'saved', version: look.version } : { kind: 'exists', look };
  } catch (problem) {
    throwIfAborted(AbortSignal.any([scope.signal, signal]));
    if (problem instanceof DOMException && problem.name === 'AbortError') throw problem;
    return { kind: 'unknown' };
  }
}
async function sendCreate(client: AppClient, scope: OwnerScope, attempt: LookAttempt, signal: AbortSignal): Promise<CreateReply> {
  let result;
  try {
    result = await client.rpc('save_wear_event', wearArguments(attempt)).abortSignal(signal);
  } catch {
    owned(scope, signal, attempt.ownerId, attempt.epoch);
    result = null;
  }
  owned(scope, signal, attempt.ownerId, attempt.epoch);
  if (result && result.error) {
    const kind = classifyWearError(result.error, result.status);
    // A conflict on a create is a refusal only when no look of this owner has the ID: an earlier send may have stored it.
    if (kind === 'conflict') return readCreate(client, scope, attempt, signal, { kind: 'conflict' });
    if (kind !== 'unknown') return { kind };
  } else if (result && confirmsWear(attempt, result.data)) return { kind: 'saved', version: result.data as number };
  return readCreate(client, scope, attempt, signal, { kind: 'notSaved' });
}

// Creates a look under a key such as `wear-today:<outfit>` or `plan`. A kept attempt for the key always wins over the
// fresh one and is read back first; it is sent again only when `resend` is set and the reread finds no such look.
export async function createLook(client: AppClient, scope: OwnerScope, key: string, fresh: LookAttempt | null, resend: boolean,
  signal: AbortSignal): Promise<{ attempt: LookAttempt; reply: CreateReply } | null> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const kept = pendingCreate(scope, key);
  const attempt = kept ?? (fresh && Object.freeze({ ...fresh, itemIds: Object.freeze([...fresh.itemIds]) }));
  if (!attempt || attempt.baselineVersion !== null) return null;
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  keepCreate(scope, key, attempt);
  let reply: CreateReply;
  if (kept) {
    reply = await readCreate(client, scope, attempt, lifetime, { kind: 'notSaved' });
    if (reply.kind === 'notSaved' && resend) reply = await sendCreate(client, scope, attempt, lifetime);
  } else reply = await sendCreate(client, scope, attempt, lifetime);
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  keepCreate(scope, key, reply.kind === 'notSaved' || reply.kind === 'unknown' ? attempt : null);
  return { attempt, reply };
}
// Edits or marks an existing look through save_wear_event; wear_event_items are never written directly. New looks go
// through createLook.
export async function saveLook(client: AppClient, scope: OwnerScope, attempt: LookAttempt, signal: AbortSignal): Promise<WearReply> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  if (attempt.baselineVersion === null) throw new AppError('error.unavailable');
  let result;
  try {
    result = await client.rpc('save_wear_event', wearArguments(attempt)).abortSignal(lifetime);
  } catch {
    owned(scope, lifetime, attempt.ownerId, attempt.epoch);
    result = null;
  }
  owned(scope, lifetime, attempt.ownerId, attempt.epoch);
  if (result && result.error) {
    const kind = classifyWearError(result.error, result.status);
    if (kind !== 'unknown') return { kind };
  } else if (result && confirmsWear(attempt, result.data)) return { kind: 'saved', version: result.data as number };
  return reread<WearReply>(client, scope, attempt.id, lifetime, look => compareLook(attempt, look),
    look => ({ kind: 'saved', version: look.version }), { kind: 'unknown' }, { kind: 'notSaved' }, { kind: 'conflict' });
}

// Removes a look, or brings it back, with an owner- and version-guarded update that must change exactly one row.
export async function setLookRemoved(client: AppClient, scope: OwnerScope, look: Pick<Look, 'id' | 'ownerId' | 'version'>, removed: boolean,
  epoch: number, signal: AbortSignal): Promise<WearReply> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  owned(scope, lifetime, look.ownerId, epoch);
  let result;
  try {
    result = await client.from('wear_events').update({ deleted_at: removed ? new Date().toISOString() : null })
      .eq('id', look.id).eq('owner_id', look.ownerId).eq('version', look.version).select('id,owner_id,version,deleted_at').abortSignal(lifetime);
  } catch {
    owned(scope, lifetime, look.ownerId, epoch);
    result = null;
  }
  owned(scope, lifetime, look.ownerId, epoch);
  if (result && result.error) {
    const kind = classifyWearError(result.error, result.status);
    if (kind !== 'unknown') return { kind };
  } else if (result && Array.isArray(result.data)) {
    const rows = result.data as unknown[];
    if (rows.length === 0) return { kind: 'conflict' };
    const row = rows[0];
    if (rows.length === 1 && isRecord(row) && row.id === look.id && row.owner_id === look.ownerId && row.version === look.version + 1
      && (row.deleted_at !== null) === removed && (row.deleted_at === null || typeof row.deleted_at === 'string')) return { kind: 'saved', version: look.version + 1 };
  }
  return reread<WearReply>(client, scope, look.id, lifetime, value => compareRemoval({ version: look.version, removed }, value),
    value => ({ kind: 'saved', version: value.version }), { kind: 'unknown' }, { kind: 'notSaved' }, { kind: 'conflict' });
}
