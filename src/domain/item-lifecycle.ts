import { AppError } from '../data/errors';
import { freezeValues, parseGarmentValues, sameValue, type GarmentValues } from './garment-fields';
import { parseFieldProvenance, sameFieldProvenance, type FieldProvenance } from './attribute-provenance';
import { itemDetailColumns, itemFactColumns, type ItemBaseline } from './item-details';
import { isRecord, isUuid } from './wardrobe';

export const lifecyclePageSize = 40;
export const lifecycleBudgetMs = 30_000;
export const undoMs = 8_000;
export { itemDetailColumns };
export const lifecycleImageColumns = 'id,owner_id,item_id,state,retired_at,main_path,thumb_path';
const statusKeys = ['id', 'owner_id', 'title', 'version', 'deleted_at', 'photo_count', 'current_image_id',
  'current_thumb_path', 'image_manifest_sha256', 'cleanup_blocked', 'unmanifested_count', 'request_id', 'expected_version', 'started_at'];
export type DeletionStatus = Readonly<{
  id: string; owner_id: string; title: string; version: number; deleted_at: string | null; photo_count: number;
  current_image_id: string | null; current_thumb_path: string | null; image_manifest_sha256: string;
  cleanup_blocked: boolean; unmanifested_count: number; request_id: string | null; expected_version: number | null; started_at: string | null;
}>;
export type LifecycleSnapshot = Readonly<{
  id: string; ownerId: string; version: number; deletedAt: string | null; values: GarmentValues;
  provenance: FieldProvenance; createdAt: string;
}>;
export type TrashIntent = Readonly<{ baseline: LifecycleSnapshot; trashed: boolean; epoch: number }>;
export type UndoItem = { item: LifecycleSnapshot; expiresAt: number };
export function newUndo(item: LifecycleSnapshot): UndoItem { return { item, expiresAt: performance.now() + undoMs }; }
export type DeletionIntent = Readonly<{ preview: DeletionStatus; requestId: string; expectedVersion: number; epoch: number }>;
export type LifecycleImage = Readonly<{ id: string; mainPath: string; thumbPath: string; state: 'ready' | 'retired'; retiredAt: string | null }>;
export const canonicalId = (value: unknown): value is string => isUuid(value) && value === value.toLowerCase();
export const safeVersion = (value: unknown, input = false): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER - (input ? 1 : 0);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const stamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = () => new AppError('error.unavailable');
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
export function requireLifecycleIds(ids: readonly string[], owner: string): void {
  if (!canonicalId(owner) || ids.length < 1 || ids.length > lifecyclePageSize
    || new Set(ids).size !== ids.length || !ids.every(canonicalId)) throw invalid();
}
export function parseDeletionStatuses(value: unknown, owner: string, ids: readonly string[]): DeletionStatus[] {
  requireLifecycleIds(ids, owner);
  if (!Array.isArray(value) || value.length > ids.length) throw invalid();
  const seen = new Set<string>();
  return value.map((row: unknown) => {
    if (!exact(row, statusKeys) || !canonicalId(row.id) || !ids.includes(row.id) || seen.has(row.id)
      || row.owner_id !== owner || typeof row.title !== 'string' || !row.title.trim() || row.title.includes('\0') || [...row.title].length > 100
      || !safeVersion(row.version) || !(row.deleted_at === null || stamp(row.deleted_at))
      || !count(row.photo_count) || !hash(row.image_manifest_sha256) || !count(row.unmanifested_count)
      || typeof row.cleanup_blocked !== 'boolean' || row.cleanup_blocked !== (row.unmanifested_count > 0)) throw invalid();
    if (row.current_image_id === null ? row.current_thumb_path !== null
      : !canonicalId(row.current_image_id) || row.photo_count < 1
        || row.current_thumb_path !== `${owner}/${row.id}/${row.current_image_id}/thumb.jpg`) throw invalid();
    if (row.request_id === null ? row.expected_version !== null || row.started_at !== null
      : !canonicalId(row.request_id) || !safeVersion(row.expected_version, true) || !stamp(row.started_at)
        || row.deleted_at === null || row.version !== row.expected_version + 1) throw invalid();
    seen.add(row.id);
    return freezeValues({
      id: row.id, owner_id: owner, title: row.title, version: row.version, deleted_at: row.deleted_at,
      photo_count: row.photo_count, current_image_id: row.current_image_id as string | null,
      current_thumb_path: row.current_thumb_path as string | null, image_manifest_sha256: row.image_manifest_sha256,
      cleanup_blocked: row.cleanup_blocked, unmanifested_count: row.unmanifested_count,
      request_id: row.request_id as string | null, expected_version: row.expected_version as number | null, started_at: row.started_at as string | null,
    });
  });
}
export function parseLifecycleSnapshot(value: unknown, owner: string, id: string): LifecycleSnapshot {
  requireLifecycleIds([id], owner);
  if (!isRecord(value) || value.id !== id || value.owner_id !== owner || !safeVersion(value.version)
    || !(value.deleted_at === null || stamp(value.deleted_at)) || !stamp(value.created_at) || !stamp(value.updated_at)
    || itemFactColumns.some(key => !Object.hasOwn(value, key))) throw invalid();
  try {
    return freezeValues({ id, ownerId: owner, version: value.version, deletedAt: value.deleted_at,
      values: parseGarmentValues(value), provenance: parseFieldProvenance(value.field_provenance), createdAt: value.created_at });
  } catch { throw invalid(); }
}
export function sameSavedBaseline(actual: LifecycleSnapshot, baseline: ItemBaseline): boolean {
  return actual.id === baseline.id && actual.ownerId === baseline.ownerId && actual.version === baseline.version
    && actual.deletedAt === null && sameValue(actual.values, baseline.values)
    && sameFieldProvenance(actual.provenance, baseline.provenance) && actual.createdAt === baseline.facts.created_at;
}
export function confirmsTrash(actual: LifecycleSnapshot, intent: TrashIntent): boolean {
  const base = intent.baseline;
  return actual.id === base.id && actual.ownerId === base.ownerId && actual.version === base.version + 1
    && (intent.trashed ? actual.deletedAt !== null : actual.deletedAt === null)
    && actual.createdAt === base.createdAt && sameValue(actual.values, base.values) && sameFieldProvenance(actual.provenance, base.provenance);
}
export function parseTrashReply(value: unknown, intent: TrashIntent): LifecycleSnapshot {
  const row: unknown = Array.isArray(value) && value.length === 1 ? value[0] : null;
  const base = intent.baseline;
  if (!exact(row, ['id', 'owner_id', 'version', 'deleted_at']) || row.id !== base.id || row.owner_id !== base.ownerId
    || !safeVersion(row.version) || row.version !== base.version + 1
    || (intent.trashed ? !stamp(row.deleted_at) : row.deleted_at !== null)) throw invalid();
  return freezeValues({ ...base, version: row.version, deletedAt: row.deleted_at as string | null });
}
export function deletionIntent(preview: DeletionStatus, epoch: number, requestId: string = crypto.randomUUID()): DeletionIntent {
  if (!preview.deleted_at || preview.cleanup_blocked || !canonicalId(requestId)
    || !safeVersion(preview.expected_version ?? preview.version, true)) throw invalid();
  return freezeValues({ preview, epoch, requestId: preview.request_id ?? requestId, expectedVersion: preview.expected_version ?? preview.version });
}
export function samePreview(actual: DeletionStatus, expected: DeletionStatus): boolean {
  return sameValue(actual, expected);
}
export function matchesClaim(status: DeletionStatus, intent: DeletionIntent): boolean {
  return status.id === intent.preview.id && status.owner_id === intent.preview.owner_id
    && status.request_id === intent.requestId && status.expected_version === intent.expectedVersion
    && status.version === intent.expectedVersion + 1 && status.image_manifest_sha256 === intent.preview.image_manifest_sha256
    && status.title === intent.preview.title && status.photo_count === intent.preview.photo_count && status.deleted_at === intent.preview.deleted_at
    && status.current_image_id === intent.preview.current_image_id && status.current_thumb_path === intent.preview.current_thumb_path
    && (intent.preview.started_at === null || status.started_at === intent.preview.started_at)
    && !status.cleanup_blocked;
}
export function parseBeginReply(value: unknown, intent: DeletionIntent): string {
  const row: unknown = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (!exact(row, ['request_id', 'expected_version', 'version', 'started_at', 'image_manifest_sha256'])
    || row.request_id !== intent.requestId || row.expected_version !== intent.expectedVersion
    || row.version !== intent.expectedVersion + 1 || !stamp(row.started_at)
    || row.image_manifest_sha256 !== intent.preview.image_manifest_sha256
    || intent.preview.started_at !== null && row.started_at !== intent.preview.started_at) throw invalid();
  return row.started_at;
}
export function parseFinishReply(value: unknown): 'completed' | 'absent' {
  const row: unknown = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (!exact(row, ['state']) || row.state !== 'completed' && row.state !== 'absent') throw invalid();
  return row.state;
}
export function parseLifecycleImages(value: unknown, owner: string, item: string, cursor: string | null): LifecycleImage[] {
  requireLifecycleIds([item], owner);
  if (!Array.isArray(value) || value.length > lifecyclePageSize) throw invalid();
  let previous = cursor;
  return value.map((row: unknown) => {
    if (!exact(row, lifecycleImageColumns.split(',')) || !canonicalId(row.id) || row.owner_id !== owner || row.item_id !== item
      || previous !== null && row.id <= previous || row.state !== 'ready' && row.state !== 'retired'
      || (row.state === 'ready' ? row.retired_at !== null : !stamp(row.retired_at))
      || row.main_path !== `${owner}/${item}/${row.id}/main.jpg` || row.thumb_path !== `${owner}/${item}/${row.id}/thumb.jpg`) throw invalid();
    previous = row.id;
    return freezeValues({ id: row.id, mainPath: String(row.main_path), thumbPath: String(row.thumb_path), state: row.state, retiredAt: row.retired_at as string | null });
  });
}
