import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import '../../src/i18n/tryon';
import { TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { jpegSize, mockBackend, owners, signIn, type TryOnSetup } from './mock-backend';
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
  if (options.consent !== false) api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
  const outfitId = options.outfit === 'dress' ? seedOutfit(api, [clothes.dress.id, clothes.shoes.id], 'Summer party')
    : seedOutfit(api, [clothes.coat.id, clothes.top.id, clothes.trousers.id, clothes.shoes.id], 'Weekend');
  const hash = options.route === 'settings' ? '#/settings' : options.route === 'try-on' ? `#/outfits/${outfitId}/try-on` : `#/outfits/${outfitId}`;
  await page.goto(`/${hash}`); await signIn(page);
  await expectSignedIn(page);
  return { api, clothes, outfitId };
}
async function syntheticPerson(page: Page, shirt = '#3d5a80'): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (shirtColour) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 1000 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e4e1da'; context.fillRect(0, 0, 800, 1000);
    context.fillStyle = '#8a6f5a'; context.beginPath(); context.arc(400, 170, 80, 0, Math.PI * 2); context.fill();
    context.fillStyle = shirtColour; context.fillRect(290, 260, 220, 330);
    context.fillStyle = '#293241'; context.fillRect(300, 590, 90, 330); context.fillRect(410, 590, 90, 330);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, shirt));
}
async function openTryOn(page: Page, language: Language = 'en', title = 'Weekend') {
  await expect(page.locator('#outfit-detail-title')).toBeVisible();
  await page.locator('#tryon-open').click();
  await expect(page.locator('#tryon-title')).toBeFocused();
  await expect(page.locator('#tryon-title')).toHaveText(text('tryon.title', language, { name: title }));
}
async function preparePhoto(page: Page, language: Language = 'en', shirt?: string) {
  await page.locator('.tryon-page input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page, shirt) });
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
  test('Settings: Turn on consents to the current notice revision only when the server policy is on and matches', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { consent: false, route: 'settings' });
    const card = page.locator('section[aria-labelledby="tryon-heading"]');
    // UI1: the row's switch shows the server state; an unchecked switch opens the consent sheet, whose Turn on writes.
    const toggle = (on: boolean) => card.locator(`[role="switch"][aria-checked="${on}"]`);
    const sheet = page.locator('dialog[aria-labelledby="tryon-sheet-title"]');
    await expect(page.locator('#tryon-heading')).toHaveText(text('tryonC.settings'));
    await expect(toggle(false)).toBeVisible();
    await card.getByText(text('aiF.about'), { exact: true }).click();
    await expect(card).toContainText(text('tryonC.notice2Sent'));
    await expect(card).toContainText(text('tryonC.notice2Result'));
    await axe(page);
    await toggle(false).click();
    await expect(sheet).toContainText(text('tryonC.notice2Sent'));
    await expect(sheet).toContainText(text('tryonC.notice2Saved'));
    expect(api.tryonControl.consentWrites).toEqual([]);
    await axe(page);
    await sheet.getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(toggle(true)).toBeVisible();
    expect(api.tryonControl.consentWrites.map((entry) => entry.body)).toEqual([{ p_enabled: true, p_notice_revision: TRYON_NOTICE_REVISION }]);
    await expect(sheet).toHaveCount(0);
    for (const setup of [{ activated: false }, { activated: true, noticeRevision: TRYON_NOTICE_REVISION + 1 }]) {
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
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
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
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
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
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
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
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
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

const seedPhoto = (api: Api, jpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), savedAtMs = Date.now() - 86_400_000) => {
  api.tryonControl.photos[owners.a] = { jpeg, sha256: createHash('sha256').update(jpeg).digest('hex'), savedAtMs };
};
const photoCard = (page: Page) => page.locator('section[aria-labelledby="tryon-photo-heading"]');
const profilePhoto = (page: Page) => page.locator('section[aria-labelledby="profile-photo-heading"]');
const confirmRemoval = async (page: Page, id = 'tryon-remove-photo-confirm') => {
  await page.locator(`#${id}-confirm`).click();
};

test.describe('saved reference photo (TRYON-PHOTO1)', () => {
  test('is saved once, and later try-ons start from it without asking again', async ({ page }) => {
    const { api } = await start(page);
    await openTryOn(page);
    await preparePhoto(page);
    // Saving is an explicit button, never automatic, and a try-on needs no save.
    await expect(page.locator('#tryon-save-photo')).toHaveText(text('tryon.savePhoto'));
    expect(api.tryonControl.photoCalls.put).toBe(0);
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaved'), { exact: true })).toBeVisible();
    await expect(page.locator('#tryon-save-photo')).toHaveCount(0);
    expect(api.tryonControl.photoCalls.put).toBe(1);
    const stored = api.tryonControl.photos[owners.a]!;
    expect(jpegSize(stored.jpeg)).toEqual({ width: 1024, height: 1280 });
    expect(stored.sha256).toBe(createHash('sha256').update(stored.jpeg).digest('hex'));
    await page.reload();
    await expect(page.locator('.tryon-photo img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.tryon-photo img')).toHaveAttribute('alt', text('tryon.savedPhoto'));
    await expect(page.locator('#tryon-saved-caption')).toContainText('Saved ');
    await expect(page.locator('#tryon-choose')).toHaveText(text('tryon.changePhoto'));
    await expect(page.locator('#tryon-remove-photo')).toHaveText(text('tryon.removePhoto'));
    await expect(page.locator('#tryon-start')).toHaveText(text('tryon.startMany', 'en', { count: 3 }));
    await axe(page);
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    checkRequests(api, 3);
    // The very bytes that were saved are sent, and nothing is saved or removed by trying on.
    expect(api.tryonControl.requests[0]!.bytes).toBe(stored.jpeg.length);
    expect(api.tryonControl.photoCalls.put).toBe(1);
    expect(api.tryonControl.photoDeletes).toBe(0);
    expect(api.tryonControl.photos[owners.a]).toBe(stored);
  });

  test('another photo is used once or replaces the saved one, only when asked', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaved'), { exact: true })).toBeVisible();
    const first = api.tryonControl.photos[owners.a]!.sha256;
    await page.reload();
    await expect(page.locator('.tryon-photo img')).toBeVisible({ timeout: 20_000 });
    // Used once: the saved photo is not touched.
    await preparePhoto(page, 'en', '#a33b3b');
    await expect(page.locator('#tryon-save-photo')).toHaveText(text('tryon.replacePhoto'));
    await expect(page.locator('#tryon-remove-photo')).toHaveCount(0);
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    expect(api.tryonControl.photoCalls.put).toBe(1);
    expect(api.tryonControl.photos[owners.a]!.sha256).toBe(first);
    await page.locator('#tryon-done').click();
    // Replaced: only through the button.
    await openTryOn(page);
    await expect(page.locator('.tryon-photo img')).toBeVisible({ timeout: 20_000 });
    await preparePhoto(page, 'en', '#a33b3b');
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaved'), { exact: true })).toBeVisible();
    expect(api.tryonControl.photoCalls.put).toBe(2);
    expect(api.tryonControl.photos[owners.a]!.sha256).not.toBe(first);
  });

  test('Remove asks first, removes it, and the screen asks for a photo again', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaved'), { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('.tryon-photo img')).toBeVisible({ timeout: 20_000 });
    await page.locator('#tryon-remove-photo').click();
    await expect(page.getByRole('heading', { name: text('tryon.removePhotoTitle'), exact: true })).toBeVisible();
    await page.getByRole('button', { name: text('common.cancel'), exact: true }).click();
    expect(api.tryonControl.photoDeletes).toBe(0);
    await expect(page.locator('#tryon-remove-photo')).toBeFocused();
    await page.locator('#tryon-remove-photo').click();
    await confirmRemoval(page);
    await expect(page.getByText(text('tryon.photoRemoved'), { exact: true })).toBeVisible();
    await expect(page.locator('#tryon-choose')).toBeFocused();
    await expect(page.locator('.tryon-photo img')).toHaveCount(0);
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await page.reload();
    await expect(page.locator('#tryon-photo-tip')).toBeVisible();
    await expect(page.locator('#tryon-remove-photo')).toHaveCount(0);
  });

  test('a failed save says so and the try-on still works from the chosen photo', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    api.tryonControl.photoFaults.put.push('fail');
    await openTryOn(page);
    await preparePhoto(page);
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaveFailed'), { exact: true })).toBeVisible();
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await expect(page.locator('#tryon-start')).toBeEnabled();
    await page.locator('#tryon-start').click();
    await expect(page.locator('.tryon-result img')).toBeVisible({ timeout: 20_000 });
    checkRequests(api, 3);
  });

  test('a saved photo that is no longer usable is not sent, and can be removed', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'try-on' });
    seedPhoto(api, Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]));
    await page.reload();
    await expect(page.getByText(text('tryon.photoUnusableSaved'), { exact: true })).toBeVisible();
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    await expect(page.locator('#tryon-remove-photo')).toBeVisible();
    await axe(page);
    await page.locator('#tryon-remove-photo').click();
    await confirmRemoval(page);
    await expect(page.getByText(text('tryon.photoRemoved'), { exact: true })).toBeVisible();
    expect(api.tryonControl.requests).toHaveLength(0);
  });

  test('a photo still being fetched is never used once it was removed', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'try-on' });
    await expect(page.locator('#tryon-photo-tip')).toBeVisible();
    await preparePhoto(page);
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaved'), { exact: true })).toBeVisible();
    const held = gate();
    api.tryonControl.photoHolds.push(held.hold);
    await page.reload();
    await expect.poll(() => api.tryonControl.photoCalls.get).toBe(1);
    await expect(page.locator('#tryon-remove-photo')).toBeVisible();
    await page.locator('#tryon-remove-photo').click();
    await confirmRemoval(page);
    await expect(page.getByText(text('tryon.photoRemoved'), { exact: true })).toBeVisible();
    held.release();
    // The late reply carries bytes, but they are dropped: no image, no Start.
    await expect(page.locator('#tryon-photo-tip')).toBeVisible();
    await expect(page.locator('.tryon-photo img')).toHaveCount(0);
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    expect(api.tryonControl.requests).toHaveLength(0);
  });

  test('Settings: the saved photo can be removed while try-on is paused, and shows when it was saved', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { setup: { providerAvailable: false }, route: 'settings' });
    seedPhoto(api);
    await page.reload();
    await expect(page.locator('section[aria-labelledby="tryon-heading"]')).toContainText(text('tryonC.pausedText'));
    await expect(profilePhoto(page)).toBeVisible();
    await expect(page.locator('#profile-photo-heading')).toHaveText(text('tryonC.photoHeading'));
    await expect(profilePhoto(page)).toContainText('Saved ');
    // Try-on is paused: nothing can be added or replaced, and the block says so instead of offering it.
    await expect(profilePhoto(page)).toContainText(text('tryon.failure.unavailable'));
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    // Settings only shows the state: it fetches the photo only when asked.
    expect(api.tryonControl.photoCalls.get).toBe(0);
    await axe(page);
    await page.locator('#profile-photo-remove').click();
    await confirmRemoval(page, 'profile-photo-remove-confirm');
    await expect(profilePhoto(page)).toContainText(text('tryon.photoRemoved'));
    await expect(page.locator('#profile-photo-heading')).toBeFocused();
    await expect(page.locator('#profile-photo-remove')).toHaveCount(0);
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await axe(page);
  });

  test('Settings: a failed status read says so, offers Retry and Remove, and never reads as "no photo"', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    seedPhoto(api);
    api.tryonControl.photoStatusDown = true;
    await page.reload();
    await expect(profilePhoto(page)).toBeVisible();
    await expect(profilePhoto(page).getByRole('alert')).toHaveText(text('tryon.photoStatusFailed'));
    await expect(profilePhoto(page)).not.toContainText('Saved ');
    await expect(profilePhoto(page)).not.toContainText(text('tryonC.photoEmpty'));
    await expect(page.locator('#profile-photo-retry')).toBeVisible();
    await expect(page.locator('#profile-photo-remove')).toBeVisible();
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    await axe(page);
    // Retry reads again and shows the real state.
    api.tryonControl.photoStatusDown = false;
    await page.locator('#profile-photo-retry').click();
    await expect(profilePhoto(page)).toContainText('Saved ');
    await expect(profilePhoto(page).getByRole('alert')).toHaveCount(0);
    await expect(page.locator('#profile-photo-retry')).toHaveCount(0);
    // Removal stays reachable while the state is unknown, and removes the existing server photo.
    api.tryonControl.photoStatusDown = true;
    await page.reload();
    await expect(page.locator('#profile-photo-retry')).toBeVisible();
    await page.locator('#profile-photo-remove').click();
    await confirmRemoval(page, 'profile-photo-remove-confirm');
    await expect(profilePhoto(page)).toContainText(text('tryon.photoRemoved'));
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    expect(api.tryonControl.photoDeletes).toBe(1);
  });

  test('Setup: a failed status read with a photo on the server is not treated as none or offered as a new save', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'try-on' });
    seedPhoto(api);
    api.tryonControl.photoStatusDown = true;
    await page.reload();
    await expect(page.getByText(text('tryon.photoStatusFailed'), { exact: true })).toBeVisible();
    await expect(page.locator('#tryon-photo-retry')).toBeVisible();
    await expect(page.locator('#tryon-remove-photo')).toBeVisible();
    await expect(page.locator('#tryon-start')).toHaveCount(0);
    await axe(page);
    // A photo chosen now can be tried on, but it is never offered as a (new) save while the server state is unknown.
    await preparePhoto(page);
    await expect(page.locator('#tryon-start')).toBeEnabled();
    await expect(page.locator('#tryon-save-photo')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveText(text('tryon.photoStatusFailed'));
    expect(api.tryonControl.photoCalls.put).toBe(0);
    // Once the read works again the same button is a replacement, because a photo exists.
    api.tryonControl.photoStatusDown = false;
    await page.locator('#tryon-photo-retry').click();
    await expect(page.locator('#tryon-save-photo')).toHaveText(text('tryon.replacePhoto'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    api.tryonControl.photoStatusDown = true;
    await page.reload();
    await expect(page.locator('#tryon-remove-photo')).toBeVisible();
    await page.locator('#tryon-remove-photo').click();
    await confirmRemoval(page);
    await expect(page.getByText(text('tryon.photoRemoved'), { exact: true })).toBeVisible();
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
  });

  test('Settings: Profile offers Add when no photo is saved, and Turn off removes a saved one', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await expect(page.locator('section[aria-labelledby="tryon-heading"]')).toBeVisible();
    await expect.poll(() => api.tryonControl.photoCalls.status).toBeGreaterThan(0);
    await expect(profilePhoto(page)).toContainText(text('tryonC.photoEmpty'));
    await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoAdd'));
    await expect(page.locator('#profile-photo-remove')).toHaveCount(0);
    seedPhoto(api);
    await page.reload();
    await expect(profilePhoto(page)).toContainText('Saved ');
    await page.locator('section[aria-labelledby="tryon-heading"] [role="switch"][aria-checked="true"]').click();
    await expect(page.locator('section[aria-labelledby="tryon-heading"] [role="switch"][aria-checked="false"]')).toBeVisible();
    await expect(profilePhoto(page)).not.toContainText('Saved ');
    await expect(page.locator('#profile-photo-remove')).toHaveCount(0);
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    expect(api.tryonControl.consentWrites.map((entry) => entry.body)).toEqual([{ p_enabled: false, p_notice_revision: null }]);
  });

  test('the try-on screen offers Remove even when try-on is not available', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { setup: { providerAvailable: false }, route: 'try-on' });
    seedPhoto(api);
    await page.reload();
    await expect(page.getByText(text('tryon.failure.unavailable'), { exact: true })).toBeVisible();
    await expect(page.locator('.tryon-page input[type=file]')).toHaveCount(0);
    await expect(photoCard(page)).toBeVisible();
    await page.locator('#tryon-photo-remove').click();
    await confirmRemoval(page, 'tryon-photo-confirm');
    await expect(photoCard(page)).toContainText(text('tryon.photoRemoved'));
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    expect(api.tryonControl.requests).toHaveLength(0);
  });

  test('a save is refused by the server without consent to the current notice, and nothing is kept', async ({ page }) => {
    engineOnly();
    const { api } = await start(page);
    await openTryOn(page);
    await preparePhoto(page);
    // Consent given to another revision after the screen opened: the server refuses and the app shows the failure.
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION - 1;
    await page.locator('#tryon-save-photo').click();
    await expect(page.getByText(text('tryon.photoSaveFailed'), { exact: true })).toBeVisible();
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
  });
});

