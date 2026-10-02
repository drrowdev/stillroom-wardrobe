import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import '../../src/i18n/tryon';
import { mockBackend, owners, signIn, type TryOnSetup } from './mock-backend';
import { expectSignedIn } from './shell-support';

// VTO-2a owner try-on against the mocked backend. Every assertion is text: request counts and fields, JPEG frame sizes
// read from the sent bytes, visible copy, focus and axe results. The person photo is a flat synthetic figure drawn in the
// page; no real photo is used and no image is looked at by the test author or the model. Captures go to ignored buffers.
type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) =>
  page.getByRole('button', { name: text(key, language, parameters), exact: true });
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const engineOnly = () => test.skip(test.info().project.name === 'mobile', 'Behaviour is covered by the chromium and webkit-photo projects.');
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

function seed(api: Api) {
  const add = (title: string, category: string, account: 'a' | 'b' = 'a') => {
    const { item } = api.seedSavedItem(account, title);
    Object.assign(item as Row, { category });
    return item as Row & { id: string };
  };
  return {
    top: add('Olive overshirt', 'top'), trousers: add('Navy trousers', 'bottom'), shoes: add('White trainers', 'footwear'),
    coat: add('Grey coat', 'outerwear'), dress: add('Green dress', 'one_piece'), peer: add('Robin private shirt', 'top', 'b'),
  };
}
function seedOutfit(api: Api, itemIds: string[], title: string, account: 'a' | 'b' = 'a') {
  const id = randomUUID(), owner = owners[account], now = new Date(Date.now() - 60000).toISOString();
  api.outfits.push({ id, owner_id: owner, title, occasion: 'everyday', notes: '', favourite: false, deleted_at: null, version: 1, created_at: now, updated_at: now });
  itemIds.forEach((itemId, position) => api.outfitItems.push({ owner_id: owner, outfit_id: id, item_id: itemId, position }));
  return id;
}
type Start = { language?: Language; setup?: Partial<TryOnSetup> | null; consent?: boolean; route?: 'detail' | 'try-on' | 'settings'; outfit?: 'full' | 'dress' };
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
  const clothes = seed(api);
  if (options.setup !== null) api.tryonControl.setup[owners.a] = { activated: true, ...options.setup };
  if (options.consent !== false) api.tryonControl.consent[owners.a] = 1;
  const outfitId = options.outfit === 'dress' ? seedOutfit(api, [clothes.dress.id, clothes.shoes.id], 'Summer party')
    : seedOutfit(api, [clothes.coat.id, clothes.top.id, clothes.trousers.id, clothes.shoes.id], 'Weekend');
  const hash = options.route === 'settings' ? '#/settings' : options.route === 'try-on' ? `#/outfits/${outfitId}/try-on` : `#/outfits/${outfitId}`;
  await page.goto(`/${hash}`); await signIn(page);
  await expectSignedIn(page);
  return { api, clothes, outfitId };
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
async function openTryOn(page: Page, language: Language = 'en', title = 'Weekend') {
  await expect(page.locator('#outfit-detail-title')).toBeVisible();
  await page.locator('#tryon-open').click();
  await expect(page.locator('#tryon-title')).toBeFocused();
  await expect(page.locator('#tryon-title')).toHaveText(text('tryon.title', language, { name: title }));
}
async function preparePhoto(page: Page, language: Language = 'en') {
  await page.locator('.tryon-page input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page) });
  await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
  await button(page, 'photo.applyCrop', language).click();
  await expect(page.locator('#tryon-start')).toBeFocused({ timeout: 20_000 });
  await expect(page.locator('.tryon-photo img')).toBeVisible();
}
const gate = () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release: () => release() };
};
const failureTitle = (page: Page) => page.locator('#tryon-failure-title');
const status = (page: Page) => page.locator('.tryon-page [aria-live=polite]');
function checkRequests(api: Api, steps: number) {
  const requests = api.tryonControl.requests;
  expect(requests.map((entry) => entry.step)).toEqual(Array.from({ length: steps }, (_, index) => index + 1));
  expect(new Set(requests.map((entry) => entry.chainId)).size).toBe(1);
  expect(new Set(requests.map((entry) => entry.requestId)).size).toBe(steps);
  expect(requests.every((entry) => entry.owner === owners.a && entry.soi)).toBe(true);
  expect(requests.map((entry) => entry.outfitId !== null)).toEqual(requests.map((entry) => entry.step === 1));
  const first = requests[0]!;
  expect([first.width, first.height]).toEqual([1024, 1280]);
  expect(first.bytes).toBeLessThanOrEqual(512_000);
}

