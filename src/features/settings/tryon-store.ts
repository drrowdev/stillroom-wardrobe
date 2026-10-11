// VTO-2: try-on status and consent for one owner scope, in memory only, shared by the Settings card and the outfit
// screens through a per-scope registry. Same ordering as the enhancement store: one read at a time, no read overtakes a
// consent write, and an unknown write outcome stays unresolved until a later read. It also holds this scope's session
// stop: two consecutive FAILED or TIMEOUT steps stop new dispatch for 10 minutes (rev4 §2.4).
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { readConfiguration, type PublicConfig } from '../../data/config';
import { TryOnClient, tryOnView, type TryOnRead, type TryOnStatus, type TryOnView } from '../../data/tryon';
import type { MessageKey } from '../../i18n';
import { readPersonPhoto } from './tryon-photo';

export const SESSION_STOP_MS = 600_000;
export type TryOnState = {
  read: TryOnRead; known: boolean; unresolved: boolean; reading: boolean; writing: boolean; settingsError: MessageKey | null;
};
const initial: TryOnState = { read: { kind: 'unknown' }, known: false, unresolved: false, reading: false, writing: false, settingsError: null };

/**
 * TRYON-PHOTO1: the owner's one saved reference photo, as the store knows it (the bytes are never held here). `read` tells
 * whether the state is known; `error` is the last failed change, cleared by the next one.
 */
export type PhotoState = {
  read: 'unknown' | 'missing' | 'failed' | 'ready'; saved: { bytes: number; savedAtMs: number } | null;
  busy: 'save' | 'remove' | null; error: 'save' | 'remove' | null;
};
export const initialPhoto: PhotoState = { read: 'unknown', saved: null, busy: null, error: null };

/**
 * The notice (revision 2, TRYON-PHOTO1) states the one reusable saved photo. Revision 1 is kept frozen in
 * tests/unit/tryon-notice.test.ts; its keys stay in the catalogue and are never shown. Pinned in tryon-notice.test.ts.
 */
export const TRYON_NOTICE_KEYS = [
  'tryonC.notice2Sent', 'tryonC.notice2Saved', 'tryonC.notice2Result', 'tryonC.notice2Processing', 'tryonC.notice2Charges',
] as const satisfies readonly MessageKey[];

