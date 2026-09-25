// Restore (I20/I21, P6b): adds a backup's saved wardrobe to the signed-in account. Only owner-scoped reads and the
// existing checked write paths are used; nothing is overwritten or deleted, and no analysis is ever requested.
import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import type { Json } from './database.types';
import { AppError, isAborted, requireSuccess, throwIfAborted } from './errors';
import { BackupFormatError, canonical, sha256Hex, type JpegCheck, type PartSource } from '../domain/export-format';
import {
  chainState, missingPart, readBackup, restoreId, selectBackupFiles,
  type ChainImage, type ChainState, type ReadBackup, type RestoreItem,
} from '../domain/restore-plan';
import { parseFieldProvenance, type FieldProvenance } from '../domain/attribute-provenance';
import { garmentPayload, parseGarmentValues, type GarmentPayload, type GarmentValues } from '../domain/garment-fields';
import { itemDetailColumns } from '../domain/item-details';
import { parseImageChangeReceipt, type ImageChangeAttempt, type ImageChangeIntent } from '../domain/image-replacement';
import { isRecord } from '../domain/wardrobe';
import { readJpegHeader, JPEG_LIMITS, ImagePreparationError } from '../images/jpeg';
import { inspectRestoreJpeg } from '../images/restore-jpeg';
import { planRestorePhoto, restorePhotoDeps, type PhotoPlan, type RestorePhotoDeps } from '../images/restore-photo';
import type { PreparedPhoto } from '../images/process-jpeg';
import { ImageChangeClient } from '../images/replace';
import { saveItem, type SaveAttempt } from '../images/upload';

// While reading, before any photo is decoded: the whole structure of every main photo (Q6), and the size of every thumbnail.
// Thumbnails are never stored from a backup; a new one is always made from the main photo.
const checkJpeg: JpegCheck = (bytes, variant, width, height) => {
  try {
    if (variant === 'main') { inspectRestoreJpeg(bytes, width, height); return; }
    const header = readJpegHeader(bytes);
    if (header.width > JPEG_LIMITS.thumbSide || header.height > JPEG_LIMITS.thumbSide || bytes.length > JPEG_LIMITS.thumbBytes) throw new Error('size');
  } catch { throw new BackupFormatError('invalid'); }
};
function readProblem(error: unknown): never {
  if (error instanceof BackupFormatError) {
    throw new AppError(error.problem === 'passphrase' ? 'restore.wrong' : error.problem === 'tooLarge' ? 'restore.tooLarge'
      : error.problem === 'incomplete' ? 'restore.missing' : 'restore.invalid');
  }
  throw error;
}

export type ItemStatus = 'new' | 'resume' | 'same' | 'conflict' | 'trash';
export type ItemPlan = { source: RestoreItem; id: string; imageIds: string[]; requestIds: string[]; status: ItemStatus };
export type RestorePreview = {
  ownerId: string; epoch: number; backup: ReadBackup; items: ItemPlan[]; otherAccount: boolean;
  // Every main photo, checked in full by Check; `reencoded` counts only the photos this restore will write.
  photos: ReadonlyMap<string, PhotoPlan>; deps: RestorePhotoDeps;
  counts: { add: number; same: number; conflicts: number; trash: number; outfits: number; reencoded: number };
  ids: { outfits: string[]; events: string[]; entries: string[][] };
};
// Per photo: what Check planned (the backup file and the main and thumbnail files it would write), kept apart from what
// happened here. `stored` holds the hashes of the files this run wrote, or those recorded for photos already here; it is
// never a newly calculated hash presented as the one expected. Photos not reached are 'skipped'.
export type PhotoOutcome = { sourceImageId: string; planned: Pick<PhotoPlan, 'main' | 'reason' | 'sourceSha256' | 'mainSha256' | 'thumbSha256'>;
  outcome: 'written' | 'present' | 'skipped' | 'failed' | 'blocked'; stored: { mainSha256: string; thumbSha256: string } | null };
// `failed` can be retried; `blocked` items were started by a different restore and can't be finished from this backup;
// `deferred` counts outfits, rules, feedback and history held back until a failed or blocked item is restored.
export type RestoreResult = { restored: number; same: number; conflicts: number; trash: number; failed: number; blocked: number; deferred: number;
  outfits: number; outfitConflicts: number; history: number; historyConflicts: number; photos: PhotoOutcome[] };

