import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKUP_LIMITS, BackupFormatError, canonical, encryptPart, partFileName, sha256Hex, toBase64 } from '../../src/domain/export-format';
import {
  chainState, missingPart, normalizeV1Manifest, readBackup, restoreId, restoredKinds, selectBackupFiles,
  type ChainImage, type ChainTarget,
} from '../../src/domain/restore-plan';

const owner = '11111111-1111-4111-8111-111111111111';
const target = '33333333-3333-4333-8333-333333333333';
const exportId = '22222222-2222-4222-8222-222222222222';
const passphrase = 'correct horse battery staple';
const jpeg = new Uint8Array(readFileSync(new URL('../security/fixture.jpg', import.meta.url)));
const problem = async (run: () => unknown) => {
  try { await run(); } catch (error) { return error instanceof BackupFormatError ? error.problem : String(error); }
  return 'passed';
};

describe('backup file selection', () => {
  const file = (index: number, size = 100, id = exportId) => ({ name: partFileName(id, index), size });
  it('accepts the parts of one backup in any order', () => {
    expect(selectBackupFiles([file(2), file(0), file(1)])).toEqual({ exportId, indices: [2, 0, 1] });
    expect(missingPart([2, 0, 1], 3)).toBeNull();
    expect(missingPart([0, 2], 3)).toBe(1);
  });
  it('refuses other names, mixed backups, duplicates and a part index beyond the count', async () => {
    expect(await problem(() => selectBackupFiles([]))).toBe('incomplete');
    expect(await problem(() => selectBackupFiles([{ name: 'wardrobe.json.enc', size: 1 }]))).toBe('invalid');
    expect(await problem(() => selectBackupFiles([file(0), file(1, 100, target)]))).toBe('invalid');
    expect(await problem(() => selectBackupFiles([file(0), file(0)]))).toBe('invalid');
    expect(await problem(() => selectBackupFiles([{ name: `stillroom-${exportId}-01.json.enc`, size: 1 }]))).toBe('invalid');
    expect(missingPart([0, 1, 3], 3)).toBe(2);
    expect(missingPart([1], 1)).toBe(0);
    expect(await problem(() => missingPart([0, 1, 3], 2))).toBe('invalid');
  });
  it('checks the part count, the part size and the total encrypted size before reading', async () => {
    const many = Array.from({ length: BACKUP_LIMITS.parts + 1 }, (_, index) => file(index));
    expect(await problem(() => selectBackupFiles(many))).toBe('tooLarge');
    expect(await problem(() => selectBackupFiles([file(0, BACKUP_LIMITS.encryptedPartBytes + 1)]))).toBe('tooLarge');
    const full = Array.from({ length: 192 }, (_, index) => file(index, BACKUP_LIMITS.encryptedPartBytes));
    expect(full.reduce((sum, entry) => sum + entry.size, 0)).toBe(BACKUP_LIMITS.totalEncryptedBytes);
    expect(await problem(() => selectBackupFiles(full))).toBe('passed');
    expect(await problem(() => selectBackupFiles([...full, file(192, 1)]))).toBe('tooLarge');
  });
});

describe('restored IDs', () => {
  it('are version 8 UUIDs bound to the version, account, backup, table and source ID', async () => {
    const id = await restoreId(2, target, exportId, 'items', owner);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await restoreId(2, target, exportId, 'items', owner)).toBe(id);
    const hex = await sha256Hex(`stillroom/restore/v2|${target}|${exportId}|items|${owner}`);
    expect(id.replaceAll('-', '').slice(0, 12)).toBe(hex.slice(0, 12));
    const others = await Promise.all([restoreId(1, target, exportId, 'items', owner), restoreId(2, owner, exportId, 'items', owner),
      restoreId(2, target, target, 'items', owner), restoreId(2, target, exportId, 'outfits', owner), restoreId(2, target, exportId, 'items', target)]);
    expect(new Set([id, ...others]).size).toBe(6);
  });
});

describe('restored provenance kinds', () => {
  it('keeps kinds, marks unlabelled values unknown, drops AI kinds the analyzer cannot fill and skips empty fields', () => {
    const kinds = restoredKinds({ category: 'top', colours: ['navy'], material: 'wool', brand: 'Fictional', notes: 'x', size_label: '',
      seasons: [], field_provenance: { category: { kind: 'ai_observed', revision: 4 }, colours: { kind: 'user' }, material: { kind: 'ai_observed' },
        brand: { kind: 'invented' }, size_label: { kind: 'user' } } });
    expect(kinds).toMatchObject({ category: 'ai_observed', colours: 'user', material: 'unknown', brand: 'unknown' });
    expect(kinds).not.toHaveProperty('size_label');
    expect(kinds).not.toHaveProperty('seasons');
  });
});

