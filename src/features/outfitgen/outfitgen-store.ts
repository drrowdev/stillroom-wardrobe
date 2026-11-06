// OUTFITGEN1b: suggested-outfit status, consent, suggestions and runs for one owner scope, in memory only. Shared by the
// Settings card, the Outfits section and the automatic triggers through a per-scope registry, so app.tsx holds only the
// small trigger. Reads are single-flight and none overtakes a consent write; an unknown write outcome stays unresolved
// until a later read. There is never a retry: a failed run starts a local cooldown and the server keeps its own.
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { readConfiguration, type PublicConfig } from '../../data/config';
import { OutfitGenClient } from '../../data/outfitgen';
import {
  autoBlock, outfitGenView, outfitGenLimits, shownOutfitGenView, AUTO_SCOPE_CALLS,
  type GenerateReply, type OutfitGenRead, type OutfitGenStatus, type OutfitGenView, type Suggestion,
} from '../../domain/outfitgen-app';
import type { OutfitGenLanguage, OutfitGenMode } from '../../domain/outfitgen';
import type { MessageKey } from '../../i18n';
import '../../i18n/outfitgen';

/** The notice paragraphs, in order, with the shared titles and retention sentence they sit under. Pinned by tests/unit/outfitgen-notice.test.ts. */
export const OUTFITGEN_NOTICE_KEYS = [
  'stylistC.fieldsTitle', 'outfitgenC.sent', 'outfitgenC.when', 'stylistC.processing', 'outfitgenC.processing', 'aiC.retentionTitle',
  'aiC.azureTrainingNotice', 'outfitgenC.stored', 'aiC.chargesTitle', 'outfitgenC.charges', 'outfitgenC.optOut',
] as const satisfies readonly MessageKey[];

export type Notice = { key: MessageKey; count?: number; at: number };
export type OutfitGenState = {
  read: OutfitGenRead; known: boolean; unresolved: boolean; reading: boolean; writing: boolean; settingsError: MessageKey | null;
  list: { kind: 'unknown' | 'failed' | 'ready'; suggestions: readonly Suggestion[] };
  /** Set only while a call to the model is in flight. */
  running: OutfitGenMode | null;
  /** The last manual run's result lines, or a decision's outcome; shown in a live region. */
  notices: readonly Notice[];
  /** Cards with a Keep, Remove or Undo in flight. */
  deciding: ReadonlySet<string>;
  /** The most recent removal, offered for Undo until another action replaces it. */
  removed: Suggestion | null;
};
const initial: OutfitGenState = {
  read: { kind: 'unknown' }, known: false, unresolved: false, reading: false, writing: false, settingsError: null,
  list: { kind: 'unknown', suggestions: [] }, running: null, notices: [], deciding: new Set(), removed: null,
};

