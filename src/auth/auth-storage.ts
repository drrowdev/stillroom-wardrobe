export const authKeyPrefix = 'stillroom.auth';

/** The session storage behind one auth client. Once closed it never reopens and never touches real storage again. */
export class ClosableAuthStorage {
  private live = true;
  constructor(private readonly store: () => Storage) {}
  get closed(): boolean { return !this.live; }
  getItem(key: string): string | null { return this.live ? this.store().getItem(key) : null; }
  setItem(key: string, value: string): void { if (this.live) this.store().setItem(key, value); }
  removeItem(key: string): void { if (this.live) this.store().removeItem(key); }
  close(): void { this.live = false; }
}

/** Removes every auth key (session, user and all PKCE verifier slots, including orphaned ones) from both stores. */
export function clearAuthNamespace(stores: readonly Storage[]): void {
  for (const store of stores) {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(authKeyPrefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  }
}

/** The access token of a stored session, or null. Never logged. */
export function storedAccessToken(stored: string | null): string | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    return typeof value === 'object' && value !== null && 'access_token' in value
      && typeof value.access_token === 'string' && value.access_token ? value.access_token : null;
  } catch { return null; }
}
