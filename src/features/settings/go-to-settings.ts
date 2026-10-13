/** Scrolls to a settings block and focuses its heading, as the section menu does. */
export function goToSettings(id: string) {
  const target = document.getElementById(id);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  target?.focus({ preventScroll: true });
}
