// BG2b-2: photo-enhancement status and consent for one owner scope, in memory only. Shared by the Settings card and
// the wardrobe flows through a per-scope registry, so app.tsx is unchanged. Ordering follows #94's stylist store: one
// read at a time, no read overtakes a consent write, and an unknown write outcome stays unresolved until a later read.
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { readConfiguration, type PublicConfig } from '../../data/config';
import { EnhancementClient } from '../../data/enhancement';
import {
  enhanceView, knownEnabled, observeEnhanceStatus, type EnhanceRead, type EnhanceStatus, type EnhanceView,
} from '../../domain/enhance-controls';
import type { MessageKey } from '../../i18n';
import { EnhanceSession } from '../wardrobe/enhancement-stage';

/** The revision-2 (clean-up) notice paragraphs, in order. Pinned by tests/unit/enhancement-notice.test.ts. */
export const ENHANCE_NOTICE_KEYS = [
  'enhanceC.noticeSent', 'enhanceC.noticeRedraw', 'enhanceC.noticeProcessing', 'enhanceC.noticeOnlyPhoto', 'enhanceC.noticeTraining',
  'enhanceC.noticeLabel', 'enhanceC.noticeCharges',
] as const satisfies readonly MessageKey[];

export type EnhanceState = {
  read: EnhanceRead; known: boolean; unresolved: boolean; reading: boolean; writing: boolean; settingsError: MessageKey | null;
};
const initial: EnhanceState = { read: { kind: 'unknown' }, known: false, unresolved: false, reading: false, writing: false, settingsError: null };

export class EnhanceStore {
  private state: EnhanceState = initial;
  private readonly listeners = new Set<() => void>();
  readonly session: EnhanceSession;
  readonly api: EnhancementClient;
  seq = 0;
  applied = 0;
  lastWrite = 0;
  readPromise: Promise<EnhanceStatus | null> | null = null;
  writePromise: Promise<void> | null = null;
  busy = false;
  deferred = false;
  disposed = false;
  /** The last consent state a read showed, so Turn off stays offered after a later failed read. */
  consentOn = false;
  constructor(client: AppClient, config: PublicConfig, readonly scope: OwnerScope, now: () => number = () => performance.now()) {
    this.session = new EnhanceSession(now);
    this.api = new EnhancementClient(client, config, scope, now);
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.dispose();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;
  update(patch: Partial<EnhanceState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Profile writes hold the profile row, which enhance_status locks, so passive reads wait until they finish. */
  setBusy(busy: boolean) {
    this.busy = busy;
    if (!busy && this.deferred && !this.disposed) { this.deferred = false; void readEnhanceStatus(this, 'passive'); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.readPromise = null;
    this.deferred = false;
    this.lastWrite = ++this.seq;
    this.state = initial;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

const stores = new WeakMap<OwnerScope, EnhanceStore>();
/** The enhancement store of this owner scope; a new scope (logout, UID or epoch change) gets a new, empty one. */
export function enhanceStoreFor(client: AppClient, scope: OwnerScope, config?: PublicConfig): EnhanceStore | null {
  const existing = stores.get(scope);
  if (existing && !existing.disposed) return existing;
  if (scope.signal.aborted) return null;
  const checked = config ? { status: 'ready' as const, value: config } : readConfiguration(import.meta.env);
  if (checked.status !== 'ready') return null;
  try {
    const store = new EnhanceStore(client, checked.value, scope);
    stores.set(scope, store);
    return store;
  } catch { return null; }
}

export const enhanceViewOf = (store: EnhanceStore, state: EnhanceState): EnhanceView =>
  enhanceView(state.read, state.unresolved, state.known, store.consentOn);

function apply(store: EnhanceStore, read: EnhanceRead, since: number) {
  const state = store.get();
  if (read.kind === 'ready') {
    store.consentOn = read.status.consent?.enabled === true;
    store.session.observe(observeEnhanceStatus(read.status, knownEnabled(store.session.memory)), since);
  } else if (read.kind === 'missing') store.session.observe('off', since);
  const settles = read.kind === 'ready' && read.status.consent !== null;
  const unresolved = state.unresolved && !settles;
  store.update({ read, unresolved, known: state.known || enhanceView(read, false, false, store.consentOn).kind !== 'hidden' });
}

/** Same modes as the stylist store: `passive` waits for profile or consent writes, `fresh` postdates the caller. */
export function readEnhanceStatus(store: EnhanceStore, mode: 'passive' | 'active' | 'fresh'): Promise<EnhanceStatus | null> {
  if (store.disposed) return Promise.resolve(null);
  if (mode === 'passive' && (store.busy || store.writePromise)) { store.deferred = true; return Promise.resolve(null); }
  if (store.writePromise) return store.writePromise.then(() => readEnhanceStatus(store, 'active'));
  if (store.readPromise) return mode === 'fresh' ? store.readPromise.then(() => readEnhanceStatus(store, 'active')) : store.readPromise;
  const at = ++store.seq, busyAtStart = store.busy, since = store.session.writes;
  store.update({ reading: true });
  const promise: Promise<EnhanceStatus | null> = store.api.status().then((result) => {
    if (store.disposed) return null;
    if (result.kind === 'ready') store.session.sample(result.sample);
    if (at > store.lastWrite && at > store.applied) {
      store.applied = at;
      apply(store, result.kind === 'missing' ? { kind: 'missing' } : { kind: 'ready', status: result.status }, since);
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
    if (store.deferred && !store.busy && !store.writePromise && !store.disposed) { store.deferred = false; void readEnhanceStatus(store, 'passive'); }
  });
  store.readPromise = promise;
  return promise;
}

const permitted = (store: EnhanceStore, enabled: boolean) => {
  const view = enhanceViewOf(store, store.get());
  return enabled ? view.turnOn : view.turnOff;
};
/** Turns enhancement on or off: one write at a time, after any running read; an unknown outcome is read again. */
export function writeEnhanceConsent(store: EnhanceStore, enabled: boolean): Promise<void> {
  if (store.disposed || store.busy || store.writePromise || !permitted(store, enabled)) return Promise.resolve();
  let release!: () => void;
  store.writePromise = new Promise<void>((resolve) => { release = resolve; });
  return runWrite(store, enabled).finally(() => {
    store.lastWrite = ++store.seq;
    store.writePromise = null;
    store.update({ writing: false });
    release();
    if (store.deferred && !store.busy && !store.disposed) { store.deferred = false; void readEnhanceStatus(store, 'passive'); }
  });
}
async function runWrite(store: EnhanceStore, enabled: boolean): Promise<void> {
  store.update({ writing: true, settingsError: null });
  if (store.readPromise) await store.readPromise;
  if (store.disposed || store.busy || !permitted(store, enabled)) return;
  const at = ++store.seq;
  store.lastWrite = at;
  // A5: any consent-change attempt ends a remembered verified `off`.
  store.session.consentChanging();
  const since = store.session.writes;
  try {
    const result = await store.api.consent(enabled);
    if (store.disposed) return;
    if (result.kind === 'applied') { store.applied = at; apply(store, { kind: 'ready', status: result.status }, since); return; }
    store.update({ settingsError: result.code === 'CONFIG_CHANGED' ? 'enhanceC.changed' : 'enhanceC.failed' });
  } catch {
    if (store.disposed) return;
    store.session.consentChanging();
    store.update({ unresolved: true });
  }
  void readEnhanceStatus(store, 'active');
}
