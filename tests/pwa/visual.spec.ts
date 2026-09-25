import { devices, expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { languages, messages, type Language } from '../../src/i18n';
import { mockBackend, signIn } from '../browser/mock-backend';
import { builds } from './builds';
import { controlled, serve, updateAndSettle, type DistServer } from './helpers';

// Bounded synthetic captures for the coordinator's visual review; this session never opens them.
const directory = path.join('test-results', 'i23-visual');
let server: DistServer;
test.beforeEach(async () => { server = await serve('a'); await mkdir(directory, { recursive: true }); });
test.afterEach(async () => { await server.close(); });

async function signedIn(page: Page, language: Language) {
  await mockBackend(page, { initialLanguage: language });
  await page.goto(server.url);
  await controlled(page);
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
}
async function updatePrompt(page: Page, language: Language, file: string) {
  await signedIn(page, language);
  await server.setRoot(builds.b);
  expect((await updateAndSettle(page)).waiting).toBe(true);
  const status = page.getByRole('status').filter({ hasText: messages['update.available'][language] });
  await expect(status).toBeVisible();
  const reload = status.getByRole('button', { name: messages['update.reload'][language], exact: true });
  await expect(reload).toBeEnabled();
  const box = (await reload.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: path.join(directory, file), fullPage: false });
}
const installCard = (page: Page) => page.locator('section[aria-labelledby="install-heading"]');
async function openSettings(page: Page, language: Language) {
  await signedIn(page, language);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#profile-heading')).toBeVisible();
}
async function installHint(page: Page, language: Language, platform: 'ios' | 'other', file: string) {
  await openSettings(page, language);
  const card = installCard(page);
  await expect(card.getByRole('heading', { name: messages['install.title'][language] })).toBeVisible();
  const [shown, hidden] = platform === 'ios' ? ['install.ios', 'install.android'] as const : ['install.android', 'install.ios'] as const;
  await expect(card.locator('p')).toHaveText([messages[shown][language]]);
  await expect(card).not.toContainText(messages[hidden][language]);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, file), fullPage: false });
}

test.describe('desktop', () => {
  test('captures the update prompt in English', async ({ page }) => {
    await updatePrompt(page, 'en', 'update-en-desktop.png');
  });
  test('captures the install hint in English', async ({ page }) => {
    await installHint(page, 'en', 'other', 'install-en-desktop.png');
  });
  test('hides the install hint when the app runs as an installed app', async ({ page }) => {
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => query === '(display-mode: standalone)'
        ? { ...original(query), matches: true, media: query } as MediaQueryList : original(query);
    });
    await openSettings(page, 'en');
    expect(await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches)).toBe(true);
    await expect(installCard(page)).toHaveCount(0);
  });
});

test.describe('iPhone', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  test('captures the Safari install steps in Finnish', async ({ page }) => {
    await installHint(page, 'fi', 'ios', 'install-fi-iphone.png');
  });
  test('hides the install hint when opened from the Home Screen', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); });
    await openSettings(page, 'sv');
    expect(await page.evaluate(() => (navigator as Navigator & { standalone?: boolean }).standalone)).toBe(true);
    await expect(installCard(page)).toHaveCount(0);
  });
});

test.describe('mobile', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  test('captures the update prompt in Finnish', async ({ page }) => {
    await updatePrompt(page, 'fi', 'update-fi-mobile.png');
  });
  test('captures the install hint in Swedish', async ({ page }) => {
    await installHint(page, 'sv', 'other', 'install-sv-mobile.png');
  });
});

// I24: the update prompt and the install hint only exist in the production build, so their checks live here.
// The production CSP blocks injected style sheets, so 200% text is applied through the CSSOM instead.
const setLargeText = (page: Page, on: boolean) => page.evaluate((enlarged) => {
  document.documentElement.style.fontSize = enlarged ? '200%' : '';
  document.body.style.fontSize = enlarged ? '32px' : '';
}, on);
/**
 * These screens are signed in: exactly one skip link, off-screen until focused, the first Tab stop, then
 * fully visible with a focus ring, and Enter moves focus to #main.
 */
async function skipLink(page: Page, label: string) {
  const links = page.locator('.skip-link');
  await expect(page.locator('.workspace'), label).toHaveCount(1);
  expect(await links.count(), label).toBe(1);
  const hidden = await links.evaluate((element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.bottom <= 0;
  });
  expect(hidden, `${label} skip link off-screen until focused`).toBe(true);
  await page.evaluate(() => { document.documentElement.setAttribute('tabindex', '-1'); document.documentElement.focus(); });
  await page.keyboard.press('Tab');
  await page.evaluate(() => { document.documentElement.removeAttribute('tabindex'); });
  await expect(links, label).toBeFocused();
  expect(await links.evaluate((element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { inView: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
      ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 || style.boxShadow !== 'none' };
  }), label).toEqual({ inView: true, ring: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('#main'), label).toBeFocused();
}
async function narrowAndEnlarged(page: Page, scope: string, language: Language, capture?: string) {
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await page.setViewportSize({ width: 320, height: 800 });
  for (const enlarged of [false, true]) {
    await setLargeText(page, enlarged);
    const found = await page.evaluate((selector) => {
      const root = document.querySelector(selector)!;
      const clipped = [root, ...root.querySelectorAll('h2, p, span, button')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.getBoundingClientRect().right > innerWidth + 1)
        .map((element) => element.textContent);
      const small = [...root.querySelectorAll('button')].map((element) => element.getBoundingClientRect())
        .filter((box) => box.width < 44 || box.height < 44).length;
      return { overflow: document.documentElement.scrollWidth > innerWidth, clipped, small };
    }, scope);
    const label = `${scope} ${language} ${enlarged ? '200%' : '100%'}`;
    expect(found, label).toEqual({ overflow: false, clipped: [], small: 0 });
    await skipLink(page, label);
    expect((await new AxeBuilder({ page }).analyze()).violations, `${scope} ${language} axe`).toEqual([]);
    if (enlarged && capture) {
      await mkdir(path.join('test-results', 'i24-visual'), { recursive: true });
      await page.screenshot({ path: path.join('test-results', 'i24-visual', capture), fullPage: false });
    }
  }
  await setLargeText(page, false);
}

for (const language of languages) {
  test.describe(`I24 ${language}`, () => {
    test('the update prompt fits 320px and 200% text, passes axe and Reload takes focus by keyboard', async ({ page }) => {
      await signedIn(page, language);
      await server.setRoot(builds.b);
      expect((await updateAndSettle(page)).waiting).toBe(true);
      const status = page.getByRole('status').filter({ hasText: messages['update.available'][language] });
      await expect(status).toBeVisible();
      await narrowAndEnlarged(page, '.update-notice', language, language === 'sv' ? 'update-sv-320-200.png' : undefined);
      const reload = status.getByRole('button', { name: messages['update.reload'][language], exact: true });
      await page.locator('body').focus();
      for (let presses = 0; presses < 40 && !await reload.evaluate((element) => element === document.activeElement); presses++) await page.keyboard.press('Tab');
      await expect(reload).toBeFocused();
      expect(await reload.evaluate((element) => { const style = getComputedStyle(element);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 || style.boxShadow !== 'none'; })).toBe(true);
    });
    test('the install hint fits 320px and 200% text and passes axe', async ({ page }) => {
      await openSettings(page, language);
      await narrowAndEnlarged(page, 'section[aria-labelledby="install-heading"]', language);
    });
  });
}