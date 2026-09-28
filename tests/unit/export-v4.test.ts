import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPart, metadataFile, prepareExport } from '../../src/data/export';
import { collectSnapshot } from '../../src/domain/export-run';
import { describeSaved } from '../../src/domain/restore-plan';
import { restoreModeOf } from '../../src/data/restore';
import { assertMetadata, BackupFormatError, decryptPart, projectProvenance } from '../../src/domain/export-format';
import { describePart, parityClient, parityId, parityWorld, PARITY_OWNER, PARITY_PASSPHRASE, sha256, withEntropy, type ParityWorld } from '../fixtures/export-parity';

const expected = JSON.parse(readFileSync(new URL('../fixtures/export-parity.json', import.meta.url), 'utf8'));
const scope = () => ({ ownerId: PARITY_OWNER, signal: new AbortController().signal }) as never;
const imageOf = (world: ParityWorld, id: string) => (world.raw.tables as { item_images: Record<string, unknown>[] }).item_images.find(image => image.id === id)!;
const provenanceRow = (world: ParityWorld, n: number, over: Record<string, unknown> = {}) => ({
  image_id: parityId(3, n), kind: 'ai_edited', origin: 'recorded', model_id: 'gpt-image-2.5-sunburst',
  manifest_id: 'azure-global-image25-sunburst-enhance-v1', stored_sha256: imageOf(world, parityId(3, n)).main_sha256, backup_sha256: null, ...over,
});
const source = (world: ParityWorld, digests?: string[]) => ({
  manifest: async (exportId: string) => ({ ...world.raw, export_id: exportId }),
  attribution: async (id: string) => world.attributions.get(id),
  digest: async () => world.digest,
  provenance: async () => structuredClone(world.provenance),
  provenanceDigest: async () => digests ? digests.shift()! : sha256(JSON.stringify(world.provenance)),
});
const snapshot = (world: ParityWorld, digests?: string[]) => collectSnapshot(source(world, digests), PARITY_OWNER, crypto.randomUUID(), new AbortController().signal);

