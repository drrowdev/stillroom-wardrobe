import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n';
import { manualEntry } from './ai-photo-first-support';
import { mockBackend, owners, signIn } from './mock-backend';
import { accountMenu, accountTrigger, expectIdentity, expectSignedIn, openAccountMenu, shellNav } from './shell-support';

const text = (key: MessageKey, language: Language = 'en') => translate(language, key);
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const noViolations = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
const tabBar = (page: Page) => page.locator('nav.tab-bar');
const topNav = (page: Page) => page.locator('nav.top-nav');
const leaveDialog = (page: Page) => page.locator('dialog[aria-labelledby="discard-title"]');
// Headless WebKit, like Safari by default, moves Tab through form controls but not links, so the steps that Tab onto a
// link run in the Chromium projects.
const tabsToLinks = () => test.info().project.name !== 'webkit-photo';
const barHeight = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tab-bar-height').trim());

async function start(page: Page, options: { language?: Language; width?: number; height?: number; hash?: string; admin?: boolean; items?: number } = {}) {
  const language = options.language ?? 'en';
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = await mockBackend(page, { initialLanguage: language });
  if (options.admin) api.adminControl.admin = owners.a;
  for (let index = 0; index < (options.items ?? 0); index++) api.seedSavedItem('a', `Synthetic garment ${index + 1}`);
  await page.goto(`/${options.hash ?? '#/wardrobe'}`); await signIn(page);
  await expectSignedIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  return api;
}
async function openSettings(page: Page, language: Language = 'en') {
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('link', { name: text('nav.settings', language), exact: true }).click();
  await expect(page.locator('#settings-title')).toBeFocused();
  await expect(page.locator('#profile-display_name')).toBeVisible();
}
const tabLabels = (page: Page) => tabBar(page).locator('li').evaluateAll(items => items.map(item => item.textContent?.trim() ?? ''));

