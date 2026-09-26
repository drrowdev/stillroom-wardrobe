import type { MessageKey } from '../i18n';
import { isRecord } from '../domain/wardrobe';

// Explicit fields rather than parameter properties, so the Node restore CLI can load this without a TypeScript transform.
export class AppError extends Error {
  readonly messageKey: MessageKey;
  constructor(messageKey: MessageKey) { super(messageKey); this.messageKey = messageKey; this.name = 'AppError'; }
}
export class AnalyzedSaveRefusedError extends AppError {
  readonly itemId: string;
  readonly imageId: string;
  constructor(itemId: string, imageId: string) {
    super('aiC.saveRefused'); this.itemId = itemId; this.imageId = imageId; this.name = 'AnalyzedSaveRefusedError';
  }
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
