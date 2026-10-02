export const authKeyPrefix = 'stillroom.auth';
const sessionKey = authKeyPrefix;

/** The only fields an Auth record may keep in Web storage: the two tokens and the access token's expiry. */
export type AuthRecord = { access_token: string; refresh_token: string; expires_at: number };
const MAX_TOKEN_LENGTH = 16_384;

const isToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
function parse(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
/** The allowlisted fields of a record, from any object that carries valid ones (today's full SDK record included). */
export function authRecordFields(value: unknown): AuthRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { access_token: access, refresh_token: refresh, expires_at: expires } = record;
  if (!isToken(access) || !isToken(refresh) || typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 0) return null;
  return { access_token: access, refresh_token: refresh, expires_at: expires };
}
/** A stored record only if it is exactly the allowlisted form. */
export function readAuthRecord(raw: string | null): AuthRecord | null {
  const value = parse(raw);
  const fields = authRecordFields(value);
  return fields && Object.keys(value as object).length === 3 ? fields : null;
}
const serialize = (record: AuthRecord) => JSON.stringify({
  access_token: record.access_token, refresh_token: record.refresh_token, expires_at: record.expires_at,
});
const isVerifierKey = (key: string) => key.startsWith(`${sessionKey}-`) && key.endsWith('-code-verifier') && key.length <= 128;

/**
 * The Web storage behind one auth client. It keeps the session only in the allowlisted form and the SDK's PKCE
 * verifiers; every other key (the user object included) is refused. Once closed it never touches real storage again.
 *
 * A `guarded` store (the remembered slot) also drops a write once the record it last saw has been changed or removed
 * by someone else, such as an older release's sign-out, so a refresh can never put the record back.
 */
export class ClosableAuthStorage {
  private live = true;
  private seen: string | null | undefined;
  private lastSeen: AuthRecord | null = null;
  constructor(private readonly store: () => Storage, private readonly guarded = false) {}
  get closed(): boolean { return !this.live; }
  /** The last record this store read or wrote, kept so a removed slot can still be revoked. */
  get last(): AuthRecord | null { return this.lastSeen; }
  private note(raw: string | null): void {
    if (this.guarded && this.seen !== undefined && this.seen !== raw) this.live = false;
    else {
      this.seen = raw;
      this.lastSeen = readAuthRecord(raw) ?? this.lastSeen;
    }
  }
  getItem(key: string): string | null {
    if (!this.live) return null;
    if (key === sessionKey) {
      const raw = this.store().getItem(key);
      this.note(raw);
      return this.live && readAuthRecord(raw) ? raw : null;
    }
    return isVerifierKey(key) ? this.store().getItem(key) : null;
  }
  setItem(key: string, value: string): void {
    if (!this.live) return;
    if (key === sessionKey) {
      const record = authRecordFields(parse(value));
      if (!record) return;
      this.note(this.store().getItem(key));
      if (!this.live) return;
      const raw = serialize(record);
      this.store().setItem(key, raw);
      this.seen = raw;
      this.lastSeen = record;
      return;
    }
    if (isVerifierKey(key)) this.store().setItem(key, value);
  }
  removeItem(key: string): void {
    if (this.live && (key === sessionKey || key === `${sessionKey}-user` || isVerifierKey(key))) this.store().removeItem(key);
    if (key === sessionKey) this.seen = null;
  }
  close(): void { this.live = false; }
}

/** The SDK's user object lives only in memory, owned by one client, and is dropped with it. */
export class MemoryUserStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

function authKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith(authKeyPrefix)) keys.push(key);
  }
  return keys;
}
/** Removes every auth key (session, user and all PKCE verifier slots, including orphaned ones) from the given stores. */
export function clearAuthNamespace(stores: readonly Storage[]): void {
  for (const store of stores) for (const key of authKeys(store)) store.removeItem(key);
}
/** Removes `key` only while it still holds exactly `raw`, so a newer write is never lost. */
function removeIfUnchanged(store: Storage, key: string, raw: string | null): void {
  if (store.getItem(key) === raw) store.removeItem(key);
}

/**
 * Brings this tab's stored session into the allowlisted form before any client reads it. A valid record from an
 * older release (with the user object and other fields) is rewritten; anything invalid is removed with the user key
 * and any orphaned auth keys. Synchronous, on one store, so nothing else interleaves.
 */
export function migrateAuthStore(store: Storage): void {
  const raw = store.getItem(sessionKey);
  const record = authRecordFields(parse(raw));
  if (record) {
    const allowlisted = serialize(record);
    if (raw !== allowlisted && store.getItem(sessionKey) === raw) store.setItem(sessionKey, allowlisted);
    removeIfUnchanged(store, `${sessionKey}-user`, store.getItem(`${sessionKey}-user`));
    return;
  }
  for (const key of authKeys(store)) {
    if (key === sessionKey || !isVerifierKey(key)) removeIfUnchanged(store, key, store.getItem(key));
  }
  if (raw !== null) removeIfUnchanged(store, sessionKey, raw);
}

/** The access token of a stored allowlisted session, or null. Never logged. */
export function storedAccessToken(stored: string | null): string | null {
  return readAuthRecord(stored)?.access_token ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
type Claims = { sub: string; exp: number; sessionId: string | null };
/** The claims this app relies on locally, or null for anything malformed. The server still verifies every bearer. */
export function tokenClaims(token: unknown): Claims | null {
  if (!isToken(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => part.length > 0 && BASE64URL.test(part))) return null;
  let payload: unknown;
  try {
    const base64 = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch { return null; }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { sub, role, aud, exp, session_id: sessionId } = payload as Record<string, unknown>;
  const audience = Array.isArray(aud) ? aud.length === 1 && aud[0] === 'authenticated' : aud === 'authenticated';
  if (typeof sub !== 'string' || !UUID.test(sub) || role !== 'authenticated' || !audience
    || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) return null;
  return { sub, exp, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null };
}
/** The owner of a session, from its access token's claims; null (fail-closed) when they are malformed. */
export function sessionOwner(session: { access_token?: unknown } | null | undefined): string | null {
  return tokenClaims(session?.access_token)?.sub ?? null;
}
