import {
  TRYON_LIMITS, TRYON_MANIFEST, TRYON_MAX_STEPS, TRYON_MODEL, TRYON_NOTICE_REVISION, TRYON_RESERVATION_MICRO, TRYON_REVIEW_EXPIRES_AT,
  tryOnSlots, type TryOnSlot,
} from '../../../src/domain/tryon.ts';
import { admitProviderJpeg } from '../../../src/images/provider-jpeg.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { UUID, exact, object, ProtocolError, readBounded, readJson, sha256, validAccounting, type JsonObject } from '../analyze-clothing/protocol.ts';
import { callTryOn, type TryOnOutcome } from './azure.ts';

export type TryOnConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; azure: AzureConfig; probeToken?: string | null };
export const TRYON_RPCS = ['tryon_status', 'tryon_claim', 'tryon_dispatch', 'tryon_finish'] as const;
const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONSENT_REQUIRED: 403, NOT_FOUND: 404, TERMINAL: 409,
  CONFLICT: 409, CHAIN_MISMATCH: 409, WITHDRAWN: 409, CANCELLED: 409, EXPIRED: 409, RESULTS_FULL: 409, TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415, NO_GARMENTS: 422, FILTERED: 422, OUTPUT_REJECTED: 422, RATE_LIMIT: 429, ALLOWANCE: 429,
  FAILED: 502, UNCONFIGURED: 503, INACTIVE: 503, CONFIG_CHANGED: 503, BUSY: 503, TIMEOUT: 504,
};
// Claim codes pass through; the dispatch mark and finish codes that are internal to the server map to the closed set.
const markCodes: Record<string, string> = { EXPIRED: 'TIMEOUT', CLIENT_GONE: 'TIMEOUT', ALREADY_AUTHORISED: 'FAILED', PROBE_LIMIT: 'UNAVAILABLE' };
const finishCodes: Record<string, string> = {
  EXPIRED: 'TIMEOUT', LATE: 'CONFLICT', PRE_DISPATCH: 'FAILED', NOT_DISPATCHED: 'FAILED', INVALID_USAGE: 'FAILED',
  USAGE_ANOMALY: 'FAILED', USAGE_CONFLICT: 'FAILED', PROBE_LIMIT: 'UNAVAILABLE',
};
const claimCodes: Record<string, string> = { PROBE_LIMIT: 'UNAVAILABLE' };
const allowedHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const exposedHeaders = ['x-stillroom-tryon-sha256'];
const FIELDS = ['chainId', 'step', 'requestId', 'manifestId', 'person'];
function closedCode(value: unknown, map: Record<string, string> = {}): string {
  const code = typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : value;
  return typeof code === 'string' && Object.hasOwn(statusCodes, code) ? code : 'FAILED';
}
function allowedOrigin(origin: string | null, url: string): boolean {
  if (origin === null || origin === 'https://stillroom-wardrobe.pages.dev') return true;
  return /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(url)
    && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin);
}
function serverConfig(config: TryOnConfig): boolean {
  return (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl)
    || /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl))
    && typeof config.publicKey === 'string' && config.publicKey.length > 0 && config.publicKey.length <= 8192
    && typeof config.serviceKey === 'string' && config.serviceKey.length > 0 && config.serviceKey.length <= 8192;
}
const microText = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const safeMs = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const HEX64 = /^[0-9a-f]{64}$/;
// Storage paths are server-issued (item_images.main_path): owner UUID, then plain segments. Anything else is refused.
const GARMENT_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){1,4}$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

