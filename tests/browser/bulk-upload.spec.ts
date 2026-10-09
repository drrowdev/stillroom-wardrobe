import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, pluralText, type Language } from '../../src/i18n/all';
import { formatUsdCents } from '../../src/domain/admin-limits';
import { aiFixture } from './ai-photo-first-support';
import { enhanced, held, redraw, removals, start, syntheticPhoto } from './enhancement-support';
import { enhanceServerNow, owners, signIn } from './mock-backend';
import { shellNav, signOutThroughMenu } from './shell-support';

type Fixture = Awaited<ReturnType<typeof aiFixture>>;
const button = (page: Page, key: keyof typeof messages, language: Language = 'en') =>
  page.getByRole('button', { name: messages[key][language], exact: true });
const cards = (page: Page) => page.locator('.bulk-card');
const cardNamed = (page: Page, name: string) => cards(page).filter({ has: page.locator('.bulk-card-title', { hasText: new RegExp(`^${name}$`) }) });
const progress = (page: Page, ready: number, total: number, language: Language = 'en', timeout?: number) =>
  expect(page.locator('.bulk-progress')).toHaveText(messages['bulk.progress'][language].replace('{ready}', String(ready)).replace('{total}', String(total)), { timeout });
const posts = (api: Fixture) => api.calls.filter(call => call.route.endsWith('/analyze-clothing'));
const saves = (api: Fixture) => api.requests.filter(call => call.path.endsWith('/reserve_analyzed_item_save'));
const editor = (page: Page) => page.locator('.bulk-editor');

const sent = (api: Fixture) => api.enhanceControl.requests;
const engineOnly = () => test.skip(test.info().project.name === 'mobile', 'Behaviour is covered by the chromium and webkit-photo projects.');

// `png`: synthetic photos that the stand-in clean-up accepts; `armed` runs just before the files are picked.
async function startBatch(page: Page, api: Fixture, count: number, language: Language = 'en', options: { png?: Buffer; armed?: () => void } = {}) {
  await button(page, 'wardrobe.add', language).first().click();
  await page.locator('#add-several').click();
  await expect(page.locator('#bulk-title')).toBeFocused();
  expect(api.items).toHaveLength(0);
  options.armed?.();
  await page.locator('.bulk-pick input[type=file]').setInputFiles(Array.from({ length: count }, (_, n) => options.png
    ? { name: `synthetic-${n + 1}.png`, mimeType: 'image/png', buffer: options.png }
    : { name: `synthetic-${n + 1}.jpg`, mimeType: 'image/jpeg', buffer: api.fixture }));
}
// Holds status checks until released, after letting `skip` through: with one photo, 1 is the batch estimate, 2 also passes
// the analysis's own check and holds the transport's inner check right before the POST.
async function holdPreflight(page: Page, skip = 1) {
  let armed = false, seen = 0, held = 0;
  const waiting: Array<() => void> = [];
  await page.route('**/rest/v1/rpc/ai_status', async (route) => {
    if (!armed || route.request().method() === 'OPTIONS' || seen++ < skip) { await route.fallback(); return; }
    held += 1;
    await new Promise<void>((resolve) => waiting.push(resolve));
    await route.fallback().catch(() => undefined);
  });
  return { arm: () => { armed = true; }, held: () => held, release: () => { armed = false; for (const go of waiting.splice(0)) go(); } };
}
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: value ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
// The draft stays usable by hand: name it, pick a category and save it from its editor.
async function saveByHand(page: Page, index: number, title: string) {
  await page.locator('.bulk-card-open').nth(index).click();
  await page.locator('#item-title').fill(title);
  if (await page.locator('#item-category').inputValue() === '') await page.locator('#item-category').selectOption('top');
  await editor(page).getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#bulk-title')).toBeVisible({ timeout: 30_000 });
}
// While held, every status check answers "still working", so analyses stay in progress until released.
async function holdStatus(page: Page) {
  let held = true;
  await page.route('**/rest/v1/rpc/ai_analysis_status', async (route) => {
    if (!held || route.request().method() === 'OPTIONS') { await route.fallback(); return; }
    await route.fulfill({ json: { code: 'OK', status: 'dispatched', result: null, accounting: { basis: 'held', amountMicro: '1034', currency: 'USD' } } })
      .catch(() => undefined);
  });
  return () => { held = false; };
}