test.describe('try-on happy paths', () => {
  test('a three-step outfit sends one request per step and shows the labelled result', async ({ page }) => {
    const { api, outfitId } = await start(page);
    await openTryOn(page);
    await expect(page.locator('.tryon-garments li')).toHaveText([
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.top'), name: 'Olive overshirt' }),
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.bottom'), name: 'Navy trousers' }),
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.footwear'), name: 'White trainers' })]);
    await expect(page.getByText(text('tryon.notIncluded', 'en', { names: 'Grey coat' }), { exact: true })).toBeVisible();
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    await preparePhoto(page);
    await expect(page.locator('#tryon-start')).toHaveText(text('tryon.startMany', 'en', { count: 3 }));
    await expect(page.locator('#tryon-limit')).toHaveText(text('tryon.limitLine'));
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#tryon-title')).toBeFocused();
    await expect(page.locator('.tryon-result figcaption')).toContainText('Made with AI');
    checkRequests(api, 3);
    expect(api.tryonControl.results).toHaveLength(1);
    expect(api.tryonControl.results[0]!.outfitId).toBe(outfitId);
    expect(api.tryonControl.cancels).toEqual([]);
    await page.locator('#tryon-done').click();
    await expect(page.locator('#outfit-detail-title')).toBeVisible();
    // The saved try-on is listed on the outfit until it expires or is deleted.
    await expect(page.locator('#tryon-saved-title')).toHaveText(text('tryon.saved'));
    await expect(page.locator('.tryon-saved-list img')).toBeVisible();
    expect(api.tryonControl.requests).toHaveLength(3);
  });
  test('a one-piece outfit takes two steps', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { outfit: 'dress' });
    await openTryOn(page, 'en', 'Summer party');
    await expect(page.locator('.tryon-garments li')).toHaveText([
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.one_piece'), name: 'Green dress' }),
      text('tryon.slotLine', 'en', { slot: text('tryon.slot.footwear'), name: 'White trainers' })]);
    await preparePhoto(page);
    await expect(page.locator('#tryon-start')).toHaveText(text('tryon.startMany', 'en', { count: 2 }));
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    checkRequests(api, 2);
    expect(api.tryonControl.chains[0]!.steps.map((step) => step.slot)).toEqual(['one_piece', 'footwear']);
  });
  test('shows progress with the current step and no button when try-on is off', async ({ page }) => {
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(status(page)).toHaveText(text('tryon.progress', 'en', { step: 2, total: 3, slot: text('tryon.slot.bottom') }));
    await expect(page.locator('.tryon-steps li')).toHaveText([
      `${text('tryon.stepDone', 'en', { slot: text('tryon.slot.top') })} · Olive overshirt`,
      `${text('tryon.stepNow', 'en', { slot: text('tryon.slot.bottom') })} · Navy trousers`,
      `${text('tryon.stepWaiting', 'en', { slot: text('tryon.slot.footwear') })} · White trainers`]);
    await expect(page.locator('.tryon-steps li[aria-current=step]')).toHaveCount(1);
    await axe(page);
    held.release();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('try-on is offered only when it is on', () => {
  for (const [name, options] of [['not activated', { setup: null, consent: false }], ['not consented', { consent: false }],
    ['paused', { setup: { providerAvailable: false } }]] as const) {
    test(`no Try on button when ${name}`, async ({ page }) => {
      engineOnly();
      const { api } = await start(page, options as Start);
      await expect(page.locator('#outfit-detail-title')).toBeVisible();
      await expect.poll(() => api.tryonControl.statusReads).toBeGreaterThan(0);
      await expect(page.locator('#tryon-open')).toHaveCount(0);
      expect(api.tryonControl.requests).toHaveLength(0);
    });
  }
  test('the try-on route without try-on sends nothing', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { setup: null, consent: false, route: 'try-on' });
    await expect(page.getByText(text('tryon.failure.unavailable'), { exact: true })).toBeVisible();
    await expect(page.locator('.tryon-page input[type=file]')).toHaveCount(0);
    expect(api.tryonControl.requests).toHaveLength(0);
  });
  test('Settings: Turn on consents to notice revision 1 only when the server policy is on and matches', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { consent: false, route: 'settings' });
    const card = page.locator('section[aria-labelledby="tryon-heading"]');
    // UI1: the row's switch shows the server state; an unchecked switch opens the consent sheet, whose Turn on writes.
    const toggle = (on: boolean) => card.locator(`[role="switch"][aria-checked="${on}"]`);
    const sheet = page.locator('dialog[aria-labelledby="tryon-sheet-title"]');
    await expect(page.locator('#tryon-heading')).toHaveText(text('tryonC.settings'));
    await expect(toggle(false)).toBeVisible();
    await card.getByText(text('aiF.about'), { exact: true }).click();
    await expect(card).toContainText(text('tryonC.noticeSent'));
    await expect(card).toContainText(text('tryonC.noticeResult'));
    await axe(page);
    await toggle(false).click();
    await expect(sheet).toContainText(text('tryonC.noticeSent'));
    expect(api.tryonControl.consentWrites).toEqual([]);
    await axe(page);
    await sheet.getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(toggle(true)).toBeVisible();
    expect(api.tryonControl.consentWrites.map((entry) => entry.body)).toEqual([{ p_enabled: true, p_notice_revision: 1 }]);
    await expect(sheet).toHaveCount(0);
    for (const setup of [{ activated: false }, { activated: true, noticeRevision: 2 }]) {
      api.tryonControl.consent[owners.a] = null;
      api.tryonControl.setup[owners.a] = setup;
      const reads = api.tryonControl.statusReads;
      await page.reload();
      await expect.poll(() => api.tryonControl.statusReads).toBeGreaterThan(reads);
      // Without a policy this app has the notice for, the card stays hidden: no consent can be given.
      await expect(page.locator('#tryon-heading')).toHaveCount(0);
      await expect(card.getByRole('switch')).toHaveCount(0);
    }
    expect(api.tryonControl.consentWrites).toHaveLength(1);
  });
  test('Settings: Turn off always works, also while paused', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { consent: false, route: 'settings' });
    const toggle = (on: boolean) => page.locator(`section[aria-labelledby="tryon-heading"] [role="switch"][aria-checked="${on}"]`);
    await expect(toggle(false)).toBeVisible();
    api.tryonControl.consent[owners.a] = 1;
    api.tryonControl.setup[owners.a] = { activated: true, providerAvailable: false };
    await page.reload();
    await expect(page.locator('section[aria-labelledby="tryon-heading"]')).toContainText(text('tryonC.pausedText'));
    await toggle(true).click();
    await expect(toggle(false)).toBeVisible();
    expect(api.tryonControl.consentWrites.map((entry) => entry.body)).toEqual([{ p_enabled: false, p_notice_revision: null }]);
    // Paused is still an activated, matching policy, so it can be turned on again, as for photo clean-up.
    await expect(toggle(false)).toBeEnabled();
  });
});

