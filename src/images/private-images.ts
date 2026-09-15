import type { AppClient } from '../data/client';
import type { OwnerScope } from '../auth/session';
import { AppError, requireSuccess, throwIfAborted } from '../data/errors';

export class PrivateImages {
  private active = 0;
  private queue: Array<() => void> = [];
  private pending = new Map<string, { promise: Promise<string>; controller: AbortController; url: string | null }>();
  private listeners = new Set<(paths: readonly string[]) => void>();
  private disposed = false;
  private controller = new AbortController();
  constructor(private client: AppClient, private scope: OwnerScope) {
    scope.signal.addEventListener('abort', this.clear, { once: true });
  }
  activate(): void {
    if (this.disposed && !this.scope.signal.aborted) {
      this.disposed = false;
      this.controller = new AbortController();
      this.scope.signal.addEventListener('abort', this.clear, { once: true });
    }
  }
  get(path: string): Promise<string> {
    if (this.disposed) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    throwIfAborted(this.scope.signal);
    if (!path.startsWith(`${this.scope.ownerId}/`) || !/^[0-9a-f/-]+\/(?:main|thumb)\.jpg$/i.test(path)) {
      throw new AppError('photo.missing');
    }
    const existing = this.pending.get(path);
    if (existing) return existing.promise;
    const lifecycle = this.controller.signal;
    const controller = new AbortController();
    const entry = { promise: Promise.resolve(''), controller, url: null as string | null };
    const promise = new Promise<string>((resolve, reject) => {
      this.queue.push(() => {
        if (controller.signal.aborted || lifecycle.aborted || this.disposed || this.pending.get(path) !== entry) {
          reject(new DOMException('Cancelled', 'AbortError'));
          return;
        }
        this.active++;
        void this.download(path, lifecycle, entry).then(resolve, reject).finally(() => { this.active--; this.flush(); });
      });
    }).catch((error: unknown) => { if (this.pending.get(path) === entry) this.pending.delete(path); throw error; });
    entry.promise = promise;
    this.pending.set(path, entry);
    this.flush();
    return promise;
  }
  private async download(path: string, lifecycle: AbortSignal, entry: { controller: AbortController; url: string | null }): Promise<string> {
    throwIfAborted(this.scope.signal);
    throwIfAborted(lifecycle);
    throwIfAborted(entry.controller.signal);
    const signal = AbortSignal.any([this.scope.signal, lifecycle, entry.controller.signal]);
    const { data, error } = await this.client.storage.from('wardrobe').download(path, {}, { signal, cache: 'no-store' });
    throwIfAborted(this.scope.signal);
    throwIfAborted(lifecycle);
    throwIfAborted(entry.controller.signal);
    if (this.pending.get(path) !== entry) throw new DOMException('Cancelled', 'AbortError');
    requireSuccess(error);
    if (!data || data.type !== 'image/jpeg') throw new AppError('photo.missing');
    const url = URL.createObjectURL(data);
    entry.url = url;
    return url;
  }
  subscribe(listener: (paths: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  invalidate(paths: readonly string[]): void {
    for (const path of paths) {
      const entry = this.pending.get(path);
      if (!entry) continue;
      entry.controller.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
      this.pending.delete(path);
    }
    for (const listener of this.listeners) listener(paths);
    this.flush();
  }
  private flush(): void {
    while (this.active < 4 && this.queue.length) this.queue.shift()!();
  }
  clear = (): void => {
    this.disposed = true;
    this.controller.abort();
    this.scope.signal.removeEventListener('abort', this.clear);
    this.invalidate([...this.pending.keys()]);
    this.flush();
  };
}
