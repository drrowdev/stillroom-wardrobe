import {
  STYLIST_LIMITS, STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_NOTICE_REVISION, STYLIST_RESERVATION_MICRO, STYLIST_REVIEW_EXPIRES,
  buildStylistRequest, claimedCandidate, conversationBytes, parseStylistBody, parseStylistItem, stylistEligible,
  validateStylistReply, type StylistItem,
} from '../../../src/domain/stylist.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { AI_BUDGET_CONTRACT, AI_BUDGET_CONTRACT_HEADER, parseAiBudget } from '../../../src/domain/ai-budget.ts';
import { UUID, exact, object, ProtocolError, readBounded, readJson, validAccounting, type JsonObject } from '../analyze-clothing/protocol.ts';
import { callStylist, type StylistOutcome } from './azure.ts';

export type StylistConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; azure: AzureConfig };
export const STYLIST_RPCS = ['stylist_status', 'stylist_claim', 'stylist_finish'] as const;
const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONSENT_REQUIRED: 403, TERMINAL: 409, TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415, FILTERED: 422, ALLOWANCE: 429, FAILED: 502, UNCONFIGURED: 503, INACTIVE: 503,
  CONFIG_CHANGED: 503, BUSY: 503, TIMEOUT: 504,
};
const finishCodes: Record<string, string> = {
  EXPIRED: 'TIMEOUT', NOT_DISPATCHED: 'FAILED', INVALID_USAGE: 'FAILED', USAGE_ANOMALY: 'FAILED', USAGE_CONFLICT: 'FAILED',
};
const allowedHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info', AI_BUDGET_CONTRACT_HEADER.toLowerCase()];
const HANDLER_MS = 45000;
function stageSignal(signal: AbortSignal, ms: number) { return AbortSignal.any([signal, AbortSignal.timeout(ms)]); }
function closedCode(value: unknown): string {
  const code = typeof value === 'string' && Object.hasOwn(finishCodes, value) ? finishCodes[value] : value;
  return typeof code === 'string' && Object.hasOwn(statusCodes, code) ? code : 'FAILED';
}
function allowedOrigin(origin: string | null, url: string): boolean {
  if (origin === null || origin === 'https://stillroom-wardrobe.pages.dev') return true;
  return /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(url)
    && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin);
}
function serverConfig(config: StylistConfig): boolean {
  return (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl)
    || /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl))
    && typeof config.publicKey === 'string' && config.publicKey.length > 0 && config.publicKey.length <= 8192
    && typeof config.serviceKey === 'string' && config.serviceKey.length > 0 && config.serviceKey.length <= 8192;
}
const microText = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);

/**
 * Stylist chat (ST1a, inactive). Order: closed body parsing (no RPC on invalid input), verified /auth/v1/user,
 * status preflight, service claim (the owner comes only from the verified user), eligibility recheck, bounded request,
 * dispatch deadline, one provider call, finish. Content is returned only when finish returns OK. Model output is
 * plain data: it is validated against the claimed item aliases and never calls any write RPC.
 */