test.describe('try-on failures', () => {
  test('a block at step 1 offers another photo and makes no result', async ({ page }) => {
    const { api } = await start(page);
    api.tryonControl.replies.push({ code: 'FILTERED', status: 422 });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.filtered'));
    await expect(button(page, 'common.retry')).toHaveCount(0);
    await expect(button(page, 'common.close')).toBeVisible();
    await expect(failureTitle(page)).toBeFocused();
    await axe(page);
    expect(api.tryonControl.results).toHaveLength(0);
    await button(page, 'tryon.changePhoto').click();
    await expect(page.locator('#tryon-choose')).toBeFocused();
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    expect(api.tryonControl.requests).toHaveLength(1);
  });
  test('a block at step 2 shows the same message and offers another photo, not Try again', async ({ page }) => {
    const { api } = await start(page);
    api.tryonControl.replies.push({}, { code: 'FILTERED', status: 422 });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.filtered'));
    await expect(failureTitle(page)).toBeFocused();
    await expect(button(page, 'common.retry')).toHaveCount(0);
    expect(api.tryonControl.results).toHaveLength(0);
    await button(page, 'tryon.changePhoto').click();
    await expect(page.locator('#tryon-choose')).toBeFocused();
    expect(api.tryonControl.requests.map((entry) => entry.step)).toEqual([1, 2]);
  });
  test('busy at step 2: Try again sends exactly one more request', async ({ page }) => {
    const { api } = await start(page);
    api.tryonControl.replies.push({}, { code: 'BUSY', status: 503 }, { code: 'BUSY', status: 503 });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.busy'));
    expect(api.tryonControl.results).toHaveLength(0);
    await button(page, 'common.retry').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.busy'));
    expect(api.tryonControl.requests.map((entry) => entry.step)).toEqual([1, 2, 2]);
    await button(page, 'common.retry').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    expect(api.tryonControl.requests.map((entry) => entry.step)).toEqual([1, 2, 2, 2, 3]);
  });
  test('a lost intermediate picture asks to start again', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    api.tryonControl.replies.push({ abort: true, commit: true });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.lost'), { timeout: 20_000 });
    expect(api.tryonControl.chainReads).toBeGreaterThan(0);
    expect(api.tryonControl.requests).toHaveLength(1);
    await button(page, 'tryon.startAgain').click();
    await expect(page.locator('#tryon-choose')).toBeFocused();
    await expect.poll(() => api.tryonControl.cancels).toEqual([api.tryonControl.requests[0]!.chainId]);
  });
  test('a lost final reply is recovered from the chain status, without sending again', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    api.tryonControl.replies.push({}, {}, { abort: true, commit: true });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    expect(api.tryonControl.requests).toHaveLength(3);
    expect(api.tryonControl.chainReads).toBeGreaterThan(0);
  });
  test('offline during a step: nothing is resent; the step is checked when back online', async ({ page, context }) => {
    engineOnly();
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({ hold: held.hold, abort: true });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(1);
    await context.setOffline(true);
    held.release();
    await expect(status(page)).toHaveText(text('tryon.offline'), { timeout: 20_000 });
    expect(api.tryonControl.chainReads).toBe(0);
    await context.setOffline(false);
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.failed'), { timeout: 20_000 });
    expect(api.tryonControl.chainReads).toBe(1);
    expect(api.tryonControl.requests).toHaveLength(1);
    await button(page, 'common.retry').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    expect(api.tryonControl.requests.map((entry) => entry.step)).toEqual([1, 1, 2, 3]);
  });
  test('a changed garment asks to start again', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    api.tryonControl.replies.push({}, { code: 'CHAIN_MISMATCH', status: 409 });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.mismatch'));
    await expect(button(page, 'common.retry')).toHaveCount(0);
    await button(page, 'tryon.startAgain').click();
    await expect(page.locator('#tryon-choose')).toBeFocused();
  });
  test('turning try-on off during a chain stops it', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(2);
    // The owner turns try-on off in Settings in another tab: consent is withdrawn and running chains end.
    api.tryonControl.consent[owners.a] = null;
    for (const chain of api.tryonControl.chains) chain.state = 'withdrawn';
    held.release();
    await expect(failureTitle(page)).toHaveText(text('tryon.failure.turnedOff'));
    await expect(button(page, 'common.retry')).toHaveCount(0);
    expect(api.tryonControl.results).toHaveLength(0);
  });
});

