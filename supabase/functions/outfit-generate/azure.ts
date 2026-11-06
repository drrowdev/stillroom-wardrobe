import { OUTFITGEN_ENDPOINT, OUTFITGEN_LIMITS, utf8Bytes } from '../../../src/domain/outfitgen.ts';
import { observeAzureUsage, azureConfigured, type AzureConfig, type AzureTransport, type AzureUsage } from '../analyze-clothing/azure-openai.ts';
import { object, ProtocolError, readBounded, type JsonObject } from '../analyze-clothing/protocol.ts';

/**
 * `usage` is null only for a non-200 reply that carries no token counters: nothing proves it was free, so finish keeps the
 * whole reservation, but it does not switch the feature off. A 200 reply always carries its observed usage (all-null counters
 * are invalid metering and switch the feature off, as for the Stylist). `unusable` marks a reply that arrived but cannot be read.
 */
export type OutfitGenOutcome = { code: 'OK' | 'FAILED' | 'FILTERED'; content: string | null; usage: AzureUsage | null; unusable?: true };

export const UNUSABLE_RESPONSE_USAGE: AzureUsage = Object.freeze({
  modelObservation: 'not_observed', controlObservation: 'ordinary',
  input: null, output: null, total: null, reasoning: null, cacheRead: null, cacheWrite: null,
}) as AzureUsage;

const hasCounters = (usage: AzureUsage) => usage.input !== null || usage.output !== null || usage.total !== null;

/**
 * Classifies one provider response. A null or absent refusal is ordinary; a real refusal or content filter is FILTERED;
 * tool or function calls and any other shape are FAILED. Usage is observed from every JSON response.
 */
export function classifyOutfitGenResponse(status: number, value: JsonObject): OutfitGenOutcome {
  const observed = observeAzureUsage(value);
  const usage = status === 200 || hasCounters(observed) ? observed : null;
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
    || utf8Bytes(message.content) > OUTFITGEN_LIMITS.contentBytes) return { code: 'FAILED', content: null, usage };
  return { code: 'OK', content: message.content, usage };
}

/** One provider call: no retry, no fallback, bounded response read. */
export async function callOutfitGen(config: AzureConfig, body: JsonObject, signal: AbortSignal,
  transport: AzureTransport = fetch): Promise<OutfitGenOutcome> {
  if (!azureConfigured(config)) throw new ProtocolError('UNCONFIGURED');
  signal.throwIfAborted();
  const response = await transport(OUTFITGEN_ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey! }, body: JSON.stringify(body) });
  const unusable = (): OutfitGenOutcome => response.status === 200
    ? { code: 'FAILED', content: null, usage: UNUSABLE_RESPONSE_USAGE, unusable: true } : { code: 'FAILED', content: null, usage: null, unusable: true };
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {}); return unusable();
  }
  // A read that fails mid-body (abort, timeout, reset) is transport uncertainty and stays on the held/expiry path;
  // a complete body that is oversized or not JSON is unusable.
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = await readBounded(response.body, OUTFITGEN_LIMITS.responseBytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError && !signal.aborted) return unusable();
    throw failure;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return unusable(); }
  if (!object(value)) return unusable();
  return classifyOutfitGenResponse(response.status, value);
}
