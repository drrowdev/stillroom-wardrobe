import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import '../../src/i18n/tryon';
import { mockBackend, owners, signIn, type TryOnSetup } from './mock-backend';
import { expectSignedIn } from './shell-support';

// TRYON-IDEA1: trying on an unsaved Today idea against the mocked backend. Every assertion is text: request fields, visible
// copy, focus and axe results. The person photo is a flat synthetic figure drawn in the page; no real photo is used.
type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const engineOnly = () => test.skip(test.info().project.name === 'mobile', 'Behaviour is covered by the chromium and webkit-photo projects.');
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
const tryOn = (page: Page) => page.locator('#today-tryon');
const status = (page: Page) => page.locator('.tryon-page [aria-live=polite]');

type Start = { language?: Language; setup?: Partial<TryOnSetup> | null; consent?: boolean; missing?: boolean;
  preload?: (api: Api, clothes: { top: Row & { id: string }; trousers: Row & { id: string }; shoes: Row & { id: string } }) => void | Promise<void> };
async function start(page: Page, options: Start = {}) {
  const language = options.language ?? 'en';
  // Playwright's WebKit route interception reports an empty body for Blob uploads, so on that engine the try-on POST is
  // re-sent with the same multipart bytes as an ArrayBuffer.
  if (test.info().project.name === 'webkit-photo') {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/functions/v1/try-on') && init?.body instanceof FormData) {
          const encoded = new Response(init.body);
          const headers = new Headers(init.headers);
          headers.set('content-type', encoded.headers.get('content-type') ?? '');
          return original(input, { ...init, headers, body: await encoded.arrayBuffer() });
        }
        return original(input, init);
      };
    });
  }
  const api = await mockBackend(page, { initialLanguage: language });
  let serial = 0;
  const add = (title: string, category: string, account: 'a' | 'b' = 'a') => {
    const { item } = api.seedSavedItem(account, title);
    serial++;
    Object.assign(item as Row, { category, seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 1,
      created_at: `2026-09-09T00:00:${String(serial).padStart(2, '0')}Z` });
    return item as Row & { id: string };
  };
  const clothes = { top: add('Olive overshirt', 'top'), trousers: add('Navy trousers', 'bottom'), shoes: add('White trainers', 'footwear'),
    peer: add('Robin private shirt', 'top', 'b') };
  if (options.missing) api.tryonControl.missing = true;
  if (options.setup !== null) api.tryonControl.setup[owners.a] = { activated: true, ...options.setup };
  if (options.consent !== false) api.tryonControl.consent[owners.a] = 1;
  await options.preload?.(api, clothes);
  await page.goto('/#/today'); await signIn(page);
  await expectSignedIn(page);
  await expect(page.locator('#today-title')).toHaveText(text('today.title', language));
  await expect(page.locator('.today-card.today-featured .outfit-component-name')).not.toHaveCount(0);
  return { api, clothes };
}
async function syntheticPerson(page: Page): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 1000 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e4e1da'; context.fillRect(0, 0, 800, 1000);
    context.fillStyle = '#8a6f5a'; context.beginPath(); context.arc(400, 170, 80, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#3d5a80'; context.fillRect(290, 260, 220, 330);
    context.fillStyle = '#293241'; context.fillRect(300, 590, 90, 330); context.fillRect(410, 590, 90, 330);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
}
async function preparePhoto(page: Page, language: Language = 'en') {
  await page.locator('.tryon-page input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page) });
  await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
  await button(page, 'photo.applyCrop', language).click();
  await expect(page.locator('#tryon-start')).toBeFocused({ timeout: 20_000 });
}
async function openFromToday(page: Page, language: Language = 'en') {
  await tryOn(page).click();
  await expect(page).toHaveURL(/#\/today\/try-on$/);
  await expect(page.locator('#tryon-title')).toBeFocused();
  await expect(page.locator('#tryon-title')).toHaveText(text('tryon.open', language));
}
const gate = () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release: () => release() };
};
const noWrites = (api: Api) => expect(api.outfits).toHaveLength(0);

