import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/data/errors';
import { buildPart, metadataFile, prepareExport } from '../../src/data/export';
import { assemblePart, collectSnapshot, fromMetadata } from '../../src/domain/export-run';
import { BackupFormatError, decryptPart } from '../../src/domain/export-format';
import { describePart, parityClient, parityWorld, PARITY_EXPORT, PARITY_OWNER, PARITY_PASSPHRASE, sha256, withEntropy } from '../fixtures/export-parity';

// Captured from src/data/export.ts before it moved onto export-run (see `capturedFrom`); both paths must still reproduce it byte for byte.
const expected = JSON.parse(readFileSync(new URL('../fixtures/export-parity.json', import.meta.url), 'utf8'));
const scope = (signal = new AbortController().signal) => ({ ownerId: PARITY_OWNER, signal }) as never;

describe('export parity with the pre-refactor browser export', { timeout: 120_000 }, () => {
  it('the browser export reproduces every part, the metadata file and the plan', async () => {
    const world = parityWorld();
    const client = parityClient(world) as never;
    const signal = new AbortController().signal;
    const result = await withEntropy(async () => {
      const prepared = await prepareExport(client, scope(), signal);
      const parts: string[] = [];
      for (let index = 0; index < prepared.partCount; index++) parts.push(await (await buildPart(client, scope(), prepared, index, PARITY_PASSPHRASE, signal)).text());
      return { prepared, parts, metadata: await metadataFile(prepared).text() };
    });
    expect(result.prepared).toMatchObject({ exportId: expected.exportId, manifestSha256: expected.manifestSha256, partCount: expected.partCount,
      items: expected.items, photos: expected.photos });
    expect(sha256(JSON.stringify(result.prepared.plan))).toBe(expected.planSha256);
    expect(sha256(result.metadata)).toBe(expected.metadataFileSha256);
    expect(await Promise.all(result.parts.map((text, index) => describePart(index, text)))).toEqual(expected.parts);
  });

  it('the shared steps the CLI uses reproduce the same parts', async () => {
    const world = parityWorld();
    const source = {
      manifest: async (exportId: string) => ({ ...world.raw, export_id: exportId }),
      attribution: async (id: string) => world.attributions.get(id),
    };
    const parts = await withEntropy(async () => {
      const prepared = await collectSnapshot(source, PARITY_OWNER, crypto.randomUUID(), new AbortController().signal);
      const texts: string[] = [];
      for (let index = 0; index < prepared.partCount; index++) {
        texts.push(JSON.stringify(await assemblePart(prepared, index, async ref => world.objects.get(ref.path)!, PARITY_PASSPHRASE)));
      }
      return texts;
    });
    expect(await Promise.all(parts.map((text, index) => describePart(index, text)))).toEqual(expected.parts);
  });

  it('a snapshot rebuilt from exported metadata plans the same parts', async () => {
    const world = parityWorld();
    const first = await withEntropy(async () => {
      const prepared = await prepareExport(parityClient(world) as never, scope(), new AbortController().signal);
      return (await buildPart(parityClient(world) as never, scope(), prepared, 0, PARITY_PASSPHRASE, new AbortController().signal)).text();
    });
    const head = await decryptPart(first, PARITY_PASSPHRASE);
    const rebuilt = fromMetadata(head.manifest!, head.manifestSha256);
    expect(rebuilt).toMatchObject({ exportId: PARITY_EXPORT, ownerId: PARITY_OWNER, partCount: expected.partCount, manifestSha256: expected.manifestSha256 });
    expect(sha256(JSON.stringify(rebuilt.plan))).toBe(expected.planSha256);
  });
});

describe('browser export behaviour kept by the refactor', () => {
  it('maps a changed item, a changed photo and a moved snapshot to backup.changed', async () => {
    const world = parityWorld(2, 1000, 100);
    const signal = new AbortController().signal;
    const gone = parityWorld(2, 1000, 100);
    gone.attributions.delete([...gone.attributions.keys()][0]!);
    await expect(prepareExport(parityClient(gone) as never, scope(), signal)).rejects.toMatchObject({ messageKey: 'backup.changed' });
    const prepared = await prepareExport(parityClient(world) as never, scope(), signal);
    const altered = parityWorld(2, 1000, 100);
    const path = prepared.plan[0]![0]!.path;
    altered.objects.set(path, new Uint8Array(1000));
    await expect(buildPart(parityClient(altered) as never, scope(), prepared, 1, PARITY_PASSPHRASE, signal)).rejects.toMatchObject({ messageKey: 'backup.changed' });
    altered.objects.delete(path);
    await expect(buildPart(parityClient(altered) as never, scope(), prepared, 1, PARITY_PASSPHRASE, signal)).rejects.toMatchObject({ messageKey: 'backup.changed' });
    let calls = 0;
    const moving = { ...parityClient(world), rpc(name: string, args: Record<string, unknown>) {
      const inner = parityClient(world).rpc(name, args);
      return { abortSignal: async (abort: AbortSignal) => {
        const result = await inner.abortSignal(abort);
        if (name === 'export_manifest' && calls++ === 1) {
          const raw = result.data as { tables: { items: Record<string, unknown>[] } };
          return { data: { ...raw, tables: { ...raw.tables, items: raw.tables.items.map(item => ({ ...item, version: 9 })) } }, error: null };
        }
        return result;
      } };
    } };
    await expect(prepareExport(moving as never, scope(), signal)).rejects.toMatchObject({ messageKey: 'backup.changed' });
  });

  it('refuses another owner or an out-of-range part, and honours cancellation after encryption', async () => {
    const world = parityWorld(1, 1000, 100);
    const prepared = await prepareExport(parityClient(world) as never, scope(), new AbortController().signal);
    const other = { ownerId: '99999999-9999-4999-8999-999999999999', signal: new AbortController().signal } as never;
    await expect(buildPart(parityClient(world) as never, other, prepared, 0, PARITY_PASSPHRASE, new AbortController().signal)).rejects.toBeInstanceOf(AppError);
    await expect(buildPart(parityClient(world) as never, scope(), prepared, prepared.partCount, PARITY_PASSPHRASE, new AbortController().signal))
      .rejects.toMatchObject({ messageKey: 'error.unavailable' });
    const controller = new AbortController();
    const cancelling = buildPart(parityClient(world) as never, scope(controller.signal), prepared, 0, PARITY_PASSPHRASE, new AbortController().signal);
    controller.abort();
    await expect(cancelling).rejects.toMatchObject({ name: 'AbortError' });
    const blob = await buildPart(parityClient(world) as never, scope(), prepared, 0, PARITY_PASSPHRASE, new AbortController().signal);
    expect(blob.type).toBe('application/octet-stream');
  });

  it('the shared steps report a changed photo as a format problem', async () => {
    const world = parityWorld(1, 1000, 100);
    const source = { manifest: async (id: string) => ({ ...world.raw, export_id: id }), attribution: async (id: string) => world.attributions.get(id) };
    const prepared = await collectSnapshot(source, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal);
    await expect(assemblePart(prepared, 1, async () => new Uint8Array(3), PARITY_PASSPHRASE)).rejects.toEqual(new BackupFormatError('changed'));
    await expect(assemblePart(prepared, 5, async () => new Uint8Array(3), PARITY_PASSPHRASE)).rejects.toEqual(new BackupFormatError('invalid'));
  });
});
