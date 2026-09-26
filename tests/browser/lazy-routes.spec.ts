import { expect, test, type Page } from '@playwright/test';
import { translate, type Language } from '../../src/i18n';
import { mockBackend, signIn } from './mock-backend';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';
import { codePreloaded } from './lazy-support';
import { preloadDelayMs } from '../../src/app/lazy-load';

type Api = Awaited<ReturnType<typeof mockBackend>>;

async function start(page: Page, language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language });
  const saved = api.seedSavedItem('a', 'Lazy route shirt');
  await page.goto('/#/wardrobe'); await signIn(page);
  await expect(page.locator('.workspace-identity')).toBeVisible();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  return { api, saved };
}
async function go(page: Page, hash: string) {
  await page.evaluate(next => { location.hash = next; }, hash);
}
async function expectRoute(page: Page, heading: string) {
  await expect(page.locator(heading)).toBeVisible();
  await expect(page.locator(heading)).toBeFocused();
  await expect(page.locator('.chunk-error')).toHaveCount(0);
  await expect(page.locator('.chunk-loading')).toHaveCount(0);
}

const routes = [
  { name: 'Today', hash: '#/today', heading: '#today-title' },
  { name: 'Outfits', hash: '#/outfits', heading: '#outfits-title' },
  { name: 'New outfit', hash: '#/outfits/new', heading: '#outfit-editor-title' },
  { name: 'Calendar', hash: '#/calendar', heading: '#calendar-title' },
  { name: 'Settings', hash: '#/settings', heading: '#settings-title' },
  { name: 'Trash', hash: '#/trash', heading: '#trash-title' },
  { name: 'Add item', hash: '#/items/new', heading: '#capture-title' },
];

test.describe('lazy routes', () => {
  for (const route of routes) {
    test(`${route.name} loads on navigation and moves focus to its heading`, async ({ page }) => {
      await start(page);
      await go(page, route.hash);
      await expectRoute(page, route.heading);
      await go(page, '#/wardrobe');
      await expectRoute(page, '#wardrobe-title');
    });
  }

  test('a lazy route opens directly from its link', async ({ page }) => {
    const api = await mockBackend(page);
    api.seedSavedItem('a', 'Lazy route shirt');
    await page.goto('/#/trash'); await signIn(page);
    await expect(page.locator('#trash-title')).toBeVisible();
    await expect(page.locator('.chunk-error')).toHaveCount(0);
  });

  test('photo replacement loads from item detail', async ({ page }) => {
    const { saved } = await start(page);
    await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
    await expect(page.locator('#detail-title')).toHaveValue(saved.item.title as string);
    await page.getByRole('button', { name: translate('en', 'imageChange.replace'), exact: true }).click();
    await expectRoute(page, '#image-change-title');
  });

  test('page code preloads only after the workspace settles, and a reload right after sign-in works', async ({ page }) => {
    await page.addInitScript(() => { performance.setResourceTimingBufferSize(5000); });
    await start(page);
    await page.reload();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await codePreloaded(page);
    // Both times come from the reloaded page's own timeline: when the scheduler armed its delay and when page code was requested.
    const timing = await page.evaluate(() => ({
      armed: performance.getEntriesByName('chunks-preload-armed').map(entry => entry.startTime),
      requested: performance.getEntriesByType('resource')
        .filter(entry => /\/src\/features\/(today\/today-screen|outfits\/outfits-screen|profile\/profile-screen|settings\/trash-screen)\.tsx/.test(entry.name))
        .map(entry => entry.startTime),
    }));
    // React's development double effect arms and cancels one scheduler first; the last mark belongs to the one that ran.
    expect(timing.armed.length).toBeGreaterThan(0);
    expect(timing.requested.length).toBeGreaterThan(0);
    expect(Math.min(...timing.requested) - Math.max(...timing.armed)).toBeGreaterThanOrEqual(preloadDelayMs - 1);
  });

  test('pages opened after going offline still load', async ({ page, context }) => {
    await start(page);
    await codePreloaded(page);
    await context.setOffline(true);
    await expect(page.locator('.notice-offline')).toBeVisible();
    for (const route of routes) {
      await go(page, route.hash);
      await expectRoute(page, route.heading);
    }
  });

  for (const mode of ['loading', 'failed'] as const) {
    test(`the photo editor can be left while its code is ${mode}, keeping the photo and fields`, async ({ page }) => {
      const editor = /\/src\/images\/crop-editor\.tsx/;
      const held: Array<() => Promise<void>> = [];
      await page.route(editor, route => mode === 'failed' ? route.abort() : new Promise<void>(resolve => { held.push(() => route.continue().then(resolve)); }));
      const api = await aiFixture(page);
      await addAiPhoto(page, api);
      await expect(page.locator('#item-category')).not.toHaveValue('');
      await page.locator('#item-title').fill('Kept title');
      const photo = await page.locator('.capture-photo img').getAttribute('src');
      const category = await page.locator('#item-category').inputValue();
      await page.locator('#edit-photo').click();
      await expect(page.locator(mode === 'failed' ? '.chunk-error[role=alert]' : '.chunk-loading [role=status]')).toBeVisible();
      await expect(page.locator('#crop-rectangle')).toHaveCount(0);
      await page.locator('#crop-leave').click();
      await expect(page.locator('.chunk-error, .chunk-loading')).toHaveCount(0);
      await expect(page.locator('.capture-photo img')).toHaveAttribute('src', photo!);
      await expect(page.locator('#item-title')).toHaveValue('Kept title');
      await expect(page.locator('#item-category')).toHaveValue(category);
      await expect(page.locator('#edit-photo')).toBeFocused();
      await expect(page.locator('#photo-pending')).toHaveCount(0);
      await expect(page.locator('.save-actions button[type=submit]')).toBeEnabled();
      for (const release of held.splice(0)) await release();
      if (mode === 'loading') {
        await page.locator('#edit-photo').click();
        await expect(page.locator('#crop-rectangle')).toBeVisible();
      }
    });
  }

  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`a failed page download offers Reload (${language})`, async ({ page }) => {
      let blocked = 0;
      await page.route(/\/src\/features\/today\/today-screen\.tsx/, route => { blocked++; return route.abort(); });
      await start(page, language);
      await go(page, '#/today');
      const alert = page.locator('.chunk-error[role=alert]');
      await expect(alert).toContainText(translate(language, 'chunk.failed'));
      expect(blocked).toBeGreaterThan(0);
      await expect(page.locator('.workspace-identity')).toBeVisible();
      await page.unroute(/\/src\/features\/today\/today-screen\.tsx/);
      const reload = alert.getByRole('button', { name: translate(language, 'chunk.reload'), exact: true });
      await Promise.all([page.waitForEvent('load'), reload.click()]);
    });
  }
});

export type { Api };
