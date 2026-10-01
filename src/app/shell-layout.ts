import { useSyncExternalStore } from 'react';

/** The phone layout's width limit. The same value is the tab bar's media query in app.css. */
export const NARROW_MAX_WIDTH = 650;
const narrowQuery = `(max-width: ${NARROW_MAX_WIDTH}px)`;
function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(narrowQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const readNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia(narrowQuery).matches;
export function useNarrow() {
  return useSyncExternalStore(subscribeNarrow, readNarrow);
}

/** The routes reached through the account menu or More; on a phone the More tab shows them as current. */
export type MenuPage = 'statistics' | 'settings' | 'trash' | 'admin' | null;
export function menuPageFor(route: string): MenuPage {
  return route === 'statistics' || route === 'settings' || route === 'trash' || route === 'admin' ? route : null;
}
