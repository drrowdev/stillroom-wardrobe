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
// Returns the count to show in the one announcer mounted at `placement`, or null. Each mount (the sheet opening or
// closing, or a language change) starts a new generation, and a message belongs to the generation it was made in, so
// a newly mounted announcer always starts empty: a finished announcement is never replayed by remounting. A pending
// announcement, still debounced and deduplicated, is spoken once by whichever announcer is mounted when it is due.
export function useCountAnnouncement(count: number | null, placement: Placement, language: Language): number | null {
  const [mount, setMount] = useState({ placement, language, generation: 0 });
  if (mount.placement !== placement || mount.language !== language) setMount({ placement, language, generation: mount.generation + 1 });
  const [message, setMessage] = useState<{ count: number; generation: number } | null>(null);
  const generation = useRef(mount.generation);
  const announcer = useRef<CountAnnouncer | null>(null);
  useEffect(() => { generation.current = mount.generation; }, [mount.generation]);
  useEffect(() => {
    const instance = new CountAnnouncer(value => setMessage({ count: value, generation: generation.current }));
    announcer.current = instance;
    return () => { instance.dispose(); announcer.current = null; };
  }, []);
  useEffect(() => { if (count !== null) announcer.current?.update(count); }, [count]);
  return message && message.generation === mount.generation ? message.count : null;
}
