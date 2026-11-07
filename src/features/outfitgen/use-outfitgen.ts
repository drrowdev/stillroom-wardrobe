import { useEffect, useSyncExternalStore } from 'react';
import { readStatus, viewOf, type OutfitGenState, type OutfitGenStore } from './outfitgen-store';

export function useOutfitGen(store: OutfitGenStore) {
  return useSyncExternalStore(store.subscribe, store.get);
}
/** Reads status on arrival and on focus, visibility and reconnect while a suggested-outfits surface is shown. Reads never write. */
export function useOutfitGenStatus(store: OutfitGenStore) {
  useEffect(() => {
    void readStatus(store);
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void readStatus(store); };
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

const none = { subscribe: () => () => undefined, get: (): OutfitGenState | null => null };
/** Whether suggested outfits are on, which is also what makes the automatic pictures use the saved photo. */
export function usePicturesOn(store: OutfitGenStore | null): boolean {
  const state = useSyncExternalStore<OutfitGenState | null>(store?.subscribe ?? none.subscribe, store?.get ?? none.get);
  return state !== null && viewOf(state).kind === 'on';
}
