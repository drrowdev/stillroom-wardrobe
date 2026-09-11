import { assertSanitizedJpeg, readJpegHeader } from '../../../src/images/jpeg.ts';
import { analyzeGoogle, googleToken, type GoogleConfig, type Transport } from './google-cloud.ts';
import {
  MANIFEST_ID, MAX_IMAGE_BYTES, MODEL_ID, ProtocolError, REQUEST_MS, RESERVATION_MICRO, REVIEW_EXPIRES,
  UUID, exact, object, readBounded, readJson, sha256, validAccounting, validResult, type JsonObject,
} from './protocol.ts';

export type HandlerConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; google: GoogleConfig };
const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONSENT_REQUIRED: 403,
  CONFLICT: 409, ACTIVE_DRAFT: 409, TERMINAL: 409, TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415,
  RATE_LIMIT: 429, ALLOWANCE: 429, UNCONFIGURED: 503, INACTIVE: 503, CONFIG_CHANGED: 503,
  ANALYSIS_FAILED: 502, TIMEOUT: 504,
};
const allowedHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info',
  'x-stillroom-request-id', 'x-stillroom-draft-id', 'x-stillroom-generation'];
function stageSignal(signal: AbortSignal, ms: number) { return AbortSignal.any([signal, AbortSignal.timeout(ms)]); }
function closedCode(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(statusCodes, value) ? value : 'ANALYSIS_FAILED';
}
function allowedOrigin(origin: string | null, url: string): boolean {
  if (origin === null || origin === 'https://stillroom-wardrobe.pages.dev') return true;
  return /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(url)
    && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin);
}
function serverConfig(config: HandlerConfig): boolean {
  return (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl)
    || /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl))
    && typeof config.publicKey === 'string' && config.publicKey.length > 0 && config.publicKey.length <= 8192
    && typeof config.serviceKey === 'string' && config.serviceKey.length > 0 && config.serviceKey.length <= 8192;
}

export function createHandler(config: HandlerConfig, googleTransport: Transport = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string) => reply({ code: closedCode(code) }, statusCodes[closedCode(code)]!);
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_MS)]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/analyze-clothing', '/functions/v1/analyze-clothing'].includes(url.pathname)) return error('INVALID_INPUT');
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
      const requestId = request.headers.get('X-Stillroom-Request-Id') ?? '';
      const draftId = request.headers.get('X-Stillroom-Draft-Id') ?? '';
      const generation = request.headers.get('X-Stillroom-Generation') ?? '';
      if (!UUID.test(requestId) || !UUID.test(draftId) || !/^[1-9][0-9]{0,9}$/.test(generation)
        || Number(generation) > 2147483647) return error('INVALID_INPUT');
      if (request.headers.get('Content-Type') !== 'image/jpeg' || request.headers.has('Content-Encoding')) return error('UNSUPPORTED_MEDIA');
      const length = request.headers.get('Content-Length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) return error('TOO_LARGE');
      const authSignal = stageSignal(signal, 5000);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const rpc = async (name: string, body: JsonObject, service = false): Promise<JsonObject> => {
        const dbSignal = stageSignal(signal, 5000);
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: dbSignal,
          headers: { Authorization: service ? 'Bearer '.concat(config.serviceKey) : bearer,
            apikey: service ? config.serviceKey : config.publicKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await readJson(response, 32768, dbSignal);
        if (!response.ok || !object(result) || typeof result.code !== 'string') throw new ProtocolError('ANALYSIS_FAILED');
        return result;
      };
      const status = async () => {
        const result = await rpc('ai_analysis_status', { p_request_id: requestId });
        if (result.code !== 'OK') return error(closedCode(result.code));
        if (!exact(result, ['code', 'status', 'result', 'accounting']) || !validAccounting(result.accounting)
          || !['dispatched', 'ready'].includes(String(result.status))) throw new ProtocolError('ANALYSIS_FAILED');
        if (result.status === 'ready') {
          if (!validResult(result.result) || result.result.requestId !== requestId || result.result.draftId !== draftId
            || result.result.generation !== Number(generation) || result.result.imageSha256 !== imageHash) throw new ProtocolError('ANALYSIS_FAILED');
        } else if (result.result !== null) throw new ProtocolError('ANALYSIS_FAILED');
        return reply(result, result.status === 'ready' ? 200 : 202);
      };
      const image = await readBounded(request.body, MAX_IMAGE_BYTES, signal);
      let width: number, height: number;
      try {
        ({ width, height } = readJpegHeader(image));
        if (width > 1600 || height > 1600) return error('INVALID_INPUT');
        assertSanitizedJpeg(image, width, height);
      } catch { return error('INVALID_INPUT'); }
      const imageHash = await sha256(image);
      const preflight = await rpc('ai_status', {});
      if (preflight.code !== 'OK') return error(closedCode(preflight.code));
      if (!object(preflight.policy) || preflight.policy.activated !== true) return error('INACTIVE');
      if (!object(preflight.consent) || preflight.consent.enabled !== true
        || !Number.isInteger(preflight.policy.noticeRevision) || Number(preflight.policy.noticeRevision) < 1
        || preflight.consent.noticeRevision !== preflight.policy.noticeRevision) return error('CONSENT_REQUIRED');
      if (!object(preflight.policy) || preflight.policy.modelId !== MODEL_ID || preflight.policy.promptVersion !== 1
        || typeof preflight.policy.maxRequestMicro !== 'string' || !/^[1-9][0-9]{0,18}$/.test(preflight.policy.maxRequestMicro)
        || BigInt(preflight.policy.maxRequestMicro) < BigInt(RESERVATION_MICRO) || Date.now() >= REVIEW_EXPIRES) return error('UNCONFIGURED');
      const token = await googleToken(config.google, stageSignal(signal, 5000), googleTransport);
      const claim = await rpc('ai_claim_analysis', {
        p_owner_id: user.id, p_request_id: requestId, p_draft_id: draftId, p_generation: Number(generation),
        p_image_sha256: imageHash, p_byte_count: image.length, p_width: width, p_height: height, p_manifest_id: MANIFEST_ID,
      }, true);
      if (claim.code === 'ALREADY_CLAIMED' && claim.claimed === false) return await status();
      if (claim.code !== 'OK' || claim.claimed !== true) return error(closedCode(claim.code));
      if (!exact(claim, ['code', 'claimed', 'manifestId', 'resultExpiresAtMs', 'dispatchBeforeMs'])
        || claim.manifestId !== MANIFEST_ID || typeof claim.dispatchBeforeMs !== 'number' || !Number.isSafeInteger(claim.dispatchBeforeMs)
        || typeof claim.resultExpiresAtMs !== 'number' || !Number.isSafeInteger(claim.resultExpiresAtMs)
        || Date.now() >= Math.min(claim.dispatchBeforeMs, claim.resultExpiresAtMs)) return error('TIMEOUT');
      signal.throwIfAborted();
      const result = await analyzeGoogle(config.google, token, image, signal, googleTransport);
      const finished = await rpc('ai_finish_analysis', {
        p_owner_id: user.id, p_request_id: requestId, p_manifest_id: MANIFEST_ID,
        p_facts: result.facts, p_usage: result.usage, p_code: result.facts ? 'SUCCESS' : 'FAILED',
      }, true);
      if (finished.code !== 'READY' || finished.stored !== true) return error('ANALYSIS_FAILED');
      return await status();
    } catch (failure) {
      return error(signal.aborted || failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name)
        ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'ANALYSIS_FAILED');
    }
  };
}
