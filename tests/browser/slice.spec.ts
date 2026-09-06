import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { messages, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

for (const language of ['en', 'fi', 'sv'] satisfies Language[]) {
  test(`photo, editable draft and explicit save in ${language}`, async ({ page }) => {
    const backend = await mockBackend(page);
    await page.goto('/');
    await page.getByRole('button', { name: messages[`language.${language}`][language], exact: true }).click();
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'][language]);
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
    await expect(page.locator('.capture-photo img')).toBeVisible();
    expect(backend.items).toHaveLength(0);
    expect(backend.files.size).toBe(0);
    await page.locator('#item-title').fill('My edited olive shirt');
    await page.locator('#item-category').selectOption('top');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('An olive shirt, front view');
    await page.getByRole('button', { name: messages['capture.save'][language] }).click();
    await expect(page.locator('.item-caption h2')).toHaveText('My edited olive shirt');
    await expect(page.locator('.item-photo img')).toHaveAttribute('alt', 'An olive shirt, front view');
    expect(backend.items).toHaveLength(1);
    expect(backend.images[0]?.state).toBe('ready');
    expect(backend.files.size).toBe(2);
    expect(backend.profiles[owners.a]?.ui_language).toBe(language);
    expect(backend.profiles[owners.b]?.ui_language).toBe('sv');
    for (const bytes of backend.files.values()) {
      expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
      expect(bytes.length).toBeLessThanOrEqual(512000);
    }
  });
}

test('discarding a prepared draft creates no library records', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('#item-title').fill('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing' }).click();
  await expect(page.locator('#item-title')).toHaveValue('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(backend.items).toHaveLength(0);
  expect(backend.files.size).toBe(0);
});

test('retrying a failed commit reuses the same records and image bytes', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en', failCommitOnce: true });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await page.locator('#item-title').fill('A retryable shirt');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: 'Save to my wardrobe' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.item-caption h2')).toHaveText('A retryable shirt');
  expect(backend.items).toHaveLength(1);
  expect(backend.images).toHaveLength(1);
  expect(backend.files.size).toBe(2);
});

test('logout clears private state before another owner signs in', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'fi' });
  await page.goto('/');
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].fi }).click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Alex', { exact: true })).toHaveCount(0);
  await signIn(page, 'b');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.locator('.account-button')).toContainText('Robin');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('stillroom')))).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test('offline save is disabled without losing draft text', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('#item-title').fill('Still here');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save to my wardrobe' })).toBeDisabled();
  await expect(page.locator('#item-title')).toHaveValue('Still here');
});

test('a failed language save stays visible without pretending to persist', async ({ page }) => {
  const backend = await mockBackend(page, { failLanguageSave: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.locator('.language-warning')).toContainText(messages['account.languageRetry'].fi);
  expect(backend.profiles[owners.a]?.ui_language).toBeNull();
});

test('sign-out is broadcast across tabs without sending account data', async ({ page, context }) => {
  const second = await context.newPage();
  await mockBackend(page, { initialLanguage: 'en' });
  await mockBackend(second, { initialLanguage: 'en' });
  await page.goto('/');
  await second.goto('/');
  await signIn(page);
  await signIn(second);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(second.locator('#wardrobe-title')).toBeVisible();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(second.locator('#email')).toBeVisible();
  await expect(second.getByText('Alex', { exact: true })).toHaveCount(0);
  await second.close();
});

test('accessibility and 320px layout across login, empty wardrobe and draft', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.locator('#email')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await expect(page.locator('#capture-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
