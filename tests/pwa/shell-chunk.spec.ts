import { expect, test, type Page } from '@playwright/test';
import { messages, type MessageKey } from '../../src/i18n';
import { mockBackend, signIn } from '../browser/mock-backend';
import { expectIdentity, expectSignedIn, shellNav } from '../browser/shell-support';
import { serve, type DistServer } from './helpers';

// UX1 in the production build: the signed-in navigation (shell-nav) is one module plus its stylesheet. Hold or fail
// only the stylesheet while its script downloads normally. The plain fallback links must stay until both have
// arrived, and only one navigation landmark may be exposed at any moment, including while the parts arrive.
// Route interception needs the requests outside the service worker, so it is blocked here; cache.spec.ts covers it.
test.use({ serviceWorkers: 'block' });
const text = (key: MessageKey) => messages[key].en;
const isShellCss = (url: URL) => /^\/assets\/shell-nav-[\w-]+\.css$/.test(url.pathname);
const isShellJs = (url: URL) => /^\/assets\/shell-nav-[\w-]+\.js$/.test(url.pathname);

let server: DistServer;
test.beforeEach(async () => { server = await serve('a'); });
test.afterEach(async () => { await server.close(); });

// Samples every frame: the most navigation landmarks shown at once (rendered, not display:none or visibility:hidden).
async function watchLandmarks(page: Page) {
  await page.addInitScript(() => {
    const exposed = () => [...document.querySelectorAll('nav, [role=navigation]')].filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && !element.closest('[hidden], [aria-hidden=true], [inert]');
    }).length;
    const state = { max: 0, frames: 0 };
    (window as unknown as { landmarks: typeof state }).landmarks = state;
    const sample = () => { if (document.querySelector('.workspace')) { state.max = Math.max(state.max, exposed()); state.frames++; } requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
  });
}
const landmarks = (page: Page) => page.evaluate(() => (window as unknown as { landmarks: { max: number; frames: number } }).landmarks);

async function held(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await watchLandmarks(page);
  const api = await mockBackend(page, { initialLanguage: 'en' });
  api.seedSavedItem('a', 'Synthetic garment 1');
  let release!: (outcome: 'load' | 'fail') => void;
  const outcome = new Promise<'load' | 'fail'>(resolve => { release = resolve; });
  await page.route(isShellCss, async route => {
    if (await outcome === 'fail') await route.abort('failed'); else await route.fallback();
  });
  await page.goto(server.url);
  await signIn(page);
  const fallback = page.locator('.shell-fallback');
  await expect(fallback).toBeVisible();
  // The script itself downloads; only its stylesheet is outstanding.
  await expect.poll(() => server.requests.some(entry => isShellJs(new URL(entry.pathname, server.url)))).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.locator('nav.top-nav, nav.tab-bar, #account-trigger')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(1);
  await expect(fallback.getByRole('button', { name: text('auth.signOut'), exact: true })).toBeVisible();
  await page.locator('#wardrobe-search').fill('navy');
  await fallback.getByRole('link', { name: text('nav.outfits'), exact: true }).focus();
  return { release, fallback };
}

for (const width of [390, 1280]) {
  test(`${width}px: a held stylesheet keeps the plain links until the styled navigation replaces them`, async ({ page }) => {
    const { release, fallback } = await held(page, width);
    release('load');
    await expectSignedIn(page);
    await expect(fallback).toHaveCount(0);
    await expect(shellNav(page).getByRole('link', { name: text('nav.outfits'), exact: true })).toBeFocused();
    await expect(page.locator('#wardrobe-search')).toHaveValue('navy');
    await expect(page.getByRole('navigation')).toHaveCount(1);
    // Styled: the hidden one of the two navigations is hidden by the loaded stylesheet.
    await expect(page.locator(width <= 650 ? 'nav.top-nav' : 'nav.tab-bar')).toBeHidden();
    await expectIdentity(page, 'Alex');
    const seen = await landmarks(page);
    expect(seen.frames).toBeGreaterThan(10);
    expect(seen.max).toBe(1);
  });

  test(`${width}px: a failed stylesheet keeps the plain links, what was typed and Sign out, and never shows the unstyled navigation`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    const { release, fallback } = await held(page, width);
    release('fail');
    await expect(page.locator('.shell-failed')).toHaveText(`${text('shell.failed')} ${text('chunk.reload')}`);
    await page.waitForTimeout(300);
    await expect(page.locator('nav.top-nav, nav.tab-bar, #account-trigger')).toHaveCount(0);
    await expect(page.locator('.fatal-error')).toHaveCount(0);
    await expect(page.locator('#wardrobe-search')).toHaveValue('navy');
    await expect(fallback.getByRole('link', { name: text('nav.outfits'), exact: true })).toBeFocused();
    await expect(page.getByRole('navigation')).toHaveCount(1);
    const seen = await landmarks(page);
    expect(seen.frames).toBeGreaterThan(10);
    expect(seen.max).toBe(1);
    expect(errors).toEqual([]);
    await fallback.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
  });
}

