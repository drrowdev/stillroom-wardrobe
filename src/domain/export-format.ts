// Saved-only backup format (metadata v3, encryption envelope v1; blueprint 08). Version 2 is still read and resumed. The app and scripts/verify-backup.mjs
// share this module, so it has no imports and uses only syntax that Node can load by stripping types.

const MiB = 1024 * 1024;
export const BACKUP_LIMITS = Object.freeze({
  partFileBytes: 12 * MiB,
  metadataBytes: 8 * MiB,
  encryptedPartBytes: 40 * MiB,
  // Part 0 holds only metadata (at most 8 MiB before base64 and encryption).
  metadataPartBytes: 12 * MiB,
  // Largest honest backup: 4 GiB of photos, base64 twice (16/9), plus metadata and per-file overhead.
  totalEncryptedBytes: 7680 * MiB,
  parts: 400,
  totalFileBytes: 4096 * MiB,
  rowsPerTable: 20_000,
  stringLength: 8192,
  depth: 12,
  passphrase: 16,
});
export const KDF_ITERATIONS = 600_000;

type Row = Record<string, unknown>;
export type BackupProblem = 'changed' | 'tooLarge' | 'invalid' | 'passphrase' | 'incomplete';
export class BackupFormatError extends Error {
  readonly problem: BackupProblem;
  constructor(problem: BackupProblem) { super(`Backup ${problem}.`); this.name = 'BackupFormatError'; this.problem = problem; }
}
const fail = (problem: BackupProblem = 'invalid'): never => { throw new BackupFormatError(problem); };

// Columns of the raw export_manifest rows, which the saved-only projection reads. An unknown column fails the export.
export const rawColumns = {
  profiles: ['owner_id', 'display_name', 'ui_language', 'timezone', 'currency', 'weather_enabled', 'weather_city', 'latitude',
    'longitude', 'created_at', 'updated_at', 'version'],
  style_preferences: ['owner_id', 'preferred_colours', 'style_tags', 'excluded_categories', 'minimum_upper_coverage',
    'minimum_lower_coverage', 'cold_sensitivity', 'repeat_gap_days', 'created_at', 'updated_at', 'version'],
  items: ['id', 'owner_id', 'title', 'category', 'subcategory', 'colours', 'brand', 'size_label', 'material', 'seasons', 'formality',
    'warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage', 'style_tags', 'tags',
    'purchase_date', 'purchase_price', 'currency', 'notes', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions',
    'wear_more', 'deleted_at', 'created_at', 'updated_at', 'version', 'pattern', 'sleeve_length', 'garment_length', 'field_provenance'],
  item_images: ['id', 'owner_id', 'item_id', 'state', 'retired_at', 'main_path', 'thumb_path', 'main_bytes', 'thumb_bytes',
    'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text', 'created_at', 'description_version'],
  outfits: ['id', 'owner_id', 'title', 'occasion', 'notes', 'favourite', 'deleted_at', 'created_at', 'updated_at', 'version'],
  outfit_items: ['owner_id', 'outfit_id', 'item_id', 'position'],
  wear_events: ['id', 'owner_id', 'outfit_id', 'local_date', 'timezone', 'state', 'label', 'deleted_at', 'created_at', 'updated_at', 'version'],
  wear_event_items: ['id', 'owner_id', 'event_id', 'item_id', 'import_id', 'title_snapshot', 'category_snapshot'],
  combination_rules: ['id', 'owner_id', 'item_low', 'item_high', 'created_at'],
  suggestion_feedback: ['id', 'owner_id', 'item_ids', 'signature', 'vote', 'created_at'],
} as const;
export type RawTable = keyof typeof rawColumns;
export const attributionEntryKeys = ['source_image_id', 'image_sha256', 'model_id', 'prompt_version', 'fields'] as const;
// One entry of item_attribution_history_v2: the legacy keys plus the origin the server derives from where it is stored.
export const attributionOriginKeys = ['origin', ...attributionEntryKeys] as const;
export const attributionOrigins = ['recorded', 'imported'] as const;
export type AttributionOrigin = typeof attributionOrigins[number];
// New backups are version 3 (history carries its origin). Version 2 is still read, verified and resumed as version 2.
// Version 4 is version 3 plus a non-empty `provenance` list, written only when an exported photo was edited with AI.
export const SAVED_VERSION = 3;
export const PROVENANCE_VERSION = 4;
export type SavedVersion = 2 | 3 | 4;
/** One exported photo edited with AI; `backupSha256` is that exported image's main_sha256. */
export type ProvenanceEntry = { imageId: string; kind: 'ai_edited'; modelId: string; manifestId: string; backupSha256: string };
const provenanceKeys = ['imageId', 'kind', 'modelId', 'manifestId', 'backupSha256'] as const;
const provenanceRowKeys = ['image_id', 'kind', 'origin', 'model_id', 'manifest_id', 'stored_sha256', 'backup_sha256'] as const;
const modelPattern = /^[A-Za-z0-9._:/-]{1,128}$/;
const manifestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const attributionColumnsV2 = ['owner_id', 'item_id', 'position', 'source_image_id', 'source_image_excluded', 'image_sha256', 'model_id',
  'prompt_version', 'fields'] as const;
