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

/** One exclusive lock, as `navigator.locks` grants it with `ifAvailable`. */
class Locks {
  holder = false;
  refuse = false;
  request = vi.fn((_name: string, _options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
    if (this.refuse) return Promise.reject(new DOMException('Refused.', 'SecurityError'));
    if (this.holder) return Promise.resolve(callback(null));
    this.holder = true;
    return Promise.resolve(callback({ name: 'stillroom.remembered' })).finally(() => { this.holder = false; });
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
  it('grants a free lock once, and busy, refused or missing all resolve null without waiting', async () => {
    const { acquireLock, hasLocks } = await import('../../src/auth/device-lock');
    const first = await acquireLock();
    expect(first).not.toBeNull();
    expect(await acquireLock()).toBeNull();
    first!.release();
    await tick();
    const second = await acquireLock();
    expect(second).not.toBeNull();
    second!.release();
    await tick();
    locks.refuse = true;
    expect(await acquireLock()).toBeNull();
    vi.stubGlobal('navigator', {});
    expect(hasLocks()).toBe(false);
    expect(await acquireLock()).toBeNull();
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
  clients: { revoke: ReturnType<typeof vi.fn> }; generation: number; started: boolean; allowSession: boolean;
  held: { release(): void } | null; ownSession: boolean; canRemember: boolean;
  switchClient: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn>; dropHolder: ReturnType<typeof vi.fn>;
};
function controller(held: { release(): void } | null = null): Fake {
  const fake: Fake = {
    clients: { revoke: vi.fn(async () => 'ok') }, generation: 0, started: true, allowSession: false, held, ownSession: false,
    get canRemember() { return fake.held !== null; },
    switchClient: vi.fn(), settle: vi.fn(), dropHolder: vi.fn(() => { fake.held?.release(); fake.held = null; }),
  };
  return fake;
}
async function rememberedWith(staging: () => Promise<Staged> = async () => { throw new Error('not used'); }) {
  const { remembered } = await import('../../src/auth/remembered');
  return remembered(config, () => staging());
}
const revoked = (fake: Fake) => fake.clients.revoke.mock.calls.map(([value]) => (value as AuthRecord).refresh_token);
async function holding() {
  const { acquireLock } = await import('../../src/auth/device-lock');
  return controller(await acquireLock());
}

describe('staged sign-in', () => {
  it('a ticked commit by the holder writes only the allowlisted slot, empties this tab and revokes what it displaced', async () => {
    const left = record(USER_A, 'token-a');
    const own = record(USER_B, 'token-b');
    const next = record(USER_B, 'token-b2');
    local.setItem('stillroom.auth', raw(left));
    session.setItem('stillroom.auth', raw(own));
    session.setItem('stillroom.auth-code-verifier', 'v');
    const fake = await holding();
    const mode = await rememberedWith(async () => ({ record: next, user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', true);
    expect(local.raw()).toEqual({ 'stillroom.auth': raw(next) });
    expect(session.raw()).toEqual({});
    expect(fake.switchClient).toHaveBeenCalledWith('device', null);
    expect(fake.dropHolder).not.toHaveBeenCalled();
    expect(locks.holder).toBe(true);
    expect(revoked(fake).sort()).toEqual(['refresh-token-a', 'refresh-token-b']);
    fake.held!.release();
  });

  it('an unticked commit writes this tab only, leaves the slot alone and lets the lock go', async () => {
    const left = raw(record(USER_A, 'token-a'));
    const next = record(USER_B, 'token-b');
    local.setItem('stillroom.auth', left);
    const fake = await holding();
    const mode = await rememberedWith(async () => ({ record: next, user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', false);
    expect(session.raw()).toEqual({ 'stillroom.auth': raw(next) });
    expect(local.raw()).toEqual({ 'stillroom.auth': left });
    expect(fake.switchClient).toHaveBeenCalledWith('tab', null);
    expect(fake.dropHolder).toHaveBeenCalledOnce();
    await tick();
    expect(locks.holder).toBe(false);
    expect(revoked(fake)).toEqual([]);
  });

  it('a ticked sign-in without the lock commits to this tab only and never touches the slot', async () => {
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    const fake = controller();
    const mode = await rememberedWith(async () => ({ record: record(USER_B, 'token-b'), user: null }));
    await mode.signIn(fake as never, 'b@example.test', 'pw', true);
    expect(local.raw()).toEqual({ 'stillroom.auth': slot });
    expect(session.raw()).toEqual({ 'stillroom.auth': raw(record(USER_B, 'token-b')) });
    expect(fake.switchClient).toHaveBeenCalledWith('tab', null);
    expect(revoked(fake)).toEqual([]);
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
  });
});

describe('claiming the slot', () => {
  it('adopts a valid slot, rewriting extra fields to the allowlisted form', async () => {
    const value = record(USER_A, 'token-a');
    local.setItem('stillroom.auth', JSON.stringify({ ...JSON.parse(raw(value)), user: { id: USER_A } }));
    const fake = controller();
    await (await rememberedWith()).claim(fake as never);
    expect(fake.held).not.toBeNull();
    expect(fake.switchClient).toHaveBeenCalledWith('device');
    expect(local.raw()).toEqual({ 'stillroom.auth': raw(value) });
    fake.held!.release();
  });

  it('removes an invalid slot and its leftovers, keeps other keys and the lock, and sends nothing', async () => {
    local.setItem('stillroom.auth', '{"access_token":"x"}');
    local.setItem('stillroom.auth-user', 'leftover');
    local.setItem('stillroom.language', 'sv');
    const fake = controller();
    await (await rememberedWith()).claim(fake as never);
    expect(local.raw()).toEqual({ 'stillroom.language': 'sv' });
    expect(fake.held).not.toBeNull();
    expect(fake.switchClient).not.toHaveBeenCalled();
    expect(fake.settle).toHaveBeenCalledOnce();
    expect(fake.clients.revoke).not.toHaveBeenCalled();
    fake.held!.release();
  });

  it('busy or refused: leaves the slot byte for byte and settles without the lock', async () => {
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    const { acquireLock } = await import('../../src/auth/device-lock');
    const other = await acquireLock();
    for (const refuse of [false, true]) {
      locks.refuse = refuse;
      const fake = controller();
      await (await rememberedWith()).claim(fake as never);
      expect(fake.held).toBeNull();
      expect(fake.settle).toHaveBeenCalledOnce();
      expect(fake.switchClient).not.toHaveBeenCalled();
      expect(local.raw()).toEqual({ 'stillroom.auth': slot });
    }
    other!.release();
  });

  it('a grant that arrives after this tab took a session or stopped is let go without reading the slot', async () => {
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    for (const change of [(fake: Fake) => { fake.ownSession = true; }, (fake: Fake) => { fake.started = false; }]) {
      const fake = controller();
      const pending = (await rememberedWith()).claim(fake as never);
      change(fake);
      await pending;
      expect(fake.held).toBeNull();
      expect(fake.switchClient).not.toHaveBeenCalled();
      await tick();
      expect(locks.holder).toBe(false);
      expect(local.raw()).toEqual({ 'stillroom.auth': slot });
    }
  });

  it('a grant that arrives after a sign-out or a sign-in began keeps the lock but adopts and cleans nothing', async () => {
    const slot = raw(record(USER_A, 'token-a'));
    local.setItem('stillroom.auth', slot);
    const fake = controller();
    const pending = (await rememberedWith()).claim(fake as never);
    fake.generation++;
    await pending;
    expect(fake.held).not.toBeNull();
    expect(fake.switchClient).not.toHaveBeenCalled();
    expect(fake.settle).toHaveBeenCalledOnce();
    expect(local.raw()).toEqual({ 'stillroom.auth': slot });
    fake.held!.release();
  });
});
