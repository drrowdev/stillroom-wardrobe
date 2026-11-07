// AI-GUARD1: the backend runaway protection as the app and the Edge functions see it. A paused account refuses every new AI
// admission with SQLSTATE AG001; PostgREST answers that with a non-2xx reply whose body `code` is the SQLSTATE. The Edge functions
// turn it into the closed outcome PAUSED, which no client retries by itself. Import-free so the Edge runtime can load it.

export const AI_GUARD_SQLSTATE = 'AG001';
export const AI_GUARD_CODE = 'PAUSED';
/** Dispatched on window after a successful Resume, so automatic queues that stopped on PAUSED may start again. */
export const AI_GUARD_RESUMED_EVENT = 'stillroom-ai-guard-resumed';

/** True when a failed RPC reply is the spending guard's refusal. A successful reply is never one. */
export function guardRefusal(ok: boolean, body: unknown): boolean {
  return !ok && typeof body === 'object' && body !== null && !Array.isArray(body)
    && (body as Record<string, unknown>).code === AI_GUARD_SQLSTATE;
}

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const MICRO = /^(0|[1-9][0-9]{0,18})$/;

export type AiGuardStatus = { paused: false } | { paused: true; pausedAtMs: number; spentMicro: string; limitMicro: string };

/** Parses the closed `ai_guard_status_v1` reply; `UNAVAILABLE` carries only its code, null is anything else. */
export function parseAiGuardStatus(value: unknown): AiGuardStatus | 'UNAVAILABLE' | null {
  if (!record(value)) return null;
  if (hasKeys(value, ['code'])) return value.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : null;
  if (value.code !== 'OK') return null;
  if (hasKeys(value, ['code', 'paused']) && value.paused === false) return { paused: false };
  if (!hasKeys(value, ['code', 'paused', 'pausedAtMs', 'spentMicro', 'limitMicro']) || value.paused !== true
    || typeof value.pausedAtMs !== 'number' || !Number.isSafeInteger(value.pausedAtMs) || value.pausedAtMs < 0
    || typeof value.spentMicro !== 'string' || !MICRO.test(value.spentMicro)
    || typeof value.limitMicro !== 'string' || !MICRO.test(value.limitMicro)) return null;
  return { paused: true, pausedAtMs: value.pausedAtMs, spentMicro: value.spentMicro, limitMicro: value.limitMicro };
}

export type AiGuardResume = 'OK' | 'BUSY' | 'UNAVAILABLE';
/** Parses the closed `ai_guard_resume_v1` reply; null is anything else. */
export function parseAiGuardResume(value: unknown): AiGuardResume | null {
  if (!record(value)) return null;
  if (hasKeys(value, ['code'])) return value.code === 'BUSY' || value.code === 'UNAVAILABLE' ? value.code : null;
  return hasKeys(value, ['code', 'replayed']) && value.code === 'OK' && typeof value.replayed === 'boolean' ? 'OK' : null;
}