// Weather on/off is consent, so it is never exported; the chosen city stays as owner data.
export const savedColumns = {
  ...rawColumns,
  profiles: rawColumns.profiles.filter(column => column !== 'weather_enabled'),
  item_attributions: [...attributionColumnsV2, 'origin'],
} as const;
export type SavedTable = keyof typeof savedColumns;
const savedTables = Object.keys(savedColumns) as SavedTable[];
const rawTables = Object.keys(rawColumns) as RawTable[];
export const savedColumnsFor = (version: SavedVersion, table: SavedTable): readonly string[] =>
  version === 2 && table === 'item_attributions' ? attributionColumnsV2 : savedColumns[table];

export type SavedMetadata = {
  format: 'stillroom-saved'; schema_version: SavedVersion; export_id: string; owner_id: string; created_at: string;
  tables: Record<SavedTable, Row[]>;
  /** Version 4 only. */ provenance?: ProvenanceEntry[];
};
export type RawManifest = { export_id: string; owner_id: string; created_at: string; tables: Record<RawTable, Row[]> };
export type FileRef = { imageId: string; variant: 'main' | 'thumb'; path: string; sha256: string; byteLength: number };
export type FileEntry = { imageId: string; variant: 'main' | 'thumb'; sha256: string; byteLength: number; mime: 'image/jpeg'; base64: string };
export type ExportPart = {
  format: 'stillroom-export'; schemaVersion: 1 | SavedVersion; exportId: string; partIndex: number; partCount: number; manifestSha256: string;
  manifest?: SavedMetadata; files: FileEntry[];
};
export type Envelope = { format: 'stillroom-encrypted'; version: 1; kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; aad: string; ciphertext: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
const isCount = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const isStamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const sameKeys = (row: Row, keys: readonly string[]) => {
  const own = Object.keys(row);
  return own.length === keys.length && keys.every(key => Object.hasOwn(row, key));
};

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  return fail();
}

const encoder = new TextEncoder();
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}
// A flat character class: a grouped repetition overflows the regex stack on multi-megabyte parts. The round trip below keeps it canonical.
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
export function fromBase64(text: unknown, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length > Math.ceil(maximumBytes / 3) * 4 || text.length % 4 !== 0 || !base64Pattern.test(text)) return fail();
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (toBase64(bytes) !== text) return fail();
  return bytes;
}

