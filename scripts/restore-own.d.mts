export const LOCK: string;
export const EXIT: Readonly<{ complete: 0; refused: 1; retry: 2; recheck: 3; kept: 5; blocked: 6; cancelled: 130 }>;
export class RestoreOwnError extends Error { code: string; detail?: string; constructor(code: string); }
export function parseArguments(argv: string[]): { folder: string; local: string | undefined; yes: boolean; allowOther: boolean; json: boolean };
export function loadEngine(): Promise<unknown>;
export function outcomeOf(result: unknown): { code: number; message: string };
export type RestoreOwnDeps = {
  argv: string[]; env: Record<string, string | undefined>; stdin: unknown; stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown };
  signal?: AbortSignal; files?: unknown; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; now?: () => number; platform?: string;
  startImageWorker?: (...args: never[]) => Promise<unknown>; loadEngine?: () => Promise<unknown>; observeRequest?: (request: { method: string; path: string; search: string }) => unknown;
};
export function runRestoreOwn(deps: RestoreOwnDeps): Promise<number>;