test.beforeEach(({ page }, info) => { void page; expect(info.retry, 'New bulk-upload flakiness blocks acceptance').toBe(0); });

async function captureActionsGeometry(page: Page, language: Language) {
  const panel = page.locator('.photo-panel');
  const several = button(page, 'bulk.entry', language);
  const cancel = panel.getByRole('button', { name: messages['common.cancel'][language], exact: true });
  await expect(several).toBeVisible();
  await expect(cancel).toBeVisible();
  const boxes = await several.or(cancel).evaluateAll(controls => controls.map(control => {
    const box = control.getBoundingClientRect(), parent = control.closest('.photo-panel')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(control);
    const text = [...range.getClientRects()].filter(rect => rect.width > 0);
    return { top: box.top, bottom: box.bottom, width: box.width, height: box.height,
      centered: Math.abs(box.left + box.width / 2 - parent.left - parent.width / 2),
      contained: text.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1
        && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
      wraps: getComputedStyle(control).whiteSpace === 'normal' };
  }));
  expect(boxes).toHaveLength(2);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.centered).toBeLessThanOrEqual(1);
    expect(box.contained).toBe(true);
    expect(box.wraps).toBe(true);
  }
  expect(boxes[1]!.top - boxes[0]!.bottom).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const language of ['en', 'fi', 'sv'] as const) {
  for (const width of [320, 1280]) {
    test(`CAPTURE1 geometry and entry actions ${language} ${width}`, async ({ page }) => {
      const api = await aiFixture(page, language);
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      await button(page, 'wardrobe.add', language).first().click();
      await captureActionsGeometry(page, language);
      const choices = page.locator('.photo-actions');
      await expect(choices.getByRole('button', { name: messages['capture.library'][language], exact: true })).toBeVisible();
      const camera = choices.getByRole('button', { name: messages['capture.camera'][language], exact: true });
      await expect(camera).toBeVisible();
      await expect(page.locator('#photo-menu')).toHaveCount(0);
      await camera.focus();
      await page.keyboard.press('Tab');
      await expect(button(page, 'bulk.entry', language)).toBeFocused();
      await page.keyboard.press('Tab');
      const cancel = page.locator('.photo-panel').getByRole('button', { name: messages['common.cancel'][language], exact: true });
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      await expect(page.locator('#bulk-title')).toBeFocused();
      await page.locator('.bulk-page .back-button').click();
      await expect(page.locator('#capture-title')).toBeVisible();
      await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 1rem; }' });
      await captureActionsGeometry(page, language);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.locator('.photo-panel input[type=file][capture]').setInputFiles({
        name: 'synthetic-invalid.jpg', mimeType: 'image/jpeg', buffer: api.fixture.subarray(0, -2),
      });
      const error = page.locator('.photo-panel [role=alert]');
      await expect(error).toBeVisible();
      await captureActionsGeometry(page, language);
      const severalBox = (await button(page, 'bulk.entry', language).boundingBox())!;
      const errorBox = (await error.boundingBox())!;
      const cancelBox = (await cancel.boundingBox())!;
      expect(errorBox.y).toBeGreaterThanOrEqual(severalBox.y + severalBox.height);
      expect(cancelBox.y).toBeGreaterThanOrEqual(errorBox.y + errorBox.height);
      await cancel.click();
      await expect(page.locator('#wardrobe-title')).toBeVisible();
      expect(posts(api)).toHaveLength(0);
      expect(saves(api)).toHaveLength(0);
      expect(api.items).toHaveLength(0);
      expect(api.images).toHaveLength(0);
    });

    test(`CAPTURE1 visual evidence ${language} ${width}`, async ({ page }, info) => {
      const project = width === 320 ? 'mobile' : 'chromium';
      test.skip(info.project.name !== project, 'Only the six approved Chromium captures are written.');
      const api = await aiFixture(page, language);
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      await button(page, 'wardrobe.add', language).first().click();
      await captureActionsGeometry(page, language);
      expect(posts(api)).toHaveLength(0);
      expect(api.items).toHaveLength(0);
      expect(api.images).toHaveLength(0);
      await page.locator('.photo-panel').getByRole('button', { name: messages['common.cancel'][language], exact: true }).scrollIntoViewIfNeeded();
      await expect(page.locator('.photo-actions')).toBeInViewport({ ratio: 1 });
      await expect(button(page, 'bulk.entry', language)).toBeInViewport({ ratio: 1 });
      const directory = path.resolve('test-results/capture1-visual');
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `empty-${language}-${width === 320 ? 'mobile' : 'desktop'}.png`);
      await page.screenshot({ path: file, fullPage: false, animations: 'disabled', scale: 'css' });
      const stat = await lstat(file);
      expect(stat.isFile() && stat.size > 24 && stat.size <= 1024 * 1024).toBe(true);
    });
  }
}

