import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { PublicConfig } from './config';
import type { RecoveryLink } from '../auth/recovery-callback';
import { profileColumns } from './rows';
import { DELETE_TIMEOUT_MS } from './delete-account';
import { ClosableAuthStorage, clearAuthNamespace, storedAccessToken } from '../auth/auth-storage';

export type AppClient = SupabaseClient<Database>;
export const authStorageKey = 'stillroom.auth';
type ClientContext = { signal?: AbortSignal; retired: boolean; storage: ClosableAuthStorage; identity: string };
const requestContexts = new WeakMap<AppClient, ClientContext>();
const clients = new Map<string, AppClient>();
export const REQUEST_TIMEOUT_MS = 20_000;
// Account deletion may legitimately run for up to 100 s on the server; every other request gets 20 s.
export function requestTimeoutMs(pathname: string): number {
  return pathname.endsWith('/functions/v1/delete-account') ? DELETE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}
export function makeClient(config: PublicConfig): AppClient {
  const identity = `${config.url}|${config.publishableKey}`;
  const existing = clients.get(identity);
  if (existing) return existing;
  const context: ClientContext = { retired: false, storage: new ClosableAuthStorage(() => window.sessionStorage), identity };
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: {
      storage: context.storage,
      storageKey: authStorageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: {
      fetch: (input, init) => {
        // A signed-out client's late refreshes, retries and requests end here, off the network.
        if (context.retired) return Promise.resolve(retiredResponse());
        const address = input instanceof Request ? input.url : String(input);
        const pathname = new URL(address).pathname;
        const signals = [AbortSignal.timeout(requestTimeoutMs(pathname))];
        if (init?.signal) signals.push(init.signal);
        if (context.signal && !pathname.startsWith('/auth/v1/')) signals.push(context.signal);
        return fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.any(signals) });
      },
    },
  });
  requestContexts.set(client, context);
  clients.set(identity, client);
  return client;
}
export function bindDataRequests(client: AppClient, signal: AbortSignal): void {
  const context = requestContexts.get(client);
  if (context) context.signal = signal;
}

