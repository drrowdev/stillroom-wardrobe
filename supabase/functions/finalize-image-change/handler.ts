import { exact, object, ProtocolError, readBounded, readJson, REQUEST_MS, UUID } from '../analyze-clothing/protocol.ts';
import { storedObjectIdentities, verifyStoredImage } from '../finalize-analyzed-item/verify-image.ts';
import type { FinalizerConfig } from '../finalize-analyzed-item/handler.ts';

const codes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONFLICT: 409,
  UPLOAD_INCOMPLETE: 409, UNCONFIGURED: 503, SAVE_FAILED: 502, TIMEOUT: 504,
};
const requestHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const intentKeys = ['requestId', 'itemId', 'imageId', 'expectedVersion', 'currentImageId',
  'descriptionVersion', 'item', 'image', 'claim', 'sourceImageId'];
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function receipt(value: unknown, intent: Record<string, unknown>): boolean {
  return exact(value, ['requestId', 'itemId', 'imageId', 'kind', 'state', 'fingerprint', 'completedVersion'])
    && value.requestId === intent.requestId && value.itemId === intent.itemId && value.imageId === intent.imageId
    && value.kind === 'recovery' && ['reserved', 'completed'].includes(String(value.state))
    && typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.fingerprint)
    && (value.state === 'reserved' ? value.completedVersion === null : counter(value.completedVersion));
}
function databaseError(value: unknown): string {
  if (exact(value, ['code', 'message', 'details', 'hint']) && value.details === null && value.hint === null) {
    if (value.code === '22023' && value.message === 'Invalid input') return 'INVALID_INPUT';
    if (value.code === '22023' && value.message === 'Request conflict') return 'CONFLICT';
    if (value.code === '22023' && value.message === 'Upload incomplete') return 'UPLOAD_INCOMPLETE';
    if (value.code === '42501' && value.message === 'Not available') return 'UNAVAILABLE';
  }
  return 'SAVE_FAILED';
}

export function createImageChangeFinalizer(config: FinalizerConfig) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const fail = (code: string) => Response.json({ code }, { headers, status: codes[code] ?? 502 });
    const local = /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl);
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== 'https://stillroom-wardrobe.pages.dev'
      && !(local && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin))) return fail('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_MS)]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/finalize-image-change', '/functions/v1/finalize-image-change'].includes(url.pathname)) return fail('INVALID_INPUT');
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'POST'
          || (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').some((v) =>
            v.trim() && !requestHeaders.includes(v.trim().toLowerCase()))) return fail('INVALID_INPUT');
        headers.set('Access-Control-Allow-Methods', 'POST');
        headers.set('Access-Control-Allow-Headers', requestHeaders.join(', '));
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'POST' || request.headers.get('Content-Type') !== 'application/json'
        || request.headers.has('Content-Encoding')) return fail('INVALID_INPUT');
      const length = request.headers.get('Content-Length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 49152)) return fail('INVALID_INPUT');
      const bearer = request.headers.get('Authorization') ?? '';
      if (!bearer.startsWith('Bearer ') || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(bearer.slice(7))) return fail('UNAUTHENTICATED');
      if ((!local && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl))
        || !config.publicKey || !config.serviceKey || config.publicKey.length > 8192 || config.serviceKey.length > 8192) return fail('UNCONFIGURED');
      const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.body, 49152, signal)));
      if (!exact(input, ['action', 'intent']) || !['complete', 'accept-recovery'].includes(String(input.action))
        || !exact(input.intent, intentKeys)) return fail('INVALID_INPUT');
      const intent = input.intent;
      if (![intent.requestId, intent.itemId, intent.imageId, intent.currentImageId].every(uuid)
        || !uuid(intent.itemId) || !uuid(intent.imageId) || !counter(intent.expectedVersion)
        || !counter(intent.descriptionVersion) || intent.descriptionVersion > 2147483647
        || !object(intent.item) || !object(intent.image)
        || (intent.claim !== null && !object(intent.claim))
        || (intent.sourceImageId !== null && !uuid(intent.sourceImageId))
        || (input.action === 'accept-recovery' && (!uuid(intent.sourceImageId) || intent.claim !== null))) return fail('INVALID_INPUT');
      const authSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || !uuid(user.id) || user.role !== 'authenticated' || user.is_anonymous !== false) return fail('UNAUTHENTICATED');
      const rpc = async (name: 'image_change_preflight' | 'image_recovery_preflight' | 'complete_image_change' | 'reserve_image_recovery',
        body: Record<string, unknown>, service = false): Promise<unknown> => {
        signal.throwIfAborted();
        const stage = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: stage,
          headers: { Authorization: service ? 'Bearer '.concat(config.serviceKey) : bearer,
            apikey: service ? config.serviceKey : config.publicKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.status === 204 && response.body === null) return null;
        const result = await readJson(response, 16384, stage);
        if (!response.ok) throw new ProtocolError(databaseError(result));
        return result;
      };
      const recovery = input.action === 'accept-recovery';
      const preflight = await rpc(recovery ? 'image_recovery_preflight' : 'image_change_preflight', { p_intent: intent });
      if (recovery && exact(preflight, ['receipt'])) {
        if (!receipt(preflight.receipt, intent)) return fail('CONFLICT');
        signal.throwIfAborted();
        return Response.json(preflight.receipt, { headers });
      }
      if (!exact(preflight, ['image', 'objects', 'state']) || !storedObjectIdentities(preflight.objects)
        || (recovery ? preflight.state !== 'source' : !['reserved', 'completed'].includes(String(preflight.state)))) return fail('CONFLICT');
      const imageId = recovery ? intent.sourceImageId : intent.imageId;
      if (!uuid(imageId)) return fail('CONFLICT');
      await verifyStoredImage(preflight.image, {
        ownerId: user.id, itemId: intent.itemId, imageId,
        state: recovery ? 'retired' : preflight.state === 'reserved' ? 'pending' : 'ready',
        ...(recovery ? {} : { descriptionVersion: 1 }),
      }, { supabaseUrl: config.supabaseUrl, publicKey: config.publicKey, bearer, signal });
      const result = await rpc(recovery ? 'reserve_image_recovery' : 'complete_image_change', {
        p_owner_id: user.id, p_intent: intent, p_objects: preflight.objects,
      }, true);
      signal.throwIfAborted();
      if (recovery) return receipt(result, intent) ? Response.json(result, { headers }) : fail('CONFLICT');
      return result === null ? new Response(null, { status: 204, headers }) : fail('CONFLICT');
    } catch (error) {
      return fail(signal.aborted ? 'TIMEOUT' : error instanceof SyntaxError
        || error instanceof ProtocolError && error.code === 'TOO_LARGE' ? 'INVALID_INPUT'
        : error instanceof ProtocolError && Object.hasOwn(codes, error.code) ? error.code : 'SAVE_FAILED');
    }
  };
}
