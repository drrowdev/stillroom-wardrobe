import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppClient } from '../../src/data/client';
import type { AuthRecord } from '../../src/auth/auth-storage';
import type { SessionController, SessionState } from '../../src/auth/session';
import { testAccessToken } from './test-token';

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

/** The fictional label ('token-a', 'token-b2', ...) carried in an access token's claims. */
function labelOf(token: string | null | undefined): string | null {
  const payload = token?.replace(/^Bearer /, '').split('.')[1];
  if (!payload) return null;
  try { return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { jti?: string }).jti ?? null; } catch { return null; }
}
function sessionFor(token: string, user: string, expiresIn = 3600) {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  return {
    access_token: testAccessToken(user, { exp: expiresAt, label: token }), refresh_token: `refresh-${token}`, token_type: 'bearer',
    expires_in: expiresIn, expires_at: expiresAt,
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
const stored = () => {
  const record = JSON.parse(sessionStore.getItem('stillroom.auth') ?? 'null') as { access_token: string } | null;
  return record ? { access_token: labelOf(record.access_token) } : null;
};
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
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined });
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
  const revoke = await import('../../src/data/revoke');
  const session = await import('../../src/auth/session');
  return { ...client, ...revoke, ...session };
}
async function controllerSetup() {
  const loaded = await modules();
  const sources = { make: () => loaded.makeClient(config), retire: loaded.retireClient,
    revoke: (record: AuthRecord | null) => loaded.revokeSession(config, record) };
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
    // A genuine sign-out is device-wide: it also clears the remembered namespace (AUTH1 rev6.1 §9.4).
    localStore.setItem('stillroom.auth', '{}');
    localStore.setItem('stillroom.other', 'kept');
    const seen: string[][] = [];
    controller.subscribe(() => { if (controller.getSnapshot().phase === 'signed-out') seen.push(sessionStore.authKeys()); });
    const before = controller.getSnapshot().client;
    const done = controller.signOut();
    expect(seen[0]).toEqual([]);
    expect(controller.getSnapshot().client).not.toBe(before);
    await until(() => calls.some((call) => call.path === '/auth/v1/logout'));
    const logout = calls.find((call) => call.path === '/auth/v1/logout');
    expect(logout?.scope).toBe('local');
    expect(labelOf(logout?.auth)).toBe('token-a');
    expect(localStore.getItem('stillroom.auth')).toBeNull();
    expect(localStore.getItem('stillroom.other')).toBe('kept');
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
    reply = (call) => call.grant === 'password' ? json(sessionFor('token-a', USER_A)) : json({ code: 'user_not_found' }, 403);
    await controller.signIn('a@example.test', 'password');
    await controller.signOut('delete.done');
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
    await controller.endOnCommand('sign-out');
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
    await controller.endOnCommand('sign-out');
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
    await controller.endOnCommand('sign-out');
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
    expect(labelOf(retireClient(clientA).record?.access_token)).toBe('token-a');
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

const profileFor = (owner: string) => ({ owner_id: owner, display_name: 'Alex', ui_language: 'en', timezone: 'Europe/Helsinki',
  currency: 'EUR', version: 3, weather_enabled: false, weather_city: null, latitude: null, longitude: null });
const isA = (call: Call) => labelOf(call.auth)?.startsWith('token-a') ?? false;
type Controls = { profileA?: Promise<Response>; deletionA?: Promise<Response>; refreshA?: Promise<Response>; lockedA?: boolean; shortA?: boolean };
/** A scripted backend where B is an ordinary account and A's answers can be held or refused. */
function backend(controls: Controls) {
  reply = (call) => {
    // A short session makes the next session read wait on a refresh.
    if (call.grant === 'password') return json(call.body.includes('a@example.test') ? sessionFor('token-a', USER_A, controls.shortA ? 10 : 3600) : sessionFor('token-b', USER_B));
    if (call.grant === 'refresh_token') return call.body.includes('refresh-token-a') ? controls.refreshA ?? json(sessionFor('token-a2', USER_A, 10)) : json(sessionFor('token-b2', USER_B));
    if (call.path === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (call.path === '/rest/v1/profiles') {
      if (!isA(call)) return json([profileFor(USER_B)]);
      return controls.profileA ?? (controls.lockedA ? json({ message: 'denied' }, 403) : json([profileFor(USER_A)]));
    }
    if (call.path === '/rest/v1/rpc/deletion_status') return isA(call) ? controls.deletionA ?? json({ state: 'none' }) : json({ state: 'none' });
    return json({ message: 'unexpected' }, 500);
  };
}
/** Signs A out and B in, then records every signed-out or open the older generation might still cause. */
async function handOverToB(controller: SessionController) {
  await controller.endOnCommand('sign-out');
  await controller.signIn('b@example.test', 'password');
  await until(() => controller.getSnapshot().phase === 'ready');
  expect(controller.getSnapshot().profile?.owner_id).toBe(USER_B);
  const internals = controller as unknown as { signedOut: () => void; open: () => Promise<void> };
  return { signedOut: vi.spyOn(internals, 'signedOut'), open: vi.spyOn(internals, 'open') };
}
function expectBUntouched(controller: SessionController, spies: Awaited<ReturnType<typeof handOverToB>>) {
  expect(spies.signedOut).not.toHaveBeenCalled();
  expect(spies.open).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', profile: { owner_id: USER_B } });
  expect(stored()?.access_token).toBe('token-b');
}

describe('a continuation from an older sign-in', () => {
  it('drops a locked account\'s Retry whose refresh is answered after sign-out and the next sign-in', async () => {
    const { controller } = await controllerSetup();
    const refreshA = deferred<Response>();
    backend({ lockedA: true, shortA: true });
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'locked');
    backend({ lockedA: true, shortA: true, refreshA: refreshA.promise });
    // A's session is close to expiry, so Retry's session read waits on a refresh.
    const retry = controller.retry();
    await until(() => tokenGrants().some((call) => call.grant === 'refresh_token'));
    backend({ lockedA: true, shortA: true, refreshA: refreshA.promise });
    const spies = await handOverToB(controller);
    refreshA.resolve(json(sessionFor('token-a2', USER_A)));
    await retry;
    await settle();
    expectBUntouched(controller, spies);
    // A reload restores B, not a signed-out screen and not A.
    expect(sessionStore.authKeys()).toEqual(['stillroom.auth']);
  });

  it.each([
    ['Retry after a failed refresh', 'retry-error'],
    ['the profile read while opening', 'profile'],
    ['the deletion check of a frozen account', 'deletion'],
    ['the membership check on return to the app', 'membership'],
  ] as const)('cannot sign out or reopen the newer account: %s', async (_name, path) => {
    const { controller } = await controllerSetup();
    const held = deferred<Response>();
    const controls: Controls = path === 'profile' ? { profileA: held.promise } : path === 'deletion' ? { lockedA: true, deletionA: held.promise }
      : path === 'retry-error' ? { lockedA: true, shortA: true } : {};
    backend(controls);
    await controller.signIn('a@example.test', 'password');
    let pending: Promise<unknown> = Promise.resolve();
    if (path === 'profile') await until(() => calls.some((call) => call.path === '/rest/v1/profiles' && isA(call)));
    if (path === 'deletion') await until(() => calls.some((call) => call.path === '/rest/v1/rpc/deletion_status'));
    if (path === 'retry-error') {
      await until(() => controller.getSnapshot().phase === 'locked');
      backend({ ...controls, refreshA: held.promise });
      pending = controller.retry();
      await until(() => tokenGrants().some((call) => call.grant === 'refresh_token'));
    }
    if (path === 'membership') {
      await until(() => controller.getSnapshot().phase === 'ready');
      backend({ profileA: held.promise });
      const reads = calls.length;
      pending = (controller as unknown as { checkMembership: () => Promise<void> }).checkMembership();
      await until(() => calls.slice(reads).some((call) => call.path === '/rest/v1/profiles' && isA(call)));
    }
    backend(path === 'membership' || path === 'profile' ? { profileA: held.promise } : { ...controls, refreshA: held.promise });
    const spies = await handOverToB(controller);
    // Each older answer is the one that would have ended or replaced the newer account.
    held.resolve(path === 'profile' ? json([profileFor(USER_A)]) : path === 'deletion' ? json({ state: 'complete' })
      : path === 'retry-error' ? json({ error: 'invalid_grant', error_description: 'gone' }, 400) : json({ message: 'denied' }, 403));
    await pending;
    await settle();
    expectBUntouched(controller, spies);
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toHaveLength(1);
  });
});

describe('server revoke', () => {
  const live = () => ({ access_token: testAccessToken(USER_A, { label: 'token-a' }), refresh_token: 'refresh-token-a',
    expires_at: Math.floor(Date.now() / 1000) + 3600 });
  it('posts a local logout with the captured token and counts only a confirmed end as done', async () => {
    const { revokeSession } = await modules();
    const seen: RequestInit[] = [];
    const cases = [[204, {}, 'ok'], [200, {}, 'ok'], [404, {}, 'ok'], [403, { error_code: 'session_not_found' }, 'ok'],
      [403, { error_code: 'user_not_found' }, 'ok'], [403, { error_code: 'bad_jwt' }, 'failed'], [401, {}, 'failed'],
      [401, { code: 'user_not_found' }, 'failed'], [500, {}, 'failed'], [429, {}, 'failed']] as const;
    for (const [status, body, expected] of cases) {
      vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
        expect(input).toBe(`${config.url}/auth/v1/logout?scope=local`);
        seen.push(init);
        return new Response(status === 204 ? null : JSON.stringify(body), { status });
      }));
      await expect(revokeSession(config, live())).resolves.toBe(expected);
    }
    expect(seen[0]).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { apikey: 'public-key' } });
    expect(labelOf(new Headers(seen[0]?.headers).get('authorization'))).toBe('token-a');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(revokeSession(config, live())).resolves.toBe('failed');
    const unused = vi.fn();
    vi.stubGlobal('fetch', unused);
    await expect(revokeSession(config, null)).resolves.toBe('ok');
    expect(unused).not.toHaveBeenCalled();
  });

  it('renews an expired access token before the logout, and treats a dead refresh token as done', async () => {
    const { revokeSession } = await modules();
    const expired = { ...live(), expires_at: Math.floor(Date.now() / 1000) - 10 };
    const paths: string[] = [];
    const renewed = testAccessToken(USER_A, { label: 'token-a2' });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      paths.push(new URL(input).pathname + new URL(input).search);
      if (input.includes('grant_type=refresh_token')) {
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'refresh-token-a' });
        return json({ access_token: renewed, refresh_token: 'refresh-token-a2' });
      }
      expect(labelOf(new Headers(init.headers).get('authorization'))).toBe('token-a2');
      return new Response(null, { status: 204 });
    }));
    await expect(revokeSession(config, expired)).resolves.toBe('ok');
    expect(paths).toEqual(['/auth/v1/token?grant_type=refresh_token', '/auth/v1/logout?scope=local']);
    for (const [status, body, expected] of [[400, { error_code: 'refresh_token_not_found' }, 'ok'],
      [400, { error_code: 'refresh_token_already_used' }, 'ok'], [400, { error_code: 'validation_failed' }, 'failed'],
      [500, {}, 'failed']] as const) {
      const fetcher = vi.fn(async () => json(body, status));
      vi.stubGlobal('fetch', fetcher);
      await expect(revokeSession(config, expired)).resolves.toBe(expected);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

describe('state carries the current client', () => {
  it('publishes the new generation\'s client with the signed-out state', async () => {
    const { controller } = await controllerSetup();
    const states: SessionState[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    const before = controller.getSnapshot().client;
    await controller.endOnCommand('sign-out');
    expect(states[0]?.client).not.toBe(before);
    expect(states.every((state) => state.client === controller.getSnapshot().client)).toBe(true);
  });
});

const restCalls = () => calls.filter((call) => call.path.startsWith('/rest/v1/'));
const ownerOfCall = (call: Call) => labelOf(call.auth)?.startsWith('token-a') ? USER_A : labelOf(call.auth)?.startsWith('token-b') ? USER_B : null;
/** The allowlisted record the SDK would keep for a session. */
const recordOf = (session: ReturnType<typeof sessionFor>) =>
  JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at });
