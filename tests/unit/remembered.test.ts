import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClosableAuthStorage, type AuthRecord } from '../../src/auth/auth-storage';
import type { Staged } from '../../src/auth/remembered';
import { testAccessToken } from './test-token';

// AUTH1b's lock, guarded slot and staged commits, on in-memory stores and a scripted Web Locks manager.
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
  raw() { return Object.fromEntries([...this.values.entries()].sort()); }
}

/** One exclusive lock, as `navigator.locks` grants it: in order, with `ifAvailable` and abortable waits. */
class Locks {
  holder = false;
  queue: (() => void)[] = [];
  refuse = false;
  request = vi.fn((_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown) => {
    if (this.refuse) return Promise.reject(new DOMException('Refused.', 'SecurityError'));
    const run = () => {
      this.holder = true;
      return Promise.resolve(callback({ name: 'stillroom.remembered' })).finally(() => {
        this.holder = false;
        this.queue.shift()?.();
      });
    };
    if (!this.holder) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const grant = () => { run().then(resolve, reject); };
      this.queue.push(grant);
      options.signal?.addEventListener('abort', () => {
        this.queue = this.queue.filter((entry) => entry !== grant);
        reject(new DOMException('Aborted.', 'AbortError'));
      });
    });
  });
}

const record = (owner: string, label: string): AuthRecord => ({
  access_token: testAccessToken(owner, { exp: 1_900_000_000, label }), refresh_token: `refresh-${label}`, expires_at: 1_900_000_000,
});
const raw = (value: AuthRecord) => JSON.stringify({ access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let local: MemoryStorage;
let session: MemoryStorage;
let locks: Locks;
beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  locks = new Locks();
  vi.stubGlobal('window', { localStorage: local, sessionStorage: session, location: { href: 'http://localhost/' }, addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('navigator', { locks, onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('device lock', () => {
  it('grants a free lock, reports a held one as busy, and lets a waiter in on release', async () => {
    const { acquireLock } = await import('../../src/auth/device-lock');
    const first = await acquireLock(false);
    expect(first).not.toBeNull();
    expect(await acquireLock(false)).toBeNull();
    const waiting = acquireLock(true);
    let granted = false;
    void waiting.then(() => { granted = true; });
    await tick();
    expect(granted).toBe(false);
    first!.release();
    const second = await waiting;
    expect(second).not.toBeNull();
    second!.release();
  });

  it('rejects when the API is missing or the request is refused, and a stopped wait never gets the lock', async () => {
    const { acquireLock, hasLocks } = await import('../../src/auth/device-lock');
    locks.refuse = true;
    await expect(acquireLock(false)).rejects.toThrow();
    locks.refuse = false;
    const held = await acquireLock(false);
    const stop = new AbortController();
    const waiting = acquireLock(true, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow();
    held!.release();
    vi.stubGlobal('navigator', {});
    expect(hasLocks()).toBe(false);
    await expect(acquireLock(false)).rejects.toThrow('Web Locks unavailable.');
  });
});

describe('guarded slot storage', () => {
  it('drops every write once someone else changed or removed the record it last saw, and keeps the last record', () => {
    const a = record(USER_A, 'token-a');
    const store = new ClosableAuthStorage(() => local, true);
    store.setItem('stillroom.auth', raw(a));
    expect(store.getItem('stillroom.auth')).toBe(raw(a));
    // An older release's sign-out clears the namespace.
    local.removeItem('stillroom.auth');
    store.setItem('stillroom.auth', raw(record(USER_A, 'token-a2')));
    expect(local.raw()).toEqual({});
    expect(store.closed).toBe(true);
    expect(store.last?.refresh_token).toBe('refresh-token-a');
  });

  it('drops a write after another record replaced the one it saw', () => {
    const store = new ClosableAuthStorage(() => local, true);
    store.setItem('stillroom.auth', raw(record(USER_A, 'token-a')));
    local.setItem('stillroom.auth', raw(record(USER_B, 'token-b')));
    expect(store.getItem('stillroom.auth')).toBeNull();
    store.setItem('stillroom.auth', raw(record(USER_A, 'token-a2')));
    expect(local.getItem('stillroom.auth')).toBe(raw(record(USER_B, 'token-b')));
  });

  it('an unguarded per-tab store keeps writing after an outside change', () => {
    const store = new ClosableAuthStorage(() => session);
    store.setItem('stillroom.auth', raw(record(USER_A, 'token-a')));
    session.removeItem('stillroom.auth');
    store.setItem('stillroom.auth', raw(record(USER_A, 'token-a2')));
    expect(session.getItem('stillroom.auth')).toBe(raw(record(USER_A, 'token-a2')));
  });
});

describe('releasing and retiring clients', () => {
  it('a per-tab retire clears only this tab, and a release clears nothing', async () => {
    const { makeClient, releaseClient, retireClient } = await import('../../src/data/client');
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    local.setItem('stillroom.auth-code-verifier', 'v');
    session.setItem('stillroom.auth', raw(record(USER_B, 'token-b')));
    const tab = makeClient(config, 'tab');
    expect(retireClient(tab).record?.refresh_token).toBe('refresh-token-b');
    expect(session.raw()).toEqual({});
    expect(local.raw()).toEqual({ 'stillroom.auth': slot, 'stillroom.auth-code-verifier': 'v' });
    session.setItem('stillroom.auth', raw(record(USER_B, 'token-b2')));
    for (const mode of ['tab', 'device'] as const) releaseClient(makeClient(config, mode));
    await tick();
    expect(local.raw()).toEqual({ 'stillroom.auth': slot, 'stillroom.auth-code-verifier': 'v' });
    expect(session.getItem('stillroom.auth')).toBe(raw(record(USER_B, 'token-b2')));
  });
});

type Fake = {
  clients: { revoke: ReturnType<typeof vi.fn> }; generation: number; started: boolean; lock: 'available' | 'absent' | 'rejected';
  allowSession: boolean; held: { release(): void } | null; deviceSlot: boolean;
  channels: { send: ReturnType<typeof vi.fn> }; switchClient: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn>;
  getSnapshot(): object; settle: ReturnType<typeof vi.fn>; queue: AbortController;
};
function controller(): Fake {
  return {
    clients: { revoke: vi.fn(async () => 'ok') }, generation: 0, started: true, lock: 'available', allowSession: false, held: null,
    deviceSlot: false, channels: { send: vi.fn() }, switchClient: vi.fn(), publish: vi.fn(), getSnapshot: () => ({}), settle: vi.fn(),
    queue: new AbortController(),
  };
}
async function rememberedWith(staging: () => Promise<Staged>) {
  const { remembered } = await import('../../src/auth/remembered');
  return remembered(config, () => staging());
}
const revoked = (fake: Fake) => fake.clients.revoke.mock.calls.map(([value]) => (value as AuthRecord).refresh_token);

describe('staged sign-in', () => {
  it('a ticked commit writes only the allowlisted slot, empties this tab and revokes what it displaced', async () => {
    const left = record(USER_A, 'token-a');
    const own = record(USER_B, 'token-b');
    const next = record(USER_B, 'token-b2');
    local.setItem('stillroom.auth', raw(left));
    session.setItem('stillroom.auth', raw(own));
    session.setItem('stillroom.auth-code-verifier', 'v');
    const fake = controller();
    const mode = await rememberedWith(async () => ({ record: next, user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', true);
    expect(local.raw()).toEqual({ 'stillroom.auth': raw(next) });
    expect(session.raw()).toEqual({});
    expect(fake.switchClient).toHaveBeenCalledWith('device', null);
    expect(fake.held).not.toBeNull();
    expect(revoked(fake).sort()).toEqual(['refresh-token-a', 'refresh-token-b']);
    expect(fake.channels.send).not.toHaveBeenCalled();
    fake.held!.release();
  });

  it('an unticked commit writes this tab only, asks a holder to end, then removes and revokes a left slot', async () => {
    const left = record(USER_A, 'token-a');
    const next = record(USER_B, 'token-b');
    local.setItem('stillroom.auth', raw(left));
    local.setItem('stillroom.auth-user', 'leftover');
    local.setItem('stillroom.language', 'fi');
    const fake = controller();
    const mode = await rememberedWith(async () => ({ record: next, user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', false);
    expect(session.raw()).toEqual({ 'stillroom.auth': raw(next) });
    expect(fake.switchClient).toHaveBeenCalledWith('tab', null);
    expect(fake.channels.send.mock.calls).toEqual([['end-remembered']]);
    await vi.waitFor(() => expect(local.raw()).toEqual({ 'stillroom.language': 'fi' }));
    await vi.waitFor(() => expect(revoked(fake)).toEqual(['refresh-token-a']));
  });

  it('a ticked sign-in while another window holds the lock takes nothing, revokes its own record and waits', async () => {
    const holder = record(USER_A, 'token-a');
    local.setItem('stillroom.auth', raw(holder));
    const { acquireLock } = await import('../../src/auth/device-lock');
    const held = await acquireLock(false);
    const fake = controller();
    const mode = await rememberedWith(async () => ({ record: record(USER_B, 'token-b'), user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', true);
    expect(local.raw()).toEqual({ 'stillroom.auth': raw(holder) });
    expect(session.raw()).toEqual({});
    expect(revoked(fake)).toEqual(['refresh-token-b']);
    expect(fake.switchClient).not.toHaveBeenCalled();
    fake.queue.abort();
    held!.release();
  });

  it('discards a staged sign-in that finishes after a sign-out or another sign-in, and revokes it', async () => {
    let finish!: (value: Staged) => void;
    const fake = controller();
    const mode = await rememberedWith(() => new Promise<Staged>((resolve) => { finish = resolve; }));
    const pending = mode.signIn(fake as never, 'a@example.test', 'pw', true);
    fake.generation++;
    finish({ record: record(USER_A, 'token-late'), user: null });
    await pending;
    expect(local.raw()).toEqual({});
    expect(session.raw()).toEqual({});
    expect(fake.switchClient).not.toHaveBeenCalled();
    expect(revoked(fake)).toEqual(['refresh-token-late']);
    expect(locks.holder).toBe(false);
  });

  it('a refused lock request falls back to this tab\'s own session', async () => {
    locks.refuse = true;
    const fake = controller();
    const mode = await rememberedWith(async () => ({ record: record(USER_A, 'token-a'), user: null }));
    await mode.signIn(fake as never, 'a@example.test', 'pw', true);
    expect(fake.lock).toBe('rejected');
    expect(session.raw()).toEqual({ 'stillroom.auth': raw(record(USER_A, 'token-a')) });
    expect(local.raw()).toEqual({});
    expect(fake.switchClient).toHaveBeenCalledWith('tab', null);
  });
});

describe('signing a slot out of the device', () => {
  it('without the lock API: removes the slot and its leftovers, keeps other keys, revokes it and tells other tabs', async () => {
    const left = record(USER_A, 'token-a');
    local.setItem('stillroom.auth', JSON.stringify({ ...JSON.parse(raw(left)), user: { id: USER_A } }));
    local.setItem('stillroom.auth-user', 'leftover');
    local.setItem('stillroom.auth-orphan', 'x');
    local.setItem('stillroom.language', 'sv');
    const fake = { ...controller(), lock: 'absent' as const, deviceSlot: true };
    const mode = await rememberedWith(async () => { throw new Error('not used'); });
    await mode.signOutDevice(fake as never);
    expect(local.raw()).toEqual({ 'stillroom.language': 'sv' });
    expect(revoked(fake)).toEqual(['refresh-token-a']);
    expect(fake.channels.send.mock.calls).toEqual([['sign-out']]);
  });

  it('after a refused lock request: asks the holder only, and touches nothing here', async () => {
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    const fake = { ...controller(), lock: 'rejected' as const, deviceSlot: true };
    const mode = await rememberedWith(async () => { throw new Error('not used'); });
    await mode.signOutDevice(fake as never);
    expect(local.raw()).toEqual({ 'stillroom.auth': slot });
    expect(fake.clients.revoke).not.toHaveBeenCalled();
    expect(fake.channels.send.mock.calls).toEqual([['end-remembered'], ['sign-out']]);
  });
});
