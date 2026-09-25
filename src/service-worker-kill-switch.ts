import { shellCachePrefix } from './pwa/shell-policy';

// Emergency replacement for the shell worker, built with STILLROOM_SW_KILL_SWITCH=1 and deployed as
// /service-worker.js. It takes over even with tabs open, deletes only Stillroom shell caches and
// unregisters itself. Code already loaded in an open tab keeps running until that tab reloads.
type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type WorkerScope = {
  clients: { claim(): Promise<void> };
  registration: { unregister(): Promise<boolean> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
};
const worker = self as unknown as WorkerScope;

worker.addEventListener('install', (event) => { event.waitUntil(worker.skipWaiting()); });
worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await worker.clients.claim();
    for (const name of await caches.keys()) {
      if (name.startsWith(shellCachePrefix)) await caches.delete(name);
    }
    await worker.registration.unregister();
  })());
});
