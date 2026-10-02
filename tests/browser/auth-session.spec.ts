import { expect, test, type Page } from '@playwright/test';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, signIn, type AuthControl } from './mock-backend';
import { expectIdentity, expectSignedIn, openAccountMenu } from './shell-support';

// AUTH1a: per-tab sessions keep only the two tokens and the expiry, never anything private, and a lapsed or
// unreachable session shows no private state.
const text = (key: MessageKey, language: Language = 'en') => translate(language, key);
const backend = 'http://127.0.0.1:54321';

async function start(page: Page, auth: AuthControl = {}) {
  const api = await mockBackend(page, { initialLanguage: 'en', auth });
  api.seedSavedItem('a', 'Synthetic linen shirt');
  await page.goto('/#/wardrobe');
  await signIn(page);
  await expectSignedIn(page);
  await expectIdentity(page, 'Alex');
  return api;
}
async function signOut(page: Page, language: Language = 'en') {
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('button', { name: text('auth.signOut', language), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
}
/** Everything this origin keeps on the device, for checks that nothing private is there. */
function deviceState(page: Page) {
  return page.evaluate(async () => {
    const entries = (store: Storage) => Object.fromEntries(Array.from({ length: store.length }, (_, index) => {
      const key = store.key(index)!;
      return [key, store.getItem(key) ?? ''];
    }));
    const cached: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) cached.push(request.url);
    }
    const databases = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((database) => database.name ?? '') : [];
    return { session: entries(sessionStorage), local: entries(localStorage), cached, databases };
  });
}
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string };
async function heldRecord(page: Page) {
  const raw = await page.evaluate(() => sessionStorage.getItem('stillroom.auth'));
  return raw === null ? null : JSON.parse(raw) as Record<string, unknown>;
}
async function expectNothingPrivate(page: Page) {
  const state = await deviceState(page);
  expect(Object.keys(state.session).filter((key) => key.startsWith('stillroom.auth'))).toEqual(['stillroom.auth']);
  expect(Object.keys(JSON.parse(state.session['stillroom.auth'] ?? '{}') as object).sort()).toEqual(['access_token', 'expires_at', 'refresh_token']);
  expect(Object.keys(state.local).filter((key) => key.startsWith('stillroom.auth'))).toEqual([]);
  const values = JSON.stringify([state.session, state.local]);
  for (const secret of ['Alex', 'Robin', 'user-a@example.test', 'user-b@example.test', 'Synthetic linen shirt', 'user_metadata']) expect(values).not.toContain(secret);
  expect(state.cached.filter((url) => url.startsWith(backend))).toEqual([]);
  expect(state.databases).toEqual([]);
}
async function waitingCard(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: text('auth.offlineWaiting') })).toBeVisible();
  await expect(page.getByRole('button', { name: text('auth.signOut'), exact: true })).toBeVisible();
  await expect(page.getByText('Alex')).toHaveCount(0);
  await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
}