// Bounds every parsed structure before it is interpreted: nesting, string length and array size.
export function assertBounded(value: unknown, depth = 0): void {
  if (depth > BACKUP_LIMITS.depth) fail();
  if (typeof value === 'string') { if (value.length > BACKUP_LIMITS.stringLength) fail(); return; }
  if (Array.isArray(value)) {
    if (value.length > BACKUP_LIMITS.rowsPerTable) fail();
    for (const entry of value) assertBounded(entry, depth + 1);
    return;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 64) fail();
    for (const key of keys) { if (key.length > 64) fail(); assertBounded(value[key], depth + 1); }
    return;
  }
  if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) fail();
}

// Text the database can hold in jsonb: no NUL character and no unpaired surrogate. Recorded history never has either.
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const storable = (text: string) => !text.includes('\u0000') && !loneSurrogate.test(text);
function isStorable(value: unknown): boolean {
  if (typeof value === 'string') return storable(value);
  if (Array.isArray(value)) return value.every(isStorable);
  if (isObject(value)) return Object.keys(value).every(key => storable(key) && isStorable(value[key]));
  return true;
}
// One tag-history entry's values: the same checks restore_item_attribution makes.
function validAttribution(entry: Row): boolean {
  return isHash(entry.image_sha256) && typeof entry.model_id === 'string' && isCount(entry.prompt_version, 0, 2_147_483_647)
    && isObject(entry.fields) && isStorable(entry.model_id) && isStorable(entry.fields);
}

function rowKey(table: SavedTable, row: Row): string {
  if (table === 'profiles' || table === 'style_preferences') return String(row.owner_id);
  if (table === 'outfit_items') return `${String(row.outfit_id)}|${String(row.item_id)}`;
  if (table === 'item_attributions') return `${String(row.item_id)}|${String(row.position).padStart(6, '0')}`;
  return String(row.id);
}
const byKey = (table: SavedTable) => (a: Row, b: Row) => { const x = rowKey(table, a), y = rowKey(table, b); return x < y ? -1 : x > y ? 1 : 0; };

export function readRawManifest(value: unknown, ownerId: string, exportId: string): RawManifest {
  if (!isObject(value) || value.schema_version !== 2 || value.owner_id !== ownerId || value.export_id !== exportId
    || !isStamp(value.created_at) || !isObject(value.tables) || !sameKeys(value.tables, rawTables)) return fail();
  assertBounded(value.tables);
  const tables = {} as Record<RawTable, Row[]>;
  for (const table of rawTables) {
    const rows = value.tables[table];
    if (!Array.isArray(rows)) return fail();
    for (const row of rows) if (!isObject(row) || !sameKeys(row, rawColumns[table]) || row.owner_id !== ownerId) fail();
    tables[table] = rows as Row[];
  }
  if (tables.profiles.length !== 1 || tables.style_preferences.length > 1) fail();
  return { export_id: exportId, owner_id: ownerId, created_at: value.created_at, tables };
}

const imagePath = (image: Row, variant: 'main' | 'thumb') => `${String(image.owner_id)}/${String(image.item_id)}/${String(image.id)}/${variant}.jpg`;
function validImage(image: Row): boolean {
  return isUuid(image.id) && isUuid(image.item_id) && (image.state === 'ready' || image.state === 'retired' || image.state === 'pending')
    && (image.state === 'retired' ? isStamp(image.retired_at) : image.retired_at === null)
    && image.main_path === imagePath(image, 'main') && image.thumb_path === imagePath(image, 'thumb')
    && isCount(image.main_bytes, 1, 512_000) && isCount(image.thumb_bytes, 1, 61_440) && isHash(image.main_sha256) && isHash(image.thumb_sha256)
    && isCount(image.width, 1, 1600) && isCount(image.height, 1, 1600) && typeof image.alt_text === 'string';
}

