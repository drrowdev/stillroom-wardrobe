import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, recoveryHash, signIn, type AuthControl } from './mock-backend';
import { expectIdentity, expectSignedIn, openAccountMenu } from './shell-support';

// AUTH1b: "Keep me signed in on this device". One window holds the remembered session under a Web Lock; every other
// window waits. Only the two tokens and the expiry are kept, and only in that one slot.
const text = (key: MessageKey, language: Language = 'en') => translate(language, key);
const key = 'stillroom.auth';
type Backend = Awaited<ReturnType<typeof mockBackend>>;

async function open(page: Page, auth: AuthControl = {}) {
  const api = await mockBackend(page, { initialLanguage: 'en', auth });
  api.seedSavedItem('a', 'Synthetic linen shirt');
  await recordChannels(page);
  await page.goto('/#/wardrobe');
  return api;
}
const remember = (page: Page) => page.getByRole('checkbox', { name: text('auth.remember'), exact: true });
async function signInRemembered(page: Page, account: 'a' | 'b' = 'a') {
  await page.locator('#email').fill(`user-${account}@example.test`);
  await page.locator('#password').fill('fictional-test-password');
  await expect(remember(page)).not.toBeChecked();
  await remember(page).check();
  await page.locator('button[type="submit"]').click();
}
const slot = (page: Page) => page.evaluate((name) => localStorage.getItem(name), key);
const own = (page: Page) => page.evaluate((name) => sessionStorage.getItem(name), key);
const claims = (raw: string | null) => {
  const record = JSON.parse(raw ?? '{}') as { access_token?: string };
  return JSON.parse(Buffer.from((record.access_token ?? '').split('.')[1] ?? '', 'base64url').toString()) as { sub: string };
};
const logouts = (api: Backend, owner?: string) => api.requests.filter((request) => request.path === '/auth/v1/logout' && (!owner || request.owner === owner));
const authRequests = (api: Backend) => api.requests.filter((request) => request.path.startsWith('/auth/'));
async function signOut(page: Page) {
  const menu = await openAccountMenu(page, 'en');
  await menu.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
}
/** Records every message this page posts on either auth channel, and its legacy storage fallback. */
async function recordChannels(page: Page) {
  await page.addInitScript(() => {
    const posts: unknown[] = [];
    (window as unknown as { __posts: unknown[] }).__posts = posts;
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, message: unknown) {
      if (this.name === 'stillroom.auth.v2' || this.name === 'stillroom.logout') posts.push([this.name, message]);
      return post.call(this, message);
    };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      if (name === 'stillroom.logout') posts.push([name, value]);
      return set.call(this, name, value);
    };
  });
}
const posts = (page: Page) => page.evaluate(() => (window as unknown as { __posts: unknown[] }).__posts);
async function otherWindowCard(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: text('auth.otherWindow') })).toBeFocused();
  await expect(page.getByText(text('auth.otherWindowHint'), { exact: true })).toBeVisible();
  await expect(page.locator('.entry-card button')).toHaveCount(0);
  await expect(page.getByText('Alex')).toHaveCount(0);
  await expect(page.getByText('Synthetic linen shirt')).toHaveCount(0);
}
/** Only the allowlisted slot, nothing private, no caches or databases. */
async function expectOnlySlot(page: Page) {
  const state = await page.evaluate(async () => {
    const entries = (store: Storage) => Object.fromEntries(Array.from({ length: store.length }, (_, index) => [store.key(index)!, store.getItem(store.key(index)!) ?? '']));
    const databases = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((database) => database.name ?? '') : [];
    return { local: entries(localStorage), session: entries(sessionStorage), caches: await caches.keys(), databases };
  });
  expect(Object.keys(state.local).filter((name) => name.startsWith('stillroom.auth'))).toEqual([key]);
  expect(Object.keys(JSON.parse(state.local[key] ?? '{}') as object).sort()).toEqual(['access_token', 'expires_at', 'refresh_token']);
  expect(Object.keys(state.session).filter((name) => name.startsWith('stillroom.auth'))).toEqual([]);
  const values = JSON.stringify([state.local, state.session]);
  for (const secret of ['Alex', 'Robin', 'user-a@example.test', 'user-b@example.test', 'Synthetic linen shirt', 'user_metadata']) expect(values).not.toContain(secret);
  expect(state.caches).toEqual([]);
  expect(state.databases).toEqual([]);
}
/** A later start of the app after it was closed: the device's localStorage, none of the closed tab's sessionStorage. */
async function reopen(from: BrowserContext) {
  const state = await from.storageState();
  return from.browser()!.newContext({ ...test.info().project.use, storageState: state });
}