/** A backup photo changed or failed its checks after Check: the whole restore stops, and the backup must be checked again. */
export class RestoreRecheckError extends Error {
  constructor() { super('restore.recheck'); this.name = 'RestoreRecheckError'; }
}

// The last run's report, in this tab's memory only. It holds IDs from the backup and file hashes, no garment details, and
// is cleared when the sign-in it ran in ends.
let lastReport: { result: RestoreResult } | null = null;
/** The report of the last restore in this sign-in, including one that stopped early. */
export function restoreReport(): RestoreResult | null { return lastReport?.result ?? null; }

// Check: each photo decoded and planned in part order. A photo this browser can't process now can be checked again later;
// anything else refuses the backup.
async function checkPhoto(backup: ReadBackup, sourceImageId: string, width: number, height: number, signal: AbortSignal,
  deps: RestorePhotoDeps): Promise<PhotoPlan> {
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await backup.read(sourceImageId, 'main'); } catch (error) { if (isAborted(error)) throw error; return readProblem(error); }
  throwIfAborted(signal);
  try { return (await planRestorePhoto(sourceImageId, bytes, width, height, signal, deps)).plan; }
  catch (error) {
    throwIfAborted(signal);
    if (isAborted(error)) throw error;
    throw new AppError(error instanceof ImagePreparationError && error.code === 'unavailable' ? 'error.unavailable' : 'restore.invalid');
  }
}

type StoredImage = ChainImage & { descriptionVersion: number; mainPath: string; thumbPath: string;
  mainBytes: number; thumbBytes: number; mainSha256: string; thumbSha256: string };
const imageColumns = 'id,owner_id,item_id,state,alt_text,width,height,description_version,main_path,thumb_path,main_bytes,thumb_bytes,main_sha256,thumb_sha256';
function storedImage(row: unknown, ownerId: string): StoredImage & { itemId: string } {
  if (!isRecord(row) || row.owner_id !== ownerId || typeof row.id !== 'string' || typeof row.item_id !== 'string'
    || !['pending', 'ready', 'retired'].includes(String(row.state)) || typeof row.alt_text !== 'string') throw new AppError('error.unavailable');
  return { id: row.id, itemId: row.item_id, state: row.state as StoredImage['state'], altText: row.alt_text,
    width: Number(row.width), height: Number(row.height), descriptionVersion: Number(row.description_version),
    mainPath: String(row.main_path), thumbPath: String(row.thumb_path), mainBytes: Number(row.main_bytes), thumbBytes: Number(row.thumb_bytes),
    mainSha256: String(row.main_sha256), thumbSha256: String(row.thumb_sha256) };
}

async function readTargets(client: AppClient, scope: OwnerScope, ids: string[], signal: AbortSignal) {
  const rows = new Map<string, Record<string, unknown>>(), images = new Map<string, StoredImage[]>();
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    const [found, photos] = await Promise.all([
      client.from('items').select(itemDetailColumns).eq('owner_id', scope.ownerId).in('id', chunk).abortSignal(signal),
      client.from('item_images').select(imageColumns).eq('owner_id', scope.ownerId).in('item_id', chunk).abortSignal(signal),
    ]);
    throwIfAborted(signal);
    requireSuccess(found.error); requireSuccess(photos.error);
    for (const row of (found.data ?? []) as unknown[]) {
      if (!isRecord(row) || row.owner_id !== scope.ownerId || typeof row.id !== 'string') throw new AppError('error.unavailable');
      rows.set(row.id, row);
    }
    for (const row of (photos.data ?? []) as unknown[]) {
      const image = storedImage(row, scope.ownerId);
      images.set(image.itemId, [...images.get(image.itemId) ?? [], image]);
    }
  }
  return { rows, images };
}

