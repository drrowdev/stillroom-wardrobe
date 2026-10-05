import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, pluralText, type Language } from '../../src/i18n/all';
import { mockBackend, owners, signIn } from './mock-backend';
import { openAccountMenu } from './shell-support';

type Backend = Awaited<ReturnType<typeof mockBackend>>;
const button = (page: Page, key: keyof typeof messages, language: Language = 'en') =>
  page.getByRole('button', { name: messages[key][language], exact: true });
const card = (page: Page, title: string) => page.locator('.item-card', { has: page.locator('h2', { hasText: new RegExp(`^${title}$`) }) });
const titles = (page: Page) => page.locator('.item-caption h2');
const bar = (page: Page) => page.locator('.bulk-bar');
const notice = (page: Page) => page.locator('.lifecycle-undo');

async function open(page: Page, names: string[], language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language });
  const saved = names.map(name => api.seedSavedItem('a', name));
  api.seedSavedItem('b', 'Robin private');
  await page.goto('/'); await signIn(page);
  await expect(page.locator('.item-card')).toHaveCount(names.length);
  return { api, ids: Object.fromEntries(saved.map(row => [row.item.title, row.item.id])) as Record<string, string> };
}
async function select(page: Page, names: string[], language: Language = 'en') {
  await button(page, 'wardrobe.select', language).click();
  await expect(bar(page)).toBeVisible();
  for (const name of names) await card(page, name).locator('button.item-select').click();
  await expect(bar(page).getByRole('status')).toHaveText(pluralText(language, 'wardrobe.selected', names.length));
}
const row = (api: Backend, id: string) => api.items.find(item => item.id === id)!;
const trashCalls = (api: Backend, trashed: boolean) => api.trashControl.calls.filter(call => call.trashed === trashed);
function hold(api: Backend) { api.trashControl.hold = true; }
function release(api: Backend) { api.trashControl.hold = false; for (const gate of api.trashControl.held.splice(0)) gate(); }
async function signOut(page: Page, language: Language = 'en') {
  await openAccountMenu(page, language); await button(page, 'auth.signOut', language).click();
  await expect(page.locator('#email')).toBeVisible();
}

test.beforeEach(({ page }, info) => { void page; expect(info.retry, 'New bulk-trash flakiness blocks acceptance').toBe(0); });