test.describe('Stop and Delete', () => {
  test('Stop asks first, returns focus when kept going, and cancels the chain', async ({ page }) => {
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(2);
    await page.locator('#tryon-stop').click();
    const dialog = page.getByRole('dialog', { name: text('tryon.stopTitle') });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(text('tryon.stopText'));
    await expect(button(page, 'tryon.keepGoing')).toBeFocused();
    await axe(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#tryon-stop')).toBeFocused();
    expect(api.tryonControl.cancels).toEqual([]);
    await page.locator('#tryon-stop').click();
    await page.locator('#tryon-stop-confirm-confirm').click();
    await expect(page.getByText(text('tryon.stopped'), { exact: true })).toBeVisible();
    expect(api.tryonControl.cancels).toEqual([api.tryonControl.requests[0]!.chainId]);
    held.release();
    await page.waitForTimeout(200);
    expect(api.tryonControl.requests).toHaveLength(2);
    expect(api.tryonControl.results).toHaveLength(0);
  });
  test('Stop before the first step is claimed stays stopped when the held request arrives later', async ({ page }) => {
    const { api, outfitId } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({ hold: held.hold });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(1);
    const chainId = api.tryonControl.requests[0]!.chainId;
    // The server has not seen the chain yet: Stop records a stop for it and replies CANCELLED.
    await page.locator('#tryon-stop').click();
    await page.locator('#tryon-stop-confirm-confirm').click();
    await expect(page.getByText(text('tryon.stopped'), { exact: true })).toBeVisible();
    expect(api.tryonControl.cancels).toEqual([chainId]);
    expect(api.tryonControl.stops).toEqual([{ owner: owners.a, chainId }]);
    await axe(page);
    // The held request now reaches the server and is refused at its claim: no chain, no result, and the page stays stopped.
    held.release();
    await expect.poll(() => api.tryonControl.stopRefusals).toBe(1);
    await page.waitForTimeout(200);
    expect(api.tryonControl.chains).toHaveLength(0);
    await expect(page.getByText(text('tryon.stopped'), { exact: true })).toBeVisible();
    await expect(page.locator('.tryon-result img')).toHaveCount(0);
    expect(api.tryonControl.requests).toHaveLength(1);
    expect(api.tryonControl.results).toHaveLength(0);
    // Reopened, the outfit lists no saved try-on.
    await page.goto(`/#/outfits/${outfitId}`);
    await expect(page.locator('#outfit-detail-title')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(0);
    expect(api.tryonControl.results).toHaveLength(0);
  });
  test('Stop after the last step finished shows the result', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, {}, { hold: held.hold });
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(3);
    const chain = api.tryonControl.chains[0]!;
    const row = { id: randomUUID(), owner: owners.a, outfitId: chain.outfitId, itemIds: chain.steps.map((step) => step.itemId),
      image: api.fixture, completedAtMs: Date.now(), expiresAtMs: Date.now() + 7 * 86_400_000 };
    api.tryonControl.results.push(row);
    Object.assign(chain, { state: 'complete', resultId: row.id, nextStep: 4 });
    await page.locator('#tryon-stop').click();
    await page.locator('#tryon-stop-confirm-confirm').click();
    await expect(page.getByText(text('tryon.alreadyFinished'), { exact: true })).toBeVisible();
    await expect(page.locator('.tryon-result img')).toBeVisible();
    await expect(page.locator('#tryon-result-delete')).toBeVisible();
    held.release();
  });
  test('Delete asks first and removes the try-on', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    await page.locator('#tryon-result-delete').click();
    const dialog = page.getByRole('dialog', { name: text('tryon.deleteTitle') });
    await expect(dialog).toBeVisible();
    await axe(page);
    await button(page, 'common.cancel').click();
    await expect(page.locator('#tryon-result-delete')).toBeFocused();
    expect(api.tryonControl.deletes).toEqual([]);
    await page.locator('#tryon-result-delete').click();
    await page.locator('#tryon-result-confirm-confirm').click();
    await expect(page.getByText(text('tryon.deleted'), { exact: true })).toBeVisible();
    expect(api.tryonControl.deletes).toEqual([api.tryonControl.chains[0]!.resultId]);
    expect(api.tryonControl.results).toHaveLength(0);
  });
  test('a saved try-on leaves the outfit when it expires', async ({ page }) => {
    engineOnly();
    const api = await mockBackend(page);
    const clothes = seed(api);
    api.tryonControl.setup[owners.a] = { activated: true };
    api.tryonControl.consent[owners.a] = 1;
    const outfitId = seedOutfit(api, [clothes.top.id], 'Weekend');
    api.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId, itemIds: [clothes.top.id], image: api.fixture,
      completedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 12_000 });
    await page.goto(`/#/outfits/${outfitId}`); await signIn(page);
    await expect(page.locator('.tryon-saved-list img')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.tryon-saved figcaption')).toContainText('Made with AI');
    await expect(page.getByText(text('tryon.deleted'), { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(0);
  });
  test('with several saved try-ons, deleting or expiring one keeps the others and settles', async ({ page }) => {
    engineOnly();
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    const api = await mockBackend(page);
    const clothes = seed(api);
    api.tryonControl.setup[owners.a] = { activated: true };
    api.tryonControl.consent[owners.a] = 1;
    const outfitId = seedOutfit(api, [clothes.top.id], 'Weekend');
    const stored = (expiresInMs: number, age: number) => {
      const id = randomUUID();
      api.tryonControl.results.push({ id, owner: owners.a, outfitId, itemIds: [clothes.top.id], image: api.fixture,
        completedAtMs: Date.now() - age, expiresAtMs: Date.now() + expiresInMs });
      return id;
    };
    const expiring = stored(15_000, 1000), deleting = stored(3_600_000, 2000), kept = stored(3_600_000, 3000);
    let reads = 0;
    page.on('request', request => { if (/\/rpc\/tryon_(results_v1|result_image_v1)$/.test(new URL(request.url()).pathname)) reads += 1; });
    await page.goto(`/#/outfits/${outfitId}`); await signIn(page);
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(3, { timeout: 10_000 });
    await page.locator(`#tryon-${deleting}-delete`).click();
    await page.locator(`#tryon-${deleting}-confirm-confirm`).click();
    await expect(page.getByText(text('tryon.deleted'), { exact: true })).toBeVisible();
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(2);
    expect(api.tryonControl.deletes).toEqual([deleting]);
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(`#tryon-${kept}-delete`)).toBeVisible();
    await expect(page.locator(`#tryon-${expiring}-delete`)).toHaveCount(0);
    const settled = reads;
    await page.waitForTimeout(1500);
    expect(reads).toBe(settled);
    await expect(page.getByText(text('tryon.deleted'), { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  });
  test('a failed list of saved try-ons says so and offers Retry', async ({ page }) => {
    engineOnly();
    const api = await mockBackend(page);
    const clothes = seed(api);
    api.tryonControl.setup[owners.a] = { activated: true };
    api.tryonControl.consent[owners.a] = 1;
    const outfitId = seedOutfit(api, [clothes.top.id], 'Weekend');
    api.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId, itemIds: [clothes.top.id], image: api.fixture,
      completedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000 });
    let failing = true;
    await page.route('**/rest/v1/rpc/tryon_results_v1', async route => {
      if (failing) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"fixture"}' }); return; }
      await route.fallback();
    });
    await page.goto(`/#/outfits/${outfitId}`); await signIn(page);
    await expect(page.locator('.tryon-saved [role=alert]')).toContainText(text('tryon.savedFailed'), { timeout: 10_000 });
    await axe(page);
    failing = false;
    await page.locator('#tryon-saved-retry').click();
    await expect(page.locator('.tryon-saved-list img')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.tryon-saved [role=alert]')).toHaveCount(0);
  });
});

test.describe('try-on layout', () => {
  test('fits 320 px at 200% text and passes axe in setup, crop, progress and failure', async ({ page }) => {
    const { api } = await start(page);
    const held = gate();
    api.tryonControl.replies.push({}, { hold: held.hold });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: zoom });
    await openTryOn(page);
    await page.addStyleTag({ content: zoom });
    await noOverflow(page);
    await axe(page);
    await page.locator('.tryon-page input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page) });
    await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
    await noOverflow(page);
    await axe(page);
    await button(page, 'photo.applyCrop').click();
    await expect(page.locator('#tryon-start')).toBeFocused({ timeout: 20_000 });
    await noOverflow(page);
    await page.locator('#tryon-start').click();
    await expect.poll(() => api.tryonControl.requests.length).toBe(2);
    await noOverflow(page);
    await axe(page);
    api.tryonControl.replies.length = 0;
    for (const chain of api.tryonControl.chains) chain.state = 'stale';
    held.release();
    await expect(failureTitle(page)).toBeVisible();
    await noOverflow(page);
    await axe(page);
  });
});

