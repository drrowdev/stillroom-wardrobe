import { expect, test, type Page } from '@playwright/test';
import { messages } from '../../src/i18n/all';
import { mockBackend, owners, signIn, type AuthControl } from '../browser/mock-backend';
import { builds } from './builds';
import { serve, type DistServer } from './helpers';
import { expectIdentity, signOutThroughMenu } from '../browser/shell-support';

// T8 (AUTH1a): the production release (baseline) and this release in tabs of one origin and storage bucket. Each
// one's sign-out signs the other out, this release's expiry and sign-in send nothing an older tab could act on, and
// a full session record left by the baseline is cut down to the allowlisted form. Workers are blocked: this is about
// the two bundles' storage and messages, and the cache contracts are covered elsewhere.
test.use({ serviceWorkers: 'block' });

let server: DistServer;
test.beforeEach(async () => { server = await serve('mixed'); });
test.afterEach(async () => { await server.close(); });

const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string };
const record = async (page: Page) => {
  const raw = await page.evaluate(() => sessionStorage.getItem('stillroom.auth'));
  return raw === null ? null : JSON.parse(raw) as Record<string, unknown>;
};

/** Opens a tab of one release: the server's root is switched only for that navigation; the mixed root has both builds' assets. */
async function open(page: Page, release: 'baseline' | 'current', auth: AuthControl = {}) {
  const backend = await mockBackend(page, { initialLanguage: 'en', auth });
  if (release === 'baseline') await server.setRoot(builds.baseline);
  try {
    await page.goto(`${server.url}/#/wardrobe`);
    await expect(page.locator('#email')).toBeVisible();
  } finally {
    if (release === 'baseline') await server.setRoot(builds.mixed);
  }
  return backend;
}
const signedIn = async (page: Page, name: 'Alex' | 'Robin') => expectIdentity(page, name);
/** Robin's fixture profile is in Swedish. */
async function signOut(page: Page, language: 'en' | 'sv' = 'en') {
  await page.bringToFront();
  await signOutThroughMenu(page, language);
  await expect(page.locator('#email')).toBeVisible();
}
/** Records everything sent on the legacy channel, by BroadcastChannel or by storage, from any script in the page. */
async function recordLegacy(page: Page) {
  await page.addInitScript(() => {
    const heard: string[] = [];
    (window as unknown as { __legacy: string[] }).__legacy = heard;
    new BroadcastChannel('stillroom.logout').onmessage = (event) => heard.push(`channel:${String(event.data)}`);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'stillroom.logout') heard.push(`storage:${value}`);
      return setItem.call(this, key, value);
    };
  });
}
const legacy = (page: Page) => page.evaluate(() => (window as unknown as { __legacy: string[] }).__legacy);

test('a baseline sign-out signs out a current tab, and a current sign-out signs out a baseline tab', async ({ context }) => {
  const baseline = await context.newPage();
  const current = await context.newPage();
  await open(baseline, 'baseline');
  await open(current, 'current');
  expect(await baseline.evaluate(() => document.querySelector('script[src]')?.getAttribute('src'))).not
    .toBe(await current.evaluate(() => document.querySelector('script[src]')?.getAttribute('src')));
  await baseline.bringToFront();
  await signIn(baseline, 'a');
  await signedIn(baseline, 'Alex');
  await current.bringToFront();
  await signIn(current, 'b');
  await signedIn(current, 'Robin');
  // Signing in sent nothing the baseline acts on.
  await current.waitForTimeout(300);
  await signedIn(baseline, 'Alex');
  await signOut(baseline);
  await expect(current.locator('#email')).toBeVisible();
  expect(await record(current)).toBeNull();

  await baseline.bringToFront();
  await signIn(baseline, 'a');
  await signedIn(baseline, 'Alex');
  await current.bringToFront();
  await signIn(current, 'b');
  await signedIn(current, 'Robin');
  await signOut(current, 'sv');
  await expect(baseline.locator('#email')).toBeVisible();
  expect(await record(baseline)).toBeNull();
});

