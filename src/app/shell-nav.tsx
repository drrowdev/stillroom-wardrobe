import { useCallback, useEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { NavFamily } from '../domain/outfits';
import type { Translate } from '../i18n';
import { fitHeader } from './header-fit';
import { Icon } from './icon';
import type { MenuPage } from './shell-layout';
import { fitTabBar } from './tab-fit';
import '../styles/shell.css';

const tabs = [
  { family: 'today', href: '#/today', icon: 'today', label: 'nav.today' },
  { family: 'wardrobe', href: '#/wardrobe', icon: 'wardrobe', label: 'nav.wardrobe' },
  { family: 'outfits', href: '#/outfits', icon: 'outfits', label: 'nav.outfits' },
  { family: 'calendar', href: '#/calendar', icon: 'calendar', label: 'nav.calendar' },
] as const;

/** The signed-in header; on one row when the brand, nav and account menu fit, otherwise the nav takes its own row. */
export function WorkspaceHeader({ children }: { children: ReactNode }) {
  return <header className="workspace-header" ref={fitHeader}>{children}</header>;
}

/** Desktop: the five destinations in the header. */
export function TopNav({ family, t }: { family: NavFamily; t: Translate }) {
  const link = (target: NavFamily, href: string) =>
    ({ className: `nav-link${family === target ? ' active-nav' : ''}`, 'aria-current': family === target ? 'page' as const : undefined, href });
  return <nav className="top-nav" aria-label={t('nav.wardrobe')}>
    {tabs.map(tab => <a key={tab.href} {...link(tab.family, tab.href)}><Icon name={tab.icon} />{t(tab.label)}</a>)}
    <a {...link('statistics', '#/statistics')}><Icon name="statistics" />{t('nav.statistics')}</a>
  </nav>;
}

/** Phone: four destinations and More, after the page content in reading order. */
export function TabBar({ family, more, t }: { family: NavFamily; more: ReactNode; t: Translate }) {
  const bar = useCallback((element: HTMLElement | null) => fitTabBar(element), []);
  return <nav className="tab-bar" aria-label={t('nav.wardrobe')} ref={bar}>
    <ul>
      {tabs.map(tab => <li key={tab.href}>
        <a className="tab-item" href={tab.href} aria-current={family === tab.family ? 'page' : undefined}>
          <Icon name={tab.icon} /><span className="tab-label">{t(tab.label)}</span>
        </a>
      </li>)}
      <li className="tab-more">{more}</li>
    </ul>
  </nav>;
}

type MenuProps = {
  narrow: boolean; open: boolean; onOpen: (open: boolean) => void; page: MenuPage; name: string; initial: string;
  language: ReactNode; onSignOut: () => void; t: Translate;
};
/**
 * The account menu (desktop, under the name) or More (phone, above the tab bar): one disclosure of plain links and
 * buttons, with no menu roles and no focus trap. Escape closes it and returns focus to its trigger; focus or a tap
 * leaving it closes it without moving focus. A link first moves focus to the trigger, so a leave dialog that keeps the
 * user on the page returns focus to something still on screen.
 */
export function AccountMenu({ narrow, open, onOpen, page, name, initial, language, onSignOut, t }: MenuProps) {
  const region = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!region.current?.contains(event.target as Node)) onOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, onOpen]);
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    onOpen(false);
    trigger.current?.focus();
  };
  const follow = () => { trigger.current?.focus(); onOpen(false); };
  // Focus leaving the region closes the menu without moving focus. With no new target, it closes only if focus left the
  // page: a tap on text inside the panel, or on a button WebKit does not focus, blurs to the body and keeps it open.
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = event.relatedTarget;
    if (next instanceof Node) { if (!region.current?.contains(next)) onOpen(false); return; }
    setTimeout(() => { if (!document.hasFocus()) onOpen(false); }, 0);
  };
  const link = (target: MenuPage, href: string, label: Parameters<Translate>[0]) =>
    <a className="text-button" href={href} aria-current={page === target ? 'page' : undefined} onClick={follow}>{t(label)}</a>;
  return <div ref={region} className={`account-region${narrow ? ' in-tab-bar' : ' account-controls'}`} onKeyDown={keyDown}
    onBlur={blur}>
    {narrow
      ? <button ref={trigger} id="account-trigger" type="button" className={`tab-item${page ? ' tab-more-current' : ''}`} aria-expanded={open}
        aria-controls="account-menu" onClick={() => onOpen(!open)}><Icon name="more" /><span className="tab-label">{t('nav.more')}</span></button>
      : <button ref={trigger} id="account-trigger" type="button" className="account-button" aria-expanded={open} aria-controls="account-menu"
        aria-label={t('account.menu')} onClick={() => onOpen(!open)}><span className="avatar">{initial}</span><span className="account-name" title={name}>{name}</span><Icon name="chevron" /></button>}
    {open && <div id="account-menu" className="account-popover">
      {narrow && <p className="menu-identity">{name}</p>}
      {narrow && link('statistics', '#/statistics', 'nav.statistics')}
      {link('settings', '#/settings', 'nav.settings')}
      {link('trash', '#/trash', 'nav.trash')}
      {language}
      <button className="text-button" type="button" onClick={onSignOut}>{t('auth.signOut')}</button>
    </div>}
  </div>;
}
