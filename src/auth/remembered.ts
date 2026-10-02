import { createClient, type User } from '@supabase/supabase-js';
import type { PublicConfig } from '../data/config';
import { REQUEST_TIMEOUT_MS, authStorageKey } from '../data/client';
import { authKeyPrefix, authRecordFields, clearAuthNamespace, migrateAuthStore, readAuthRecord, type AuthRecord } from './auth-storage';
import type { Remembered, SessionController } from './session';
import { acquireLock, type HeldLock } from './device-lock';
import { AppError } from '../data/errors';

export type Staged = { record: AuthRecord; user: User | null };
type Stage = (config: PublicConfig, email: string, password: string) => Promise<Staged>;

/** Remembered mode for one configuration. `staging` is replaceable for tests only. */
export function remembered(config: PublicConfig, staging: Stage = stage): Remembered {
  return {
    claim, signOutDevice, sweepSlot,
    signIn: (controller, email, password, remember) => signIn(controller, () => staging(config, email, password), remember),
  };
}

/**
 * Start-up with a remembered slot and no session of this tab's own: take the slot's lock if it is free, or wait for
 * it while another window holds it. A request the browser refuses leaves everything as it is.
 */
async function claim(controller: SessionController): Promise<void> {
  // Each start of the controller has its own signal; a stopped start lets go of anything it gets.
  const signal = controller.queue.signal;
  let held: HeldLock | null;
  try { held = await acquireLock(false); } catch { if (!signal.aborted) refused(controller); return; }
  if (!held && !signal.aborted) {
    controller.publish({ ...controller.getSnapshot(), phase: 'elsewhere', profile: null, scope: null });
    try { held = await acquireLock(true, signal); } catch { if (!signal.aborted) refused(controller); return; }
  }
  if (!held) return;
  if (signal.aborted) held.release();
  else adopt(controller, held);
}
function refused(controller: SessionController): void {
  controller.lock = 'rejected';
  controller.settle();
}
/** Holding the lock: a valid slot becomes this tab's remembered session; anything else is cleaned up and let go. */
function adopt(controller: SessionController, held: HeldLock): void {
  controller.lock = 'available';
  migrateAuthStore(window.localStorage);
  if (readAuthRecord(window.localStorage.getItem(authStorageKey))) {
    controller.held = held;
    controller.switchClient('device');
    return;
  }
  held.release();
  controller.settle();
}

/**
 * Stages a sign-in, then commits it. Ticked, it takes the slot's lock and becomes the remembered session; if another
 * window holds the lock, nothing is taken from it and this window waits. Unticked, it becomes this tab's own session
 * and signs any remembered session out of this device. A sign-out or another sign-in meanwhile discards it.
 */
async function signIn(controller: SessionController, staging: () => Promise<Staged>, remember: boolean): Promise<void> {
  const clients = controller.clients!;
  const generation = ++controller.generation;
  const staged = await staging();
  const drop = () => { void clients.revoke(staged.record); };
  if (generation !== controller.generation || !controller.started) { drop(); return; }
  let held: HeldLock | null = null;
  if (remember && controller.lock === 'available') {
    // A refused request falls back to this tab's own session.
    try { held = await acquireLock(false); } catch { controller.lock = 'rejected'; }
    if (!held && controller.lock === 'available') { drop(); void claim(controller); return; }
    if (generation !== controller.generation || !controller.started) { held?.release(); drop(); return; }
  }
  controller.allowSession = true;
  const displaced = commit(staged.record, held !== null);
  controller.held = held;
  controller.switchClient(held ? 'device' : 'tab', staged.user);
  for (const record of displaced) if (record.refresh_token !== staged.record.refresh_token) void clients.revoke(record);
  if (held) return;
  controller.channels?.send('end-remembered');
  if (controller.lock === 'available') void sweepSlot(clients.revoke);
}

/**
 * Signs a remembered session that this tab cannot adopt out of the device. Without the lock API no tab can hold it, so
 * the slot is removed here. After a refused request another window may hold it, so only that holder is asked.
 */
async function signOutDevice(controller: SessionController): Promise<void> {
  if (!controller.deviceSlot) return;
  const record = controller.lock === 'absent' ? clearSlot() : null;
  if (controller.lock === 'rejected') controller.channels?.send('end-remembered');
  controller.channels?.send('sign-out');
  if (record) void controller.clients?.revoke(record);
  controller.publish({ ...controller.getSnapshot() });
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

/**
 * Commits a staged sign-in and returns the records it displaced, for revocation. A remembered commit (made only while
 * holding the lock) takes the slot, so a slot left by a closed window and this tab's own session are displaced. A
 * per-tab commit displaces only this tab's own session.
 */
/** Writes exactly the allowlisted form of a record. */
function writeAuthRecord(store: Storage, record: AuthRecord): void {
  store.setItem(authStorageKey, JSON.stringify({ access_token: record.access_token, refresh_token: record.refresh_token, expires_at: record.expires_at }));
}
function commit(record: AuthRecord, device: boolean): AuthRecord[] {
  const own = readAuthRecord(window.sessionStorage.getItem(authStorageKey));
  const displaced = device ? [readAuthRecord(window.localStorage.getItem(authStorageKey)), own] : [own];
  if (device) {
    writeAuthRecord(window.localStorage, record);
    clearAuthNamespace([window.sessionStorage]);
  } else writeAuthRecord(window.sessionStorage, record);
  return displaced.filter((item): item is AuthRecord => item !== null);
}

/**
 * Removes the remembered slot, its user key and any orphaned auth keys from localStorage, each only while it still
 * holds what was read, and returns the removed record for revocation. Only a lock holder, or a browser without locks,
 * calls this.
 */
function clearSlot(): AuthRecord | null {
  const store = window.localStorage;
  const raw = store.getItem(authStorageKey);
  let record: AuthRecord | null = null;
  try { record = readAuthRecord(raw) ?? authRecordFields(JSON.parse(raw ?? 'null')); } catch { /* A malformed slot is only removed. */ }
  const keys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith(authKeyPrefix)) keys.push(key);
  }
  for (const key of keys) {
    const value = key === authStorageKey ? raw : store.getItem(key);
    if (store.getItem(key) === value) store.removeItem(key);
  }
  return record;
}

/**
 * After a sign-out or an unticked sign-in elsewhere: if a slot is left, wait up to 5 s for the lock and, holding it,
 * remove and revoke that slot. A live holder has already been told and ends its own session first.
 */
async function sweepSlot(revoke: (record: AuthRecord) => Promise<unknown>): Promise<void> {
  if (window.localStorage.getItem(authStorageKey) === null) return;
  const held = await acquireLock(true, AbortSignal.timeout(5_000)).catch(() => null);
  if (!held) return;
  let record: AuthRecord | null;
  try { record = clearSlot(); } finally { held.release(); }
  if (record) await revoke(record).catch(() => undefined);
}
