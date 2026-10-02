import { expect, test, type Page, type Response } from '@playwright/test';
import { messages, translate, type Language } from '../../src/i18n/all';
import { mockBackend, recoveryHash } from '../browser/mock-backend';
import { readManifest } from './builds';
import { cacheName, controlled, expectOnlyShell, serve, type DistServer } from './helpers';

// LANG1: the language catalogues of a real production build, under its CSP and with the worker in control.
let server: DistServer;
test.beforeEach(async () => { server = await serve('a'); });
test.afterEach(async () => { await server.close(); });

const languages: Language[] = ['en', 'fi', 'sv'];
const catalogueUrl = (language: Language) => {
  const file = readManifest('a').files.find((entry) => new RegExp(`^/assets/catalogue-${language}-[\\w-]{8}\\.json$`).test(entry.url));
  if (!file) throw new Error(`No ${language} catalogue in the precache manifest.`);
  return file.url;
};
const entryLanguage = (page: Page, language: Language) => page.locator(`.entry-language button[lang="${language}"]`);
const catalogueResponses = (page: Page) => {
  const responses: Response[] = [];
  page.on('response', (response) => { if (response.url().includes('/assets/catalogue-')) responses.push(response); });
  return responses;
};
const serverCatalogueRequests = () => server.requests.filter((entry) => entry.pathname.startsWith('/assets/catalogue-')).length;

// Records CSP violations, and optionally rejects the first page fetch of one exact URL before delegating to the
// native fetch. page.route cannot see requests the worker answers, so the failure is injected at the page boundary.
async function instrument(page: Page, failOnce?: string) {
  await page.addInitScript((target) => {
    const store = window as unknown as { cspViolations: string[] };
    store.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => { store.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`); });
    if (!target) return;
    const native = window.fetch.bind(window);
    let armed = true;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (armed && url.origin === location.origin && url.pathname === target && url.search === '') {
        armed = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return native(input, init);
    };
  }, failOnce ?? '');
}
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

async function expectEntryIn(page: Page, language: Language) {
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.locator('button[type="submit"]')).toHaveText(translate(language, 'auth.signIn'));
}

test('the worker precaches every catalogue, and a cold offline page switches to Finnish and Swedish from the cache', async ({ page, context }) => {
  await instrument(page);
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  const cached = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname), cacheName('a'));
  expect(cached).toEqual(expect.arrayContaining(languages.map(catalogueUrl)));
  await expectOnlyShell(page, 'a');

  await context.setOffline(true);
  const cold = await context.newPage();
  await instrument(cold);
  await mockBackend(cold, { initialLanguage: 'en' });
  const responses = catalogueResponses(cold);
  const before = serverCatalogueRequests();
  await cold.goto(server.url);
  await expectEntryIn(cold, 'en');
  await entryLanguage(cold, 'fi').click();
  await expectEntryIn(cold, 'fi');
  await entryLanguage(cold, 'sv').click();
  await expectEntryIn(cold, 'sv');
  await expect(cold.locator('.language-load-error')).toHaveCount(0);
  expect(responses.map((response) => new URL(response.url()).pathname)).toEqual(['en', 'fi', 'sv'].map((language) => catalogueUrl(language as Language)));
  for (const response of responses) {
    expect(new URL(response.url()).search).toBe('');
    expect(response.fromServiceWorker()).toBe(true);
    expect(response.status()).toBe(200);
  }
  expect(serverCatalogueRequests()).toBe(before);
  expect(await cspViolations(cold)).toEqual([]);
  await context.setOffline(false);
  await cold.close();
});

test.describe('fi-FI device', () => {
  test.use({ locale: 'fi-FI' });
  test('a cold offline start opens in Finnish from the cache and never asks for English', async ({ page, context }) => {
    await instrument(page);
    await mockBackend(page);
    await page.goto(server.url);
    await controlled(page);
    await expectEntryIn(page, 'fi');

    await context.setOffline(true);
    const cold = await context.newPage();
    await instrument(cold);
    await mockBackend(cold);
    const responses = catalogueResponses(cold);
    const before = serverCatalogueRequests();
    await cold.goto(server.url);
    await expectEntryIn(cold, 'fi');
    expect(responses.map((response) => new URL(response.url()).pathname)).toEqual([catalogueUrl('fi')]);
    expect(responses[0]?.fromServiceWorker()).toBe(true);
    expect(serverCatalogueRequests()).toBe(before);
    expect(await cspViolations(cold)).toEqual([]);
    await context.setOffline(false);
    await cold.close();
  });
});

test('a failed switch keeps English; offline, Try again loads the same catalogue URL from the installed cache', async ({ page, context }) => {
  await instrument(page, catalogueUrl('fi'));
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(server.url);
  await controlled(page);
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expectEntryIn(page, 'en');
  const responses = catalogueResponses(page);

  await entryLanguage(page, 'fi').click();
  await expect(page.locator('.language-load-error')).toHaveText(translate('en', 'language.loadFailed'));
  await expectEntryIn(page, 'en');
  expect(responses).toEqual([]);

  await context.setOffline(true);
  const before = serverCatalogueRequests();
  await page.locator('.language-load-failed').getByRole('button', { name: translate('en', 'common.retry'), exact: true }).click();
  await expectEntryIn(page, 'fi');
  await expect(page.locator('.language-load-error')).toHaveCount(0);
  expect(responses.map((response) => response.url())).toEqual([`${server.url}${catalogueUrl('fi')}`]);
  expect(responses[0]?.fromServiceWorker()).toBe(true);
  expect(serverCatalogueRequests()).toBe(before);
  expect(await cspViolations(page)).toEqual([]);
  await context.setOffline(false);
});

test('a failed startup catalogue keeps a recovery link: Try again opens the recovery form in the same document', async ({ page }) => {
  await instrument(page, catalogueUrl('en'));
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto(`${server.url}/${recoveryHash()}`);
  await expect(page.getByRole('heading', { name: messages['common.errorTitle'].en, exact: true })).toBeVisible();
  await expect(page.locator('#email')).toHaveCount(0);
  const marker = await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; return location.href; });
  expect(marker).not.toContain('access_token');

  await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(page.getByText(translate('en', 'recovery.target', { email: 'user-a@example.test' }), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
  const exposed = await page.evaluate(() => [location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })].join('\n'));
  for (const secret of ['access_token', 'refresh_token', 'unused-opaque-fixture']) expect(exposed).not.toContain(secret);
  expect(backend.requests.some((entry) => entry.path.startsWith('/auth/v1/token'))).toBe(false);
  expect(server.requests.some((entry) => entry.pathname.includes('token'))).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
});
