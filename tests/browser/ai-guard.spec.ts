import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, signIn } from './mock-backend';
import { expectSignedIn } from './shell-support';

const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const notice = (page: Page) => page.locator('section[aria-labelledby="ai-guard-title"]');
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';

async function start(page: Page, options: { paused?: boolean; missing?: boolean; language?: Language; hash?: string } = {}) {
  const api = await mockBackend(page, { initialLanguage: options.language ?? 'en' });
  api.guardControl.paused[owners.a] = options.paused === true;
  api.guardControl.missing = options.missing === true;
  await page.goto(options.hash ?? '/#/settings'); await signIn(page);
  await expectSignedIn(page);
  return api;
}

test.describe('AI-GUARD1 spending guard notice', () => {
  test('shows nothing where the account is not paused', async ({ page }) => {
    const api = await start(page);
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect.poll(() => api.guardControl.statusReads).toBeGreaterThan(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test('shows nothing, and asks for nothing, where the backend has no guard', async ({ page }) => {
    const api = await start(page, { missing: true });
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    expect(api.guardControl.resumes).toBe(0);
  });

  test('says what happened and Resume re-opens AI features with one call', async ({ page }) => {
    const api = await start(page, { paused: true });
    await expect(notice(page)).toBeVisible();
    await expect(notice(page).getByRole('heading')).toHaveText(text('aiGuard.title'));
    await expect(notice(page)).toContainText(text('aiGuard.body'));
    await expect(notice(page)).toContainText(text('aiGuard.amounts', 'en', { spent: '$26.14', limit: '$25' }));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await notice(page).getByRole('button', { name: text('aiGuard.resume'), exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
    expect(api.guardControl.resumes).toBe(1);
    expect(api.guardControl.paused[owners.a]).toBe(false);
    await expect(page.locator('#settings-title')).toBeFocused();
  });

  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`stays readable at 320 px and 200 % text in ${language}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await start(page, { paused: true, language });
      await page.addStyleTag({ content: zoom });
      await expect(notice(page)).toBeVisible();
      await expect(notice(page).getByRole('button', { name: text('aiGuard.resume', language), exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await notice(page).boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 321).toBe(true);
    });
  }

  test('a Resume whose reply is lost still clears the notice and tells automatic work it may start again', async ({ page }) => {
    const api = await start(page, { paused: true });
    await expect(notice(page)).toBeVisible();
    api.guardControl.lostResume = true;
    await page.evaluate(() => { (window as unknown as { resumed: number }).resumed = 0;
      window.addEventListener('stillroom-ai-guard-resumed', () => { (window as unknown as { resumed: number }).resumed++; }); });
    await notice(page).getByRole('button', { name: text('aiGuard.resume'), exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
    expect(api.guardControl.resumes).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { resumed: number }).resumed)).toBeGreaterThan(0);
  });

  test('a Stylist message refused as paused says so and is not offered again', async ({ page }) => {
    const api = await mockBackend(page);
    api.stylistControl.setup[owners.a] = { configured: true, activated: true };
    api.stylistControl.consent[owners.a] = 1;
    api.seedSavedItem('a', 'White shirt');
    api.stylistControl.replies.push({ status: 403, body: { code: 'PAUSED' } });
    await page.goto('/#/stylist'); await signIn(page);
    await expectSignedIn(page);
    await page.locator('#stylist-message').fill('Something for Friday');
    await page.getByRole('button', { name: text('stylist.send'), exact: true }).click();
    await expect(page.getByText(text('aiGuard.paused'), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: text('common.retry'), exact: true })).toHaveCount(0);
    await expect(page.locator('#stylist-message')).toHaveValue('Something for Friday');
    expect(api.stylistControl.chats).toHaveLength(1);
  });
});
