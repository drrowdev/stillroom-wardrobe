import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppClient, AuthMode } from '../../src/data/client';
import type { AuthRecord } from '../../src/auth/auth-storage';
import type { SessionController } from '../../src/auth/session';
import { testAccessToken } from './test-token';

// AUTH1b's remembered holder with the real Supabase auth client, the real remembered mode and a scripted Web Locks
// manager: how the holder lets go of the slot and its lock.
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'public-key', version: 'test' };
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SLOT_LOCK = 'stillroom.remembered';

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

/** Exclusive locks granted in order, as `navigator.locks` does. */
class Locks {
  private names = new Map<string, { held: boolean; queue: (() => void)[] }>();
  held(name = SLOT_LOCK) { return this.names.get(name)?.held ?? false; }
  request = (name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown) => {
    // The SDK's own lock is not under test here; it runs at once, as with the SDK's no-op lock.
    if (name !== SLOT_LOCK) return Promise.resolve().then(() => callback({ name }));
    const entry = this.names.get(name) ?? { held: false, queue: [] };
    this.names.set(name, entry);
    const run = () => {
      entry.held = true;
      return Promise.resolve().then(() => callback({ name })).finally(() => {
        entry.held = false;
        entry.queue.shift()?.();
      });
    };
    if (!entry.held) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const grant = () => { run().then(resolve, reject); };
      entry.queue.push(grant);
      options.signal?.addEventListener('abort', () => {
        entry.queue = entry.queue.filter((waiting) => waiting !== grant);
        reject(new DOMException('Aborted.', 'AbortError'));
      });
    });
  };
}