test.describe('UX1 phone shell', () => {
  for (const language of languages) {
    test(`390px ${language}: tab bar, compact header and no identity strip or footer`, async ({ page }) => {
      await start(page, { language, items: 3 });
      await expect(tabBar(page)).toBeVisible();
      await expect(topNav(page)).toBeHidden();
      expect(await tabLabels(page)).toEqual(['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar', 'nav.more'].map(key => text(key as MessageKey, language)));
      await expect(shellNav(page).getByRole('link', { name: text('nav.wardrobe', language), exact: true })).toHaveAttribute('aria-current', 'page');
      // The desktop top nav stays in the DOM but is hidden, so it is out of the accessibility tree.
      await expect(page.locator('[aria-current="page"]:visible')).toHaveCount(1);
      await expect(page.getByRole('link', { name: text('nav.wardrobe', language), exact: true })).toHaveCount(1);
      await expect(page.locator('.account-button, .workspace-identity, .site-footer, footer')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: text('nav.wardrobe', language), exact: true })).toHaveCount(1);
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.tab-bar')!.getBoundingClientRect();
        const header = document.querySelector('.workspace-header')!.getBoundingClientRect();
        const heading = document.querySelector('h1')!.getBoundingClientRect();
        return { header: header.height, heading: heading.top, bar: { top: bar.top, bottom: bar.bottom, left: bar.left, right: bar.right }, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(layout.header).toBeLessThanOrEqual(56);
      expect(layout.heading).toBeLessThan(140);
      expect(layout.bar.bottom).toBeLessThanOrEqual(844 + 0.5);
      expect(layout.bar.left >= 0 && layout.bar.right <= 390 + 0.5).toBe(true);
      expect(layout.overflow).toBe(false);
      expect(parseFloat(await barHeight(page))).toBeCloseTo(await tabBar(page).evaluate(bar => bar.getBoundingClientRect().height), 0);
      await noViolations(page);
    });
  }

  test('the tab bar replaces the top nav at 650px and gives way to it at 651px', async ({ page }) => {
    await start(page, { width: 650 });
    await expect(tabBar(page)).toBeVisible();
    await expect(topNav(page)).toBeHidden();
    await expect(page.getByRole('navigation', { name: text('nav.wardrobe'), exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 651, height: 844 });
    await expect(tabBar(page)).toBeHidden();
    await expect(topNav(page)).toBeVisible();
    await expect(page.getByRole('navigation', { name: text('nav.wardrobe'), exact: true })).toHaveCount(1);
    await expect.poll(() => barHeight(page)).toBe('0px');
    await expect(page.locator('.account-button')).toBeVisible();
  });

  test('More is a plain disclosure: contents, Escape, outside tap and focus leaving close it', async ({ page }) => {
    await start(page);
    const more = accountTrigger(page);
    await expect(more).toHaveAccessibleName(text('nav.more'));
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const menu = await openAccountMenu(page, 'en');
    await expect(page.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
    await expect(menu.locator('.menu-identity')).toHaveText('Alex');
    expect(await menu.locator(':scope > a, :scope > button').evaluateAll(nodes => nodes.map(node => node.textContent?.trim())))
      .toEqual([text('nav.statistics'), text('nav.settings'), text('nav.trash'), text('auth.signOut')]);
    await expect(menu.getByRole('button', { name: 'Suomi', exact: true })).toBeVisible();
    await expect(menu.locator('a[href="#/admin"]')).toHaveCount(0);
    await noViolations(page);
    // Escape returns focus to More.
    await menu.getByRole('link', { name: text('nav.settings'), exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(accountMenu(page)).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // Shift+Tab from the first link back past More closes it without trapping focus.
    await openAccountMenu(page);
    await accountMenu(page).getByRole('link', { name: text('nav.statistics'), exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(more).toBeFocused();
    await expect(accountMenu(page)).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(accountMenu(page)).toHaveCount(0);
    if (tabsToLinks()) await expect(shellNav(page).getByRole('link', { name: text('nav.calendar'), exact: true })).toBeFocused();
    // Tab past the last control closes it.
    await openAccountMenu(page);
    await accountMenu(page).getByRole('button', { name: text('auth.signOut'), exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(accountMenu(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest('.account-region') === null || document.activeElement?.id === 'account-trigger')).toBe(true);
    // A tap elsewhere closes it.
    await openAccountMenu(page);
    await page.locator('#wardrobe-title').click();
    await expect(accountMenu(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/wardrobe$/);
  });

  test('menu links reach their routes with the heading focused, and More shows the current menu page', async ({ page }) => {
    await start(page);
    for (const [key, heading] of [['nav.statistics', 'statistics-title'], ['nav.settings', 'settings-title'], ['nav.trash', 'trash-title']] as const) {
      const menu = await openAccountMenu(page, 'en');
      await menu.getByRole('link', { name: text(key), exact: true }).click();
      await expect(page.locator(`#${heading}`)).toBeFocused();
      await expect(accountMenu(page)).toHaveCount(0);
      await expect(accountTrigger(page)).toHaveClass(/tab-more-current/);
      await expect(tabBar(page).locator('[aria-current="page"]')).toHaveCount(0);
      await openAccountMenu(page);
      await expect(accountMenu(page).getByRole('link', { name: text(key), exact: true })).toHaveAttribute('aria-current', 'page');
      await accountTrigger(page).click();
    }
    await shellNav(page).getByRole('link', { name: text('nav.today'), exact: true }).click();
    await expect(page.locator('#today-title')).toBeFocused();
    await expect(accountTrigger(page)).not.toHaveClass(/tab-more-current/);
  });

  test('crossing the breakpoint moves focus from a vanished menu to the visible trigger, but never after a route commit', async ({ page }) => {
    await start(page);
    // Phone panel link → desktop account button.
    await openAccountMenu(page);
    await accountMenu(page).getByRole('link', { name: text('nav.trash'), exact: true }).focus();
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(page.locator('.account-button')).toBeFocused();
    await expect(accountMenu(page)).toHaveCount(0);
    // Desktop panel link → More.
    await openAccountMenu(page);
    await accountMenu(page).getByRole('link', { name: text('nav.settings'), exact: true }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(accountTrigger(page)).toBeFocused();
    await expect(accountTrigger(page)).toHaveAccessibleName(text('nav.more'));
    await expect(accountMenu(page)).toHaveCount(0);
    // Trigger only.
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(page.locator('.account-button')).toBeFocused();
    // A committed route keeps its heading focus.
    const menu = await openAccountMenu(page);
    await menu.getByRole('link', { name: text('nav.settings'), exact: true }).click();
    await expect(page.locator('#settings-title')).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tabBar(page)).toBeVisible();
    await expect(page.locator('#settings-title')).toBeFocused();
  });

  for (const width of [390, 1280]) {
    test(`${width}px: a dirty Add item draft keeps its values when leaving through the menu is cancelled`, async ({ page }) => {
      const api = await start(page, { width });
      await page.getByRole('button', { name: text('wardrobe.add'), exact: true }).first().click();
      await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
      await expect(page.locator('.capture-photo img')).toBeVisible();
      await manualEntry(page);
      await page.locator('#item-title').fill('Unsaved shell draft');
      const items = api.items.length, files = api.files.size;
      const menu = await openAccountMenu(page);
      await menu.getByRole('link', { name: text('nav.settings'), exact: true }).click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
      await expect(leaveDialog(page)).toHaveCount(0);
      await expect(accountTrigger(page)).toBeFocused();
      expect(new URL(page.url()).hash).toBe('#/items/new');
      await expect(page.locator('#item-title')).toHaveValue('Unsaved shell draft');
      expect(api.items).toHaveLength(items); expect(api.files.size).toBe(files);
      await (await openAccountMenu(page)).getByRole('link', { name: text('nav.settings'), exact: true }).click();
      await leaveDialog(page).getByRole('button', { name: text('common.discard'), exact: true }).click();
      await expect(page.locator('#settings-title')).toBeFocused();
      expect(api.items).toHaveLength(items); expect(api.files.size).toBe(files);
    });
  }

  test('a menu route chosen during a profile save opens once the save finishes', async ({ page }) => {
    const api = await start(page);
    await openSettings(page);
    let held: import('@playwright/test').Route | undefined; let writes = 0;
    await page.route('http://127.0.0.1:54321/rest/v1/profiles*', async (route) => {
      if (route.request().method() === 'PATCH') { writes++; if (!held) { held = route; return; } }
      await route.fallback();
    });
    await page.locator('#profile-display_name').fill('Queued shell rename');
    await page.getByRole('button', { name: text('settings.saveProfile'), exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await (await openAccountMenu(page)).getByRole('link', { name: text('nav.trash'), exact: true }).click();
    await expect(page.locator('#settings-title')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/settings');
    await held!.fallback();
    await expect(page.locator('#trash-title')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('#/trash');
    await expect(leaveDialog(page)).toHaveCount(0);
    expect(api.profiles[owners.a]!.display_name).toBe('Queued shell rename');
    expect(writes).toBe(1);
  });

  for (const admin of [true, false]) for (const width of [390, 1280]) {
    test(`${admin ? 'admin' : 'non-admin'} ${width}px: the shell menu has no admin link and reads no admin status`, async ({ page }) => {
      const reads: string[] = [];
      page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/rpc/admin_status')) reads.push(request.url()); });
      await start(page, { width, admin });
      await expect(page.locator('#wardrobe-title')).toBeVisible();
      for (let round = 0; round < 3; round++) {
        const menu = await openAccountMenu(page);
        await expect(menu.locator('a[href="#/admin"]')).toHaveCount(0);
        await accountTrigger(page).click();
        await expect(accountMenu(page)).toHaveCount(0);
      }
      await page.waitForTimeout(250);
      expect(reads).toEqual([]);
      await openSettings(page);
      const link = page.getByRole('link', { name: text('admin.title'), exact: true });
      if (admin) await expect(link).toBeVisible(); else await expect(link).toHaveCount(0);
    });
  }

  test('typing hides the tab bar; leaving the field brings it back and it works without :has()', async ({ page }) => {
    await start(page, { items: 2 });
    const search = page.locator('#wardrobe-search');
    await search.focus();
    await expect(tabBar(page)).toBeHidden();
    // The hidden bar keeps its space and its measured scroll padding, so the page does not jump.
    await expect.poll(async () => parseFloat(await barHeight(page))).toBeGreaterThan(40);
    // Leaving by keyboard, past any other text fields and selects (which count as typing too).
    const typing = () => page.evaluate(() => document.activeElement?.matches('input:not([type=checkbox],[type=radio]), select, textarea') ?? false);
    for (let step = 0; step < 6 && await typing(); step++) await page.keyboard.press('Tab');
    await expect(search).not.toBeFocused();
    expect(await typing()).toBe(false);
    await expect(tabBar(page)).toBeVisible();
    await expect.poll(async () => parseFloat(await barHeight(page))).toBeGreaterThan(40);
    // Leaving by tapping the page, then a normal tap on a tab.
    await search.focus();
    await page.keyboard.press('Escape');
    await expect(tabBar(page)).toBeHidden();
    await page.locator('#wardrobe-title').click();
    await expect(tabBar(page)).toBeVisible();
    await shellNav(page).getByRole('link', { name: text('nav.outfits'), exact: true }).click();
    await expect(page.locator('#outfits-title')).toBeFocused();
    // A checkbox is not typing.
    await shellNav(page).getByRole('link', { name: text('nav.wardrobe'), exact: true }).click();
    await page.locator('.wardrobe-filters summary').click();
    await page.locator('.wardrobe-filters input[type="checkbox"]').first().focus();
    await expect(tabBar(page)).toBeVisible();
    // A browser without :has() keeps the bar; focus still lands clear of it and every tab works.
    await page.addStyleTag({ content: '@media (max-width: 650px) { .workspace .tab-bar { visibility: visible !important; } }' });
    await search.focus();
    await expect(tabBar(page)).toBeVisible();
    await expect.poll(async () => parseFloat(await barHeight(page))).toBeGreaterThan(40);
    await walkFocus(page, 'forward', 400);
    await shellNav(page).getByRole('link', { name: text('nav.calendar'), exact: true }).click();
    await expect(page.locator('#calendar-title')).toBeFocused();
  });

  test('a control tapped under the hidden bar is moved clear when the bar comes back', async ({ page }) => {
    await start(page, { items: 12 });
    await page.locator('#wardrobe-search').focus();
    await expect(tabBar(page)).toBeHidden();
    // With the keyboard up, scroll a garment link that starts below the first screen into the strip the bar will take
    // back, then tap it.
    await page.evaluate(() => {
      const link = [...document.querySelectorAll<HTMLElement>('main a[href]')].find(element => element.getBoundingClientRect().top + scrollY > innerHeight);
      link!.dataset.reshowTarget = '';
    });
    const target = page.locator('[data-reshow-target]');
    const barTop = await tabBar(page).evaluate(bar => bar.getBoundingClientRect().top);
    await target.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().bottom - (innerHeight - 4)));
    expect(await target.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThan(barTop);
    // Focus moves the way a tap does, without scrolling the already visible control.
    await target.evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    await expect(target).toBeFocused();
    // The bar returns after a 0.3 s delay; measure after it is back.
    await page.waitForTimeout(450);
    await expect(tabBar(page)).toBeVisible();
    await expect.poll(() => target.evaluate(element => {
      const bar = document.querySelector('.tab-bar')!.getBoundingClientRect(), box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 0 && box.bottom <= bar.top + 0.5 && (hit === element || element.contains(hit!));
    })).toBe(true);
    await expect(target).toBeFocused();
  });

  test('forced colours: the current tab is marked by its border, not only colour', async ({ page }) => {
    await start(page);
    await page.emulateMedia({ forcedColors: 'active' });
    const borders = await tabBar(page).locator('.tab-item').evaluateAll(items => items.map(item => ({
      current: item.getAttribute('aria-current') === 'page', color: getComputedStyle(item).borderTopColor, width: getComputedStyle(item).borderTopWidth,
    })));
    const current = borders.find(border => border.current)!, other = borders.find(border => !border.current)!;
    expect(parseFloat(current.width)).toBeGreaterThanOrEqual(3);
    expect(current.color).not.toBe(other.color);
    await openAccountMenu(page);
    expect(await accountMenu(page).evaluate(panel => getComputedStyle(panel).outlineStyle)).not.toBe('none');
    await noViolations(page);
  });

  test('safe-area insets: with a notch and home bar the header, skip link, sign-in page and bar stay clear', async ({ page }) => {
    test.skip(test.info().project.name === 'webkit-photo', 'Inset emulation uses the Chromium DevTools protocol.');
    const inset = { top: 47, bottom: 34, left: 0, right: 0 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: inset } as never);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBackend(page);
    await page.goto('/#/wardrobe');
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
    // Sign-in page: the header starts below the notch.
    const entry = page.locator('.entry-header');
    await expect(entry).toBeVisible();
    expect(await entry.evaluate(header => header.getBoundingClientRect().top)).toBeGreaterThanOrEqual(inset.top);
    await signIn(page);
    await expectSignedIn(page);
    const layout = await page.evaluate(() => ({
      brand: document.querySelector('.workspace-header')!.firstElementChild!.getBoundingClientRect().top,
      skip: document.querySelector('.skip-link')!.getBoundingClientRect().bottom,
      tabs: Math.max(...[...document.querySelectorAll('.tab-bar .tab-item')].map(item => item.getBoundingClientRect().bottom)),
    }));
    expect(layout.brand).toBeGreaterThanOrEqual(inset.top);
    // The unfocused skip link is entirely off screen, not peeking out below the notch.
    expect(layout.skip).toBeLessThanOrEqual(0);
    expect(layout.tabs).toBeLessThanOrEqual(844 - inset.bottom + 0.5);
    const skip = page.locator('.skip-link');
    await skip.focus();
    await expect.poll(() => skip.evaluate(link => {
      const box = link.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 47 && box.bottom <= innerHeight && (hit === link || link.contains(hit));
    })).toBe(true);
  });

  for (const width of [390, 1280]) {
    test(`${width}px: the skip link is the first stop, in view above the bar, and opens main`, async ({ page }) => {
      await start(page, { width });
      const skip = page.locator('.skip-link');
      if (tabsToLinks()) {
        // Sequential navigation starts from the top of the document, as on a fresh load (not from the focused heading).
        await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
        await page.keyboard.press('Tab');
      } else {
        // Tab does not reach links in WebKit, so focus the link directly; everything after that is the same.
        await skip.focus();
      }
      await expect(skip).toBeFocused();
      await expect.poll(() => skip.evaluate(link => {
        const box = link.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && (hit === link || link.contains(hit));
      })).toBe(true);
      await page.keyboard.press('Enter');
      await expect(page.locator('#main')).toBeFocused();
    });
  }
});

test.describe('UX1 desktop shell', () => {
  test('1280px: five top links, no tab bar, and the account menu', async ({ page }) => {
    await start(page, { width: 1280 });
    await expect(tabBar(page)).toBeHidden();
    expect(await topNav(page).locator('a').evaluateAll(links => links.map(link => link.textContent?.trim())))
      .toEqual(['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar', 'nav.statistics'].map(key => text(key as MessageKey)));
    await expectIdentity(page, 'Alex');
    const menu = await openAccountMenu(page, 'en');
    await expect(menu.locator('.menu-identity')).toHaveCount(0);
    expect(await menu.locator(':scope > a, :scope > button').evaluateAll(nodes => nodes.map(node => node.textContent?.trim())))
      .toEqual([text('nav.settings'), text('nav.trash'), text('auth.signOut')]);
    await noViolations(page);
    await menu.getByRole('link', { name: text('nav.settings'), exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(accountMenu(page)).toHaveCount(0);
    await expect(page.locator('.account-button')).toBeFocused();
    await openAccountMenu(page);
    await accountMenu(page).getByRole('button', { name: text('auth.signOut'), exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(accountMenu(page)).toHaveCount(0);
  });
});

test.describe('UX1 navigation chunk held or failing', () => {
  // The header's links, the tab bar and the account menu load in their own module (shell-nav.tsx); hold its request.
  async function held(page: Page, width: number) {
    await page.setViewportSize({ width, height: 844 });
    const api = await mockBackend(page);
    api.seedSavedItem('a', 'Synthetic garment 1');
    let release!: (outcome: 'load' | 'fail') => void;
    const outcome = new Promise<'load' | 'fail'>(resolve => { release = resolve; });
    await page.route(url => url.pathname === '/src/app/shell-nav.tsx', async route => {
      if (await outcome === 'fail') await route.abort('failed'); else await route.fallback();
    });
    await page.goto('/#/wardrobe'); await signIn(page);
    const fallback = page.locator('.shell-fallback');
    await expect(fallback).toBeVisible();
    await expect(accountTrigger(page)).toHaveCount(0);
    await expect(tabBar(page)).toHaveCount(0);
    // While loading: the banner, one named navigation with plain links and Sign out, and an interactive main.
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: text('nav.wardrobe'), exact: true })).toHaveCount(1);
    expect(await fallback.locator('a').evaluateAll(links => links.map(link => link.textContent?.trim())))
      .toEqual(['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar', 'nav.statistics', 'nav.settings'].map(key => text(key as MessageKey)));
    await expect(fallback.getByRole('link', { name: text('nav.wardrobe'), exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(fallback.getByRole('button', { name: text('auth.signOut'), exact: true })).toBeVisible();
    await expect(page.locator('main#main')).toBeVisible();
    await noViolations(page);
    // Something typed, and focus on a fallback link, when the module arrives or fails.
    await page.locator('#wardrobe-search').fill('navy');
    const brand = await page.locator('.workspace-header .brand').elementHandle();
    await fallback.getByRole('link', { name: text('nav.outfits'), exact: true }).focus();
    return { release, fallback, brand: brand! };
  }

  for (const width of [390, 1280]) {
    test(`${width}px: a held module shows plain links, then hands focus to the same link in the loaded navigation`, async ({ page }) => {
      const { release, fallback, brand } = await held(page, width);
      release('load');
      await expectSignedIn(page);
      await expect(fallback).toHaveCount(0);
      await expect(shellNav(page).getByRole('link', { name: text('nav.outfits'), exact: true })).toBeFocused();
      await expect(page.locator('#wardrobe-search')).toHaveValue('navy');
      // The brand link is never replaced.
      expect(await brand.evaluate(element => element.isConnected)).toBe(true);
      await expect(page.getByRole('navigation', { name: text('nav.wardrobe'), exact: true })).toHaveCount(1);
      await expect(page).toHaveURL(/#\/wardrobe$/);
      await expectIdentity(page, 'Alex');
    });

    test(`${width}px: a failed module keeps the workspace and what was typed, with plain links, Sign out and Reload`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => { errors.push(error.message); });
      const { release, brand } = await held(page, width);
      release('fail');
      const failed = page.locator('.shell-failed');
      await expect(failed).toHaveText(`${text('shell.failed')} ${text('chunk.reload')}`);
      await expect(failed).toHaveAttribute('role', 'alert');
      await expect(failed.getByRole('button', { name: text('chunk.reload'), exact: true })).toBeVisible();
      await expect(page.locator('.fatal-error')).toHaveCount(0);
      await expect(page.locator('#wardrobe-search')).toHaveValue('navy');
      await expect(page.locator('.shell-fallback').getByRole('link', { name: text('nav.outfits'), exact: true })).toBeFocused();
      expect(await brand.evaluate(element => element.isConnected)).toBe(true);
      await expect(page.getByRole('banner')).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: text('nav.wardrobe'), exact: true })).toHaveCount(1);
      await expect(tabBar(page)).toHaveCount(0);
      await noViolations(page);
      expect(errors).toEqual([]);
      // The plain links still navigate, and Sign out still works.
      await page.locator('.shell-fallback').getByRole('link', { name: text('nav.calendar'), exact: true }).click();
      await expect(page.locator('#calendar-title')).toBeFocused();
      await page.locator('.shell-fallback').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
      await expect(page.locator('#email')).toBeVisible();
    });
  }
});

test.describe('UX1 large text', () => {
  for (const language of ['fi', 'sv'] as const) {
    test(`320px with 200% text ${language}: whole tab labels, reflowed bar and unobscured focus`, async ({ page }) => {
      await start(page, { language, width: 320, height: 800, items: 4 });
      const base = await tabBar(page).locator('.tab-label').first().evaluate(label => parseFloat(getComputedStyle(label).fontSize));
      await page.addStyleTag({ content: zoom });
      await expect(tabBar(page)).toHaveAttribute('data-reflow', '');
      const labels = await tabBar(page).evaluate(bar => {
        const words = (element: Element) => {
          const node = [...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE)!;
          const value = node.textContent ?? '', result: boolean[] = [];
          let offset = 0;
          for (const word of value.split(' ')) {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + word.length);
            result.push(new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size <= 1);
            offset += word.length + 1;
          }
          return result.every(Boolean);
        };
        return [...bar.querySelectorAll('.tab-label')].map(label => ({ whole: words(label), size: parseFloat(getComputedStyle(label).fontSize),
          inside: label.closest('li')!.getBoundingClientRect().left >= 0 && label.closest('li')!.getBoundingClientRect().right <= innerWidth + 0.5 }));
      });
      expect(labels).toHaveLength(5);
      for (const label of labels) expect(label.whole && label.inside && label.size >= base * 1.9).toBe(true);
      await expect.poll(async () => Math.abs(parseFloat(await barHeight(page)) - await tabBar(page).evaluate(bar => bar.getBoundingClientRect().height))).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await noViolations(page);
      await openAccountMenu(page, language);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await noViolations(page);
      await accountTrigger(page).click();
      await walkFocus(page, 'forward', 160);
      await walkFocus(page, 'backward', 160);
      await openSettings(page, language);
      await walkFocus(page, 'forward', 220);
    });
  }

  test('390px with 100% text in English keeps one row of five tabs', async ({ page }) => {
    await start(page);
    await expect(tabBar(page)).not.toHaveAttribute('data-reflow', '');
    const tops = await tabBar(page).locator('li').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
  });
});

/**
 * Tabs once round the whole page and checks that every focused control outside the bar sits fully above it and that a
 * hit test at its centre and edges reaches that control. The walk must come back to its first stop within the limit.
 */
async function walkFocus(page: Page, direction: 'forward' | 'backward', limit: number) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  let first = '', typing = false;
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab');
    // Leaving a text field brings the bar back after a 0.3 s delay; measure once it is back.
    if (typing) await page.waitForTimeout(450);
    // The shell moves a control the browser left under the bar one frame after focus, so measure after two frames.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return { key: 'body', ok: true, typing: false, detail: '' };
      const ids = ((window as unknown as { walkIds?: WeakMap<Element, string> }).walkIds ??= new WeakMap());
      if (!ids.has(element)) ids.set(element, `walk-${performance.now()}-${Math.random()}`);
      const key = ids.get(element)!, name = `${element.tagName} ${element.id || element.getAttribute('name') || element.textContent?.trim().slice(0, 40)}`;
      const typing = element.matches('input:not([type=checkbox],[type=radio]), select, textarea');
      const bar = document.querySelector('.tab-bar')!;
      const barBox = bar.getBoundingClientRect(), shown = getComputedStyle(bar).display !== 'none' && getComputedStyle(bar).visibility !== 'hidden';
      if (!shown || bar.contains(element) || element.closest('dialog')) return { key, ok: true, typing, detail: '' };
      const box = element.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return { key, ok: true, typing, detail: '' };
      const limitBottom = Math.min(innerHeight, barBox.top);
      const fits = box.height <= limitBottom ? box.top >= -0.5 && box.bottom <= limitBottom + 0.5 : box.top >= -0.5 && box.top < limitBottom;
      // The centre and the middle of each visible edge, 2 px in; hit testing follows rounded corners, so not the corners.
      const middle = box.top + Math.min(box.height, limitBottom - box.top) / 2, centre = box.left + box.width / 2;
      const points = [[centre, middle], [centre, box.top + 2], [box.left + 2, middle], [box.right - 2, middle]];
      if (box.height <= limitBottom) points.push([centre, box.bottom - 2]);
      // A link that wraps over lines is a set of boxes, not their bounding rectangle: test the centre of each line.
      const lines = [...element.getClientRects()];
      if (lines.length > 1) points.splice(0, points.length, ...lines.map(line => [line.left + line.width / 2, line.top + line.height / 2]));
      const inView = points.filter(([x, y]) => x! >= 0 && x! < innerWidth && y! >= 0 && y! < innerHeight);
      const misses = inView.filter(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        return !hit || (hit !== element && !element.contains(hit));
      }).map(([x, y]) => `${Math.round(x!)},${Math.round(y!)}→${document.elementFromPoint(x!, y!)?.outerHTML.slice(0, 60) ?? 'null'}`);
      const clear = inView.length > 0 && misses.length === 0;
      return { key, ok: fits && clear, typing, detail: `${name} top ${box.top} bottom ${box.bottom} bar ${barBox.top} fits ${fits} misses ${misses.join(' | ')}` };
    });
    expect(state.ok, state.detail).toBe(true);
    typing = state.typing;
    if (state.key === 'body') continue;
    if (!first) first = state.key;
    else if (state.key === first) return;
  }
  throw new Error(`walkFocus ${direction} did not come back to its first stop within ${limit} steps`);
}

test.describe('bounded UX1 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { name: 'shell-en-mobile', language: 'en', width: 390, height: 844, large: false, scene: 'wardrobe' },
    { name: 'shell-fi-mobile', language: 'fi', width: 390, height: 844, large: false, scene: 'more' },
    { name: 'shell-sv-320-200', language: 'sv', width: 320, height: 800, large: true, scene: 'today' },
    { name: 'shell-en-desktop', language: 'en', width: 1280, height: 800, large: false, scene: 'desktop-menu' },
    { name: 'dialog-fi-320-200', language: 'fi', width: 320, height: 800, large: true, scene: 'dialog' },
  ] as const;
  for (const scene of scenes) {
    test(`${scene.name} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = scene.language;
      const write = testInfo.project.name === 'chromium';
      const directory = path.resolve('test-results/ux1-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const hash = scene.scene === 'more' || scene.scene === 'today' ? '#/today' : '#/wardrobe';
      await start(page, { language, width: scene.width, height: scene.height, hash, items: 4 });
      if (scene.large) await page.addStyleTag({ content: zoom });
      if (scene.scene === 'wardrobe') {
        await expect(page.locator('.item-card').first()).toBeVisible();
        await expect(tabBar(page)).toBeVisible();
      } else if (scene.scene === 'more') {
        await expect(page.locator('#today-title')).toBeVisible();
        await expect((await openAccountMenu(page, language)).locator('.menu-identity')).toHaveText('Alex');
      } else if (scene.scene === 'today') {
        await expect(page.locator('#today-title')).toBeVisible();
        await expect(tabBar(page)).toHaveAttribute('data-reflow', '');
      } else if (scene.scene === 'desktop-menu') {
        await expect(topNav(page)).toBeVisible();
        await expectIdentity(page, 'Alex');
        await openAccountMenu(page, language);
      } else {
        await openSettings(page, language);
        await page.locator('#profile-display_name').fill('Unsaved rename');
        await (await openAccountMenu(page, language)).getByRole('link', { name: text('nav.trash', language), exact: true }).click();
        await expect(leaveDialog(page)).toBeVisible();
        await expect(leaveDialog(page).locator('h2')).toBeVisible();
      }
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await noViolations(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
          .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
      }, { expectedLanguage: language, width: scene.width })).toBe(true);
      if (!write) return;
      const png = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === scene.width).toBe(true);
      const file = await open(path.join(directory, `${scene.name}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});