test.describe('try on an unsaved Today idea', () => {
  test('sends the garments only, saves no outfit and keeps the picture under Try-ons', async ({ page }) => {
    const { api, clothes } = await start(page);
    await expect(tryOn(page)).toHaveText(text('tryon.ideaOpen'));
    await openFromToday(page);
    // Before any photo is chosen or anything is paid, the screen says which items will be tried on and which will not.
    await expect(page.locator('#tryon-subset')).toHaveText(text('tryon.subset'));
    await expect(page.locator('.tryon-garments li')).toHaveText([
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.top'), name: 'Olive overshirt' }),
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.bottom'), name: 'Navy trousers' }),
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.footwear'), name: 'White trainers' })]);
    await preparePhoto(page);
    await expect(page.locator('#tryon-start')).toHaveText(text('tryon.startMany', 'en', { count: 3 }));
    await expect(page.locator('#tryon-limit')).toHaveText(text('tryon.limitLine'));
    await expect(page.locator('#tryon-limit')).toContainText('AI budget');
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    const requests = api.tryonControl.requests;
    expect(requests.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(new Set(requests.map((entry) => entry.chainId)).size).toBe(1);
    // Only the garments are named, on the first step, and never an outfit or another account's item.
    expect(requests.map((entry) => entry.outfitId)).toEqual([null, null, null]);
    expect(requests[0]!.itemIds).toEqual([clothes.top.id, clothes.trousers.id, clothes.shoes.id]);
    expect(requests.slice(1).map((entry) => entry.itemIds)).toEqual([null, null]);
    expect(api.tryonControl.chains[0]!.outfitId).toBeNull();
    expect(api.tryonControl.results.map((row) => row.outfitId)).toEqual([null]);
    noWrites(api);
    await page.locator('#tryon-done').click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('#today-title')).toBeVisible();
    // The picture waits under Try-ons, closed, until the owner opens it.
    const saved = page.locator('#tryon-ideas');
    await expect(saved.locator('summary')).toHaveText(text('tryon.savedCount', 'en', { count: 1 }));
    await expect(saved.locator('.tryon-saved-list')).toHaveCount(0);
    await saved.locator('summary').click();
    await expect(saved.locator('.tryon-saved-list img')).toBeVisible();
    await axe(page);
    const id = api.tryonControl.results[0]!.id;
    await page.locator(`#tryon-${id}-delete`).click();
    await page.locator(`#tryon-${id}-confirm-confirm`).click();
    await expect(page.getByText(text('tryon.deleted'), { exact: true })).toBeVisible();
    expect(api.tryonControl.deletes).toEqual([id]);
    noWrites(api);
  });

  for (const [name, options] of [['not activated', { setup: null, consent: false }], ['not consented', { consent: false }],
    ['paused', { setup: { providerAvailable: false } }], ['missing on this backend', { missing: true }]] as const) {
    test(`no Try on button when ${name}`, async ({ page }) => {
      engineOnly();
      const { api } = await start(page, options as Start);
      await expect(page.locator('.today-card.today-featured')).toBeVisible();
      if (!('missing' in options)) await expect.poll(() => api.tryonControl.statusReads).toBeGreaterThan(0);
      await expect(tryOn(page)).toHaveCount(0);
      expect(api.tryonControl.requests).toHaveLength(0);
    });
  }

  test('Back leaves without sending anything, and the route cannot be reopened without its idea', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    await openFromToday(page);
    await page.getByRole('button', { name: text('outfits.back'), exact: true }).click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('#today-title')).toBeVisible();
    expect(api.tryonControl.requests).toHaveLength(0);
    await page.goto('/#/today/try-on');
    await expect(page.locator('#today-title')).toBeVisible();
    await expect(page).toHaveURL(/#\/today$/);
    expect(api.tryonControl.requests).toHaveLength(0);
  });

  test('Stop asks first and cancels the idea chain; closing leaves nothing running', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await openFromToday(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(2);
    await expect(status(page)).toHaveText(text('tryon.progress', 'en', { step: 2, total: 3, slot: text('tryon.slot.bottom') }));
    await page.locator('#tryon-stop').click();
    await page.locator('#tryon-stop-confirm-confirm').click();
    await expect(page.getByText(text('tryon.stopped'), { exact: true })).toBeVisible();
    expect(api.tryonControl.cancels).toEqual([api.tryonControl.requests[0]!.chainId]);
    held.release();
    await page.waitForTimeout(200);
    expect(api.tryonControl.requests).toHaveLength(2);
    expect(api.tryonControl.results).toHaveLength(0);
    noWrites(api);
  });

  test('leaving mid-run ends the chain on the server', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await openFromToday(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(2);
    await page.getByRole('button', { name: text('outfits.back'), exact: true }).click();
    await expect(page.locator('#today-title')).toBeVisible();
    await expect.poll(() => api.tryonControl.cancels.length).toBe(1);
    expect(api.tryonControl.cancels).toEqual([api.tryonControl.requests[0]!.chainId]);
    held.release();
  });

  test('is disabled while offline and sends nothing', async ({ page, context }) => {
    engineOnly();
    const { api } = await start(page);
    await expect(tryOn(page)).toBeEnabled();
    await context.setOffline(true);
    await expect(tryOn(page)).toBeDisabled();
    expect(api.tryonControl.requests).toHaveLength(0);
    await context.setOffline(false);
    await expect(tryOn(page)).toBeEnabled();
  });

  test('lists unsaved try-ons before opening, also while try-on is off, and deletes one without any automatic deletion', async ({ page }) => {
    engineOnly();
    const stored = (api: Api, itemId: string, completedAgo: number) => {
      const id = randomUUID();
      api.tryonControl.results.push({ id, owner: owners.a, outfitId: null, itemIds: [itemId], image: api.fixture,
        completedAtMs: Date.now() - completedAgo, expiresAtMs: Date.now() + 3_600_000 });
      return id;
    };
    const ids: string[] = [];
    const { api } = await start(page, { setup: null, consent: false, preload: (api, clothes) => {
      ids.push(stored(api, clothes.top.id, 1000), stored(api, clothes.top.id, 2000));
    } });
    const saved = page.locator('#tryon-ideas');
    // The count comes from a metadata read; no picture is fetched until the list is opened.
    await expect(saved.locator('summary')).toHaveText(text('tryon.savedCount', 'en', { count: 2 }));
    await expect(saved.locator('.tryon-saved-list')).toHaveCount(0);
    await expect(tryOn(page)).toHaveCount(0);
    await saved.locator('summary').click();
    await expect(saved.locator('.tryon-saved-list img')).toHaveCount(2);
    await page.locator(`#tryon-${ids[0]}-delete`).click();
    await page.locator(`#tryon-${ids[0]}-confirm-confirm`).click();
    await expect(saved.locator('.tryon-saved-list img')).toHaveCount(1);
    expect(api.tryonControl.deletes).toEqual([ids[0]]);
    expect(api.tryonControl.results.map((row) => row.id)).toEqual([ids[1]]);
  });

  test('stored unsaved try-ons stay listed when the status read fails, with no Show on me button', async ({ page }) => {
    engineOnly();
    const ids: string[] = [];
    const { api } = await start(page, { preload: async (api, clothes) => {
      await page.route('**/rest/v1/rpc/tryon_status', async route => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"fixture"}' });
      });
      const id = randomUUID();
      ids.push(id);
      api.tryonControl.results.push({ id, owner: owners.a, outfitId: null, itemIds: [clothes.top.id], image: api.fixture,
        completedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000 });
    } });
    const saved = page.locator('#tryon-ideas');
    await expect(saved.locator('summary')).toHaveText(text('tryon.savedCount', 'en', { count: 1 }));
    await expect(tryOn(page)).toHaveCount(0);
    await saved.locator('summary').click();
    await expect(saved.locator('.tryon-saved-list img')).toBeVisible();
    await page.locator(`#tryon-${ids[0]}-delete`).click();
    await page.locator(`#tryon-${ids[0]}-confirm-confirm`).click();
    await expect(saved.locator('.tryon-saved-list img')).toHaveCount(0);
    expect(api.tryonControl.deletes).toEqual([ids[0]]);
  });

  test('a failed list of unsaved try-ons is shown with Retry, never hidden', async ({ page }) => {
    engineOnly();
    let failing = true;
    await start(page, { preload: async (api, clothes) => {
      // Registered after the mock backend's own routes, so it is consulted first.
      await page.route('**/rest/v1/rpc/tryon_results_v1', async route => {
        if (failing) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"fixture"}' }); return; }
        await route.fallback();
      });
      api.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId: null, itemIds: [clothes.top.id], image: api.fixture,
        completedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000 });
    } });
    await expect(page.locator('.tryon-saved [role=alert]')).toContainText(text('tryon.savedFailed'), { timeout: 10_000 });
    await axe(page);
    failing = false;
    await page.locator('#tryon-saved-retry').click();
    await expect(page.locator('#tryon-ideas summary')).toHaveText(text('tryon.savedCount', 'en', { count: 1 }));
  });

  test('a client without the results header sees outfit results only', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { preload: (api, clothes) => {
      api.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId: null, itemIds: [clothes.top.id], image: api.fixture,
        completedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000 });
    } });
    const seen = await page.evaluate(async () => {
      const call = async (headers: Record<string, string>) => {
        const response = await fetch('http://127.0.0.1:54321/rest/v1/rpc/tryon_results_v1', { method: 'POST', headers: { 'Content-Type': 'application/json',
          'X-Stillroom-AI-Budget-Contract': '2', ...headers }, body: '{}' });
        return (await response.json() as { results: unknown[] }).results.length;
      };
      return [await call({}), await call({ 'X-Stillroom-TryOn-Results-Contract': '2' })];
    }).catch(() => null);
    // The fixture answers any origin the page can reach; a blocked cross-origin call leaves the rule to the unit tests.
    if (seen !== null) expect(seen).toEqual([0, 1]);
    expect(api.tryonControl.results).toHaveLength(1);
  });

  test('fits 320 px at 200% text and passes axe on the card and the setup', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await start(page);
    await page.addStyleTag({ content: zoom });
    await expect(tryOn(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe(page);
    await openFromToday(page);
    await page.addStyleTag({ content: zoom });
    await preparePhoto(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe(page);
  });

  for (const language of ['fi', 'sv'] as const) {
    test(`${language}: the button and the idea screen use the translated feature name`, async ({ page }) => {
      engineOnly();
      await start(page, { language });
      await expect(tryOn(page)).toHaveText(text('tryon.ideaOpen', language));
      await openFromToday(page, language);
      await expect(page.locator('#tryon-subset')).toHaveText(text('tryon.subset', language));
      await expect(page.locator('.tryon-garments')).toHaveAttribute('aria-label', text('tryon.steps', language));
    });
  }
});
