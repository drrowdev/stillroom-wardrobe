export const PROBE_CALLS: number;
export const VISUAL_CALLS: number;
export const SAMPLE_BYTES: number;
export const OUTPUT_BYTES: number;
export const JSON_BYTES: number;
export const CALL_TIMEOUT_MS: number;
export const DISCONNECT_AFTER_MS: number;
export const POLL_EVERY_MS: number;
export const POLL_FOR_MS: number;
export class ProbeRefusal extends Error { constructor(code: string); readonly code: string; }
export function prepareProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<{ lines: string[]; calls: Array<{ code: string } & Record<string, unknown>> }>;