export class TryOnStore {
  private state: TryOnState = initial;
  private readonly listeners = new Set<() => void>();
  readonly api: TryOnClient;
  seq = 0;
  applied = 0;
  lastWrite = 0;
  readPromise: Promise<TryOnStatus | null> | null = null;
  writePromise: Promise<void> | null = null;
  busy = false;
  deferred = false;
  disposed = false;
  consentOn = false;
  private failures = 0;
  private stoppedAt: number | null = null;
  constructor(client: AppClient, config: PublicConfig, readonly scope: OwnerScope, private readonly now: () => number = () => Date.now()) {
    this.api = new TryOnClient(client, config, scope);
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.dispose();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;
  // TRYON-PHOTO1: the saved reference photo. Every change is queued (see tryon-photo.ts); `photoGeneration` moves on any
  // save, removal, consent write or disposal, so bytes fetched before it moved are dropped instead of used.
  private photo: PhotoState = initialPhoto;
  private readonly photoListeners = new Set<() => void>();
  photoChain: Promise<void> = Promise.resolve();
  photoGeneration = 0;
  subscribePhoto = (listener: () => void) => { this.photoListeners.add(listener); return () => { this.photoListeners.delete(listener); }; };
  getPhoto = () => this.photo;
  updatePhoto(patch: Partial<PhotoState>) {
    if (this.disposed) return;
    this.photo = { ...this.photo, ...patch };
    for (const listener of this.photoListeners) listener();
  }
  update(patch: Partial<TryOnState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setBusy(busy: boolean) {
    this.busy = busy;
    if (!busy && this.deferred && !this.disposed) { this.deferred = false; void readTryOnStatus(this, 'passive'); }
  }
  /** Records a step outcome for the session stop; FILTERED and other refusals don't count and don't reset. */
  recordStep(outcome: 'ok' | 'failed' | 'other') {
    if (outcome === 'ok') { this.failures = 0; return; }
    if (outcome !== 'failed') return;
    this.failures += 1;
    if (this.failures >= 2) { this.stoppedAt = this.now(); this.failures = 0; }
  }
  /** True while the session stop holds: no new step is sent. */
  stopped(): boolean {
    if (this.stoppedAt === null) return false;
    const elapsed = this.now() - this.stoppedAt;
    if (elapsed >= 0 && elapsed < SESSION_STOP_MS) return true;
    this.stoppedAt = null;
    return false;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.readPromise = null;
    this.deferred = false;
    this.lastWrite = ++this.seq;
    this.photoGeneration += 1;
    this.photo = initialPhoto;
    this.state = initial;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    for (const listener of this.photoListeners) listener();
    this.photoListeners.clear();
  }
}

const stores = new WeakMap<OwnerScope, TryOnStore>();
/** The try-on store of this owner scope; a new scope (logout, UID or epoch change) gets a new, empty one. */
export function tryOnStoreFor(client: AppClient, scope: OwnerScope, config?: PublicConfig): TryOnStore | null {
  const existing = stores.get(scope);
  if (existing && !existing.disposed) return existing;
  if (scope.signal.aborted) return null;
  const checked = config ? { status: 'ready' as const, value: config } : readConfiguration(import.meta.env);
  if (checked.status !== 'ready') return null;
  try {
    const store = new TryOnStore(client, checked.value, scope);
    stores.set(scope, store);
    return store;
  } catch { return null; }
}

/** Turn on is offered only when the server policy is activated and matches this app's notice revision, manifest and model. */
export const tryOnViewOf = (store: TryOnStore, state: TryOnState): TryOnView =>
  tryOnView(state.read, state.unresolved, state.known, store.consentOn);

function apply(store: TryOnStore, read: TryOnRead) {
  const state = store.get();
  // A status without consent info (UNAVAILABLE) says nothing about consent: keep the last known answer.
  if (read.kind === 'ready' && read.status.consent !== null) store.consentOn = read.status.consent.enabled === true;
  const settles = read.kind === 'ready' && read.status.consent !== null;
  store.update({ read, unresolved: state.unresolved && !settles,
    known: state.known || tryOnView(read, false, false, store.consentOn).kind !== 'hidden' });
}

/** `passive` waits for profile or consent writes, `fresh` postdates the caller. */
export function readTryOnStatus(store: TryOnStore, mode: 'passive' | 'active' | 'fresh'): Promise<TryOnStatus | null> {
  if (store.disposed) return Promise.resolve(null);
  if (mode === 'passive' && (store.busy || store.writePromise)) { store.deferred = true; return Promise.resolve(null); }
  if (store.writePromise) return store.writePromise.then(() => readTryOnStatus(store, 'active'));
  if (store.readPromise) return mode === 'fresh' ? store.readPromise.then(() => readTryOnStatus(store, 'active')) : store.readPromise;
  const at = ++store.seq, busyAtStart = store.busy;
  store.update({ reading: true });
  const promise: Promise<TryOnStatus | null> = store.api.status().then((result) => {
    if (store.disposed) return null;
    if (at > store.lastWrite && at > store.applied) {
      store.applied = at;
      apply(store, result.kind === 'missing' ? { kind: 'missing' } : { kind: 'ready', status: result.status });
    }
    return result.kind === 'ready' ? result.status : null;
  }, () => {
    if (store.disposed) return null;
    if (busyAtStart || store.busy) store.deferred = true;
    else if (at > store.lastWrite && at > store.applied) { store.applied = at; store.update({ read: { kind: 'failed' } }); }
    return null;
  }).finally(() => {
    if (store.readPromise === promise) store.readPromise = null;
    store.update({ reading: false });
    if (store.deferred && !store.busy && !store.writePromise && !store.disposed) { store.deferred = false; void readTryOnStatus(store, 'passive'); }
  });
  store.readPromise = promise;
  return promise;
}

const permitted = (store: TryOnStore, enabled: boolean) => {
  const view = tryOnViewOf(store, store.get());
  return enabled ? view.turnOn : view.turnOff;
};
/** Turns try-on on or off: one write at a time, after any running read; an unknown outcome is read again. */
export function writeTryOnConsent(store: TryOnStore, enabled: boolean): Promise<void> {
  if (store.disposed || store.busy || store.writePromise || !permitted(store, enabled)) return Promise.resolve();
  let release!: () => void;
  store.writePromise = new Promise<void>((resolve) => { release = resolve; });
  return runWrite(store, enabled).finally(() => {
    store.lastWrite = ++store.seq;
    store.writePromise = null;
    store.update({ writing: false });
    // Turning try-on off removes the saved photo on the server: bytes fetched earlier are dropped and the state is read again.
    store.photoGeneration += 1;
    void readPersonPhoto(store);
    release();
    if (store.deferred && !store.busy && !store.disposed) { store.deferred = false; void readTryOnStatus(store, 'passive'); }
  });
}
async function runWrite(store: TryOnStore, enabled: boolean): Promise<void> {
  store.update({ writing: true, settingsError: null });
  if (store.readPromise) await store.readPromise;
  if (store.disposed || store.busy || !permitted(store, enabled)) return;
  const at = ++store.seq;
  store.lastWrite = at;
  try {
    const result = await store.api.consent(enabled);
    if (store.disposed) return;
    if (result.kind === 'applied') { store.applied = at; apply(store, { kind: 'ready', status: result.status }); return; }
    store.update({ settingsError: result.code === 'CONFIG_CHANGED' ? 'tryonC.changed' : 'tryonC.failed' });
  } catch {
    if (store.disposed) return;
    store.update({ unresolved: true });
  }
  void readTryOnStatus(store, 'active');
}