function retiredResponse(): Response {
  return new Response(JSON.stringify({ code: 'signed_out', message: 'Signed out.' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
}

/**
 * Signs a client out on this device, synchronously: the stored session is cleared and the client can no longer
 * read, write or send anything. The next `makeClient` call returns a fresh client. Returns the access token for a
 * best-effort server revoke.
 */
export function retireClient(client: AppClient): { token: string | null } {
  const context = requestContexts.get(client);
  const token = storedAccessToken(context && !context.storage.closed ? context.storage.getItem(authStorageKey) : null)
    ?? storedAccessToken(window.localStorage.getItem(authStorageKey));
  if (context) {
    context.retired = true;
    context.storage.close();
    if (clients.get(context.identity) === client) clients.delete(context.identity);
  }
  clearAuthNamespace([window.sessionStorage, window.localStorage]);
  void settleRetired(client);
  return { token };
}

// dispose() is not a latch: an initialization still in flight re-registers its visibility listener and auto-refresh
// when it finishes, so the teardown runs again once it has settled.
async function settleRetired(client: AppClient): Promise<void> {
  const teardown = () => client.auth.dispose().catch(() => undefined);
  void teardown();
  await client.auth.initialize().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await teardown();
}

export type RevokeResult = 'ok' | 'failed';
/** Best-effort server logout for a captured token. A missing account or an expired token also counts as done. */
export async function revokeSession(config: PublicConfig, token: string | null): Promise<RevokeResult> {
  if (!token) return 'ok';
  try {
    const response = await fetch(`${config.url}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: config.publishableKey, authorization: `Bearer ${token}` },
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok || [401, 403, 404].includes(response.status) ? 'ok' : 'failed';
  } catch { return 'failed'; }
}

export function makeRecoveryClient(config: PublicConfig, link: RecoveryLink | null, redirect: string) {
  const abort = new AbortController();
  let owner: string | null = null;
  let updateAllowed = false;
  let updateSent = false;
  let passwordSucceeded = false;
  let logoutAffirmed = false;
  let retrySeconds = 60;
  let errorDetails: { status: number; code?: string; minimum?: number } | undefined;
  const refuse = () => { throw new Error('Recovery request refused.'); };
  const projection = profileColumns;
  const guardedFetch: typeof fetch = async (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    let url: URL;
    try { url = new URL(address); } catch { return refuse(); }
    if (!address.startsWith(`${config.url}/`) || url.origin !== config.url || url.username || url.password || url.hash || abort.signal.aborted) return refuse();
    const request = new Request(input, init);
    const method = request.method;
    const headers = request.headers;
    if (headers.get('apikey') !== config.publishableKey) return refuse();
    if (method === 'POST' || method === 'PUT') {
      if ((await request.clone().text()).length > 16_384) return refuse();
    }
    const publicRequest = !link && method === 'POST' && url.pathname === '/auth/v1/recover'
      && [...url.searchParams.keys()].length === 1 && url.searchParams.get('redirect_to') === redirect;
    if (publicRequest) {
      if (headers.get('authorization') !== 'Bearer ' + config.publishableKey) return refuse();
    } else {
      if (!link || link.expiresAt * 1000 <= Date.now() + 150_000 || headers.get('authorization') !== 'Bearer ' + link.accessToken) return refuse();
      const user = url.pathname === '/auth/v1/user' && !url.search && (method === 'GET' || (method === 'PUT' && updateAllowed && !updateSent));
      const profile = method === 'GET' && url.pathname === '/rest/v1/profiles' && owner
        && [...url.searchParams.keys()].length === 2 && url.searchParams.get('select') === projection
        && url.searchParams.get('owner_id') === `eq.${owner}`;
      const logout = method === 'POST' && url.pathname === '/auth/v1/logout' && passwordSucceeded && url.search === '?scope=global';
      if (!user && !profile && !logout) return refuse();
      if (method === 'PUT') {
        const body: unknown = await request.clone().json();
        if (typeof body !== 'object' || !body || !('password' in body) || typeof body.password !== 'string'
          || Object.keys(body).some(key => !['password', 'code_challenge', 'code_challenge_method'].includes(key))) return refuse();
        updateSent = true;
      }
    }
    const signals = [abort.signal, request.signal, AbortSignal.timeout(20_000)];
    const response = await fetch(request, { cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.any(signals) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > 262_144) { await reader.cancel(); return refuse(); }
        chunks.push(result.value);
      }
    }
    if (abort.signal.aborted) return refuse();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const retry = response.headers.get('retry-after');
    if (retry && /^\d{1,4}$/.test(retry)) retrySeconds = Math.max(60, Math.min(3600, Number(retry)));
    if (url.pathname === '/auth/v1/logout') logoutAffirmed = response.ok;
    errorDetails = undefined;
    if (!response.ok) {
      errorDetails = { status: response.status };
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof value === 'object' && value) {
          const code = 'code' in value && typeof value.code === 'string' ? value.code
            : 'error_code' in value && typeof value.error_code === 'string' ? value.error_code : '';
          if (['user_not_found', 'email_not_confirmed', 'user_banned', 'signup_disabled', 'email_address_not_authorized',
            'over_email_send_rate_limit', 'over_request_rate_limit', 'same_password', 'weak_password',
            'reauthentication_needed', 'reauthentication_not_valid', 'insufficient_aal'].includes(code)) {
            errorDetails.code = code;
            if (code === 'weak_password') {
              const message = 'msg' in value && typeof value.msg === 'string' ? value.msg
                : 'message' in value && typeof value.message === 'string' ? value.message : '';
              const minimum = Number(/^Password should be at least (\d{1,2}) characters\.$/.exec(message)?.[1]);
              if (Number.isSafeInteger(minimum) && minimum >= 24 && minimum <= 72) errorDetails.minimum = minimum;
            }
          }
        }
      } catch { /* Only allowlisted codes and bounded numeric hints leave this boundary. */ }
    }
    return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
  };
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: {
      storageKey: `stillroom.recovery.${crypto.randomUUID()}`,
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit', debug: false,
    },
    global: {
      fetch: async (input, init) => {
        try { return await guardedFetch(input, init); }
        catch {
          errorDetails = { status: 0 };
          // A local refusal must not become a retryable SDK refresh or log inputs.
          return new Response(JSON.stringify({ code: 'recovery_transport_denied', message: 'Recovery request unavailable.' }), {
            status: 403, headers: { 'content-type': 'application/json' },
          });
        }
      },
    },
  });
  return {
    client, signal: abort.signal,
    bindOwner(id: string) { if (!link || id !== link.subject) return refuse(); owner = id; },
    allowUpdate() { if (!owner) return refuse(); updateAllowed = true; },
    confirmSuccess() { if (!updateSent) return refuse(); passwordSucceeded = true; },
    get updateSent() { return updateSent; },
    get logoutAffirmed() { return logoutAffirmed; },
    get retrySeconds() { return retrySeconds; },
    get errorDetails() { return errorDetails; },
    dispose() { abort.abort(); void client.auth.dispose(); },
  };
}