describe('version 1 manifests', () => {
  const image = { id: '44444444-4444-4444-8444-444444444444', owner_id: owner, item_id: '55555555-5555-4555-8555-555555555555', state: 'ready' };
  it('fills later columns with their defaults', () => {
    const raw = normalizeV1Manifest({ export_id: exportId, owner_id: owner, created_at: '2026-01-02T00:00:00Z',
      tables: { item_images: [image] } }, exportId);
    expect(raw.tables.item_images[0]).toMatchObject({ ...image, description_version: 1 });
    expect(raw.tables.items).toEqual([]);
  });
  it('refuses unknown tables and columns, other owners, drafts and a different backup', async () => {
    const base = { export_id: exportId, owner_id: owner, created_at: '2026-01-02T00:00:00Z' };
    expect(await problem(() => normalizeV1Manifest({ ...base, tables: { trips: [] } }, exportId))).toBe('invalid');
    expect(await problem(() => normalizeV1Manifest({ ...base, tables: { item_images: [{ ...image, secret: 1 }] } }, exportId))).toBe('invalid');
    expect(await problem(() => normalizeV1Manifest({ ...base, tables: { item_images: [{ ...image, owner_id: target }] } }, exportId))).toBe('invalid');
    expect(await problem(() => normalizeV1Manifest({ ...base, tables: { item_images: [{ ...image, state: 'pending' }] } }, exportId))).toBe('invalid');
    expect(await problem(() => normalizeV1Manifest({ ...base, tables: {} }, target))).toBe('invalid');
  });

  it('reads a reference-exporter backup, checking the hash of the manifest as written', async () => {
    const item = '55555555-5555-4555-8555-555555555555', photo = '44444444-4444-4444-8444-444444444444';
    const hash = await sha256Hex(jpeg);
    const manifest = { export_id: exportId, owner_id: owner, created_at: '2026-01-02T00:00:00Z', tables: {
      profiles: [{ owner_id: owner, display_name: 'Owner', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 }],
      items: [{ id: item, owner_id: owner, title: 'Fictional coat', category: 'outerwear', colours: [], seasons: [], style_tags: [], tags: [],
        favourite: false, availability: 'available', lifecycle: 'active', exclude_suggestions: false, wear_more: false, deleted_at: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 }],
      item_images: [{ id: photo, owner_id: owner, item_id: item, state: 'ready', retired_at: null, main_path: `${owner}/${item}/${photo}/main.jpg`,
        thumb_path: `${owner}/${item}/${photo}/thumb.jpg`, main_bytes: jpeg.length, thumb_bytes: jpeg.length, main_sha256: hash, thumb_sha256: hash,
        width: 2, height: 2, alt_text: 'A coat', created_at: '2026-01-01T00:00:00Z' }] } };
    const files = (['main', 'thumb'] as const).map(variant => ({ imageId: photo, variant, sha256: hash, byteLength: jpeg.length,
      mime: 'image/jpeg' as const, base64: toBase64(jpeg) }));
    const part = { format: 'stillroom-export' as const, schemaVersion: 1, exportId, partIndex: 0, partCount: 1,
      manifestSha256: await sha256Hex(canonical(manifest)), files, manifest };
    const text = JSON.stringify(await encryptPart(part as never, passphrase));
    const checked: string[] = [];
    const backup = await readBackup({ count: 1, exportId, read: async () => text }, passphrase, (_bytes, variant) => { checked.push(variant); });
    expect(backup.data.version).toBe(1);
    expect(backup.data.items.map(entry => [entry.row.title, entry.photos.length])).toEqual([['Fictional coat', 1]]);
    expect(checked).toEqual(['main', 'thumb']);
    expect(Array.from(await backup.read(photo, 'main'))).toEqual(Array.from(jpeg));
    expect(await restoreId(backup.data.version, target, exportId, 'items', item)).not.toBe(await restoreId(2, target, exportId, 'items', item));

    const tampered = { ...part, manifestSha256: await sha256Hex(canonical({ ...manifest, created_at: '2026-01-03T00:00:00Z' })) };
    const bad = JSON.stringify(await encryptPart(tampered as never, passphrase));
    expect(await problem(() => readBackup({ count: 1, read: async () => bad }, passphrase, () => undefined))).toBe('invalid');
    expect(await problem(() => readBackup({ count: 1, read: async () => text }, `${passphrase}!`, () => undefined))).toBe('passphrase');
  }, 60_000);

  it('reads a version 1 part 0 larger than the version 2 metadata limit, and refuses one that is not version 1', async () => {
    const id = (n: number, tail: string) => `${tail}${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
    const bytes = (length: number, seed: number) => new Uint8Array(length).map((_, index) => (index * seed + 7) & 255);
    const items: Record<string, unknown>[] = [], images: Record<string, unknown>[] = [], files: Record<string, unknown>[] = [];
    let thumb = new Uint8Array();
    for (let n = 0; n < 16; n++) {
      const item = id(n, '5555'), photo = id(n, '4444');
      const main = bytes(500_000, 31 + n * 2);
      thumb = bytes(60_000, 17 + n * 2);
      const [mainHash, thumbHash] = [await sha256Hex(main), await sha256Hex(thumb)];
      items.push({ id: item, owner_id: owner, title: `Fictional coat ${n}`, category: 'outerwear', colours: [], seasons: [], style_tags: [], tags: [],
        favourite: false, availability: 'available', lifecycle: 'active', exclude_suggestions: false, wear_more: false, deleted_at: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 });
      images.push({ id: photo, owner_id: owner, item_id: item, state: 'ready', retired_at: null, main_path: `${owner}/${item}/${photo}/main.jpg`,
        thumb_path: `${owner}/${item}/${photo}/thumb.jpg`, main_bytes: main.length, thumb_bytes: thumb.length, main_sha256: mainHash,
        thumb_sha256: thumbHash, width: 1200, height: 1600, alt_text: 'A coat', created_at: '2026-01-01T00:00:00Z' });
      files.push({ imageId: photo, variant: 'main', sha256: mainHash, byteLength: main.length, mime: 'image/jpeg', base64: toBase64(main) },
        { imageId: photo, variant: 'thumb', sha256: thumbHash, byteLength: thumb.length, mime: 'image/jpeg', base64: toBase64(thumb) });
    }
    const manifest = { export_id: exportId, owner_id: owner, created_at: '2026-01-02T00:00:00Z', tables: {
      profiles: [{ owner_id: owner, display_name: 'Owner', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 }], items, item_images: images } };
    const part = { format: 'stillroom-export' as const, schemaVersion: 1, exportId, partIndex: 0, partCount: 1,
      manifestSha256: await sha256Hex(canonical(manifest)), files, manifest };
    const text = JSON.stringify(await encryptPart(part as never, passphrase));
    expect(text.length).toBeGreaterThan(BACKUP_LIMITS.metadataPartBytes);
    expect(text.length).toBeLessThan(BACKUP_LIMITS.encryptedPartBytes);
    const backup = await readBackup({ count: 1, exportId, read: async () => text }, passphrase, () => undefined);
    expect(backup.data.version).toBe(1);
    expect(backup.data.items).toHaveLength(16);
    expect(backup.fileBytes).toBe(16 * 560_000);
    expect(Array.from(await backup.read(id(15, '4444'), 'thumb'))).toEqual(Array.from(thumb));
    expect(await problem(() => readBackup({ count: 1, read: async () => text }, `${passphrase}!`, () => undefined))).toBe('passphrase');
    const v2 = JSON.stringify(await encryptPart({ ...part, schemaVersion: 2 } as never, passphrase));
    expect(await problem(() => readBackup({ count: 1, read: async () => v2 }, passphrase, () => undefined))).toBe('tooLarge');
  }, 120_000);
});

describe('photo chains resume only from a completed prefix', () => {
  const targets: ChainTarget[] = ['p0', 'p1', 'p2'].map(imageId => ({ imageId, altText: `alt ${imageId}`, width: 2, height: 2 }));
  const img = (id: string, state: ChainImage['state'], altText = `alt ${id}`): ChainImage => ({ id, state, altText, width: 2, height: 2 });
  it('starts new, resumes and completes', () => {
    expect(chainState(targets, [])).toEqual({ kind: 'new' });
    expect(chainState(targets, [img('p0', 'pending')])).toEqual({ kind: 'resume', completed: -1, pending: true });
    // Right after photo 0 was saved: photo 0 is current, the rest remain.
    expect(chainState(targets, [img('p0', 'ready')])).toEqual({ kind: 'resume', completed: 0, pending: false });
    // After an intermediate replacement, the latest completed photo is current while a later one remains.
    expect(chainState(targets, [img('p0', 'retired'), img('p1', 'ready')])).toEqual({ kind: 'resume', completed: 1, pending: false });
    expect(chainState(targets, [img('p0', 'retired'), img('p1', 'ready'), img('p2', 'pending')])).toEqual({ kind: 'resume', completed: 1, pending: true });
    expect(chainState(targets, [img('p0', 'retired'), img('p1', 'retired'), img('p2', 'ready')])).toEqual({ kind: 'complete' });
  });
  it('treats any other state as a conflict', () => {
    expect(chainState(targets, [img('p0', 'ready'), img('p1', 'ready')]).kind).toBe('conflict');
    expect(chainState(targets, [img('p0', 'retired')]).kind).toBe('conflict');
    expect(chainState(targets, [img('p0', 'ready', 'edited')]).kind).toBe('conflict');
    expect(chainState(targets, [img('p0', 'ready'), img('p2', 'pending')]).kind).toBe('conflict');
    expect(chainState(targets, [img('p0', 'ready'), img('other', 'retired')]).kind).toBe('conflict');
    expect(chainState(targets, [img('p0', 'retired'), img('p1', 'retired'), img('p2', 'retired')]).kind).toBe('conflict');
  });
});