type Internals = { checkExpiry: () => boolean; checkMembership: () => Promise<void> };
const internals = (controller: SessionController) => controller as unknown as Internals;

describe('owner binding', () => {
  it('refuses a data request whose credential belongs to another owner, or with no owner bound, off the network', async () => {
    const { makeClient, bindDataRequests, unbindDataRequests } = await modules();
    backend({});
    sessionStore.setItem('stillroom.auth', recordOf(sessionFor('token-b', USER_B)));
    const client = makeClient(config);
    cleanups.push(() => client.auth.dispose());
    const signal = new AbortController().signal;
    expect((await client.from('profiles').select('owner_id')).error).not.toBeNull();
    bindDataRequests(client, signal, USER_A);
    expect((await client.from('profiles').select('owner_id')).error).not.toBeNull();
    expect(restCalls()).toEqual([]);
    bindDataRequests(client, signal, USER_B);
    expect((await client.from('profiles').select('owner_id')).error).toBeNull();
    expect(restCalls().map(ownerOfCall)).toEqual([USER_B]);
    unbindDataRequests(client);
    expect((await client.from('profiles').select('owner_id')).error).not.toBeNull();
    expect(restCalls()).toHaveLength(1);
  });

  it('never runs a queued open once the store holds another credential', async () => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    // The open is queued behind the SDK's lock; the store changes before it runs.
    sessionStore.setItem('stillroom.auth', recordOf(sessionFor('token-b', USER_B)));
    await settle();
    expect(restCalls()).toEqual([]);
    expect(controller.getSnapshot().phase).not.toBe('ready');
  });

  it('ignores a delayed event for a credential this tab does not hold', async () => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'ready');
    const scope = controller.getSnapshot().scope;
    const auth = controller.getSnapshot().client.auth as unknown as { _notifyAllSubscribers: (event: string, session: unknown) => Promise<void> };
    await auth._notifyAllSubscribers('SIGNED_IN', sessionFor('token-b', USER_B));
    await auth._notifyAllSubscribers('TOKEN_REFRESHED', sessionFor('token-b', USER_B));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', profile: { owner_id: USER_A } });
    expect(controller.getSnapshot().scope).toBe(scope);
    expect(restCalls().every((call) => ownerOfCall(call) === USER_A)).toBe(true);
  });

  it('ends the old owner\'s scope before anything else when the held credential changes owner', async () => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'ready');
    const scopeA = controller.getSnapshot().scope;
    const sessionB = sessionFor('token-b', USER_B);
    sessionStore.setItem('stillroom.auth', recordOf(sessionB));
    const auth = controller.getSnapshot().client.auth as unknown as { _notifyAllSubscribers: (event: string, session: unknown) => Promise<void> };
    const firstRestB = { index: -1 };
    controller.subscribe(() => { if (firstRestB.index < 0 && controller.getSnapshot().phase === 'ready') firstRestB.index = calls.length; });
    void auth._notifyAllSubscribers('SIGNED_IN', sessionB);
    expect(scopeA?.signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'loading', scope: null, profile: null });
    await until(() => controller.getSnapshot().phase === 'ready');
    expect(controller.getSnapshot().profile?.owner_id).toBe(USER_B);
  });

  it('refuses a request issued in the old scope after the store took another owner\'s credential', async () => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'ready');
    const before = restCalls().length;
    sessionStore.setItem('stillroom.auth', recordOf(sessionFor('token-b', USER_B)));
    await internals(controller).checkMembership();
    expect(restCalls().slice(before)).toEqual([]);
    expect(calls.some((call) => ownerOfCall(call) === USER_B)).toBe(false);
  });
});

