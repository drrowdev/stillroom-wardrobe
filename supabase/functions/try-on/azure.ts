import { observeEnhanceUsage } from '../../../src/domain/enhancement.ts';
import { TRYON_DEPLOYMENT, TRYON_ENDPOINT, TRYON_LIMITS, TRYON_MODEL, TRYON_PARAMETERS, tryOnPrompt, type TryOnSlot } from '../../../src/domain/tryon.ts';
import { admitProviderJpeg, decodeProviderBase64 } from '../../../src/images/provider-jpeg.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { object, ProtocolError, readBounded, type JsonObject } from '../analyze-clothing/protocol.ts';

// A copy of the photo-enhancement rules (plan rev4 §6.1): the same deployment, response profile and usage counters.
// Merging the two is later cleanup; the enhance-photo artefact is not changed.

/** The finish payload: all five counters, or null when any is missing (settled at the reservation). */
export type TryOnUsagePayload = {
  modelObservation: 'not_observed' | 'response_unrecognised_model' | 'expected_snapshot' | 'deployment_alias';
  input: number; output: number; total: number; inputText: number; inputImage: number;
};
export type TryOnOutcome =
  | { code: 'OK'; image: Uint8Array<ArrayBuffer>; usage: TryOnUsagePayload | null }
  | { code: 'FAILED' | 'FILTERED' | 'OUTPUT_REJECTED'; image: null; usage: TryOnUsagePayload | null };

const FILTER_CODES = new Set(['content_policy_violation', 'content_filter', 'moderation_blocked', 'ResponsibleAIPolicyViolation']);

export function tryOnUsagePayload(value: JsonObject): TryOnUsagePayload | null {
  const usage = observeEnhanceUsage(value);
  if (usage.input === null || usage.output === null || usage.total === null || usage.inputText === null
    || usage.inputImage === null) return null;
  const model = value.model;
  const modelObservation = model === undefined ? 'not_observed' : model === TRYON_MODEL ? 'expected_snapshot'
    : model === TRYON_DEPLOYMENT ? 'deployment_alias' : 'response_unrecognised_model';
  return { modelObservation, input: usage.input, output: usage.output, total: usage.total, inputText: usage.inputText,
    inputImage: usage.inputImage };
}

function filtered(value: JsonObject): boolean {
  const error = object(value.error) ? value.error : null;
  if (!error) return false;
  const inner = object(error.innererror) ? error.innererror : object(error.inner_error) ? error.inner_error : null;
  return FILTER_CODES.has(String(error.code)) || (inner !== null && FILTER_CODES.has(String(inner.code)));
}

/**
 * Classifies one images-API response. A 200 with exactly one base64 JPEG is admitted by the strict 1024x1280
 * provider-output profile; anything else it produces is OUTPUT_REJECTED and is never re-encoded or returned. A
 * content-policy error on the input or the output is FILTERED, a normal outcome. Usage is observed from every JSON body.
 */
export function classifyTryOnResponse(status: number, value: JsonObject): TryOnOutcome {
  const usage = tryOnUsagePayload(value);
  if (status !== 200) return { code: filtered(value) ? 'FILTERED' : 'FAILED', image: null, usage };
  const data = Array.isArray(value.data) && value.data.length === 1 ? value.data[0] : null;
  if (!object(data) || typeof data.b64_json !== 'string') return { code: 'FAILED', image: null, usage };
  try {
    const admitted = admitProviderJpeg(decodeProviderBase64(data.b64_json));
    if (admitted.width !== TRYON_LIMITS.outputWidth || admitted.height !== TRYON_LIMITS.outputHeight
      || admitted.bytes.length > TRYON_LIMITS.outputBytes) return { code: 'OUTPUT_REJECTED', image: null, usage };
    return { code: 'OK', image: admitted.bytes, usage };
  } catch {
    return { code: 'OUTPUT_REJECTED', image: null, usage };
  }
}

/** The outbound multipart: the frozen parameters, the fixed prompt for the slot, then image[] = [person, garment]. */
export function tryOnForm(person: Uint8Array<ArrayBuffer>, garment: Uint8Array<ArrayBuffer>, slot: TryOnSlot): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(TRYON_PARAMETERS)) form.append(key, String(value));
  form.append('prompt', tryOnPrompt(slot));
  form.append('image[]', new Blob([person], { type: 'image/jpeg' }), 'person.jpg');
  form.append('image[]', new Blob([garment], { type: 'image/jpeg' }), 'garment.jpg');
  return form;
}

/**
 * One provider call: no retry, no fallback deployment, the response read with the 4 MiB cap enforced while reading.
 * The transport is invoked before this function's first await, so a caller that samples its client signal on the line
 * before the call observes the state at the actual fetch start (rev4 R1).
 */
export async function callTryOn(config: AzureConfig, person: Uint8Array<ArrayBuffer>, garment: Uint8Array<ArrayBuffer>,
  slot: TryOnSlot, signal: AbortSignal, transport: AzureTransport = fetch): Promise<TryOnOutcome> {
  if (!azureConfigured(config)) throw new ProtocolError('UNCONFIGURED');
  signal.throwIfAborted();
  const response = await transport(TRYON_ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'api-key': config.apiKey! }, body: tryOnForm(person, garment, slot) });
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    return { code: 'FAILED', image: null, usage: null };
  }
  // A read that fails mid-body is transport uncertainty and stays held for provisional expiry; a complete body that
  // is oversized or not JSON is FAILED without usage, settled at the reservation.
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = await readBounded(response.body, TRYON_LIMITS.responseBytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError && !signal.aborted) return { code: 'FAILED', image: null, usage: null };
    throw failure;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch {
    return { code: 'FAILED', image: null, usage: null };
  }
  if (!object(value)) return { code: 'FAILED', image: null, usage: null };
  return classifyTryOnResponse(response.status, value);
}