test.describe('AUTH1b remember on this device', () => {
  test('the checkbox starts unticked with a 44 px target, and a ticked sign-in keeps only the slot', async ({ page }) => {
    const api = await open(page);
    await expect(remember(page)).not.toBeChecked();
    const box = await page.locator('label.check').filter({ has: remember(page) }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await signInRemembered(page);
    await expectSignedIn(page);
    await expect(page.getByText('Synthetic linen shirt')).toBeVisible();
    await expectOnlySlot(page);
    expect(claims(await slot(page)).sub).toBe(owners.a);
    await page.reload();
    await expectIdentity(page, 'Alex');
    await expectOnlySlot(page);
    // The sign-in client's teardown and the reload released the committed record: nothing revoked it.
    expect(logouts(api)).toEqual([]);
    // Signed out and back to the screen: the checkbox is unticked again.
    await signOut(page);
    await expect(remember(page)).not.toBeChecked();
    expect(await slot(page)).toBeNull();
  });

  test('ticked: a new window after closing the old one, and a reopened app, open as the same owner', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    await page.close();
    const second = await context.newPage();
    await open(second);
    await expectIdentity(second, 'Alex');
    expect(await slot(second)).toBe(record);
    const later = await reopen(context);
    try {
      const third = await later.newPage();
      await open(third);
      await expectIdentity(third, 'Alex');
      await expect(third.getByText('Synthetic linen shirt')).toBeVisible();
    } finally { await later.close(); }
  });

  test('unticked: a reload stays signed in, a new window and a reopened app show sign-in', async ({ page, context }) => {
    await open(page);
    await signIn(page);
    await expectIdentity(page, 'Alex');
    await page.reload();
    await expectIdentity(page, 'Alex');
    expect(await slot(page)).toBeNull();
    const second = await context.newPage();
    await open(second);
    await expect(second.locator('#email')).toBeVisible();
    const later = await reopen(context);
    try {
      const third = await later.newPage();
      await open(third);
      await expect(third.locator('#email')).toBeVisible();
      expect(await slot(third)).toBeNull();
    } finally { await later.close(); }
  });

  test('a second window waits with no private data and no requests, then adopts when the first closes', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    const second = await context.newPage();
    const api = await open(second);
    await otherWindowCard(second);
    expect(authRequests(api)).toEqual([]);
    expect(api.requests.filter((request) => request.path.startsWith('/rest/'))).toEqual([]);
    expect(await slot(second)).toBe(record);
    await page.close();
    await expectIdentity(second, 'Alex');
    await expect(second.getByText('Synthetic linen shirt')).toBeVisible();
    await expect(second.locator('#wardrobe-title')).toBeFocused();
  });

  test('a holder refresh in flight: the waiting window touches nothing, then adopts the rotated record', async ({ page, context }) => {
    // A 60 s token is inside the SDK's renewal margin, so the holder renews at once; hold that first renewal.
    const auth: AuthControl = { lifetime: 60 };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let renewals = 0;
    await open(page, auth);
    await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=refresh_token', async (route) => {
      if (++renewals === 1) await held;
      await route.fallback();
    });
    await signInRemembered(page);
    // The renewal starts as soon as the session is committed; the holder waits on it.
    await expect.poll(() => renewals).toBe(1);
    const before = await slot(page);
    const second = await context.newPage();
    const api = await open(second);
    await otherWindowCard(second);
    expect(await slot(second)).toBe(before);
    release();
    await expectIdentity(page, 'Alex');
    await expect.poll(() => slot(page)).not.toBe(before);
    const rotated = await slot(page);
    expect(Object.keys(JSON.parse(rotated ?? '{}') as object).sort()).toEqual(['access_token', 'expires_at', 'refresh_token']);
    await otherWindowCard(second);
    expect(authRequests(api)).toEqual([]);
    await page.close();
    // The first refresh token was spent by the rotation, so only the rotated record can open here.
    await expectIdentity(second, 'Alex');
    await expect(second.getByText('Synthetic linen shirt')).toBeVisible();
  });

  test('the holder signs out: the slot is gone before the waiting window gets the lock, which then shows sign-in', async ({ page, context }) => {
    const api = await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const second = await context.newPage();
    await open(second);
    await otherWindowCard(second);
    await signOut(page);
    await expect(second.locator('#email')).toBeVisible();
    await expect(second.getByText('Alex')).toHaveCount(0);
    expect(await slot(second)).toBeNull();
    await expect.poll(() => logouts(api, owners.a).length).toBe(1);
  });

  test('a ticked sign-in while another window holds the slot takes nothing, revokes its own session once and waits', async ({ page, context }) => {
    const second = await context.newPage();
    const api = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    await signInRemembered(second, 'b');
    await otherWindowCard(second);
    await expect(second.getByText('Robin')).toHaveCount(0);
    expect(await slot(second)).toBe(record);
    expect(await own(second)).toBeNull();
    await expect.poll(() => logouts(api, owners.b).length).toBe(1);
    expect(logouts(api, owners.a)).toEqual([]);
    await expectIdentity(page, 'Alex');
  });

  test('D1: an unticked sign-in elsewhere signs the holder out once and keeps the new account signed in', async ({ page, context }) => {
    const second = await context.newPage();
    const apiB = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    const apiA = await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await signIn(second, 'b');
    await expectIdentity(second, 'Robin');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.getByText('Alex')).toHaveCount(0);
    await expect.poll(() => logouts(apiA, owners.a).length + logouts(apiB, owners.a).length).toBe(1);
    const record = await own(second);
    // Let every message, revocation and timer settle: the 5 s lock wait, a refresh tick, the holder's release.
    await second.waitForTimeout(6_000);
    await expectIdentity(second, 'Robin');
    expect(await own(second)).toBe(record);
    expect(await slot(second)).toBeNull();
    expect([...logouts(apiA, owners.b), ...logouts(apiB, owners.b)]).toEqual([]);
    expect(logouts(apiA, owners.a).length + logouts(apiB, owners.a).length).toBe(1);
    // The holder only received: it posted nothing on either channel.
    expect(await posts(page)).toEqual([]);
    const sent = await posts(second) as [string, unknown][];
    expect(sent.map(([name, message]) => [name, (message as { type?: string }).type ?? message])).toEqual([['stillroom.auth.v2', 'end-remembered']]);
  });

  test('D1 with the holder closed: the unticked sign-in removes the slot under the lock and revokes it once', async ({ page, context }) => {
    const second = await context.newPage();
    const apiB = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    const apiA = await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    await signIn(second, 'b');
    await expectIdentity(second, 'Robin');
    await expect.poll(() => slot(second)).toBeNull();
    await expect.poll(() => logouts(apiB, owners.a).length).toBe(1);
    expect(logouts(apiA, owners.a)).toEqual([]);
    await expectIdentity(second, 'Robin');
  });

  test('a sign-out in a per-tab window signs the holder out too and empties both stores', async ({ page, context }) => {
    const second = await context.newPage();
    await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    // The per-tab window signs in unticked as the same account would be D1; use the same account's per-tab session.
    await signIn(second, 'a');
    await expectIdentity(second, 'Alex');
    await expect(page.locator('#email')).toBeVisible();
    await signOut(second);
    expect(await slot(second)).toBeNull();
    expect(await own(second)).toBeNull();
    expect(await own(page)).toBeNull();
  });

  test('A remembered, signed out, then B remembered: a reopened app shows Robin with only B\'s bearer', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await signOut(page);
    await signInRemembered(page, 'b');
    await expectIdentity(page, 'Robin');
    await page.close();
    const later = await reopen(context);
    try {
      const next = await later.newPage();
      const api = await open(next);
      await expectIdentity(next, 'Robin');
      await expect(next.getByText('Alex')).toHaveCount(0);
      expect(api.requests.filter((request) => request.owner !== null).every((request) => request.owner === owners.b)).toBe(true);
    } finally { await later.close(); }
  });

  test('a ticked B while A\'s window is closed displaces A and revokes it once', async ({ page, context }) => {
    const second = await context.newPage();
    const apiB = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    await signInRemembered(second, 'b');
    await expectIdentity(second, 'Robin');
    expect(claims(await slot(second)).sub).toBe(owners.b);
    await expect.poll(() => logouts(apiB, owners.a).length).toBe(1);
    expect(apiB.requests.filter((request) => request.path.startsWith('/rest/') && request.owner === owners.a)).toEqual([]);
    await expect(second.getByText('Alex')).toHaveCount(0);
  });
});

