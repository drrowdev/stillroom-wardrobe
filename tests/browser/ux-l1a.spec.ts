import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { languages, messages, type Language, type MessageKey } from '../../src/i18n';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';

type Api = Awaited<ReturnType<typeof aiFixture>>;
const text = (key: MessageKey, language: Language = 'en') => messages[key][language];
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
// App-owned copy on the add and saved-item screens must not expose AI internals or developer wording.
const banned = [/gpt-/i, /\bUSD\b/, /micro/i, /revision/i, /verified/i, /provenance/i, /Check analysis status/i,
  /Request a new analysis/i, /\bClear /, /\bReset /];
const surfaceKeys = (Object.keys(messages) as MessageKey[]).filter((key) => /^(item|detail|capture|warmth|occasion|availability|lifecycle)\./.test(key)
  || ['aiC.filling', 'aiC.stillWorking', 'aiC.fillFailed', 'aiC.limit', 'aiC.needsCheck', 'aiC.keep', 'aiC.off', 'aiC.turnOn',
    'aiC.markSuggested', 'aiC.markEstimated'].includes(key));

async function auditCopy(page: Page) {
  const copy = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const element of document.querySelectorAll('[aria-label],[title],img[alt]')) {
      parts.push(element.getAttribute('aria-label') ?? '', element.getAttribute('title') ?? '');
    }
    const badge = [...document.querySelectorAll('body *')].some((element) => element.children.length === 0 && element.textContent?.trim() === '01');
    return { text: parts.join('\n'), badge };
  });
  for (const pattern of banned) expect(copy.text, `no ${pattern.source}`).not.toMatch(pattern);
  expect(copy.badge).toBe(false);
}
async function openSaved(page: Page, api: Api, warmth?: number) {
  const saved = api.seedSavedItem();
  if (warmth !== undefined) (saved.item as Record<string, unknown>).warmth = warmth;
  await page.reload();
  await expect(page.locator('.item-card')).toHaveCount(1);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  return saved;
}
function recordPatches(page: Page) {
  const patches: Array<{ url: URL; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/rest/v1/items') {
      patches.push({ url: new URL(request.url()), body: request.postDataJSON() as Record<string, unknown> });
    }
  });
  return patches;
}
async function leaveAdd(page: Page, language: Language = 'en') {
  await button(page, 'common.cancel', language).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.or(page.locator('#wardrobe-title'))).toBeVisible();
  if (await dialog.count()) await dialog.getByRole('button', { name: text('common.discard', language), exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
}
const sent = (body: Record<string, unknown>) => Object.keys(body).filter((key) => key !== 'field_provenance').sort();

test('L1a catalog copy for the add and saved-item screens is plain in every language', () => {
  for (const key of surfaceKeys) for (const language of languages) {
    for (const pattern of banned) expect(messages[key][language], `${key} ${language}`).not.toMatch(pattern);
  }
});

test('L1a add form shows only the essential fields; More details starts collapsed; audit ready, failed and off', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await expect(page.locator('#analysis-status')).toHaveCount(0);
  const details = page.locator('details.optional-details');
  await expect(details).toHaveCount(1);
  expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  expect(await page.locator('.garment-field').evaluateAll((fields) => fields
    .filter((field) => !field.closest('details') && field.getClientRects().length > 0)
    .map((field) => field.id || field.querySelector('[id]')?.id.replace(/-label$/, '')))).toEqual(['item-title', 'item-category', 'item-colours', 'item-seasons']);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  for (const id of ['#item-subcategory', '#item-pattern', '#item-brand', '#item-warmth', '#item-purchase_price', '#item-notes', '#item-tags-new']) {
    await expect(page.locator(id)).toBeHidden();
  }
  await auditCopy(page);
  await page.locator('details.optional-details > summary').click();
  await expect(page.locator('#item-warmth')).toBeVisible();
  await expect(page.locator('#item-pattern option[value=""]')).toHaveText(text('item.notSet'));
  await expect(page.locator('#item-alt')).toBeVisible();
  await auditCopy(page);
  api.mode('failed');
  await leaveAdd(page);
  await addAiPhoto(page, api);
  await expect(page.locator('#analysis-status')).toContainText(text('aiC.fillFailed'));
  await auditCopy(page);
  expect(api.items).toHaveLength(0);
});

test('L1a AI off shows one short line and no internals', async ({ page }) => {
  const api = await aiFixture(page, 'en', false);
  await addAiPhoto(page, api);
  await expect(page.locator('#analysis-status')).toContainText(text('aiC.off'));
  await auditCopy(page);
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(0);
});