test.describe('AUTH1a per-tab sessions', () => {
  test('keeps only the tokens and expiry in this tab, nothing private on the device, across a reload', async ({ page }) => {
    await start(page);
    await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
    await expectNothingPrivate(page);
    const before = await heldRecord(page);
    expect(claims(String(before?.access_token)).sub).toBe(owners.a);
    await page.reload();
    await expectSignedIn(page);
    await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
    expect(await heldRecord(page)).toEqual(before);
    await expectNothingPrivate(page);
  });

  test('keeps the allowlisted form when the session is renewed', async ({ page }) => {
    const auth: AuthControl = { lifetime: 60 };
    await start(page, auth);
    // A 60 s token is inside the SDK's renewal margin, so it is renewed at once.
    await expect.poll(() => auth.refreshes ?? 0).toBeGreaterThan(0);
    await expectNothingPrivate(page);
    await page.reload();
    await expectSignedIn(page);
    await expectNothingPrivate(page);
  });

  test('reopens offline to the waiting card with nothing private, then opens once back online', async ({ page }) => {
    await start(page);
    const before = await heldRecord(page);
    await page.addInitScript(() => {
      const state = window as unknown as { __offline?: boolean };
      state.__offline = sessionStorage.getItem('test.offline') === '1';
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !state.__offline });
    });
    await page.evaluate(() => sessionStorage.setItem('test.offline', '1'));
    const unreachable = (route: import('@playwright/test').Route) => route.abort('internetdisconnected');
    await page.route(`${backend}/**`, unreachable);
    await page.reload();
    await waitingCard(page);
    // The credentials stay for the retry.
    expect(await heldRecord(page)).toEqual(before);
    await page.unroute(`${backend}/**`, unreachable);
    await page.evaluate(() => {
      sessionStorage.removeItem('test.offline');
      (window as unknown as { __offline?: boolean }).__offline = false;
      window.dispatchEvent(new Event('online'));
    });
    await expectSignedIn(page);
    await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
  });

  test('signs out from the waiting card without the network', async ({ page }) => {
    await start(page);
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
    await page.route(`${backend}/**`, (route) => route.abort('internetdisconnected'));
    await page.reload();
    await waitingCard(page);
    await page.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    expect((await deviceState(page)).session['stillroom.auth']).toBeUndefined();
  });

  for (const outcome of ['renewed', 'refused', 'unreachable'] as const) {
    test(`a session that lapses while open is ${outcome}`, async ({ page }) => {
      const auth: AuthControl = {};
      await page.clock.install();
      const api = await start(page, auth);
      await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
      const before = await heldRecord(page);
      auth.refresh = outcome === 'renewed' ? 'ok' : outcome === 'refused' ? 400 : 'offline';
      await page.clock.fastForward('01:01:00');
      if (outcome === 'unreachable') await page.clock.runFor(40_000);
      if (outcome === 'renewed') {
        await expectSignedIn(page);
        await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
        await expect.poll(async () => (await heldRecord(page))?.access_token).not.toBe(before?.access_token);
        await expectNothingPrivate(page);
      } else if (outcome === 'refused') {
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.getByText(text('auth.expired'))).toBeVisible();
        await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
        expect((await deviceState(page)).session['stillroom.auth']).toBeUndefined();
        expect(api.requests.filter((request) => request.path === '/auth/v1/logout')).toEqual([]);
      } else {
        await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
        await expect(page.locator('.entry-card h1')).toBeVisible();
        await expect(page.getByText('Alex')).toHaveCount(0);
        expect(await heldRecord(page)).toEqual(before);
      }
    });
  }

  test('a renewal that stalls online at expiry removes the wardrobe and its photos at once', async ({ page }) => {
    const auth: AuthControl = {};
    await page.addInitScript(() => {
      const created: string[] = [], revoked: string[] = [];
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (object) => { const url = create(object); created.push(url); return url; };
      URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
      (window as unknown as { __urls: unknown }).__urls = { created, revoked };
    });
    await page.clock.install();
    await start(page, auth);
    await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
    await expect(page.locator('img[src^="blob:"]').first()).toBeVisible();
    auth.refresh = 'stall';
    await page.clock.fastForward('01:01:00');
    await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
    await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
    await expect(page.getByText('Alex')).toHaveCount(0);
    const urls = await page.evaluate(() => (window as unknown as { __urls: { created: string[]; revoked: string[] } }).__urls);
    expect(urls.created.length).toBeGreaterThan(0);
    expect(urls.created.filter((url) => !urls.revoked.includes(url))).toEqual([]);
  });

  test('a sign-out in one tab signs the other tabs out', async ({ page, context }) => {
    await start(page);
    const other = await context.newPage();
    await mockBackend(other, { initialLanguage: 'en' });
    await other.goto('/#/wardrobe');
    await signIn(other, 'b');
    await expectSignedIn(other);
    // Each tab holds its own account.
    expect(claims(String((await heldRecord(other))?.access_token)).sub).toBe(owners.b);
    expect(claims(String((await heldRecord(page))?.access_token)).sub).toBe(owners.a);
    await signOut(page);
    await expect(other.locator('#email')).toBeVisible();
    expect(await heldRecord(other)).toBeNull();
    expect(await heldRecord(page)).toBeNull();
  });

  test('switching accounts in a tab holds and shows only the new account', async ({ page }) => {
    await start(page);
    await signOut(page);
    await signIn(page, 'b');
    await expectSignedIn(page);
    await expectIdentity(page, 'Robin');
    await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
    expect(claims(String((await heldRecord(page))?.access_token)).sub).toBe(owners.b);
    await expectNothingPrivate(page);
  });
});
