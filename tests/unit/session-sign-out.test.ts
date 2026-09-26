import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppClient } from '../../src/data/client';
import type { SessionController, SessionState } from '../../src/auth/session';

// Runs the real Supabase auth client against a scripted network, so the sign-out ordering and every late write
// from a retired client are exercised through the SDK itself.
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'public-key', version: 'test' };
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  authKeys() { return [...this.values.keys()].filter((key) => key.startsWith('stillroom.auth')); }
}

type Call = { path: string; grant: string | null; scope: string | null; auth: string | null; body: string };
type Reply = Response | Promise<Response>;
let calls: Call[];
let reply: (call: Call) => Reply;
let sessionStore: MemoryStorage;
let localStore: MemoryStorage;
let visibility: Set<unknown>;
let cleanups: (() => unknown)[];

function sessionFor(token: string, user: string, expiresIn = 3600) {
  return {
    access_token: token, refresh_token: `refresh-${token}`, token_type: 'bearer', expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: user, aud: 'authenticated', role: 'authenticated', email: `${user.slice(0, 4)}@example.test`,
      app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** A reply whose headers arrive now and whose body arrives later. */
function heldBody() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  return { response, release(body: unknown) { stream.enqueue(new TextEncoder().encode(JSON.stringify(body))); stream.close(); } };
}
const stored = () => JSON.parse(sessionStore.getItem('stillroom.auth') ?? 'null') as { access_token: string } | null;
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  calls = [];
  cleanups = [];
  visibility = new Set();
  sessionStore = new MemoryStorage();
  localStore = new MemoryStorage();
  reply = (call) => call.path === '/auth/v1/logout' ? new Response(null, { status: 204 }) : json({ message: 'unexpected' }, 500);
  vi.stubGlobal('window', {
    sessionStorage: sessionStore, localStorage: localStore, location: { href: 'http://localhost/' },
    addEventListener: (type: string, listener: unknown) => { if (type === 'visibilitychange') visibility.add(listener); },
    removeEventListener: (type: string, listener: unknown) => { if (type === 'visibilitychange') visibility.delete(listener); },
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const call = { path: url.pathname, grant: url.searchParams.get('grant_type'), scope: url.searchParams.get('scope'),
      auth: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return reply(call);
  }));
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function modules() {
  const client = await import('../../src/data/client');
  const session = await import('../../src/auth/session');
  return { ...client, ...session };
}
async function controllerSetup() {
  const loaded = await modules();
  const sources = { make: () => loaded.makeClient(config), retire: loaded.retireClient,
    revoke: (token: string | null) => loaded.revokeSession(config, token) };
  const controller: SessionController = new loaded.SessionController(sources.make(), ['en'], sources);
  const stop = controller.start();
  cleanups.push(() => { stop(); return controller.getSnapshot().client.auth.dispose(); });
  return { ...loaded, controller };
}
const tokenGrants = () => calls.filter((call) => call.path === '/auth/v1/token');

describe('sign-out without the network', () => {
  it('clears the stored credentials before anything shows signed out and revokes the captured token afterwards', async () => {
    const { controller } = await controllerSetup();
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A)) : call.path === '/auth/v1/logout' ? held.promise : json({}, 500);
    const held = deferred<Response>();
    await controller.signIn('a@example.test', 'password');
    expect(stored()?.access_token).toBe('token-a');
    sessionStore.setItem('stillroom.auth-flow-1-code-verifier', 'v');
    localStore.setItem('stillroom.auth-code-verifier', 'v');
    const seen: string[][] = [];
    controller.subscribe(() => { if (controller.getSnapshot().phase === 'signed-out') seen.push([...sessionStore.authKeys(), ...localStore.authKeys()]); });
    const before = controller.getSnapshot().client;
    const done = controller.signOut();
    expect(seen[0]).toEqual([]);
    expect(controller.getSnapshot().client).not.toBe(before);
    await until(() => calls.some((call) => call.path === '/auth/v1/logout'));
    const logout = calls.find((call) => call.path === '/auth/v1/logout');
    expect(logout).toMatchObject({ scope: 'local', auth: 'Bearer token-a' });
    // A reload now finds nothing to restore, even though the server has not answered.
    expect(sessionStore.authKeys()).toEqual([]);
    held.resolve(new Response(null, { status: 204 }));
    await done;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'signed-out' });
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('stays signed out offline and says the server did not confirm it', async () => {
    const { controller } = await controllerSetup();
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A)) : Promise.reject(new TypeError('Failed to fetch'));
    await controller.signIn('a@example.test', 'password');
    await controller.signOut();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'signed-out', notice: 'auth.localSignOut' });
    expect(sessionStore.authKeys()).toEqual([]);
  });

  it('keeps the deletion confirmation when the revoke answers that the account is gone', async () => {
    const { controller } = await controllerSetup();
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A)) : json({ code: 'user_not_found' }, 401);
    await controller.signIn('a@example.test', 'password');
    await controller.signOut(true, 'delete.done');
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'signed-out', notice: 'delete.done' });
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toHaveLength(1);
  });

  it('drops a sign-in whose reply headers came before sign-out and whose body came after the next sign-in', async () => {
    const { controller } = await controllerSetup();
    const lateA = heldBody();
    reply = (call) => call.body.includes('a@example.test') ? lateA.response : json(sessionFor('token-b', USER_B));
    const signInA = controller.signIn('a@example.test', 'password');
    await until(() => tokenGrants().length === 1);
    await controller.signOut(false);
    await controller.signIn('b@example.test', 'password');
    expect(stored()?.access_token).toBe('token-b');
    lateA.release(sessionFor('token-a', USER_A));
    await expect(signInA).resolves.toBeUndefined();
    await settle();
    expect(stored()?.access_token).toBe('token-b');
    expect(controller.getSnapshot().phase).not.toBe('signed-out');
  });

  it('keeps an old refresh held across sign-out out of the next account, whose own refresh still works', async () => {
    const { controller } = await controllerSetup();
    const oldRefresh = deferred<Response>();
    reply = (call) => call.grant === 'password' ? json(call.body.includes('a@example.test') ? sessionFor('token-a', USER_A, 10) : sessionFor('token-b', USER_B, 10))
      : call.grant === 'refresh_token' && call.body.includes('refresh-token-a') ? oldRefresh.promise
        : call.grant === 'refresh_token' ? json(sessionFor('token-b2', USER_B)) : new Response(null, { status: 204 });
    await controller.signIn('a@example.test', 'password');
    const clientA = controller.getSnapshot().client;
    void clientA.auth.refreshSession();
    await until(() => tokenGrants().some((call) => call.grant === 'refresh_token'));
    await controller.signOut(false);
    await controller.signIn('b@example.test', 'password');
    const clientB = controller.getSnapshot().client;
    const refreshed = await clientB.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(stored()?.access_token).toBe('token-b2');
    const refreshes = tokenGrants().filter((call) => call.grant === 'refresh_token');
    expect(refreshes.filter((call) => call.body.includes('refresh-token-a'))).toHaveLength(1);
    expect(refreshes.at(-1)?.body).toContain('refresh-token-b');
    oldRefresh.resolve(json(sessionFor('token-a2', USER_A)));
    await settle();
    expect(stored()?.access_token).toBe('token-b2');
  });

  it('refreshes a session within the same sign-in as before', async () => {
    const { controller } = await controllerSetup();
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A, 10)) : json(sessionFor('token-a2', USER_A));
    await controller.signIn('a@example.test', 'password');
    const { error } = await controller.getSnapshot().client.auth.refreshSession();
    expect(error).toBeNull();
    expect(stored()?.access_token).toBe('token-a2');
  });

  it('does not retry a retired refresh that failed in transport onto the network', async () => {
    const { controller } = await controllerSetup();
    const oldRefresh = deferred<Response>();
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A, 10))
      : call.grant === 'refresh_token' ? oldRefresh.promise : new Response(null, { status: 204 });
    await controller.signIn('a@example.test', 'password');
    const refresh = controller.getSnapshot().client.auth.refreshSession();
    await until(() => tokenGrants().some((call) => call.grant === 'refresh_token'));
    await controller.signOut(false);
    oldRefresh.reject(new TypeError('Failed to fetch'));
    await refresh;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(tokenGrants().filter((call) => call.grant === 'refresh_token')).toHaveLength(1);
    expect(sessionStore.authKeys()).toEqual([]);
  });

  it('leaves a client retired during a held start-up refresh with no timers or listeners', async () => {
    const { makeClient, retireClient } = await modules();
    sessionStore.setItem('stillroom.auth', JSON.stringify(sessionFor('token-a', USER_A, 5)));
    const startup = deferred<Response>();
    reply = (call) => call.grant === 'refresh_token' ? startup.promise : json({}, 500);
    const clientA = makeClient(config);
    // Record every visibility callback A registers, including any re-registered when its start-up finishes.
    const callbacksA: unknown[] = [];
    let currentA: unknown = (clientA.auth as unknown as { visibilityChangedCallback: unknown }).visibilityChangedCallback;
    Object.defineProperty(clientA.auth, 'visibilityChangedCallback', {
      configurable: true, get: () => currentA, set: (value: unknown) => { if (value) callbacksA.push(value); currentA = value; },
    });
    await until(() => tokenGrants().length === 1);
    expect(retireClient(clientA).token).toBe('token-a');
    const clientB: AppClient = makeClient(config);
    cleanups.push(() => clientB.auth.dispose());
    expect(clientB).not.toBe(clientA);
    await clientB.auth.initialize();
    startup.resolve(json(sessionFor('token-a2', USER_A)));
    await settle();
    const internals = clientA.auth as unknown as { autoRefreshTicker: unknown; autoRefreshTickTimeout: unknown; visibilityChangedCallback: unknown; broadcastChannel: unknown };
    expect(internals.autoRefreshTicker).toBeNull();
    expect(internals.autoRefreshTickTimeout).toBeNull();
    expect(internals.visibilityChangedCallback).toBeFalsy();
    expect(internals.broadcastChannel).toBeNull();
    // A's start-up re-registered its listener after it was retired; the follow-up teardown removed it again.
    expect(callbacksA.length).toBeGreaterThan(0);
    expect(callbacksA.some((callback) => visibility.has(callback))).toBe(false);
    expect(visibility.has((clientB.auth as unknown as { visibilityChangedCallback: unknown }).visibilityChangedCallback)).toBe(true);
    expect(sessionStore.authKeys()).toEqual([]);
    expect(tokenGrants()).toHaveLength(1);
  });

  it('never sends a retired client\'s requests to the network', async () => {
    const { makeClient, retireClient } = await modules();
    const client = makeClient(config);
    await client.auth.initialize();
    retireClient(client);
    const before = calls.length;
    const result = await client.from('profiles').select('owner_id');
    expect(result.error).not.toBeNull();
    expect(calls.length).toBe(before);
  });
});

