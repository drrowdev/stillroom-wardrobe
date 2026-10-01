import { Component, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { NavFamily } from '../domain/outfits';
import type { Translate } from '../i18n';
import { leaveShellFocus, restoreShellFocus } from './shell-focus';
import type { MenuPage } from './shell-layout';

// The header's links and the account menu load in their own chunk (shell-nav.tsx). Until they arrive, or if they fail
// to, the header shows these plain links and Sign out, so the workspace stays usable and nothing typed is lost.

const links = [
  { href: '#/today', label: 'nav.today', family: 'today' },
  { href: '#/wardrobe', label: 'nav.wardrobe', family: 'wardrobe' },
  { href: '#/outfits', label: 'nav.outfits', family: 'outfits' },
  { href: '#/calendar', label: 'nav.calendar', family: 'calendar' },
  { href: '#/statistics', label: 'nav.statistics', family: 'statistics' },
] as const;

export function ShellFallback({ family, page, failed, t, onSignOut }: { family: NavFamily; page: MenuPage; failed: boolean; t: Translate; onSignOut: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    restoreShellFocus();
    const element = root.current;
    // Runs before the links leave the page, so it can still see which one has focus.
    return () => {
      const active = document.activeElement;
      if (element && active instanceof HTMLElement && element.contains(active)) leaveShellFocus(active.dataset.shellKey ?? '');
    };
  }, []);
  return <div ref={root} className="shell-fallback">
    <nav aria-label={t('nav.wardrobe')}>
      <ul>
        {links.map(link => <li key={link.href}><a href={link.href} data-shell-key={link.href} aria-current={family === link.family ? 'page' : undefined}>{t(link.label)}</a></li>)}
        <li><a href="#/settings" data-shell-key="#/settings" aria-current={page === 'settings' ? 'page' : undefined}>{t('nav.settings')}</a></li>
      </ul>
    </nav>
    <button type="button" className="text-button" data-shell-key="sign-out" onClick={onSignOut}>{t('auth.signOut')}</button>
    {failed && <p className="shell-failed" role="alert">{t('shell.failed')} <button type="button" className="text-button" onClick={() => location.reload()}>{t('chunk.reload')}</button></p>}
  </div>;
}

/** Keeps a failed navigation download inside the header (or the tab bar's place) instead of replacing the workspace. */
export class ShellBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