test('L1a warmth keeps a stored 4, sends no warmth key when untouched and 2 for Medium', async ({ page }) => {
  const api = await aiFixture(page);
  const patches = recordPatches(page);
  const { item } = await openSaved(page, api, 4);
  await page.locator('details.optional-details > summary').click();
  await expect(page.locator('#detail-warmth')).toHaveValue('4');
  await expect(page.locator('#detail-warmth option:checked')).toHaveText(text('warmth.warm'));
  await page.locator('#detail-title').fill('Warm overshirt');
  await button(page, 'detail.saveChanges').click();
  await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(sent(patches[0]!.body)).toEqual(['title']);
  expect(patches[0]!.url.searchParams.get('version')).toBe('eq.1');
  expect(item.warmth).toBe(4);
  await page.locator('#detail-warmth').selectOption({ label: text('warmth.medium') });
  await button(page, 'detail.saveChanges').click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]!.body).toMatchObject({ warmth: 2 });
  expect(sent(patches[1]!.body)).toEqual(['warmth']);
  expect(item.warmth).toBe(2);
  await auditCopy(page);
});

test('L1a availability and Archive are quick, sparse, version-checked saves disabled while editing', async ({ page }) => {
  const api = await aiFixture(page);
  const patches = recordPatches(page);
  const { item } = await openSaved(page, api);
  await auditCopy(page);
  const radios = page.locator('.detail-availability input');
  await expect(radios).toHaveCount(4);
  await page.locator('#detail-title').fill('Edited title');
  for (const radio of await radios.all()) await expect(radio).toBeDisabled();
  await expect(button(page, 'detail.archive')).toBeDisabled();
  await button(page, 'detail.saveChanges').click();
  await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
  await expect(radios.first()).toBeEnabled();
  expect(patches).toHaveLength(1);
  await page.locator('.detail-availability input[value="laundry"]').check();
  await expect.poll(() => patches.length).toBe(2);
  const availability = () => patches[1]!, archive = () => patches[2]!, unarchive = () => patches[3]!;
  expect(sent(availability().body)).toEqual(['availability']);
  expect(availability().body.availability).toBe('laundry');
  expect(availability().url.searchParams.get('version')).toBe('eq.2');
  await expect.poll(() => item.availability).toBe('laundry');
  await expect(button(page, 'detail.archive')).toBeEnabled();
  await button(page, 'detail.archive').click();
  await expect(button(page, 'detail.unarchive')).toBeVisible();
  expect(sent(archive().body)).toEqual(['lifecycle']);
  expect(archive().body.lifecycle).toBe('archived');
  expect(archive().url.searchParams.get('version')).toBe('eq.3');
  await button(page, 'detail.unarchive').click();
  await expect(button(page, 'detail.archive')).toBeVisible();
  expect(patches).toHaveLength(4);
  expect(sent(unarchive().body)).toEqual(['lifecycle']);
  expect(unarchive().body.lifecycle).toBe('active');
  expect(unarchive().url.searchParams.get('version')).toBe('eq.4');
  expect(item.lifecycle).toBe('active');
  await expect(button(page, 'item.trash')).toBeEnabled();
  expect(api.requests.some((call) => call.method === 'DELETE')).toBe(false);
});

test('L1a accessibility: add and saved item at 1280, 320 and 200% text; keyboard More details and invalid focus', async ({ page }) => {
  test.slow();
  const api = await aiFixture(page);
  const axe = async () => {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  await addAiPhoto(page, api);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await axe();
  await page.locator('details.optional-details > summary').focus();
  await page.keyboard.press('Enter');
  expect(await page.locator('details.optional-details').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await axe();
  await leaveAdd(page);
  const patches = recordPatches(page);
  await openSaved(page, api);
  await axe();
  await page.locator('#detail-title').fill('');
  await button(page, 'detail.saveChanges').click();
  await expect(page.locator('#detail-title')).toBeFocused();
  expect(patches).toHaveLength(0);
});

test.describe('bounded L1a visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`add, More details, failed and saved item ${selected.suffix} retain functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language, api = await aiFixture(page, language);
      const write = testInfo.project.name === selected.project;
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/ux-l1a-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async (name: 'add-ready' | 'add-failed' | 'more-details' | 'saved-item') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        if (!write) return;
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await addAiPhoto(page, api, language);
      await expect(page.locator('#item-category')).not.toHaveValue('');
      await expect(page.locator('#analysis-status')).toHaveCount(0);
      await capture('add-ready');
      await page.locator('details.optional-details > summary').click();
      await expect(page.locator('#item-warmth')).toBeVisible();
      await capture('more-details');
      await leaveAdd(page, language);
      api.mode('failed');
      await addAiPhoto(page, api, language);
      await expect(page.locator('#analysis-status')).toContainText(text('aiC.fillFailed', language));
      await capture('add-failed');
      await leaveAdd(page, language);
      expect(api.items).toHaveLength(0);
      await openSaved(page, api);
      await capture('saved-item');
    });
  }
});
