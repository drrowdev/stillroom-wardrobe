import { assertSanitizedJpeg, fitDimensions, JPEG_LIMITS } from '../../../src/images/jpeg.ts';
import { exact, object, ProtocolError, readBounded, readJson, REQUEST_MS, sha256, UUID } from '../analyze-clothing/protocol.ts';

export type FinalizerConfig = { supabaseUrl: string; publicKey: string; serviceKey: string };
const codes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONFLICT: 409,
  UPLOAD_INCOMPLETE: 409, UNCONFIGURED: 503, SAVE_FAILED: 502, TIMEOUT: 504,
};
const requestHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const imageKeys = ['id', 'owner_id', 'item_id', 'state', 'retired_at', 'main_path', 'thumb_path',
  'main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text', 'created_at', 'description_version'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum;
function identity(value: unknown): boolean {
  return exact(value, ['id', 'version']) && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 1024;
}
function databaseError(value: unknown): string {
  if (exact(value, ['code', 'message', 'details', 'hint']) && value.details === null && value.hint === null) {
    if (value.code === '22023' && value.message === 'Request conflict') return 'CONFLICT';
    if (value.code === '22023' && value.message === 'Upload incomplete') return 'UPLOAD_INCOMPLETE';
    if (value.code === '42501' && value.message === 'Not available') return 'UNAVAILABLE';
  }
  return 'SAVE_FAILED';
}

export function createFinalizer(config: FinalizerConfig) {
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
      if (url.search || !['/finalize-analyzed-item', '/functions/v1/finalize-analyzed-item'].includes(url.pathname)) return fail('INVALID_INPUT');
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
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 1024)) return fail('INVALID_INPUT');
      const bearer = request.headers.get('Authorization') ?? '';
      if (!bearer.startsWith('Bearer ') || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(bearer.slice(7))) return fail('UNAUTHENTICATED');
      if ((!local && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl))
        || !config.publicKey || !config.serviceKey || config.publicKey.length > 8192 || config.serviceKey.length > 8192) return fail('UNCONFIGURED');
      const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.body, 1024, signal)));
      if (!exact(input, ['itemId', 'imageId', 'fingerprint']) || typeof input.itemId !== 'string' || !UUID.test(input.itemId)
        || typeof input.imageId !== 'string' || !UUID.test(input.imageId) || !hash(input.fingerprint)) return fail('INVALID_INPUT');
      const authSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return fail('UNAUTHENTICATED');
      const rpc = async (name: string, body: Record<string, unknown>, service = false): Promise<unknown> => {
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
      const args = { p_item_id: input.itemId, p_image_id: input.imageId, p_fingerprint: input.fingerprint };
      const preflight = await rpc('analyzed_item_save_preflight', args);
      if (!exact(preflight, ['image', 'objects', 'state']) || !exact(preflight.image, imageKeys)
        || !exact(preflight.objects, ['main', 'thumb']) || !identity(preflight.objects.main) || !identity(preflight.objects.thumb)
        || !['reserved', 'completed'].includes(String(preflight.state))) return fail('CONFLICT');
      const image = preflight.image;
      const prefix = `${user.id}/${input.itemId}/${input.imageId}`;
      if (image.owner_id !== user.id || image.item_id !== input.itemId || image.id !== input.imageId
        || image.main_path !== `${prefix}/main.jpg` || image.thumb_path !== `${prefix}/thumb.jpg`
        || image.description_version !== 1 || image.retired_at !== null
        || image.state !== (preflight.state === 'reserved' ? 'pending' : 'ready')
        || !integer(image.width, JPEG_LIMITS.mainSide) || !integer(image.height, JPEG_LIMITS.mainSide)
        || !integer(image.main_bytes, JPEG_LIMITS.mainBytes) || !integer(image.thumb_bytes, JPEG_LIMITS.thumbBytes)
        || !hash(image.main_sha256) || !hash(image.thumb_sha256)) return fail('CONFLICT');
      for (const variant of ['main', 'thumb'] as const) {
        signal.throwIfAborted();
        const response = await fetch(`${config.supabaseUrl}/storage/v1/object/authenticated/wardrobe/${prefix}/${variant}.jpg`, {
          headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal,
        });
        if (!response.ok) { await response.body?.cancel(); return fail(response.status === 404 ? 'UPLOAD_INCOMPLETE' : 'SAVE_FAILED'); }
        if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/jpeg') {
          await response.body?.cancel(); return fail('CONFLICT');
        }
        const body = await readBounded(response.body, variant === 'main' ? JPEG_LIMITS.mainBytes : JPEG_LIMITS.thumbBytes, signal);
        if (body.length !== image[`${variant}_bytes`] || await sha256(body) !== image[`${variant}_sha256`]) return fail('CONFLICT');
        const dimensions = variant === 'main' ? { width: image.width, height: image.height }
          : fitDimensions(image.width, image.height, JPEG_LIMITS.thumbSide);
        try { assertSanitizedJpeg(body, dimensions.width, dimensions.height); } catch { return fail('CONFLICT'); }
      }
      signal.throwIfAborted();
      const result = await rpc('complete_analyzed_item_save', {
        ...args, p_owner_id: user.id, p_objects: preflight.objects,
      }, true);
      if (result !== null) return fail('CONFLICT');
      signal.throwIfAborted();
      return new Response(null, { status: 204, headers });
    } catch (error) {
      return fail(signal.aborted ? 'TIMEOUT' : error instanceof SyntaxError ? 'INVALID_INPUT'
        : error instanceof ProtocolError && Object.hasOwn(codes, error.code) ? error.code : 'SAVE_FAILED');
    }
  };
}
