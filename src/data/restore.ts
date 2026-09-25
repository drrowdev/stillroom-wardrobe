// Restore (I20/I21, P6b): adds a backup's saved wardrobe to the signed-in account. Only owner-scoped reads and the
// existing checked write paths are used; nothing is overwritten or deleted, and no analysis is ever requested.
import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import type { Json } from './database.types';
import { AppError, isAborted, requireSuccess, throwIfAborted } from './errors';
import { BackupFormatError, sha256Hex, type JpegCheck, type PartSource } from '../domain/export-format';
import {
  chainState, missingPart, readBackup, restoreId, selectBackupFiles,
  type ChainImage, type ChainState, type ReadBackup, type RestoreItem,
} from '../domain/restore-plan';
import { parseFieldProvenance, type FieldProvenance } from '../domain/attribute-provenance';
import { garmentPayload, parseGarmentValues } from '../domain/garment-fields';
import { itemDetailColumns } from '../domain/item-details';
import { parseImageChangeReceipt, type ImageChangeAttempt, type ImageChangeIntent } from '../domain/image-replacement';
import { isRecord } from '../domain/wardrobe';
import { readJpegHeader, JPEG_LIMITS } from '../images/jpeg';
import { prepareImage } from '../images/process-image';
import { ORIGINAL_EDIT } from '../images/crop';
import type { PreparedPhoto } from '../images/process-jpeg';
import { ImageChangeClient } from '../images/replace';
import { saveItem, type SaveAttempt } from '../images/upload';