describe('v4 backups (H5)', { timeout: 120_000 }, () => {
  it('stays the byte-identical v3 export when provenance only covers Trash, pending or retired-and-not-exported images', async () => {
    const world = parityWorld();
    world.provenance = [provenanceRow(world, 901), provenanceRow(world, 902)];
    const client = parityClient(world) as never;
    const result = await withEntropy(async () => {
      const prepared = await prepareExport(client, scope(), new AbortController().signal);
      const parts: string[] = [];
      for (let index = 0; index < prepared.partCount; index++) parts.push(await (await buildPart(client, scope(), prepared, index, PARITY_PASSPHRASE, new AbortController().signal)).text());
      return { prepared, parts, metadata: await metadataFile(prepared).text() };
    });
    expect(result.prepared.manifestSha256).toBe(expected.manifestSha256);
    expect(sha256(result.metadata)).toBe(expected.metadataFileSha256);
    expect(await Promise.all(result.parts.map((text, index) => describePart(index, text)))).toEqual(expected.parts);
    expect(result.metadata).not.toContain('"provenance"');
  });

  it('writes v4 with the projected, sorted provenance of exported images', async () => {
    const world = parityWorld(3, 1000, 100);
    world.provenance = [provenanceRow(world, 2), provenanceRow(world, 900, { origin: 'imported', backup_sha256: imageOf(world, parityId(3, 900)).main_sha256 }), provenanceRow(world, 902)];
    const prepared = await snapshot(world);
    expect(prepared.metadata.schema_version).toBe(4);
    expect(prepared.metadata.provenance).toEqual([
      { imageId: parityId(3, 2), kind: 'ai_edited', modelId: 'gpt-image-2.5-sunburst', manifestId: 'azure-global-image25-sunburst-enhance-v1', backupSha256: imageOf(world, parityId(3, 2)).main_sha256 },
      { imageId: parityId(3, 900), kind: 'ai_edited', modelId: 'gpt-image-2.5-sunburst', manifestId: 'azure-global-image25-sunburst-enhance-v1', backupSha256: imageOf(world, parityId(3, 900)).main_sha256 },
    ]);
    const part = await withEntropy(async () => (await buildPart(parityClient(world) as never, scope(), await prepareExport(parityClient(world) as never, scope(), new AbortController().signal), 0,
      PARITY_PASSPHRASE, new AbortController().signal)).text());
    const head = await decryptPart(part, PARITY_PASSPHRASE);
    expect(head.manifest?.schema_version).toBe(4);
  });

  it('refuses a hash that differs from the exported photo, duplicates and malformed rows', () => {
    const world = parityWorld(2, 1000, 100);
    const images = (world.raw.tables as { item_images: Record<string, unknown>[] }).item_images.filter(image => image.state !== 'pending');
    expect(() => projectProvenance(images, [provenanceRow(world, 1, { stored_sha256: 'f'.repeat(64) })])).toThrow(expect.objectContaining({ problem: 'changed' }));
    expect(() => projectProvenance(images, [provenanceRow(world, 1), provenanceRow(world, 1)])).toThrow(BackupFormatError);
    expect(() => projectProvenance(images, [{ ...provenanceRow(world, 1), extra: 1 }])).toThrow(BackupFormatError);
    expect(() => projectProvenance(images, [provenanceRow(world, 1, { kind: 'other' })])).toThrow(BackupFormatError);
    expect(() => projectProvenance(images, {})).toThrow(BackupFormatError);
  });

  it('maps a provenance change during collection to changed', async () => {
    const world = parityWorld(2, 1000, 100);
    world.provenance = [provenanceRow(world, 1)];
    await expect(snapshot(world, ['a'.repeat(64), 'b'.repeat(64)])).rejects.toMatchObject({ problem: 'changed' });
  });

  it('keeps the provenance key only on v4 metadata', async () => {
    const world = parityWorld(2, 1000, 100);
    const v3 = (await snapshot(world)).metadata;
    expect(v3.schema_version).toBe(3);
    expect(() => assertMetadata({ ...v3, provenance: [] })).toThrow(BackupFormatError);
    world.provenance = [provenanceRow(world, 1)];
    const v4 = (await snapshot(world)).metadata;
    expect(() => assertMetadata(v4)).not.toThrow();
    expect(() => assertMetadata({ ...v4, provenance: [] })).toThrow(BackupFormatError);
    expect(() => assertMetadata({ ...v4, provenance: [{ ...v4.provenance![0]!, backupSha256: 'f'.repeat(64) }] })).toThrow(BackupFormatError);
  });

  it('carries v4 records to the restore plan and fixes the mode of each photo (Q6)', async () => {
    const world = parityWorld(2, 1000, 100);
    world.provenance = [provenanceRow(world, 1)];
    const data = describeSaved((await snapshot(world)).metadata, 4);
    const photos = data.items.flatMap(item => item.photos);
    const edited = photos.find(photo => photo.sourceId === parityId(3, 1))!;
    expect(edited.provenance).toEqual({ modelId: 'gpt-image-2.5-sunburst', manifestId: 'azure-global-image25-sunburst-enhance-v1',
      backupSha256: imageOf(world, parityId(3, 1)).main_sha256 });
    expect(photos.filter(photo => photo !== edited).every(photo => photo.provenance === null)).toBe(true);
    const hash = edited.provenance!.backupSha256;
    expect(restoreModeOf(edited, { main: 'preserved', mainSha256: hash })).toBe('v4');
    expect(restoreModeOf(edited, { main: 'reencoded', mainSha256: 'f'.repeat(64) })).toBe('unlabelled');
    expect(restoreModeOf(edited, { main: 'preserved', mainSha256: 'f'.repeat(64) })).toBe('unlabelled');
    expect(restoreModeOf({ ...edited, provenance: null }, { main: 'reencoded', mainSha256: 'f'.repeat(64) })).toBe('legacy');
  });
});
