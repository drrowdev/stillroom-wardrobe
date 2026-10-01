// Keeps the phone tab bar's rendered height in --tab-bar-height (0px in the desktop layout; while typing it is only
// made invisible and keeps its height), which the page uses as its
// bottom scroll padding so focused or scrolled-to content never sits under the bar. It also switches the bar to its
// reflow layout, whole labels beside their icons on wrapping rows, whenever a label word is wider than its column.
export function fitTabBar(bar: HTMLElement | null): (() => void) | undefined {
  if (!bar) return undefined;
  const root = document.documentElement;
  const check = () => {
    const shown = getComputedStyle(bar).display !== 'none';
    if (shown) {
      delete bar.dataset.reflow;
      bar.dataset.measured = '';
      const labels = [...bar.querySelectorAll<HTMLElement>('.tab-label')];
      // In the one-row layout a label wraps only between words, so a word too wide for its column overflows the label.
      // Measured from the text itself, since the label clips that overflow (shell.css).
      const range = document.createRange();
      const wide = (label: HTMLElement) => { range.selectNodeContents(label); return range.getBoundingClientRect().width > label.clientWidth + 0.5; };
      if (labels.some(wide)) bar.dataset.reflow = '';
    }
    root.style.setProperty('--tab-bar-height', `${shown ? bar.getBoundingClientRect().height : 0}px`);
    if (shown) clear();
  };
  // Keeps the focused control clear of the bar. WebKit ignores scroll-padding when it scrolls a newly focused control
  // into view, the bar comes back a moment after a text field loses focus, and a reflow can make it taller; after each,
  // move the page just enough to bring the control above the bar.
  let focusFrame = 0;
  const clear = () => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || target === document.body || bar.contains(target) || target.closest('dialog')) return;
    const style = getComputedStyle(bar);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const top = bar.getBoundingClientRect().top, box = target.getBoundingClientRect();
    if (box.bottom > top && box.height < top) window.scrollBy(0, Math.ceil(box.bottom - top) + 8);
  };
  const reveal = () => { cancelAnimationFrame(focusFrame); focusFrame = requestAnimationFrame(clear); };
  document.addEventListener('focusin', reveal);
  // The delayed visibility transition ends when the bar is back on screen.
  bar.addEventListener('transitionend', reveal);
  check();
  if (typeof ResizeObserver !== 'function') {
    return () => {
      cancelAnimationFrame(focusFrame); document.removeEventListener('focusin', reveal); bar.removeEventListener('transitionend', reveal);
      root.style.setProperty('--tab-bar-height', '0px');
    };
  }
  let frame = 0;
  // Deferred to the next frame so a layout change caused by the check itself never loops the observer.
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); });
  observer.observe(bar);
  for (const label of bar.querySelectorAll('.tab-label')) observer.observe(label);
  return () => {
    cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); observer.disconnect(); document.removeEventListener('focusin', reveal);
    bar.removeEventListener('transitionend', reveal);
    root.style.setProperty('--tab-bar-height', '0px');
  };
}