// UX6 in the production build: the Filters sheet's frame (named dialog, focusable heading, Close and safe geometry) is
// part of the start page; its options and their stylesheet load on demand. Hold or fail each part separately.
const isSheetPart = (kind: 'js' | 'css') => (url: URL) => new RegExp(`^/assets/filter-sheet-[\\w-]+\\.${kind}$`).test(url.pathname);
for (const kind of ['js', 'css'] as const) {
  for (const result of ['load', 'fail'] as const) {
    for (const width of [390, 1280]) {
      test(`${width}px: the Filters sheet with its ${kind === 'js' ? 'script' : 'stylesheet'} held, then ${result === 'load' ? 'arriving' : 'failing'}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => { errors.push(error.message); });
        await page.setViewportSize({ width, height: 844 });
        const api = await mockBackend(page, { initialLanguage: 'en' });
        for (let index = 0; index < 3; index++) api.seedSavedItem('a', `Synthetic garment ${index + 1}`);
        let release!: (outcome: 'load' | 'fail') => void;
        const outcome = new Promise<'load' | 'fail'>(resolve => { release = resolve; });
        await page.route(isSheetPart(kind), async route => {
          if (await outcome === 'fail') await route.abort('failed'); else await route.fallback();
        });
        await page.goto(server.url);
        await signIn(page);
        await expectSignedIn(page);
        await expect(page.locator('.item-card')).toHaveCount(3);
        await page.locator('#wardrobe-search').fill('Synthetic');
        await page.locator('#wardrobe-sort').selectOption('name');
        const filters = page.locator('.wardrobe-filter-button'), sheet = page.locator('dialog.filter-sheet');
        await filters.click();
        await expect(page.getByRole('dialog', { name: text('common.filters'), exact: true })).toBeVisible();
        await expect(page.locator('#filter-sheet-title')).toBeFocused();
        const close = sheet.getByRole('button', { name: text('common.close'), exact: true });
        await expect(close).toBeVisible();
        await expect(sheet.locator('.chunk-loading')).toBeVisible();
        await expect(sheet.locator('.wardrobe-facet-grid')).toHaveCount(0);
        const fits = await sheet.evaluate(dialog => {
          const box = dialog.getBoundingClientRect();
          return box.left >= -0.5 && box.right <= innerWidth + 0.5 && box.top >= -0.5 && box.bottom <= innerHeight + 0.5 && box.width >= 280;
        });
        expect(fits).toBe(true);
        release(result);
        if (result === 'load') {
          await expect(sheet.locator('.wardrobe-facet-grid')).toBeVisible();
          await sheet.locator('input[name="category"][value="top"]').check();
          await sheet.getByRole('button', { name: messages['wardrobe.showItems_other'].en.replace('{count}', '3'), exact: true }).click();
          await expect(page.locator('.filter-chip')).toHaveCount(1);
        } else {
          await expect(sheet.getByRole('alert')).toContainText(text('chunk.failed'));
          await expect(page.locator('.fatal-error')).toHaveCount(0);
          await close.click();
          await expect(page.locator('.filter-chip')).toHaveCount(0);
        }
        await expect(sheet).toHaveCount(0);
        await expect(filters).toBeFocused();
        await expect(page.locator('#wardrobe-search')).toHaveValue('Synthetic');
        await expect(page.locator('#wardrobe-sort')).toHaveValue('name');
        await expect(page.locator('.item-card')).toHaveCount(3);
        expect(errors).toEqual([]);
      });
    }
  }
}
