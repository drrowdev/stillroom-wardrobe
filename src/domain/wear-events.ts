import { isRecord, isUuid } from './wardrobe';
import { validDateOnly } from '../i18n/format';
import type { MessageKey } from '../i18n';

export const lookLimits = { label: 100, items: 12 } as const;
export const eventColumns = 'id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at,version,created_at,'
  + 'wear_event_items!wear_event_items_owner_id_event_id_fkey(id,owner_id,event_id,item_id,title_snapshot,category_snapshot)';

export type WearState = 'planned' | 'worn';
export type LookPiece = { id: string; itemId: string | null; title: string; category: string };
export type Look = {
  id: string; ownerId: string; outfitId: string | null; localDate: string; timezone: string; state: WearState;
  label: string; deletedAt: string | null; version: number; createdAt: string; pieces: LookPiece[];
};
// What save_wear_event is asked to store. A null baseline creates the look, or replays an identical create.
export type LookAttempt = {
  id: string; localDate: string; timezone: string; state: WearState; label: string; outfitId: string | null;
  itemIds: readonly string[]; baselineVersion: number | null; ownerId: string; epoch: number;
};
export type WearResult = 'conflict' | 'invalidSelection' | 'future' | 'rejected' | 'notSaved' | 'unknown';
export type WearReply = { kind: 'saved'; version: number } | { kind: WearResult };
export type WearProblem = { key: MessageKey; action?: 'retry' | 'reload' };
export const wearProblems: Record<WearResult, WearProblem> = {
  conflict: { key: 'error.conflict', action: 'reload' },
  invalidSelection: { key: 'calendar.invalidSelection' },
  future: { key: 'calendar.future' },
  rejected: { key: 'calendar.notSaved' },
  notSaved: { key: 'calendar.notSaved', action: 'retry' },
  unknown: { key: 'calendar.unknown', action: 'reload' },
};

const plainText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && [...value].length <= maximum;
const lowerUuid = (value: unknown): value is string => isUuid(value) && value === value.toLowerCase();

export function parseLook(row: unknown, ownerId: string): Look {
  if (!isRecord(row) || row.owner_id !== ownerId || !lowerUuid(row.id) || !(row.outfit_id === null || lowerUuid(row.outfit_id))
    || typeof row.local_date !== 'string' || !validDateOnly(row.local_date) || typeof row.timezone !== 'string' || !row.timezone
    || (row.state !== 'planned' && row.state !== 'worn') || !plainText(row.label, lookLimits.label) || !row.label.length
    || !(row.deleted_at === null || typeof row.deleted_at === 'string') || typeof row.created_at !== 'string'
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.wear_event_items)) throw new Error('Invalid look.');
  const seen = new Set<string>(), items = new Set<string>();
  const pieces = (row.wear_event_items as unknown[]).map((link): LookPiece => {
    if (!isRecord(link) || link.owner_id !== ownerId || link.event_id !== row.id || !lowerUuid(link.id) || seen.has(link.id)
      || !(link.item_id === null || lowerUuid(link.item_id)) || typeof link.item_id === 'string' && items.has(link.item_id)
      || !plainText(link.title_snapshot, 100) || !link.title_snapshot.length || !plainText(link.category_snapshot, 40)) throw new Error('Invalid look.');
    seen.add(link.id);
    if (typeof link.item_id === 'string') items.add(link.item_id);
    return { id: link.id, itemId: link.item_id, title: link.title_snapshot, category: link.category_snapshot };
  }).sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
  return {
    id: row.id, ownerId, outfitId: row.outfit_id, localDate: row.local_date, timezone: row.timezone, state: row.state,
    label: row.label, deletedAt: row.deleted_at, version: row.version, createdAt: row.created_at, pieces,
  };
}

// Items that save_wear_event can still link: a deleted garment keeps its text but has no item to send.
export function linkedItems(look: Pick<Look, 'pieces'>): string[] {
  return look.pieces.flatMap(piece => piece.itemId ? [piece.itemId] : []);
}
export function canMarkWorn(look: Pick<Look, 'state' | 'localDate' | 'pieces'>, today: string): boolean {
  return look.state === 'planned' && look.localDate <= today && linkedItems(look).length > 0;
}
export function stateAttempt(look: Look, state: WearState, epoch: number): LookAttempt {
  return {
    id: look.id, localDate: look.localDate, timezone: look.timezone, state, label: look.label, outfitId: look.outfitId,
    itemIds: linkedItems(look), baselineVersion: look.version, ownerId: look.ownerId, epoch,
  };
}

