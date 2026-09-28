import {
  ENHANCE_LIMITS, ENHANCE_MANIFEST, ENHANCE_MODEL, ENHANCE_NOTICE_REVISION, ENHANCE_RESERVATION_MICRO, ENHANCE_REVIEW_EXPIRES,
} from '../../../src/domain/enhancement.ts';
import { readJpegHeader } from '../../../src/images/jpeg.ts';
import { inspectRestoreJpeg } from '../../../src/images/restore-jpeg.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { UUID, exact, object, ProtocolError, readBounded, readJson, sha256, validAccounting, type JsonObject } from '../analyze-clothing/protocol.ts';
import { callEnhance, type EnhanceOutcome } from './azure.ts';

export type EnhanceConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; azure: AzureConfig; probeToken?: string | null };
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
 * Photo enhancement (BG2b-1 backend, BG2b-2 lifetime; INACTIVE until the owner's switch). Order: closed ingress (the
 * app's byte-preservable baseline JPEG, read with the cap enforced; no RPC on invalid input), the operator probe gate
 * when its headers are present, verified /auth/v1/user, status preflight, service claim for the verified owner only,
 * then the claimed work. H2 bytes are released only after finish returns OK, which has already committed the evidence
 * and tombstone for this output hash and length.
 *
 * Lifetime (W1): after the claim there is exactly one work promise. It owns its deadlines, buffers and cleanup, and it
 * dispatches only after the runtime has accepted it as a background task (EdgeRuntime.waitUntil in production, an
 * explicit registrar in fixtures). No registrar means UNCONFIGURED before any claim; a registrar that throws settles the
 * claim as not dispatched with no provider call. The handler always awaits the same promise it registered; a cancelled
 * browser only loses the delivery of H2, never the settlement.
 *
 * Only the photo is sent; no item fields, titles, notes or identifiers other than the opaque request UUID for accounting,
 * which stays on the server.
 */
export function createEnhanceHandler(config: EnhanceConfig, registrar: EnhanceRegistrar | null, azureTransport: AzureTransport = fetch) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string) => reply({ code: closedCode(code) }, statusCodes[closedCode(code)]!);
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    // Pre-claim timers only. Nothing the claimed work depends on is cleared by this response's finally.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = deadlineSignal(timers, ENHANCE_LIMITS.requestMs);
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
      const probe = await probeGate(request, origin, config.probeToken ?? null);
      if (probe.refused) return error(probe.refused);
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

      const authSignal = AbortSignal.any([signal, deadlineSignal(timers, 5000)]);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const owner = user.id;
      const rpc = rpcClient(config, bearer, timers);

      const preflight = await rpc('enhance_status', {}, false, signal);
      if (preflight.code !== 'OK' && !(probe.id !== null && preflight.code === 'INACTIVE')) return error(closedCode(preflight.code));
      const policy = preflight.policy, consent = preflight.consent;
      if (probe.id !== null) {
        // A1: the probe runs only while the owner's ordinary enhancement is switched off, whatever the consent state.
        if (!object(policy) || policy.activated !== false) return error('INVALID_INPUT');
      } else {
        if (!object(policy) || policy.activated !== true) return error('INACTIVE');
        if (!object(consent) || consent.enabled !== true || consent.noticeRevision !== policy.noticeRevision) return error('CONSENT_REQUIRED');
      }
      if (policy.noticeRevision !== ENHANCE_NOTICE_REVISION || policy.manifestId !== ENHANCE_MANIFEST || policy.modelId !== ENHANCE_MODEL
        || !microText(policy.maxRequestMicro) || BigInt(policy.maxRequestMicro as string) < BigInt(ENHANCE_RESERVATION_MICRO)
        || Date.now() >= ENHANCE_REVIEW_EXPIRES || !azureConfigured(config.azure)) return error('UNCONFIGURED');
      if (policy.providerAvailable !== true) return error('UNAVAILABLE');
      // W1: without a way to keep the claimed work alive, nothing is claimed.
      if (registrar === null) return error('UNCONFIGURED');

      // The claim writes a held row, so it runs on the server-owned lifetime, not the browser's.
      const claim = await rpc('enhance_claim', { p_owner_id: owner, p_request_id: requestId, p_manifest_id: ENHANCE_MANIFEST,
        p_input_sha256: inputHash, p_probe_id: probe.id }, true, server);
      if (claim.code !== 'OK' || claim.claimed !== true) return error(closedCode(claim.code));
      if (!exact(claim, ['code', 'claimed', 'manifestId', 'dispatchBeforeMs', 'requestSeconds']) || claim.manifestId !== ENHANCE_MANIFEST
        || typeof claim.dispatchBeforeMs !== 'number' || !Number.isSafeInteger(claim.dispatchBeforeMs)) throw new ProtocolError('FAILED');

      let accept!: (registered: boolean) => void;
      const registration = new Promise<boolean>((resolve) => { accept = resolve; });
      const work = runClaimed({ config, bearer, owner, requestId, image, dispatchBeforeMs: claim.dispatchBeforeMs,
        remainingMs: ENHANCE_LIMITS.requestMs - (Date.now() - startedAt), browser: request.signal, registration, azureTransport });
      try { registrar(work); accept(true); } catch { accept(false); }
      const outcome = await work;
      // Delivery only: the settlement has already run whether or not the browser is still there.
      if (request.signal.aborted) return error('TIMEOUT');
      if (outcome.code !== 'OK' || !outcome.output) return error(outcome.code);
      headers.set('Content-Type', 'image/jpeg');
      headers.set('Content-Length', String(outcome.output.bytes.length));
      headers.set('X-Stillroom-Enhancement-Sha256', outcome.output.sha256);
      headers.set('X-Stillroom-Enhancement-Usable-Until', String(outcome.output.usableUntilMs));
      if (origin !== null) headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '));
      return new Response(outcome.output.bytes, { status: 200, headers });
    } catch (failure) {
      return error(signal.aborted || timeoutFailure(failure) ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };
}