// The values, kinds and photo as the restore writes them for photo 0. Empty fields carry no kind.
type Restored = { values: GarmentValues; payload: GarmentPayload; provenance: FieldProvenance };
function restoredFields(source: RestoreItem): Restored {
  const values = parseGarmentValues(source.row);
  const payload = garmentPayload(values);
  const provenance: FieldProvenance = {};
  for (const [field, kind] of Object.entries(source.kinds)) {
    const value = (payload as Record<string, unknown>)[field];
    if (value === null || value === '' || Array.isArray(value) && value.length === 0) continue;
    (provenance as Record<string, unknown>)[field] = { kind, revision: 1 };
  }
  return { values, payload, provenance };
}
const kindsOf = (value: unknown) => {
  try { return canonical(Object.fromEntries(Object.entries(parseFieldProvenance(value)).map(([field, entry]) => [field, entry.kind]))); }
  catch { return null; }
};
// An item this restore wrote still has exactly the restored values and kinds; any edit made here since makes it different.
function sameFields(plan: Omit<ItemPlan, 'status'>, row: Record<string, unknown>): boolean {
  try {
    const restored = restoredFields(plan.source);
    return canonical(garmentPayload(parseGarmentValues(row))) === canonical(restored.payload)
      && kindsOf(row.field_provenance) === kindsOf(restored.provenance);
  } catch { return false; }
}

// Structural comparison only (values, kinds, photo chain and item version); stored files and requests are checked while restoring.
function classify(plan: Omit<ItemPlan, 'status'>, row: Record<string, unknown> | undefined, images: readonly ChainImage[]): { status: ItemStatus; chain: ChainState } {
  const targets = plan.source.photos.map((photo, index) => ({ imageId: plan.imageIds[index]!, altText: photo.altText, width: photo.width, height: photo.height }));
  const conflict = { status: 'conflict' as const, chain: { kind: 'conflict' as const } };
  if (!row) return images.length ? conflict : { status: 'new', chain: { kind: 'new' } };
  if (row.deleted_at !== null) return { status: 'trash', chain: { kind: 'conflict' } };
  if (!sameFields(plan, row)) return conflict;
  const chain = chainState(targets, images);
  if (chain.kind === 'conflict' || chain.kind === 'new') return conflict;
  // Photo 0 creates version 1 and each completed replacement adds one; anything else is an edit made here.
  const completed = chain.kind === 'complete' ? targets.length - 1 : Math.max(chain.completed, 0);
  if (row.version !== completed + 1) return conflict;
  return { status: chain.kind === 'complete' ? 'same' : 'resume', chain };
}

// Reads and checks the backup, then compares it with this account using owner-scoped reads only. Nothing is written.
export async function checkBackup(client: AppClient, scope: OwnerScope, files: readonly File[], passphrase: string,
  signal: AbortSignal, deps: RestorePhotoDeps = restorePhotoDeps): Promise<RestorePreview> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  let backup: ReadBackup;
  try {
    const selection = selectBackupFiles(files.map(file => ({ name: file.name, size: file.size })));
    if (missingPart(selection.indices, files.length) !== null) throw new BackupFormatError('incomplete');
    const byIndex = new Map(selection.indices.map((index, position) => [index, files[position]!]));
    const source: PartSource = { count: files.length, exportId: selection.exportId, read: async index => {
      const file = byIndex.get(index);
      if (!file) throw new BackupFormatError('incomplete');
      const text = await file.text();
      // Photos are read again while restoring, after this check has finished, so only the account's lifetime applies.
      throwIfAborted(scope.signal);
      return text;
    } };
    backup = await readBackup(source, passphrase, checkJpeg);
  } catch (error) { if (isAborted(error)) throw error; return readProblem(error); }
  throwIfAborted(lifetime);
  const { data } = backup, uid = scope.ownerId;
  // Every photo's structure passed while reading; only now is any photo decoded.
  const sizes = new Map(data.items.flatMap(item => item.photos.map(photo => [photo.sourceId, photo] as const)));
  const photos = new Map<string, PhotoPlan>();
  for (const id of backup.order) {
    const photo = sizes.get(id);
    if (photo) photos.set(id, await checkPhoto(backup, id, photo.width, photo.height, lifetime, deps));
  }
  if (photos.size !== sizes.size) return readProblem(new BackupFormatError('incomplete'));
  const map = (table: string, id: string) => restoreId(data.version, uid, data.exportId, table, id);
  const base = await Promise.all(data.items.map(async (source) => ({ source, id: await map('items', source.sourceId),
    imageIds: await Promise.all(source.photos.map(photo => map('item_images', photo.sourceId))),
    requestIds: await Promise.all(source.photos.map((_, index) => map('photo-request', `${source.sourceId}#${index}`))) })));
  const { rows, images } = await readTargets(client, scope, base.map(item => item.id), lifetime);
  let reencoded = 0;
  const items = base.map(plan => {
    const { status, chain } = classify(plan, rows.get(plan.id), images.get(plan.id) ?? []);
    const first = status === 'new' ? 0 : status === 'resume' && chain.kind === 'resume' ? chain.completed + 1 : plan.source.photos.length;
    reencoded += plan.source.photos.slice(first).filter(photo => photos.get(photo.sourceId)?.main === 'reencoded').length;
    return { ...plan, status };
  });
  const available = new Set(items.filter(item => item.status !== 'conflict' && item.status !== 'trash').map(item => item.source.sourceId));
  const count = (status: ItemStatus) => items.filter(item => item.status === status).length;
  const ids = {
    outfits: await Promise.all(data.outfits.map(outfit => map('outfits', outfit.sourceId))),
    events: await Promise.all(data.events.map(event => map('wear_events', event.sourceId))),
    entries: await Promise.all(data.events.map(event => Promise.all(event.entries.map(entry => map('wear_event_items', entry.sourceId))))),
  };
  throwIfAborted(lifetime);
  return { ownerId: uid, epoch: scope.epoch, backup, items, otherAccount: data.sourceOwner !== uid, ids, photos, deps,
    counts: { add: count('new') + count('resume'), same: count('same'), conflicts: count('conflict'), trash: count('trash'),
      outfits: data.outfits.filter(outfit => outfit.itemIds.some(id => available.has(id))).length, reencoded } };
}