async function chooseProfilePhoto(page: Page, language: Language = 'en', shirt?: string) {
  await page.locator('#profile-photo-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page, shirt) });
  await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
  await button(page, 'photo.applyCrop', language).click();
  await expect(page.locator('#profile-photo-save')).toBeFocused({ timeout: 20_000 });
  await expect(page.locator('.profile-photo-preview')).toBeVisible();
}
const saveProfilePhoto = async (page: Page, language: Language = 'en') => {
  await page.locator('#profile-photo-save').click();
  await expect(profilePhoto(page)).toContainText(text('tryon.photoSaved', language));
};

test.describe('photo of you under Settings > Profile (PHOTO2)', () => {
  test('a chosen photo is saved only on Save; Cancel and Replace leave the saved one alone until then', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoAdd'));
    await chooseProfilePhoto(page);
    expect(api.tryonControl.photoCalls.put).toBe(0);
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    await axe(page);
    await page.locator('#profile-photo-save').click();
    await expect(profilePhoto(page)).toContainText(text('tryon.photoSaved'));
    await expect(page.locator('#profile-photo-heading')).toBeFocused();
    expect(api.tryonControl.photoCalls.put).toBe(1);
    const stored = api.tryonControl.photos[owners.a]!;
    expect(jpegSize(stored.jpeg)).toEqual({ width: 1024, height: 1280 });
    expect(stored.sha256).toBe(createHash('sha256').update(stored.jpeg).digest('hex'));
    await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoReplace'));
    await expect(profilePhoto(page)).toContainText('Saved ');
    await expect(profilePhoto(page)).toContainText(text('tryonC.photoPrivate'));
    await axe(page);
    await chooseProfilePhoto(page, 'en', '#a33b3b');
    await page.locator('#profile-photo-cancel').click();
    await expect(page.locator('#profile-photo-add')).toBeFocused();
    expect(api.tryonControl.photoCalls.put).toBe(1);
    expect(api.tryonControl.photos[owners.a]).toBe(stored);
    await chooseProfilePhoto(page, 'en', '#a33b3b');
    await saveProfilePhoto(page);
    expect(api.tryonControl.photoCalls.put).toBe(2);
    expect(api.tryonControl.photos[owners.a]!.sha256).not.toBe(stored.sha256);
    expect(api.tryonControl.photoDeletes).toBe(0);
  });

  test('the saved photo is fetched only when shown, and dropped when hidden', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await chooseProfilePhoto(page);
    await saveProfilePhoto(page);
    await page.reload();
    await expect(page.locator('#profile-photo-show')).toHaveText(text('tryonC.photoShow'));
    expect(api.tryonControl.photoCalls.get).toBe(0);
    await expect(page.locator('.profile-photo-preview')).toHaveCount(0);
    await page.locator('#profile-photo-show').click();
    await expect(page.locator('.profile-photo-preview')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.profile-photo-preview')).toHaveAttribute('alt', text('tryon.savedPhoto'));
    await expect(page.locator('#profile-photo-show')).toHaveText(text('tryonC.photoHide'));
    expect(api.tryonControl.photoCalls.get).toBe(1);
    await axe(page);
    await page.locator('#profile-photo-show').click();
    await expect(page.locator('.profile-photo-preview')).toHaveCount(0);
    expect(api.tryonControl.photoCalls.get).toBe(1);
  });

  test('Remove asks first, keeps focus where it was on Cancel, and removes the photo on the server', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await chooseProfilePhoto(page);
    await saveProfilePhoto(page);
    await page.locator('#profile-photo-remove').click();
    await expect(page.getByRole('heading', { name: text('tryon.removePhotoTitle'), exact: true })).toBeVisible();
    await page.getByRole('button', { name: text('common.cancel'), exact: true }).click();
    await expect(page.locator('#profile-photo-remove')).toBeFocused();
    expect(api.tryonControl.photoDeletes).toBe(0);
    await page.locator('#profile-photo-remove').click();
    await confirmRemoval(page, 'profile-photo-remove-confirm');
    await expect(profilePhoto(page)).toContainText(text('tryon.photoRemoved'));
    await expect(page.locator('#profile-photo-heading')).toBeFocused();
    await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoAdd'));
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await axe(page);
  });

  test('a failed save says so, keeps the chosen photo and can be retried', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    api.tryonControl.photoFaults.put.push('fail');
    await chooseProfilePhoto(page);
    await page.locator('#profile-photo-save').click();
    await expect(profilePhoto(page).getByRole('alert')).toHaveText(text('tryonC.photoSaveFailed'));
    await expect(page.locator('#profile-photo-save')).toBeFocused();
    await expect(page.locator('.profile-photo-preview')).toBeVisible();
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await axe(page);
    await saveProfilePhoto(page);
    await expect(profilePhoto(page).getByRole('alert')).toHaveCount(0);
    expect(api.tryonControl.photos[owners.a]).toBeDefined();
  });

  test('a save the server refuses is never reported as saved, and the block explains how to continue', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await chooseProfilePhoto(page);
    api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION - 1;
    await page.locator('#profile-photo-save').click();
    await expect(profilePhoto(page).getByRole('alert')).toHaveText(text('tryonC.photoSaveRefused'));
    await expect(profilePhoto(page)).not.toContainText(text('tryon.photoSaved'));
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    await expect(page.locator('#profile-photo-save')).toHaveCount(0);
    await expect(profilePhoto(page)).toContainText(text('tryonC.photoNeedsOn'));
    await expect(page.locator('#profile-photo-turn-on')).toBeVisible();
    await axe(page);
  });

  test('with try-on off, Add is replaced by a way to turn it on, and a saved photo can still be removed', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { consent: false, route: 'settings' });
    await expect(profilePhoto(page)).toContainText(text('tryonC.photoNeedsOn'));
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    await axe(page);
    await page.locator('#profile-photo-turn-on').click();
    await expect(page.locator('#tryon-heading')).toBeFocused();
    seedPhoto(api);
    await page.reload();
    await expect(profilePhoto(page)).toContainText('Saved ');
    await expect(page.locator('#profile-photo-add')).toHaveCount(0);
    await page.locator('#profile-photo-remove').click();
    await confirmRemoval(page, 'profile-photo-remove-confirm');
    await expect(profilePhoto(page)).toContainText(text('tryon.photoRemoved'));
    expect(api.tryonControl.photos[owners.a]).toBeUndefined();
    expect(api.tryonControl.photoCalls.put).toBe(0);
  });

  test('the block is absent when try-on is unavailable and no photo is saved', async ({ page }) => {
    engineOnly();
    const { api } = await start(page, { setup: { providerAvailable: false }, route: 'settings' });
    await expect(page.locator('section[aria-labelledby="tryon-heading"]')).toContainText(text('tryonC.pausedText'));
    await expect.poll(() => api.tryonControl.photoCalls.status).toBeGreaterThan(0);
    await expect(profilePhoto(page)).toHaveCount(0);
    await expect(page.locator('#tryon-photo-link')).toHaveCount(0);
  });

  test('the Try-on card points to the photo only while one is saved, and controls are disabled offline', async ({ page, context }) => {
    engineOnly();
    const { api } = await start(page, { route: 'settings' });
    await expect(profilePhoto(page)).toBeVisible();
    await expect(page.locator('#tryon-photo-link')).toHaveCount(0);
    seedPhoto(api);
    await page.reload();
    await expect(page.locator('#tryon-photo-link')).toHaveText(text('tryonC.photoGoTo'));
    await page.locator('#tryon-photo-link').click();
    await expect(page.locator('#profile-photo-heading')).toBeFocused();
    await context.setOffline(true);
    await expect(page.locator('#profile-photo-remove')).toBeDisabled();
    await expect(page.locator('#profile-photo-add')).toBeDisabled();
    await expect(page.locator('#profile-photo-show')).toBeDisabled();
    await context.setOffline(false);
    await expect(page.locator('#profile-photo-remove')).toBeEnabled();
  });

  test('fits 320 px at 200% text and passes axe when empty, cropping and saved', async ({ page }) => {
    const { api } = await start(page, { route: 'settings' });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: zoom });
    await expect(page.locator('#profile-photo-add')).toBeVisible();
    await noOverflow(page); await axe(page);
    await page.locator('#profile-photo-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticPerson(page) });
    await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
    await noOverflow(page); await axe(page);
    await button(page, 'photo.applyCrop').click();
    await expect(page.locator('#profile-photo-save')).toBeFocused({ timeout: 20_000 });
    await noOverflow(page); await axe(page);
    await saveProfilePhoto(page);
    await expect(page.locator('#profile-photo-show')).toBeVisible();
    await noOverflow(page); await axe(page);
    expect(api.tryonControl.photos[owners.a]).toBeDefined();
  });
});

