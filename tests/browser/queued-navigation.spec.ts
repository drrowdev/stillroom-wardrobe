import { expect, test, type Page, type Route } from '@playwright/test';
import { messages } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

const profileUrl = 'http://127.0.0.1:54321/rest/v1/profiles*';

async function openSettings(page: Page) {
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('link', { name: messages['nav.settings'].en, exact: true }).click();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(page.locator('#profile-timezone')).toBeVisible();
}
// Starts a profile save and holds its write until the test releases it.
async function heldSave(page: Page, name: string) {
  let held: Route | undefined;
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === 'PATCH' && !held) held = route; else await route.fallback();
  });
  await page.locator('#profile-display_name').fill(name);
  await page.getByRole('button', { name: messages['settings.saveProfile'].en, exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByRole('button', { name: messages['common.saving'].en, exact: true })).toBeVisible();
  return () => held!;
}
const nav = (page: Page, key: 'nav.today' | 'nav.wardrobe' | 'nav.outfits') => page.getByRole('navigation').getByRole('link', { name: messages[key].en, exact: true });
const leaveDialog = (page: Page) => page.locator('dialog[aria-labelledby="discard-title"]');
const historyLength = (page: Page) => page.evaluate(() => history.length);

test('a route chosen during a profile save opens once the save finishes, and the latest choice wins', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page); await openSettings(page);
  const held = await heldSave(page, 'Queued rename');
  await nav(page, 'nav.today').click();
  await nav(page, 'nav.outfits').click();
  await expect(page.locator('#settings-title')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  await held().fallback();
  await expect(page.locator('#outfits-title')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/outfits');
  await expect(leaveDialog(page)).toHaveCount(0);
  expect(api.profiles[owners.a]!.display_name).toBe('Queued rename');
  await page.goBack();
  await expect(page.locator('#settings-title')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#outfits-title')).toBeVisible();
});
test('Back during a profile save is followed once the save finishes', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  const start = page.url();
  await openSettings(page);
  const length = await historyLength(page);
  const held = await heldSave(page, 'Back rename');
  await page.goBack();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings');
  await held().fallback();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(page.url()).toBe(start);
  await expect(leaveDialog(page)).toHaveCount(0);
  // Replayed as a traversal: no new entry, and Forward still returns to Settings.
  expect(await historyLength(page)).toBe(length);
  await page.goForward();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(page.locator('#profile-display_name')).toHaveValue('Back rename');
  await page.goBack();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
});
test('Back during a failed profile save asks first, and Discard goes back without a new history entry', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  const start = page.url();
  await openSettings(page);
  const saved = structuredClone(api.profiles[owners.a]);
  const length = await historyLength(page);
  const held = await heldSave(page, 'Unsaved back rename');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings');
  await held().fulfill({ status: 503, json: { message: 'Unavailable' } });
  await expect(leaveDialog(page)).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  await leaveDialog(page).getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(page.url()).toBe(start);
  expect(await historyLength(page)).toBe(length);
  expect(api.profiles[owners.a]).toEqual(saved);
  await page.goForward();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(page.locator('#profile-display_name')).toHaveValue(String(saved!.display_name));
});
test('when the save fails, the queued route asks to discard the edits first', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page); await openSettings(page);
  const saved = structuredClone(api.profiles[owners.a]);
  const held = await heldSave(page, 'Unsaved rename');
  await nav(page, 'nav.outfits').click();
  await held().fulfill({ status: 503, json: { message: 'Unavailable' } });
  await expect(leaveDialog(page)).toBeVisible();
  await expect(leaveDialog(page)).toContainText(messages['settings.discardBody'].en);
  await expect(page.locator('#settings-title')).toBeAttached();
  await leaveDialog(page).getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(page.locator('#profile-display_name')).toHaveValue('Unsaved rename');
  expect(new URL(page.url()).hash).toBe('#/settings');
  await nav(page, 'nav.outfits').click();
  await leaveDialog(page).getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
  await expect(page.locator('#outfits-title')).toBeVisible();
  expect(api.profiles[owners.a]).toEqual(saved);
});
test('signing out during a profile save drops the queued route', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page); await openSettings(page);
  const held = await heldSave(page, 'Signed-out rename');
  await nav(page, 'nav.outfits').click();
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#login-title')).toBeVisible();
  await held().fallback();
  await signIn(page);
  await expect(page.locator('#settings-title')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  await expect(page.locator('#outfits-title')).toHaveCount(0);
  await expect(leaveDialog(page)).toHaveCount(0);
});
