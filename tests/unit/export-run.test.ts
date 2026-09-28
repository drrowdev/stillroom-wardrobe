import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/data/errors';
import { buildPart, metadataFile, prepareExport } from '../../src/data/export';
import { assemblePart, collectSnapshot, fromMetadata, sameRows } from '../../src/domain/export-run';
import { BackupFormatError, decryptPart } from '../../src/domain/export-format';
import { describePart, parityClient, parityWorld, PARITY_EXPORT, PARITY_OWNER, PARITY_PASSPHRASE, sha256, withEntropy } from '../fixtures/export-parity';

// Captured from src/data/export.ts before it moved onto export-run (see `capturedFrom`); both paths must still reproduce it byte for byte.
const expected = JSON.parse(readFileSync(new URL('../fixtures/export-parity.json', import.meta.url), 'utf8'));
const noProvenance = { provenance: async () => [], provenanceDigest: async () => 'e'.repeat(64) };
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
      digest: async () => world.digest, ...noProvenance,
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

  it('refuses a snapshot when tag history changes while it is read, with no item or photo change', async () => {
    const world = parityWorld(2, 1000, 100);
    let reads = 0;
    const importing = { manifest: async (id: string) => ({ ...world.raw, export_id: id }), attribution: async (id: string) => world.attributions.get(id),
      digest: async () => (reads++ === 0 ? world.digest : 'f'.repeat(64)), ...noProvenance };
    await expect(collectSnapshot(importing, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal)).rejects.toEqual(new BackupFormatError('changed'));
    const malformed = { ...importing, digest: async () => 'not-a-digest' };
    await expect(collectSnapshot(malformed, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal)).rejects.toEqual(new BackupFormatError('invalid'));
    const steady = { ...importing, digest: async () => world.digest, ...noProvenance };
    await expect(collectSnapshot(steady, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal)).resolves.toMatchObject({ items: 2 });
  });

  it('the shared steps report a changed photo as a format problem', async () => {
    const world = parityWorld(1, 1000, 100);
    const source = { manifest: async (id: string) => ({ ...world.raw, export_id: id }), attribution: async (id: string) => world.attributions.get(id),
      digest: async () => world.digest, ...noProvenance };
    const prepared = await collectSnapshot(source, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal);
    await expect(assemblePart(prepared, 1, async () => new Uint8Array(3), PARITY_PASSPHRASE)).rejects.toEqual(new BackupFormatError('changed'));
    await expect(assemblePart(prepared, 5, async () => new Uint8Array(3), PARITY_PASSPHRASE)).rejects.toEqual(new BackupFormatError('invalid'));
  });
});

