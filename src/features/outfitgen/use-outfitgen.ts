import { useEffect, useSyncExternalStore } from 'react';
import { readStatus, type OutfitGenStore } from './outfitgen-store';

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
