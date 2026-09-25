import { exact, ProtocolError, readBounded, readJson, UUID } from '../analyze-clothing/protocol.ts';
import { runDeletion, TIMEOUTS, type DeletionState } from '../_shared/deletion-loop.ts';
import { createCall, serviceDeps, type Call } from '../_shared/deletion-service.ts';

export type DeleteAccountConfig = { supabaseUrl: string; publicKey: string; serviceKey: string };
export type DeleteAccountOptions = { call?: Call; clock?: () => number; newOp?: () => string };
// Stops starting new work well inside the platform wall-clock limit; the lease covers the rest.
export const DELETE_BUDGET_MS = 100000;
const codes: Record<string, number> = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, PASSWORD: 403, UNAVAILABLE: 403, UNCONFIGURED: 503, FAILED: 502 };
const states: Record<DeletionState, number> = { complete: 200, in_progress: 202, retry: 503, contact: 409, not_available: 403 };
const requestHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Owner-confirmed deletion. The owner comes only from the verified session; the body carries only the password. */
export function createDeleteAccount(config: DeleteAccountConfig, options: DeleteAccountOptions = {}) {
  const call = options.call ?? createCall(config.supabaseUrl);
  const clock = options.clock ?? Date.now;
  const newOp = options.newOp ?? (() => crypto.randomUUID());
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const fail = (code: string) => Response.json({ code }, { headers, status: codes[code] ?? 502 });
    const local = /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl);
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== 'https://stillroom-wardrobe.pages.dev'
      && !(local && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin))) return fail('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    try {
      const url = new URL(request.url);
      if (url.search || !['/delete-account', '/functions/v1/delete-account'].includes(url.pathname)) return fail('INVALID_INPUT');
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
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 4096)) return fail('INVALID_INPUT');
      const bearer = request.headers.get('Authorization') ?? '';
      if (!bearer.startsWith('Bearer ') || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(bearer.slice(7))) return fail('UNAUTHENTICATED');
      if ((!local && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl))
        || !config.publicKey || !config.serviceKey || config.publicKey.length > 8192 || config.serviceKey.length > 8192) return fail('UNCONFIGURED');
      const started = clock();
      const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        await readBounded(request.body, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]))));
      // Exactly one key: an owner ID or any other field in the body is refused.
      if (!exact(input, ['password']) || typeof input.password !== 'string' || input.password.length < 1
        || input.password.length > 1024) return fail('INVALID_INPUT');

      // 1. The caller's own session. No privileged call happens before this succeeds.
      const who = await call('/auth/v1/user', { method: 'GET', bearer: bearer.slice(7), key: config.publicKey }, 5000);
      if (!who) return fail('FAILED');
      const user = await readJson(who.response, 65536, who.signal).catch(() => undefined);
      if (!who.response.ok || !record(user) || typeof user.id !== 'string' || !UUID.test(user.id) || user.role !== 'authenticated'
        || user.is_anonymous !== false || typeof user.email !== 'string') return fail('UNAUTHENTICATED');
      // 2. Re-authentication with the password; the fresh session is revoked straight away.
      const fresh = await call('/auth/v1/token?grant_type=password', { method: 'POST', key: config.publicKey,
        body: { email: user.email, password: input.password } }, 10000);
      if (!fresh) return fail('FAILED');
      const token = await readJson(fresh.response, 65536, fresh.signal).catch(() => undefined);
      if (fresh.response.status === 400 || fresh.response.status === 401) return fail('PASSWORD');
      if (!fresh.response.ok || !record(token) || typeof token.access_token !== 'string' || !record(token.user)
        || token.user.id !== user.id) return fail('FAILED');
      await call('/auth/v1/logout?scope=local', { method: 'POST', bearer: token.access_token, key: config.publicKey }, 5000);
      // 3. Only after re-authentication: purge old completed receipts, then run the shared loop.
      await call('/rest/v1/rpc/purge_deletion_receipts', { method: 'POST', bearer: config.serviceKey, key: config.serviceKey,
        body: {} }, TIMEOUTS.rpcMs);
      const deps = { ...serviceDeps(user.id, config.serviceKey, call), now: clock };
      const state = await runDeletion(deps, user.id, 'begin', newOp(), started + DELETE_BUDGET_MS);
      return Response.json({ state }, { headers, status: states[state] });
    } catch (error) {
      return fail(error instanceof SyntaxError || error instanceof ProtocolError ? 'INVALID_INPUT' : 'FAILED');
    }
  };
}
