import { useEffect, useRef, useState } from 'react';
import type { MessageKey, Translate } from '../../i18n';

export type SettingsSection = { id: string; label: MessageKey };

/**
 * The section menu: buttons, not hash links, because the app routes on `#/…`. A button scrolls to its section and
 * focuses the section heading; the section in view is marked `aria-current="location"`. A chosen section stays marked
 * until the user scrolls or it leaves the screen, so a short last section is not replaced by the one above it.
 */
export function SettingsNav({ sections, t }: { sections: readonly SettingsSection[]; t: Translate }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? null);
  const chosen = useRef<string | null>(null);
  const ids = sections.map((section) => section.id).join(' ');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      if (chosen.current) {
        const box = document.getElementById(chosen.current)?.getBoundingClientRect();
        if (box && box.bottom > 0 && box.top < innerHeight) return;
        chosen.current = null;
      }
      const order = ids.split(' ');
      const first = order.find((id) => visible.has(id));
      if (first) setCurrent(first);
    }, { rootMargin: '0px 0px -60% 0px' });
    for (const id of ids.split(' ')) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    const release = () => { chosen.current = null; };
    const input = ['wheel', 'touchstart', 'keydown'] as const;
    for (const type of input) window.addEventListener(type, release, { passive: true });
    return () => {
      observer.disconnect();
      for (const type of input) window.removeEventListener(type, release);
    };
  }, [ids]);
  function go(id: string) {
    chosen.current = id;
    setCurrent(id);
    const section = document.getElementById(id);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    document.getElementById(`${id}-heading`)?.focus({ preventScroll: true });
  }
  return <nav className="settings-nav" aria-label={t('settings.sections')}>
    <ul>
      {sections.map((section) => <li key={section.id}>
        <button type="button" className="settings-nav-item" aria-current={current === section.id ? 'location' : undefined}
          onClick={() => go(section.id)}>{t(section.label)}</button>
      </li>)}
    </ul>
  </nav>;
}