// Items that count as saved: not in Trash and with a current ready photo, the same rule the wardrobe uses.
export function savedItemIds(raw: RawManifest): string[] {
  const ready = new Map<string, number>();
  for (const image of raw.tables.item_images) {
    if (!validImage(image)) fail();
    if (image.state === 'ready') ready.set(String(image.item_id), (ready.get(String(image.item_id)) ?? 0) + 1);
  }
  const ids: string[] = [];
  for (const item of raw.tables.items) {
    if (!isUuid(item.id) || !(item.deleted_at === null || isStamp(item.deleted_at))) fail();
    const count = ready.get(String(item.id)) ?? 0;
    if (count > 1) fail();
    if (item.deleted_at === null && count === 1) ids.push(String(item.id));
  }
  return ids.sort();
}

// Only what was saved leaves the account: no drafts, pending photos, Trash, analysis requests, receipts or consent.
// Every reference inside the result points at an exported row; history keeps its text when its item is left out.
// `attributions` holds each saved item's item_attribution_history_v2 entries, in order.
export function projectSaved(raw: RawManifest, attributions: ReadonlyMap<string, unknown>, provenanceRows: unknown = []): SavedMetadata {
  const t = raw.tables, owner = raw.owner_id;
  const items = new Set(savedItemIds(raw));
  if (attributions.size !== items.size || [...attributions.keys()].some(id => !items.has(id))) fail();
  const images = t.item_images.filter(image => items.has(String(image.item_id)) && image.state !== 'pending');
  const imageIds = new Set(images.map(image => String(image.id)));
  const links = t.outfit_items.filter(link => items.has(String(link.item_id)));
  const outfits = t.outfits.filter(outfit => outfit.deleted_at === null && links.some(link => link.outfit_id === outfit.id));
  const outfitIds = new Set(outfits.map(outfit => String(outfit.id)));
  const events = t.wear_events.filter(event => event.deleted_at === null)
    .map((event): Row => ({ ...event, outfit_id: outfitIds.has(String(event.outfit_id)) ? event.outfit_id : null }));
  const eventIds = new Set(events.map(event => String(event.id)));
  const itemAttributions: Row[] = [];
  for (const [itemId, entries] of attributions) {
    if (!Array.isArray(entries) || entries.length > 1000) fail();
    (entries as unknown[]).forEach((entry, position) => {
      if (!isObject(entry) || !sameKeys(entry, attributionOriginKeys) || !(entry.source_image_id === null || isUuid(entry.source_image_id))
        || !attributionOrigins.some(origin => origin === entry.origin) || !validAttribution(entry)) fail();
      const row = entry as Row;
      const linked = row.source_image_id !== null && imageIds.has(String(row.source_image_id))
        && images.some(image => image.id === row.source_image_id && image.item_id === itemId);
      itemAttributions.push({ owner_id: owner, item_id: itemId, position, source_image_id: linked ? row.source_image_id : null,
        source_image_excluded: !linked, image_sha256: row.image_sha256, model_id: row.model_id,
        prompt_version: row.prompt_version, fields: row.fields, origin: row.origin });
    });
  }
  const tables: Record<SavedTable, Row[]> = {
    profiles: t.profiles.map(profile => Object.fromEntries(Object.entries(profile).filter(([column]) => column !== 'weather_enabled'))),
    style_preferences: t.style_preferences,
    items: t.items.filter(item => items.has(String(item.id))),
    item_images: images,
    item_attributions: itemAttributions,
    outfits,
    outfit_items: links.filter(link => outfitIds.has(String(link.outfit_id))),
    wear_events: events,
    wear_event_items: t.wear_event_items.filter(link => eventIds.has(String(link.event_id)))
      .map(link => ({ ...link, item_id: items.has(String(link.item_id)) ? link.item_id : null })),
    combination_rules: t.combination_rules.filter(rule => items.has(String(rule.item_low)) && items.has(String(rule.item_high))),
    suggestion_feedback: t.suggestion_feedback.filter(entry => Array.isArray(entry.item_ids)
      && entry.item_ids.every(id => items.has(String(id)))),
  };
  for (const table of savedTables) tables[table] = [...tables[table]].sort(byKey(table));
  const provenance = projectProvenance(tables.item_images, provenanceRows);
  // Without an exported edited photo the metadata is exactly what version 3 always wrote: no provenance key.
  const metadata: SavedMetadata = provenance.length
    ? { format: 'stillroom-saved', schema_version: PROVENANCE_VERSION, export_id: raw.export_id, owner_id: owner,
      created_at: raw.created_at, tables, provenance }
    : { format: 'stillroom-saved', schema_version: SAVED_VERSION, export_id: raw.export_id, owner_id: owner,
      created_at: raw.created_at, tables };
  assertMetadata(metadata);
  return metadata;
}