const conflictError = (error: unknown) => isRecord(error) && error.message === 'Request conflict' && (error.code === 'P0001' || error.code === '22023');

type Photos = { backup: ReadBackup; plans: ReadonlyMap<string, PhotoPlan>; deps: RestorePhotoDeps };
// Before each reservation the photo is read and planned again and must match Check exactly. Any difference or refusal stops
// the whole restore; only a browser that can't process photos right now is an ordinary retry.
async function preparePhoto(photos: Photos, sourceImageId: string, width: number, height: number, signal: AbortSignal): Promise<PreparedPhoto> {
  const planned = photos.plans.get(sourceImageId);
  if (!planned) throw new RestoreRecheckError();
  let bytes: Uint8Array<ArrayBuffer>;
  // Read from the chosen file again, not from what Check kept in memory.
  try { bytes = await photos.backup.read(sourceImageId, 'main', true); }
  catch (error) { if (isAborted(error) || signal.aborted) throw error; throw new RestoreRecheckError(); }
  throwIfAborted(signal);
  try {
    const { plan, photo } = await planRestorePhoto(sourceImageId, bytes, width, height, signal, photos.deps);
    // Both files this photo would write, kept or re-encoded, must be the ones Check planned.
    if (plan.sourceSha256 !== planned.sourceSha256 || plan.main !== planned.main || plan.reason !== planned.reason
      || plan.mainSha256 !== planned.mainSha256 || plan.thumbSha256 !== planned.thumbSha256) throw new RestoreRecheckError();
    return photo;
  } catch (error) {
    throwIfAborted(signal);
    if (isAborted(error) || error instanceof RestoreRecheckError) throw error;
    if (error instanceof ImagePreparationError && error.code === 'unavailable') throw new AppError('error.unavailable');
    throw new RestoreRecheckError();
  }
}
const sameReservation = (image: { mainBytes: number; thumbBytes: number; mainSha256: string; thumbSha256: string; width: number; height: number; altText: string },
  photo: PreparedPhoto, altText: string) => image.mainBytes === photo.main.size && image.thumbBytes === photo.thumb.size
  && image.mainSha256 === photo.mainSha256 && image.thumbSha256 === photo.thumbSha256 && image.width === photo.width
  && image.height === photo.height && image.altText === altText;

// Storage reports a missing object as 404 (in the status or in the body's statusCode).
const missingObject = (error: unknown) => isRecord(error)
  && (String(error.statusCode) === '404' || error.status === 404 || error.code === 'NoSuchKey');
