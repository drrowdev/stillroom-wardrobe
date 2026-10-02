import { createClient, type User } from '@supabase/supabase-js';
import type { PublicConfig } from '../data/config';
import { REQUEST_TIMEOUT_MS, authStorageKey } from '../data/client';
import { authRecordFields, clearAuthNamespace, migrateAuthStore, readAuthRecord, type AuthRecord } from './auth-storage';
import type { Remembered, SessionController } from './session';
import { acquireLock } from './device-lock';
import { AppError } from '../data/errors';

export type Staged = { record: AuthRecord; user: User | null };
type Stage = (config: PublicConfig, email: string, password: string) => Promise<Staged>;

/** Remembered mode for one configuration. `staging` is replaceable for tests only. */
export function remembered(config: PublicConfig, staging: Stage = stage): Remembered {
  return {
    claim,
    signIn: (controller, email, password, remember) => signIn(controller, () => staging(config, email, password), remember),
  };
}

/**
 * For a window without a session of its own: take the slot's lock if it is free. Holding it, a valid slot becomes
 * this window's remembered session; otherwise the slot is cleaned and the lock kept, so the sign-in screen can offer
 * remember. Busy, missing or refused: this window signs in per tab and never touches the slot.
 */
async function claim(controller: SessionController): Promise<void> {
  const generation = controller.generation;
  const held = await acquireLock();
  if (held && (!controller.started || controller.held || controller.ownSession)) {
    held.release();
    controller.settle();
    return;
  }
  if (!held) { controller.settle(); return; }
  controller.held = held;
  // A sign-out or sign-in since the request: keep the lock for this window's next sign-in, but adopt nothing.
  if (generation !== controller.generation) { controller.settle(); return; }
  migrateAuthStore(window.localStorage);
  if (readAuthRecord(window.localStorage.getItem(authStorageKey))) {
    controller.switchClient('device');
    return;
  }
  clearAuthNamespace([window.localStorage]);
  controller.settle();
}

/**
 * Stages a sign-in, then commits it. Ticked (offered only while this window holds the lock), it becomes the
 * remembered session. Unticked, it becomes this tab's own session and the lock is let go. A sign-out or another
 * sign-in meanwhile discards it.
 */
async function signIn(controller: SessionController, staging: () => Promise<Staged>, remember: boolean): Promise<void> {
  const clients = controller.clients!;
  const generation = ++controller.generation;
  const staged = await staging();
  if (generation !== controller.generation || !controller.started) { void clients.revoke(staged.record); return; }
  const device = remember && controller.canRemember;
  controller.allowSession = true;
  const displaced = commit(staged.record, device);
  controller.switchClient(device ? 'device' : 'tab', staged.user);
  if (!device) controller.dropHolder();
  for (const record of displaced) if (record.refresh_token !== staged.record.refresh_token) void clients.revoke(record);
}

/**
 * Signs in on a throwaway client that keeps the session in memory only, never refreshes and shares no channel, so
 * nothing live changes until the caller commits the result.
 */
async function stage(config: PublicConfig, email: string, password: string): Promise<Staged> {
  const memory = new Map<string, string>();
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      storageKey: `stillroom.stage.${crypto.randomUUID()}`,
      storage: { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: (key) => { memory.delete(key); } },
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init, cache: 'no-store', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    },
  });
  try {
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    const record = error ? null : authRecordFields(data.session);
    if (!record) throw new AppError('auth.failed');
    return { record, user: data.session?.user ?? null };
  } finally {
    memory.clear();
    void client.auth.dispose().catch(() => undefined);
  }
}

/** Writes exactly the allowlisted form of a record. */
function writeAuthRecord(store: Storage, record: AuthRecord): void {
  store.setItem(authStorageKey, JSON.stringify({ access_token: record.access_token, refresh_token: record.refresh_token, expires_at: record.expires_at }));
}
/**
 * Commits a staged sign-in and returns the records it displaced, for revocation. A remembered commit (made only while
 * holding the lock) takes the slot and replaces this tab's own session; a per-tab commit replaces only the latter.
 */
function commit(record: AuthRecord, device: boolean): AuthRecord[] {
  const own = readAuthRecord(window.sessionStorage.getItem(authStorageKey));
  const displaced = device ? [readAuthRecord(window.localStorage.getItem(authStorageKey)), own] : [own];
  if (device) {
    writeAuthRecord(window.localStorage, record);
    clearAuthNamespace([window.sessionStorage]);
  } else writeAuthRecord(window.sessionStorage, record);
  return displaced.filter((item): item is AuthRecord => item !== null);
}