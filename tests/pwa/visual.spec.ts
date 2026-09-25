import { devices, expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { messages, type Language } from '../../src/i18n';
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
