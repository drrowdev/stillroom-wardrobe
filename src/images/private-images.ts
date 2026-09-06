import type { AppClient } from '../data/client';
import type { OwnerScope } from '../auth/session';
import { AppError, requireSuccess, throwIfAborted } from '../data/errors';

export class PrivateImages {
  private active = 0;
  private queue: Array<() => void> = [];
  private pending = new Map<string, Promise<string>>();
  private urls = new Set<string>();
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
    if (existing) return existing;
    const promise = new Promise<string>((resolve, reject) => {
      this.queue.push(() => {
        this.active++;
        void this.download(path).then(resolve, reject).finally(() => { this.active--; this.flush(); });
      });
      this.flush();
    }).catch((error: unknown) => { this.pending.delete(path); throw error; });
    this.pending.set(path, promise);
    return promise;
  }
  private async download(path: string): Promise<string> {
    throwIfAborted(this.scope.signal);
    const lifecycle = this.controller.signal;
    throwIfAborted(lifecycle);
    const signal = AbortSignal.any([this.scope.signal, lifecycle]);
    const { data, error } = await this.client.storage.from('wardrobe').download(path, {}, { signal, cache: 'no-store' });
    throwIfAborted(this.scope.signal);
    throwIfAborted(lifecycle);
    requireSuccess(error);
    if (!data || data.type !== 'image/jpeg') throw new AppError('photo.missing');
    const url = URL.createObjectURL(data);
    this.urls.add(url);
    return url;
  }
  private flush(): void {
    while (this.active < 4 && this.queue.length) this.queue.shift()!();
  }
  clear = (): void => {
    this.disposed = true;
    this.controller.abort();
    this.scope.signal.removeEventListener('abort', this.clear);
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
    this.flush();
  };
}
