import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/data/database.types';
import {
  BACKUP_LIMITS, BackupFormatError, assertBounded, canonical, decryptPart, encryptPart, fromBase64, metadataDigest, planParts,
  projectSaved, rawColumns, readRawManifest, savedColumns, savedItemIds, sha256Hex, toBase64, verifyParts,
  type ExportPart, type RawManifest, type SavedMetadata,
} from '../../src/domain/export-format';
type Reference = { encryptPart: (part: unknown, passphrase: string) => Promise<unknown>; decryptPart: (envelope: unknown, passphrase: string) => Promise<unknown> };
const { decryptPart: referenceDecrypt, encryptPart: referenceEncrypt } = await vi.importActual<Reference>('../../blueprint/reference-scripts/export-own.mjs');

type Tables = Database['public']['Tables'];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const columnsMatch: [
  Exact<(typeof rawColumns.items)[number], keyof Tables['items']['Row']>,
  Exact<(typeof rawColumns.item_images)[number], keyof Tables['item_images']['Row']>,
  Exact<(typeof rawColumns.outfits)[number], keyof Tables['outfits']['Row']>,
  Exact<(typeof rawColumns.outfit_items)[number], keyof Tables['outfit_items']['Row']>,
  Exact<(typeof rawColumns.wear_events)[number], keyof Tables['wear_events']['Row']>,
  Exact<(typeof rawColumns.wear_event_items)[number], keyof Tables['wear_event_items']['Row']>,
  Exact<(typeof rawColumns.combination_rules)[number], keyof Tables['combination_rules']['Row']>,
  Exact<(typeof rawColumns.suggestion_feedback)[number], keyof Tables['suggestion_feedback']['Row']>,
  Exact<(typeof rawColumns.style_preferences)[number], keyof Tables['style_preferences']['Row']>,
  Exact<(typeof rawColumns.profiles)[number], Exclude<keyof Tables['profiles']['Row'], `ai_${string}`>>,
] = [true, true, true, true, true, true, true, true, true, true];

const owner = '11111111-1111-4111-8111-111111111111';
const exportId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-09-25T10:00:00+00:00';
const passphrase = 'correct horse battery staple';
const jpeg = new Uint8Array(readFileSync(new URL('../security/fixture.jpg', import.meta.url)));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Row = Record<string, unknown>;

function blank(table: keyof typeof rawColumns, values: Row): Row {
  const row: Row = Object.fromEntries(rawColumns[table].map(column => [column, null]));
  return { ...row, owner_id: owner, ...values };
}
async function image(item: string, id: string, state: 'ready' | 'retired' | 'pending', bytes = jpeg): Promise<Row> {
  const hash = await sha256Hex(bytes);
  return blank('item_images', { id, item_id: item, state, retired_at: state === 'retired' ? stamp : null,
    main_path: `${owner}/${item}/${id}/main.jpg`, thumb_path: `${owner}/${item}/${id}/thumb.jpg`, main_bytes: bytes.length,
    thumb_bytes: bytes.length, main_sha256: hash, thumb_sha256: hash, width: 2, height: 2, alt_text: `Photo ${id.slice(-2)}`,
    created_at: stamp, description_version: 1 });
}
const item = (id: string, values: Row = {}) => blank('items', { id, title: `Item ${id.slice(-2)}`, category: 'top', colours: [],
  seasons: [], style_tags: [], tags: [], favourite: false, availability: 'available', lifecycle: 'active', exclude_suggestions: false,
  wear_more: false, deleted_at: null, created_at: stamp, updated_at: stamp, version: 1, field_provenance: {}, ...values });