export type EnhanceRegistrar = (work: Promise<unknown>) => void;
export type ClaimedOutcome = { code: string; output: { bytes: Uint8Array<ArrayBuffer>; sha256: string; usableUntilMs: number } | null };
type ClaimedWork = {
  config: EnhanceConfig; bearer: string; owner: string; requestId: string; image: Uint8Array<ArrayBuffer>; dispatchBeforeMs: number;
  remainingMs: number; browser: AbortSignal; registration: Promise<boolean>; azureTransport: AzureTransport;
};
/** Test hook: observes the one work promise per claimed request, so tests can prove the registered and awaited references are the same. */
export const claimedWorkObserver: { current: ((work: Promise<ClaimedOutcome>) => void) | null } = { current: null };

const timeoutFailure = (failure: unknown) => failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name);
function deadlineSignal(timers: ReturnType<typeof setTimeout>[], ms: number): AbortSignal {
  const controller = new AbortController();
  timers.push(setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), Math.max(0, ms)));
  return controller.signal;
}
function rpcClient(config: EnhanceConfig, bearer: string, timers: ReturnType<typeof setTimeout>[]) {
  return async (name: (typeof ENHANCE_RPCS)[number], body: JsonObject, service: boolean, base: AbortSignal): Promise<JsonObject> => {
    const dbSignal = AbortSignal.any([base, deadlineSignal(timers, 5000)]);
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
}

// The claimed work: its own server lifetime (what is left of the request budget), the provider deadline, the input and
// output buffers and every timer are owned and released here. It never rejects.
function runClaimed(work: ClaimedWork): Promise<ClaimedOutcome> {
  const promise = (async (): Promise<ClaimedOutcome> => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = deadlineSignal(timers, work.remainingMs);
    const rpc = rpcClient(work.config, work.bearer, timers);
    let image: Uint8Array<ArrayBuffer> | null = work.image;
    try {
      const finish = async (code: EnhanceOutcome['code'] | 'NOT_DISPATCHED', usage: EnhanceOutcome['usage'],
        output: { sha256: string; bytes: number } | null) => {
        const result = await rpc('enhance_finish', { p_owner_id: work.owner, p_request_id: work.requestId, p_code: code, p_usage: usage,
          p_output_sha256: output?.sha256 ?? null, p_output_bytes: output?.bytes ?? null }, true, server);
        if (result.code !== 'BUSY' && !validAccounting(result.accounting)) throw new ProtocolError('FAILED');
        return result;
      };
      // A2: no dispatch until the runtime has accepted this promise. A refused registration spends nothing.
      if (!await work.registration) {
        await finish('NOT_DISPATCHED', null, null);
        return { code: 'UNCONFIGURED', output: null };
      }
      if (Date.now() >= work.dispatchBeforeMs || work.browser.aborted) {
        await finish('NOT_DISPATCHED', null, null);
        return { code: 'TIMEOUT', output: null };
      }
      const outcome = await callEnhance(work.config.azure, image, AbortSignal.any([server, deadlineSignal(timers, ENHANCE_LIMITS.providerMs)]),
        work.azureTransport);
      image = null;
      const output = outcome.code === 'OK' ? { sha256: await sha256(outcome.image), bytes: outcome.image.length } : null;
      const finished = await finish(outcome.code, outcome.usage, output);
      if (finished.code !== 'OK' || outcome.code !== 'OK' || !output) {
        return { code: closedCode(finished.code === 'OK' ? outcome.code : String(finished.code)), output: null };
      }
      if (typeof finished.usableUntilMs !== 'number' || !Number.isSafeInteger(finished.usableUntilMs)) throw new ProtocolError('FAILED');
      return { code: 'OK', output: { bytes: outcome.image, sha256: output.sha256, usableUntilMs: finished.usableUntilMs } };
    } catch (failure) {
      // A provider that misses its deadline is left held for provisional expiry; nothing else is retried.
      return { code: server.aborted || timeoutFailure(failure) ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED',
        output: null };
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  })();
  claimedWorkObserver.current?.(promise);
  return promise;
}

// Operator probe (A1). The shared secret is an additional check on top of the verified owner JWT and the DB-bound
// authorisation with its expiry, call and spend limits; it is not authentication on its own, and neither is the absence
// of an Origin header or CORS. Browsers can't send these headers (not allowed in preflight) and any request with an
// Origin is refused. With no secret configured, the normal state, every probe request is refused before any RPC.
const PROBE_SECRET = /^[A-Za-z0-9_-]{43,256}$/;
async function probeGate(request: Request, origin: string | null, secret: string | null): Promise<{ id: string | null; refused: string | null }> {
  const id = request.headers.get('X-Stillroom-Probe-Authorisation'), token = request.headers.get('X-Stillroom-Probe-Token');
  if (id === null && token === null) return { id: null, refused: null };
  if (origin !== null || id === null || token === null || !UUID.test(id)) return { id: null, refused: 'INVALID_INPUT' };
  if (secret === null || !PROBE_SECRET.test(secret)) return { id: null, refused: 'UNCONFIGURED' };
  if (!PROBE_SECRET.test(token) || !await sameSecret(token, secret)) return { id: null, refused: 'UNAUTHENTICATED' };
  return { id, refused: null };
}
async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= x![index]! ^ y![index]!;
  return difference === 0;
}
