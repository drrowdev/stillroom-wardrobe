import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptPart, metadataDigest, partFileName, planParts, sha256Hex, toBase64, type SavedMetadata } from '../../src/domain/export-format';

const owner = '11111111-1111-4111-8111-111111111111';
const exportId = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const image = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-09-25T10:00:00+00:00';
const passphrase = 'a long synthetic passphrase';
const jpeg = new Uint8Array(readFileSync(new URL('../security/fixture.jpg', import.meta.url)));
const script = new URL('../../scripts/verify-backup.mjs', import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const nulls = (columns: string[]) => Object.fromEntries(columns.map(column => [column, null]));
async function backup(bytes = jpeg): Promise<string> {
  const hash = await sha256Hex(bytes);
  const meta: SavedMetadata = { format: 'stillroom-saved', schema_version: 2, export_id: exportId, owner_id: owner, created_at: stamp, tables: {
    profiles: [{ ...nulls(['display_name', 'ui_language', 'timezone', 'currency', 'weather_city', 'latitude', 'longitude', 'created_at', 'updated_at', 'version']), owner_id: owner }],
    style_preferences: [],
    items: [{ ...nulls(['title', 'category', 'subcategory', 'colours', 'brand', 'size_label', 'material', 'seasons', 'formality', 'warmth', 'min_temp',
      'max_temp', 'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage', 'style_tags', 'tags', 'purchase_date', 'purchase_price', 'currency',
      'notes', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more', 'deleted_at', 'created_at', 'updated_at', 'version',
      'pattern', 'sleeve_length', 'garment_length', 'field_provenance']), id: item, owner_id: owner }],
    item_images: [{ id: image, owner_id: owner, item_id: item, state: 'ready', retired_at: null, main_path: `${owner}/${item}/${image}/main.jpg`,
      thumb_path: `${owner}/${item}/${image}/thumb.jpg`, main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: hash, thumb_sha256: hash,
      width: 2, height: 2, alt_text: 'Photo', created_at: stamp, description_version: 1 }],
    item_attributions: [], outfits: [], outfit_items: [], wear_events: [], wear_event_items: [], combination_rules: [], suggestion_feedback: [],
  } };
  const digest = await metadataDigest(meta);
  const plan = planParts(meta);
  const base = { format: 'stillroom-export', schemaVersion: 2, exportId, partCount: plan.length + 1, manifestSha256: digest } as const;
  const directory = mkdtempSync(join(tmpdir(), 'stillroom-verify-'));
  directories.push(directory);
  const parts = [{ ...base, partIndex: 0, manifest: meta, files: [] },
    ...plan.map((refs, index) => ({ ...base, partIndex: index + 1, files: refs.map(ref => ({ imageId: ref.imageId, variant: ref.variant,
      sha256: ref.sha256, byteLength: ref.byteLength, mime: 'image/jpeg' as const, base64: toBase64(bytes) })) }))];
  for (const part of parts) writeFileSync(join(directory, partFileName(exportId, part.partIndex)), JSON.stringify(await encryptPart(part, passphrase)));
  return directory;
}
const run = (args: string[], input = `${passphrase}\n`) => spawnSync(process.execPath, [fileURLToPath(script), ...args],
  { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 });

// PBKDF2 at 600,000 iterations runs per part, and each case spawns Node; the default 5 s is too short under a loaded runner.
describe('offline backup verifier', { timeout: 60_000 }, () => {
  it('verifies a complete backup with a piped passphrase and prints only a summary', async () => {
    const result = run(['--input', await backup()]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Backup verified: 2 parts, 1 items, 1 photos, 1264 photo bytes, metadata sha256 [0-9a-f]{64}\.\n$/);
    expect(result.stdout).not.toContain(passphrase);
  });
  it('fails on a wrong passphrase, a missing part, an unexpected file or a tampered photo', async () => {
    const directory = await backup();
    expect(run(['--input', directory], 'the wrong passphrase!!\n')).toMatchObject({ status: 1, stderr: 'Backup check failed: passphrase.\n' });
    writeFileSync(join(directory, 'notes.txt'), 'x');
    expect(run(['--input', directory]).status).toBe(1);
    rmSync(join(directory, 'notes.txt'));
    rmSync(join(directory, partFileName(exportId, 1)));
    expect(run(['--input', directory])).toMatchObject({ status: 1, stderr: 'Backup check failed: incomplete.\n' });
    const bad = jpeg.slice();
    bad.set([0xff, 0xfe, 0, 4, 0x41, 0x42], 2);
    expect(run(['--input', await backup(bad)]).status).toBe(1);
  });
  it('takes no passphrase from arguments and accepts only --input DIR', async () => {
    const directory = await backup();
    expect(run(['--input', directory, '--passphrase', passphrase]).status).toBe(2);
    expect(run(['--passphrase', passphrase]).status).toBe(2);
    expect(run(['--input', directory], 'short\n').status).toBe(2);
  });
});
