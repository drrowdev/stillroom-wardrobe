import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import {
  BackupFormatError, canonical, encryptPart, metadataDigest, planParts, projectSaved, readRawManifest, savedItemIds, sha256Hex, toBase64,
  type ExportPart, type FileEntry, type FileRef, type RawManifest, type SavedMetadata,
} from '../domain/export-format';

export type PreparedExport = {
  exportId: string; ownerId: string; metadata: SavedMetadata; manifestSha256: string; plan: FileRef[][]; partCount: number;
  items: number; photos: number;
};

function problem(error: unknown): never {
  if (error instanceof BackupFormatError) {
    throw new AppError(error.problem === 'changed' ? 'backup.changed' : error.problem === 'tooLarge' ? 'backup.tooLarge' : 'error.unavailable');
  }
  throw error;
}

async function manifest(client: AppClient, scope: OwnerScope, exportId: string, signal: AbortSignal): Promise<RawManifest> {
  const { data, error } = await client.rpc('export_manifest', { p_export_id: exportId }).abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(error);
  try { return readRawManifest(data, scope.ownerId, exportId); } catch (failure) { return problem(failure); }
}

async function attribution(client: AppClient, itemId: string, signal: AbortSignal): Promise<unknown> {
  const { data, error } = await client.rpc('item_attribution_history', { p_item_id: itemId }).abortSignal(signal);
  throwIfAborted(signal);
  // The item left the saved set (Trash or deletion) after the snapshot.
  if (error && (error as { code?: string }).code === '42501') throw new AppError('backup.changed');
  requireSuccess(error);
  return data;
}

// One snapshot, the attribution of each saved item, then a second snapshot: if items or photos moved in between,
// the backup is refused rather than mixing two states.
export async function prepareExport(client: AppClient, scope: OwnerScope, signal: AbortSignal): Promise<PreparedExport> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const exportId = crypto.randomUUID();
  const raw = await manifest(client, scope, exportId, lifetime);
  let ids: string[];
  try { ids = savedItemIds(raw); } catch (failure) { return problem(failure); }
  const attributions = new Map<string, unknown>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      attributions.set(id, await attribution(client, id, lifetime));
    }
  }));
  const again = await manifest(client, scope, exportId, lifetime);
  if (canonical(again.tables.items) !== canonical(raw.tables.items) || canonical(again.tables.item_images) !== canonical(raw.tables.item_images)) {
    throw new AppError('backup.changed');
  }
  try {
    const metadata = projectSaved(raw, new Map([...attributions].sort(([a], [b]) => a < b ? -1 : 1)));
    const manifestSha256 = await metadataDigest(metadata);
    const plan = planParts(metadata);
    return { exportId, ownerId: scope.ownerId, metadata, manifestSha256, plan, partCount: plan.length + 1,
      items: metadata.tables.items.length, photos: metadata.tables.item_images.length };
  } catch (failure) { return problem(failure); }
}

async function photo(client: AppClient, ref: FileRef, signal: AbortSignal): Promise<FileEntry> {
  const { data, error } = await client.storage.from('wardrobe').download(ref.path, {}, { signal, cache: 'no-store' });
  throwIfAborted(signal);
  if (error || !data) throw new AppError('backup.changed');
  const bytes = new Uint8Array(await data.arrayBuffer());
  throwIfAborted(signal);
  if (bytes.length !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) throw new AppError('backup.changed');
  return { imageId: ref.imageId, variant: ref.variant, sha256: ref.sha256, byteLength: ref.byteLength, mime: 'image/jpeg', base64: toBase64(bytes) };
}

// Builds and encrypts one part on demand, so only one part's photos are in memory at a time.
export async function buildPart(client: AppClient, scope: OwnerScope, prepared: PreparedExport, index: number, passphrase: string,
  signal: AbortSignal): Promise<Blob> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  if (scope.ownerId !== prepared.ownerId || !Number.isSafeInteger(index) || index < 0 || index >= prepared.partCount) throw new AppError('error.unavailable');
  const files: FileEntry[] = [];
  for (const ref of index === 0 ? [] : prepared.plan[index - 1]!) files.push(await photo(client, ref, lifetime));
  const part: ExportPart = { format: 'stillroom-export', schemaVersion: 2, exportId: prepared.exportId, partIndex: index,
    partCount: prepared.partCount, manifestSha256: prepared.manifestSha256, ...(index === 0 ? { manifest: prepared.metadata } : {}), files };
  const envelope = await encryptPart(part, passphrase);
  throwIfAborted(lifetime);
  return new Blob([JSON.stringify(envelope)], { type: 'application/octet-stream' });
}

// The plain download: saved metadata only, no photos, unencrypted.
export function metadataFile(prepared: PreparedExport): Blob {
  return new Blob([JSON.stringify(prepared.metadata, null, 2)], { type: 'application/json' });
}
