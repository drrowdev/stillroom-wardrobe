import type { MessageKey } from '../i18n';
import { isRecord } from '../domain/wardrobe';

export class AppError extends Error {
  constructor(public readonly messageKey: MessageKey) { super(messageKey); this.name = 'AppError'; }
}
export function errorKey(error: unknown): MessageKey {
  if (error instanceof AppError) return error.messageKey;
  return 'error.unavailable';
}
export function requireSuccess(error: unknown): void {
  if (!error) return;
  if (isRecord(error) && (error.code === '23505' || error.status === 409)) throw new AppError('error.conflict');
  throw new AppError('error.unavailable');
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}
export function isAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