test('three photos: one analysis each on its final photo, nothing saved until Save all, then all three saved', async ({ page }) => {
  const api = await aiFixture(page);
  await startBatch(page, api, 3);
  await expect(cards(page)).toHaveCount(3);
  await progress(page, 3, 3);
  await expect(page.locator('.bulk-status-ready')).toHaveCount(3);
  expect(api.items).toHaveLength(0);
  expect(api.images).toHaveLength(0);
  expect(posts(api)).toHaveLength(3);

  // Keyboard: a card opens its editor, and Back returns focus to that card.
  const first = page.locator('.bulk-card-open').first();
  await first.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#bulk-edit-title')).toBeFocused();
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await button(page, 'bulk.backToList').focus(); await page.keyboard.press('Enter');
  await expect(first).toBeFocused();

  await button(page, 'bulk.saveAll').click();
  await expect(page.locator('.bulk-lines')).toHaveText(pluralText('en', 'bulk.saved', 3));
  await expect(cards(page)).toHaveCount(0);
  expect(api.items).toHaveLength(3);
  expect(api.images.every(image => image.state === 'ready')).toBe(true);
  // The checked save binds the analysed photo: each saved photo is exactly the one its single analysis read.
  expect(api.inputs.map(input => input.sha256).sort()).toEqual(api.images.map(image => String(image.main_sha256)).sort());
  expect(posts(api)).toHaveLength(3);
  expect(saves(api)).toHaveLength(3);
});

test('review while the rest process: an edit survives the late fill, one item saves alone, and leaving asks first', async ({ page }) => {
  const api = await aiFixture(page);
  api.mode('pending');
  const release = await holdStatus(page);
  await startBatch(page, api, 2);
  await expect(page.locator('.bulk-status-filling')).toHaveCount(2);
  await page.locator('.bulk-card-open').first().click();
  await expect(editor(page).locator('#item-title')).toBeVisible();
  await page.locator('#item-title').fill('Linen shirt');
  await button(page, 'bulk.backToList').click();
  await expect(cardNamed(page, 'Linen shirt')).toHaveCount(1);
  await expect(cardNamed(page, 'Linen shirt').locator('.bulk-status')).toHaveText(messages['bulk.filling'].en);
  expect(api.items).toHaveLength(0);

  release();
  await progress(page, 2, 2);
  await expect(cardNamed(page, 'Linen shirt')).toHaveCount(1);
  await cardNamed(page, 'Linen shirt').getByRole('button', { name: messages['common.save'].en, exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  expect(api.items.map(item => item.title)).toEqual(['Linen shirt']);
  expect(posts(api)).toHaveLength(2);

  await shellNav(page).getByRole('link', { name: messages['nav.wardrobe'].en, exact: true }).click();
  await expect(page.getByRole('dialog', { name: messages['bulk.discard'].en })).toBeVisible();
  await button(page, 'common.continueEditing').click();
  await expect(cards(page)).toHaveCount(1);
  await shellNav(page).getByRole('link', { name: messages['nav.wardrobe'].en, exact: true }).click();
  await button(page, 'common.discard').click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items).toHaveLength(1);
});

test('Save all with a lost reservation reply: the rest save, and Retry keeps the same attempt', async ({ page }) => {
  const api = await aiFixture(page, 'en', true, 'reservation');
  const reserved: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/rest/v1/rpc/reserve_analyzed_item_save') && request.method() === 'POST') {
      reserved.push(String((request.postDataJSON() as { p_item: { id: string } }).p_item.id));
    }
  });
  await startBatch(page, api, 2);
  await progress(page, 2, 2);
  await button(page, 'bulk.saveAll').click();
  await expect(page.locator('.bulk-lines')).toHaveText(`${pluralText('en', 'bulk.saved', 1)} ${pluralText('en', 'bulk.needsAttention', 1)}`);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('.bulk-card-meta').last()).toHaveText(messages['bulk.saveFailed'].en);
  await cards(page).getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(new Set(api.items.map(item => item.id)).size).toBe(2);
  expect(api.images.every(image => image.state === 'ready')).toBe(true);
  expect(reserved).toHaveLength(3);
  expect(new Set(reserved).size).toBe(2);
  expect(posts(api)).toHaveLength(2);
});

