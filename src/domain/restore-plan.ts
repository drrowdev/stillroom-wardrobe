// Restore reading and planning (I20/I21). Pure: no Supabase access. Reads version 2 backups (the app) and version 1 backups
// (the reference exporter), checks every photo's original bytes before anything is converted, and describes the saved
// wardrobe under deterministic IDs for the signed-in account.
import {
  BACKUP_LIMITS, BackupFormatError, canonical, decryptPart, fromBase64, planParts, projectSaved, rawColumns, savedItemIds, sha256Hex, verifyBackup,
  type ExportPart, type FileRef, type JpegCheck, type PartSource, type RawManifest, type RawTable, type SavedMetadata,
} from './export-format';
import { provenanceFields, provenanceKinds, type ProvenanceField, type ProvenanceKind } from './attribute-provenance';

type Row = Record<string, unknown>;
const fail = (problem: 'tooLarge' | 'invalid' | 'incomplete' = 'invalid'): never => { throw new BackupFormatError(problem); };
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

// ---- File selection: checked on names and sizes only, before any file is read. ----
export type SelectedFile = { name: string; size: number };
export type Selection = { exportId: string; indices: number[] };
const partName = /^stillroom-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(0|[1-9][0-9]{0,2})\.json\.enc$/;
export function selectBackupFiles(files: readonly SelectedFile[]): Selection {
  if (files.length === 0) fail('incomplete');
  if (files.length > BACKUP_LIMITS.parts) fail('tooLarge');
  let exportId: string | null = null, total = 0;
  const indices: number[] = [];
  for (const file of files) {
    const match = partName.exec(file.name);
    if (!match || !Number.isSafeInteger(file.size) || file.size < 0) return fail();
    if (exportId !== null && match[1] !== exportId) fail();
    exportId = match[1]!;
    const index = Number(match[2]);
    if (indices.includes(index)) fail();
    if (file.size > BACKUP_LIMITS.encryptedPartBytes) fail('tooLarge');
    total += file.size;
    indices.push(index);
  }
  // The encrypted total covers base64 photos twice plus metadata; the decoded photo limit is checked while verifying.
  if (total > BACKUP_LIMITS.totalEncryptedBytes) fail('tooLarge');
  return { exportId: exportId!, indices };
}
// The first missing part, given the part count read from part 0; null when complete.
export function missingPart(indices: readonly number[], count: number): number | null {
  for (let index = 0; index < count; index++) if (!indices.includes(index)) return index;
  return indices.some(index => index >= count) ? fail() : null;
}