/** Delivers a v2 command to every app channel, as another tab would; the injected nonces are told apart from the app's own posts. */
async function deliver(page: Page, type: 'sign-out' | 'end-remembered', nonce: string) {
  await page.evaluate(([kind, id]) => {
    const channel = new BroadcastChannel('stillroom.auth.v2');
    channel.postMessage({ v: 2, type: kind, nonce: id });
    channel.close();
  }, [type, nonce] as const);
}
const ownPosts = async (page: Page) => (await posts(page) as [string, { nonce?: string }][])
  .filter(([, message]) => !String(message?.nonce ?? '').startsWith('injected-'));

test.describe('AUTH1b replayed and out-of-order commands', () => {
  for (const order of ['end-remembered first', 'sign-out first'] as const) {
    test(`${order}, with replays: each window can only be signed out, and no receiver posts anything`, async ({ page, context }) => {
      const tab = await context.newPage();
      const apiTab = await open(tab);
      await signIn(tab, 'b');
      await expectIdentity(tab, 'Robin');
      const apiHolder = await open(page);
      await signInRemembered(page);
      await expectIdentity(page, 'Alex');
      await expectIdentity(tab, 'Robin');
      const sequence: ['sign-out' | 'end-remembered', string][] = order === 'end-remembered first'
        ? [['end-remembered', 'injected-0001'], ['end-remembered', 'injected-0001'], ['sign-out', 'injected-0002'], ['end-remembered', 'injected-0003'], ['sign-out', 'injected-0002']]
        : [['sign-out', 'injected-0002'], ['end-remembered', 'injected-0001'], ['sign-out', 'injected-0002'], ['end-remembered', 'injected-0001']];
      // Each window's own posts so far (the unticked sign-in's end-remembered); a receiver adds none.
      const before = [(await ownPosts(page)).length, (await ownPosts(tab)).length];
      const first = sequence[0]!;
      await deliver(page, first[0], first[1]);
      await expect(page.locator('#email')).toBeVisible();
      if (first[0] === 'end-remembered') {
        // The per-tab window ignores a command for the remembered session.
        await tab.waitForTimeout(500);
        await expectIdentity(tab, 'Robin');
      } else await expect(tab.locator('#email')).toBeVisible();
      for (const [type, nonce] of sequence.slice(1)) await deliver(page, type, nonce);
      await expect(tab.locator('#email')).toBeVisible();
      await expect(page.locator('#email')).toBeVisible();
      const settled = [apiHolder.requests.length, apiTab.requests.length];
      // A refresh tick and the release wait: nothing comes back and nothing is asked with an ended session.
      await page.waitForTimeout(6_000);
      expect((await ownPosts(page)).slice(before[0])).toEqual([]);
      expect((await ownPosts(tab)).slice(before[1])).toEqual([]);
      for (const window of [page, tab]) {
        expect(await slot(window)).toBeNull();
        expect(await own(window)).toBeNull();
        await expect(window.getByText('Alex')).toHaveCount(0);
        await expect(window.getByText('Robin')).toHaveCount(0);
      }
      const later = [...apiHolder.requests.slice(settled[0]), ...apiTab.requests.slice(settled[1])];
      expect(later.filter((request) => request.owner !== null && request.path !== '/auth/v1/logout')).toEqual([]);
      expect(logouts(apiHolder, owners.a).length + logouts(apiTab, owners.a).length).toBeLessThanOrEqual(1);
      expect(logouts(apiHolder, owners.b).length + logouts(apiTab, owners.b).length).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('AUTH1b reopening a remembered slot', () => {
  test('a renewed record stays allowlisted', async ({ page }) => {
    const auth: AuthControl = { lifetime: 60 };
    await open(page, auth);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await expect.poll(() => auth.refreshes ?? 0).toBeGreaterThan(0);
    await expectOnlySlot(page);
    await page.reload();
    await expectIdentity(page, 'Alex');
    await expectOnlySlot(page);
  });

  test('a refused renewal at reopen shows the expired sign-in and removes the slot', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    // An expired access token with a refresh token the server no longer knows.
    await page.evaluate((name) => {
      const record = JSON.parse(localStorage.getItem(name)!) as Record<string, unknown>;
      localStorage.setItem(name, JSON.stringify({ ...record, expires_at: Math.floor(Date.now() / 1000) - 60, refresh_token: 'fixture-unknown' }));
    }, key);
    await page.close();
    const second = await context.newPage();
    await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await expect(second.getByText(text('auth.expired'))).toBeVisible();
    await expect.poll(() => slot(second)).toBeNull();
    await expect(second.getByText('Alex')).toHaveCount(0);
  });

  test('a malformed slot and its leftovers are removed at start-up and nothing is sent', async ({ page }) => {
    await page.addInitScript((name) => {
      if (sessionStorage.getItem('test.seeded')) return;
      sessionStorage.setItem('test.seeded', '1');
      localStorage.setItem(name, '{"access_token":"x"}');
      localStorage.setItem(`${name}-user`, '{"user":{"email":"user-a@example.test"}}');
    }, key);
    const api = await open(page);
    await expect(page.locator('#email')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((name) => name.startsWith('stillroom.auth')))).toEqual([]);
    expect(authRequests(api)).toEqual([]);
  });

  test('an extra-field slot is rewritten to the allowlisted form and stays signed in', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.evaluate((name) => {
      const record = JSON.parse(localStorage.getItem(name)!) as Record<string, unknown>;
      localStorage.setItem(name, JSON.stringify({ ...record, token_type: 'bearer', user: { email: 'user-a@example.test' } }));
    }, key);
    await page.close();
    const second = await context.newPage();
    await open(second);
    await expectIdentity(second, 'Alex');
    await expectOnlySlot(second);
  });

  test('offline reopen shows the waiting card; Sign out works offline', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    const second = await context.newPage();
    await second.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
    await open(second);
    await second.route('http://127.0.0.1:54321/**', (route) => route.abort('internetdisconnected'));
    await expect(second.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeFocused();
    await expect(second.getByText('Alex')).toHaveCount(0);
    await expect(second.locator('.workspace')).toHaveCount(0);
    await second.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(second.locator('#email')).toBeVisible();
    expect(await slot(second)).toBeNull();
  });

  test('a recovery link on a device with a remembered slot is refused before any Auth start', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    const second = await context.newPage();
    const api = await mockBackend(second);
    await second.goto('/' + recoveryHash());
    await expect(second.getByRole('alert')).toHaveText(text('recovery.conflict'));
    expect(api.requests).toHaveLength(0);
  });
});

test.describe('AUTH1b lock states', () => {
  test('without Web Locks: no checkbox, the slot is left as it is, and Sign out of this device removes and revokes it', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    await page.close();
    const second = await context.newPage();
    await second.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined }));
    const api = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await expect(remember(second)).toHaveCount(0);
    expect(await slot(second)).toBe(record);
    expect(authRequests(api)).toEqual([]);
    await second.getByRole('button', { name: text('auth.signOutDevice'), exact: true }).click();
    await expect.poll(() => second.evaluate(() => Object.keys(localStorage).filter((name) => name.startsWith('stillroom.auth')))).toEqual([]);
    await expect.poll(() => logouts(api, owners.a).length).toBe(1);
    await expect(second.getByRole('button', { name: text('auth.signOutDevice'), exact: true })).toHaveCount(0);
  });

  test('a refused lock request leaves everything; Sign out of this device asks the holder to sign out', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    const second = await context.newPage();
    await second.addInitScript(() => {
      LockManager.prototype.request = () => Promise.reject(new DOMException('Refused for this test.', 'SecurityError'));
    });
    const api = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await expect(remember(second)).toHaveCount(0);
    expect(await slot(second)).toBe(record);
    expect(authRequests(api)).toEqual([]);
    await expectIdentity(page, 'Alex');
    await second.getByRole('button', { name: text('auth.signOutDevice'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    await expect.poll(() => slot(page)).toBeNull();
  });
});

