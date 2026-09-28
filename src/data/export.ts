import type { OwnerScope } from '../auth/session';
import type { AppClient } from './client';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { BackupFormatError, type FileRef } from '../domain/export-format';
import { assemblePart, collectSnapshot, type PreparedSnapshot } from '../domain/export-run';

export type PreparedExport = PreparedSnapshot;

function problem(error: unknown): never {
  if (error instanceof BackupFormatError) {
    throw new AppError(error.problem === 'changed' ? 'backup.changed' : error.problem === 'tooLarge' ? 'backup.tooLarge' : 'error.unavailable');
  }
  throw error;
}

async function manifest(client: AppClient, exportId: string, signal: AbortSignal): Promise<unknown> {
  const { data, error } = await client.rpc('export_manifest', { p_export_id: exportId }).abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(error);
  return data;
}

async function attribution(client: AppClient, itemId: string, signal: AbortSignal): Promise<unknown> {
  const { data, error } = await client.rpc('item_attribution_history_v2', { p_item_id: itemId }).abortSignal(signal);
  throwIfAborted(signal);
  // The item left the saved set (Trash or deletion) after the snapshot.
  if (error && (error as { code?: string }).code === '42501') throw new AppError('backup.changed');
  requireSuccess(error);
  return data;
}

async function digest(client: AppClient, signal: AbortSignal,
  name: 'attribution_digest' | 'image_provenance_v1' | 'image_provenance_digest_v1' = 'attribution_digest'): Promise<unknown> {
  const { data, error } = await client.rpc(name).abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(error);
  return data;
}

// Digest, one snapshot, the attribution of each saved item, then a second snapshot and digest (src/domain/export-run.ts).
export async function prepareExport(client: AppClient, scope: OwnerScope, signal: AbortSignal): Promise<PreparedExport> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  const exportId = crypto.randomUUID();
  try {
    return await collectSnapshot({
      manifest: (id, abort) => manifest(client, id, abort),
      attribution: (id, abort) => attribution(client, id, abort),
      digest: abort => digest(client, abort),
      provenance: abort => digest(client, abort, 'image_provenance_v1'),
      provenanceDigest: abort => digest(client, abort, 'image_provenance_digest_v1'),
    }, scope.ownerId, exportId, lifetime);
  } catch (failure) { return problem(failure); }
}

async function photo(client: AppClient, ref: FileRef, signal: AbortSignal): Promise<Uint8Array> {
  const { data, error } = await client.storage.from('wardrobe').download(ref.path, {}, { signal, cache: 'no-store' });
  throwIfAborted(signal);
  if (error || !data) throw new AppError('backup.changed');
  const bytes = new Uint8Array(await data.arrayBuffer());
  throwIfAborted(signal);
  return bytes;
}

// Builds and encrypts one part on demand, so only one part's photos are in memory at a time.
export async function buildPart(client: AppClient, scope: OwnerScope, prepared: PreparedExport, index: number, passphrase: string,
  signal: AbortSignal): Promise<Blob> {
  const lifetime = AbortSignal.any([scope.signal, signal]);
  if (scope.ownerId !== prepared.ownerId || !Number.isSafeInteger(index) || index < 0 || index >= prepared.partCount) throw new AppError('error.unavailable');
  let envelope;
  try { envelope = await assemblePart(prepared, index, ref => photo(client, ref, lifetime), passphrase); } catch (failure) { return problem(failure); }
  throwIfAborted(lifetime);
  return new Blob([JSON.stringify(envelope)], { type: 'application/octet-stream' });
}

// The plain download: saved metadata only, no photos, unencrypted.
export function metadataFile(prepared: PreparedExport): Blob {
  return new Blob([JSON.stringify(prepared.metadata, null, 2)], { type: 'application/json' });
}
