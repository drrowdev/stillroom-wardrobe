import {
  ENHANCE_LIMITS, ENHANCE_MANIFEST, ENHANCE_MODEL, ENHANCE_NOTICE_REVISION, ENHANCE_RESERVATION_MICRO, ENHANCE_REVIEW_EXPIRES,
} from '../../../src/domain/enhancement.ts';
import { readJpegHeader } from '../../../src/images/jpeg.ts';
import { inspectRestoreJpeg } from '../../../src/images/restore-jpeg.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { UUID, exact, object, ProtocolError, readBounded, readJson, sha256, validAccounting, type JsonObject } from '../analyze-clothing/protocol.ts';
import { callEnhance, type EnhanceOutcome } from './azure.ts';

export type EnhanceConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; azure: AzureConfig };
export const ENHANCE_RPCS = ['enhance_status', 'enhance_claim', 'enhance_finish'] as const;
const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONSENT_REQUIRED: 403, TERMINAL: 409, TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415, FILTERED: 422, OUTPUT_REJECTED: 422, RATE_LIMIT: 429, ALLOWANCE: 429, FAILED: 502,
  UNCONFIGURED: 503, INACTIVE: 503, CONFIG_CHANGED: 503, BUSY: 503, TIMEOUT: 504,
};
const finishCodes: Record<string, string> = {
  EXPIRED: 'TIMEOUT', NOT_DISPATCHED: 'FAILED', INVALID_USAGE: 'FAILED', USAGE_ANOMALY: 'FAILED', USAGE_CONFLICT: 'FAILED',
  PROBE_LIMIT: 'UNAVAILABLE',
};
const allowedHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info', 'x-stillroom-request-id'];
const exposedHeaders = ['x-stillroom-enhancement-sha256', 'x-stillroom-enhancement-usable-until'];
function closedCode(value: unknown): string {
  const code = typeof value === 'string' && Object.hasOwn(finishCodes, value) ? finishCodes[value] : value;
  return typeof code === 'string' && Object.hasOwn(statusCodes, code) ? code : 'FAILED';
}
function allowedOrigin(origin: string | null, url: string): boolean {
  if (origin === null || origin === 'https://stillroom-wardrobe.pages.dev') return true;
  return /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(url)
    && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin);
}
function serverConfig(config: EnhanceConfig): boolean {
  return (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl)
    || /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl))
    && typeof config.publicKey === 'string' && config.publicKey.length > 0 && config.publicKey.length <= 8192
    && typeof config.serviceKey === 'string' && config.serviceKey.length > 0 && config.serviceKey.length <= 8192;
}
const microText = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);

/**
 * Photo enhancement (BG2b-1, INACTIVE). Order: closed ingress (the app's byte-preservable baseline JPEG, read with
 * the cap enforced; no RPC on invalid input), verified /auth/v1/user, status preflight, service claim for the verified
 * owner only, dispatch deadline, one provider call, strict output admission, finish. H2 bytes are released only after
 * finish returns OK, which has already committed the evidence and tombstone for this output hash and length.
 * From the claim on, the provider call and settlement run on a server-owned lifetime, independent of the browser: a
 * cancelled request still settles its usage, and only the delivery of H2 to the gone client is suppressed.
 * Only the photo is sent; no item fields, titles, notes or identifiers other than the opaque request UUID for accounting,
 * which stays on the server.
 */