describe('the two manifest reads are compared as row sets', () => {
  type Tables = { items: Record<string, unknown>[]; item_images: Record<string, unknown>[] };
  // The first read is the world as it is; `second` rewrites the items and photos of the second read only.
  const snapshot = (world: ReturnType<typeof parityWorld>, second: (tables: Tables) => Tables, first: (tables: Tables) => Tables = tables => tables) => {
    let reads = 0;
    const raw = world.raw as unknown as { tables: Tables };
    const source = {
      manifest: async (id: string) => {
        const change = reads++ === 0 ? first : second;
        const tables = change({ items: raw.tables.items.map(row => ({ ...row })), item_images: raw.tables.item_images.map(row => ({ ...row })) });
        return { ...world.raw, export_id: id, tables: { ...raw.tables, ...tables } };
      },
      attribution: async (id: string) => world.attributions.get(id), digest: async () => world.digest, ...noProvenance,
    };
    return collectSnapshot(source, PARITY_OWNER, PARITY_EXPORT, new AbortController().signal);
  };
  const reversed = (tables: Tables): Tables => ({ items: [...tables.items].reverse(), item_images: [...tables.item_images].reverse() });

  it('identical rows in another order are the same snapshot, with the same metadata', async () => {
    const world = parityWorld(3, 1000, 100);
    const raw = world.raw as unknown as { tables: Tables };
    expect(raw.tables.items.length).toBeGreaterThan(1);
    expect(raw.tables.item_images.length).toBeGreaterThan(1);
    const steady = await snapshot(world, tables => tables);
    await expect(snapshot(world, reversed)).resolves.toMatchObject({ manifestSha256: steady.manifestSha256, items: steady.items, photos: steady.photos });
    await expect(snapshot(world, tables => tables, reversed)).resolves.toMatchObject({ manifestSha256: steady.manifestSha256 });
    await expect(snapshot(world, ({ items, item_images }) => ({ items: [...items.slice(1), items[0]!], item_images })))
      .resolves.toMatchObject({ manifestSha256: steady.manifestSha256 });
  });

  it('a changed field, or a missing or extra item or photo, is still a change in any order', async () => {
    const world = parityWorld(3, 1000, 100);
    const changed = new BackupFormatError('changed');
    const cases: ((tables: Tables) => Tables)[] = [
      ({ items, item_images }) => ({ items: items.map((row, index) => index === 1 ? { ...row, title: `${String(row.title)} (edited)` } : row), item_images }),
      ({ items, item_images }) => ({ items, item_images: item_images.map((row, index) => index === 0 ? { ...row, alt_text: 'A different description' } : row) }),
      ({ items, item_images }) => ({ items: items.slice(1), item_images }),
      ({ items, item_images }) => ({ items, item_images: item_images.slice(0, -1) }),
      ({ items, item_images }) => ({ items: [...items, { ...items[0]!, id: crypto.randomUUID() }], item_images }),
      ({ items, item_images }) => ({ items, item_images: [...item_images, { ...item_images[0]!, id: crypto.randomUUID() }] }),
    ];
    for (const change of cases) {
      await expect(snapshot(world, change)).rejects.toEqual(changed);
      await expect(snapshot(world, tables => reversed(change(tables)))).rejects.toEqual(changed);
    }
  });

  it('a repeated id in either read is refused, even with the same number of rows', async () => {
    const world = parityWorld(3, 1000, 100);
    const invalid = new BackupFormatError('invalid');
    const repeatItem = ({ items, item_images }: Tables): Tables => ({ items: [items[0]!, items[0]!, ...items.slice(2)], item_images });
    const repeatImage = ({ items, item_images }: Tables): Tables => ({ items, item_images: [...item_images.slice(0, -1), item_images[0]!] });
    await expect(snapshot(world, repeatItem)).rejects.toEqual(invalid);
    await expect(snapshot(world, repeatImage)).rejects.toEqual(invalid);
    await expect(snapshot(world, tables => tables, repeatItem)).rejects.toEqual(invalid);
    await expect(snapshot(world, tables => tables, repeatImage)).rejects.toEqual(invalid);
  });

  it('compares whole rows by id', () => {
    const a = { id: 'a', title: 'Shirt', colours: ['olive', 'navy'] }, b = { id: 'b', title: 'Trousers', colours: [] };
    expect(sameRows([a, b], [b, a])).toBe(true);
    expect(sameRows([a, b], [{ colours: ['olive', 'navy'], title: 'Shirt', id: 'a' }, b])).toBe(true);
    expect(sameRows([a, b], [b, { ...a, colours: ['navy', 'olive'] }])).toBe(false);
    expect(sameRows([a, b], [a])).toBe(false);
    expect(sameRows([a], [a, b])).toBe(false);
    expect(sameRows([], [])).toBe(true);
    expect(() => sameRows([a, a], [a, b])).toThrow(new BackupFormatError('invalid'));
    expect(() => sameRows([a, b], [b, b])).toThrow(new BackupFormatError('invalid'));
    expect(() => sameRows([{ title: 'No id' }], [{ title: 'No id' }])).toThrow(new BackupFormatError('invalid'));
  });
});