// image_provenance_v1 rows projected onto the images this backup actually exports (saved items; no Trash, pending or
// unsaved photos). A row for an exported image must match its stored bytes; anything else means it changed meanwhile.
export function projectProvenance(images: readonly Row[], rows: unknown): ProvenanceEntry[] {
  if (!Array.isArray(rows) || rows.length > 100_000) fail();
  const exported = new Map(images.map(image => [String(image.id), image]));
  const seen = new Set<string>();
  const out: ProvenanceEntry[] = [];
  for (const value of rows as unknown[]) {
    if (!isObject(value)) fail();
    const row = value as Row;
    if (!sameKeys(row, provenanceRowKeys) || !isUuid(row.image_id) || row.kind !== 'ai_edited'
      || (row.origin !== 'recorded' && row.origin !== 'imported') || typeof row.model_id !== 'string' || !modelPattern.test(row.model_id)
      || typeof row.manifest_id !== 'string' || !manifestPattern.test(row.manifest_id) || !isHash(row.stored_sha256)
      || !(row.backup_sha256 === null || isHash(row.backup_sha256))) fail();
    if (seen.has(String(row.image_id))) fail();
    seen.add(String(row.image_id));
    const image = exported.get(String(row.image_id));
    if (!image) continue;
    if (image.main_sha256 !== row.stored_sha256) fail('changed');
    out.push({ imageId: String(row.image_id), kind: 'ai_edited', modelId: String(row.model_id), manifestId: String(row.manifest_id),
      backupSha256: String(row.stored_sha256) });
  }
  return out.sort((a, b) => a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0);
}