export class OutfitGenStore {
  private state: OutfitGenState = initial;
  private readonly listeners = new Set<() => void>();
  api: OutfitGenClient;
  seq = 0;
  applied = 0;
  lastWrite = 0;
  readPromise: Promise<OutfitGenStatus | null> | null = null;
  writePromise: Promise<void> | null = null;
  listPromise: Promise<void> | null = null;
  /** List reads are numbered; a read that began before the last decision (listFloor) is dropped when it lands. */
  listSeq = 0;
  listFloor = 0;
  runController: AbortController | null = null;
  /** True from the start of an automatic run to its end, so triggers never overlap. */
  autoActive = false;
  autoCalls = 0;
  failedAtMs: number | null = null;
  noticeAt = 0;
  disposed = false;
  constructor(client: AppClient, config: PublicConfig, readonly scope: OwnerScope) {
    this.api = new OutfitGenClient(client, config, scope);
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.dispose();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;
  update(patch: Partial<OutfitGenState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  notice(...lines: readonly { key: MessageKey; count?: number }[]) {
    this.update({ notices: lines.map((entry) => ({ ...entry, at: ++this.noticeAt })) });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.runController?.abort();
    this.runController = null;
    this.readPromise = null;
    this.lastWrite = ++this.seq;
    this.state = initial;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

const stores = new WeakMap<OwnerScope, OutfitGenStore>();
/** The suggested-outfits store of this owner scope; a new scope (logout, UID or epoch change) gets a new, empty one. */
export function outfitGenStoreFor(client: AppClient, scope: OwnerScope, config?: PublicConfig): OutfitGenStore | null {
  const existing = stores.get(scope);
  if (existing && !existing.disposed) return existing;
  if (scope.signal.aborted) return null;
  const checked = config ? { status: 'ready' as const, value: config } : readConfiguration(import.meta.env);
  if (checked.status !== 'ready') return null;
  try {
    const store = new OutfitGenStore(client, checked.value, scope);
    stores.set(scope, store);
    return store;
  } catch { return null; }
}

export const viewOf = (state: OutfitGenState): OutfitGenView => outfitGenView(state.read, state.known, state.unresolved);
export const statusOf = (state: OutfitGenState): OutfitGenStatus | null => state.read.kind === 'ready' ? state.read.status : null;

function apply(store: OutfitGenStore, read: OutfitGenRead) {
  const state = store.get();
  const settles = read.kind === 'ready' && read.status.consent !== null;
  store.update({ read, unresolved: state.unresolved && !settles,
    known: state.known || shownOutfitGenView(outfitGenView(read, state.known, false)) });
}

/** Reads status. One read runs at a time; `fresh` waits for a running read and starts a new one, so it postdates the caller. */
export function readStatus(store: OutfitGenStore, mode: 'shared' | 'fresh' = 'shared'): Promise<OutfitGenStatus | null> {
  if (store.disposed) return Promise.resolve(null);
  if (store.writePromise) return store.writePromise.then(() => readStatus(store, mode));
  if (store.readPromise) return mode === 'fresh' ? store.readPromise.then(() => readStatus(store, 'shared')) : store.readPromise;
  const at = ++store.seq;
  store.update({ reading: true });
  const promise: Promise<OutfitGenStatus | null> = store.api.outfitGenStatus().then((result) => {
    if (store.disposed) return null;
    if (at > store.lastWrite && at > store.applied) {
      store.applied = at;
      apply(store, result.kind === 'missing' ? { kind: 'missing' } : { kind: 'ready', status: result.status });
    }
    return result.kind === 'ready' ? result.status : null;
  }, () => {
    if (store.disposed) return null;
    if (at > store.lastWrite && at > store.applied) { store.applied = at; store.update({ read: { kind: 'failed' } }); }
    return null;
  }).finally(() => {
    if (store.readPromise === promise) store.readPromise = null;
    store.update({ reading: false });
  });
  store.readPromise = promise;
  return promise;
}

/**
 * Reads the suggestions; one read at a time, shared. A failure keeps what was shown. A read that began before a decision
 * (Keep, Remove, Undo) is dropped when it lands, so it can't bring a decided card back; `resh waits for a running read and
 * starts another, so its result postdates the caller.
 */
export function readList(store: OutfitGenStore, mode: 'shared' | 'fresh' = 'shared'): Promise<void> {
  if (store.disposed) return Promise.resolve();
  if (store.listPromise) return mode === 'fresh' ? store.listPromise.then(() => readList(store, 'shared')) : store.listPromise;
  const at = ++store.listSeq;
  const promise = store.api.list().then((list) => {
    if (store.disposed || at <= store.listFloor) return;
    if (list.kind === 'ok') store.update({ list: { kind: 'ready', suggestions: list.suggestions } });
    else store.update({ list: { kind: 'failed', suggestions: store.get().list.suggestions } });
  }, () => {
    if (!store.disposed && at > store.listFloor) store.update({ list: { kind: store.get().list.kind === 'ready' ? 'ready' : 'failed', suggestions: store.get().list.suggestions } });
  }).finally(() => { if (store.listPromise === promise) store.listPromise = null; });
  store.listPromise = promise;
  return promise;
}
/** A decision starts or lands: every list read that began before this moment is out of date. */
const invalidateList = (store: OutfitGenStore) => { store.listFloor = ++store.listSeq; };

/** Turns suggested outfits on or off. Writes run one at a time, after a running read; the permission is checked again after it. */
export function writeConsent(store: OutfitGenStore, enabled: boolean): Promise<void> {
  const permitted = () => { const view = viewOf(store.get()); return enabled ? view.turnOn : view.turnOff; };
  if (store.disposed || store.writePromise || !permitted()) return Promise.resolve();
  const run = async () => {
    store.update({ writing: true, settingsError: null });
    if (store.readPromise) await store.readPromise;
    if (store.disposed || !permitted()) return;
    const at = ++store.seq;
    store.lastWrite = at;
    try {
      const result = await store.api.outfitGenConsent(enabled);
      if (store.disposed) return;
      if (result.kind === 'applied') { store.applied = at; apply(store, { kind: 'ready', status: result.status }); return; }
      store.update({ settingsError: result.code === 'CONFIG_CHANGED' ? 'outfitgenC.changed' : 'outfitgenC.failed' });
    } catch {
      if (!store.disposed) store.update({ unresolved: true });
    }
    void readStatus(store, 'fresh');
  };
  const promise: Promise<void> = run().finally(() => {
    store.lastWrite = ++store.seq;
    store.writePromise = null;
    store.update({ writing: false });
  });
  store.writePromise = promise;
  return promise;
}

const online = () => navigator.onLine;
const visible = () => document.visibilityState === 'visible';

/** After a run: the list and the status, both read again. */
async function refreshAfterRun(store: OutfitGenStore) {
  await Promise.all([readList(store, 'fresh'), readStatus(store, 'fresh')]);
}

/**
 * The last check before a run is sent, called by the client right before the POST (after authentication): no consent
 * change pending or unresolved, consent still on and the policy supported, the budget not reached, still online, and for
 * an automatic run the page visible and the trigger not superseded by a newer Save. A reason means nothing is sent.
 */
function dispatchBlock(store: OutfitGenStore, auto: boolean, current: () => boolean): string | null {
  const state = store.get();
  if (store.disposed || store.writePromise !== null || state.writing || state.unresolved) return 'consent-change';
  if (!viewOf(state).run) return 'not-on';
  const status = statusOf(state);
  if (!status || outfitGenLimits(status).reached) return 'limit';
  if (!online() || (auto && !visible())) return 'page';
  if (!current()) return 'superseded';
  return null;
}

/**
 * An automatic run (after a Save, or when the app opens). The status is read first and every call is gated by the
 * policy and by `dispatchBlock` right before it is sent; a consent change in progress, or a newer Save, stops it. The
 * chain goes on only while the server says more is left, at most AUTO_SCOPE_CALLS calls in this scope. Any failure ends
 * it and starts the local cooldown. Nothing here retries, and offline or failed runs say nothing.
 */
export async function runAuto(store: OutfitGenStore, language: OutfitGenLanguage, current: () => boolean = () => true): Promise<void> {
  if (store.disposed || store.autoActive || store.get().running) return;
  store.autoActive = true;
  let ran = false;
  try {
    for (;;) {
      const status = await readStatus(store, 'fresh');
      if (store.disposed || !current() || store.writePromise !== null || store.get().writing) return;
      const block = autoBlock(status, { online: online(), visible: visible(), running: store.get().running !== null, autoCalls: store.autoCalls,
        failedAtMs: store.failedAtMs, nowMs: performance.now() });
      if (block !== null) return;
      store.autoCalls++;
      const controller = store.runController = new AbortController();
      store.update({ running: 'auto' });
      let reply: GenerateReply;
      try { reply = await store.api.generate({ requestId: crypto.randomUUID(), mode: 'auto', language }, controller.signal, () => dispatchBlock(store, true, current)); }
      finally { store.runController = null; store.update({ running: null }); }
      if (store.disposed) return;
      if (reply.code === 'NOT_SENT') { store.autoCalls--; return; }
      ran = true;
      if (reply.code !== 'OK') { if (reply.code !== 'PENDING_FULL') store.failedAtMs = performance.now(); return; }
      if (!reply.remaining || reply.judged === 0 || store.autoCalls >= AUTO_SCOPE_CALLS) return;
    }
  } finally {
    store.autoActive = false;
    if (ran && !store.disposed) void refreshAfterRun(store);
  }
}

/** The result lines of a manual run. */
export function manualNotices(reply: GenerateReply): { key: MessageKey; count?: number }[] {
  if (reply.code === 'OK') {
    const lines: { key: MessageKey; count?: number }[] = [reply.suggested > 0 ? { key: 'outfitgen.found_other', count: reply.suggested } : { key: 'outfitgen.nothingNew' }];
    if (reply.remaining) lines.push({ key: 'outfitgen.more' });
    return lines;
  }
  switch (reply.code) {
    case 'NOT_SENT': return [];
    case 'BUSY': return [{ key: 'outfitgen.busy' }];
    case 'RATE_LIMIT': case 'COOLDOWN': return [{ key: 'outfitgen.rateLimit' }];
    case 'PENDING_FULL': return [{ key: 'outfitgen.full' }];
    case 'ALLOWANCE': return [{ key: 'outfitgenC.limit' }];
    default: return [{ key: 'outfitgen.failed' }];
  }
}
const rereadCodes = new Set(['CONSENT_REQUIRED', 'INACTIVE', 'UNCONFIGURED', 'CONFIG_CHANGED', 'UNAVAILABLE', 'ALLOWANCE']);

/**
 * One manual run per tap: never while another runs or a consent change is pending, offline, without consent or over the
 * limit. It takes a fresh status first, and the client checks again right before the request is sent.
 */
export async function runManual(store: OutfitGenStore, language: OutfitGenLanguage): Promise<void> {
  const state = store.get();
  if (store.disposed || store.autoActive || state.running || state.writing || !viewOf(state).run) return;
  if (!online()) { store.notice({ key: 'outfitgen.failed' }); return; }
  store.update({ running: 'manual', notices: [] });
  let reply: GenerateReply | null = null;
  const gate: { status: OutfitGenStatus | null } = { status: null };
  try {
    const status = gate.status = await readStatus(store, 'fresh');
    if (store.disposed) return;
    const now = store.get();
    if (status && viewOf(now).run && !now.writing && !outfitGenLimits(status).reached) {
      const controller = store.runController = new AbortController();
      try { reply = await store.api.generate({ requestId: crypto.randomUUID(), mode: 'manual', language }, controller.signal, () => dispatchBlock(store, false, () => true)); }
      finally { store.runController = null; }
    }
  } finally { if (!store.disposed) store.update({ running: null }); }
  if (store.disposed) return;
  if (reply === null) {
    const now = store.get();
    const status = gate.status;
    store.notice(status === null ? { key: 'outfitgen.failed' } : status && outfitGenLimits(status).reached ? { key: 'outfitgenC.limit' } : viewOf(now).run ? { key: 'outfitgen.failed' } : { key: 'outfitgen.off' });
    return;
  }
  store.notice(...manualNotices(reply));
  if (reply.code === 'OK' || rereadCodes.has(reply.code)) void refreshAfterRun(store);
}

type Decision = { code: 'OK' | 'GONE' | 'RETRY' };
const mark = (store: OutfitGenStore, id: string, on: boolean) => {
  const deciding = new Set(store.get().deciding);
  if (on) deciding.add(id); else deciding.delete(id);
  store.update({ deciding });
};
const without = (store: OutfitGenStore, id: string) => store.get().list.suggestions.filter((entry) => entry.id !== id);

/** Keep creates the normal outfit through the server. STALE, IN_TRASH and CONFLICT drop the card with a plain line. */
export async function keepSuggestion(store: OutfitGenStore, id: string): Promise<Decision> {
  const card = store.get().list.suggestions.find((entry) => entry.id === id);
  if (store.disposed || !card || store.get().deciding.has(id)) return { code: 'RETRY' };
  mark(store, id, true);
  invalidateList(store);
  try {
    const reply = await store.api.keep(id, crypto.randomUUID());
    if (store.disposed) return { code: 'RETRY' };
    invalidateList(store);
    const drop = (key: MessageKey): Decision => {
      store.update({ list: { kind: 'ready', suggestions: without(store, id) } }); store.notice({ key }); void readList(store, 'fresh'); return { code: 'GONE' };
    };
    if (reply.code === 'OK') {
      store.update({ list: { kind: 'ready', suggestions: without(store, id) }, removed: null }); store.notice({ key: 'outfitgen.kept' });
      void readList(store, 'fresh');
      return { code: 'OK' };
    }
    if (reply.code === 'STALE') return drop('outfitgen.stale');
    if (reply.code === 'IN_TRASH') return drop('outfitgen.inTrash');
    if (reply.code === 'CONFLICT' || reply.code === 'NOT_FOUND') return drop('outfitgen.conflict');
    store.notice({ key: reply.code === 'BUSY' ? 'outfitgen.decideBusy' : 'outfitgen.decideFailed' });
    return { code: 'RETRY' };
  } catch {
    if (!store.disposed) store.notice({ key: 'outfitgen.decideFailed' });
    return { code: 'RETRY' };
  } finally { mark(store, id, false); }
}

/** Remove hides the suggestion for good (and marks the set as not wanted in Today); the card stays offered for Undo. */
export async function removeSuggestion(store: OutfitGenStore, id: string): Promise<void> {
  const card = store.get().list.suggestions.find((entry) => entry.id === id);
  if (store.disposed || !card || store.get().deciding.has(id)) return;
  mark(store, id, true);
  invalidateList(store);
  try {
    const reply = await store.api.remove(id);
    if (store.disposed) return;
    invalidateList(store);
    if (reply.code === 'OK') {
      store.update({ list: { kind: 'ready', suggestions: without(store, id) }, removed: card }); store.notice({ key: 'outfitgen.removed' });
      void readList(store, 'fresh');
      return;
    }
    if (reply.code === 'CONFLICT' || reply.code === 'NOT_FOUND') {
      store.update({ list: { kind: 'ready', suggestions: without(store, id) } }); store.notice({ key: 'outfitgen.conflict' }); void readList(store, 'fresh'); return;
    }
    store.notice({ key: reply.code === 'BUSY' ? 'outfitgen.decideBusy' : 'outfitgen.decideFailed' });
  } catch {
    if (!store.disposed) store.notice({ key: 'outfitgen.decideFailed' });
  } finally { mark(store, id, false); }
}

/** Undo puts the suggestion back only while nothing else changed that set's vote in Today and the list has room; the server decides. */
export async function undoRemoval(store: OutfitGenStore): Promise<void> {
  const card = store.get().removed;
  if (store.disposed || !card || store.get().deciding.has(card.id)) return;
  mark(store, card.id, true);
  invalidateList(store);
  try {
    const reply = await store.api.undoRemove(card.id);
    if (store.disposed) return;
    invalidateList(store);
    if (reply.code === 'OK') { store.update({ removed: null }); store.notice({ key: 'outfitgen.restored' }); void readList(store, 'fresh'); return; }
    if (reply.code === 'CONFLICT') { store.update({ removed: null }); store.notice({ key: 'outfitgen.undoConflict' }); return; }
    if (reply.code === 'NOT_FOUND') { store.update({ removed: null }); return; }
    // A full list keeps the removal offered, so Undo can be tried again once there is room.
    if (reply.code === 'PENDING_FULL') store.notice({ key: 'outfitgen.full' }, { key: 'outfitgen.removed' });
    else store.notice({ key: reply.code === 'BUSY' ? 'outfitgen.decideBusy' : 'outfitgen.decideFailed' });
  } catch {
    if (!store.disposed) store.notice({ key: 'outfitgen.decideFailed' });
  } finally { mark(store, card.id, false); }
}