describe('sign-out messages', () => {
  it('a sign-out started here sends one v2 message and its marked legacy twin', async () => {
    const { controller } = await controllerSetup();
    backend({});
    const v2: unknown[] = [], legacy: unknown[] = [];
    const listenV2 = new BroadcastChannel('stillroom.auth.v2'), listenLegacy = new BroadcastChannel('stillroom.logout');
    listenV2.onmessage = (event: MessageEvent) => v2.push(event.data);
    listenLegacy.onmessage = (event: MessageEvent) => legacy.push(event.data);
    cleanups.push(() => { listenV2.close(); listenLegacy.close(); });
    await controller.signIn('a@example.test', 'password');
    await controller.signOut();
    await settle();
    expect(v2).toEqual([{ v: 2, type: 'sign-out', nonce: expect.any(String) }]);
    expect(legacy).toEqual(['sign-out:v2']);
  });

  it.each([
    ['a v2 sign-out', 'stillroom.auth.v2', { v: 2, type: 'sign-out', nonce: '0123456789-abcdef' }],
    ['an older release\'s sign-out', 'stillroom.logout', 'logout'],
  ] as const)('%s ends this tab\'s session, revokes it and sends nothing on', async (_label, name, message) => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'ready');
    const seen: unknown[] = [];
    const sender = new BroadcastChannel(name);
    const listeners = ['stillroom.auth.v2', 'stillroom.logout'].map((channel) => {
      const listener = new BroadcastChannel(channel);
      listener.onmessage = (event: MessageEvent) => seen.push(event.data);
      return listener;
    });
    cleanups.push(() => { sender.close(); for (const listener of listeners) listener.close(); });
    sender.postMessage(message);
    await until(() => controller.getSnapshot().phase === 'signed-out');
    await settle();
    expect(sessionStore.authKeys()).toEqual([]);
    expect(calls.filter((call) => call.path === '/auth/v1/logout').map(ownerOfCall)).toEqual([USER_A]);
    // Only the injected message itself was ever on either channel.
    expect(seen).toEqual([message]);
  });

  it('ignores the marked legacy twin of a current tab\'s sign-out', async () => {
    const { controller } = await controllerSetup();
    backend({});
    await controller.signIn('a@example.test', 'password');
    await until(() => controller.getSnapshot().phase === 'ready');
    const sender = new BroadcastChannel('stillroom.logout');
    cleanups.push(() => sender.close());
    sender.postMessage('sign-out:v2');
    await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
  });
});

