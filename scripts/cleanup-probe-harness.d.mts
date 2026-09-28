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
