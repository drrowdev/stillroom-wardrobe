import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';
import { signIn } from './mock-backend';

for (const language of ['en', 'fi', 'sv'] as const) {
  test(`photo-first ${language}: one call, editable facts, unknown local text and explicit trusted Save`, async ({ page }) => {
    const api = await aiFixture(page, language);
    await addAiPhoto(page, api, language);
    await expect(page.getByText(messages['aiC.ready'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#item-title')).not.toHaveValue('');
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    await page.locator('#item-title').fill('My corrected title');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('');
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.items).toHaveLength(1);
    expect(api.items[0]!.field_provenance).toMatchObject({
      title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
      formality: { kind: 'ai_estimated', revision: 1 }, tags: { kind: 'unknown', revision: 1 },
    });
    expect(api.images[0]!.alt_text).toBe('');
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(1);
    expect(api.requests.some((call) => /reserve_item_save|commit_image|finalize_item_save/.test(call.path))).toBe(false);
  });
}
test('language change never regenerates draft title, description, tags or analysis', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  await page.locator('details.optional-details summary').click();
  const title = await page.locator('#item-title').inputValue(), description = await page.locator('#item-alt').inputValue();
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#item-title')).toHaveValue(title);
  await expect(page.locator('#item-alt')).toHaveValue(description);
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
});
for (const mode of ['pending', 'timeout'] as const) {
  test(`${mode}: explicit same-request status resolution without another POST`, async ({ page }) => {
    const api = await aiFixture(page); api.mode(mode);
    await addAiPhoto(page, api);
    await expect(page.getByText(messages[mode === 'pending' ? 'aiC.pending' : 'aiC.uncertain'].en, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: messages['capture.save'].en, exact: true })).toBeDisabled();
    await page.locator('#item-title').fill('Retain my pending edit');
    await page.getByRole('button', { name: messages['aiC.checkStatus'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
    await expect(page.locator('#item-title')).toHaveValue('Retain my pending edit');
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    expect(api.items).toHaveLength(0);
  });
}
for (const action of ['new-analysis', 'manual'] as const) {
  test(`closed failed analysis: first explicit ${action} succeeds without a false cancellation warning`, async ({ page }) => {
    const api = await aiFixture(page); api.mode('failed');
    await addAiPhoto(page, api);
    await expect(page.getByText(messages['aiC.unavailable'].en, { exact: true })).toBeVisible();
    const first = api.calls.filter((call) => call.route.endsWith('/analyze-clothing'));
    expect(first).toHaveLength(1);
    expect(api.results.size).toBe(0);
    await page.locator('#item-title').fill('My retained manual title');
    if (action === 'new-analysis') {
      api.mode('ready');
      await page.getByRole('button', { name: messages['aiC.newAnalysis'].en, exact: true }).click();
      await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
      const posts = api.calls.filter((call) => call.route.endsWith('/analyze-clothing'));
      expect(posts).toHaveLength(2);
      expect(posts[1]!.body).not.toEqual(posts[0]!.body);
      expect(api.results.size).toBe(1);
      expect([...api.results.values()][0]!.generation).toBe(2);
    } else {
      const checked = page.waitForResponse((response) => response.url().endsWith('/ai_analysis_status'));
      await page.getByRole('button', { name: messages['aiC.checkStatus'].en, exact: true }).click();
      expect(await (await checked).json()).toEqual({ code: 'TERMINAL', reason: 'FAILED' });
      await expect(page.getByText(messages['aiC.expired'].en, { exact: true })).toBeVisible();
      const discarded = page.waitForResponse((response) => response.url().endsWith('/ai_request_control'));
      await page.getByRole('button', { name: messages['aiC.continueManual'].en, exact: true }).click();
      expect(await (await discarded).json()).toEqual({ code: 'TERMINAL', reason: 'FAILED' });
      await expect(page.getByText(messages['aiC.manual'].en, { exact: true })).toBeVisible();
      await page.locator('#item-category').selectOption('top');
      await expect(page.getByRole('button', { name: messages['capture.save'].en, exact: true })).toBeEnabled();
      expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
      expect(api.results.size).toBe(0);
    }
    await expect(page.locator('#item-title')).toHaveValue('My retained manual title');
    await expect(page.getByText(messages['aiC.discardUnconfirmed'].en, { exact: true })).toHaveCount(0);
    expect(api.calls.filter((call) => call.route.endsWith('/ai_request_control'))).toHaveLength(1);
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
  });
}
test('unclear result and manual continuation never imply verified or automatically saved facts', async ({ page }) => {
  const api = await aiFixture(page); api.mode('unclear');
  await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.unclear'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('');
  await page.getByRole('button', { name: messages['aiC.continueManual'].en, exact: true }).click();
  await page.locator('#item-title').fill('Manual garment');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]!.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
});
test('expiry retains fields but requires explicit unknown continuation, without another analysis', async ({ page }) => {
  await page.clock.install();
  const api = await aiFixture(page); api.ttl(2000);
  await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  const title = await page.locator('#item-title').inputValue();
  await page.clock.fastForward(2001);
  await expect(page.getByText(messages['aiC.expired'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue(title);
  await expect(page.getByRole('button', { name: messages['capture.save'].en, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: messages['aiC.continueManual'].en, exact: true }).click();
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]!.field_provenance).toMatchObject({ title: { kind: 'unknown', revision: 1 }, category: { kind: 'unknown', revision: 1 } });
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
});
test('owner change clears an in-flight draft and ignores its late completion', async ({ page }) => {
  const api = await aiFixture(page);
  let release!: () => void, reached = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/functions/v1/analyze-clothing', async (route) => {
    reached = true; await held;
    try { await route.fallback(); } catch { /* The old owner's request is deliberately aborted. */ }
  });
  await addAiPhoto(page, api);
  await expect.poll(() => reached).toBe(true);
  await page.locator('#item-title').fill('Old owner private draft');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('#capture-title')).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('');
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  release();
  await expect(page.getByText('Old owner private draft', { exact: true })).toHaveCount(0);
  expect(api.items).toHaveLength(0); expect(api.files.size).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
test('crop movement and cancellation do not analyze; an applied crop creates exactly one new generation', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  await page.locator('#item-title').fill('Retained manual title');
  await page.locator('#edit-photo').click(); await page.locator('#crop-width').fill('80');
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
  await page.getByRole('button', { name: messages['photo.cancelCrop'].en, exact: true }).click();
  await expect(page.locator('#edit-photo')).toBeVisible();
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
  await page.locator('#edit-photo').click(); await page.locator('#crop-width').fill('80'); await page.locator('#apply-crop').click();
  await expect.poll(() => api.calls.filter((call) => call.route.endsWith('/analyze-clothing')).length).toBe(2);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('Retained manual title');
  expect([...api.results.values()][0]!.generation).toBe(2);
});
test('late result after explicit manual continuation cannot overwrite edits or create rows', async ({ page }) => {
  const api = await aiFixture(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = false;
  await page.route('**/functions/v1/analyze-clothing', async (route) => {
    reached = true; await held;
    try { await route.fallback(); } catch { /* The deliberate local abort may already have closed this fixture request. */ }
  });
  await addAiPhoto(page, api);
  await expect.poll(() => reached).toBe(true);
  await page.getByRole('button', { name: messages['aiC.continueManual'].en, exact: true }).click();
  await page.locator('#item-title').fill('Manual after abort');
  release();
  await expect(page.locator('#item-title')).toHaveValue('Manual after abort');
  await expect(page.locator('#item-category')).toHaveValue('');
  expect(api.items).toHaveLength(0); expect(api.files.size).toBe(0);
});
for (const lost of ['reservation', 'finalizer'] as const) {
  test(`lost ${lost} ACK: Cancel never reserves; retry preserves the frozen Save`, async ({ page }) => {
    const api = await aiFixture(page, 'en', true, lost); await addAiPhoto(page, api);
    await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
    const frozen = structuredClone(api.items);
    await page.getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
    const before = api.requests.length;
    await page.getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.leaveWarning'].en, { exact: true })).toBeVisible();
    expect(api.requests.slice(before).some((call) => call.path.includes('reserve'))).toBe(false);
    expect(api.requests.slice(before).filter((call) => call.path.includes('cancel_analyzed'))).toHaveLength(lost === 'reservation' ? 0 : 1);
    await page.getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
    await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    expect(api.items).toEqual(frozen);
    expect(api.images[0]!.state).toBe('ready');
    expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(2);
  });
}
test('a reserved incomplete Save can be cancelled, without a second reservation or a deletion claim', async ({ page }) => {
  const api = await aiFixture(page); await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  await page.route('**/functions/v1/finalize-analyzed-item', (route) => route.abort('failed'));
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
  await page.getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
  await page.getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.images[0]!.state).toBe('pending');
  expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(1);
  expect(api.requests.filter((call) => call.path.endsWith('/cancel_analyzed_item_save'))).toHaveLength(1);
});
test('Save excludes Cancel until its finalizer has settled', async ({ page }) => {
  const api = await aiFixture(page); await addAiPhoto(page, api);
  await expect(page.getByText(messages['aiC.ready'].en, { exact: true })).toBeVisible();
  let release!: () => void, reached = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/functions/v1/finalize-analyzed-item', async (route) => { reached = true; await held; await route.fallback(); });
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect.poll(() => reached).toBe(true);
  await expect(page.getByRole('button', { name: messages['common.cancel'].en, exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.requests.some((call) => call.path.endsWith('/cancel_analyzed_item_save'))).toBe(false);
  release(); await expect(page.locator('#wardrobe-title')).toBeVisible();
});
test.describe('bounded C visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`consent and analyzed draft ${selected.suffix}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== selected.project);
      const language: Language = selected.language, api = await aiFixture(page, language);
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/i29-photo-first-visual');
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      const capture = async (name: 'consent' | 'analyzed-draft') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await page.getByRole('button', { name: messages['account.menu'][language] }).click();
      await page.getByRole('link', { name: messages['nav.settings'][language], exact: true }).click();
      await expect(page.getByText(messages['aiC.enabled'][language], { exact: true })).toBeVisible();
      await capture('consent');
      await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
      await addAiPhoto(page, api, language);
      await expect(page.getByText(messages['aiC.ready'][language], { exact: true })).toBeVisible();
      await page.locator('details.optional-details summary').click();
      await capture('analyzed-draft');
      expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
      expect(api.items).toHaveLength(0);
    });
  }
});
