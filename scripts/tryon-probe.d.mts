export const PROBE_CALLS: number;
export const PERSON_BYTES: number;
export const OUTPUT_BYTES: number;
export const JSON_BYTES: number;
export const RESULT_JSON_BYTES: number;
export const CALL_TIMEOUT_MS: number;
export const DISCONNECT_AFTER_MS: number;
export const DISPATCH_SPACING_MS: number;
export const REFUSED_POLL_MS: number;
export const REFUSED_FOR_MS: number;
export const SETTLE_POLL_MS: number;
export const SETTLE_FOR_MS: number;
export class ProbeRefusal extends Error { constructor(code: string); readonly code: string; }
export function prepareProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runProbe(env: Record<string, string | undefined>, deps: Record<string, unknown>): Promise<{ lines: string[]; calls: Array<{ code: string } & Record<string, unknown>> }>;
