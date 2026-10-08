import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n/all';
import { manualEntry } from './ai-photo-first-support';
import { controlCatalogues } from './catalogue-support';
import { mockBackend, owners, recoveryHash, signIn } from './mock-backend';
import { accountMenu, accountTrigger, expectIdentity, expectSignedIn, openAccountMenu, settleShell, shellNav, signOutThroughMenu } from './shell-support';
import { closeFilters, filterSheet, openFilters } from './wardrobe-support';

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

test.describe('WEATHER1 Today header geometry', () => {
  for (const language of languages) test(`${language}: 320/390px, desktop and 200% text keep weather and navigation readable`, async ({ page }) => {
    await start(page, { language, hash: '#/today', width: 390 });
    const trigger = page.locator('#weather-trigger');
    await expect(trigger).toHaveText(text('weather.noForecast', language));
    const fits = async () => {
      expect(await page.evaluate(() => {
        const header = document.querySelector('.workspace-header')!;
        const weather = document.querySelector('#weather-trigger')!;
        const box = weather.getBoundingClientRect();
        return document.documentElement.scrollWidth <= innerWidth && header.scrollWidth <= header.clientWidth
          && weather.scrollWidth <= weather.clientWidth && box.left >= 0 && box.right <= innerWidth + .5 && box.height >= 44
          && parseFloat(getComputedStyle(weather).fontSize) >= 14;
      })).toBe(true);
    };
    for (const width of [320, 390, 650, 651, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await settleShell(page);
      await fits();
      await expect(width <= 650 ? tabBar(page) : topNav(page)).toBeVisible();
      if (width === 390) expect(await page.locator('.workspace-header').evaluate(header => header.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: zoom });
    await settleShell(page);
    await fits();
    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator('#weather-details');
    await expect(panel).toBeVisible();
    for (const control of await panel.locator('button, a').all()) {
      if (!await control.isVisible()) continue;
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth && box.left >= 0 && box.right <= innerWidth + .5 && box.height >= 44;
      })).toBe(true);
    }
    await noViolations(page);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await shellNav(page).getByRole('link', { name: text('nav.wardrobe', language), exact: true }).click();
    await expect(trigger).toHaveCount(0);
    await expect(page.locator('#weather-header-slot')).toBeEmpty();
  });
});

