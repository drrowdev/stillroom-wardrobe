import { expect, test, type Page } from '@playwright/test';
import { messages, translate } from '../../src/i18n';
import { mockBackend, owners, recoveryHash, signIn } from '../browser/mock-backend';
import { readManifest } from './builds';
import { cacheName, controlled, expectOnlyShell, serve, type DistServer } from './helpers';

let server: DistServer;
test.beforeEach(async () => { server = await serve('a'); });
test.afterEach(async () => { await server.close(); });

// Fixture values that never occur in the public build; the helper checks that before relying on them.
const privateTitle = 'Private fixture coat Q7';
const privateMarkers = [privateTitle, 'An olive overshirt', 'user-a@example.test', 'user-b@example.test', 'fictional-test-password', 'unused-opaque-fixture'];

test('installs and controls the page with only public shell files, and private traffic passes through', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  backend.seedSavedItem('a', privateTitle);
  await page.goto(server.url);
  expect(await controlled(page)).toEqual([cacheName('a')]);
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  // The saved photo arrives as an authenticated download and is shown from a Blob URL.
  await expect(page.locator('.item-photo img').first()).toHaveAttribute('src', /^blob:/);
  const privateRequests = backend.requests.filter((entry) => /^\/(?:rest|storage|auth)\/v1\//.test(entry.path));
  expect(privateRequests.length).toBeGreaterThan(2);
  // Same-origin look-alikes of signed or tokenised URLs are passed to the network and never stored.
  expect(await page.evaluate(async () => Promise.all([
    '/storage/v1/object/sign/wardrobe/a/b/main.jpg?token=synthetic', '/index.html?access_token=synthetic', '/precache-manifest.json',
    '/service-worker.js', '/_headers',
  ].map(async (url) => (await fetch(url)).status)))).toEqual([404, 200, 200, 200, 404]);
  await expectOnlyShell(page, 'a', privateMarkers);
});

test('logout, another owner and a recovery link leave Cache Storage unchanged', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('.account-button')).toContainText('Robin');
  await expect(page.getByText('Alex', { exact: true })).toHaveCount(0);
  await expectOnlyShell(page, 'a', privateMarkers);
  await page.getByRole('button', { name: messages['account.menu'].sv }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].sv, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  // A fresh document load, so the recovery capture sees the synthetic tokens in the fragment.
  await page.goto('about:blank');
  await page.goto(`${server.url}/${recoveryHash()}`);
  await expect(page.getByText(translate('en', 'recovery.target', { email: 'user-a@example.test' }), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expectOnlyShell(page, 'a', privateMarkers);
  expect(server.requests.some((entry) => entry.pathname.includes('token'))).toBe(false);
});

test('sign-out in one controlled tab signs out the other', async ({ page, context }) => {
  const second = await context.newPage();
  await mockBackend(page, { initialLanguage: 'en' });
  await mockBackend(second, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await second.goto(server.url);
  expect(await second.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await signIn(page);
  await signIn(second);
  await expect(second.locator('.workspace-identity')).toContainText('Alex');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(second.locator('#email')).toBeVisible();
  await expect(second.getByText('Alex', { exact: true })).toHaveCount(0);
  await expectOnlyShell(second, 'a', privateMarkers);
  await second.close();
});

test('a private response that arrives after logout is neither shown nor stored', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  backend.seedSavedItem('a', privateTitle);
  await page.goto(server.url);
  await controlled(page);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let finished!: () => void;
  const answered = new Promise<void>((resolve) => { finished = resolve; });
  let held = false;
  await page.route('http://127.0.0.1:54321/rest/v1/items**', async (route) => {
    if (held) { await route.fallback(); return; }
    held = true;
    await released;
    // The page may already have aborted this request; the late answer is delivered if it still can be.
    await route.fallback().catch(() => undefined);
    finished();
  });
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  await expect.poll(() => held).toBe(true);
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  release();
  await answered;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText(privateTitle)).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expectOnlyShell(page, 'a', privateMarkers);
});