// Saved: A (ready + retired photo), B (ready). Trash: T. Draft: D (pending photo only).
const A = uuid(1), B = uuid(2), T = uuid(3), D = uuid(4);
async function rawManifest(): Promise<RawManifest> {
  const tables = {
    profiles: [blank('profiles', { display_name: 'Owner', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR',
      weather_enabled: true, weather_city: 'Helsinki', latitude: 60.17, longitude: 24.94, created_at: stamp, updated_at: stamp, version: 3 })],
    style_preferences: [],
    items: [item(A), item(B), item(T, { deleted_at: stamp }), item(D)],
    item_images: [await image(A, uuid(11), 'ready'), await image(A, uuid(12), 'retired'), await image(B, uuid(13), 'ready'),
      await image(T, uuid(14), 'ready'), await image(D, uuid(15), 'pending'), await image(A, uuid(16), 'pending')],
    outfits: [
      blank('outfits', { id: uuid(21), title: 'Kept', favourite: false, deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 }),
      blank('outfits', { id: uuid(22), title: 'Trashed', favourite: false, deleted_at: stamp, created_at: stamp, updated_at: stamp, version: 1 }),
      blank('outfits', { id: uuid(23), title: 'Only Trash items', favourite: false, deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 }),
    ],
    outfit_items: [
      blank('outfit_items', { outfit_id: uuid(21), item_id: A, position: 0 }), blank('outfit_items', { outfit_id: uuid(21), item_id: T, position: 1 }),
      blank('outfit_items', { outfit_id: uuid(22), item_id: B, position: 0 }), blank('outfit_items', { outfit_id: uuid(23), item_id: T, position: 0 }),
    ],
    wear_events: [
      blank('wear_events', { id: uuid(31), outfit_id: uuid(21), local_date: '2026-09-20', timezone: 'Europe/Helsinki', state: 'worn', deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 }),
      blank('wear_events', { id: uuid(32), outfit_id: uuid(22), local_date: '2026-09-21', timezone: 'Europe/Helsinki', state: 'worn', deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 }),
      blank('wear_events', { id: uuid(33), outfit_id: uuid(23), local_date: '2026-09-22', timezone: 'Europe/Helsinki', state: 'worn', deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 }),
      blank('wear_events', { id: uuid(34), outfit_id: null, local_date: '2026-09-23', timezone: 'Europe/Helsinki', state: 'worn', deleted_at: stamp, created_at: stamp, updated_at: stamp, version: 1 }),
    ],
    wear_event_items: [
      blank('wear_event_items', { id: uuid(41), event_id: uuid(31), item_id: A, title_snapshot: 'Item 01', category_snapshot: 'top' }),
      blank('wear_event_items', { id: uuid(42), event_id: uuid(33), item_id: T, title_snapshot: 'Old coat', category_snapshot: 'outerwear' }),
      blank('wear_event_items', { id: uuid(43), event_id: uuid(34), item_id: A, title_snapshot: 'Deleted wear', category_snapshot: 'top' }),
    ],
    combination_rules: [blank('combination_rules', { id: uuid(51), item_low: A, item_high: B, created_at: stamp }),
      blank('combination_rules', { id: uuid(52), item_low: A, item_high: T, created_at: stamp })],
    suggestion_feedback: [blank('suggestion_feedback', { id: uuid(61), item_ids: [A, B], signature: 'a', vote: 'like', created_at: stamp }),
      blank('suggestion_feedback', { id: uuid(62), item_ids: [B, D], signature: 'b', vote: 'dislike', created_at: stamp })],
  };
  return readRawManifest({ schema_version: 2, export_id: exportId, owner_id: owner, created_at: stamp, tables }, owner, exportId);
}
const history = (source: string | null, hash: string) => ({ source_image_id: source, image_sha256: hash, model_id: 'model-x', prompt_version: 2, fields: { title: 'X' } });
async function saved(): Promise<SavedMetadata> {
  const hash = await sha256Hex(jpeg);
  return projectSaved(await rawManifest(), new Map<string, unknown>([
    [A, [history(uuid(11), hash), history(uuid(16), hash), history(uuid(14), hash)]],
    [B, [history(null, hash)]],
  ]));
}
function problem(error: unknown) { return error instanceof BackupFormatError ? error.problem : String(error); }
const ids = (rows: Row[]) => rows.map(row => row.id);

describe('backup encoding', () => {
  it('matches the blueprint canonical and hash vectors', async () => {
    expect(columnsMatch.every(Boolean)).toBe(true);
    expect(canonical({ z: 1, a: { c: 3, b: 2 } })).toBe('{"a":{"b":2,"c":3},"z":1}');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('accepts only canonical base64 within the byte limit', () => {
    expect([...fromBase64(toBase64(new Uint8Array([1, 2, 3, 250])), 4)]).toEqual([1, 2, 3, 250]);
    for (const bad of ['AQID+g', 'AQID+g=', 'AQ ID', 'AQIDBA==x', 'AR==', 42]) expect(() => fromBase64(bad, 10)).toThrow(BackupFormatError);
    expect(() => fromBase64(toBase64(new Uint8Array(7)), 6)).toThrow(BackupFormatError);
  });
  it('bounds depth, strings, rows and keys', () => {
    let deep: unknown = 1;
    for (let level = 0; level <= BACKUP_LIMITS.depth; level++) deep = [deep];
    expect(() => assertBounded(deep)).toThrow(BackupFormatError);
    expect(() => assertBounded('x'.repeat(BACKUP_LIMITS.stringLength + 1))).toThrow(BackupFormatError);
    expect(() => assertBounded(Array.from({ length: BACKUP_LIMITS.rowsPerTable + 1 }, () => 0))).toThrow(BackupFormatError);
    expect(() => assertBounded(Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`k${n}`, 1])))).toThrow(BackupFormatError);
    expect(() => assertBounded({ value: Number.NaN })).toThrow(BackupFormatError);
    expect(() => assertBounded({ a: [1, 'b', null, true, { c: 2 }] })).not.toThrow();
  });
});

