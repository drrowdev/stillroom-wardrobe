import { ENHANCE_ENDPOINT, ENHANCE_LIMITS, ENHANCE_MODEL, ENHANCE_DEPLOYMENT, ENHANCE_PARAMETERS, CLEANUP_PROMPT,
  observeEnhanceUsage } from '../../../src/domain/enhancement.ts';
import { admitProviderJpeg, decodeProviderBase64 } from '../../../src/images/provider-jpeg.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { object, ProtocolError, readBounded, type JsonObject } from '../analyze-clothing/protocol.ts';

/** The finish payload: all five counters, or null when any is missing (settled at the reservation). */
export type EnhanceUsagePayload = {
  modelObservation: 'not_observed' | 'response_unrecognised_model' | 'expected_snapshot' | 'deployment_alias';
  input: number; output: number; total: number; inputText: number; inputImage: number;
};
export type EnhanceOutcome =
  | { code: 'OK'; image: Uint8Array<ArrayBuffer>; usage: EnhanceUsagePayload | null }
  | { code: 'FAILED' | 'FILTERED' | 'OUTPUT_REJECTED'; image: null; usage: EnhanceUsagePayload | null };

const FILTER_CODES = new Set(['content_policy_violation', 'content_filter', 'moderation_blocked', 'ResponsibleAIPolicyViolation']);

export function enhanceUsagePayload(value: JsonObject): EnhanceUsagePayload | null {
  const usage = observeEnhanceUsage(value);
  if (usage.input === null || usage.output === null || usage.total === null || usage.inputText === null
    || usage.inputImage === null) return null;
  const model = value.model;
  const modelObservation = model === undefined ? 'not_observed' : model === ENHANCE_MODEL ? 'expected_snapshot'
    : model === ENHANCE_DEPLOYMENT ? 'deployment_alias' : 'response_unrecognised_model';
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
 * Classifies one images-API response. A 200 with exactly one base64 JPEG is admitted by the strict provider-output
 * profile (H1); anything else it produces is OUTPUT_REJECTED and is never re-encoded or returned. Usage is observed
 * from every JSON body; a missing counter leaves usage null.
 */
export function classifyEnhanceResponse(status: number, value: JsonObject): EnhanceOutcome {
  const usage = enhanceUsagePayload(value);
  if (status !== 200) return { code: filtered(value) ? 'FILTERED' : 'FAILED', image: null, usage };
  const data = Array.isArray(value.data) && value.data.length === 1 ? value.data[0] : null;
  if (!object(data) || typeof data.b64_json !== 'string') return { code: 'FAILED', image: null, usage };
  try {
    return { code: 'OK', image: admitProviderJpeg(decodeProviderBase64(data.b64_json)).bytes, usage };
  } catch {
    return { code: 'OUTPUT_REJECTED', image: null, usage };
  }
}

/** The outbound multipart: only the image, the fixed prompt and the frozen parameters (L1). */
export function enhanceForm(image: Uint8Array<ArrayBuffer>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(ENHANCE_PARAMETERS)) form.append(key, String(value));
  form.append('prompt', CLEANUP_PROMPT);
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'garment.jpg');
  return form;
}

/** One provider call: no retry, no fallback deployment, response read with the 4 MiB cap enforced while reading. */
export async function callEnhance(config: AzureConfig, image: Uint8Array<ArrayBuffer>, signal: AbortSignal,
  transport: AzureTransport = fetch): Promise<EnhanceOutcome> {
  if (!azureConfigured(config)) throw new ProtocolError('UNCONFIGURED');
  signal.throwIfAborted();
  const response = await transport(ENHANCE_ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'api-key': config.apiKey! }, body: enhanceForm(image) });
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    return { code: 'FAILED', image: null, usage: null };
  }
  // A read that fails mid-body is transport uncertainty and stays held for provisional expiry; a complete body that
  // is oversized or not JSON is FAILED without usage, settled at the reservation.
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = await readBounded(response.body, ENHANCE_LIMITS.responseBytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError && !signal.aborted) return { code: 'FAILED', image: null, usage: null };
    throw failure;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch {
    return { code: 'FAILED', image: null, usage: null };
  }
  if (!object(value)) return { code: 'FAILED', image: null, usage: null };
  return classifyEnhanceResponse(response.status, value);
}
