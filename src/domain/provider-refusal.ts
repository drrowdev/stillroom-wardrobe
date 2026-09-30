// FILT1 (plan rev3): the bounded provider refusal kind and the metering state of an images-API reply, shared by the
// try-on and enhance-photo Edge adapters. Server-side only. The provider's message text is compared with two documented
// constants and never stored, logged or returned; no content_filter_results category or severity is kept.

export type ProviderRefusal = 'rai_input' | 'rai_output' | 'unknown_filter' | 'unverified_filter';
export type Metering = 'observed' | 'absent' | 'faulty';

/** A Microsoft-documented code establishes the refusal; unverified_filter keeps FILTERED but never qualifies. */
export const QUALIFYING_REFUSALS: readonly ProviderRefusal[] = Object.freeze(['rai_input', 'rai_output', 'unknown_filter']);

// https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e (image API error codes).
const INPUT_MESSAGE = 'Your task failed as a result of our safety system.';
const OUTPUT_MESSAGE = 'Generated image was filtered as a result of our safety system.';
const QUALIFYING_CODES = new Set(['contentFilter', 'content_policy_violation', 'content_filter']);
const UNVERIFIED_CODES = new Set(['moderation_blocked', 'ResponsibleAIPolicyViolation']);
const FILTER_CODES = new Set([...QUALIFYING_CODES, ...UNVERIFIED_CODES]);
// The filtering system did not run (Scenario 6, content_filter_results.error.code). Never a refusal.
const FILTER_SYSTEM_FAILURE = 'content_filter_error';
const WRAPPERS = Object.freeze([[], ['innererror'], ['inner_error']] as const);
const CONTAINERS = Object.freeze(['content_filter_results', 'content_filter_result'] as const);
const CATEGORIES = Object.freeze(['hate', 'sexual', 'violence', 'self_harm', 'profanity', 'jailbreak', 'custom_blocklists',
  'protected_material_text', 'protected_material_code'] as const);

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (root: unknown, steps: readonly string[]): unknown => {
  let value = root;
  for (const step of steps) {
    if (!plain(value) || !Object.hasOwn(value, step)) return undefined;
    value = value[step];
  }
  return value;
};

/**
 * The fixed, explicit list of paths (relative to the body's `error` object) where a filter-system failure is signalled:
 * the two inner codes, `W.C.error.code` for the three wrappers and both container spellings, and `W.C.<category>.error.code`
 * for the fixed category list. Every step must be a plain object; no other key or depth is read.
 */
export const FILTER_FAILURE_PATHS: readonly (readonly string[])[] = Object.freeze([
  ['innererror', 'code'], ['inner_error', 'code'],
  ...WRAPPERS.flatMap((wrapper) => CONTAINERS.map((container) => [...wrapper, container, 'error', 'code'])),
  ...WRAPPERS.flatMap((wrapper) => CONTAINERS.flatMap((container) => CATEGORIES.map((category) =>
    [...wrapper, container, category, 'error', 'code']))),
].map((path) => Object.freeze(path)));

function filterSystemFailed(error: Plain): boolean {
  return FILTER_FAILURE_PATHS.some((path) => at(error, path) === FILTER_SYSTEM_FAILURE);
}

/** The refusal kind of one non-200 images-API reply, or null when the reply is not a content-filter refusal (FAILED). */
export function providerRefusal(status: number, body: unknown): ProviderRefusal | null {
  if (status === 200 || !plain(body) || !plain(body.error)) return null;
  const error = body.error;
  const outer = typeof error.code === 'string' ? error.code : null;
  if (outer === null || outer === FILTER_SYSTEM_FAILURE) return null;
  const inner = [at(error, ['innererror', 'code']), at(error, ['inner_error', 'code'])];
  let kind: ProviderRefusal | null = null;
  if (QUALIFYING_CODES.has(outer)) {
    if (status !== 400) kind = 'unverified_filter';
    else if (outer !== 'contentFilter') kind = 'unknown_filter';
    else kind = error.message === INPUT_MESSAGE ? 'rai_input' : error.message === OUTPUT_MESSAGE ? 'rai_output' : 'unknown_filter';
  } else if (UNVERIFIED_CODES.has(outer) || inner.some((code) => typeof code === 'string' && FILTER_CODES.has(code))) {
    kind = 'unverified_filter';
  }
  if (kind === null) return null;
  return filterSystemFailed(error) ? 'unverified_filter' : kind;
}

/**
 * The metering state of a reply whose usage payload is `payload` (null when any counter is missing or invalid). Only a
 * body with no own `usage` key, no stray top-level counters and an absent or recognised model is `absent`.
 */
export function metering(body: unknown, payload: unknown, models: readonly string[]): Metering {
  if (payload !== null) return 'observed';
  if (!plain(body) || Object.hasOwn(body, 'usage')) return 'faulty';
  if (['input_tokens', 'output_tokens', 'total_tokens'].some((key) => Object.hasOwn(body, key))) return 'faulty';
  if (Object.hasOwn(body, 'model') && !models.includes(body.model as string)) return 'faulty';
  return 'absent';
}

/** The two trailing finish arguments: the kind only for FILTERED, and whether metering was genuinely absent. */
export function refusalFinishArgs(outcome: { code: string; usage: unknown; refusal: ProviderRefusal | null; metering: Metering }):
  { p_refusal_kind: ProviderRefusal | null; p_usage_absent: boolean | null } {
  if (outcome.code !== 'FILTERED' || outcome.refusal === null) return { p_refusal_kind: null, p_usage_absent: null };
  return { p_refusal_kind: outcome.refusal,
    p_usage_absent: outcome.usage !== null ? null : outcome.metering === 'absent' };
}
