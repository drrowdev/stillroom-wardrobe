import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, recoveryHash, signIn, type AuthControl } from './mock-backend';
import { expectIdentity, expectSignedIn, openAccountMenu } from './shell-support';

// AUTH1b: "Keep me signed in on this device". One window holds the remembered session under a Web Lock; every other
// window signs in per tab. Only the two tokens and the expiry are kept, and only in that one slot.
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
async function signOut(page: Page, language: Language = 'en') {
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('button', { name: text('auth.signOut', language), exact: true }).click();
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

const offline = (page: Page) => page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
/** Whether another page could take the remembered lock right now. */
const lockFree = (page: Page) => page.evaluate(() => navigator.locks.request('stillroom.remembered', { ifAvailable: true }, (lock) => lock !== null));

test.describe('AUTH1b remember on this device', () => {
  test('J1: unticked by default with a 44 px target; ticked keeps only the slot, and a reload stays signed in', async ({ page }) => {
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
  });

  test('J1: a new window after closing the old one, and a reopened app, open as the same owner', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    await page.close();
    const second = await context.newPage();
    await open(second);
    await expectIdentity(second, 'Alex');
    expect(await slot(second)).toBe(record);
    await second.close();
    const later = await reopen(context);
    try {
      const third = await later.newPage();
      await open(third);
      await expectIdentity(third, 'Alex');
      await expect(third.getByText('Synthetic linen shirt')).toBeVisible();
      await expectOnlySlot(third);
    } finally { await later.close(); }
  });

  test('J2: a reopened app offline waits without private data, then opens on reconnect', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    const later = await reopen(context);
    try {
      const next = await later.newPage();
      await next.addInitScript(() => {
        (window as unknown as { __offline: boolean }).__offline = true;
        Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !(window as unknown as { __offline: boolean }).__offline });
      });
      await open(next);
      const down = (route: { abort(code: string): Promise<void> }) => route.abort('internetdisconnected');
      await next.route('http://127.0.0.1:54321/**', down);
      await expect(next.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeFocused();
      await expect(next.getByText('Alex')).toHaveCount(0);
      await expect(next.locator('.workspace')).toHaveCount(0);
      await next.unroute('http://127.0.0.1:54321/**', down);
      await next.evaluate(() => { (window as unknown as { __offline: boolean }).__offline = false; window.dispatchEvent(new Event('online')); });
      await expectIdentity(next, 'Alex');
      await expect(next.getByText('Synthetic linen shirt')).toBeVisible();
    } finally { await later.close(); }
  });

  test('J2: Sign out from the offline waiting card empties both stores without a connection', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await page.close();
    const second = await context.newPage();
    await offline(second);
    await open(second);
    await second.route('http://127.0.0.1:54321/**', (route) => route.abort('internetdisconnected'));
    await expect(second.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeFocused();
    await second.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(second.locator('#email')).toBeVisible();
    expect(await slot(second)).toBeNull();
    expect(await own(second)).toBeNull();
    const later = await reopen(context);
    try {
      const next = await later.newPage();
      await offline(next);
      await open(next);
      await expect(next.locator('#email')).toBeVisible();
      await expect(next.getByText('Alex')).toHaveCount(0);
    } finally { await later.close(); }
  });

  test('J3: unticked stays in this tab, lets the lock go, and a new window or reopened app shows sign-in', async ({ page, context }) => {
    await open(page);
    await expect(remember(page)).toBeVisible();
    await signIn(page);
    await expectIdentity(page, 'Alex');
    await page.reload();
    await expectIdentity(page, 'Alex');
    expect(await slot(page)).toBeNull();
    expect(await lockFree(page)).toBe(true);
    const second = await context.newPage();
    await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await expect(remember(second)).toBeVisible();
    const later = await reopen(context);
    try {
      const third = await later.newPage();
      await open(third);
      await expect(third.locator('#email')).toBeVisible();
      expect(await slot(third)).toBeNull();
    } finally { await later.close(); }
  });

  test('J3: the holder signs out: both stores empty, one revoke, and a reopened app offers remember again', async ({ page, context }) => {
    const api = await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    await signOut(page);
    expect(await slot(page)).toBeNull();
    expect(await own(page)).toBeNull();
    await expect.poll(() => logouts(api, owners.a).length).toBe(1);
    await expect(remember(page)).not.toBeChecked();
    await page.close();
    const later = await reopen(context);
    try {
      const next = await later.newPage();
      await open(next);
      await expect(next.locator('#email')).toBeVisible();
      await expect(remember(next)).toBeVisible();
    } finally { await later.close(); }
  });

  test('J4 and J3: a second window signs in per tab beside the holder, and its Sign out ends the holder too', async ({ page, context }) => {
    const apiA = await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const record = await slot(page);
    const second = await context.newPage();
    const apiB = await open(second);
    await expect(second.locator('#email')).toBeVisible();
    await expect(remember(second)).toHaveCount(0);
    expect(await slot(second)).toBe(record);
    expect(authRequests(apiB)).toEqual([]);
    await signIn(second, 'b');
    await expectIdentity(second, 'Robin');
    await expectIdentity(page, 'Alex');
    expect(await slot(second)).toBe(record);
    expect(claims(await own(second)).sub).toBe(owners.b);
    const data = (api: Backend) => api.requests.filter((request) => request.path.startsWith('/rest/') && request.owner !== null);
    expect(data(apiA).every((request) => request.owner === owners.a)).toBe(true);
    expect(data(apiB).every((request) => request.owner === owners.b)).toBe(true);
    const before = (await posts(page)).length;
    await signOut(second, 'sv');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.getByText('Alex')).toHaveCount(0);
    expect(await slot(page)).toBeNull();
    expect(await own(second)).toBeNull();
    await expect.poll(() => logouts(apiA, owners.a).length).toBe(1);
    await expect.poll(() => logouts(apiB, owners.b).length).toBe(1);
    // The holder ended on the received command and sent nothing on.
    await page.waitForTimeout(500);
    expect((await posts(page)).slice(before)).toEqual([]);
  });

  test('J3: a per-tab Sign out removes a closed holder\'s slot, and a reopened app stays signed out', async ({ page, context }) => {
    await open(page);
    await signInRemembered(page);
    await expectIdentity(page, 'Alex');
    const second = await context.newPage();
    await open(second);
    await signIn(second, 'b');
    await expectIdentity(second, 'Robin');
    await page.close();
    expect(await slot(second)).not.toBeNull();
    await signOut(second, 'sv');
    expect(await slot(second)).toBeNull();
    await second.close();
    const later = await reopen(context);
    try {
      const next = await later.newPage();
      await open(next);
      await expect(next.locator('#email')).toBeVisible();
      await expect(next.getByText('Alex')).toHaveCount(0);
      expect(await slot(next)).toBeNull();
    } finally { await later.close(); }
  });

  test('J5: a refused renewal at reopen shows the expired sign-in, removes the slot and offers remember again', async ({ page, context }) => {
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
    await expect(remember(second)).toBeVisible();
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

type Scene = 'sign-in' | 'waiting';
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
  await open(page);
  await signInRemembered(page);
  await expectIdentity(page, 'Alex');
  await page.close();
  const second = await context.newPage();
  await offline(second);
  await open(second);
  await second.route('http://127.0.0.1:54321/**', (route) => route.abort('internetdisconnected'));
  await expect(second.getByRole('heading', { level: 1, name: text('auth.offlineTitle') })).toBeVisible();
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
  for (const state of ['sign-in', 'waiting'] as const) {
    test(`${state}: axe, 44 px targets and no overflow, at 320 px with 200 % text in Finnish and Swedish`, async ({ page, context }) => {
      for (const language of ['en', 'fi', 'sv'] as const) {
        if (state !== 'sign-in' && language === 'en') continue;
        const target = await scene(page, context, state, language);
        await target.setViewportSize({ width: 320, height: 800 });
        await audit(target, `${state} ${language}`);
        if (target !== page) await target.close();
        if (state !== 'sign-in') break;
        // Each language gets a fresh device: an open sign-in window holds the lock, so a second one offers no checkbox.
        context = await reopen(context);
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