type Ingress = { chainId: string; step: number; requestId: string; outfitId: string | null; person: Uint8Array<ArrayBuffer> };
async function readIngress(request: Request, signal: AbortSignal): Promise<Ingress | string> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data; ?boundary=[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(type) || request.headers.has('Content-Encoding')) {
    return 'UNSUPPORTED_MEDIA';
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > TRYON_LIMITS.ingressBytes)) return 'TOO_LARGE';
  const raw = await readBounded(request.body, TRYON_LIMITS.ingressBytes, signal);
  let form: FormData;
  try { form = await new Response(raw, { headers: { 'Content-Type': type } }).formData(); } catch { return 'INVALID_INPUT'; }
  const keys = [...form.keys()];
  const text = (name: string) => { const all = form.getAll(name); return all.length === 1 && typeof all[0] === 'string' ? all[0] : null; };
  const stepText = text('step');
  const step = stepText !== null && /^[1-3]$/.test(stepText) ? Number(stepText) : 0;
  const expected = step === 1 ? [...FIELDS, 'outfitId'] : FIELDS;
  if (step === 0 || step > TRYON_MAX_STEPS || keys.length !== expected.length || !expected.every((name) => form.getAll(name).length === 1)) {
    return 'INVALID_INPUT';
  }
  const chainId = text('chainId'), requestId = text('requestId'), manifestId = text('manifestId');
  const outfitId = step === 1 ? text('outfitId') : null;
  const file = form.get('person');
  if (chainId === null || !UUID.test(chainId) || requestId === null || !UUID.test(requestId) || manifestId === null
    || (step === 1 && (outfitId === null || !UUID.test(outfitId))) || !(file instanceof Blob)) return 'INVALID_INPUT';
  if (manifestId !== TRYON_MANIFEST) return 'CONFIG_CHANGED';
  if (file.type !== 'image/jpeg') return 'UNSUPPORTED_MEDIA';
  if (file.size > TRYON_LIMITS.personBytes) return 'TOO_LARGE';
  // The body photo (step 1) or the previous step's accepted output: one baseline 1024x1280 frame, metadata removed.
  // Only the admitted bytes are hashed and sent; nothing about the person is stored.
  let person: Uint8Array<ArrayBuffer>;
  try {
    const admitted = admitProviderJpeg(new Uint8Array(await file.arrayBuffer()));
    if (admitted.width !== TRYON_LIMITS.personWidth || admitted.height !== TRYON_LIMITS.personHeight
      || admitted.bytes.length > TRYON_LIMITS.personBytes) return 'INVALID_INPUT';
    person = admitted.bytes;
  } catch { return 'INVALID_INPUT'; }
  return { chainId, step, requestId, outfitId, person };
}

/**
 * Virtual try-on, one garment step per request (VTO-1, plan rev4 §6.2; INACTIVE until the owner's switch). Order:
 * origin and method, the operator probe gate when its headers are present, closed multipart ingress (the person JPEG is
 * admitted by the strict 1024x1280 profile; no RPC on invalid input), verified /auth/v1/user, status preflight, then the
 * service claim for the verified owner only. The claim returns the step's frozen garment; everything after it is the
 * claimed work (W1): the garment download with the user's JWT, the once-only dispatch mark, the provider call and the
 * finish. An intermediate's bytes are released only after finish returned OK for the chain's active attempt; the last
 * step returns the stored result's id. The body photo is never written anywhere.
 *
 * Only the two pictures and the fixed prompt for the step's slot are sent; no item fields, titles, notes or identifiers.
 */
