// AD1b: the three admin RPCs (ADR27); spending and limits use the v2 functions, which add try-on (VTO-2b). Each call is bound to the owner scope that made it, so a sign-out or account
// change drops its reply. Anyone who isn't the app's admin gets the same fixed UNAVAILABLE, shown as "Not available".
import type { OwnerScope } from '../auth/session';
import { AI_BUDGET_CONTRACT, AI_BUDGET_CONTRACT_HEADER } from '../domain/ai-budget';
import { parseSpending, parseWriteResult, type AdminSpending, type Limits, type WriteResult } from '../domain/admin-limits';
import type { AppClient } from './client';
import { AppError, throwIfAborted } from './errors';

export const ADMIN_REASONS = ['RAISE', 'LOWER', 'PAUSE', 'RESTORE', 'CORRECTION'] as const;
export type AdminReason = (typeof ADMIN_REASONS)[number];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unavailable = (value: unknown) => record(value) && Object.keys(value).length === 1 && value.code === 'UNAVAILABLE';
const missing = (error: unknown) => record(error) && error.code === 'PGRST202';

function lifetime(scope: OwnerScope, signal: AbortSignal) {
  const joined = AbortSignal.any([scope.signal, signal]);
  return { signal: joined, check: () => throwIfAborted(joined) };
}

/** Whether the signed-in account is the app's admin. A backend without the admin functions has no admin. */
export async function readAdminStatus(client: AppClient, scope: OwnerScope, signal: AbortSignal): Promise<boolean> {
  const call = lifetime(scope, signal);
  call.check();
  const { data, error } = await client.rpc('admin_status').abortSignal(call.signal);
  call.check();
  if (error) { if (missing(error)) return false; throw new AppError('error.unavailable'); }
  if (record(data) && Object.keys(data).length === 1 && data.code === 'OK') return true;
  if (unavailable(data)) return false;
  throw new AppError('error.unavailable');
}

export type SpendingRead = { kind: 'ok'; spending: AdminSpending } | { kind: 'unavailable' };
export async function readAdminSpending(client: AppClient, scope: OwnerScope, months: 6 | 12, signal: AbortSignal): Promise<SpendingRead> {
  const call = lifetime(scope, signal);
  call.check();
  const { data, error } = await client.rpc('admin_ai_spending_v2', { p_months: months })
    .setHeader(AI_BUDGET_CONTRACT_HEADER, AI_BUDGET_CONTRACT).abortSignal(call.signal);
  call.check();
  if (error) { if (missing(error)) return { kind: 'unavailable' }; throw new AppError('error.unavailable'); }
  if (unavailable(data)) return { kind: 'unavailable' };
  const spending = parseSpending(data);
  if (!spending || spending.months.length !== months) throw new AppError('error.unavailable');
  return { kind: 'ok', spending };
}

export type LimitWrite = { admissionNo: 1 | 2; accountVersion: string; expected: Limits; limits: Limits; reason: AdminReason | null };
/** One limits change. A thrown error means the outcome is unknown and the caller reads the current values again. */
export async function writeAdminLimits(client: AppClient, scope: OwnerScope, write: LimitWrite, signal: AbortSignal): Promise<WriteResult> {
  const call = lifetime(scope, signal);
  call.check();
  const { data, error } = await client.rpc('admin_set_ai_limits_v2', {
    p_admission_no: write.admissionNo, p_account_version: write.accountVersion, p_expected: write.expected, p_limits: write.limits,
    ...write.reason ? { p_reason_code: write.reason } : {},
  }).setHeader(AI_BUDGET_CONTRACT_HEADER, AI_BUDGET_CONTRACT).abortSignal(call.signal);
  call.check();
  if (error) throw new AppError('error.unavailable');
  const result = parseWriteResult(data);
  if (!result) throw new AppError('error.unavailable');
  return result;
}
