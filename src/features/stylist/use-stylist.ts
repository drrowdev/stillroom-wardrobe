import { useEffect, useSyncExternalStore } from 'react';
import { StylistClient } from '../../data/stylist';
import {
  allowanceKey, normaliseMessage, messageOver, sendFailure, shownStylistView, stylistLimits, stylistRequest, stylistView,
  type StylistRead, type StylistStatus, type StylistView,
} from '../../domain/stylist-controls';
import type { StylistSeason, StylistWeather } from '../../domain/stylist';
import type { StylistEntry, StylistState, StylistStore } from './stylist-store';

function api(store: StylistStore): StylistClient {
  return store.api ??= new StylistClient(store.client, store.config, store.scope);
}
export const viewOf = (state: StylistState): StylistView => stylistView(state.read, state.known, state.unresolved);
export const statusOf = (state: StylistState): StylistStatus | null => state.read.kind === 'ready' ? state.read.status : null;

function apply(store: StylistStore, read: StylistRead) {
  const state = store.get();
  // Only a status that carries the consent state settles an unknown consent change.
  const settles = read.kind === 'ready' && read.status.consent !== null;
  store.update({ read, unresolved: state.unresolved && !settles, known: state.known || shownStylistView(stylistView(read, state.known, false)) });
}

/**
 * Reads status. One read runs at a time and callers share it. `passive` reads (arrival, focus, reconnect) wait while
 * the profile row is being written or consent is changing, then run once. A read that is already running when a
 * profile write starts is left to finish; if it fails meanwhile it may have hit that write's lock, so it is not shown
 * and is read again afterwards. A read's result is applied only if no consent write began after it and no newer read
 * was applied. `fresh` waits for any running read and starts a new one, so its result postdates the caller's event.
 * While consent is changing no read starts: passive reads are deferred, and active or fresh reads wait for the write to
 * finish and then read. A write's completion also invalidates every read that began before it.
 */
export function readStatus(store: StylistStore, mode: 'passive' | 'active' | 'fresh'): Promise<StylistStatus | null> {
  if (store.disposed) return Promise.resolve(null);
  store.onIdle ??= () => { void readStatus(store, 'passive'); };
  if (mode === 'passive' && (store.busy || store.writePromise)) { store.deferred = true; return Promise.resolve(null); }
  if (store.writePromise) return store.writePromise.then(() => readStatus(store, 'active'));
  if (store.readPromise) return mode === 'fresh' ? store.readPromise.then(() => readStatus(store, 'active')) : store.readPromise;
  const at = ++store.seq, busyAtStart = store.busy, client = api(store);
  store.update({ reading: true });
  const promise: Promise<StylistStatus | null> = client.stylistStatus().then((result) => {
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
    if (store.deferred && !store.busy && !store.writePromise && !store.disposed) { store.deferred = false; void readStatus(store, 'passive'); }
  });
  store.readPromise = promise;
  return promise;
}

/**
 * Turns stylist use on or off. Writes run one at a time, after any running read has settled, and supersede every read
 * that began before they finished. The permission is checked again after that read, so a status that changed meanwhile
 * (for example to an unsupported policy) stops the write. An applied write returns the new status itself; after a
 * refusal or an unknown outcome status is read again, and an unknown outcome stays unresolved until a later read
 * returns the consent state.
 */
const permitted = (store: StylistStore, enabled: boolean) => {
  const view = viewOf(store.get());
  return enabled ? view.turnOn : view.turnOff;
};
export function writeConsent(store: StylistStore, enabled: boolean): Promise<void> {
  if (store.disposed || store.busy || store.writePromise || !permitted(store, enabled)) return Promise.resolve();
  let release!: () => void;
  store.writePromise = new Promise<void>((resolve) => { release = resolve; });
  return runWrite(store, enabled).finally(() => {
    store.lastWrite = ++store.seq;
    store.writePromise = null;
    store.update({ writing: false });
    release();
    if (store.deferred && !store.busy && !store.disposed) { store.deferred = false; void readStatus(store, 'passive'); }
  });
}
async function runWrite(store: StylistStore, enabled: boolean): Promise<void> {
  const client = api(store);
  store.update({ writing: true, settingsError: null });
  if (store.readPromise) await store.readPromise;
  if (store.disposed || store.busy || !permitted(store, enabled)) return;
  const at = ++store.seq;
  store.lastWrite = at;
  try {
    const result = await client.stylistConsent(enabled);
    if (store.disposed) return;
    if (result.kind === 'applied') { store.applied = at; apply(store, { kind: 'ready', status: result.status }); return; }
    store.update({ settingsError: result.code === 'CONFIG_CHANGED' ? 'stylistC.changed' : 'stylistC.failed' });
  } catch {
    if (!store.disposed) store.update({ unresolved: true });
  }
  // This read waits for the write to finish, so its result postdates it.
  void readStatus(store, 'active');
}