// PHOTO2 visual evidence for the Profile photo block: three bounded viewport captures (never full page), written by their selected
// project only; every project keeps the functional and axe assertions. Synthetic figure, ignored buffers.
test.describe('bounded PHOTO2 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'profile-photo-saved', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'profile-photo-empty', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-320' },
    { scene: 'profile-photo-needs-on', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
  ] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/tryon-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      const { api } = await start(page, { language, route: 'settings', consent: selected.scene !== 'profile-photo-needs-on' });
      if (selected.scene === 'profile-photo-saved') {
        await chooseProfilePhoto(page, language);
        await saveProfilePhoto(page, language);
        await page.reload();
        await page.locator('#profile-photo-show').click();
        await expect(page.locator('.profile-photo-preview')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('.profile-photo-preview')).toHaveJSProperty('complete', true);
        await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoReplace', language));
        await expect(page.locator('#profile-photo-remove')).toHaveText(text('tryon.removePhoto', language));
        expect(api.tryonControl.photos[owners.a]).toBeDefined();
      } else if (selected.scene === 'profile-photo-empty') {
        await expect(page.locator('#profile-photo-add')).toHaveText(text('tryonC.photoAdd', language));
        await expect(profilePhoto(page)).toContainText(text('tryonC.photoEmpty', language));
      } else {
        await expect(page.locator('#profile-photo-turn-on')).toHaveText(text('tryonC.photoTurnOn', language));
        await expect(profilePhoto(page)).toContainText(text('tryonC.photoNeedsOn', language));
        await expect(page.locator('#profile-photo-add')).toHaveCount(0);
      }
      await page.evaluate(() => document.getElementById('profile-photo-heading')?.scrollIntoView({ block: 'start' }));
      await axe(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: language, width: selected.width })).toBe(true);
      if (write) {
        const png = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      }
    });
  }
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
        await expect(card).toContainText(text('tryonC.notice2Charges', language));
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