describe('saved-only projection', () => {
  it('keeps only saved items, their saved photos and closed references', async () => {
    const meta = await saved();
    const t = meta.tables;
    expect(ids(t.items)).toEqual([A, B]);
    expect(ids(t.item_images)).toEqual([uuid(11), uuid(12), uuid(13)]);
    expect(t.item_images.find(row => row.id === uuid(12))).toMatchObject({ state: 'retired', alt_text: 'Photo 12' });
    expect(ids(t.outfits)).toEqual([uuid(21)]);
    expect(t.outfit_items).toEqual([expect.objectContaining({ outfit_id: uuid(21), item_id: A })]);
    expect(t.wear_events.map(event => [event.id, event.outfit_id])).toEqual([[uuid(31), uuid(21)], [uuid(32), null], [uuid(33), null]]);
    expect(t.wear_event_items.map(link => [link.id, link.item_id, link.title_snapshot])).toEqual([
      [uuid(41), A, 'Item 01'], [uuid(42), null, 'Old coat']]);
    expect(ids(t.combination_rules)).toEqual([uuid(51)]);
    expect(ids(t.suggestion_feedback)).toEqual([uuid(61)]);
  });
  it('drops weather consent but keeps the chosen city', async () => {
    const [profile] = (await saved()).tables.profiles;
    expect(profile).not.toHaveProperty('weather_enabled');
    expect(profile).toMatchObject({ weather_city: 'Helsinki', display_name: 'Owner' });
    expect(Object.keys(profile!).some(column => column.startsWith('ai_'))).toBe(false);
  });
  it('exports attribution history and marks links to photos that are not in the backup', async () => {
    const rows = (await saved()).tables.item_attributions;
    expect(rows.map(row => [row.item_id, row.position, row.source_image_id, row.source_image_excluded])).toEqual([
      [A, 0, uuid(11), false], [A, 1, null, true], [A, 2, null, true], [B, 0, null, false]]);
    expect(rows[0]).toMatchObject({ model_id: 'model-x', prompt_version: 2, fields: { title: 'X' } });
    expect(Object.keys(rows[0]!).sort()).toEqual([...savedColumns.item_attributions].sort());
  });
  it('refuses unknown columns, other owners and incomplete attribution', async () => {
    const raw = await rawManifest();
    const base = { schema_version: 2, export_id: exportId, owner_id: owner, created_at: stamp };
    const extra = { ...raw.tables, items: [{ ...raw.tables.items[0], secret: 1 }] };
    expect(() => readRawManifest({ ...base, tables: extra }, owner, exportId)).toThrow(BackupFormatError);
    const foreign = { ...raw.tables, outfits: [{ ...raw.tables.outfits[0], owner_id: uuid(99) }] };
    expect(() => readRawManifest({ ...base, tables: foreign }, owner, exportId)).toThrow(BackupFormatError);
    expect(() => readRawManifest({ ...base, tables: { ...raw.tables, ai_analysis_requests: [] } }, owner, exportId)).toThrow(BackupFormatError);
    expect(() => readRawManifest({ ...base, tables: raw.tables }, uuid(99), exportId)).toThrow(BackupFormatError);
    expect(() => projectSaved(raw, new Map([[A, []]]))).toThrow(BackupFormatError);
    expect(() => projectSaved(raw, new Map<string, unknown>([[A, []], [B, [{ ...history(null, 'a'.repeat(64)), extra: 1 }]]]))).toThrow(BackupFormatError);
  });
  it('lists saved items by the same rule the wardrobe uses', async () => {
    expect(savedItemIds(await rawManifest())).toEqual([A, B]);
  });
});

async function parts(meta: SavedMetadata, bytes = jpeg): Promise<string[]> {
  const digest = await metadataDigest(meta);
  const plan = planParts(meta);
  const count = plan.length + 1;
  const base = { format: 'stillroom-export', schemaVersion: 2, exportId, partCount: count, manifestSha256: digest } as const;
  const out: ExportPart[] = [{ ...base, partIndex: 0, manifest: meta, files: [] }];
  plan.forEach((refs, index) => out.push({ ...base, partIndex: index + 1, files: refs.map(ref => ({ imageId: ref.imageId, variant: ref.variant,
    sha256: ref.sha256, byteLength: ref.byteLength, mime: 'image/jpeg', base64: toBase64(bytes) })) }));
  return Promise.all(out.map(async part => JSON.stringify(await encryptPart(part, passphrase))));
}
const noJpegCheck = () => undefined;

