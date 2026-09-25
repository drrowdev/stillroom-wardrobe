import { useSyncExternalStore } from 'react';

// Must match workerPath in shell-policy.ts (checked by a unit test). Imported values would pull the
// policy module into a chunk shared with the worker, which must stay a single classic script.
const workerUrl = '/service-worker.js';
const updateInterval = 30 * 60 * 1000;

type Snapshot = { waiting: boolean; reloading: boolean };
let snapshot: Snapshot = { waiting: false, reloading: false };
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
function watch(current: ServiceWorkerRegistration) {
  const check = () => {
    if (current.waiting && navigator.serviceWorker.controller) publish({ ...snapshot, waiting: true });
  };
  check();
  current.addEventListener('updatefound', () => {
    const installing = current.installing;
    installing?.addEventListener('statechange', () => { if (installing.state === 'installed') check(); });
  });
}

// The shell worker exists only in production builds, on secure origins. A kill-switch build instead
// removes any existing registration and registers nothing.
export function startShellWorker(enabled: boolean) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (!enabled) {
    void navigator.serviceWorker.getRegistrations().then((all) => Promise.all(all.map((entry) => entry.unregister()))).catch(() => undefined);
    return;
  }
  let lastCheck = Date.now();
  // A controller change on a page that already had one means another tab activated a newer version.
  // This tab keeps its current code and unsaved input and offers a reload instead.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (snapshot.reloading) window.location.reload();
    else if (controlled) publish({ ...snapshot, waiting: true });
    controlled = true;
  });
  navigator.serviceWorker.register(workerUrl, { scope: '/', updateViaCache: 'none' }).then((current) => {
    registration = current;
    watch(current);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < updateInterval) return;
      lastCheck = Date.now();
      void current.update().catch(() => undefined);
    });
  }).catch(() => undefined);
}

// Activates the waiting version only when the user asks, then reloads this tab into it. When another
// tab has already activated the new version, this tab only needs to reload.
export function applyUpdate() {
  if (snapshot.reloading) return;
  publish({ ...snapshot, reloading: true });
  const waiting = registration?.waiting;
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useShellUpdate = () => useSyncExternalStore(subscribe, () => snapshot);