test('SAVE1 one photo whose analysis fails does not pause the batch: the other photos are still analysed', async ({ page }) => {
  const api = await aiFixture(page);
  api.failNext(1);
  await startBatch(page, api, 3);
  await expect(page.locator('.bulk-status-ready')).toHaveCount(3);
  await expect(page.locator('.bulk-lines').getByText(messages['bulk.paused'].en, { exact: true })).toHaveCount(0);
  expect(posts(api)).toHaveLength(3);
  expect(api.results.size).toBe(2);
  expect(api.items).toHaveLength(0);
  expect(api.consent.get(owners.a)).toBe(true);
});

test('two unsettled analyses pause the rest: no third request, Retry is off, and the photo can still be saved by hand', async ({ page }) => {
  const api = await aiFixture(page);
  api.mode('failed');
  await startBatch(page, api, 3);
  await expect(page.locator('.bulk-lines').getByText(messages['bulk.paused'].en, { exact: true })).toBeVisible();
  await expect(page.locator('.bulk-status-preparing, .bulk-status-filling, .bulk-status-removing, .bulk-status-cleaning')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(posts(api)).toHaveLength(2);

  await page.locator('.bulk-card-open').nth(2).click();
  await expect(editor(page).getByText(messages['bulk.paused'].en, { exact: true })).toBeVisible();
  await expect(editor(page).locator('#analysis-status').getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeDisabled();
  await page.locator('#item-title').fill('Hand-filled top');
  await page.locator('#item-category').selectOption('top');
  await editor(page).getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#bulk-title')).toBeVisible({ timeout: 30_000 });
  await expect(cards(page)).toHaveCount(2);
  expect(api.items.map(item => item.title)).toEqual(['Hand-filled top']);
  expect(posts(api)).toHaveLength(2);
});

test('more than 50 photos keeps the first 50, and a batch larger than the allowance left shows an estimate first', async ({ page }) => {
  const api = await aiFixture(page);
  api.policy({ monthlyAllowanceMicro: '50000' });
  await startBatch(page, api, 51);
  await expect(page.getByText(messages['bulk.limit'].en, { exact: true })).toBeVisible();
  await expect(page.locator('.bulk-estimate p')).toHaveText(messages['bulk.estimate'].en.replace('{amount}', formatUsdCents('2000000', 'en')));
  await button(page, 'common.cancel').click();
  await expect(page.locator('#bulk-pick')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  expect(posts(api)).toHaveLength(0);

  await page.locator('.bulk-pick input[type=file]').setInputFiles(Array.from({ length: 2 },
    (_, n) => ({ name: `synthetic-${n + 1}.jpg`, mimeType: 'image/jpeg', buffer: api.fixture })));
  await expect(page.locator('.bulk-estimate p')).toHaveText(messages['bulk.estimate'].en.replace('{amount}', formatUsdCents('80000', 'en')));
  await expect(page.getByText(messages['bulk.limit'].en, { exact: true })).toHaveCount(0);
  await button(page, 'bulk.start').click();
  await expect(cards(page)).toHaveCount(2);
  await progress(page, 2, 2);
});

test('signing out mid-batch drops every draft and sends nothing more', async ({ page }) => {
  const api = await aiFixture(page);
  api.mode('pending');
  await holdStatus(page);
  await startBatch(page, api, 3);
  await expect.poll(() => posts(api).length).toBe(2);
  await signOutThroughMenu(page);
  await expect(page.locator('#email')).toBeVisible();
  const sent = posts(api).length;
  await page.waitForTimeout(500);
  expect(posts(api)).toHaveLength(sent);
  await signIn(page);
  // The new session opens the same address with an empty batch.
  await expect(page.locator('#bulk-pick')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  expect(api.items).toHaveLength(0);
  expect(posts(api)).toHaveLength(sent);
});

const preflights = [{ name: 'the status check', skip: 1 }, { name: 'the inner check before the POST', skip: 2 }] as const;
for (const hold of preflights) {
test(`${hold.name} held across Stop sends no analysis, and the photo can still be saved`, async ({ page }) => {
  const api = await aiFixture(page);
  const preflight = await holdPreflight(page, hold.skip);
  await startBatch(page, api, 1, 'en', { armed: preflight.arm });
  await expect.poll(preflight.held).toBe(1);
  await button(page, 'bulk.stop').click();
  preflight.release();
  await expect(page.locator('.bulk-status-filling')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(posts(api)).toHaveLength(0);
  await saveByHand(page, 0, 'Stopped top');
  expect(api.items.map(item => item.title)).toEqual(['Stopped top']);
  expect(posts(api)).toHaveLength(0);
});

test(`${hold.name} held while the page is hidden sends nothing until it is visible, then exactly one analysis`, async ({ page }) => {
  const api = await aiFixture(page);
  const preflight = await holdPreflight(page, hold.skip);
  await startBatch(page, api, 1, 'en', { armed: preflight.arm });
  await expect.poll(preflight.held).toBe(1);
  await setHidden(page, true);
  preflight.release();
  await page.waitForTimeout(800);
  expect(posts(api)).toHaveLength(0);
  await setHidden(page, false);
  await progress(page, 1, 1, 'en', 30_000);
  expect(posts(api)).toHaveLength(1);
});
}

test('with clean-up on: the original file is dropped before clean-up, and the one analysis reads the final photo', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  const gate = held(enhanced(page));
  api.enhanceControl.replies.push(gate.reply);
  await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
  await expect.poll(() => sent(api).length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.bulk-status-cleaning')).toHaveCount(1);
  expect(await removals(page)).toBeGreaterThan(0);
  // Clean-up is deliberately held: only the bounded prepared photo is kept, not the picked file.
  await expect(cards(page)).toHaveAttribute('data-source', 'photo');
  expect(posts(api)).toHaveLength(0);
  gate.release();
  await progress(page, 1, 1, 'en', 30_000);
  expect(posts(api)).toHaveLength(1);
  expect(api.inputs[0]!.sha256).not.toBe(sent(api)[0]!.sha256);
  await cards(page).getByRole('button', { name: messages['common.save'].en, exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(api.images.map(image => String(image.main_sha256))).toEqual([api.inputs[0]!.sha256]);
  expect(posts(api)).toHaveLength(1);
});

for (const expiry of ['local', 'server'] as const) {
  test(`${expiry} clean-up expiry with AI unavailable: Fill in again keeps the reviewed details, and Keep saves`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    // Local: 64 s of evidence less the 60 s margin lapses on the device in about 4 s. Server: Save finds it gone.
    api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes),
      usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + (expiry === 'local' ? 64_000 : 86_400_000) }));
    await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
    if (expiry === 'local') await expect(page.locator('.bulk-status-attention')).toHaveCount(1, { timeout: 30_000 });
    else {
      await progress(page, 1, 1, 'en', 30_000);
      for (const output of api.enhanceControl.outputs) output.usableUntilMs = 0;
      await cards(page).getByRole('button', { name: messages['common.save'].en, exact: true }).click();
      await expect(page.locator('.bulk-status-attention')).toHaveCount(1);
    }
    expect(api.items).toHaveLength(0);
    expect(posts(api)).toHaveLength(1);
    await page.locator('.bulk-card-open').first().click();
    await expect(page.locator('#cleanup-expired')).toBeVisible();
    await page.locator('#item-title').fill('Reviewed shirt');
    await expect(page.locator('#item-category')).toHaveValue('top');
    await expect(page.locator('#item-material')).toHaveValue('Cotton');

    api.policy({ activated: false });
    await page.locator('#cleanup-expired').getByRole('button', { name: messages['bulk.fillAgain'].en, exact: true }).click();
    await expect(page.locator('#cleanup-expired').getByText(messages['aiC.off'].en, { exact: true })).toBeVisible();
    await expect(page.locator('#item-title')).toHaveValue('Reviewed shirt');
    await expect(page.locator('#item-category')).toHaveValue('top');
    await expect(page.locator('#item-material')).toHaveValue('Cotton');
    expect(posts(api)).toHaveLength(1);

    await page.locator('#cleanup-expired').getByRole('button', { name: messages['aiC.keep'].en, exact: true }).click();
    await expect(page.locator('#cleanup-expired')).toHaveCount(0);
    await editor(page).getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(page.locator('#bulk-title')).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    expect(api.items.map(item => [item.title, item.category])).toEqual([['Reviewed shirt', 'top']]);
    expect(posts(api)).toHaveLength(1);
    expect(sent(api)).toHaveLength(1);
  });
}

test('Fill in again after expiry locks editing until the attempt settles, so an edit is neither overwritten nor dropped', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes),
    usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + 64_000 }));
  await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
  await expect(page.locator('.bulk-status-attention')).toHaveCount(1, { timeout: 30_000 });
  await page.locator('.bulk-card-open').first().click();
  await expect(page.locator('#cleanup-expired')).toBeVisible();
  await page.locator('#item-title').fill('Reviewed shirt');
  const preflight = await holdPreflight(page, 0);
  preflight.arm();
  await page.locator('#cleanup-expired').getByRole('button', { name: messages['bulk.fillAgain'].en, exact: true }).click();
  await expect.poll(preflight.held).toBe(1);
  // While the availability check is held the form is read-only: typing changes nothing.
  await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
  await expect(page.locator('#item-category')).toBeDisabled();
  await page.locator('#item-title').press('End');
  await page.keyboard.type(' changed');
  await expect(page.locator('#item-title')).toHaveValue('Reviewed shirt');
  preflight.release();
  await expect(page.locator('#cleanup-expired')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => posts(api).length, { timeout: 30_000 }).toBe(2);
  await expect(page.locator('#item-title')).not.toHaveAttribute('readonly', '', { timeout: 30_000 });
  await expect(page.locator('#item-title')).toHaveValue('Reviewed shirt');
  await page.locator('#item-title').fill('Reviewed shirt, edited');
  await expect(page.locator('#item-title')).toHaveValue('Reviewed shirt, edited');
});

