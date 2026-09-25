import { expect, test, type Page } from '@playwright/test';
import { messages } from '../../src/i18n';
import { mockBackend, signIn } from '../browser/mock-backend';
import { builds, readManifest } from './builds';
import { cacheName, controlled, entryScripts, expectOnlyShell, loadedScripts, serve, updateAndSettle, type DistServer } from './helpers';

let server: DistServer;
test.beforeEach(async () => { server = await serve('a'); });
test.afterEach(async () => { await server.close(); });

const prompt = (page: Page, language: 'en' | 'fi' | 'sv' = 'en') => page.getByRole('status').filter({ hasText: messages['update.available'][language] });
type Marked = Window & { marked?: boolean };
const shellCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith('stillroom-shell-')));

test('a new version waits for Reload, and another open tab keeps its input and is not reloaded', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  expect(await controlled(page)).toEqual([cacheName('a')]);
  const second = await context.newPage();
  const secondBackend = await mockBackend(second, { initialLanguage: 'en' });
  secondBackend.seedSavedItem('a', 'Synthetic scarf');
  await second.goto(server.url);
  await signIn(second);
  await expect(second.locator('#wardrobe-title')).toBeVisible();
  await second.locator('#wardrobe-search').fill('kept query');
  await second.evaluate(() => { (window as Marked).marked = true; });
  await server.setRoot(builds.b);
  expect(await updateAndSettle(page)).toEqual({ waiting: true, state: 'installed' });
  await expect(prompt(page)).toBeVisible();
  // Nothing changes until the user asks: this tab still runs A and A's cache is intact.
  expect(await loadedScripts(page)).toEqual(entryScripts('a'));
  expect((await shellCaches(page)).sort()).toEqual([cacheName('a'), cacheName('b')].sort());
  await prompt(page).getByRole('button', { name: messages['update.reload'].en, exact: true }).click();
  await expect.poll(() => loadedScripts(page).catch(() => [])).toEqual(entryScripts('b'));
  await expect.poll(() => shellCaches(page)).toEqual([cacheName('b')]);
  await expectOnlyShell(page, 'b');
  await expect(prompt(page)).toHaveCount(0);
  await expect(prompt(second)).toBeVisible();
  await expect(second.locator('#wardrobe-search')).toHaveValue('kept query');
  expect(await loadedScripts(second)).toEqual(entryScripts('a'));
  expect(await second.evaluate(() => (window as Marked).marked)).toBe(true);
  // A's lazy chunks are no longer precached; a route this tab has not opened yet either still loads (HTTP cache) or shows the chunk-error Reload, never a blank or signed-out screen.
  await second.evaluate(() => { location.hash = '#/outfits'; });
  await expect(second.locator('#outfits-title').or(second.getByText(messages['chunk.failed'].en))).toBeVisible();
  await expect(second.locator('.workspace-identity')).toContainText('Alex');
  await prompt(second).getByRole('button', { name: messages['update.reload'].en, exact: true }).click();
  await expect.poll(() => loadedScripts(second).catch(() => [])).toEqual(entryScripts('b'));
  expect(await second.evaluate(() => (window as Marked).marked)).toBeUndefined();
  await second.close();
});

test('a deploy that replaces index.html during install keeps the working version', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await server.setRoot(builds.torn);
  expect(await updateAndSettle(page)).toEqual({ waiting: false, state: 'redundant' });
  expect(await shellCaches(page)).toEqual([cacheName('a')]);
  await expectOnlyShell(page, 'a');
  await expect(prompt(page)).toHaveCount(0);
  await page.reload();
  expect(await loadedScripts(page)).toEqual(entryScripts('a'));
  // Once the deploy is consistent, the next check installs it normally.
  await server.setRoot(builds.b);
  expect(await updateAndSettle(page)).toEqual({ waiting: true, state: 'installed' });
  await expect(prompt(page)).toBeVisible();
});