// False only when the stored file is verified missing or different. A file that could not be read (network, 5xx, anything
// else) throws, so the item is retried and nothing that refers to it is written yet.
async function storedMatches(client: AppClient, image: StoredImage, signal: AbortSignal): Promise<boolean> {
  for (const [path, size, hash] of [[image.thumbPath, image.thumbBytes, image.thumbSha256], [image.mainPath, image.mainBytes, image.mainSha256]] as const) {
    const result = await client.storage.from('wardrobe').download(path, {}, { signal, cache: 'no-store' });
    throwIfAborted(signal);
    if (result.error) { if (missingObject(result.error)) return false; throw new AppError('error.unavailable'); }
    if (!result.data) throw new AppError('error.unavailable');
    if (result.data.size !== size) return false;
    if (await sha256Hex(new Uint8Array(await result.data.arrayBuffer())) !== hash) return false;
  }
  return true;
}

type RestoreStatus = { receipt: ReturnType<typeof parseImageChangeReceipt>; expectedVersion: number; currentImageId: string;
  descriptionVersion: number; image: Record<string, unknown> | null };
async function restoreStatus(client: AppClient, itemId: string, requestId: string, signal: AbortSignal): Promise<RestoreStatus | null> {
  const result = await client.rpc('restore_image_change_status', { p_item_id: itemId, p_request_id: requestId }).abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(result.error);
  if (result.data === null) return null;
  const value: unknown = result.data;
  if (!isRecord(value)) throw new AppError('error.conflict');
  const { expectedVersion, currentImageId, descriptionVersion, image, ...receipt } = value;
  if (typeof expectedVersion !== 'number' || typeof currentImageId !== 'string' || typeof descriptionVersion !== 'number'
    || image !== null && !isRecord(image)) throw new AppError('error.conflict');
  return { receipt: parseImageChangeReceipt(receipt, itemId, requestId), expectedVersion, currentImageId, descriptionVersion, image };
}

type SaveStatus = { itemId: string; imageId: string | null; state: string };
async function saveStatus(client: AppClient, itemId: string, signal: AbortSignal): Promise<SaveStatus | null> {
  const result = await client.rpc('restore_item_save_status', { p_item_id: itemId }).abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(result.error);
  const value: unknown = result.data;
  if (value === null) return null;
  if (!isRecord(value) || typeof value.itemId !== 'string' || value.imageId !== null && typeof value.imageId !== 'string'
    || typeof value.state !== 'string') throw new AppError('error.conflict');
  return { itemId: value.itemId, imageId: value.imageId, state: value.state };
}

// Every completed photo is checked before it is skipped: its stored files, and the checked save (photo 0) or the completed
// replacement request (later photos) that created it, with the item version that request expected.
async function verifyPrefix(client: AppClient, plan: ItemPlan, images: readonly StoredImage[], completed: number, signal: AbortSignal): Promise<boolean> {
  for (let index = 0; index <= completed; index++) {
    const image = images.find(entry => entry.id === plan.imageIds[index]);
    if (!image || !await storedMatches(client, image, signal)) return false;
    if (index === 0) {
      const saved = await saveStatus(client, plan.id, signal);
      if (!saved || saved.itemId !== plan.id || saved.imageId !== plan.imageIds[0] || saved.state !== 'completed') return false;
      continue;
    }
    const known = await restoreStatus(client, plan.id, plan.requestIds[index]!, signal);
    if (!known || known.receipt.state !== 'completed' || known.receipt.kind !== 'replacement' || known.receipt.imageId !== plan.imageIds[index]
      || known.currentImageId !== plan.imageIds[index - 1] || known.expectedVersion !== index || known.receipt.completedVersion !== index + 1) return false;
  }
  return true;
}

