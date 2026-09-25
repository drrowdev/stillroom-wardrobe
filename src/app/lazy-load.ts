import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super('Chunk load failed.', { cause });
    this.name = 'ChunkLoadError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy accepts any component props.
type AnyComponent = ComponentType<any>;
type Preloadable<T extends AnyComponent> = LazyExoticComponent<T> & { preload: () => Promise<unknown> };

const loaders: (() => Promise<unknown>)[] = [];

export function lazyNamed<M extends Record<K, AnyComponent>, K extends keyof M>(load: () => Promise<M>, name: K): Preloadable<M[K]> {
  let pending: Promise<M> | null = null;
  let loaded: M | null = null;
  const fetch = () => pending ??= load().then(
    (module) => { loaded = module; return module; },
    (error: unknown) => { pending = null; throw new ChunkLoadError(error); },
  );
  loaders.push(fetch);
  // Once the code is here, resolve synchronously so React renders the page without a loading state.
  // A failed download stays failed until the page is reloaded; the error state offers Reload.
  const component = lazy(() => loaded
    ? { then: (resolve: (value: { default: M[K] }) => void) => { resolve({ default: loaded![name] }); } } as unknown as Promise<{ default: M[K] }>
    : fetch().then((module) => ({ default: module[name] })));
  return Object.assign(component, { preload: fetch });
}

export function preloadable<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  const fetch = () => pending ??= load().catch((error: unknown) => { pending = null; throw new ChunkLoadError(error); });
  loaders.push(fetch);
  return fetch;
}

export const preloadDelayMs = 1500;

// Fetch every page's code after the workspace has loaded and the browser is idle, so later navigation also works offline.
// Chunks load one at a time and stop when the page is left, so preloading never competes with startup, a reload or navigation.
// The performance marks let tests see when the delay starts and when every page's code is in memory.
export function preloadChunks(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const run = async () => {
    let complete = true;
    for (const load of loaders) {
      if (stopped) return;
      try { await load(); } catch { complete = false; }
    }
    if (complete && !stopped) performance.mark('chunks-preloaded');
  };
  const whenIdle = () => {
    if (stopped) return;
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => { void run(); }, { timeout: 5000 });
    else void run();
  };
  const begin = () => {
    performance.mark('chunks-preload-armed');
    timer = setTimeout(whenIdle, preloadDelayMs);
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    removeEventListener('load', begin);
    removeEventListener('pagehide', stop);
  };
  addEventListener('pagehide', stop);
  if (document.readyState === 'complete') begin(); else addEventListener('load', begin, { once: true });
  return stop;
}