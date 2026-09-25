import { FunctionsHttpError } from '@supabase/supabase-js';
import type { AppClient } from './client';
import type { OwnerScope } from '../auth/session';

export type DeleteOutcome = 'complete' | 'in_progress' | 'retry' | 'contact' | 'password' | 'signed_out' | 'failed';
const states = new Set<DeleteOutcome>(['complete', 'in_progress', 'retry', 'contact']);
// The server stops starting new work after 100 s; this leaves room for the reply.
export const DELETE_TIMEOUT_MS = 120_000;

function outcome(value: unknown): DeleteOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'failed';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return 'failed';
  if (typeof record.state === 'string' && states.has(record.state as DeleteOutcome)) return record.state as DeleteOutcome;
  if (record.code === 'PASSWORD') return 'password';
  if (record.code === 'UNAUTHENTICATED') return 'signed_out';
  return 'failed';
}

export type DeletionStatus = 'none' | 'in_progress' | 'retry' | 'contact' | 'complete';
const statuses = new Set<DeletionStatus>(['none', 'in_progress', 'retry', 'contact', 'complete']);

/** The caller's own deletion job, readable after the freeze. `null` when the answer is missing or malformed. */
export async function deletionStatus(client: AppClient, signal: AbortSignal): Promise<DeletionStatus | null> {
  const { data, error } = await client.rpc('deletion_status').abortSignal(signal);
  if (error || typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  return Object.keys(record).length === 1 && statuses.has(record.state as DeletionStatus) ? record.state as DeletionStatus : null;
}

/** Owner-confirmed account deletion. Only the password is sent; the server takes the owner from the session. */
export async function deleteAccount(client: AppClient, scope: OwnerScope, password: string, signal: AbortSignal): Promise<DeleteOutcome> {
  const { data: current } = await client.auth.getSession();
  if (current.session?.user.id !== scope.ownerId) return 'signed_out';
  const { data, error } = await client.functions.invoke('delete-account', {
    body: { password }, method: 'POST', signal: AbortSignal.any([signal, scope.signal]), timeout: DELETE_TIMEOUT_MS,
  });
  if (!error) return outcome(data);
  if (!(error instanceof FunctionsHttpError) || !(error.context instanceof Response)) return 'failed';
  const response = error.context;
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return 'failed';
  const text = await response.text().catch(() => '');
  if (text.length > 4096) return 'failed';
  try { return outcome(JSON.parse(text)); } catch { return 'failed'; }
}