type Scene = 'sign-in' | 'device' | 'waiting' | 'other-window';
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
/** Brings `page` to one of the AUTH1b entry states in `language`, using a second window where the state needs one. */
async function scene(page: Page, context: BrowserContext, state: Scene, language: Language) {
  const choose = async (target: Page) => {
    await target.locator(`.language-selector button[lang="${language}"]`).click();
    await expect(target.locator('html')).toHaveAttribute('lang', language);
  };
  if (state === 'sign-in') {
    await open(page);
    await choose(page);
    await expect(page.getByRole('checkbox', { name: text('auth.remember', language), exact: true })).toBeVisible();
    return page;
  }
  if (state === 'device') {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined }));
    await page.addInitScript(() => { if (!localStorage.getItem('stillroom.auth')) localStorage.setItem('stillroom.auth', '{"left":"by another release"}'); });
    await open(page);
    await choose(page);
    await expect(page.getByRole('button', { name: text('auth.signOutDevice', language), exact: true })).toBeVisible();
    return page;
  }
  await open(page);
  await signInRemembered(page);
  await expectIdentity(page, 'Alex');
  const second = await context.newPage();
  if (state === 'waiting') {
    await page.close();
    await second.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
    await open(second);
    await second.route('http://127.0.0.1:54321/**', (route) => route.abort('internetdisconnected'));
    await expect(second.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeVisible();
  } else {
    await open(second);
    await otherWindowCard(second);
  }
  await choose(second);
  return second;
}
/** No overflow, 44 px targets and no axe violations, at the current size with normal and 200 % text. */
async function audit(page: Page, label: string) {
  for (const large of [false, true]) {
    const style = large ? await page.addStyleTag({ content: zoom }) : null;
    const check = await page.evaluate(() => {
      const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const small = [...document.querySelectorAll('main button, main a[href], main input:not([type=hidden]), main select')]
        .filter(shown)
        .map((element) => ({ element, box: (element instanceof HTMLInputElement && element.type === 'checkbox' ? element.closest('label') ?? element : element).getBoundingClientRect() }))
        .filter(({ box }) => box.width < 44 || box.height < 44)
        .map(({ element, box }) => `${element.tagName} ${Math.round(box.width)}x${Math.round(box.height)}`);
      return { overflow: document.documentElement.scrollWidth > innerWidth, small };
    });
    expect(check, `${label} ${large ? '200%' : '100%'}`).toEqual({ overflow: false, small: [] });
    expect((await new AxeBuilder({ page }).analyze()).violations, `${label} axe`).toEqual([]);
    await style?.evaluate((node) => { (node as HTMLStyleElement).remove(); });
  }
}