// ---- Deterministic IDs: UUIDv8 from SHA-256, bound to the format version, target account and backup. ----
export async function restoreId(version: 1 | 2, targetUid: string, exportId: string, table: string, sourceId: string): Promise<string> {
  const hex = await sha256Hex(`stillroom/restore/v${version}|${targetUid}|${exportId}|${table}|${sourceId}`);
  const bytes = hex.slice(0, 32).match(/../g)!.map(pair => parseInt(pair, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

// ---- The saved wardrobe, as restore uses it. ----
export type PhotoFile = { sha256: string; byteLength: number };
export type RestorePhoto = { sourceId: string; state: 'ready' | 'retired'; altText: string; width: number; height: number; main: PhotoFile; thumb: PhotoFile };
export type RestoreItem = { sourceId: string; row: Row; kinds: Partial<Record<ProvenanceField, ProvenanceKind>>; photos: RestorePhoto[] };
export type RestoreOutfit = { sourceId: string; title: string; occasion: string; notes: string; favourite: boolean; itemIds: string[] };
export type RestoreEntry = { sourceId: string; itemId: string | null; title: string; category: string };
export type RestoreEvent = { sourceId: string; outfitId: string | null; localDate: string; timezone: string; state: string; label: string; entries: RestoreEntry[] };
export type RestoreData = {
  version: 1 | 2; exportId: string; sourceOwner: string; createdAt: string;
  items: RestoreItem[]; outfits: RestoreOutfit[]; events: RestoreEvent[];
  rules: Array<{ low: string; high: string }>; feedback: Array<{ itemIds: string[]; vote: number }>;
  // Tag history (model, prompt and source photo hash) is read but not restored yet.
  attributions: number;
};
const aiEstimated: readonly string[] = ['material', 'seasons', 'formality', 'style_tags'];
const aiObserved: readonly string[] = ['category', 'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length',
  'brand', 'size_label', 'upper_coverage', 'lower_coverage'];
const empty = (value: unknown) => value === null || value === undefined || value === '' || Array.isArray(value) && value.length === 0;
// Kinds are kept, revisions start again at 1. A non-empty value without a kind becomes unknown, and an AI kind is kept only
// on a non-empty field the analyzer can fill; otherwise it becomes unknown. Empty fields carry no kind.
export function restoredKinds(row: Row): Partial<Record<ProvenanceField, ProvenanceKind>> {
  const source = isObject(row.field_provenance) ? row.field_provenance : {};
  const kinds: Partial<Record<ProvenanceField, ProvenanceKind>> = {};
  for (const field of provenanceFields) {
    if (empty(row[field])) continue;
    const entry = source[field];
    let kind: ProvenanceKind = isObject(entry) && provenanceKinds.some(value => value === entry.kind) ? entry.kind as ProvenanceKind : 'unknown';
    if (kind === 'ai_estimated' && !aiEstimated.includes(field) || kind === 'ai_observed' && !aiObserved.includes(field)) kind = 'unknown';
    kinds[field] = kind;
  }
  return kinds;
}
const byRetired = (a: Row, b: Row) => String(a.retired_at) < String(b.retired_at) ? -1 : String(a.retired_at) > String(b.retired_at) ? 1
  : String(a.id) < String(b.id) ? -1 : 1;
function photoOf(image: Row): RestorePhoto {
  return { sourceId: String(image.id), state: image.state === 'ready' ? 'ready' : 'retired', altText: String(image.alt_text),
    width: Number(image.width), height: Number(image.height),
    main: { sha256: String(image.main_sha256), byteLength: Number(image.main_bytes) },
    thumb: { sha256: String(image.thumb_sha256), byteLength: Number(image.thumb_bytes) } };
}
export function describeSaved(metadata: SavedMetadata, version: 1 | 2): RestoreData {
  const t = metadata.tables;
  const items = t.items.map((row): RestoreItem => {
    const own = t.item_images.filter(image => image.item_id === row.id);
    // Oldest first: retired photos in the order they were replaced, the current photo last.
    const photos = [...own.filter(image => image.state === 'retired').sort(byRetired), ...own.filter(image => image.state === 'ready')].map(photoOf);
    return { sourceId: String(row.id), row, kinds: restoredKinds(row), photos };
  });
  const outfits = t.outfits.map((row): RestoreOutfit => ({ sourceId: String(row.id), title: String(row.title), occasion: String(row.occasion),
    notes: String(row.notes), favourite: row.favourite === true,
    itemIds: t.outfit_items.filter(link => link.outfit_id === row.id).sort((a, b) => Number(a.position) - Number(b.position)).map(link => String(link.item_id)) }));
  const events = t.wear_events.map((row): RestoreEvent => ({ sourceId: String(row.id), outfitId: row.outfit_id === null ? null : String(row.outfit_id),
    localDate: String(row.local_date), timezone: String(row.timezone), state: String(row.state), label: String(row.label),
    entries: t.wear_event_items.filter(link => link.event_id === row.id).map(link => ({ sourceId: String(link.id),
      itemId: link.item_id === null ? null : String(link.item_id), title: String(link.title_snapshot), category: String(link.category_snapshot) })) }));
  return { version, exportId: metadata.export_id, sourceOwner: metadata.owner_id, createdAt: metadata.created_at, items, outfits, events,
    rules: t.combination_rules.map(rule => ({ low: String(rule.item_low), high: String(rule.item_high) })),
    feedback: t.suggestion_feedback.map(entry => ({ itemIds: (entry.item_ids as unknown[]).map(String), vote: Number(entry.vote) })),
    attributions: t.item_attributions.length };
}

// ---- Reading a backup. ----
export type PhotoReader = (imageId: string, variant: 'main' | 'thumb') => Promise<Uint8Array<ArrayBuffer>>;
export type ReadBackup = { data: RestoreData; parts: number; photos: number; fileBytes: number; read: PhotoReader };

// Re-reads the part that holds a photo when it is needed, keeping one decrypted part, and checks its hash again.
function photoReader(source: PartSource, passphrase: string, version: 1 | 2, exportId: string, count: number,
  locate: ReadonlyMap<string, { part: number; ref: FileRef }>): PhotoReader {
  let cached: { index: number; part: ExportPart } | null = null;
  return async (imageId, variant) => {
    const place = locate.get(`${imageId}|${variant}`);
    if (!place) return fail();
    if (cached?.index !== place.part) {
      cached = null;
      const part = await decryptPart(await source.read(place.part), passphrase, version);
      if (part.exportId !== exportId || part.partIndex !== place.part || part.partCount !== count) fail();
      cached = { index: place.part, part };
    }
    const file = cached.part.files.find(entry => isObject(entry) && entry.imageId === imageId && entry.variant === variant);
    if (!file) return fail('incomplete');
    const bytes = fromBase64(file.base64, place.ref.byteLength);
    if (bytes.length !== place.ref.byteLength || await sha256Hex(bytes) !== place.ref.sha256) fail();
    return bytes;
  };
}

export async function readBackupV2(source: PartSource, passphrase: string, checkJpeg: JpegCheck): Promise<ReadBackup> {
  const summary = await verifyBackup(source, passphrase, checkJpeg);
  const locate = new Map<string, { part: number; ref: FileRef }>();
  planParts(summary.metadata).forEach((refs, index) => { for (const ref of refs) locate.set(`${ref.imageId}|${ref.variant}`, { part: index + 1, ref }); });
  return { data: describeSaved(summary.metadata, 2), parts: summary.parts, photos: summary.photos, fileBytes: summary.fileBytes,
    read: photoReader(source, passphrase, 2, summary.exportId, summary.parts, locate) };
}

// Version 1 manifests predate some columns: a missing column takes its later default, an unknown table or column is refused.
const v1Defaults: Partial<Record<RawTable, Row>> = {
  profiles: { weather_enabled: false, weather_city: null, latitude: null, longitude: null },
  items: { pattern: null, sleeve_length: null, garment_length: null, field_provenance: {} },
  item_images: { description_version: 1 },
};
export function normalizeV1Manifest(value: unknown, exportId: string): RawManifest {
  if (!isObject(value) || value.export_id !== exportId || !isUuid(value.owner_id) || !isObject(value.tables)) return fail();
  const owner = value.owner_id;
  const tables = {} as Record<RawTable, Row[]>;
  for (const key of Object.keys(value.tables)) if (!Object.hasOwn(rawColumns, key)) fail();
  for (const table of Object.keys(rawColumns) as RawTable[]) {
    const rows = value.tables[table] ?? [];
    if (!Array.isArray(rows) || rows.length > BACKUP_LIMITS.rowsPerTable) return fail();
    const columns: readonly string[] = rawColumns[table];
    tables[table] = rows.map((row: unknown) => {
      if (!isObject(row) || row.owner_id !== owner || Object.keys(row).some(key => !columns.includes(key))) return fail();
      return Object.fromEntries(columns.map(column => [column, Object.hasOwn(row, column) ? row[column]
        : Object.hasOwn(v1Defaults[table] ?? {}, column) ? v1Defaults[table]![column] : column === 'created_at' || column === 'updated_at'
          ? String(value.created_at ?? '1970-01-01T00:00:00Z') : null]));
    });
  }
  if (tables.item_images.some(image => image.state === 'pending')) fail();
  const createdAt = typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)) ? value.created_at : '1970-01-01T00:00:00Z';
  return { export_id: exportId, owner_id: owner, created_at: createdAt, tables };
}

export async function readBackupV1(source: PartSource, passphrase: string, checkJpeg: JpegCheck): Promise<ReadBackup> {
  if (!Number.isSafeInteger(source.count) || source.count < 1 || source.count > BACKUP_LIMITS.parts) fail('incomplete');
  const head = await decryptPart(await source.read(0), passphrase, 1);
  if (head.partIndex !== 0 || !Object.hasOwn(head, 'manifest') || source.exportId !== undefined && head.exportId !== source.exportId) fail();
  if (head.partCount !== source.count) fail('incomplete');
  const manifest: unknown = head.manifest;
  const text = canonical(manifest);
  if (new TextEncoder().encode(text).length > BACKUP_LIMITS.metadataBytes) fail('tooLarge');
  // The hash is checked on the manifest exactly as it was written, before any column is filled in.
  if (await sha256Hex(text) !== head.manifestSha256) fail();
  const raw = normalizeV1Manifest(manifest, head.exportId);
  // Version 1 order: manifest image order, main then thumb, 12 MiB per part, starting in part 0.
  const batches: FileRef[][] = [[]];
  let size = 0;
  for (const image of raw.tables.item_images) for (const variant of ['main', 'thumb'] as const) {
    const length = Number(image[`${variant}_bytes`]);
    if (size + length > BACKUP_LIMITS.partFileBytes) { batches.push([]); size = 0; }
    batches.at(-1)!.push({ imageId: String(image.id), variant, path: String(image[`${variant}_path`]),
      sha256: String(image[`${variant}_sha256`]), byteLength: length });
    size += length;
  }
  if (batches.length !== head.partCount) fail('incomplete');
  const images = new Map(raw.tables.item_images.map(image => [String(image.id), image]));
  const locate = new Map<string, { part: number; ref: FileRef }>();
  let fileBytes = 0;
  for (let index = 0; index < head.partCount; index++) {
    const part = index === 0 ? head : await decryptPart(await source.read(index), passphrase, 1);
    if (part.exportId !== head.exportId || part.partCount !== head.partCount || part.manifestSha256 !== head.manifestSha256
      || part.partIndex !== index || index > 0 && Object.hasOwn(part, 'manifest')) fail();
    const expected = batches[index]!;
    if (part.files.length !== expected.length) fail('incomplete');
    for (let position = 0; position < expected.length; position++) {
      const file: unknown = part.files[position], ref = expected[position]!;
      if (!isObject(file) || file.imageId !== ref.imageId || file.variant !== ref.variant || file.sha256 !== ref.sha256
        || file.byteLength !== ref.byteLength || file.mime !== 'image/jpeg') fail('incomplete');
      if (fileBytes + ref.byteLength > BACKUP_LIMITS.totalFileBytes) fail('tooLarge');
      const bytes = fromBase64((file as Row).base64, ref.byteLength);
      if (bytes.length !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) fail();
      const image = images.get(ref.imageId)!;
      checkJpeg(bytes, ref.variant, Number(image.width), Number(image.height));
      fileBytes += bytes.length;
      locate.set(`${ref.imageId}|${ref.variant}`, { part: index, ref });
    }
  }
  // Same saved-only rules as the app's export; version 1 has no tag history.
  const saved = projectSaved(raw, new Map(savedItemIds(raw).map(id => [id, []])));
  return { data: describeSaved(saved, 1), parts: head.partCount, photos: saved.tables.item_images.length, fileBytes,
    read: photoReader(source, passphrase, 1, head.exportId, head.partCount, locate) };
}

// Reads part 0's schema version without trusting anything else in it.
export async function readBackup(source: PartSource, passphrase: string, checkJpeg: JpegCheck): Promise<ReadBackup> {
  const first = await source.read(0);
  const v1 = () => readBackupV1({ ...source, read: index => index === 0 ? Promise.resolve(first) : source.read(index) }, passphrase, checkJpeg);
  // Version 1 keeps photos in part 0, so its part 0 may be up to the encrypted part limit. A part 0 over the version 2
  // metadata limit is decrypted first; only a version 1 part may continue, anything else is too large.
  if (first.length > BACKUP_LIMITS.metadataPartBytes) {
    try { await decryptPart(first, passphrase, 1); }
    catch (error) { throw error instanceof BackupFormatError && error.problem === 'passphrase' ? error : new BackupFormatError('tooLarge'); }
    return v1();
  }
  try { return await readBackupV2({ ...source, read: index => index === 0 ? Promise.resolve(first) : source.read(index) }, passphrase, checkJpeg); }
  catch (error) {
    if (!(error instanceof BackupFormatError) || error.problem !== 'invalid') throw error;
    let version: unknown;
    try { await decryptPart(first, passphrase, 1); version = 1; } catch { version = 2; }
    if (version !== 1) throw error;
    return v1();
  }
}

// ---- Photo chains. ----
// Photo 0 is created by the checked save; each later photo k replaces photo k-1 under request R(k). A chain may only be
// resumed from its completed prefix: earlier photos retired, the latest completed photo current, at most the next one pending.
export type ChainImage = { id: string; state: 'pending' | 'ready' | 'retired'; altText: string; width: number; height: number };
export type ChainTarget = { imageId: string; altText: string; width: number; height: number };
export type ChainState =
  | { kind: 'new' }
  | { kind: 'resume'; completed: number; pending: boolean }
  | { kind: 'complete' }
  | { kind: 'conflict' };
export function chainState(targets: readonly ChainTarget[], images: readonly ChainImage[]): ChainState {
  const byId = new Map(images.map(image => [image.id, image]));
  if (images.some(image => !targets.some(target => target.imageId === image.id))) return { kind: 'conflict' };
  let completed = -1;
  while (completed + 1 < targets.length) {
    const image = byId.get(targets[completed + 1]!.imageId);
    if (!image || image.state === 'pending') break;
    completed++;
  }
  const next = completed + 1 < targets.length ? byId.get(targets[completed + 1]!.imageId) : undefined;
  if (next && next.state !== 'pending') return { kind: 'conflict' };
  for (let index = completed + 2; index < targets.length; index++) if (byId.has(targets[index]!.imageId)) return { kind: 'conflict' };
  for (let index = 0; index <= completed; index++) {
    const image = byId.get(targets[index]!.imageId)!;
    const target = targets[index]!;
    if (image.altText !== target.altText || image.width !== target.width || image.height !== target.height
      || image.state !== (index === completed ? 'ready' : 'retired')) return { kind: 'conflict' };
  }
  if (completed < 0) return next ? { kind: 'resume', completed, pending: true } : { kind: 'new' };
  if (completed === targets.length - 1) return { kind: 'complete' };
  return { kind: 'resume', completed, pending: Boolean(next) };
}