for (const outcome of ['renewed', 'refused'] as const) {
  test(`a current tab's ${outcome} expiry sends nothing on the legacy channel`, async ({ page }) => {
    const auth: AuthControl = {};
    await recordLegacy(page);
    await page.clock.install();
    await open(page, 'current', auth);
    await signIn(page, 'a');
    await signedIn(page, 'Alex');
    auth.refresh = outcome === 'renewed' ? 'ok' : 400;
    await page.clock.fastForward('01:01:00');
    if (outcome === 'renewed') {
      await expect.poll(() => auth.refreshes ?? 0).toBeGreaterThan(0);
      await signedIn(page, 'Alex');
    } else {
      await expect(page.getByText(messages['auth.expired'].en)).toBeVisible();
    }
    await page.clock.runFor(5_000);
    expect(await legacy(page)).toEqual([]);
    // Only a sign-out the user starts reaches older tabs, marked so current tabs act on the v2 message instead.
    if (outcome === 'renewed') {
      await signOut(page);
      await expect.poll(() => legacy(page)).toEqual(['channel:sign-out:v2']);
    }
  });
}

test('a full session record left by the baseline is cut down to the tokens and expiry', async ({ page }) => {
  await open(page, 'baseline');
  await signIn(page, 'a');
  await signedIn(page, 'Alex');
  const left = await record(page);
  // The baseline keeps the whole SDK session, including the user object.
  expect(Object.keys(left ?? {})).toEqual(expect.arrayContaining(['access_token', 'refresh_token', 'expires_at', 'user']));
  await page.reload();
  await signedIn(page, 'Alex');
  const migrated = await record(page);
  expect(Object.keys(migrated ?? {}).sort()).toEqual(['access_token', 'expires_at', 'refresh_token']);
  expect(claims(String(migrated?.access_token)).sub).toBe(owners.a);
  const raw = await page.evaluate(() => JSON.stringify([{ ...sessionStorage }, { ...localStorage }]));
  for (const secret of ['user-a@example.test', 'Alex', 'user_metadata']) expect(raw).not.toContain(secret);
});

// T8 (AUTH1b): baseline and AUTH1b tabs. Under the deploy gate no AUTH1a-only bundle reaches a device, so the
// baseline is the only older release a remembered session can meet. An older release's sign-out may sign out a newer
// remembered session (fail-safe); it never brings one back or exposes it.
const slot = (page: Page) => page.evaluate(() => localStorage.getItem('stillroom.auth'));
const authKeys = (page: Page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => key.startsWith('stillroom.auth')));
async function signInRemembered(page: Page, account: 'a' | 'b') {
  await page.bringToFront();
  await page.locator('#email').fill(`user-${account}@example.test`);
  await page.locator('#password').fill('fictional-test-password');
  await page.getByRole('checkbox', { name: messages['auth.remember'].en, exact: true }).check();
  await page.locator('button[type="submit"]').click();
}
const logouts = (backend: Awaited<ReturnType<typeof mockBackend>>, owner: string) =>
  backend.requests.filter((request) => request.path === '/auth/v1/logout' && request.owner === owner).length;
const bearers = (backend: Awaited<ReturnType<typeof mockBackend>>) => backend.requests.map((request) => request.owner);

