/**
 * The remembered session's Web Lock. Only the window holding it reads, writes, refreshes or removes the localStorage
 * slot; every other window signs in per tab.
 */
export const lockName = 'stillroom.remembered';
export type HeldLock = { release(): void };

export const hasLocks = (): boolean => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

// This page's last let-go lock: until the manager has really freed it, a new request would find it busy.
let releasing: Promise<unknown> = Promise.resolve();

/** Takes the lock only if it is free right now. Busy, missing or refused all resolve null; nothing ever waits. */
export function acquireLock(): Promise<HeldLock | null> {
  if (!hasLocks()) return Promise.resolve(null);
  return releasing.then(() => new Promise((resolve) => {
    const request = navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise<void>((release) => {
        resolve({ release: () => { releasing = request.catch(() => undefined); release(); } });
      });
    });
    request.catch(() => resolve(null));
  }));
}