export function createEnhanceHandler(config: EnhanceConfig, azureTransport: AzureTransport = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string) => reply({ code: closedCode(code) }, statusCodes[closedCode(code)]!);
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const deadline = (ms: number) => {
      const controller = new AbortController();
      timers.push(setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms));
      return controller.signal;
    };
    const stageSignal = (base: AbortSignal, ms: number) => AbortSignal.any([base, deadline(ms)]);
    const server = deadline(ENHANCE_LIMITS.requestMs);
    const signal = AbortSignal.any([request.signal, server]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/enhance-photo', '/functions/v1/enhance-photo'].includes(url.pathname)) return error('INVALID_INPUT');
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
      if (!UUID.test(requestId)) return error('INVALID_INPUT');
      if (request.headers.get('Content-Type') !== 'image/jpeg' || request.headers.has('Content-Encoding')) return error('UNSUPPORTED_MEDIA');
      const length = request.headers.get('Content-Length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > ENHANCE_LIMITS.imageBytes)) return error('TOO_LARGE');
      const image = await readBounded(request.body, ENHANCE_LIMITS.imageBytes, signal);
      try {
        const { width, height } = readJpegHeader(image);
        if (width > ENHANCE_LIMITS.imageMaxSide || height > ENHANCE_LIMITS.imageMaxSide
          || inspectRestoreJpeg(image, width, height).kind !== 'preserve') return error('INVALID_INPUT');
      } catch { return error('INVALID_INPUT'); }
      const inputHash = await sha256(image);

      const authSignal = stageSignal(signal, 5000);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const owner = user.id;
      const rpc = async (name: (typeof ENHANCE_RPCS)[number], body: JsonObject, service = false,
        base: AbortSignal = signal): Promise<JsonObject> => {
        const dbSignal = stageSignal(base, 5000);
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: dbSignal,
          headers: { Authorization: service ? 'Bearer '.concat(config.serviceKey) : bearer,
            apikey: service ? config.serviceKey : config.publicKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await readJson(response, 32768, dbSignal);
        if (!response.ok || !object(result) || typeof result.code !== 'string') throw new ProtocolError('FAILED');
        return result;
      };

      const preflight = await rpc('enhance_status', {});
      // The claim writes a held row, so it and everything after it run on the server-owned lifetime.
      if (preflight.code !== 'OK') return error(closedCode(preflight.code));
      const policy = preflight.policy, consent = preflight.consent;
      if (!object(policy) || policy.activated !== true) return error('INACTIVE');
      if (!object(consent) || consent.enabled !== true || consent.noticeRevision !== policy.noticeRevision) return error('CONSENT_REQUIRED');
      if (policy.noticeRevision !== ENHANCE_NOTICE_REVISION || policy.manifestId !== ENHANCE_MANIFEST || policy.modelId !== ENHANCE_MODEL
        || !microText(policy.maxRequestMicro) || BigInt(policy.maxRequestMicro as string) < BigInt(ENHANCE_RESERVATION_MICRO)
        || Date.now() >= ENHANCE_REVIEW_EXPIRES || !azureConfigured(config.azure)) return error('UNCONFIGURED');
      if (policy.providerAvailable !== true) return error('UNAVAILABLE');

      const claim = await rpc('enhance_claim', { p_owner_id: owner, p_request_id: requestId, p_manifest_id: ENHANCE_MANIFEST,
        p_input_sha256: inputHash, p_probe_id: null }, true, server);
      if (claim.code !== 'OK' || claim.claimed !== true) return error(closedCode(claim.code));
      if (!exact(claim, ['code', 'claimed', 'manifestId', 'dispatchBeforeMs', 'requestSeconds']) || claim.manifestId !== ENHANCE_MANIFEST
        || typeof claim.dispatchBeforeMs !== 'number' || !Number.isSafeInteger(claim.dispatchBeforeMs)) throw new ProtocolError('FAILED');
      const finish = async (code: EnhanceOutcome['code'] | 'NOT_DISPATCHED', usage: EnhanceOutcome['usage'],
        output: { sha256: string; bytes: number } | null) => {
        const result = await rpc('enhance_finish', { p_owner_id: owner, p_request_id: requestId, p_code: code, p_usage: usage,
          p_output_sha256: output?.sha256 ?? null, p_output_bytes: output?.bytes ?? null }, true, server);
        if (result.code !== 'BUSY' && !validAccounting(result.accounting)) throw new ProtocolError('FAILED');
        return result;
      };
      if (Date.now() >= claim.dispatchBeforeMs || request.signal.aborted) {
        await finish('NOT_DISPATCHED', null, null);
        return error('TIMEOUT');
      }
      const outcome = await callEnhance(config.azure, image, stageSignal(server, ENHANCE_LIMITS.providerMs), azureTransport);
      const output = outcome.code === 'OK' ? { sha256: await sha256(outcome.image), bytes: outcome.image.length } : null;
      const finished = await finish(outcome.code, outcome.usage, output);
      if (request.signal.aborted) return error('TIMEOUT');
      if (finished.code !== 'OK' || outcome.code !== 'OK' || !output) {
        return error(finished.code === 'OK' ? outcome.code : String(finished.code));
      }
      if (typeof finished.usableUntilMs !== 'number' || !Number.isSafeInteger(finished.usableUntilMs)) throw new ProtocolError('FAILED');
      headers.set('Content-Type', 'image/jpeg');
      headers.set('Content-Length', String(output.bytes));
      headers.set('X-Stillroom-Enhancement-Sha256', output.sha256);
      headers.set('X-Stillroom-Enhancement-Usable-Until', String(finished.usableUntilMs));
      if (origin !== null) headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '));
      return new Response(outcome.image, { status: 200, headers });
    } catch (failure) {
      return error(signal.aborted || failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name)
        ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };
}