test('the controlling version serves every navigation, also offline, without asking the network', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await server.setRoot(builds.b);
  const before = server.requests.length;
  await page.reload();
  expect(await loadedScripts(page)).toEqual(entryScripts('a'));
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  await context.setOffline(true);
  for (const route of ['#/today', '#/outfits', '#/wardrobe', '#/settings', '#/trash']) {
    await page.evaluate((hash) => { location.hash = hash; }, route);
    await expect(page.locator('.workspace-main')).toBeVisible();
    await expect(page.getByText(messages['chunk.failed'].en)).toHaveCount(0);
  }
  await expect(page.locator('#profile-heading, #trash-title, .workspace-main h1').first()).toBeVisible();
  await page.reload();
  expect(await loadedScripts(page)).toEqual(entryScripts('a'));
  await context.setOffline(false);
  expect(server.requests.slice(before).filter((entry) => entry.mode === 'navigate')).toEqual([]);
});

test('a controlling worker whose own shell is missing fails closed instead of running the live deploy under it', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  expect(await controlled(page)).toEqual([cacheName('a')]);
  await server.setRoot(builds.b);
  expect(await page.evaluate(async (name) => (await caches.open(name)).delete('/'), cacheName('a'))).toBe(true);
  const before = server.requests.length;
  await expect(page.goto(server.url)).rejects.toThrow();
  // The worker neither served B's HTML nor asked the host for it, and it stepped aside.
  expect(server.requests.slice(before).filter((entry) => entry.mode === 'navigate')).toEqual([]);
  // Once it has unregistered, the next load is an ordinary uncontrolled network load of the live deploy.
  await expect(async () => {
    const response = await page.goto(server.url);
    expect(response?.fromServiceWorker()).toBe(false);
  }).toPass({ timeout: 5000 });
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
  expect(await loadedScripts(page)).toEqual(entryScripts('b'));
});

test('with no controller the worker takes no part: navigations are network loads and nothing is stored', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  const before = server.requests.length;
  const first = await page.goto(server.url);
  expect(first?.fromServiceWorker()).toBe(false);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
  expect(server.requests.slice(before).filter((entry) => entry.mode === 'navigate').map((entry) => entry.pathname)).toEqual(['/']);
  await controlled(page);
  // After activation the same navigation is answered by the controller.
  expect((await page.reload())?.fromServiceWorker()).toBe(true);
  await expectOnlyShell(page, 'a');
});

test('a worker-only update gets its own cache, and a failed store during its install leaves the working worker serving offline', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  expect(await controlled(page)).toEqual([cacheName('a')]);
  expect(readManifest('aw').files).toEqual(readManifest('a').files);
  expect(cacheName('aw')).not.toBe(cacheName('a'));
  await server.setRoot(builds.aw);
  // Hold the new worker's install at its manifest request, then make every Cache.put in it fail.
  const release = server.hold('/precache-manifest.json');
  const installing = context.waitForEvent('serviceworker');
  const settled = updateAndSettle(page);
  const next = await installing;
  await next.evaluate(() => { Cache.prototype.put = () => Promise.reject(new Error('Injected cache.put failure')); });
  release();
  expect(await settled).toEqual({ waiting: false, state: 'redundant' });
  expect((await shellCaches(page)).sort()).toEqual([cacheName('a')]);
  await expectOnlyShell(page, 'a');
  await context.setOffline(true);
  await page.reload();
  expect(await loadedScripts(page)).toEqual(entryScripts('a'));
  await expect(page.locator('#email')).toBeVisible();
  await context.setOffline(false);
  // Without the fault the same worker-only release installs into its own cache beside A's.
  expect(await updateAndSettle(page)).toEqual({ waiting: true, state: 'installed' });
  expect((await shellCaches(page)).sort()).toEqual([cacheName('a'), cacheName('aw')].sort());
});
test('the emergency worker removes only Stillroom caches and itself while an open tab keeps working', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await page.evaluate(async () => { await (await caches.open('unrelated-cache')).put('/unrelated', new Response('kept')); });
  await page.locator('#email').fill('kept@example.test');
  await server.setRoot(builds.kill);
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(() => caches.keys())).toEqual(['unrelated-cache']);
  await expect(page.locator('#email')).toHaveValue('kept@example.test');
  await page.locator('#email').fill('');
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  // The kill-switch build's page registers nothing, so the next load stays uncontrolled.
  await page.reload();
  await expect(page.locator('.workspace-identity, #email').first()).toBeVisible();
  expect(await page.evaluate(async () => ({
    controller: Boolean(navigator.serviceWorker.controller), registrations: (await navigator.serviceWorker.getRegistrations()).length,
  }))).toEqual({ controller: false, registrations: 0 });
});
