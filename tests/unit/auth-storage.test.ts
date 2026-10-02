import { describe, expect, it } from 'vitest';
import {
  clearAuthNamespace, ClosableAuthStorage, MemoryUserStorage, migrateAuthStore, readAuthRecord, sessionOwner,
  storedAccessToken, tokenClaims,
} from '../../src/auth/auth-storage';
import { testAccessToken } from './test-token';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  keys() { return [...this.values.keys()].sort(); }
  raw() { return Object.fromEntries([...this.values.entries()].sort()); }
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const allowlisted = { access_token: 'access-a', refresh_token: 'refresh-a', expires_at: 1_900_000_000 };
const sdkRecord = {
  ...allowlisted, token_type: 'bearer', expires_in: 3600, provider_token: 'provider',
  user: { id: OWNER, email: 'a@example.test', user_metadata: { name: 'A' } },
};

describe('closable auth storage', () => {
  it('stores only the two tokens and the expiry, whatever the SDK writes', () => {
    const store = new MemoryStorage();
    const adapter = new ClosableAuthStorage(() => store);
    adapter.setItem('stillroom.auth', JSON.stringify(sdkRecord));
    expect(store.raw()).toEqual({ 'stillroom.auth': JSON.stringify(allowlisted) });
    expect(JSON.parse(adapter.getItem('stillroom.auth') ?? 'null')).toEqual(allowlisted);
  });

  it('refuses the user object and every other key, but keeps the PKCE verifiers', () => {
    const store = new MemoryStorage();
    const adapter = new ClosableAuthStorage(() => store);
    adapter.setItem('stillroom.auth-user', JSON.stringify({ user: sdkRecord.user }));
    adapter.setItem('stillroom.wardrobe', 'private');
    adapter.setItem('stillroom.auth-code-verifier', 'v1');
    adapter.setItem('stillroom.auth-flow-3f2c-code-verifier', 'v2');
    expect(store.keys()).toEqual(['stillroom.auth-code-verifier', 'stillroom.auth-flow-3f2c-code-verifier']);
    expect(adapter.getItem('stillroom.wardrobe')).toBeNull();
  });

  it('drops a record that cannot be allowlisted and reads nothing from a malformed one', () => {
    const store = new MemoryStorage();
    const adapter = new ClosableAuthStorage(() => store);
    adapter.setItem('stillroom.auth', JSON.stringify({ access_token: 'only' }));
    expect(store.keys()).toEqual([]);
    store.setItem('stillroom.auth', JSON.stringify(sdkRecord));
    expect(adapter.getItem('stillroom.auth')).toBeNull();
  });

  it('reads and writes until closed, then never touches the store again', () => {
    const store = new MemoryStorage();
    const adapter = new ClosableAuthStorage(() => store);
    adapter.setItem('stillroom.auth', JSON.stringify(allowlisted));
    expect(adapter.getItem('stillroom.auth')).toBe(JSON.stringify(allowlisted));
    adapter.close();
    expect(adapter.closed).toBe(true);
    expect(adapter.getItem('stillroom.auth')).toBeNull();
    adapter.setItem('stillroom.auth', JSON.stringify({ ...allowlisted, access_token: 'late' }));
    adapter.removeItem('stillroom.auth');
    expect(store.getItem('stillroom.auth')).toBe(JSON.stringify(allowlisted));
  });

  it('keeps the user only in memory', () => {
    const user = new MemoryUserStorage();
    user.setItem('stillroom.auth-user', 'u');
    expect(user.getItem('stillroom.auth-user')).toBe('u');
    user.clear();
    expect(user.getItem('stillroom.auth-user')).toBeNull();
  });

  it('clears the whole auth namespace in the given stores, including indexed and orphaned PKCE slots', () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    for (const store of [session, local]) {
      for (const key of ['stillroom.auth', 'stillroom.auth-user', 'stillroom.auth-code-verifier',
        'stillroom.auth-flow-3f2c-code-verifier', 'stillroom.auth-flow-orphan-code-verifier', 'stillroom.auth-flows-code-verifier']) {
        store.setItem(key, 'x');
      }
      store.setItem('stillroom.logout', 'keep');
      store.setItem('stillroom.language', 'keep');
    }
    clearAuthNamespace([session]);
    expect(session.keys()).toEqual(['stillroom.language', 'stillroom.logout']);
    expect(local.keys()).toHaveLength(8);
    clearAuthNamespace([local]);
    expect(local.keys()).toEqual(['stillroom.language', 'stillroom.logout']);
  });

  it('reads an access token only from an exactly allowlisted record', () => {
    expect(storedAccessToken(JSON.stringify(allowlisted))).toBe('access-a');
    expect(readAuthRecord(JSON.stringify(allowlisted))).toEqual(allowlisted);
    for (const stored of [null, '', 'not json', '{}', '{"access_token":""}', '{"access_token":1}', 'null',
      JSON.stringify({ access_token: 'token-a' }), JSON.stringify(sdkRecord), JSON.stringify({ ...allowlisted, extra: 1 })]) {
      expect(storedAccessToken(stored)).toBeNull();
    }
  });
});