// Structural and referential check of saved metadata (version 2 or 3); used when writing, by the offline verifier and by
// restore's Check before anything is written.
const metadataKeys = ['format', 'schema_version', 'export_id', 'owner_id', 'created_at', 'tables'] as const;
export function assertMetadata(value: unknown): asserts value is SavedMetadata {
  if (!isObject(value) || !sameKeys(value, value.schema_version === PROVENANCE_VERSION ? [...metadataKeys, 'provenance'] : metadataKeys)
    || value.format !== 'stillroom-saved' || (value.schema_version !== 2 && value.schema_version !== 3 && value.schema_version !== 4)
    || !isUuid(value.export_id) || !isUuid(value.owner_id)
    || !isStamp(value.created_at) || !isObject(value.tables) || !sameKeys(value.tables, savedTables)) return fail();
  assertBounded(value.tables);
  const owner = value.owner_id, version = value.schema_version as SavedVersion;
  const tables = value.tables as Record<SavedTable, unknown>;
  for (const table of savedTables) {
    const rows = tables[table];
    if (!Array.isArray(rows)) return fail();
    const keys = new Set<string>();
    let previous = '';
    for (const row of rows) {
      if (!isObject(row) || !sameKeys(row, savedColumnsFor(version, table)) || row.owner_id !== owner) fail();
      const key = rowKey(table, row as Row);
      if (keys.has(key) || key < previous) fail();
      keys.add(key); previous = key;
    }
  }
  const t = tables as Record<SavedTable, Row[]>;
  if (t.profiles.length !== 1 || t.style_preferences.length > 1) fail();
  const items = new Set(t.items.map(item => { if (!isUuid(item.id) || item.deleted_at !== null) fail(); return String(item.id); }));
  const ready = new Set<string>();
  const images = new Map<string, Row>();
  for (const image of t.item_images) {
    if (!validImage(image) || image.state === 'pending' || !items.has(String(image.item_id))) fail();
    if (image.state === 'ready') { if (ready.has(String(image.item_id))) fail(); ready.add(String(image.item_id)); }
    images.set(String(image.id), image);
  }
  if (ready.size !== items.size) fail();
  // Rows are sorted by item, then position, so each item's positions must run 0, 1, 2, ... with no gap.
  let historyItem: unknown = null, nextPosition = 0;
  for (const entry of t.item_attributions) {
    if (!items.has(String(entry.item_id)) || !isCount(entry.position, 0, 999) || typeof entry.source_image_excluded !== 'boolean'
      || (entry.source_image_id === null) !== entry.source_image_excluded
      || (entry.source_image_id !== null && images.get(String(entry.source_image_id))?.item_id !== entry.item_id)
      || !validAttribution(entry) || version !== 2 && !attributionOrigins.some(origin => origin === entry.origin)) fail();
    if (entry.item_id !== historyItem) { historyItem = entry.item_id; nextPosition = 0; }
    if (entry.position !== nextPosition++) fail();
  }
  const outfits = new Set(t.outfits.map(outfit => { if (!isUuid(outfit.id) || outfit.deleted_at !== null) fail(); return String(outfit.id); }));
  const linked = new Set<string>();
  for (const link of t.outfit_items) {
    if (!outfits.has(String(link.outfit_id)) || !items.has(String(link.item_id)) || !isCount(link.position, 0, 11)) fail();
    linked.add(String(link.outfit_id));
  }
  if (linked.size !== outfits.size) fail();
  const events = new Set(t.wear_events.map(event => {
    if (!isUuid(event.id) || event.deleted_at !== null || !(event.outfit_id === null || outfits.has(String(event.outfit_id)))) fail();
    return String(event.id);
  }));
  for (const link of t.wear_event_items) {
    if (!isUuid(link.id) || !events.has(String(link.event_id)) || !(link.item_id === null || items.has(String(link.item_id)))
      || typeof link.title_snapshot !== 'string' || typeof link.category_snapshot !== 'string') fail();
  }
  for (const rule of t.combination_rules) if (!items.has(String(rule.item_low)) || !items.has(String(rule.item_high))) fail();
  for (const entry of t.suggestion_feedback) {
    if (!Array.isArray(entry.item_ids) || entry.item_ids.length < 1 || entry.item_ids.length > 12
      || !entry.item_ids.every(id => items.has(String(id)))) fail();
  }
  if (version === PROVENANCE_VERSION) {
    const list = (value as Row).provenance;
    if (!Array.isArray(list) || list.length < 1 || list.length > images.size) fail();
    let previous = '';
    for (const value of list as unknown[]) {
      if (!isObject(value)) fail();
      const entry = value as Row;
      if (!sameKeys(entry, provenanceKeys) || !isUuid(entry.imageId) || entry.kind !== 'ai_edited'
        || typeof entry.modelId !== 'string' || !modelPattern.test(entry.modelId)
        || typeof entry.manifestId !== 'string' || !manifestPattern.test(entry.manifestId) || !isHash(entry.backupSha256)
        || String(entry.imageId) <= previous || images.get(String(entry.imageId))?.main_sha256 !== entry.backupSha256) fail();
      previous = String(entry.imageId);
    }
  }
}