test.describe('bounded VTO-2 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'consent', project: 'mobile', language: 'sv', width: 390, suffix: 'sv-mobile', zoom: false },
    { scene: 'progress', project: 'mobile', language: 'fi', width: 390, suffix: 'fi-mobile', zoom: false },
    { scene: 'result', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop', zoom: false },
    { scene: 'failure', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-320-200', zoom: true },
  ] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/vto2-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      const held = gate();
      if (selected.scene === 'consent') {
        await start(page, { language, consent: false, route: 'settings' });
        const card = page.locator('section[aria-labelledby="tryon-heading"]');
        await expect(card.locator('[role="switch"][aria-checked="false"]')).toBeVisible();
        await card.getByText(text('aiF.about', language), { exact: true }).click();
        await expect(card).toContainText(text('tryonC.noticeCharges', language));
        await page.locator('#tryon-heading').scrollIntoViewIfNeeded();
      } else {
        const { api } = await start(page, { language });
        api.tryonControl.replies.push({}, selected.scene === 'progress' ? { hold: held.hold } : selected.scene === 'failure' ? { code: 'FILTERED', status: 422 } : {});
        if (selected.zoom) await page.addStyleTag({ content: zoom });
        await openTryOn(page, language);
        await preparePhoto(page, language);
        await page.locator('#tryon-start').click();
        if (selected.scene === 'progress') {
          await expect(status(page)).toHaveText(text('tryon.progress', language, { step: 2, total: 3, slot: text('tryon.slot.bottom', language) }));
        } else if (selected.scene === 'failure') {
          await expect(failureTitle(page)).toHaveText(text('tryon.failure.filtered', language));
        } else {
          await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
          await expect(page.locator('.tryon-result img')).toHaveJSProperty('complete', true);
        }
        if (selected.zoom) await page.addStyleTag({ content: zoom });
        await page.evaluate(() => scrollTo(0, 0));
      }
      if (selected.zoom) await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      await axe(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: language, width: selected.width })).toBe(true);
      if (write) {
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      }
      held.release();
    });
  }
});
