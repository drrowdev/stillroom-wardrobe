import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
export const REQUEST_TIMEOUT_MS: number;
export const RESUME_WINDOW_MS: number;
export type ExportCode = 'usage' | 'endpoint' | 'key' | 'environment' | 'input' | 'mismatch' | 'output' | 'auth' | 'unavailable' | 'changed'
  | 'passphrase' | 'stale' | 'unresumable' | 'conflict' | 'busy' | 'tooLarge' | 'cancelled' | 'io' | 'invalid';
export class ExportError extends Error { code: ExportCode; staging?: string; detail?: string; constructor(code: ExportCode, staging?: string); }
export type ExportFiles = {
  lstat(path: string): Promise<Stats>; readdir(path: string): Promise<string[]>; mkdir(path: string): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<FileHandle>; rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>; unlink(path: string): Promise<void>; rmdir(path: string): Promise<void>;
};
export const nodeFiles: ExportFiles;
export function parseArguments(argv: string[]): { output: string; local: string | undefined };
export function forbiddenEnvironment(env: Record<string, string | undefined>): boolean;
export function resolveEndpoint(env: Record<string, string | undefined>, local: string | undefined): string;
export function publishableKey(env: Record<string, string | undefined>): string;
export function parseSecrets(buffer: Buffer): { email: string; password: string; passphrase: string };
export function guardedFetch(options: {
  origin: string; key: string; fetchImpl: (input: string, init: RequestInit) => Promise<Response>; state: { owner: string | null; refused: boolean; signal?: AbortSignal };
}): (input: string | URL, init?: RequestInit) => Promise<Response>;
export function syncDirectory(files: ExportFiles, path: string, platform: string): Promise<void>;
export type LockContext = { files: ExportFiles; output: string; now(): number; platform: string; lock?: { path: string; token: string } | null };
export function acquireLock(context: LockContext, dir?: string, name?: string): Promise<void>;
export function releaseLock(context: LockContext): Promise<void>;
export type ExportDeps = {
  argv: string[]; env: Record<string, string | undefined>; stdin: unknown; stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown };
  files?: unknown; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; now?: () => number; platform?: string;
  newId?: () => string; checkJpeg?: (...args: never[]) => void; signal?: AbortSignal;
};
export function runExport(deps: ExportDeps): Promise<0 | 1 | 2>;
