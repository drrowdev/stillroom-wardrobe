import { useSyncExternalStore } from 'react';
import { preloadable } from './lazy-load';

// One download for the whole navigation: the module and its stylesheet. The header and the tab bar both render from this
// single result, so the plain links and the loaded navigation never show together, and the navigation never shows
// unstyled. (Separate import() calls would not share the stylesheet wait: only the first one waits for it.)
type ShellModule = typeof import('./shell-nav');
export type Shell = { status: 'loading' | 'failed'; module?: undefined } | { status: 'ready'; module: ShellModule };
let shell: Shell = { status: 'loading' };
let started = false;
const listeners = new Set<() => void>();
const publish = (next: Shell) => { shell = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Also fetched by the idle preloader (lazy-load.ts) like the pages, so the navigation works offline and after a deploy.
// A retry is a new import() that would not wait for the stylesheet again, so the check below is what guarantees it.
const fetchShell = preloadable(() => import('./shell-nav').then((module) => {
  // shell.css sets this property, so a missing stylesheet counts as a failed download.
  if (getComputedStyle(document.documentElement).getPropertyValue('--shell-loaded').trim() !== '1') throw new Error('Navigation styles missing.');
  return module;
}));

/** Shows the navigation once it has loaded, or the failed state. Once shown, a failure stays until Reload. */
export function loadShell() {
  if (started) return;
  started = true;
  fetchShell().then((module) => { publish({ status: 'ready', module }); }, () => { publish({ status: 'failed' }); });
}
export const failShell = () => { if (shell.status !== 'failed') publish({ status: 'failed' }); };
export const useShell = () => useSyncExternalStore(subscribe, () => shell);

// Hands focus from the plain fallback links (shell-fallback.tsx) to the loaded navigation (shell-nav.tsx).
let handoff: { key: string; at: number } | null = null;
const visible = (element: HTMLElement | null): element is HTMLElement =>
  element !== null && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

/**
 * When the plain links are replaced while one of them has focus, focus goes to the same destination in the new
 * controls, or to the account menu or More if that destination is inside it. Only right after the swap, and only if
 * focus has not gone anywhere else meanwhile.
 */
export function restoreShellFocus() {
  if (!handoff) return;
  const active = document.activeElement;
  if (performance.now() - handoff.at > 1000 || (active && active !== document.body)) { handoff = null; return; }
  const key = handoff.key;
  // Keys are the fallback's own fixed hrefs and 'sign-out'.
  const match = [...document.querySelectorAll<HTMLElement>(`.top-nav a[href="${key}"], .tab-bar a[href="${key}"], [data-shell-key="${key}"]`)].find(visible);
  const trigger = document.getElementById('account-trigger');
  const target = match ?? (visible(trigger) ? trigger : undefined);
  // On a phone the More button arrives with the tab bar, which may commit a moment after the header.
  if (!target) return;
  handoff = null;
  target.focus();
}

/** Records the fallback control that had focus as it leaves the page. */
export function leaveShellFocus(key: string) {
  handoff = { key, at: performance.now() };
}