export type LookDraft = { localDate: string; label: string; outfitId: string | null; itemIds: string[] };
export type LookErrors = { date?: 'calendar.dateRequired'; label?: 'outfits.nameRequired' | 'outfits.nameTooLong'; items?: 'outfits.chooseAtLeastOne' | 'outfits.limit' | 'outfits.invalidSelection' };
export function validateLook(draft: LookDraft): { errors: LookErrors } | { value: LookDraft } {
  const errors: LookErrors = {};
  const label = draft.label.trim();
  if (!validDateOnly(draft.localDate)) errors.date = 'calendar.dateRequired';
  if (!label) errors.label = 'outfits.nameRequired';
  else if ([...label].length > lookLimits.label || label.includes('\0')) errors.label = 'outfits.nameTooLong';
  const ids = draft.itemIds;
  if (!ids.length) errors.items = 'outfits.chooseAtLeastOne';
  else if (ids.length > lookLimits.items) errors.items = 'outfits.limit';
  else if (new Set(ids).size !== ids.length || !ids.every(lowerUuid) || !(draft.outfitId === null || lowerUuid(draft.outfitId))) errors.items = 'outfits.invalidSelection';
  if (errors.date || errors.label || errors.items) return { errors };
  return { value: { localDate: draft.localDate, label, outfitId: draft.outfitId, itemIds: [...ids] } };
}

export function wearArguments(attempt: LookAttempt) {
  const base = {
    // A look without a saved outfit sends SQL null; the generated argument type does not model nullable parameters.
    p_id: attempt.id, p_local_date: attempt.localDate, p_timezone: attempt.timezone, p_state: attempt.state,
    p_label: attempt.label, p_outfit_id: attempt.outfitId as string, p_item_ids: [...attempt.itemIds],
  };
  return attempt.baselineVersion === null ? base : { ...base, p_expected_version: attempt.baselineVersion };
}
export function expectedWearVersion(attempt: LookAttempt): number {
  return attempt.baselineVersion === null ? 1 : attempt.baselineVersion + 1;
}
export function confirmsWear(attempt: LookAttempt, value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expectedWearVersion(attempt);
}

// Both save_wear_event versions are handled: the hosted initial one reports a create-ID collision as 23505,
// the later one as 'Request conflict'. A foreign or vanished outfit fails its owner foreign key (23503).
export function classifyWearError(error: unknown, status?: number): WearResult {
  if (typeof status === 'number' && status >= 500) return 'unknown';
  if (!isRecord(error)) return 'unknown';
  const code = String(error.code ?? ''), message = error.message;
  if (code === 'P0001' && message === 'Request conflict' || code === '23505' || code === '23503') return 'conflict';
  if (code === 'P0001' && message === 'Invalid selection') return 'invalidSelection';
  if (code === 'P0001' && message === 'A future plan cannot count as worn') return 'future';
  if (code === 'P0001' && message === 'Invalid timezone' || ['42501', '23514', '23502', '22P02', '22007', '22008', 'PGRST301', 'PGRST302'].includes(code)) return 'rejected';
  return 'unknown';
}

function samePieces(look: Look, itemIds: readonly string[]): boolean {
  const current = linkedItems(look).sort(), wanted = [...itemIds].sort();
  return current.length === wanted.length && current.every((id, index) => id === wanted[index]);
}
// A read-only reread decides what an unconfirmed save did; it never implies a resend.
export function compareLook(attempt: LookAttempt, reread: Look | null): 'saved' | 'notSaved' | 'changed' {
  if (reread === null) return attempt.baselineVersion === null ? 'notSaved' : 'changed';
  if (reread.deletedAt !== null) return 'changed';
  if (attempt.baselineVersion !== null && reread.version === attempt.baselineVersion) return 'notSaved';
  return reread.version === expectedWearVersion(attempt) && reread.localDate === attempt.localDate && reread.timezone === attempt.timezone
    && reread.state === attempt.state && reread.label === attempt.label && reread.outfitId === attempt.outfitId
    && samePieces(reread, attempt.itemIds) ? 'saved' : 'changed';
}
export function compareRemoval(target: { version: number; removed: boolean }, reread: Look | null): 'saved' | 'notSaved' | 'changed' {
  if (reread === null) return 'changed';
  if (reread.version === target.version && (reread.deletedAt !== null) !== target.removed) return 'notSaved';
  return reread.version === target.version + 1 && (reread.deletedAt !== null) === target.removed ? 'saved' : 'changed';
}