// Files sorted by image and then main, thumb; each part holds at most 12 MiB of decoded photo bytes. Part 0 is metadata only.
export function planParts(metadata: SavedMetadata): FileRef[][] {
  const refs = [...metadata.tables.item_images].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1).flatMap(image =>
    (['main', 'thumb'] as const).map(variant => ({ imageId: String(image.id), variant, path: String(image[`${variant}_path`]),
      sha256: String(image[`${variant}_sha256`]), byteLength: Number(image[`${variant}_bytes`]) })));
  const total = refs.reduce((sum, ref) => sum + ref.byteLength, 0);
  if (total > BACKUP_LIMITS.totalFileBytes) fail('tooLarge');
  const parts: FileRef[][] = [];
  let size = BACKUP_LIMITS.partFileBytes;
  for (const ref of refs) {
    if (size + ref.byteLength > BACKUP_LIMITS.partFileBytes) { parts.push([]); size = 0; }
    parts.at(-1)!.push(ref); size += ref.byteLength;
  }
  if (parts.length + 1 > BACKUP_LIMITS.parts) fail('tooLarge');
  return parts;
}

export async function metadataDigest(metadata: SavedMetadata): Promise<string> {
  const text = canonical(metadata);
  if (encoder.encode(text).length > BACKUP_LIMITS.metadataBytes) fail('tooLarge');
  return sha256Hex(text);
}

export const partFileName = (exportId: string, index: number) => `stillroom-${exportId}-${index}.json.enc`;
const aadFor = (exportId: string, index: number, count: number) => `stillroom:1:${exportId}:${index}:${count}`;

async function partKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt') {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS }, material,
    { name: 'AES-GCM', length: 256 }, false, [usage]);
}
export async function encryptPart(part: ExportPart, passphrase: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = aadFor(part.exportId, part.partIndex, part.partCount);
  const key = await partKey(passphrase, salt, 'encrypt');
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 },
    key, encoder.encode(canonical(part))));
  return { format: 'stillroom-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS,
    salt: toBase64(salt), iv: toBase64(iv), aad, ciphertext: toBase64(ciphertext) };
}

const envelopeKeys = ['format', 'version', 'kdf', 'iterations', 'salt', 'iv', 'aad', 'ciphertext'];
const partKeys = ['format', 'schemaVersion', 'exportId', 'partIndex', 'partCount', 'manifestSha256', 'files'];
// Restore also reads version 1 parts (the reference exporter): the same envelope, with photos in part 0 as well.
// 'saved' accepts version 2 or 3; every later part must then have part 0's version.
export async function decryptPart(text: string, passphrase: string, schemaVersion: 1 | SavedVersion | 'saved' = 'saved'): Promise<ExportPart> {
  if (text.length > BACKUP_LIMITS.encryptedPartBytes) fail();
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { return fail(); }
  if (!isObject(envelope) || !sameKeys(envelope, envelopeKeys) || envelope.format !== 'stillroom-encrypted' || envelope.version !== 1
    || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== KDF_ITERATIONS || typeof envelope.aad !== 'string'
    || !/^stillroom:1:[0-9a-f-]{36}:\d{1,3}:\d{1,3}$/.test(envelope.aad)) return fail();
  const salt = fromBase64(envelope.salt, 16), iv = fromBase64(envelope.iv, 12);
  if (salt.length !== 16 || iv.length !== 12) fail();
  const ciphertext = fromBase64(envelope.ciphertext, BACKUP_LIMITS.encryptedPartBytes);
  let plain: Uint8Array;
  try {
    const key = await partKey(passphrase, salt, 'decrypt');
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(envelope.aad), tagLength: 128 }, key, ciphertext));
  } catch { return fail('passphrase'); }
  let part: unknown;
  try { part = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } catch { return fail(); }
  if (!isObject(part)) return fail();
  const keys = Object.hasOwn(part, 'manifest') ? [...partKeys, 'manifest'] : partKeys;
  const versionOk = schemaVersion === 'saved' ? part.schemaVersion === 2 || part.schemaVersion === 3 || part.schemaVersion === 4
    : part.schemaVersion === schemaVersion;
  if (!sameKeys(part, keys) || part.format !== 'stillroom-export' || !versionOk || !isUuid(part.exportId)
    || !isCount(part.partCount, 1, BACKUP_LIMITS.parts) || !isCount(part.partIndex, 0, part.partCount - 1) || !isHash(part.manifestSha256)
    || envelope.aad !== aadFor(part.exportId, part.partIndex, part.partCount) || !Array.isArray(part.files)) return fail();
  return part as ExportPart;
}

