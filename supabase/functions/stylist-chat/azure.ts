import { STYLIST_ENDPOINT, STYLIST_LIMITS, utf8Bytes } from '../../../src/domain/stylist.ts';
import { observeAzureUsage, azureConfigured, type AzureConfig, type AzureTransport, type AzureUsage } from '../analyze-clothing/azure-openai.ts';
import { object, ProtocolError, readJson, type JsonObject } from '../analyze-clothing/protocol.ts';

export type StylistOutcome = { code: 'OK' | 'FAILED' | 'FILTERED'; content: string | null; usage: AzureUsage };

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
    await response.body?.cancel(); throw new ProtocolError('FAILED');
  }
  const value = await readJson(response, STYLIST_LIMITS.responseBytes, signal);
  if (!object(value)) throw new ProtocolError('FAILED');
  return classifyStylistResponse(response.status, value);
}
