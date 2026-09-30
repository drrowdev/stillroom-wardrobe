export const repository: string;
export const HARNESS_CALLS: number;
export const REFERENCE_BYTES: number;
export class HarnessRefusal extends Error { constructor(code: string); readonly code: string; }
export function sha256(bytes: Uint8Array | string): string;
export function checkFolders(folders: readonly string[]): string[];
export type HarnessSample = { file: string; role: 'visual' | 'disconnect'; edit: { turns: number; crop: { x: number; y: number; width: number; height: number } } };
export function parseCrops(value: unknown): HarnessSample[];
export function sourceCommit(run?: (args: string[]) => { status: number | null; stdout: string }): string;
export function loopbackOnly(origin: string): (url: string) => boolean;
export function bindingFor(input: { commit: string; modelSha256: string; sampleSha256: string; edit: unknown; prepared: unknown;
  h0: Uint8Array; reference: Uint8Array }): Record<string, unknown> & { ambiguous: boolean; h0: { sha256: string; bytes: number; width: number; height: number } };
export function verifyPrepared(binding: unknown, current: { commit: string; modelSha256: string; h0: Uint8Array; reference: Uint8Array }): void;
export function withHarness<T>(work: (context: { page: import('@playwright/test').Page; modelSha256: string; assets: unknown[] }) => Promise<T>,
  options?: { chromium?: import('@playwright/test').BrowserType }): Promise<{ result: T; blocked: string[]; registrations: number; requests: number }>;
export const VISUAL_CALLS: number;
export const PREPARED_FILES: readonly string[];
export const CALL_FILES: readonly string[];
export const MEASURED_FILES: readonly string[];
export type RemeasureIo = {
  realpath: (file: string) => Promise<string>;
  lstat: (file: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; size: number }>;
  readdir: (folder: string, options: { withFileTypes: true }) => Promise<Array<{ name: string; isSymbolicLink(): boolean; isFile(): boolean }>>;
  readFile: (file: string, options: { flag: 'r' }) => Promise<Uint8Array>;
  mkdir: (folder: string) => Promise<unknown>;
  writeFile: (file: string, data: string, options: { flag: 'wx' }) => Promise<void>;
};
export type RemeasureEntry = { call: number; requestId: string; h0: Uint8Array; reference: Uint8Array; h2: Uint8Array;
  h0Sha256: string; h2Sha256: string; referenceSha256: string; priorReason: string };
export type RemeasurePlan = { preparedCommit: string; modelSha256: string; out: string; metricsFile: string; metricsSha256: string; entries: RemeasureEntry[] };
export function planRemeasure(root: string, outDir: string, io?: RemeasureIo): Promise<RemeasurePlan>;
export function remeasureRecord(plan: RemeasurePlan, build: { measuredCommit: string; modelSha256: string; configSha256: string;
  results: unknown[]; blocked?: string[] }): Record<string, unknown> & { schema: 2; metrics: Record<string, Record<string, unknown>> };
export function writeRemeasure(plan: RemeasurePlan, value: unknown, io?: RemeasureIo): Promise<void>;
