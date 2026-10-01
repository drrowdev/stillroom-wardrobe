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