export type BackupSummary = { exportId: string; parts: number; items: number; photos: number; fileBytes: number; manifestSha256: string; metadata: SavedMetadata };
export type JpegCheck = (bytes: Uint8Array, variant: 'main' | 'thumb', width: number, height: number) => void;
// Parts are read one at a time by index; `read(0)` is the metadata part. `exportId`, when known from file names, must match.
export type PartSource = { count: number; exportId?: string; read: (index: number) => Promise<string> };

// Checks a complete backup: identity, completeness, the metadata hash and every photo's bytes. The metadata part is checked
// first; each photo part is then read, checked and released before the next, so memory holds the metadata and one part.
// Nothing inside the backup is used as a path or address.
export async function verifyBackup(source: PartSource, passphrase: string, checkJpeg: JpegCheck): Promise<BackupSummary> {
  if (!isCount(source.count, 1, BACKUP_LIMITS.parts)) fail('incomplete');
  const firstText = await source.read(0);
  if (firstText.length > BACKUP_LIMITS.metadataPartBytes) fail('tooLarge');
  const head = await decryptPart(firstText, passphrase);
  if (head.partIndex !== 0 || !Object.hasOwn(head, 'manifest') || head.files.length
    || (source.exportId !== undefined && head.exportId !== source.exportId)) fail();
  if (head.partCount !== source.count) fail('incomplete');
  const metadata = head.manifest;
  assertMetadata(metadata);
  if (metadata.schema_version !== head.schemaVersion || metadata.export_id !== head.exportId || await metadataDigest(metadata) !== head.manifestSha256) fail();
  const plan = planParts(metadata);
  if (plan.length + 1 !== head.partCount) fail('incomplete');
  const images = new Map(metadata.tables.item_images.map(image => [String(image.id), image]));
  let fileBytes = 0;
  for (let index = 1; index < head.partCount; index++) {
    const part = await decryptPart(await source.read(index), passphrase, metadata.schema_version), expected = plan[index - 1]!;
    if (part.exportId !== head.exportId || part.partCount !== head.partCount || part.manifestSha256 !== head.manifestSha256
      || part.partIndex !== index || Object.hasOwn(part, 'manifest')) fail();
    if (part.files.length !== expected.length) fail('incomplete');
    for (let position = 0; position < expected.length; position++) {
      const file: unknown = part.files[position], ref = expected[position]!;
      if (!isObject(file) || !sameKeys(file, ['imageId', 'variant', 'sha256', 'byteLength', 'mime', 'base64']) || file.imageId !== ref.imageId
        || file.variant !== ref.variant || file.sha256 !== ref.sha256 || file.byteLength !== ref.byteLength || file.mime !== 'image/jpeg') fail('incomplete');
      if (fileBytes + ref.byteLength > BACKUP_LIMITS.totalFileBytes) fail('tooLarge');
      const bytes = fromBase64((file as Row).base64, ref.byteLength);
      if (bytes.length !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) fail();
      const image = images.get(ref.imageId)!;
      checkJpeg(bytes, ref.variant, Number(image.width), Number(image.height));
      fileBytes += bytes.length;
    }
  }
  return { exportId: head.exportId, parts: head.partCount, items: metadata.tables.items.length, photos: images.size, fileBytes,
    manifestSha256: head.manifestSha256, metadata };
}

// In-memory form for parts that were just downloaded, in part order.
export function verifyParts(texts: readonly string[], passphrase: string, checkJpeg: JpegCheck): Promise<BackupSummary> {
  return verifyBackup({ count: texts.length, read: async index => texts[index]! }, passphrase, checkJpeg);
}