test.describe('AUTH1b accessibility', () => {
  for (const state of ['sign-in', 'device', 'waiting', 'other-window'] as const) {
    test(`${state}: axe, 44 px targets and no overflow, at 320 px with 200 % text in Finnish and Swedish`, async ({ page, context }) => {
      for (const language of ['en', 'fi', 'sv'] as const) {
        if (state !== 'sign-in' && language === 'en') continue;
        const target = await scene(page, context, state, language);
        await target.setViewportSize({ width: 320, height: 800 });
        await audit(target, `${state} ${language}`);
        if (target !== page) await target.close();
        if (state !== 'sign-in') break;
        page = await context.newPage();
      }
    });
  }

  test('forced colours: the checkbox and its label stay visible, with a focus ring', async ({ page, context }) => {
    await scene(page, context, 'sign-in', 'en');
    await page.emulateMedia({ forcedColors: 'active' });
    // A keyboard focus, so the focus ring shows as it would for a keyboard user.
    // Password, then its Show button, then the checkbox.
    await page.locator('#password').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(remember(page)).toBeFocused();
    const shown = await remember(page).evaluate((box) => {
      const style = getComputedStyle(box), label = box.closest('label')!.getBoundingClientRect(), own = box.getBoundingClientRect();
      return { visible: style.visibility !== 'hidden' && style.opacity !== '0' && own.width >= 12 && own.height >= 12,
        target: label.height >= 44, ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 };
    });
    expect(shown).toEqual({ visible: true, target: true, ring: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

// Bounded synthetic captures for the coordinator's review; this session never opens them.
test.describe('AUTH1b bounded synthetic captures', () => {
  const scenes = [
    { name: 'sign-in-en-mobile', state: 'sign-in', language: 'en', width: 390, height: 844, large: false },
    { name: 'sign-in-fi-mobile', state: 'sign-in', language: 'fi', width: 390, height: 844, large: false },
    { name: 'sign-in-sv-320-200', state: 'sign-in', language: 'sv', width: 320, height: 800, large: true },
    { name: 'waiting-en-mobile', state: 'waiting', language: 'en', width: 390, height: 844, large: false },
    { name: 'other-window-fi-mobile', state: 'other-window', language: 'fi', width: 390, height: 844, large: false },
  ] as const;
  for (const shot of scenes) {
    test(`${shot.name} retains functional assertions in every project`, async ({ page, context }, testInfo) => {
      const write = testInfo.project.name === 'chromium';
      const directory = path.resolve('test-results/auth1-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const target = await scene(page, context, shot.state, shot.language);
      await target.setViewportSize({ width: shot.width, height: shot.height });
      if (shot.large) await target.addStyleTag({ content: zoom });
      expect((await new AxeBuilder({ page: target }).analyze()).violations).toEqual([]);
      expect(await target.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|Alex|Synthetic linen|@example|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement>('input')]
          .filter((field) => field.getClientRects().length && field.type !== 'checkbox').map((field) => field.value).join('');
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && fields === ''
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: shot.language, width: shot.width })).toBe(true);
      if (!write) return;
      const png = await target.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === shot.width).toBe(true);
      const file = await openFile(path.join(directory, `${shot.name}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});
