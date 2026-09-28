// The export steps shared by the browser Backup (src/data/export.ts) and scripts/export-own.mjs. Transport is injected;
// format, crypto, projection and planning stay in export-format.ts. The explicit extension lets Node load this file too.
import {
  BackupFormatError, canonical, encryptPart, metadataDigest, planParts, projectSaved, readRawManifest, savedItemIds, sha256Hex, toBase64,
  type Envelope, type ExportPart, type FileEntry, type FileRef, type RawManifest, type SavedMetadata,
} from './export-format.ts';

export type PreparedSnapshot = {
  exportId: string; ownerId: string; metadata: SavedMetadata; manifestSha256: string; plan: FileRef[][]; partCount: number;
  items: number; photos: number;
};
// `manifest` returns the raw export_manifest result, `attribution` one saved item's item_attribution_history_v2 and
// `digest` the attribution_digest of all the owner's tag history; `provenance` and `provenanceDigest` are
// image_provenance_v1 and image_provenance_digest_v1.
export type SnapshotSource = {
  manifest: (exportId: string, signal: AbortSignal) => Promise<unknown>;
  attribution: (itemId: string, signal: AbortSignal) => Promise<unknown>;
  digest: (signal: AbortSignal) => Promise<unknown>;
  provenance: (signal: AbortSignal) => Promise<unknown>;
  provenanceDigest: (signal: AbortSignal) => Promise<unknown>;
};
export type FetchFile = (ref: FileRef) => Promise<Uint8Array>;

async function manifest(source: SnapshotSource, ownerId: string, exportId: string, signal: AbortSignal): Promise<RawManifest> {
  return readRawManifest(await source.manifest(exportId, signal), ownerId, exportId);
}

async function digest(source: SnapshotSource, signal: AbortSignal, which: 'digest' | 'provenanceDigest' = 'digest'): Promise<string> {
  const value = await source[which](signal);
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new BackupFormatError('invalid');
  return value;
}

// The tag-history digest, one snapshot, the attribution of each saved item, then a second snapshot and digest: if items,
// photos or any tag history changed in between, the backup is refused rather than mixing two states. Tag history is
// covered by the digest, never by item versions (restore relies on a version equal to the photo-chain length).
// Photo provenance is bracketed the same way by its own digest, outside the unchanged export manifest.
export async function collectSnapshot(source: SnapshotSource, ownerId: string, exportId: string, signal: AbortSignal): Promise<PreparedSnapshot> {
  const provenanceBefore = await digest(source, signal, 'provenanceDigest');
  const before = await digest(source, signal);
  const raw = await manifest(source, ownerId, exportId, signal);
  const ids = savedItemIds(raw);
  const attributions = new Map<string, unknown>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      attributions.set(id, await source.attribution(id, signal));
    }
  }));
  const again = await manifest(source, ownerId, exportId, signal);
  if (canonical(again.tables.items) !== canonical(raw.tables.items) || canonical(again.tables.item_images) !== canonical(raw.tables.item_images)
    || await digest(source, signal) !== before) {
    throw new BackupFormatError('changed');
  }
  const provenance = await source.provenance(signal);
  if (await digest(source, signal, 'provenanceDigest') !== provenanceBefore) throw new BackupFormatError('changed');
  const metadata = projectSaved(raw, new Map([...attributions].sort(([a], [b]) => a < b ? -1 : 1)), provenance);
  return fromMetadata(metadata, await metadataDigest(metadata));
}

// Rebuilds the prepared snapshot from metadata that was already exported (a resumed backup never collects it again).
export function fromMetadata(metadata: SavedMetadata, manifestSha256: string): PreparedSnapshot {
  const plan = planParts(metadata);
  return { exportId: metadata.export_id, ownerId: metadata.owner_id, metadata, manifestSha256, plan, partCount: plan.length + 1,
    items: metadata.tables.items.length, photos: metadata.tables.item_images.length };
}

// Builds and encrypts one part; photo bytes are checked against the snapshot before they are included. Every part has the
// metadata's version, so a resumed version 2 backup stays version 2.
export async function assemblePart(prepared: PreparedSnapshot, index: number, fetchFile: FetchFile, passphrase: string): Promise<Envelope> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= prepared.partCount) throw new BackupFormatError('invalid');
  const files: FileEntry[] = [];
  for (const ref of index === 0 ? [] : prepared.plan[index - 1]!) {
    const bytes = await fetchFile(ref);
    if (bytes.length !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) throw new BackupFormatError('changed');
    files.push({ imageId: ref.imageId, variant: ref.variant, sha256: ref.sha256, byteLength: ref.byteLength, mime: 'image/jpeg', base64: toBase64(bytes) });
  }
  const part: ExportPart = { format: 'stillroom-export', schemaVersion: prepared.metadata.schema_version, exportId: prepared.exportId, partIndex: index,
    partCount: prepared.partCount, manifestSha256: prepared.manifestSha256, ...(index === 0 ? { manifest: prepared.metadata } : {}), files };
  return encryptPart(part, passphrase);
}