test('select three, move them to Trash in one go, then Undo restores all three', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta', 'Gamma', 'Delta']);
  await select(page, ['Alpha', 'Beta', 'Gamma']);
  await expect(card(page, 'Alpha').locator('button.item-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, 'Delta').locator('button.item-select')).toHaveAttribute('aria-pressed', 'false');
  await button(page, 'wardrobe.moveSelected').click();
  await expect(titles(page)).toHaveText(['Delta']);
  await expect(notice(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.bulkTrashed', 3));
  await expect(bar(page)).toHaveCount(0);
  await expect(button(page, 'wardrobe.select')).toHaveAttribute('aria-pressed', 'false');
  expect(trashCalls(api, true).map(call => [call.id, call.version, call.owner]).sort())
    .toEqual(['Alpha', 'Beta', 'Gamma'].map(name => [ids[name], 1, owners.a]).sort());
  for (const name of ['Alpha', 'Beta', 'Gamma']) expect(row(api, ids[name]!).deleted_at).not.toBeNull();
  await page.locator('#bulk-undo').click();
  await expect(titles(page)).toHaveCount(4);
  await expect(notice(page)).toHaveCount(0);
  for (const name of ['Alpha', 'Beta', 'Gamma']) expect(row(api, ids[name]!).deleted_at).toBeNull();
  expect(trashCalls(api, false).map(call => call.version)).toEqual([2, 2, 2]);

  await select(page, ['Alpha', 'Beta', 'Gamma']);
  await button(page, 'wardrobe.moveSelected').click();
  await expect(titles(page)).toHaveText(['Delta']);
  await notice(page).getByRole('link', { name: messages['nav.trash'].en, exact: true }).click();
  await expect(page.locator('#trash-title')).toBeVisible();
  await expect(page.locator('.trash-list li')).toHaveCount(3);
  await expect(page.locator('.trash-list')).not.toContainText('Robin private');
});

test('a version conflict fails only that item: it stays selected and the others stay in Trash', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta', 'Gamma']);
  await select(page, ['Alpha', 'Beta', 'Gamma']);
  row(api, ids.Beta!).version = 5;
  await button(page, 'wardrobe.moveSelected').click();
  await expect(titles(page)).toHaveText(['Beta']);
  await expect(bar(page).getByRole('alert')).toHaveText(pluralText('en', 'wardrobe.bulkFailed', 1));
  await expect(bar(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.selected', 1));
  await expect(card(page, 'Beta').locator('button.item-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(notice(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.bulkTrashed', 2));
  expect(row(api, ids.Alpha!).deleted_at).not.toBeNull();
  expect(row(api, ids.Gamma!).deleted_at).not.toBeNull();
  expect(row(api, ids.Beta!).deleted_at).toBeNull();
});

test('offline disables Move to Trash and shows the offline notice', async ({ page }) => {
  await open(page, ['Alpha', 'Beta']);
  await select(page, ['Alpha']);
  await expect(button(page, 'wardrobe.moveSelected')).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(button(page, 'wardrobe.moveSelected')).toBeDisabled();
  await expect(bar(page)).toContainText(messages['common.offline'].en);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(button(page, 'wardrobe.moveSelected')).toBeEnabled();
});

test('sign-out and an owner switch clear the selection', async ({ page }) => {
  const { api } = await open(page, ['Alpha', 'Beta']);
  await select(page, ['Alpha', 'Beta']);
  await signOut(page);
  await signIn(page, 'b');
  await expect(titles(page)).toHaveText(['Robin private']);
  await expect(page.locator('button.item-select')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(button(page, 'wardrobe.select', 'sv')).toHaveAttribute('aria-pressed', 'false');
  await signOut(page, 'sv');
  await signIn(page, 'a');
  await expect(titles(page)).toHaveCount(2);
  await expect(page.locator('button.item-select')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  expect(api.trashControl.calls).toEqual([]);
});

test('keyboard: Space and Enter toggle cards, a tap never opens the item, Escape returns to Select', async ({ page }) => {
  await open(page, ['Alpha', 'Beta']);
  const select = button(page, 'wardrobe.select');
  await select.focus(); await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  const alpha = card(page, 'Alpha').locator('button.item-select'), beta = card(page, 'Beta').locator('button.item-select');
  await alpha.focus(); await page.keyboard.press('Space');
  await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await beta.focus(); await page.keyboard.press('Enter');
  await expect(beta).toHaveAttribute('aria-pressed', 'true');
  await expect(bar(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.selected', 2));
  await beta.click();
  await expect(beta).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => location.hash)).not.toContain('/items/');
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await alpha.focus(); await page.keyboard.press('Escape');
  await expect(page.locator('button.item-select')).toHaveCount(0);
  await expect(select).toBeFocused();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
});

test('a double activation sends one batch', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta']);
  await select(page, ['Alpha', 'Beta']);
  hold(api);
  await button(page, 'wardrobe.moveSelected').evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect.poll(() => api.trashControl.calls.length).toBe(1);
  await expect(button(page, 'wardrobe.moveSelected')).toBeDisabled();
  await expect(bar(page).getByRole('button', { name: messages['common.cancel'].en, exact: true })).toBeDisabled();
  release(api);
  await expect(page.locator('.item-card')).toHaveCount(0);
  expect(api.trashControl.calls.map(call => call.id).sort()).toEqual([ids.Alpha, ids.Beta].sort());
});

test('leaving the Wardrobe mid-batch keeps the results and a working Undo', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta', 'Gamma', 'Delta']);
  await select(page, ['Alpha', 'Beta', 'Gamma']);
  hold(api);
  await button(page, 'wardrobe.moveSelected').click();
  await expect.poll(() => api.trashControl.calls.length).toBe(1);
  await page.evaluate(() => { location.hash = '#/outfits'; });
  await expect(page.locator('#wardrobe-title')).toHaveCount(0);
  release(api);
  await expect.poll(() => ['Alpha', 'Beta', 'Gamma'].every(name => row(api, ids[name]!).deleted_at !== null)).toBe(true);
  await page.evaluate(() => { location.hash = '#/wardrobe'; });
  await expect(titles(page)).toHaveText(['Delta']);
  await expect(notice(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.bulkTrashed', 3));
  await page.locator('#bulk-undo').click();
  await expect(titles(page)).toHaveCount(4);
  for (const name of ['Alpha', 'Beta', 'Gamma']) expect(row(api, ids[name]!).deleted_at).toBeNull();
});

test('signing out mid-batch stops further writes and leaves nothing for the next owner', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta', 'Gamma']);
  await select(page, ['Alpha', 'Beta', 'Gamma']);
  hold(api);
  await button(page, 'wardrobe.moveSelected').click();
  await expect.poll(() => api.trashControl.calls.length).toBe(1);
  await signOut(page);
  release(api);
  await signIn(page, 'b');
  await expect(titles(page)).toHaveText(['Robin private']);
  await expect(notice(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  expect(api.trashControl.calls).toHaveLength(1);
  expect(api.trashControl.calls[0]!.owner).toBe(owners.a);
  await signOut(page, 'sv');
  await signIn(page, 'a');
  // The one write that was already sent landed; the normal read shows it.
  await expect(titles(page)).toHaveCount(2);
  await expect(notice(page)).toHaveCount(0);
  expect(api.trashControl.calls).toHaveLength(1);
  expect(['Alpha', 'Beta', 'Gamma'].filter(name => row(api, ids[name]!).deleted_at !== null)).toHaveLength(1);
});

test('a partial or interrupted Undo keeps what was restored; the rest can be restored from Trash', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha', 'Beta', 'Gamma']);
  await select(page, ['Alpha', 'Beta', 'Gamma']);
  await button(page, 'wardrobe.moveSelected').click();
  await expect(page.locator('.item-card')).toHaveCount(0);
  row(api, ids.Beta!).version = 9;
  await page.locator('#bulk-undo').click();
  await expect(notice(page).getByRole('alert')).toHaveText(pluralText('en', 'wardrobe.bulkRestoreFailed', 1));
  await expect(titles(page)).toHaveCount(2);
  await expect(card(page, 'Beta')).toHaveCount(0);
  await notice(page).getByRole('link', { name: messages['nav.trash'].en, exact: true }).click();
  await expect(page.locator('.trash-list li')).toHaveCount(1);
  await button(page, 'trash.restore').click();
  await expect(page.locator('.trash-list li')).toHaveCount(0);
  expect(row(api, ids.Beta!).deleted_at).toBeNull();

  // Interrupted: the owner scope ends while the first restore is in flight.
  await page.evaluate(() => { location.hash = '#/wardrobe'; });
  await select(page, ['Alpha', 'Gamma']);
  await button(page, 'wardrobe.moveSelected').click();
  await expect(titles(page)).toHaveText(['Beta']);
  const before = api.trashControl.calls.length;
  hold(api);
  await page.locator('#bulk-undo').click();
  await expect.poll(() => api.trashControl.calls.length).toBe(before + 1);
  await signOut(page);
  release(api);
  await signIn(page, 'a');
  await expect(titles(page)).toHaveCount(2);
  expect(api.trashControl.calls).toHaveLength(before + 1);
  await openAccountMenu(page, 'en');
  await page.locator('.account-popover').getByRole('link', { name: messages['nav.trash'].en, exact: true }).click();
  await expect(page.locator('.trash-list li')).toHaveCount(1);
  await button(page, 'trash.restore').click();
  await expect(page.locator('.trash-list li')).toHaveCount(0);
  for (const name of ['Alpha', 'Beta', 'Gamma']) expect(row(api, ids[name]!).deleted_at).toBeNull();
});

test('the batch uses the selection frozen at submit, not later search or hidden items', async ({ page }) => {
  const { api, ids } = await open(page, ['Alpha linen', 'Beta linen', 'Gamma wool', 'Delta']);
  await select(page, ['Alpha linen', 'Beta linen', 'Gamma wool']);
  await page.locator('#wardrobe-search').fill('linen');
  await expect(titles(page)).toHaveCount(2);
  await expect(bar(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.selected', 2));
  hold(api);
  await button(page, 'wardrobe.moveSelected').click();
  await expect.poll(() => api.trashControl.calls.length).toBe(1);
  await page.locator('#wardrobe-search').fill('');
  await expect(card(page, 'Gamma wool').locator('button.item-select')).toBeDisabled();
  release(api);
  await expect(notice(page).getByRole('status')).toHaveText(pluralText('en', 'wardrobe.bulkTrashed', 2));
  await expect(titles(page)).toHaveCount(2);
  expect(api.trashControl.calls.map(call => [call.id, call.version]).sort())
    .toEqual([[ids['Alpha linen'], 1], [ids['Beta linen'], 1]].sort());
  expect(row(api, ids['Gamma wool']!).deleted_at).toBeNull();
});

const scenes = [
  { file: 'select-en-mobile', language: 'en', selected: [] as string[], width: 0, zoom: false },
  { file: 'selected-fi-mobile', language: 'fi', selected: ['Fictional garment 1', 'Fictional garment 3'], width: 0, zoom: false },
  { file: 'selected-sv-320-200', language: 'sv', selected: ['Fictional garment 2'], width: 320, zoom: true },
] as const;
for (const scene of scenes) {
  test(`selection mode layout and accessibility: ${scene.file}`, async ({ page }, info) => {
    const names = Array.from({ length: 6 }, (_, n) => `Fictional garment ${n + 1}`);
    await open(page, names, scene.language);
    if (scene.width) await page.setViewportSize({ width: scene.width, height: 900 });
    await button(page, 'wardrobe.select', scene.language).click();
    await expect(bar(page)).toBeVisible();
    for (const name of scene.selected) await card(page, name).locator('button.item-select').click();
    await expect(bar(page).getByRole('status')).toHaveText(pluralText(scene.language, 'wardrobe.selected', scene.selected.length));
    if (scene.zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 1rem; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const small = await page.locator('.bulk-bar button, .page-actions button, button.item-select').evaluateAll(controls =>
      controls.filter(control => { const box = control.getBoundingClientRect(); return box.height < 44 || box.width < 44; }).length);
    expect(small).toBe(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect.poll(() => page.locator('.item-photo').evaluateAll(photos => photos.every(photo => {
      const bounds = photo.getBoundingClientRect();
      if (bounds.top > innerHeight + 200 || bounds.bottom < -200) return true;
      const image = photo.querySelector('img');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    }))).toBe(true);
    if (info.project.name === 'mobile') {
      const directory = path.resolve('test-results/bulk1-visual');
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${scene.file}.png`);
      await page.screenshot({ path: file, fullPage: false, scale: 'css' });
      const stat = await lstat(file);
      expect(stat.isFile() && stat.size > 24 && stat.size <= 1024 * 1024).toBe(true);
    }
  });
}