type Call = { path: string; grant: string | null; auth: string | null; body: string };
let calls: Call[];
let refresh: (call: Call) => Response | Promise<Response>;
let sessionStore: MemoryStorage;
let localStore: MemoryStorage;
let locks: Locks;
let cleanups: (() => unknown)[];

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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const profileFor = (owner: string) => ({ owner_id: owner, display_name: owner === USER_A ? 'Alex' : 'Robin', ui_language: 'en',
  timezone: 'Europe/Helsinki', currency: 'EUR', version: 3, weather_enabled: false, weather_city: null, latitude: null, longitude: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const slotLabel = () => labelOf((JSON.parse(localStore.getItem('stillroom.auth') ?? 'null') as AuthRecord | null)?.access_token);
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 300 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const refreshGrants = () => calls.filter((call) => call.grant === 'refresh_token');

beforeEach(() => {
  calls = [];
  cleanups = [];
  sessionStore = new MemoryStorage();
  localStore = new MemoryStorage();
  locks = new Locks();
  refresh = () => json(sessionFor('token-a2', USER_A));
  vi.stubGlobal('window', {
    sessionStorage: sessionStore, localStorage: localStore, location: { href: 'http://localhost/' },
    addEventListener: () => undefined, removeEventListener: () => undefined,
  });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('navigator', { locks, onLine: true });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const call = { path: url.pathname, grant: url.searchParams.get('grant_type'), auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    if (call.grant === 'password') return json(call.body.includes('a@example.test') ? sessionFor('token-a', USER_A) : sessionFor('token-b', USER_B));
    if (call.grant === 'refresh_token') return refresh(call);
    if (call.path === '/auth/v1/logout') return new Response(null, { status: 204 });
    const owner = labelOf(call.auth)?.startsWith('token-a') ? USER_A : USER_B;
    if (call.path === '/rest/v1/profiles') return json([profileFor(owner)]);
    if (call.path === '/rest/v1/rpc/deletion_status') return json({ state: 'none' });
    return json({ message: 'unexpected' }, 500);
  }));
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A controller wired as the app wires it, recording the order of client closes and lock grants. */
async function holderSetup() {
  const client = await import('../../src/data/client');
  const { revokeSession } = await import('../../src/data/revoke');
  const { SessionController } = await import('../../src/auth/session');
  const { remembered } = await import('../../src/auth/remembered');
  const lock = await import('../../src/auth/device-lock');
  const order: string[] = [];
  const made: AuthMode[] = [];
  const sources = {
    make: (mode?: AuthMode, user?: unknown) => { made.push(mode ?? 'tab'); return client.makeClient(config, mode, user); },
    retire: (target: AppClient) => { order.push('retire'); return client.retireClient(target); },
    release: (target: AppClient) => { order.push('release'); client.releaseClient(target); },
    revoke: (record: AuthRecord | null) => revokeSession(config, record),
    remembered: () => Promise.resolve(remembered(config)),
  };
  const controller: SessionController = new SessionController(sources.make(), ['en'], sources);
  const stop = controller.start();
  cleanups.push(async () => {
    stop();
    // Stopping a holder leaves a fresh per-tab client; let its start-up finish before the stores go.
    const current = (controller as unknown as { client: AppClient }).client;
    await current.auth.initialize();
    await current.auth.dispose();
  });
  /** Another window asking for the slot's lock and taking it as soon as it is let go; its grant is recorded in `order`. */
  const waiter = () => {
    let release!: () => void;
    const granted = new Promise<{ release(): void }>((resolve) => {
      void locks.request(lock.lockName, {}, () => {
        order.push('granted');
        return new Promise<void>((done) => { release = done; resolve({ release: () => release() }); });
      });
    });
    cleanups.push(() => { void granted.then((held) => held.release()); });
    return granted;
  };
  return { controller, stop, order, made, waiter };
}
const internals = (controller: SessionController) => controller as unknown as { held: unknown; mode: AuthMode; checkExpiry(): boolean };

// The real SDK starts and settles on real timers; a busy machine can take longer than the 5 s default.
describe('the remembered holder letting go', { timeout: 20_000 }, () => {
  it('a refused renewal closes the holder\'s client, then lets go of the lock; the window claims it afresh and a ticked sign-in holds again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    cleanups.push(() => { vi.useRealTimers(); });
    const { controller, order } = await holderSetup();
    await until(() => internals(controller).held !== null);
    await controller.signIn('a@example.test', 'password', true);
    await until(() => controller.getSnapshot().phase === 'ready');
    const device = controller.getSnapshot().client;
    const first = internals(controller).held;
    expect(internals(controller).mode).toBe('device');
    expect(locks.held()).toBe(true);
    order.length = 0;
    // The access token has expired and the server refuses the refresh token: the SDK removes the session.
    refresh = () => json({ code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect(internals(controller).checkExpiry()).toBe(true);
    await until(() => controller.getSnapshot().phase === 'signed-out');
    expect(order[0]).toBe('release');
    expect(controller.getSnapshot().notice).toBe('auth.expired');
    expect(internals(controller).mode).toBe('tab');
    expect(controller.getSnapshot().client).not.toBe(device);
    expect(localStore.authKeys()).toEqual([]);
    // The old lock went with the client; the signed-out window takes it again for its next sign-in.
    await until(() => internals(controller).held !== null);
    expect(internals(controller).held).not.toBe(first);
    expect(controller.canRemember).toBe(true);
    refresh = () => json(sessionFor('token-b2', USER_B));
    await controller.signIn('b@example.test', 'password', true);
    await until(() => controller.getSnapshot().phase === 'ready');
    expect(controller.getSnapshot().profile?.owner_id).toBe(USER_B);
    expect(slotLabel()).toBe('token-b');
    expect(locks.held()).toBe(true);
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toEqual([]);
  });

  it('stopping closes the holder\'s client before the lock goes, and a refresh in flight then writes and sends nothing', async () => {
    const { controller, stop, order, waiter } = await holderSetup();
    await until(() => internals(controller).held !== null);
    await controller.signIn('a@example.test', 'password', true);
    await until(() => controller.getSnapshot().phase === 'ready');
    const device = controller.getSnapshot().client;
    const slot = localStore.getItem('stillroom.auth');
    const held = deferred<Response>();
    refresh = () => held.promise;
    const refreshing = device.auth.refreshSession();
    await until(() => refreshGrants().length === 1);
    order.length = 0;
    const waiting = waiter();
    stop();
    const granted = await waiting;
    expect(order).toEqual(['release', 'granted']);
    const sent = calls.length;
    held.resolve(json(sessionFor('token-a2', USER_A)));
    await refreshing;
    await settle();
    // The closed client neither writes the rotated record nor sends anything; nothing was revoked.
    expect(localStore.getItem('stillroom.auth')).toBe(slot);
    expect(calls.slice(sent)).toEqual([]);
    expect(calls.filter((call) => call.path === '/auth/v1/logout')).toEqual([]);
    granted!.release();
  });
});