test('a busy clean-up waiting to retry is cancelled by Stop: nothing more is sent, and the photo saves by hand', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push({ status: 503, body: { code: 'BUSY' } });
  await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
  await expect.poll(() => sent(api).length, { timeout: 30_000 }).toBe(1);
  await button(page, 'bulk.stop').click();
  await expect(page.locator('.bulk-status-cleaning, .bulk-status-filling')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent(api)).toHaveLength(1);
  expect(posts(api)).toHaveLength(0);
  await saveByHand(page, 0, 'Busy top');
  expect(api.items.map(item => item.title)).toEqual(['Busy top']);
  expect(sent(api)).toHaveLength(1);
});

test('hiding the page cancels a busy clean-up backoff; once visible one fresh request is sent, not after the wait', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push({ status: 503, body: { code: 'BUSY' } }, enhanced(page));
  await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
  await expect.poll(() => sent(api).length, { timeout: 30_000 }).toBe(1);
  await setHidden(page, true);
  await page.waitForTimeout(500);
  expect(sent(api)).toHaveLength(1);
  await setHidden(page, false);
  // The 20 s backoff is gone: the fresh request goes out promptly.
  await expect.poll(() => sent(api).length, { timeout: 8_000 }).toBe(2);
  await progress(page, 1, 1);
  expect(posts(api)).toHaveLength(1);
  expect(api.inputs[0]!.sha256).not.toBe(sent(api)[1]!.sha256);
});