export function createTryOnHandler(config: TryOnConfig, registrar: TryOnRegistrar | null, azureTransport: AzureTransport = fetch) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string, map?: Record<string, string>) => {
      const closed = closedCode(code, map);
      return reply({ code: closed }, statusCodes[closed]!);
    };
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = deadlineSignal(timers, TRYON_LIMITS.serverMs);
    const signal = AbortSignal.any([request.signal, server]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/try-on', '/functions/v1/try-on'].includes(url.pathname)) return error('INVALID_INPUT');
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
      const probe = await probeGate(request, origin, config.probeToken ?? null);
      if (probe.refused) return error(probe.refused);
      const ingress = await readIngress(request, signal);
      if (typeof ingress === 'string') return error(ingress);
      const personSha = await sha256(ingress.person);

      const authSignal = AbortSignal.any([signal, deadlineSignal(timers, 5000)]);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const owner = user.id;
      const rpc = rpcClient(config, bearer, timers);

      const preflight = await rpc('tryon_status', {}, false, signal);
      if (preflight.code !== 'OK' && !(probe.id !== null && preflight.code === 'INACTIVE')) return error(String(preflight.code), claimCodes);
      const policy = preflight.policy, consent = preflight.consent;
      if (probe.id !== null) {
        // The probe runs only while the owner's ordinary try-on is switched off; SQL judges its own consent and limits.
        if (!object(policy) || policy.activated !== false) return error('INVALID_INPUT');
      } else {
        if (!object(policy) || policy.activated !== true) return error('INACTIVE');
        if (!object(consent) || consent.enabled !== true || consent.noticeRevision !== policy.noticeRevision) return error('CONSENT_REQUIRED');
      }
      if (policy.noticeRevision !== TRYON_NOTICE_REVISION || policy.manifestId !== TRYON_MANIFEST || policy.modelId !== TRYON_MODEL
        || !microText(policy.maxRequestMicro) || BigInt(policy.maxRequestMicro as string) < BigInt(TRYON_RESERVATION_MICRO)
        || Date.now() >= Date.parse(TRYON_REVIEW_EXPIRES_AT) || !azureConfigured(config.azure)) return error('UNCONFIGURED');
      if (policy.providerAvailable !== true) return error('UNAVAILABLE');
      // W1: without a way to keep the claimed work alive, nothing is claimed.
      if (registrar === null) return error('UNCONFIGURED');

      // The claim writes a held row, so it runs on the server-owned lifetime, not the browser's.
      const claim = await rpc('tryon_claim', { p_owner_id: owner, p_chain_id: ingress.chainId, p_step: ingress.step,
        p_request_id: ingress.requestId, p_manifest_id: TRYON_MANIFEST, p_outfit_id: ingress.outfitId,
        p_person_sha256: ingress.step === 1 ? null : personSha, p_probe_id: probe.id }, true, server);
      if (claim.code !== 'OK' || claim.claimed !== true) return error(String(claim.code), claimCodes);
      const garment = object(claim.garment) ? claim.garment : null;
      if (!exact(claim, ['code', 'claimed', 'manifestId', 'chainId', 'step', 'steps', 'last', 'slot', 'garment', 'dispatchBeforeMs',
        'requestSeconds', 'reservationMicro']) || claim.manifestId !== TRYON_MANIFEST || claim.chainId !== ingress.chainId
        || claim.step !== ingress.step || typeof claim.steps !== 'number' || claim.step > claim.steps || claim.steps > TRYON_MAX_STEPS
        || claim.last !== (claim.step === claim.steps) || !tryOnSlots.includes(claim.slot as TryOnSlot) || !safeMs(claim.dispatchBeforeMs)
        || garment === null || !exact(garment, ['path', 'mainSha256', 'bytes']) || typeof garment.path !== 'string'
        || !GARMENT_PATH.test(garment.path) || !garment.path.startsWith(`${owner}/`) || typeof garment.mainSha256 !== 'string'
        || !HEX64.test(garment.mainSha256) || typeof garment.bytes !== 'number' || !Number.isSafeInteger(garment.bytes)
        || garment.bytes < 1 || garment.bytes > TRYON_LIMITS.garmentBytes) {
        // The held row expires by the claim's cutoff (released: never authorised); nothing was dispatched.
        throw new ProtocolError('FAILED');
      }

      let accept!: (registered: boolean) => void;
      const registration = new Promise<boolean>((resolve) => { accept = resolve; });
      const work = runClaimed({ config, bearer, owner, requestId: ingress.requestId, person: ingress.person, slot: claim.slot as TryOnSlot,
        last: claim.last, garment: { path: garment.path, sha256: garment.mainSha256, bytes: garment.bytes },
        dispatchBeforeMs: claim.dispatchBeforeMs, remainingMs: TRYON_LIMITS.serverMs - (Date.now() - startedAt), browser: request.signal,
        registration, azureTransport });
      try { registrar(work); accept(true); } catch { accept(false); }
      const outcome = await work;
      // Delivery only: the settlement has already run whether or not the browser is still there.
      if (request.signal.aborted) return error('TIMEOUT');
      if (outcome.code !== 'OK') return error(outcome.code);
      if (outcome.result) return reply({ code: 'OK', resultId: outcome.result.resultId, expiresAtMs: outcome.result.expiresAtMs }, 200);
      if (!outcome.output) return error('FAILED');
      headers.set('Content-Type', 'image/jpeg');
      headers.set('Content-Length', String(outcome.output.bytes.length));
      headers.set('X-Stillroom-TryOn-Sha256', outcome.output.sha256);
      if (origin !== null) headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '));
      return new Response(outcome.output.bytes, { status: 200, headers });
    } catch (failure) {
      return error(signal.aborted || timeoutFailure(failure) ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };
}