export function createStylistHandler(config: StylistConfig, azureTransport: AzureTransport = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string) => reply({ code: closedCode(code) }, statusCodes[closedCode(code)]!);
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(HANDLER_MS)]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/stylist-chat', '/functions/v1/stylist-chat'].includes(url.pathname)) return error('INVALID_INPUT');
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'POST'
          || (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').some((value) =>
            value.trim() !== '' && !allowedHeaders.includes(value.trim().toLowerCase()))) return error('INVALID_INPUT');
        headers.set('Access-Control-Allow-Methods', 'POST');
        headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'POST') return error('INVALID_INPUT');
      const bearer = request.headers.get('Authorization') ?? '';
      if (!bearer.startsWith('Bearer ') || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(bearer.slice(7))) return error('UNAUTHENTICATED');
      if (!serverConfig(config)) return error('UNCONFIGURED');
      if (request.headers.get(AI_BUDGET_CONTRACT_HEADER) !== AI_BUDGET_CONTRACT) return error('UNAVAILABLE');
      if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || request.headers.has('Content-Encoding')) return error('UNSUPPORTED_MEDIA');
      const length = request.headers.get('Content-Length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > STYLIST_LIMITS.bodyBytes)) return error('TOO_LARGE');
      const raw = await readBounded(request.body, STYLIST_LIMITS.bodyBytes, signal);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return error('INVALID_INPUT'); }
      const input = parseStylistBody(parsed);
      if (!input) return error('INVALID_INPUT');
      if (conversationBytes(input) > STYLIST_LIMITS.conversationBytes) return error('TOO_LARGE');

      const authSignal = stageSignal(signal, 5000);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const owner = user.id;
      const rpc = async (name: (typeof STYLIST_RPCS)[number], body: JsonObject, service = false, limit = 32768): Promise<JsonObject> => {
        const dbSignal = stageSignal(signal, 5000);
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: dbSignal,
          headers: { Authorization: service ? 'Bearer '.concat(config.serviceKey) : bearer,
            apikey: service ? config.serviceKey : config.publicKey, 'Content-Type': 'application/json',
            [AI_BUDGET_CONTRACT_HEADER]: AI_BUDGET_CONTRACT },
          body: JSON.stringify(body),
        });
        const result = await readJson(response, limit, dbSignal);
        if (!response.ok || !object(result) || typeof result.code !== 'string') throw new ProtocolError('FAILED');
        return result;
      };

      const preflight = await rpc('stylist_status', {});
      if (preflight.code !== 'OK') return error(closedCode(preflight.code));
      // A database that ignored the contract header answers in the old shape: refused before any claim.
      if (parseAiBudget(preflight.budget) === null) return error('UNAVAILABLE');
      const policy = preflight.policy, consent = preflight.consent;
      if (!object(policy) || policy.activated !== true) return error('INACTIVE');
      if (!object(consent) || consent.enabled !== true || consent.noticeRevision !== policy.noticeRevision) return error('CONSENT_REQUIRED');
      if (policy.noticeRevision !== STYLIST_NOTICE_REVISION || policy.manifestId !== STYLIST_MANIFEST || policy.modelId !== STYLIST_MODEL
        || !microText(policy.maxRequestMicro) || BigInt(policy.maxRequestMicro as string) < BigInt(STYLIST_RESERVATION_MICRO)
        || Date.now() >= STYLIST_REVIEW_EXPIRES || !azureConfigured(config.azure)) return error('UNCONFIGURED');

      const claim = await rpc('stylist_claim', { p_owner_id: owner, p_request_id: input.requestId, p_manifest_id: STYLIST_MANIFEST },
        true, STYLIST_LIMITS.responseBytes);
      if (claim.code !== 'OK' || claim.claimed !== true) return error(closedCode(claim.code));
      if (!exact(claim, ['code', 'claimed', 'manifestId', 'dispatchBeforeMs', 'items']) || claim.manifestId !== STYLIST_MANIFEST
        || typeof claim.dispatchBeforeMs !== 'number' || !Number.isSafeInteger(claim.dispatchBeforeMs)
        || !Array.isArray(claim.items) || claim.items.length > STYLIST_LIMITS.items) throw new ProtocolError('FAILED');
      const finish = async (code: StylistOutcome['code'] | 'NOT_DISPATCHED', usage: StylistOutcome['usage'] | null) => {
        const result = await rpc('stylist_finish', { p_owner_id: owner, p_request_id: input.requestId, p_code: code, p_usage: usage }, true);
        if (result.code !== 'BUSY' && !validAccounting(result.accounting)) throw new ProtocolError('FAILED');
        return String(result.code);
      };
      const items: StylistItem[] = [];
      for (const entry of claim.items) {
        const item = parseStylistItem(entry);
        if (item && stylistEligible(claimedCandidate(owner, item), { ownerId: owner, weather: input.weather })) items.push(item);
      }
      let built;
      try { built = buildStylistRequest(input, items); } catch {
        await finish('NOT_DISPATCHED', null); return error('TOO_LARGE');
      }
      if (Date.now() >= claim.dispatchBeforeMs) { await finish('NOT_DISPATCHED', null); return error('TIMEOUT'); }
      signal.throwIfAborted();
      const outcome = await callStylist(config.azure, built.body, stageSignal(signal, STYLIST_LIMITS.requestMs), azureTransport);
      const parsedReply = outcome.code === 'OK' ? validateStylistReply(outcome.content, built.aliases) : null;
      const code = outcome.code === 'OK' && !parsedReply ? 'FAILED' : outcome.code;
      const finished = await finish(code, outcome.usage);
      if (finished !== 'OK' || code !== 'OK' || !parsedReply) return error(finished === 'OK' ? code : finished);
      return reply({ code: 'OK', reply: parsedReply.reply, outfits: parsedReply.outfits }, 200);
    } catch (failure) {
      return error(signal.aborted || failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name)
        ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    }
  };
}