for (const code of ['RATE_LIMIT', 'ALLOWANCE'] as const) {
  test(`clean-up ${code} mid-batch stops further clean-ups; every photo is still filled in and saves`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page), { status: 429, body: { code } });
    await startBatch(page, api, 3, 'en', { png: await syntheticPhoto(page) });
    await progress(page, 3, 3, 'en', 45_000);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(2);
    expect(posts(api)).toHaveLength(3);
    await page.locator('.bulk-card-open').first().click();
    await expect(page.locator('#item-category')).toHaveValue('top');
    await button(page, 'bulk.backToList').click();
    await button(page, 'bulk.saveAll').click();
    await expect(cards(page)).toHaveCount(0);
    expect(api.items).toHaveLength(3);
    expect(sent(api)).toHaveLength(2);
  });
}

test('a refused clean-up keeps the cut-out with the usual note, analyses it once and saves', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push({ status: 422, body: { code: 'FILTERED' } });
  await startBatch(page, api, 1, 'en', { png: await syntheticPhoto(page) });
  await progress(page, 1, 1, 'en', 30_000);
  expect(sent(api)).toHaveLength(1);
  expect(posts(api)).toHaveLength(1);
  expect(api.inputs[0]!.sha256).not.toBe(sent(api)[0]!.sha256);
  await page.locator('.bulk-card-open').first().click();
  await expect(editor(page).getByText(messages['enhance.fallback'].en, { exact: true }).first()).toBeVisible();
  await editor(page).getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(api.images.map(image => String(image.main_sha256))).toEqual([api.inputs[0]!.sha256]);
});

