import { describe, expect, it } from 'vitest';
import { clearAuthNamespace, ClosableAuthStorage, storedAccessToken } from '../../src/auth/auth-storage';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  keys() { return [...this.values.keys()].sort(); }
}

describe('closable auth storage', () => {
  it('reads and writes until closed, then never touches the store again', () => {
    const store = new MemoryStorage();
    const adapter = new ClosableAuthStorage(() => store);
    adapter.setItem('stillroom.auth', 'a');
    expect(adapter.getItem('stillroom.auth')).toBe('a');
    adapter.close();
    expect(adapter.closed).toBe(true);
    expect(adapter.getItem('stillroom.auth')).toBeNull();
    adapter.setItem('stillroom.auth', 'late');
    adapter.removeItem('stillroom.auth');
    expect(store.getItem('stillroom.auth')).toBe('a');
  });

  it('clears the whole auth namespace in both stores, including indexed and orphaned PKCE slots', () => {
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
    clearAuthNamespace([session, local]);
    expect(session.keys()).toEqual(['stillroom.language', 'stillroom.logout']);
    expect(local.keys()).toEqual(['stillroom.language', 'stillroom.logout']);
  });

  it('reads an access token only from a well-formed stored session', () => {
    expect(storedAccessToken(JSON.stringify({ access_token: 'token-a' }))).toBe('token-a');
    for (const stored of [null, '', 'not json', '{}', '{"access_token":""}', '{"access_token":1}', 'null']) {
      expect(storedAccessToken(stored)).toBeNull();
    }
  });
});