describe('stored-session migration', () => {
  it('rewrites a valid record from an older release to the allowlisted form', () => {
    const store = new MemoryStorage();
    store.setItem('stillroom.auth', JSON.stringify(sdkRecord));
    store.setItem('stillroom.auth-code-verifier', 'v');
    store.setItem('stillroom.language', 'fi');
    migrateAuthStore(store);
    expect(store.raw()).toEqual({
      'stillroom.auth': JSON.stringify(allowlisted), 'stillroom.auth-code-verifier': 'v', 'stillroom.language': 'fi',
    });
  });

  it.each([
    ['malformed JSON', '{"access_token":'],
    ['a tokenless record', JSON.stringify({ user: sdkRecord.user })],
    ['an empty refresh token', JSON.stringify({ ...allowlisted, refresh_token: '' })],
    ['a non-integer expiry', JSON.stringify({ ...allowlisted, expires_at: '1900000000' })],
    ['an array', '[]'],
  ])('removes %s with the user key and orphaned auth keys', (_label, raw) => {
    const store = new MemoryStorage();
    store.setItem('stillroom.auth', raw);
    store.setItem('stillroom.auth-user', JSON.stringify({ user: sdkRecord.user }));
    store.setItem('stillroom.auth-orphan', 'x');
    store.setItem('stillroom.logout', 'keep');
    migrateAuthStore(store);
    expect(store.raw()).toEqual({ 'stillroom.logout': 'keep' });
  });

  it('leaves an allowlisted record and its verifiers exactly as they are', () => {
    const store = new MemoryStorage();
    store.setItem('stillroom.auth', JSON.stringify(allowlisted));
    store.setItem('stillroom.auth-flow-1-code-verifier', 'v');
    migrateAuthStore(store);
    expect(store.raw()).toEqual({ 'stillroom.auth': JSON.stringify(allowlisted), 'stillroom.auth-flow-1-code-verifier': 'v' });
  });

  it('removes a user key left without a session', () => {
    const store = new MemoryStorage();
    store.setItem('stillroom.auth-user', JSON.stringify({ user: sdkRecord.user }));
    migrateAuthStore(store);
    expect(store.keys()).toEqual([]);
  });
});

describe('token claims', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (claims: Record<string, unknown>) => `${encode({ alg: 'HS256' })}.${encode(claims)}.signature`;
  const valid = { sub: OWNER, role: 'authenticated', aud: 'authenticated', exp: 1_900_000_000, session_id: 'sess-1' };

  it('reads the owner, expiry and session from a well-formed access token', () => {
    expect(tokenClaims(token(valid))).toEqual({ sub: OWNER, exp: 1_900_000_000, sessionId: 'sess-1' });
    expect(tokenClaims(token({ ...valid, aud: ['authenticated'] }))?.sub).toBe(OWNER);
    expect(sessionOwner({ access_token: testAccessToken(OWNER) })).toBe(OWNER);
  });

  it.each([
    ['not a string', 42],
    ['two parts', `${encode({})}.${encode(valid)}`],
    ['four parts', `${token(valid)}.extra`],
    ['non-base64url characters', `a.${encode(valid)}+.b`],
    ['a non-JSON payload', `a.${Buffer.from('nope').toString('base64url')}.b`],
    ['an array payload', `a.${encode([valid])}.b`],
    ['a non-UUID sub', token({ ...valid, sub: 'user-a' })],
    ['the anon role', token({ ...valid, role: 'anon' })],
    ['the service role', token({ ...valid, role: 'service_role' })],
    ['another audience', token({ ...valid, aud: 'other' })],
    ['two audiences', token({ ...valid, aud: ['authenticated', 'other'] })],
    ['a string expiry', token({ ...valid, exp: '1900000000' })],
    ['a fractional expiry', token({ ...valid, exp: 1.5 })],
    ['no expiry', token({ ...valid, exp: undefined })],
  ])('fails closed for %s', (_label, value) => {
    expect(tokenClaims(value)).toBeNull();
    expect(sessionOwner({ access_token: value })).toBeNull();
  });

  it('never reads the owner from the user object', () => {
    expect(sessionOwner({ access_token: 'opaque', user: { id: OWNER } } as never)).toBeNull();
    expect(sessionOwner(null)).toBeNull();
  });
});