test('an offline reopen loads the cached shell without private data', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.getByText(messages['common.offline'].en)).toBeVisible();
  await page.goto(`${server.url}/#/settings`);
  await expect(page.locator('#email')).toBeVisible();
  await context.setOffline(false);
  await expectOnlyShell(page, 'a', privateMarkers);
});

const backendUrl = 'http://127.0.0.1:54321';
const accessToken = (page: Page) => page.evaluate(() => (JSON.parse(sessionStorage.getItem('stillroom.auth') ?? '{}') as { access_token?: string }).access_token ?? '');
// A 1x1 PNG, returned as the "signed" Storage object so a cross-origin <img> really loads it.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4kWIEAANWAV/oF4RSAAAAAElFTkSuQmCC', 'base64');

test('an authenticated Edge call and cross-origin signed Storage URLs pass through the active worker unstored', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  const seen: Array<{ path: string; authorization: string | undefined; token: string | null }> = [];
  await page.route(`${backendUrl}/functions/v1/analyze-clothing`, async (route) => {
    seen.push({ path: '/functions/v1/analyze-clothing', authorization: route.request().headers().authorization, token: null });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ title: privateTitle }) });
  });
  await page.route(`${backendUrl}/storage/v1/object/sign/**`, async (route) => {
    const url = new URL(route.request().url());
    seen.push({ path: url.pathname, authorization: route.request().headers().authorization, token: url.searchParams.get('token') });
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ signedURL: `/object/sign/wardrobe/${owners.a}/fixture/main.png?token=synthetic-signed-token` }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' }, body: pixel });
    }
  });
  await page.goto(server.url);
  await controlled(page);
  await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  const token = await accessToken(page);
  expect(token).not.toBe('');
  const result = await page.evaluate(async ({ backend, token, owner }) => {
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const edge = await (await fetch(`${backend}/functions/v1/analyze-clothing`, { method: 'POST', headers: auth, body: '{}' })).json() as { title: string };
    const sign = await (await fetch(`${backend}/storage/v1/object/sign/wardrobe/${owner}/fixture/main.png`, { method: 'POST', headers: auth, body: '{"expiresIn":60}' })).json() as { signedURL: string };
    const signed = `${backend}/storage/v1${sign.signedURL}`;
    // As the app does: download the signed object and show it from a Blob URL.
    const blob = await (await fetch(signed)).blob();
    const shown = new Image();
    shown.src = URL.createObjectURL(blob);
    await shown.decode();
    // A direct cross-origin <img> of the signed URL is refused by the page's CSP before any request.
    const direct = new Image();
    direct.src = `${signed}&view=img`;
    const directLoaded = await direct.decode().then(() => true, () => false);
    return { edge: edge.title, fetched: blob.size, width: shown.naturalWidth, directLoaded, controlled: Boolean(navigator.serviceWorker.controller) };
  }, { backend: backendUrl, token, owner: owners.a });
  expect(result).toEqual({ edge: privateTitle, fetched: pixel.length, width: 1, directLoaded: false, controlled: true });
  expect(seen.map((entry) => entry.path)).toEqual(['/functions/v1/analyze-clothing', `/storage/v1/object/sign/wardrobe/${owners.a}/fixture/main.png`,
    `/storage/v1/object/sign/wardrobe/${owners.a}/fixture/main.png`]);
  expect(seen.slice(0, 2).map((entry) => entry.authorization)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
  expect(seen.slice(2).map((entry) => entry.token)).toEqual(['synthetic-signed-token']);
  await expectOnlyShell(page, 'a', [...privateMarkers, 'synthetic-signed-token', token]);
});