const scenes = [
  { file: 'list-en-mobile', language: 'en', width: 0, zoom: false, project: 'mobile' },
  { file: 'list-fi-mobile', language: 'fi', width: 0, zoom: false, project: 'mobile' },
  { file: 'list-sv-320-200', language: 'sv', width: 320, zoom: true, project: 'mobile' },
  { file: 'list-en-desktop', language: 'en', width: 0, zoom: false, project: 'chromium' },
] as const;
for (const scene of scenes) {
  test(`review list layout and accessibility: ${scene.file}`, async ({ page }, info) => {
    const api = await aiFixture(page, scene.language);
    if (scene.width) await page.setViewportSize({ width: scene.width, height: 900 });
    await startBatch(page, api, 3, scene.language);
    await progress(page, 3, 3, scene.language);
    if (scene.zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 1rem; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const small = await page.locator('.bulk-page button:visible').evaluateAll(controls =>
      controls.filter(control => { const box = control.getBoundingClientRect(); return box.height < 44 || box.width < 44; }).length);
    expect(small).toBe(0);
    // New labels wrap only between words.
    const split = await page.locator('.bulk-header, .bulk-card-actions, .bulk-status').evaluateAll(nodes => nodes.flatMap(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), broken: string[] = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        for (const word of (text.textContent ?? '').matchAll(/\S+/g)) {
          const range = document.createRange(); range.setStart(text, word.index); range.setEnd(text, word.index + word[0].length);
          if (new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1) broken.push(word[0]);
        }
      }
      return broken;
    }));
    expect(split).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect.poll(() => page.locator('.bulk-thumb img').evaluateAll(images =>
      images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
    if (info.project.name === scene.project) {
      const directory = path.resolve('test-results/bulk2-visual');
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${scene.file}.png`);
      await page.screenshot({ path: file, fullPage: false, scale: 'css' });
      const stat = await lstat(file);
      expect(stat.isFile() && stat.size > 24 && stat.size <= 1024 * 1024).toBe(true);
    }
  });
}