// PBKDF2 at 600,000 iterations runs per part; the default 5 s is too short under a loaded runner.
describe('encrypted parts', { timeout: 60_000 }, () => {
  it('round-trips with the reference exporter in both directions', async () => {
    const part = { format: 'stillroom-export', schemaVersion: 2, exportId, partIndex: 0, partCount: 1, manifestSha256: 'a'.repeat(64), files: [] as ExportPart['files'] } as const;
    const ours = await encryptPart(part, passphrase);
    expect(await referenceDecrypt(ours, passphrase)).toEqual(part);
    expect(await decryptPart(JSON.stringify(await referenceEncrypt(part, passphrase)), passphrase)).toEqual(part);
    const again = await encryptPart(part, passphrase);
    expect(again.salt).not.toBe(ours.salt);
    expect(again.iv).not.toBe(ours.iv);
  });
  it('rejects a wrong passphrase, tampering and a moved part', async () => {
    const part = { format: 'stillroom-export', schemaVersion: 2, exportId, partIndex: 1, partCount: 2, manifestSha256: 'a'.repeat(64), files: [] as ExportPart['files'] } as const;
    const envelope = await encryptPart(part, passphrase);
    expect(problem(await decryptPart(JSON.stringify(envelope), 'wrong passphrase value').catch(error => error))).toBe('passphrase');
    const flipped = fromBase64(envelope.ciphertext, 1_000);
    flipped[0] = flipped[0]! ^ 1;
    expect(problem(await decryptPart(JSON.stringify({ ...envelope, ciphertext: toBase64(flipped) }), passphrase).catch(error => error))).toBe('passphrase');
    const moved = { ...envelope, aad: `stillroom:1:${exportId}:0:2` };
    expect(problem(await decryptPart(JSON.stringify(moved), passphrase).catch(error => error))).toBe('passphrase');
    expect(problem(await decryptPart(JSON.stringify({ ...envelope, extra: 1 }), passphrase).catch(error => error))).toBe('invalid');
    expect(problem(await decryptPart('x'.repeat(BACKUP_LIMITS.encryptedPartBytes + 1), passphrase).catch(error => error))).toBe('invalid');
  });
  it('plans photo parts within the size limit, with metadata alone in part 1', async () => {
    const meta = await saved();
    const plan = planParts(meta);
    expect(plan.flat().map(ref => `${ref.imageId}:${ref.variant}`)).toEqual([
      `${uuid(11)}:main`, `${uuid(11)}:thumb`, `${uuid(12)}:main`, `${uuid(12)}:thumb`, `${uuid(13)}:main`, `${uuid(13)}:thumb`]);
    expect(plan).toHaveLength(1);
    const big = structuredClone(meta);
    big.tables.item_images = big.tables.item_images.map(row => ({ ...row, main_bytes: 512_000, thumb_bytes: 61_440 }));
    for (const refs of planParts(big)) expect(refs.reduce((sum, ref) => sum + ref.byteLength, 0)).toBeLessThanOrEqual(BACKUP_LIMITS.partFileBytes);
  });
  it('verifies a complete backup and names what is wrong otherwise', async () => {
    const meta = await saved();
    const texts = await parts(meta);
    const summary = await verifyParts(texts, passphrase, noJpegCheck);
    expect(summary).toMatchObject({ exportId, parts: 2, items: 2, photos: 3, fileBytes: jpeg.length * 6 });
    expect(problem(await verifyParts(texts.slice(0, 1), passphrase, noJpegCheck).catch(error => error))).toBe('incomplete');
    expect(problem(await verifyParts([texts[0]!, texts[0]!], passphrase, noJpegCheck).catch(error => error))).toBe('invalid');
    const changed = jpeg.slice();
    changed[changed.length - 3] = changed[changed.length - 3]! ^ 1;
    const tampered = await parts(meta, changed);
    expect(problem(await verifyParts([texts[0]!, tampered[1]!], passphrase, noJpegCheck).catch(error => error))).toBe('invalid');
    const other = structuredClone(meta);
    other.tables.items[0]!.title = 'Changed';
    const mixed = await parts(other);
    expect(problem(await verifyParts([mixed[0]!, texts[1]!], passphrase, noJpegCheck).catch(error => error))).toBe('invalid');
    const rejecting = () => { throw new BackupFormatError('invalid'); };
    expect(problem(await verifyParts(texts, passphrase, rejecting).catch(error => error))).toBe('invalid');
  });
  it('refuses metadata over its size limit', async () => {
    const meta = await saved();
    const huge = structuredClone(meta);
    huge.tables.items = Array.from({ length: 1100 }, (_, n) => ({ ...meta.tables.items[0]!, id: uuid(1000 + n), notes: 'x'.repeat(8000) }));
    expect(problem(await metadataDigest(huge).catch(error => error))).toBe('tooLarge');
  });
});