// TRYON-IDEA1 and TRYON-PHOTO1 visual evidence for the try-on setup screen: two bounded viewport captures (never full page),
// written by their selected project only; every project keeps the functional and axe assertions. Synthetic figure, ignored buffers.
test.describe('bounded TRYON setup visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'setup-subset', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'setup-saved-photo', project: 'mobile', language: 'fi', width: 390, suffix: 'fi-mobile' },
  ] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/tryon-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      const { api } = await start(page, { language });
      await openTryOn(page, language);
      if (selected.scene === 'setup-subset') {
        await expect(page.locator('#tryon-subset')).toHaveText(text('tryon.subset', language));
        await expect(page.getByText(text('tryon.notIncluded', language, { names: 'Grey coat' }), { exact: true })).toBeVisible();
      } else {
        await preparePhoto(page, language);
        await expect(page.locator('#tryon-save-photo')).toHaveText(text('tryon.savePhoto', language));
        await page.locator('#tryon-save-photo').click();
        await expect(page.getByText(text('tryon.photoSaved', language), { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.locator('.tryon-photo img')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('.tryon-photo img')).toHaveJSProperty('complete', true);
        await expect(page.locator('.tryon-photo img')).toHaveAttribute('alt', text('tryon.savedPhoto', language));
        await expect(page.locator('#tryon-remove-photo')).toHaveText(text('tryon.removePhoto', language));
        expect(api.tryonControl.photos[owners.a]).toBeDefined();
      }
      await page.evaluate(() => scrollTo(0, 0));
      await axe(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: language, width: selected.width })).toBe(true);
      if (write) {
        const png = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      }
    });
  }
});