// One item: the checked Save for photo 0, then one replacement per later photo, resuming from the completed prefix.
// 'failed' can be retried; 'conflict' and 'trash' are final for this item, and nothing here is changed. 'blocked' is an
// item whose next photo was reserved with other files than this backup gives now: it is never overwritten or renamed.
type ItemOutcome = ItemStatus | 'failed' | 'blocked';
type PhotoReport = (index: number, outcome: 'written' | 'present', stored: { mainSha256: string; thumbSha256: string }) => void;
async function restoreItem(client: AppClient, scope: OwnerScope, photoSource: Photos, plan: ItemPlan, signal: AbortSignal,
  report: PhotoReport): Promise<ItemOutcome> {
  const photos = plan.source.photos;
  const read = async () => {
    const { rows, images } = await readTargets(client, scope, [plan.id], signal);
    const list = images.get(plan.id) ?? [];
    return { row: rows.get(plan.id), images: list, ...classify(plan, rows.get(plan.id), list) };
  };
  let state = await read();
  const initial = state.status;
  if (state.status === 'conflict' || state.status === 'trash') return state.status;
  let completed = state.chain.kind === 'resume' ? state.chain.completed : state.chain.kind === 'complete' ? photos.length - 1 : -1;
  if (completed >= 0 && !await verifyPrefix(client, plan, state.images, completed, signal)) return 'conflict';
  for (let index = 0; index <= completed; index++) {
    const image = state.images.find(entry => entry.id === plan.imageIds[index])!;
    report(index, 'present', { mainSha256: image.mainSha256, thumbSha256: image.thumbSha256 });
  }
  if (state.status === 'same') return 'same';
  const restored = restoredFields(plan.source);
  if (completed < 0) {
    const photo = await preparePhoto(photoSource, photos[0]!.sourceId, photos[0]!.width, photos[0]!.height, signal);
    const reserved = state.images.find(image => image.id === plan.imageIds[0]);
    if (reserved && (reserved.state !== 'pending' || !sameReservation(reserved, photo, photos[0]!.altText))) return 'blocked';
    const attempt: SaveAttempt = { itemId: plan.id, imageId: plan.imageIds[0]!, values: restored.values,
      payload: { ...restored.payload, field_provenance: restored.provenance }, altText: photos[0]!.altText, photo,
      ownerId: scope.ownerId, epoch: scope.epoch };
    await saveItem(client, { ...scope, signal }, attempt, () => undefined, 'reserve_restored_item_save');
    report(0, 'written', { mainSha256: photo.mainSha256, thumbSha256: photo.thumbSha256 });
    completed = 0;
  }
  const changes = new ImageChangeClient(client, { ...scope, signal });
  for (let index = completed + 1; index < photos.length; index++) {
    // The item must still be exactly as this restore left it: the restored values, the previous photo current, version index.
    state = await read();
    if (state.status === 'trash') return 'trash';
    if (state.status !== 'resume' || state.chain.kind !== 'resume' || state.chain.completed !== index - 1 || !state.row) return 'conflict';
    const photo = await preparePhoto(photoSource, photos[index]!.sourceId, photos[index]!.width, photos[index]!.height, signal);
    const requestId = plan.requestIds[index]!, imageId = plan.imageIds[index]!;
    const current = state.images.find(image => image.id === plan.imageIds[index - 1]);
    if (!current || current.state !== 'ready') return 'conflict';
    const known = await restoreStatus(client, plan.id, requestId, signal);
    if (known && (known.receipt.state === 'cancelled' || known.expectedVersion !== index || known.currentImageId !== current.id)) return 'conflict';
    const descriptionVersion = known ? known.descriptionVersion : current.descriptionVersion;
    const image = { id: imageId, main_bytes: photo.main.size, thumb_bytes: photo.thumb.size, main_sha256: photo.mainSha256,
      thumb_sha256: photo.thumbSha256, width: photo.width, height: photo.height, alt_text: photos[index]!.altText };
    // A reserved replacement is resumed only with the intent it was reserved with, down to the prepared bytes; otherwise the
    // item is blocked for this backup, not treated as an ordinary difference.
    if (known?.receipt.state === 'reserved' && (!known.image || known.image.state !== 'pending'
      || (['main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text'] as const).some(key => known.image![key] !== image[key]))) return 'blocked';
    const intent: ImageChangeIntent = { requestId, itemId: plan.id, imageId, expectedVersion: index, currentImageId: current.id, descriptionVersion,
      item: { ...restored.payload, field_provenance: parseFieldProvenance(state.row.field_provenance) as Json } as Record<string, Json>,
      image, claim: null, sourceImageId: null };
    const attempt: ImageChangeAttempt = { ownerId: scope.ownerId, epoch: scope.epoch, intent, photo };
    const receipt = await changes.save(attempt, () => undefined, () => undefined, signal);
    if (receipt.state === 'cancelled') return 'conflict';
    if (receipt.state !== 'completed') return 'failed';
    report(index, 'written', { mainSha256: photo.mainSha256, thumbSha256: photo.thumbSha256 });
  }
  return initial === 'new' ? 'new' : 'resume';
}