describe('live expiry', () => {
  const HOUR = 3600_000;
  let offline = false;
  beforeEach(() => {
    offline = false;
    vi.stubGlobal('navigator', { get onLine() { return !offline; } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function readyA(refresh: (call: Call) => Reply) {
    const setup = await controllerSetup();
    backend({});
    const base = reply;
    reply = (call) => call.grant === 'refresh_token' ? refresh(call) : base(call);
    await setup.controller.signIn('a@example.test', 'password');
    await until(() => setup.controller.getSnapshot().phase === 'ready');
    return setup;
  }
  /** Runs the expiry check as the deadline or a resume check would, and records what showed first. */
  function expire(controller: SessionController) {
    const scope = controller.getSnapshot().scope;
    const first: { aborted?: boolean; scope?: unknown } = {};
    const unsubscribe = controller.subscribe(() => {
      if (!('aborted' in first)) { first.aborted = scope?.signal.aborted; first.scope = controller.getSnapshot().scope; }
    });
    cleanups.push(unsubscribe);
    expect(internals(controller).checkExpiry()).toBe(true);
    return { scope, first };
  }
  /** Expires the scope when renewal fails: the scope's requests and private state end before anything else shows. */
  async function lapse(controller: SessionController) {
    const { scope, first } = expire(controller);
    for (let waited = 0; waited < 10_000 && !('aborted' in first); waited += 250) await vi.advanceTimersByTimeAsync(250);
    expect(first).toEqual({ aborted: true, scope: null });
    return scope;
  }
  const refreshGrants = () => tokenGrants().filter((call) => call.grant === 'refresh_token');

  it('does nothing before the access token expires', async () => {
    const { controller } = await readyA(() => json({}, 500));
    vi.setSystemTime(Date.now() + HOUR - 60_000);
    expect(internals(controller).checkExpiry()).toBe(false);
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('keeps the scope through a renewal that arrives before the deadline', async () => {
    const { controller } = await readyA(() => json(sessionFor('token-a2', USER_A)));
    const scope = controller.getSnapshot().scope;
    // Inside the SDK's margin the renewal runs while the access token still works.
    vi.setSystemTime(Date.now() + HOUR - 30_000);
    await controller.getSnapshot().client.auth.getSession();
    await until(() => stored()?.access_token === 'token-a2');
    await settle();
    // Past the old token's deadline, the renewed token's own deadline holds.
    vi.setSystemTime(Date.now() + 60_000);
    expect(internals(controller).checkExpiry()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', scope });
    expect(scope?.signal.aborted).toBe(false);
  });

  it('ends the old scope when a held renewal arrives after the deadline, before the deadline timer runs', async () => {
    const renewal = deferred<Response>();
    const { controller } = await readyA(() => renewal.promise);
    const scope = controller.getSnapshot().scope;
    // The renewal starts inside the SDK's margin, then its reply is held past the old deadline; no timer has fired.
    vi.setSystemTime(Date.now() + HOUR - 30_000);
    const renewing = controller.getSnapshot().client.auth.getSession();
    await until(() => refreshGrants().length > 0);
    vi.setSystemTime(Date.now() + 60_000);
    const first: { aborted?: boolean; scope?: unknown; phase?: string } = {};
    cleanups.push(controller.subscribe(() => {
      if (!('aborted' in first)) Object.assign(first, { aborted: scope?.signal.aborted, scope: controller.getSnapshot().scope, phase: controller.getSnapshot().phase });
    }));
    renewal.resolve(json(sessionFor('token-a2', USER_A)));
    await renewing;
    await settle();
    // The late renewal never carries the old scope on: it is aborted before anything else shows.
    expect(first).toEqual({ aborted: true, scope: null, phase: 'loading' });
    expect(scope?.signal.aborted).toBe(true);
    await until(() => controller.getSnapshot().phase === 'ready');
    const reopened = controller.getSnapshot().scope;
    expect(reopened).not.toBe(scope);
    expect(reopened?.epoch).toBeGreaterThan(scope?.epoch ?? Infinity);
    expect(stored()?.access_token).toBe('token-a2');
  });

  it('ends the scope at once when a page slept past expiry, then reopens with the renewed token', async () => {
    const { controller } = await readyA(() => json(sessionFor('token-a2', USER_A)));
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const { scope, first } = expire(controller);
    // Nothing waits for the renewal: the scope's requests and private state are gone first.
    expect(first).toEqual({ aborted: true, scope: null });
    await until(() => controller.getSnapshot().phase === 'ready');
    expect(controller.getSnapshot().scope).not.toBe(scope);
    expect(stored()?.access_token).toBe('token-a2');
  });

  it('ends the scope at once when the renewal at expiry stalls while online', async () => {
    const { controller } = await readyA(() => new Promise<Response>(() => undefined));
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const { scope, first } = expire(controller);
    expect(first).toEqual({ aborted: true, scope: null });
    expect(scope?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'loading', scope: null, profile: null });
  });

  it('never shows a profile that arrives after the access token expired', async () => {
    const setup = await controllerSetup();
    const profile = deferred<Response>();
    backend({ profileA: profile.promise });
    const base = reply;
    reply = (call) => call.grant === 'refresh_token' ? new Promise<Response>(() => undefined) : base(call);
    await setup.controller.signIn('a@example.test', 'password');
    await until(() => calls.some((call) => call.path === '/rest/v1/profiles'));
    const phases: string[] = [];
    cleanups.push(setup.controller.subscribe(() => phases.push(setup.controller.getSnapshot().phase)));
    // The deadline's timer has not run yet, as on a throttled page, when the late profile arrives.
    vi.setSystemTime(Date.now() + 2 * HOUR);
    profile.resolve(json([profileFor(USER_A)]));
    await settle();
    expect(phases).not.toContain('ready');
    expect(setup.controller.getSnapshot()).toMatchObject({ phase: 'loading', scope: null, profile: null });
  });

  it('lapses and reopens when the renewal at expiry is slow, then succeeds', async () => {
    let answer: (value: Response) => void = () => undefined;
    const { controller } = await readyA(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const old = await lapse(controller);
    await until(() => refreshGrants().length > 0);
    answer(json(sessionFor('token-a2', USER_A)));
    await until(() => controller.getSnapshot().phase === 'ready');
    expect(controller.getSnapshot().scope).not.toBe(old);
    expect(stored()?.access_token).toBe('token-a2');
  });

  it('waits offline with the credentials kept, and nothing private shown', async () => {
    const { controller } = await readyA(() => Promise.reject(new TypeError('Failed to fetch')));
    offline = true;
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await lapse(controller);
    await vi.advanceTimersByTimeAsync(35_000);
    await until(() => controller.getSnapshot().phase === 'waiting');
    expect(controller.getSnapshot()).toMatchObject({ scope: null, profile: null });
    expect(stored()?.access_token).toBe('token-a');
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toEqual([]);
  });

  it('shows the locked card online when the renewal gets a temporary server error, keeping the credentials', async () => {
    const { controller } = await readyA(() => json({ message: 'unavailable' }, 503));
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await lapse(controller);
    await vi.advanceTimersByTimeAsync(35_000);
    await until(() => controller.getSnapshot().phase === 'locked');
    expect(controller.getSnapshot()).toMatchObject({ scope: null, profile: null });
    expect(stored()?.access_token).toBe('token-a');
  });

  it('signs in again after a refused renewal, without a revoke and with nothing kept', async () => {
    const { controller } = await readyA(() => json({ error: 'invalid_grant', error_code: 'refresh_token_not_found' }, 400));
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await lapse(controller);
    await until(() => controller.getSnapshot().phase === 'signed-out');
    expect(controller.getSnapshot().notice).toBe('auth.expired');
    expect(sessionStore.authKeys()).toEqual([]);
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toEqual([]);
  });

  it('treats a renewal refused before expiry, then cached in the cooldown, as expired at the deadline', async () => {
    const { controller } = await readyA(() => json({ error: 'invalid_grant', error_code: 'refresh_token_not_found' }, 400));
    // Inside the SDK's margin the renewal is tried early and refused, while the access token still works.
    vi.setSystemTime(Date.now() + HOUR - 30_000);
    await controller.getSnapshot().client.auth.getSession();
    expect(refreshGrants()).toHaveLength(1);
    expect(stored()?.access_token).toBe('token-a');
    vi.setSystemTime(Date.now() + 40_000);
    await lapse(controller);
    await until(() => controller.getSnapshot().phase === 'signed-out');
    expect(controller.getSnapshot().notice).toBe('auth.expired');
    expect(refreshGrants()).toHaveLength(1);
    expect(sessionStore.authKeys()).toEqual([]);
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toEqual([]);
  });
});