test('a direct switch from owner A to owner B, without logout, clears A and stores nothing', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  backend.seedSavedItem('a', privateTitle);
  await page.goto(server.url);
  await controlled(page);
  await signIn(page);
  await expect(page.getByText(privateTitle).first()).toBeVisible();
  const tokenA = await accessToken(page);
  // What the SDK does when another client in this tab signs in: store the new session and broadcast SIGNED_IN.
  const tokenB = await page.evaluate(async (backend) => {
    const response = await fetch(`${backend}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'sb_publishable_browser_fixture_only' },
      body: JSON.stringify({ email: 'user-b@example.test', password: 'fictional-test-password' }) });
    const session: Record<string, unknown> = { ...await response.json() as Record<string, unknown>, expires_at: Math.floor(Date.now() / 1000) + 3600 };
    sessionStorage.setItem('stillroom.auth', JSON.stringify(session));
    const channel = new BroadcastChannel('stillroom.auth');
    channel.postMessage({ event: 'SIGNED_IN', session });
    channel.close();
    return session.access_token as string;
  }, backendUrl);
  expect(tokenB).not.toBe(tokenA);
  await expect(page.locator('.workspace-identity')).toContainText('Robin');
  await expect(page.getByText(privateTitle)).toHaveCount(0);
  await expect(page.getByText('Alex', { exact: true })).toHaveCount(0);
  expect(backend.requests.some((entry) => entry.owner === owners.b)).toBe(true);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expectOnlyShell(page, 'a', [...privateMarkers, tokenA, tokenB]);
});

test('an offline reopen after private data loaded shows no private data, and the backend really was unreachable', async ({ page, context }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  backend.seedSavedItem('a', privateTitle);
  let offline = false;
  const refused: string[] = [];
  // Registered after the mock, so it runs first: while offline no fixture can answer successfully.
  await page.route(`${backendUrl}/**`, async (route) => {
    if (!offline) { await route.fallback(); return; }
    refused.push(new URL(route.request().url()).pathname);
    await route.abort('internetdisconnected');
  });
  await page.goto(server.url);
  await controlled(page);
  await signIn(page);
  await expect(page.getByText(privateTitle).first()).toBeVisible();
  await expect(page.locator('.item-photo img').first()).toHaveAttribute('src', /^blob:/);
  offline = true;
  await context.setOffline(true);
  const before = server.requests.length;
  await page.reload();
  // The stored session cannot reach its profile, so the app shows its own could-not-open state.
  await expect(page.getByText(messages['account.locked'].en)).toBeVisible({ timeout: 20000 });
  expect(refused).toContain('/rest/v1/profiles');
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  await expect(page.getByText(privateTitle)).toHaveCount(0);
  await expect(page.locator('.item-photo img')).toHaveCount(0);
  // Chromium's offline emulation does not cover the browser's own worker update check; nothing else may reach the host.
  expect(server.requests.slice(before).filter((entry) => entry.dest !== 'serviceworker')).toEqual([]);
  await context.setOffline(false);
  await expectOnlyShell(page, 'a', privateMarkers);
});

test('the real fetch handler leaves private, control and unlisted paths to the network', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  const listed = readManifest('a').files.find((file) => file.url.endsWith('.js'))!.url;
  const unlisted = '/assets/index-Zz9Yy8Xx.js';
  for (const path of ['/rest/v1/items', '/auth/v1/verify?token=synthetic-verify', '/storage/v1/object/sign/wardrobe/a.jpg?token=synthetic', '/functions/v1/analyze-clothing', '/_headers', unlisted, listed]) {
    const before = server.requests.length;
    const response = await page.goto(`${server.url}${path}`);
    const reached = server.requests.slice(before).filter((entry) => entry.pathname === path.split('?')[0] && entry.mode === 'navigate');
    expect(reached, path).toHaveLength(1);
    expect(response?.fromServiceWorker(), path).toBe(false);
  }
  await page.goto(server.url);
  const shell = server.requests.length;
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  // A listed file fetched without its own destination is not the worker's to answer either.
  expect(await page.evaluate(async (url) => (await fetch(url)).status, listed)).toBe(200);
  expect(server.requests.slice(shell).map((entry) => entry.pathname)).toEqual([listed]);
  await expectOnlyShell(page, 'a', privateMarkers);
});