test.describe('AUTH1b with the baseline', () => {
  test('a remembered commit never signs out a baseline tab, and a baseline sign-out ends the holder with the slot gone', async ({ context }) => {
    const baseline = await context.newPage();
    const current = await context.newPage();
    await open(baseline, 'baseline');
    await open(current, 'current');
    await baseline.bringToFront();
    await signIn(baseline, 'a');
    await signedIn(baseline, 'Alex');
    await signInRemembered(current, 'b');
    await signedIn(current, 'Robin');
    await current.waitForTimeout(300);
    await signedIn(baseline, 'Alex');
    await signOut(baseline);
    await expect(current.locator('#email')).toBeVisible();
    await expect(current.getByText('Robin')).toHaveCount(0);
    expect(await authKeys(current)).toEqual([]);
  });

  test('the baseline clears a remembered slot whose window has closed, and a later AUTH1b window does not bring it back', async ({ context }) => {
    const baseline = await context.newPage();
    const current = await context.newPage();
    await open(baseline, 'baseline');
    await open(current, 'current');
    await signInRemembered(current, 'a');
    await signedIn(current, 'Alex');
    const remembered = JSON.parse(await slot(current) ?? '{}') as { refresh_token?: string };
    expect(remembered.refresh_token).toBeTruthy();
    await current.close();
    await baseline.bringToFront();
    await signIn(baseline, 'b');
    await signedIn(baseline, 'Robin');
    await signOut(baseline, 'sv');
    expect(await authKeys(baseline)).toEqual([]);
    const later = await context.newPage();
    const backend = await open(later, 'current');
    await later.waitForTimeout(1_500);
    await expect(later.locator('#email')).toBeVisible();
    expect(await authKeys(later)).toEqual([]);
    // No request carries the old remembered tokens. A server revoke of them is not required (fail-safe guarantee).
    expect(bearers(backend).filter((owner) => owner === owners.a)).toEqual([]);
  });

  for (const delivery of ['channel', 'storage'] as const) {
    test(`a delayed unmarked legacy sign-out (${delivery}) after a newer remembered commit only signs out`, async ({ context }) => {
      test.setTimeout(75_000);
      const baseline = await context.newPage();
      const current = await context.newPage();
      await open(baseline, 'baseline');
      const backend = await open(current, 'current');
      await signInRemembered(current, 'a');
      await signedIn(current, 'Alex');
      await signOut(current);
      await signInRemembered(current, 'b');
      await signedIn(current, 'Robin');
      // What a delayed delivery from the older release looks like.
      await baseline.evaluate((kind) => {
        if (kind === 'channel') new BroadcastChannel('stillroom.logout').postMessage('logout');
        else { localStorage.setItem('stillroom.logout', String(Date.now())); localStorage.removeItem('stillroom.logout'); }
      }, delivery);
      await expect(current.locator('#email')).toBeVisible();
      await expect(current.getByText('Robin')).toHaveCount(0);
      expect(await authKeys(current)).toEqual([]);
      await expect.poll(() => logouts(backend, owners.b)).toBe(1);
      const before = backend.requests.length;
      // Past a refresh tick nothing reappears, and nothing carries B's tokens again.
      await current.waitForTimeout(31_000);
      expect(await authKeys(current)).toEqual([]);
      expect(backend.requests.slice(before).filter((request) => request.owner === owners.b)).toEqual([]);
      await expect(current.locator('#email')).toBeVisible();
    });
  }

  test('a baseline clear while the holder\'s renewal is in flight ends signed out with an empty slot', async ({ context }) => {
    const baseline = await context.newPage();
    const current = await context.newPage();
    await open(baseline, 'baseline');
    await open(current, 'current', { lifetime: 60 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let renewals = 0;
    await current.route('http://127.0.0.1:54321/auth/v1/token?grant_type=refresh_token', async (route) => {
      if (++renewals === 1) await held;
      await route.fallback();
    });
    await signInRemembered(current, 'a');
    await expect.poll(() => renewals).toBe(1);
    await baseline.bringToFront();
    await signIn(baseline, 'b');
    await signedIn(baseline, 'Robin');
    await signOut(baseline, 'sv');
    release();
    await expect(current.locator('#email')).toBeVisible();
    await current.waitForTimeout(1_000);
    expect(await authKeys(current)).toEqual([]);
    await expect(current.getByText('Alex')).toHaveCount(0);
  });
});
