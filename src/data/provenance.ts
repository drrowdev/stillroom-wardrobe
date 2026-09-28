import type { AppClient } from './client';
import { requireSuccess, throwIfAborted } from './errors';

// Whether the owner's saved image carries "edited with AI" provenance. Kept in memory by the caller only.
export async function loadEditedImage(client: AppClient, imageId: string, signal: AbortSignal): Promise<boolean> {
  const { data, error } = await client.rpc('image_provenance_v1').abortSignal(signal);
  throwIfAborted(signal);
  requireSuccess(error);
  if (!Array.isArray(data)) throw new Error('Invalid provenance');
  return data.some(row => typeof row === 'object' && row !== null && !Array.isArray(row)
    && (row as Record<string, unknown>).image_id === imageId && (row as Record<string, unknown>).kind === 'ai_edited');
}
