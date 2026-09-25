import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, signIn } from './mock-backend';

const text = (language: Language, key: MessageKey) => translate(language, key);
const routes = [
  { name: 'Wardrobe', hash: '#/', heading: '#wardrobe-title' },
  { name: 'Today', hash: '#/today', heading: '#today-title' },
  { name: 'Outfits', hash: '#/outfits', heading: '#outfits-title' },
  { name: 'Settings', hash: '#/settings', heading: '#settings-title' },
] as const;
const largeText = 'html { font-size: 200%; } body { font-size: 32px; }';

async function start(page: Page, language: Language) {
  const api = await mockBackend(page, { initialLanguage: language });
  api.seedSavedItem('a', 'Fictional linen shirt');
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  return { api, errors };
}
async function open(page: Page, route: typeof routes[number]) {
  await page.evaluate(hash => { location.hash = hash; }, route.hash);
  await expect(page.locator(route.heading)).toBeVisible();
  await expect(page.locator('.chunk-loading, [aria-busy=true]')).toHaveCount(0);
}

// Headings start at one h1 and never skip a level; nothing scrolls sideways; controls are at least 44px, except links inside running text.
async function layout(page: Page) {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(shown).map(heading => Number(heading.tagName[1]));
    const skipped = levels.some((level, index) => index > 0 && level > levels[index - 1]! + 1);
    const small = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]')]
      .filter(element => shown(element) && !(element.matches('a') && element.closest('p')))
      .map(element => ({ element, box: (element.matches('input[type=checkbox], input[type=radio]') ? element.closest('label') ?? element : element).getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ element, box }) => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    return { h1: levels.filter(level => level === 1).length, first: levels[0], skipped, small, overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function expectLayout(page: Page) {
  expect(await layout(page)).toEqual({ h1: 1, first: 1, skipped: false, small: [], overflow: false });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function expectVisibleFocus(page: Page, stops = 30) {
  const hidden: string[] = [];
  let reached = 0;
  for (let index = 0; index < stops; index++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return { name: `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}"`,
        visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 || style.boxShadow !== 'none' };
    });
    if (!focus) continue;
    reached++;
    if (!focus.visible) hidden.push(focus.name);
  }
  expect(reached).toBeGreaterThan(0);
  expect([...new Set(hidden)]).toEqual([]);
}

test('the manifest describes an installable standalone app and no service worker is registered', async ({ page }) => {
  const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8')) as Record<string, unknown>;
  expect(manifest).toMatchObject({ name: 'Stillroom Wardrobe', short_name: 'Stillroom', start_url: '/', scope: '/', display: 'standalone',
    theme_color: '#F6F3ED', background_color: '#F6F3ED' });
  expect(manifest.icons).toEqual([
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  const { api } = await start(page, 'en');
  void api;
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('meta[name=theme-color]')).toHaveAttribute('content', '#F6F3ED');
  expect((await page.request.get('/icon.svg')).ok()).toBe(true);
  // Each PNG is served as a PNG of its declared size. Maskable and Apple icons are opaque, because the platform crops them.
  const png = async (src: string) => {
    const response = await page.request.get(src);
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
    return { size: `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, alpha: bytes[25] === 4 || bytes[25] === 6 };
  };
  expect(await png('/icon-192.png')).toEqual({ size: '192x192', alpha: true });
  expect(await png('/icon-512.png')).toEqual({ size: '512x512', alpha: true });
  expect(await png('/icon-maskable-512.png')).toEqual({ size: '512x512', alpha: false });
  expect(await png('/apple-touch-icon.png')).toEqual({ size: '180x180', alpha: false });
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(await page.evaluate(async () => ({
    workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    caches: 'caches' in window ? (await caches.keys()).length : 0,
  }))).toEqual({ workers: 0, caches: 0 });
});

for (const language of languages) {
  test(`accessibility sweep ${language}: sign-in and every main route at 320px and 200% text`, async ({ page }) => {
    test.setTimeout(120_000);
    const { errors } = await start(page, language);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: text(language, `language.${language}`), exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('#login-title')).toBeVisible();
    await expectLayout(page);
    await signIn(page);
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    for (const route of routes) {
      await open(page, route);
      await expectLayout(page);
      await page.locator(route.heading).focus();
      await expectVisibleFocus(page);
      const style = await page.addStyleTag({ content: largeText });
      await expectLayout(page);
      await style.evaluate(node => { (node as HTMLStyleElement).remove(); });
    }
    expect(errors).toEqual([]);
  });
}

test('the backup card keeps a gap between Create backup and the JSON download', async ({ page }) => {
  await start(page, 'en');
  await page.goto('/#/settings'); await signIn(page);
  const card = page.locator('.backup-card');
  const create = card.getByRole('button', { name: text('en', 'backup.create'), exact: true });
  const json = card.getByRole('button', { name: text('en', 'backup.json'), exact: true });
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const [top, bottom] = [await create.boundingBox(), await json.boundingBox()];
    expect(bottom!.y - (top!.y + top!.height)).toBeGreaterThanOrEqual(16);
  }
});

test('going offline keeps every main route open with a plain offline notice', async ({ page, context }) => {
  const { errors } = await start(page, 'fi');
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  for (const route of routes) await open(page, route);
  await context.setOffline(true);
  const notice = page.locator('.notice-offline[role=status]');
  for (const route of routes) {
    await open(page, route);
    await expect(notice).toHaveText(`${text('fi', 'common.offline')} ${text('fi', 'common.stale')}`);
    await expect(page.locator('.fatal-error, .chunk-error')).toHaveCount(0);
    if (route.name === 'Wardrobe') await expect(page.getByText('Fictional linen shirt').first()).toBeVisible();
  }
  await context.setOffline(false);
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('opening the app while the backend is unreachable explains it and recovers with Try again', async ({ page, context }) => {
  const { errors } = await start(page, 'sv');
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  const unreachable = (route: import('@playwright/test').Route) => route.abort('internetdisconnected');
  await page.route('http://127.0.0.1:54321/**', unreachable);
  await page.reload();
  // The profile language cannot load, so the page starts in the default language and the language buttons still work.
  await expect(page.getByRole('heading', { level: 1, name: text('en', 'common.errorTitle') })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(text('en', 'account.locked'))).toBeVisible();
  await page.getByRole('button', { name: text('sv', 'language.sv'), exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: text('sv', 'common.errorTitle') })).toBeVisible();
  await expect(page.getByText(text('sv', 'account.locked'))).toBeVisible();
  await expect(page.locator('.fatal-error')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: text('sv', 'common.retry'), exact: true })).toBeDisabled();
  await context.setOffline(false);
  await page.unroute('http://127.0.0.1:54321/**', unreachable);
  await page.getByRole('button', { name: text('sv', 'common.retry'), exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.getByText('Fictional linen shirt').first()).toBeVisible();
  expect(errors).toEqual([]);
});
