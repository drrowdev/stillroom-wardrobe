/**
 * The remembered session's Web Lock. Only the tab holding it reads, writes, refreshes or removes the localStorage
 * slot; every other window waits on the same lock.
 */
export const lockName = 'stillroom.remembered';
export type HeldLock = { release(): void };

export const hasLocks = (): boolean => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

/**
 * Takes the lock. Without `wait` it resolves null when another tab holds it; with `wait` it queues until granted or
 * `signal` aborts. It rejects when the API is missing or refuses the request.
 */
export function acquireLock(wait: boolean, signal?: AbortSignal): Promise<HeldLock | null> {
  if (!hasLocks()) return Promise.reject(new Error('Web Locks unavailable.'));
  return new Promise((resolve, reject) => {
    navigator.locks.request(lockName, wait ? { mode: 'exclusive', signal } : { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise<void>((release) => { resolve({ release: () => release() }); });
    }).catch(reject);
  });
}