export type RestoreProgress = { done: number; total: number };
// Items one at a time, then outfits, rules, feedback and history. A lost reply is followed by one fresh read and a
// resume; anything still unconfirmed is counted as not restored, and running the restore again continues from there.
// Nothing that refers to an item still to be retried is written yet, so a later run writes it once, complete.
export async function runRestore(client: AppClient, scope: OwnerScope, preview: RestorePreview, signal: AbortSignal,
  onProgress: (progress: RestoreProgress) => void): Promise<RestoreResult> {
  if (preview.ownerId !== scope.ownerId || preview.epoch !== scope.epoch) throw new AppError('error.conflict');
  const result: RestoreResult = { restored: 0, same: 0, conflicts: 0, trash: 0, failed: 0, blocked: 0, deferred: 0,
    outfits: 0, outfitConflicts: 0, history: 0, historyConflicts: 0, photos: [] };
  throwIfAborted(scope.signal);
  const entry = { result };
  lastReport = entry;
  scope.signal.addEventListener('abort', () => { if (lastReport === entry) lastReport = null; }, { once: true });
  const reached = new Set<ItemPlan>();
  try { return await restoreAll(client, scope, preview, signal, onProgress, result, reached); }
  finally {
    // A run that stopped early still reports every photo: those of items it never reached were not written.
    for (const plan of preview.items) if (!reached.has(plan)) recordPhotos(result, preview, plan, new Map(), 'skipped');
  }
}

function recordPhotos(result: RestoreResult, preview: RestorePreview, plan: ItemPlan,
  done: ReadonlyMap<number, Pick<PhotoOutcome, 'outcome' | 'stored'>>, rest: 'failed' | 'blocked' | 'skipped') {
  for (const [index, photo] of plan.source.photos.entries()) {
    const planned = preview.photos.get(photo.sourceId)!;
    result.photos.push({ sourceImageId: photo.sourceId, planned: { main: planned.main, reason: planned.reason, sourceSha256: planned.sourceSha256,
      mainSha256: planned.mainSha256, thumbSha256: planned.thumbSha256 }, ...done.get(index) ?? { outcome: rest, stored: null } });
  }
}

