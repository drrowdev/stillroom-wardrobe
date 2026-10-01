import { useEffect, useRef, useState } from 'react';
import type { Language } from '../../i18n';

export const announceDelayMs = 600;

// Screen readers hear the result count once, after the changes stop, and only when it differs from what they last
// heard. The first count (the wardrobe loading) is not announced. The visible counts never wait for this.
export class CountAnnouncer {
  private last: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly announce: (count: number) => void, private readonly delay = announceDelayMs) {}
  update(count: number) {
    if (this.last === null) { this.last = count; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (count === this.last) return;
      this.last = count;
      this.announce(count);
    }, this.delay);
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; }
}

type Placement = 'page' | 'sheet';
// Returns the count to show in the one announcer mounted at `placement`, or null. A message belongs to the announcer
// that was mounted when it was made, so a newly mounted announcer (the sheet opening or closing) starts empty and an
// announcement is never repeated by the move.
export function useCountAnnouncement(count: number | null, placement: Placement, language: Language): number | null {
  const [message, setMessage] = useState<{ count: number; placement: Placement; language: Language } | null>(null);
  const context = useRef({ placement, language });
  const announcer = useRef<CountAnnouncer | null>(null);
  useEffect(() => { context.current = { placement, language }; }, [placement, language]);
  useEffect(() => {
    const instance = new CountAnnouncer(value => setMessage({ count: value, ...context.current }));
    announcer.current = instance;
    return () => { instance.dispose(); announcer.current = null; };
  }, []);
  useEffect(() => { if (count !== null) announcer.current?.update(count); }, [count]);
  return message && message.placement === placement && message.language === language ? message.count : null;
}