test('WEATHER1 desktop Tab order follows the one-row navigation, account and weather layout', async ({ page }) => {
  await start(page, { hash: '#/today', width: 1280 });
  const trigger = page.locator('#weather-trigger');
  await expect(trigger).toBeVisible();
  await settleShell(page);
  await expect(page.locator('.workspace-header')).not.toHaveAttribute('data-stacked', '');
  const boxes = await Promise.all([topNav(page).boundingBox(), accountTrigger(page).boundingBox(), trigger.boundingBox()]);
  expect(boxes.every(box => box !== null)).toBe(true);
  const [nav, account, weather] = boxes;
  expect(nav!.x + nav!.width).toBeLessThanOrEqual(account!.x);
  expect(account!.x + account!.width).toBeLessThanOrEqual(weather!.x);
  expect(Math.abs(nav!.y + nav!.height / 2 - account!.y - account!.height / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(account!.y + account!.height / 2 - weather!.y - weather!.height / 2)).toBeLessThanOrEqual(1);
  const lastLink = topNav(page).getByRole('link').last();
  await lastLink.focus();
  await expect(lastLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(accountTrigger(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
});

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
    await openFilters(page);
    await filterSheet(page).locator('input[type="checkbox"]').first().focus();
    await expect(tabBar(page)).toBeVisible();
    await closeFilters(page);
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

  // A notched phone (390 × 844) and the owner's iPhone 17 with its Dynamic Island (about 402 × 874, insets 62 / 34).
  for (const device of [
    { name: 'notch', width: 390, height: 844, inset: { top: 47, bottom: 34, left: 0, right: 0 } },
    { name: 'iPhone 17', width: 402, height: 874, inset: { top: 62, bottom: 34, left: 0, right: 0 } },
  ]) {
    test(`safe-area insets, ${device.name} ${device.width}×${device.height}: the header, skip link, sign-in page and bar stay clear`, async ({ page }) => {
      test.skip(test.info().project.name === 'webkit-photo', 'Inset emulation uses the Chromium DevTools protocol.');
      const { inset, width, height } = device;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: inset } as never);
      await page.setViewportSize({ width, height });
      await mockBackend(page);
      await page.goto('/#/wardrobe');
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      // Sign-in page: the header starts below the notch.
      const entry = page.locator('.entry-header');
      await expect(entry).toBeVisible();
      expect(await entry.evaluate(header => header.getBoundingClientRect().top)).toBeGreaterThanOrEqual(inset.top);
      expect(await fits()).toBe(true);
      await signIn(page);
      await expectSignedIn(page);
      await settleShell(page);
      const layout = await page.evaluate(() => ({
        header: document.querySelector('.workspace-header')!.getBoundingClientRect().top,
        brand: document.querySelector('.workspace-header')!.firstElementChild!.getBoundingClientRect().top,
        skip: document.querySelector('.skip-link')!.getBoundingClientRect().bottom,
        tabs: [...document.querySelectorAll('.tab-bar .tab-item')].map(item => item.getBoundingClientRect()).map(box => ({ top: box.top, bottom: box.bottom })),
      }));
      expect(layout.header).toBeGreaterThanOrEqual(0);
      expect(layout.brand).toBeGreaterThanOrEqual(inset.top);
      // The unfocused skip link is entirely off screen, not peeking out below the notch.
      expect(layout.skip).toBeLessThanOrEqual(0);
      expect(layout.tabs).toHaveLength(5);
      for (const tab of layout.tabs) {
        expect(tab.bottom).toBeLessThanOrEqual(height - inset.bottom + 0.5);
        expect(tab.top).toBeGreaterThanOrEqual(inset.top);
      }
      expect(await fits()).toBe(true);
      const skip = page.locator('.skip-link');
      await skip.focus();
      await expect.poll(() => skip.evaluate((link, top) => {
        const box = link.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return box.top >= top && box.bottom <= innerHeight && (hit === link || link.contains(hit));
      }, inset.top)).toBe(true);
      expect(await fits()).toBe(true);
    });
  }

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
  // A size change shows the one-row bar for a frame before tab-fit.ts measures it. A word wider than its column in that
  // frame (seen with Linux WebKit fonts at 320 px and 200 % text) must not widen the page, and the bar must then reflow.
  test('a label word wider than its column never widens the page before the bar reflows', async ({ page }) => {
    await start(page, { width: 320, height: 800 });
    const before = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('nav.tab-bar')!;
      delete bar.dataset.reflow;
      bar.querySelector<HTMLElement>('.tab-more .tab-label')!.textContent = 'Moremoremoremore';
      return { scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    expect(before.scroll).toBeLessThanOrEqual(before.width);
    await expect(tabBar(page)).toHaveAttribute('data-reflow', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

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


test.describe('UX6 wardrobe filters sheet and sign-in page', () => {
  const inSheet = (page: Page) => page.evaluate(() => {
    const active = document.activeElement;
    return !!active && active !== document.body && !!active.closest('dialog.filter-sheet');
  });
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`${size.width}px: the sheet is a named modal that keeps focus inside and returns it with the page unchanged`, async ({ page }) => {
      await start(page, { items: 3, ...size });
      await page.locator('#wardrobe-search').fill('Synthetic');
      await page.locator('#wardrobe-sort').selectOption('name');
      await openFilters(page, 'keyboard');
      await expect(page.getByRole('dialog', { name: text('common.filters'), exact: true })).toBeVisible();
      expect(await filterSheet(page).evaluate(dialog => (dialog as HTMLDialogElement).open && dialog.matches(':modal'))).toBe(true);
      await noViolations(page);
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.locator('#filter-sheet-title').focus();
        for (let step = 0; step < 24; step++) {
          await page.keyboard.press(key);
          expect(await inSheet(page), `${key} step ${step}`).toBe(true);
        }
      }
      await page.keyboard.press('Escape');
      await expect(filterSheet(page)).toHaveCount(0);
      await expect(page.locator('.wardrobe-filter-button')).toBeFocused();
      await expect(page.locator('#wardrobe-search')).toHaveValue('Synthetic');
      await expect(page.locator('#wardrobe-sort')).toHaveValue('name');
      // Choosing a filter, then "Show 3 items".
      await openFilters(page);
      await filterSheet(page).locator('input[name="category"][value="top"]').check();
      await filterSheet(page).getByRole('button', { name: translate('en', 'wardrobe.showItems_other', { count: '3' }), exact: true }).click();
      await expect(filterSheet(page)).toHaveCount(0);
      await expect(page.locator('.wardrobe-filter-button')).toBeFocused();
      await expect(page.locator('.wardrobe-filter-button')).toHaveText(translate('en', 'wardrobe.filtersActive', { count: '1' }));
      await expect(page.locator('.filter-chip')).toHaveText([`${text('category.top')}×`]);
      await expect(page.locator('.item-card')).toHaveCount(3);
      // The backdrop closes it too.
      await openFilters(page);
      await page.mouse.click(8, 8);
      await expect(filterSheet(page)).toHaveCount(0);
      await expect(page.locator('.wardrobe-filter-button')).toBeFocused();
      await expect(page.locator('input[name="category"]:checked')).toHaveCount(0);
      await expect(page.locator('.filter-chip')).toHaveCount(1);
    });
  }

  for (const view of [{ width: 320, height: 640, zoom: false }, { width: 390, height: 844, zoom: false }, { width: 1280, height: 800, zoom: true }]) {
    test(`${view.width}px${view.zoom ? ' at 200%' : ''}: the sheet fits, scrolls inside and its actions can be reached`, async ({ page }) => {
      await start(page, { items: 3, width: view.width, height: view.height });
      if (view.zoom) await page.addStyleTag({ content: zoom });
      await openFilters(page);
      const fit = await filterSheet(page).evaluate(dialog => {
        const box = dialog.getBoundingClientRect(), body = dialog.querySelector('.filter-sheet-body')!;
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, sideways: body.scrollWidth > body.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth };
      });
      expect(fit.left).toBeGreaterThanOrEqual(-0.5);
      expect(fit.right).toBeLessThanOrEqual(view.width + 0.5);
      expect(fit.top).toBeGreaterThanOrEqual(-0.5);
      expect(fit.bottom).toBeLessThanOrEqual(view.height + 0.5);
      expect(fit.sideways).toBe(false);
      expect(fit.page).toBe(false);
      for (const control of [filterSheet(page).locator('.filter-sheet-header button'), filterSheet(page).locator('.filter-sheet-footer .button-primary')]) {
        await control.scrollIntoViewIfNeeded();
        await expect.poll(() => control.evaluate(element => {
          const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return box.height >= 44 && (hit === element || element.contains(hit));
        })).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('.wardrobe-filter-button')).toBeFocused();
    });
  }

  test('Refresh is a named 44px icon button and is unavailable offline', async ({ page }) => {
    await start(page, { items: 2, width: 320, height: 640 });
    const refresh = page.getByRole('button', { name: text('wardrobe.refresh'), exact: true });
    const box = (await refresh.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.context().setOffline(true);
    await expect(refresh).toBeDisabled();
    await page.context().setOffline(false);
    await expect(refresh).toBeEnabled();
  });

  test('forced colours: the sheet, chips and Refresh keep visible edges', async ({ page }) => {
    await start(page, { items: 2 });
    await page.emulateMedia({ forcedColors: 'active' });
    await openFilters(page);
    await filterSheet(page).locator('input[name="category"][value="top"]').check();
    expect(await filterSheet(page).evaluate(dialog => getComputedStyle(dialog).borderTopStyle)).not.toBe('none');
    await noViolations(page);
    await page.keyboard.press('Escape');
    const edges = await page.evaluate(() => [document.querySelector('.filter-chip')!, document.querySelector('.wardrobe-refresh')!]
      .map(element => ({ style: getComputedStyle(element).borderTopStyle, width: parseFloat(getComputedStyle(element).borderTopWidth) })));
    for (const edge of edges) { expect(edge.style).not.toBe('none'); expect(edge.width).toBeGreaterThan(0); }
    await noViolations(page);
  });

  for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`${size.width}px sign-in page: the language choice sits below the sign-in card`, async ({ page }) => {
      await page.setViewportSize(size);
      await mockBackend(page);
      await page.goto('/#/wardrobe');
      const card = page.locator('.entry-card'), choice = page.locator('.entry-language .language-selector');
      await expect(card).toBeVisible();
      await expect(choice).toBeVisible();
      await expect(page.locator('.entry-header .language-selector')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => {
        const cardBox = document.querySelector('.entry-card')?.getBoundingClientRect(), choiceBox = document.querySelector('.entry-language .language-selector')?.getBoundingClientRect();
        return !!cardBox && !!choiceBox && choiceBox.top >= cardBox.bottom - 0.5;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await noViolations(page);
    });
  }
});

test.describe('UX6 bounded synthetic captures', () => {
  const scenes = [
    { name: 'wardrobe-en-mobile', language: 'en', width: 390, height: 844, large: false, scene: 'grid' },
    { name: 'chips-fi-mobile', language: 'fi', width: 390, height: 844, large: false, scene: 'chips' },
    { name: 'filter-sheet-fi-mobile', language: 'fi', width: 390, height: 844, large: false, scene: 'sheet' },
    { name: 'filter-sheet-sv-320-200', language: 'sv', width: 320, height: 800, large: true, scene: 'sheet' },
    { name: 'filter-sheet-en-desktop', language: 'en', width: 1280, height: 800, large: false, scene: 'sheet' },
    { name: 'sign-in-sv-320-200', language: 'sv', width: 320, height: 800, large: true, scene: 'sign-in' },
  ] as const;
  for (const scene of scenes) {
    test(`${scene.name} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = scene.language;
      const write = testInfo.project.name === 'chromium';
      const directory = path.resolve('test-results/ux6-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      if (scene.scene === 'sign-in') {
        await page.setViewportSize({ width: scene.width, height: scene.height });
        await mockBackend(page, { initialLanguage: language });
        await page.goto('/#/wardrobe');
        await page.locator(`.language-selector button[lang="${language}"]`).click();
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('.entry-language .language-selector')).toBeVisible();
      } else {
        await start(page, { language, width: scene.width, height: scene.height, items: 6 });
        if (scene.scene !== 'grid') {
          await openFilters(page);
          for (const value of ['top', 'bottom', 'footwear']) await filterSheet(page).locator(`input[name="category"][value="${value}"]`).check();
          if (scene.scene === 'chips') {
            await page.keyboard.press('Escape');
            await expect(page.locator('.filter-chip')).toHaveCount(3);
          }
        }
        await expect(page.locator('.item-card').first()).toBeVisible();
      }
      if (scene.large) await page.addStyleTag({ content: zoom });
      if (scene.scene === 'sheet') await expect(filterSheet(page).locator('.filter-sheet-footer .button-primary')).toBeVisible();
      await noViolations(page);
      expect(await page.evaluate(({ expectedLanguage, width, signIn }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
          .filter((field) => field.getClientRects().length && field.type !== 'checkbox' && field.type !== 'radio').map((field) => field.value).join('');
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && (signIn ? fields === '' : !document.querySelector('input[type=password],#email,#password'))
          && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
      }, { expectedLanguage: language, width: scene.width, signIn: scene.scene === 'sign-in' })).toBe(true);
      if (!write) return;
      const png = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === scene.width).toBe(true);
      const file = await open(path.join(directory, `${scene.name}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});

// LANG1: only the active language's catalogue is fetched. Startup and every change of language wait for it (plan rev3 §6).
const recordTexts = () => {
  const seen: string[] = [];
  (window as unknown as { __texts: string[] }).__texts = seen;
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') seen.push(record.target.textContent ?? '');
      for (const node of record.addedNodes) seen.push(node.textContent ?? '');
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
};
const recordedTexts = (page: Page) => page.evaluate(() => (window as unknown as { __texts: string[] }).__texts.join('\n'));
const entryChooser = (page: Page) => page.locator('.entry-language .language-selector');
const entryLanguage = (page: Page, language: Language) => page.locator(`.entry-language button[lang="${language}"]`);
/** Lets a settled request's callbacks run, so a test can assert that they changed nothing. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { setTimeout(resolve, 50); }); }));
const catalogueSettled = (page: Page, language: Language, outcome: 'load' | 'fail') => outcome === 'load'
  ? page.waitForEvent('requestfinished', (request) => request.url().includes(`/catalogue-${language}-`))
  : page.waitForEvent('requestfailed', (request) => request.url().includes(`/catalogue-${language}-`));

test.describe('LANG1 language catalogues on the entry screens', () => {
  for (const [locale, language] of [['fi-FI', 'fi'], ['sv-SE', 'sv']] as const) {
    test.describe(`${locale} device`, () => {
      test.use({ locale });
      test(`startup waits for the ${language} catalogue and never shows another language`, async ({ page }) => {
        await page.addInitScript(recordTexts);
        await mockBackend(page);
        const catalogues = await controlCatalogues(page);
        const release = catalogues.hold(language);
        await page.goto('/');
        await expect.poll(() => catalogues.count(language)).toBe(1);
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('#root')).toBeEmpty();
        release();
        await expect(page.getByRole('button', { name: text('auth.signIn', language), exact: true })).toBeVisible();
        const seen = await recordedTexts(page);
        expect(seen).toContain(text('auth.password', language));
        for (const key of ['auth.signIn', 'auth.email', 'auth.password'] as const) expect(seen).not.toContain(text(key));
        expect(catalogues.requested()).toEqual([language]);
      });
    });
  }

  test('sign-in: a chosen language waits for its catalogue; a failure keeps the page and Try again loads it', async ({ page }) => {
    await mockBackend(page);
    const catalogues = await controlCatalogues(page);
    await page.goto('/');
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toHaveText(text('auth.signIn'));
    expect(catalogues.requested()).toEqual(['en']);
    const height = async () => (await page.locator('.entry-language').boundingBox())!.height;
    const before = await height();
    const release = catalogues.hold('sv');
    await entryLanguage(page, 'sv').click();
    await expect(entryChooser(page)).toHaveAttribute('aria-busy', 'true');
    await expect(entryLanguage(page, 'sv')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.entry-language [aria-live="polite"]')).toHaveText(text('language.loading'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(submit).toHaveText(text('auth.signIn'));
    expect(await height()).toBe(before);
    await noViolations(page);
    // Another choice while one loads is ignored.
    await entryLanguage(page, 'fi').click({ force: true });
    release();
    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
    await expect(submit).toHaveText(text('auth.signIn', 'sv'));
    await expect(entryChooser(page)).not.toHaveAttribute('aria-busy', 'true');
    expect(catalogues.count('fi')).toBe(0);

    catalogues.failNext('fi');
    await entryLanguage(page, 'fi').click();
    const alert = page.locator('.language-load-error');
    await expect(alert).toHaveText(text('language.loadFailed', 'sv'));
    await expect(alert).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
    await expect(submit).toHaveText(text('auth.signIn', 'sv'));
    await noViolations(page);
    await page.getByRole('button', { name: text('common.retry', 'sv'), exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
    await expect(submit).toHaveText(text('auth.signIn', 'fi'));
    await expect(alert).toHaveCount(0);
    await expect(entryLanguage(page, 'fi')).toBeFocused();
    const fi = catalogues.urls.filter((url) => url.includes('/catalogue-fi-'));
    expect(fi).toHaveLength(2);
    expect(fi[1]).toBe(fi[0]);
    expect(new URL(fi[1]!).search).toBe('');
  });

  for (const outcome of ['load', 'fail'] as const) {
    test(`a choice still loading at sign-in is never applied after sign-out (${outcome})`, async ({ page }) => {
      await mockBackend(page);
      const catalogues = await controlCatalogues(page);
      await page.goto('/');
      const release = catalogues.hold('sv');
      await entryLanguage(page, 'sv').click();
      await expect(entryChooser(page)).toHaveAttribute('aria-busy', 'true');
      await signIn(page);
      await expectSignedIn(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await signOutThroughMenu(page);
      await expect(page.locator('#email')).toBeVisible();
      await page.locator('#email').focus();
      const settled = catalogueSettled(page, 'sv', outcome);
      release(outcome);
      await settled;
      await settle(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('button[type="submit"]')).toHaveText(text('auth.signIn'));
      await expect(entryChooser(page)).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('.language-load-error')).toHaveCount(0);
      await expect(page.locator('#email')).toBeFocused();
    });
  }

  test('a choice still loading when the recovery screen is left is never applied to the sign-in screen', async ({ page }) => {
    await mockBackend(page);
    const catalogues = await controlCatalogues(page);
    await page.goto('/' + recoveryHash());
    await expect(page.getByText(translate('en', 'recovery.target', { email: 'user-a@example.test' }), { exact: true })).toBeVisible();
    const release = catalogues.hold('fi');
    await entryLanguage(page, 'fi').click();
    await expect(entryChooser(page)).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: text('recovery.notMine'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    const settled = catalogueSettled(page, 'fi', 'load');
    release();
    await settled;
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('button[type="submit"]')).toHaveText(text('auth.signIn'));
    await expect(page.locator('.language-load-error')).toHaveCount(0);
  });

  test('a failed startup catalogue keeps a password-recovery link: Try again opens the recovery form in place', async ({ page }) => {
    const backend = await mockBackend(page);
    const catalogues = await controlCatalogues(page);
    catalogues.failNext('en');
    await page.goto('/' + recoveryHash());
    await expect(page.getByRole('heading', { name: text('common.errorTitle'), exact: true })).toBeVisible();
    await expect(page.getByText(text('error.unavailable'), { exact: true })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('#/recovery');
    await page.evaluate(() => { (window as unknown as { __bootMarker: boolean }).__bootMarker = true; });
    await page.getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.getByText(translate('en', 'recovery.target', { email: 'user-a@example.test' }), { exact: true })).toBeVisible();
    // The same document: nothing reloaded, so the link captured in memory was kept.
    expect(await page.evaluate(() => (window as unknown as { __bootMarker?: boolean }).__bootMarker)).toBe(true);
    expect(await page.evaluate(() => `${location.href}\n${JSON.stringify({ ...localStorage })}\n${JSON.stringify({ ...sessionStorage })}`)).not.toMatch(/access_token|refresh_token|token=/);
    expect(backend.requests.filter((request) => request.path === '/auth/v1/token')).toHaveLength(0);
    expect(catalogues.count('en')).toBe(2);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: text('recovery.continue'), exact: true }).click();
    await expect(page.locator('#recovery-password')).toBeVisible();
  });

  // LANG1b: typing while a chosen language loads, and while it arrives, keeps every value and the focus.
  test('sign-in: values typed while a language loads survive its arrival and the form still signs in', async ({ page }) => {
    await mockBackend(page);
    const catalogues = await controlCatalogues(page);
    await page.goto('/');
    const email = page.locator('#email'), password = page.locator('#password');
    await expect(email).toBeEditable();
    const release = catalogues.hold('fi');
    await entryLanguage(page, 'fi').click();
    await expect(entryChooser(page)).toHaveAttribute('aria-busy', 'true');
    await expect(email).toBeEditable();
    await expect(password).toBeEditable();
    await email.pressSequentially('user-a@example.test');
    await password.click();
    const typing = password.pressSequentially('fictional-test-password', { delay: 15 });
    await expect.poll(() => password.inputValue()).toMatch(/^fict/);
    release();
    await typing;
    await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
    await expect(page.locator('button[type="submit"]')).toHaveText(text('auth.signIn', 'fi'));
    await expect(email).toHaveValue('user-a@example.test');
    await expect(password).toHaveValue('fictional-test-password');
    await expect(password).toBeFocused();
    await page.locator('button[type="submit"]').click();
    await expectSignedIn(page);
  });

  test('password reset request: an email typed while a language loads survives its arrival', async ({ page }) => {
    await mockBackend(page);
    const catalogues = await controlCatalogues(page);
    await page.goto('/');
    await page.getByRole('button', { name: text('recovery.forgot'), exact: true }).click();
    const email = page.locator('#recovery-email');
    await expect(email).toBeEditable();
    const release = catalogues.hold('sv');
    await entryLanguage(page, 'sv').click();
    await expect(entryChooser(page)).toHaveAttribute('aria-busy', 'true');
    await email.click();
    const typing = email.pressSequentially('user-a@example.test', { delay: 15 });
    await expect.poll(() => email.inputValue()).toMatch(/^user/);
    release();
    await typing;
    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
    await expect(page.locator('label[for="recovery-email"]')).toHaveText(text('auth.email', 'sv'));
    await expect(email).toHaveValue('user-a@example.test');
    await expect(email).toBeFocused();
  });

  test.describe('fi-FI device at 320px', () => {
    test.use({ locale: 'fi-FI' });
    test('200% text: the failed-language line and Try again fit, with no axe violations', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await mockBackend(page);
      const catalogues = await controlCatalogues(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await expect(page.locator('button[type="submit"]')).toHaveText(text('auth.signIn', 'fi'));
      await page.addStyleTag({ content: zoom });
      catalogues.failNext('sv');
      await entryLanguage(page, 'sv').click();
      await expect(page.locator('.language-load-error')).toHaveText(text('language.loadFailed', 'fi'));
      const retry = page.getByRole('button', { name: text('common.retry', 'fi'), exact: true });
      await retry.scrollIntoViewIfNeeded();
      await expect(retry).toBeVisible();
      const fit = await page.evaluate(() => {
        const line = document.querySelector('.language-load-failed')!.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, inside: line.left >= -0.5 && line.right <= innerWidth + 0.5 };
      });
      expect(fit).toEqual({ overflow: false, inside: true });
      await noViolations(page);
    });
  });
});
