import type { OutfitRecord } from './outfits';
import type { MessageKey } from '../i18n';

export type OutfitAction = 'trash' | 'restore' | 'delete';
export type OutfitIntent = { baseline: OutfitRecord; epoch: number; action: OutfitAction };
export type OutfitOutcome =
  | { kind: 'saved'; record: OutfitRecord | null }
  | { kind: 'unknown' | 'notSaved' | 'conflict' | 'unavailable' | 'expired' | 'busy' | 'wearPending' };

export const outfitProblems: Record<Exclude<OutfitOutcome['kind'], 'saved'>, MessageKey> = {
  unknown: 'outfitTrash.unknown', notSaved: 'outfitTrash.notSaved', conflict: 'outfitTrash.conflict',
  unavailable: 'error.unavailable', expired: 'outfitTrash.expired', busy: 'outfitTrash.busy',
  wearPending: 'calendar.unknown',
};
export function recoverableOutfit(record: OutfitRecord, now = Date.now()): boolean {
  const deleted = record.deletedAt === null ? NaN : Date.parse(record.deletedAt);
  return deleted <= now && deleted >= now - 7 * 24 * 60 * 60 * 1000;
}
export function outfitRecoveryDays(record: OutfitRecord, now = Date.now()): number {
  return recoverableOutfit(record, now) && record.deletedAt !== null
    ? Math.ceil((Date.parse(record.deletedAt) + 7 * 86400000 - now) / 86400000) : 0;
}
function samePayload(a: OutfitRecord, b: OutfitRecord) {
  return a.id === b.id && a.ownerId === b.ownerId && a.createdAt === b.createdAt && a.title === b.title
    && a.occasion === b.occasion && a.notes === b.notes && a.favourite === b.favourite
    && JSON.stringify(a.links) === JSON.stringify(b.links);
}
export function reconcileOutfit(intent: OutfitIntent, record: OutfitRecord | null): OutfitOutcome {
  const before = intent.baseline;
  if (!record) return intent.action === 'delete' ? { kind: 'saved', record: null } : { kind: 'conflict' };
  if (!samePayload(before, record)) return { kind: 'conflict' };
  if (before.version === record.version && before.deletedAt === record.deletedAt) return { kind: 'notSaved' };
  if (intent.action !== 'delete' && record.version === before.version + 1
    && Number.isSafeInteger(record.version)
    && (intent.action === 'trash' ? record.deletedAt !== null : record.deletedAt === null)) return { kind: 'saved', record };
  return { kind: 'conflict' };
}
export function confirmsOutfitReply(intent: OutfitIntent, value: unknown): OutfitRecord | null | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>, before = intent.baseline;
  const expected = intent.action === 'delete' ? 'deleted,id,owner_id,version' : 'deleted_at,id,owner_id,version';
  if (Object.keys(row).sort().join(',') !== expected || row.id !== before.id || row.owner_id !== before.ownerId) return undefined;
  if (intent.action === 'delete') return row.deleted === true && row.version === before.version ? null : undefined;
  if (!Number.isSafeInteger(row.version) || row.version !== before.version + 1
    || (intent.action === 'trash' ? typeof row.deleted_at !== 'string' || !Number.isFinite(Date.parse(row.deleted_at)) : row.deleted_at !== null)) return undefined;
  return { ...before, version: Number(row.version), deletedAt: row.deleted_at as string | null };
}