async function restoreAll(client: AppClient, scope: OwnerScope, preview: RestorePreview, signal: AbortSignal,
  onProgress: (progress: RestoreProgress) => void, result: RestoreResult, reached: Set<ItemPlan>): Promise<RestoreResult> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const { backup } = preview, { data } = backup;
  const photoSource: Photos = { backup, plans: preview.photos, deps: preview.deps };
  const available = new Map<string, string>();
  // Items that may still be restored by running again, or are blocked. Anything that refers to one waits, so its deterministic
  // ID is only ever written with its final contents; excluded items (different here, in Trash) are left out for good.
  const retry = new Set<string>();
  const total = preview.items.length;
  onProgress({ done: 0, total });
  for (const [position, plan] of preview.items.entries()) {
    let outcome: ItemOutcome = 'failed';
    const done = new Map<number, Pick<PhotoOutcome, 'outcome' | 'stored'>>();
    const report: PhotoReport = (index, kind, stored) => {
      // A photo written by the first attempt stays written when the second attempt finds it in place.
      if (done.get(index)?.outcome !== 'written') done.set(index, { outcome: kind, stored });
    };
    reached.add(plan);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { outcome = await restoreItem(client, scope, photoSource, plan, lifetime, report); break; }
      catch (error) {
        // A photo that changed or failed its checks since Check stops everything: it is not an item to retry.
        if (lifetime.aborted || isAborted(error) || error instanceof RestoreRecheckError) {
          recordPhotos(result, preview, plan, done, 'failed');
          throw error;
        }
        outcome = 'failed';
      }
    }
    if (outcome === 'new' || outcome === 'resume') result.restored++;
    else if (outcome === 'same') result.same++;
    else if (outcome === 'conflict') result.conflicts++;
    else if (outcome === 'trash') result.trash++;
    else if (outcome === 'blocked') { result.blocked++; retry.add(plan.source.sourceId); }
    else { result.failed++; retry.add(plan.source.sourceId); }
    recordPhotos(result, preview, plan, done, outcome === 'failed' ? 'failed' : outcome === 'blocked' ? 'blocked' : 'skipped');
    if (outcome === 'new' || outcome === 'resume' || outcome === 'same') available.set(plan.source.sourceId, plan.id);
    onProgress({ done: position + 1, total });
  }
  const waits = (ids: readonly (string | null)[]) => ids.some(id => id !== null && retry.has(id));
  const restoredOutfits = new Map<string, string>(), heldOutfits = new Set<string>();
  for (const [index, outfit] of data.outfits.entries()) {
    if (waits(outfit.itemIds)) { result.deferred++; heldOutfits.add(outfit.sourceId); continue; }
    const itemIds = outfit.itemIds.flatMap(id => available.has(id) ? [available.get(id)!] : []);
    if (!itemIds.length) continue;
    const saved = await client.rpc('save_outfit', { p_id: preview.ids.outfits[index]!, p_title: outfit.title, p_occasion: outfit.occasion,
      p_notes: outfit.notes, p_favourite: outfit.favourite, p_item_ids: itemIds }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (!saved.error) { result.outfits++; restoredOutfits.set(outfit.sourceId, preview.ids.outfits[index]!); }
    else if (conflictError(saved.error)) result.outfitConflicts++;
    else { result.failed++; heldOutfits.add(outfit.sourceId); }
  }
  for (const rule of data.rules) {
    if (waits([rule.low, rule.high])) { result.deferred++; continue; }
    if (!available.has(rule.low) || !available.has(rule.high)) continue;
    const [low, high] = [available.get(rule.low)!, available.get(rule.high)!].sort() as [string, string];
    const saved = await client.from('combination_rules').upsert({ owner_id: scope.ownerId, item_low: low, item_high: high },
      { onConflict: 'owner_id,item_low,item_high', ignoreDuplicates: true }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (saved.error) result.failed++;
  }
  for (const entry of data.feedback) {
    if (waits(entry.itemIds)) { result.deferred++; continue; }
    if (!entry.itemIds.every(id => available.has(id))) continue;
    const saved = await client.from('suggestion_feedback').upsert({ owner_id: scope.ownerId,
      item_ids: entry.itemIds.map(id => available.get(id)!).sort(), vote: entry.vote },
    { onConflict: 'owner_id,signature', ignoreDuplicates: true }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (saved.error) result.failed++;
  }
  for (const [index, event] of data.events.entries()) {
    if (event.outfitId !== null && heldOutfits.has(event.outfitId) || waits(event.entries.map(entry => entry.itemId))) { result.deferred++; continue; }
    const id = preview.ids.events[index]!;
    const outfitId = event.outfitId === null ? null : restoredOutfits.get(event.outfitId) ?? null;
    const row = { id, owner_id: scope.ownerId, outfit_id: outfitId, local_date: event.localDate, timezone: event.timezone,
      state: event.state, label: event.label };
    const inserted = await client.from('wear_events').insert(row).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (inserted.error) {
      if (!isRecord(inserted.error) || inserted.error.code !== '23505') { result.failed++; continue; }
      const existing = await client.from('wear_events').select('id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at')
        .eq('owner_id', scope.ownerId).eq('id', id).abortSignal(lifetime);
      throwIfAborted(lifetime);
      if (existing.error) { result.failed++; continue; }
      const found: unknown = existing.data?.[0];
      // Changed or deleted here since the last run: left as it is.
      if (!isRecord(found) || found.deleted_at !== null
        || (['outfit_id', 'local_date', 'timezone', 'state', 'label'] as const).some(key => found[key] !== row[key])) { result.historyConflicts++; continue; }
    }
    let failed = false, conflicted = false;
    for (const [position, entry] of event.entries.entries()) {
      const restored = await client.rpc('restore_history_entry', { p_id: preview.ids.entries[index]![position]!, p_event_id: id,
        // Generated types mark every argument as a string; the function keeps the text without an item link.
        p_item_id: (entry.itemId === null ? null : available.get(entry.itemId) ?? null) as string, p_title: entry.title, p_category: entry.category,
        p_import_id: data.exportId }).abortSignal(lifetime);
      throwIfAborted(lifetime);
      if (restored.error) { if (conflictError(restored.error)) conflicted = true; else failed = true; }
    }
    if (failed) result.failed++;
    else if (conflicted) result.historyConflicts++;
    else result.history++;
  }
  return result;
}
