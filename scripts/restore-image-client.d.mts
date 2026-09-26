import type { RestorePhotoDeps } from '../src/images/restore-photo.ts';
export function workerEnvironment(env: Record<string, string | undefined>, temporary: string): Record<string, string>;
export class ImageWorkerError extends Error { code: string; constructor(code: string); }
export type ImageWorker = { deps: RestorePhotoDeps; failure(): boolean; close(): Promise<void> };
export function startImageWorker(options?: { env?: Record<string, string | undefined>; [key: string]: unknown }): Promise<ImageWorker>;