// Header-only check while reading: the photo is decoded and encoded again before anything is uploaded.
const checkJpeg: JpegCheck = (bytes, variant, width, height) => {
  try {
    const header = readJpegHeader(bytes);
    if (variant === 'main' ? header.width !== width || header.height !== height || bytes.length > JPEG_LIMITS.mainBytes
      : header.width > JPEG_LIMITS.thumbSide || header.height > JPEG_LIMITS.thumbSide || bytes.length > JPEG_LIMITS.thumbBytes) throw new Error('size');
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
  counts: { add: number; same: number; conflicts: number; trash: number; outfits: number };
  ids: { outfits: string[]; events: string[]; entries: string[][] };
};
export type RestoreResult = { restored: number; same: number; conflicts: number; trash: number; failed: number;
  outfits: number; outfitConflicts: number; history: number };

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

function classify(plan: Omit<ItemPlan, 'status'>, row: Record<string, unknown> | undefined, images: readonly ChainImage[]): { status: ItemStatus; chain: ChainState } {
  const targets = plan.source.photos.map((photo, index) => ({ imageId: plan.imageIds[index]!, altText: photo.altText, width: photo.width, height: photo.height }));
  if (!row) return { status: images.length ? 'conflict' : 'new', chain: images.length ? { kind: 'conflict' } : { kind: 'new' } };
  if (row.deleted_at !== null) return { status: 'trash', chain: { kind: 'conflict' } };
  const chain = chainState(targets, images);
  return { status: chain.kind === 'complete' ? 'same' : chain.kind === 'resume' ? 'resume' : 'conflict', chain };
}

// Reads and checks the backup, then compares it with this account using owner-scoped reads only. Nothing is written.
export async function checkBackup(client: AppClient, scope: OwnerScope, files: readonly File[], passphrase: string,
  signal: AbortSignal): Promise<RestorePreview> {
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
  const map = (table: string, id: string) => restoreId(data.version, uid, data.exportId, table, id);
  const base = await Promise.all(data.items.map(async (source) => ({ source, id: await map('items', source.sourceId),
    imageIds: await Promise.all(source.photos.map(photo => map('item_images', photo.sourceId))),
    requestIds: await Promise.all(source.photos.map((_, index) => map('photo-request', `${source.sourceId}#${index}`))) })));
  const { rows, images } = await readTargets(client, scope, base.map(item => item.id), lifetime);
  const items = base.map(plan => ({ ...plan, status: classify(plan, rows.get(plan.id), images.get(plan.id) ?? []).status }));
  const available = new Set(items.filter(item => item.status !== 'conflict' && item.status !== 'trash').map(item => item.source.sourceId));
  const count = (status: ItemStatus) => items.filter(item => item.status === status).length;
  const ids = {
    outfits: await Promise.all(data.outfits.map(outfit => map('outfits', outfit.sourceId))),
    events: await Promise.all(data.events.map(event => map('wear_events', event.sourceId))),
    entries: await Promise.all(data.events.map(event => Promise.all(event.entries.map(entry => map('wear_event_items', entry.sourceId))))),
  };
  throwIfAborted(lifetime);
  return { ownerId: uid, epoch: scope.epoch, backup, items, otherAccount: data.sourceOwner !== uid, ids,
    counts: { add: count('new') + count('resume'), same: count('same'), conflicts: count('conflict'), trash: count('trash'),
      outfits: data.outfits.filter(outfit => outfit.itemIds.some(id => available.has(id))).length } };
}

const conflictError = (error: unknown) => isRecord(error) && error.message === 'Request conflict' && (error.code === 'P0001' || error.code === '22023');

async function preparePhoto(backup: ReadBackup, sourceImageId: string, signal: AbortSignal): Promise<PreparedPhoto> {
  const bytes = await backup.read(sourceImageId, 'main');
  throwIfAborted(signal);
  // The original bytes were checked against the backup; they are decoded and encoded again, with a new thumbnail.
  return prepareImage(new Blob([bytes], { type: 'image/jpeg' }), signal, ORIGINAL_EDIT);
}

async function storedMatches(client: AppClient, image: StoredImage, signal: AbortSignal): Promise<boolean> {
  for (const [path, size, hash] of [[image.thumbPath, image.thumbBytes, image.thumbSha256], [image.mainPath, image.mainBytes, image.mainSha256]] as const) {
    const result = await client.storage.from('wardrobe').download(path, {}, { signal, cache: 'no-store' });
    throwIfAborted(signal);
    if (result.error || !result.data || result.data.size !== size) return false;
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

// One item: the checked Save for photo 0, then one replacement per later photo, resuming from the completed prefix.
async function restoreItem(client: AppClient, scope: OwnerScope, backup: ReadBackup, plan: ItemPlan, signal: AbortSignal): Promise<ItemStatus | 'failed'> {
  const photos = plan.source.photos;
  const read = async () => {
    const { rows, images } = await readTargets(client, scope, [plan.id], signal);
    const list = images.get(plan.id) ?? [];
    return { row: rows.get(plan.id), images: list, ...classify(plan, rows.get(plan.id), list) };
  };
  let state = await read();
  const initial = state.status;
  if (state.status === 'conflict' || state.status === 'trash') return state.status;
  if (state.status === 'same') return 'same';
  let completed = state.chain.kind === 'resume' ? state.chain.completed : -1;
  if (completed < 0) {
    const values = parseGarmentValues(plan.source.row);
    const payload = garmentPayload(values);
    const kinds = plan.source.kinds;
    const field_provenance: FieldProvenance = {};
    for (const [field, kind] of Object.entries(kinds)) {
      const value = (payload as Record<string, unknown>)[field];
      if (value === null || value === '' || Array.isArray(value) && value.length === 0) continue;
      (field_provenance as Record<string, unknown>)[field] = { kind, revision: 1 };
    }
    const photo = await preparePhoto(backup, photos[0]!.sourceId, signal);
    const attempt: SaveAttempt = { itemId: plan.id, imageId: plan.imageIds[0]!, values, payload: { ...payload, field_provenance },
      altText: photos[0]!.altText, photo, ownerId: scope.ownerId, epoch: scope.epoch };
    await saveItem(client, { ...scope, signal }, attempt, () => undefined, 'reserve_restored_item_save');
    completed = 0;
  } else {
    // Checked-save verification of the latest completed photo: it is the current photo and its stored files match it.
    const current = state.images.find(image => image.id === plan.imageIds[completed])!;
    if (!await storedMatches(client, current, signal)) return 'failed';
  }
  const changes = new ImageChangeClient(client, { ...scope, signal });
  for (let index = completed + 1; index < photos.length; index++) {
    state = await read();
    if (!state.row || state.status === 'conflict' || state.status === 'trash') return 'failed';
    const photo = await preparePhoto(backup, photos[index]!.sourceId, signal);
    const requestId = plan.requestIds[index]!, imageId = plan.imageIds[index]!;
    const known = await restoreStatus(client, plan.id, requestId, signal);
    if (known && known.receipt.state === 'cancelled') return 'failed';
    const row = state.row, current = state.images.find(image => image.id === plan.imageIds[index - 1]);
    if (!current || current.state !== 'ready') return 'failed';
    const expectedVersion = known ? known.expectedVersion : Number(row.version);
    const currentImageId = known ? known.currentImageId : current.id;
    const descriptionVersion = known ? known.descriptionVersion : current.descriptionVersion;
    const image = { id: imageId, main_bytes: photo.main.size, thumb_bytes: photo.thumb.size, main_sha256: photo.mainSha256,
      thumb_sha256: photo.thumbSha256, width: photo.width, height: photo.height, alt_text: photos[index]!.altText };
    // A reserved replacement is resumed only with the intent it was reserved with, down to the prepared bytes.
    if (known?.receipt.state === 'reserved' && (!known.image || known.image.state !== 'pending' || currentImageId !== current.id
      || Number(row.version) !== expectedVersion
      || (['main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text'] as const).some(key => known.image![key] !== image[key]))) return 'failed';
    const provenance = parseFieldProvenance(row.field_provenance);
    const intent: ImageChangeIntent = { requestId, itemId: plan.id, imageId, expectedVersion, currentImageId, descriptionVersion,
      item: { ...garmentPayload(parseGarmentValues(row)), field_provenance: provenance as Json } as Record<string, Json>,
      image, claim: null, sourceImageId: null };
    const attempt: ImageChangeAttempt = { ownerId: scope.ownerId, epoch: scope.epoch, intent, photo };
    const receipt = await changes.save(attempt, () => undefined, () => undefined, signal);
    if (receipt.state !== 'completed') return 'failed';
  }
  return initial === 'new' ? 'new' : 'resume';
}

export type RestoreProgress = { done: number; total: number };
// Items one at a time, then outfits, rules, feedback and history. A lost reply is followed by one fresh read and a
// resume; anything still unconfirmed is counted as not restored, and running the restore again continues from there.
export async function runRestore(client: AppClient, scope: OwnerScope, preview: RestorePreview, signal: AbortSignal,
  onProgress: (progress: RestoreProgress) => void): Promise<RestoreResult> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  if (preview.ownerId !== scope.ownerId || preview.epoch !== scope.epoch) throw new AppError('error.conflict');
  const { backup } = preview, { data } = backup;
  const result: RestoreResult = { restored: 0, same: 0, conflicts: 0, trash: 0, failed: 0, outfits: 0, outfitConflicts: 0, history: 0 };
  const available = new Map<string, string>();
  const total = preview.items.length;
  onProgress({ done: 0, total });
  for (const [position, plan] of preview.items.entries()) {
    let outcome: ItemStatus | 'failed' = 'failed';
    for (let attempt = 0; attempt < 2; attempt++) {
      try { outcome = await restoreItem(client, scope, backup, plan, lifetime); break; }
      catch (error) {
        if (lifetime.aborted || isAborted(error)) throw error;
        outcome = 'failed';
      }
    }
    if (outcome === 'new' || outcome === 'resume') result.restored++;
    else if (outcome === 'same') result.same++;
    else if (outcome === 'conflict') result.conflicts++;
    else if (outcome === 'trash') result.trash++;
    else result.failed++;
    if (outcome === 'new' || outcome === 'resume' || outcome === 'same') available.set(plan.source.sourceId, plan.id);
    onProgress({ done: position + 1, total });
  }
  const restoredOutfits = new Map<string, string>();
  for (const [index, outfit] of data.outfits.entries()) {
    const itemIds = outfit.itemIds.flatMap(id => available.has(id) ? [available.get(id)!] : []);
    if (!itemIds.length) continue;
    const saved = await client.rpc('save_outfit', { p_id: preview.ids.outfits[index]!, p_title: outfit.title, p_occasion: outfit.occasion,
      p_notes: outfit.notes, p_favourite: outfit.favourite, p_item_ids: itemIds }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (!saved.error) { result.outfits++; restoredOutfits.set(outfit.sourceId, preview.ids.outfits[index]!); }
    else if (conflictError(saved.error)) result.outfitConflicts++;
    else result.failed++;
  }
  const rules = data.rules.flatMap(rule => available.has(rule.low) && available.has(rule.high)
    ? [[available.get(rule.low)!, available.get(rule.high)!].sort() as [string, string]] : []);
  for (const [low, high] of rules) {
    const saved = await client.from('combination_rules').upsert({ owner_id: scope.ownerId, item_low: low, item_high: high },
      { onConflict: 'owner_id,item_low,item_high', ignoreDuplicates: true }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (saved.error) result.failed++;
  }
  for (const entry of data.feedback) {
    if (!entry.itemIds.every(id => available.has(id))) continue;
    const saved = await client.from('suggestion_feedback').upsert({ owner_id: scope.ownerId,
      item_ids: entry.itemIds.map(id => available.get(id)!).sort(), vote: entry.vote },
    { onConflict: 'owner_id,signature', ignoreDuplicates: true }).abortSignal(lifetime);
    throwIfAborted(lifetime);
    if (saved.error) result.failed++;
  }
  for (const [index, event] of data.events.entries()) {
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
      const found: unknown = existing.data?.[0];
      if (existing.error || !isRecord(found) || found.deleted_at !== null
        || (['outfit_id', 'local_date', 'timezone', 'state', 'label'] as const).some(key => found[key] !== row[key])) { result.failed++; continue; }
    }
    let complete = true;
    for (const [position, entry] of event.entries.entries()) {
      const restored = await client.rpc('restore_history_entry', { p_id: preview.ids.entries[index]![position]!, p_event_id: id,
        // Generated types mark every argument as a string; the function keeps the text without an item link.
        p_item_id: (entry.itemId === null ? null : available.get(entry.itemId) ?? null) as string, p_title: entry.title, p_category: entry.category,
        p_import_id: data.exportId }).abortSignal(lifetime);
      throwIfAborted(lifetime);
      if (restored.error) complete = false;
    }
    if (complete) result.history++;
    else result.failed++;
  }
  return result;
}
