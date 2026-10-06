import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, pluralText, type Language } from '../../src/i18n/all';
import { formatUsdCents } from '../../src/domain/admin-limits';
import { aiFixture } from './ai-photo-first-support';
import { signIn } from './mock-backend';
import { shellNav, signOutThroughMenu } from './shell-support';

type Fixture = Awaited<ReturnType<typeof aiFixture>>;
const button = (page: Page, key: keyof typeof messages, language: Language = 'en') =>
  page.getByRole('button', { name: messages[key][language], exact: true });
const cards = (page: Page) => page.locator('.bulk-card');
const cardNamed = (page: Page, name: string) => cards(page).filter({ has: page.locator('.bulk-card-title', { hasText: new RegExp(`^${name}$`) }) });
const progress = (page: Page, ready: number, total: number, language: Language = 'en') =>
  expect(page.locator('.bulk-progress')).toHaveText(messages['bulk.progress'][language].replace('{ready}', String(ready)).replace('{total}', String(total)));
const posts = (api: Fixture) => api.calls.filter(call => call.route.endsWith('/analyze-clothing'));
const saves = (api: Fixture) => api.requests.filter(call => call.path.endsWith('/reserve_analyzed_item_save'));
const editor = (page: Page) => page.locator('.bulk-editor');

async function startBatch(page: Page, api: Fixture, count: number, language: Language = 'en') {
  await button(page, 'wardrobe.add', language).first().click();
  await page.locator('#add-several').click();
  await expect(page.locator('#bulk-title')).toBeFocused();
  expect(api.items).toHaveLength(0);
  await page.locator('.bulk-pick input[type=file]').setInputFiles(Array.from({ length: count },
    (_, n) => ({ name: `synthetic-${n + 1}.jpg`, mimeType: 'image/jpeg', buffer: api.fixture })));
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
  await expect(page.locator('#bulk-title')).toBeVisible();
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
