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
      if (labels.some(label => label.scrollWidth > label.clientWidth + 0.5)) bar.dataset.reflow = '';
    }
    root.style.setProperty('--tab-bar-height', `${shown ? bar.getBoundingClientRect().height : 0}px`);
  };
  // WebKit ignores scroll-padding when it scrolls a newly focused control into view, so a control can land under the
  // bar. After the browser's own scroll, move the page just enough to bring it clear.
  let focusFrame = 0;
  const reveal = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || bar.contains(target) || target.closest('dialog')) return;
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      const style = getComputedStyle(bar);
      if (style.display === 'none' || style.visibility === 'hidden' || document.activeElement !== target) return;
      const top = bar.getBoundingClientRect().top, box = target.getBoundingClientRect();
      if (box.bottom > top && box.height < top) window.scrollBy(0, Math.ceil(box.bottom - top) + 8);
    });
  };
  document.addEventListener('focusin', reveal);
  check();
  if (typeof ResizeObserver !== 'function') {
    return () => { cancelAnimationFrame(focusFrame); document.removeEventListener('focusin', reveal); root.style.setProperty('--tab-bar-height', '0px'); };
  }
  let frame = 0;
  // Deferred to the next frame so a layout change caused by the check itself never loops the observer.
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); });
  observer.observe(bar);
  for (const label of bar.querySelectorAll('.tab-label')) observer.observe(label);
  return () => {
    cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); observer.disconnect(); document.removeEventListener('focusin', reveal);
    root.style.setProperty('--tab-bar-height', '0px');
  };
}