export type TryOnRegistrar = (work: Promise<unknown>) => void;
export type ClaimedOutcome = {
  code: string;
  output: { bytes: Uint8Array<ArrayBuffer>; sha256: string } | null;
  result: { resultId: string; expiresAtMs: number } | null;
};
type ClaimedWork = {
  config: TryOnConfig; bearer: string; owner: string; requestId: string; person: Uint8Array<ArrayBuffer>; slot: TryOnSlot; last: boolean;
  garment: { path: string; sha256: string; bytes: number }; dispatchBeforeMs: number; remainingMs: number; browser: AbortSignal;
  registration: Promise<boolean>; azureTransport: AzureTransport;
};
/** Test hook: observes the one work promise per claimed request, so tests can prove the registered and awaited references are the same. */
export const claimedWorkObserver: { current: ((work: Promise<ClaimedOutcome>) => void) | null } = { current: null };

const timeoutFailure = (failure: unknown) => failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name);
function deadlineSignal(timers: ReturnType<typeof setTimeout>[], ms: number): AbortSignal {
  const controller = new AbortController();
  timers.push(setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), Math.max(0, ms)));
  return controller.signal;
}
function rpcClient(config: TryOnConfig, bearer: string, timers: ReturnType<typeof setTimeout>[]) {
  return async (name: (typeof TRYON_RPCS)[number], body: JsonObject, service: boolean, base: AbortSignal,
    ms = 5000): Promise<JsonObject> => {
    const dbSignal = AbortSignal.any([base, deadlineSignal(timers, ms)]);
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

// The stored main photo of the step's garment, read with the owner's own JWT (never the service role), with the cap,
// length and hash of the claim's frozen snapshot. Any difference is a refusal before dispatch.
async function downloadGarment(work: ClaimedWork, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const path = work.garment.path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${work.config.supabaseUrl}/storage/v1/object/wardrobe/${path}`, {
    headers: { Authorization: work.bearer, apikey: work.config.publicKey }, redirect: 'error', cache: 'no-store', signal,
  });
  if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'image/jpeg') {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readBounded(response.body, work.garment.bytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError) return null;
    throw failure;
  }
  return bytes.length === work.garment.bytes && await sha256(bytes) === work.garment.sha256 ? bytes : null;
}

// The claimed work: its own server lifetime, every deadline, both pictures and every timer are owned and released here.
// It never rejects. Before the provider fetch, every exit settles as PRE_DISPATCH; SQL then decides from the durable
// once-only authorisation whether that is released (never authorised) or charged (authorised but not fetched).
function runClaimed(work: ClaimedWork): Promise<ClaimedOutcome> {
  const promise = (async (): Promise<ClaimedOutcome> => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = deadlineSignal(timers, work.remainingMs);
    const rpc = rpcClient(work.config, work.bearer, timers);
    const none = (code: string): ClaimedOutcome => ({ code, output: null, result: null });
    try {
      const finish = async (code: TryOnOutcome['code'] | 'PRE_DISPATCH', usage: TryOnOutcome['usage'],
        output: { sha256: string; bytes: Uint8Array<ArrayBuffer> } | null, fetch: { started: boolean; clientLive: boolean | null }) => {
        const result = await rpc('tryon_finish', { p_owner_id: work.owner, p_request_id: work.requestId, p_code: code, p_usage: usage,
          p_output_sha256: output?.sha256 ?? null, p_output_bytes: output?.bytes.length ?? null,
          p_output: output && work.last ? `\\x${hex(output.bytes)}` : null, p_fetch_started: fetch.started,
          p_client_live_at_fetch: fetch.clientLive, p_client_gone: work.browser.aborted }, true, server);
        if (result.code !== 'BUSY' && !validAccounting(result.accounting)) throw new ProtocolError('FAILED');
        return result;
      };
      const preDispatch = async (code: string) => {
        await finish('PRE_DISPATCH', null, null, { started: false, clientLive: null });
        return none(code);
      };
      // No download or dispatch until the runtime has accepted this promise. A refused registration spends nothing.
      if (!await work.registration) return await preDispatch('UNCONFIGURED');
      let downloaded: Uint8Array<ArrayBuffer> | null;
      try { downloaded = await downloadGarment(work, AbortSignal.any([server, deadlineSignal(timers, TRYON_LIMITS.downloadMs)])); } catch (failure) {
        if (server.aborted) throw failure;
        return await preDispatch(timeoutFailure(failure) ? 'TIMEOUT' : 'FAILED');
      }
      if (downloaded === null) return await preDispatch('FAILED');
      const garment = downloaded;
      // D1: one committed authorisation, read within its deadline, is the only way to a fetch. A lost, late or refused
      // mark means no fetch; a duplicate mark never authorises another one.
      let mark: JsonObject;
      try { mark = await rpc('tryon_dispatch', { p_owner_id: work.owner, p_request_id: work.requestId,
        p_client_present: !work.browser.aborted }, true, server, TRYON_LIMITS.markMs); } catch (failure) {
        if (server.aborted) throw failure;
        return await preDispatch(timeoutFailure(failure) ? 'TIMEOUT' : 'FAILED');
      }
      if (mark.code !== 'AUTHORISED') return await preDispatch(closedCode(mark.code, markCodes));
      if (!exact(mark, ['code', 'authorisedAtMs', 'dispatchBeforeMs']) || !safeMs(mark.authorisedAtMs) || !safeMs(mark.dispatchBeforeMs)) {
        return await preDispatch('FAILED');
      }
      const cutoff = Math.min(work.dispatchBeforeMs, mark.dispatchBeforeMs);
      if (Date.now() >= cutoff) return await preDispatch('TIMEOUT');
      // R1: sampled synchronously on the line before the call; callTryOn invokes the transport before its first await.
      // Once authorised the fetch is not tied to the browser: the cost is committed, publication is judged by finish.
      const clientLive = !work.browser.aborted;
      const call = callTryOn(work.config.azure, work.person, garment, work.slot,
        AbortSignal.any([server, deadlineSignal(timers, TRYON_LIMITS.providerMs)]), work.azureTransport);
      const outcome = await call;
      const output = outcome.code === 'OK' ? { sha256: await sha256(outcome.image), bytes: outcome.image } : null;
      const finished = await finish(outcome.code, outcome.usage, output, { started: true, clientLive });
      if (finished.code !== 'OK' || outcome.code !== 'OK' || !output) {
        return none(closedCode(finished.code === 'OK' ? outcome.code : String(finished.code), finishCodes));
      }
      if (finished.last !== work.last) throw new ProtocolError('FAILED');
      if (!work.last) return { code: 'OK', output: { bytes: output.bytes, sha256: output.sha256 }, result: null };
      if (finished.deleted === true) return none('NOT_FOUND');
      if (typeof finished.resultId !== 'string' || !UUID.test(finished.resultId) || !safeMs(finished.expiresAtMs)) {
        throw new ProtocolError('FAILED');
      }
      return { code: 'OK', output: null, result: { resultId: finished.resultId, expiresAtMs: finished.expiresAtMs } };
    } catch (failure) {
      // A provider or finish that misses its deadline is left held for provisional expiry; nothing else is retried.
      return none(server.aborted || timeoutFailure(failure) ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  })();
  claimedWorkObserver.current?.(promise);
  return promise;
}

// Operator probe (BG2b-2 §7.1). The shared secret is an additional check on top of the verified owner JWT and the
// DB-bound authorisation with its expiry, call and spend limits; it is not authentication on its own, and neither is the
// absence of an Origin header or CORS. Browsers can't send these headers (not allowed in preflight) and any request with
// an Origin is refused. With no secret configured, the normal state, every probe request is refused before any RPC.
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
