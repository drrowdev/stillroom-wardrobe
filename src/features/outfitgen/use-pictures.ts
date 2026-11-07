import { useSyncExternalStore } from 'react';
import type { PictureQueue, PictureState } from './picture-queue';

const none = { subscribe: () => () => undefined, get: (): PictureState | null => null };
/** The picture queue's state for this scope, or `null` without a queue. */
export function usePictureQueue(queue: PictureQueue | null): PictureState | null {
  return useSyncExternalStore<PictureState | null>(queue?.subscribe ?? none.subscribe, queue?.get ?? none.get);
}