export type SendContext = { online: boolean; season: StylistSeason | null; weather: StylistWeather | null };
const rereadCodes = new Set(['CONSENT_REQUIRED', 'INACTIVE', 'UNCONFIGURED', 'CONFIG_CHANGED', 'UNAVAILABLE', 'FAILED', 'TERMINAL']);
/** Can a message be sent now, as far as the last status shows. Not while consent is changing. */
export function canSend(state: StylistState): boolean {
  const status = statusOf(state);
  if (state.writing || !viewOf(state).send || !status) return false;
  const limits = stylistLimits(status);
  return !limits.own && !limits.shared;
}

/**
 * Sends the typed message as a new request. One message is in flight per scope. A reply is shown only if the
 * conversation hasn't been cleared and the scope is unchanged since it was sent; a failure puts the message back.
 */
export async function send(store: StylistStore, context: SendContext): Promise<void> {
  const state = store.get();
  if (store.disposed || store.inflight || state.pending !== null || !canSend(state)) return;
  const message = normaliseMessage(state.draft);
  if (!message) return;
  const over = messageOver(message);
  if (over > 0) { store.update({ error: { key: 'stylist.tooLong', retry: false, count: over } }); return; }
  if (!context.online) { store.update({ error: sendFailure('OFFLINE') }); return; }
  const body = stylistRequest(state.turns, { requestId: crypto.randomUUID(), message, occasion: state.occasion,
    season: context.season, weather: context.weather });
  if (!body) { store.update({ error: sendFailure('INVALID_INPUT') }); return; }
  const client = api(store), token = ++store.token, controller = new AbortController(), generation = state.generation;
  store.inflight = { token, controller };
  store.update({ pending: message, draft: '', error: null, announce: { key: 'stylist.sending', at: token } });
  let answer;
  try { answer = await client.chat(body, controller.signal); }
  finally { if (store.inflight?.token === token) store.inflight = null; }
  if (store.disposed || store.get().generation !== generation) return;
  if (answer.code === 'OK') {
    const turns: StylistEntry[] = [...store.get().turns, { id: ++store.nextId, role: 'user', text: message },
      { id: ++store.nextId, role: 'assistant', text: answer.reply, outfits: answer.outfits, occasion: body.occasion ?? state.occasion,
        season: body.season, weather: body.weather }];
    store.update({ turns, pending: null, announce: { key: 'stylist.replied', at: token } });
    return;
  }
  const back = () => ({ pending: null, draft: store.get().draft === '' ? message : store.get().draft, announce: null });
  if (answer.code === 'ALLOWANCE') {
    store.update(back());
    const fresh = await readStatus(store, 'fresh');
    if (store.disposed || store.get().generation !== generation) return;
    const key = allowanceKey(fresh);
    store.update({ error: { key, retry: key === 'stylist.failed' } });
    return;
  }
  store.update({ ...back(), error: sendFailure(answer.code) });
  if (rereadCodes.has(answer.code)) void readStatus(store, 'active');
}

/** Empties the conversation. A reply still on its way is dropped when it arrives; the server may still charge for it. */
export function clear(store: StylistStore) {
  const state = store.get();
  store.inflight?.controller.abort();
  store.inflight = null;
  store.update({ generation: state.generation + 1, turns: [], pending: null, draft: '', error: null,
    announce: { key: 'stylist.cleared', at: ++store.token } });
}

export function useStylist(store: StylistStore): StylistState {
  return useSyncExternalStore(store.subscribe, store.get);
}
/** Reads status on arrival and on focus, visibility and reconnect while a stylist surface is shown. Reads never write. */
export function useStylistStatus(store: StylistStore) {
  useEffect(() => {
    void readStatus(store, 'passive');
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void readStatus(store, 'passive'); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [store]);
}
