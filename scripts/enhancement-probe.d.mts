export const PROBE_CALLS: number;
export const VISUAL_CALLS: number;
export const SAMPLE_BYTES: number;
export const OUTPUT_BYTES: number;
export const JSON_BYTES: number;
export const CALL_TIMEOUT_MS: number;
export const DISCONNECT_AFTER_MS: number;
export const POLL_EVERY_MS: number;
export const POLL_FOR_MS: number;
export const SLOT_MS: number;
export const SLOT_MARGIN_MS: number;
export const DISPATCH_SPACING_MS: number;
export const REFERENCE_BYTES: number;
export const REASON_METRICS: Readonly<Record<string, readonly string[]>>;
export function earliestStart(run: { notBefore: number }, starts: readonly number[], observed: readonly number[]): number;
export function evidenceState(calls: ReadonlyArray<Record<string, unknown>>, metrics?: Record<string, unknown>, settlement?: unknown):
  { state: 'pending' | 'ready-for-paired-review'; missing: string[] };
export class ProbeRefusal extends Error { constructor(code: string); readonly code: string; }
export function prepareProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<{ lines: string[]; calls: Array<{ code: string } & Record<string, unknown>> }>;