// Puts the nav on its own row whenever the brand, the links and the account menu don't fit on one,
// whatever the language, text size or display name length.
export function fitHeader(header: HTMLElement | null): (() => void) | undefined {
  if (!header) return undefined;
  const check = () => {
    delete header.dataset.stacked;
    const inner = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
    const boxes = [...header.children].map(child => child.getBoundingClientRect());
    // Overflowing, or wrapped onto a second row, both mean one row is too narrow.
    const over = header.scrollWidth > header.clientWidth + 0.5
      || boxes.some(box => box.right > inner + 0.5 || box.top >= boxes[0]!.bottom - 0.5);
    if (over) header.dataset.stacked = '';
  };
  check();
  let frame = 0;
  // Deferred to the next frame so a layout change caused by the check itself never loops the observer.
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); });
  observer.observe(header);
  for (const element of [...header.children, ...header.querySelectorAll('nav a')]) observer.observe(element);
  return () => { cancelAnimationFrame(frame); observer.disconnect(); };
}
