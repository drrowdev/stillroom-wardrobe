import { describe, expect, it, vi } from 'vitest';
import { canonical, encryptPart, partFileName, sha256Hex, toBase64 } from '../../src/domain/export-format';
import { preflightBackup, RestoreGarmentError } from '../../src/data/restore';
import type { RestorePhotoDeps } from '../../src/images/restore-photo';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

const owner = '11111111-1111-4111-8111-111111111111';
const exportId = '22222222-2222-4222-8222-222222222222';
const passphrase = 'correct horse battery staple';
const id = (n: number, tail = '5555') => `${tail}${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
const garment = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n), owner_id: owner, title: `Fictional coat ${n}`, category: 'outerwear', colours: ['navy'], seasons: ['winter'],
  style_tags: [], tags: [], notes: '', currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active',
  exclude_suggestions: false, wear_more: false, deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  version: 1, ...extra,
});

async function backupOf(items: Record<string, unknown>[]) {
  const profiles = [{ owner_id: owner, display_name: 'Owner', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', version: 1 }];
  // Only garments with a ready photo are saved in a backup; each has one small valid photo, which Check never decodes here.
  const jpeg = flatJpeg({ width: 16, height: 16 }), hash = await sha256Hex(jpeg);
  const images = items.map((item, n) => ({ id: id(n, '4444'), owner_id: owner, item_id: item.id, state: 'ready', retired_at: null,
    main_path: `${owner}/${String(item.id)}/${id(n, '4444')}/main.jpg`, thumb_path: `${owner}/${String(item.id)}/${id(n, '4444')}/thumb.jpg`,
    main_bytes: jpeg.length, thumb_bytes: jpeg.length, main_sha256: hash, thumb_sha256: hash, width: 16, height: 16, alt_text: 'A coat',
    created_at: '2026-01-01T00:00:00Z' }));
  const files = images.flatMap(image => (['main', 'thumb'] as const).map(variant => ({ imageId: image.id, variant, sha256: hash,
    byteLength: jpeg.length, mime: 'image/jpeg', base64: toBase64(jpeg) })));
  const manifest = { export_id: exportId, owner_id: owner, created_at: '2026-01-02T00:00:00Z', tables: { profiles, items, item_images: images } };
  const part = { format: 'stillroom-export' as const, schemaVersion: 1, exportId, partIndex: 0, partCount: 1,
    manifestSha256: await sha256Hex(canonical(manifest)), files, manifest };
  const text = JSON.stringify(await encryptPart(part as never, passphrase));
  return [{ name: partFileName(exportId, 0), size: text.length, text: async () => text }];
}
// Counts every call into the photo decoder, which then fails: a refused garment must stop Check before any photo is decoded.
let decoded = 0;
const deps = new Proxy({}, { get: () => vi.fn(() => { decoded++; throw new Error('decoder started'); }) }) as unknown as RestorePhotoDeps;
const refusal = async (items: Record<string, unknown>[]) => {
  decoded = 0;
  try { await preflightBackup(await backupOf(items), passphrase, new AbortController().signal, deps); }
  catch (error) {
    if (error instanceof RestoreGarmentError) return { key: error.messageKey, item: error.item, total: error.total, text: error.message };
    return String(error);
  }
  return 'passed';
};

describe('restore Check refuses a garment it could not save', () => {
  it('accepts valid garments, including retained free-text colours and duplicate tags, and goes on to the photos', async () => {
    // The stub decoder fails, so reaching it (and its restore.invalid) shows every garment passed.
    expect(await refusal([garment(0), garment(1, { colours: ['Petrol blue', 'Petrol blue'], tags: ['wool', 'wool'] })])).toBe('AppError: restore.invalid');
    expect(decoded).toBeGreaterThan(0);
  });
  it.each([
    ['an empty title', { title: '' }],
    ['an unknown category', { category: 'cape' }],
    ['a number where text is expected', { brand: 42 }],
    ['an integer out of range', { formality: 9 }],
    ['a price that is not a price', { purchase_price: 'twelve' }],
    ['a colour that is not text', { colours: ['navy', 7] }],
    ['a missing required value', { notes: null }],
  ])('refuses the whole backup for %s, naming only the garment position', async (_label, bad) => {
    const result = await refusal([garment(0), garment(1), garment(2, bad), garment(3)]);
    expect(result).toEqual({ key: 'restore.invalidGarment', item: 3, total: 4, text: 'restore.invalidGarment' });
    expect(decoded).toBe(0);
  });
  it('names the first garment that fails', async () => {
    expect(await refusal([garment(0, { title: '' }), garment(1, { formality: -1 })])).toMatchObject({ item: 1, total: 2 });
  });
});
