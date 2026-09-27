import { STYLIST_ENDPOINT, STYLIST_LIMITS, utf8Bytes } from '../../../src/domain/stylist.ts';
import { observeAzureUsage, azureConfigured, type AzureConfig, type AzureTransport, type AzureUsage } from '../analyze-clothing/azure-openai.ts';
import { object, ProtocolError, readBounded, type JsonObject } from '../analyze-clothing/protocol.ts';

export type StylistOutcome = { code: 'OK' | 'FAILED' | 'FILTERED'; content: string | null; usage: AzureUsage; unusable?: true };

/**
 * Fixed marker for a response that arrived but cannot be read (wrong media type, invalid or oversized JSON, not an
 * object). Finish rejects it as invalid usage: the reservation stays accounted and the stylist is disabled. The raw
 * body is never kept.
 */
export const UNUSABLE_RESPONSE_USAGE: AzureUsage = Object.freeze({
  modelObservation: 'not_observed', controlObservation: 'ordinary',
  input: null, output: null, total: null, reasoning: null, cacheRead: null, cacheWrite: null,
}) as AzureUsage;
const unusable = (): StylistOutcome => ({ code: 'FAILED', content: null, usage: UNUSABLE_RESPONSE_USAGE, unusable: true });

/**
 * Classifies one provider response (D5). A null or absent refusal is ordinary; a real refusal or content filter is
 * FILTERED; tool or function calls, or any other shape, are FAILED. Usage is observed from every JSON response.
 */
export function classifyStylistResponse(status: number, value: JsonObject): StylistOutcome {
  const usage = observeAzureUsage(value);
  const choice = Array.isArray(value.choices) && value.choices.length === 1 ? value.choices[0] : null;
  if (status !== 200 || !object(choice) || choice.index !== 0 || !object(choice.message) || choice.message.role !== 'assistant') {
    return { code: 'FAILED', content: null, usage };
  }
  const message = choice.message;
  const toolShaped = (Object.hasOwn(message, 'tool_calls') && message.tool_calls !== null)
    || (Object.hasOwn(message, 'function_call') && message.function_call !== null)
    || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call';
  if (toolShaped) return { code: 'FAILED', content: null, usage };
  if (choice.finish_reason === 'content_filter'
    || (Object.hasOwn(message, 'refusal') && message.refusal !== null && message.refusal !== undefined)) {
    return { code: 'FILTERED', content: null, usage };
  }
  if (choice.finish_reason !== 'stop' || typeof message.content !== 'string'
    || utf8Bytes(message.content) > STYLIST_LIMITS.contentBytes) return { code: 'FAILED', content: null, usage };
  return { code: 'OK', content: message.content, usage };
}

/** One provider call: no retry, no fallback, bounded response read. */
export async function callStylist(config: AzureConfig, body: JsonObject, signal: AbortSignal,
  transport: AzureTransport = fetch): Promise<StylistOutcome> {
  if (!azureConfigured(config)) throw new ProtocolError('UNCONFIGURED');
  signal.throwIfAborted();
  const response = await transport(STYLIST_ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey! }, body: JSON.stringify(body) });
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {}); return unusable();
  }
  // A read that fails mid-body (abort, timeout, reset) is transport uncertainty and stays on the held/expiry path;
  // a complete body that is oversized or not JSON is unusable.
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = await readBounded(response.body, STYLIST_LIMITS.responseBytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError && !signal.aborted) return unusable();
    throw failure;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return unusable(); }
  if (!object(value)) return unusable();
  return classifyStylistResponse(response.status, value);
}