describe('server revoke', () => {
  it('posts a local logout with the captured token and treats a gone session as done', async () => {
    const { revokeSession } = await modules();
    const seen: RequestInit[] = [];
    for (const [status, expected] of [[204, 'ok'], [200, 'ok'], [401, 'ok'], [403, 'ok'], [404, 'ok'], [500, 'failed'], [429, 'failed']] as const) {
      vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
        expect(input).toBe(`${config.url}/auth/v1/logout?scope=local`);
        seen.push(init);
        return new Response(status === 204 ? null : '{}', { status });
      }));
      await expect(revokeSession(config, 'token-a')).resolves.toBe(expected);
    }
    expect(seen[0]).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { apikey: 'public-key', authorization: 'Bearer token-a' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(revokeSession(config, 'token-a')).resolves.toBe('failed');
    const unused = vi.fn();
    vi.stubGlobal('fetch', unused);
    await expect(revokeSession(config, null)).resolves.toBe('ok');
    expect(unused).not.toHaveBeenCalled();
  });
});

describe('state carries the current client', () => {
  it('publishes the new generation\'s client with the signed-out state', async () => {
    const { controller } = await controllerSetup();
    const states: SessionState[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    const before = controller.getSnapshot().client;
    await controller.signOut(false);
    expect(states[0]?.client).not.toBe(before);
    expect(states.every((state) => state.client === controller.getSnapshot().client)).toBe(true);
  });
});
