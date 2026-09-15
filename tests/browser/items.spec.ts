import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn, type MockOptions } from './mock-backend';

const button = (page: Page, key: keyof typeof messages, language: Language = 'en') =>
  page.getByRole('button', { name: messages[key][language], exact: true });
async function setup(page: Page, language: Language = 'en', options: MockOptions = {}) {
  const api = await mockBackend(page, { ...options, initialLanguage: language });
  const saved = api.seedSavedItem(), peer = api.seedSavedItem('b', 'Robin private');
  await page.goto('/'); await signIn(page);
  await expect(page.locator('.item-card')).toHaveCount(1);
  return { api, ...saved, peer };
}
async function trashPage(page: Page, language: Language = 'en') {
  await button(page, 'account.menu', language).click();
  const link = page.locator('.account-popover').getByRole('link', { name: messages['nav.trash'][language], exact: true });
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page.locator('#trash-title')).toBeVisible();
}
async function move(page: Page, id: string, language: Language = 'en') {
  await page.locator(`a[href="#/items/${id}"]`).click();
  await button(page, 'item.trash', language).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.locator('.item-card')).toHaveCount(0);
}
test.beforeEach(({ page }, info) => { checkRetry(page, info.retry); });
function checkRetry(page: Page, retry: number) {
  expect(!page.isClosed() && retry === 0, 'New lifecycle flakiness blocks acceptance').toBe(true);
}
test('account-menu Trash navigation remains unique alongside the Undo notice link', async ({ page }) => {
  const { item } = await setup(page);
  await move(page, item.id);
  await button(page, 'account.menu').click();
  await expect(page.getByRole('link', { name: messages['nav.trash'].en, exact: true })).toHaveCount(2);
  await expect(page.locator('.lifecycle-undo').getByRole('link', { name: messages['nav.trash'].en, exact: true })).toBeVisible();
  await expect(page.locator('.account-popover').getByRole('link', { name: messages['nav.trash'].en, exact: true })).toBeVisible();
  await button(page, 'account.menu').click();
  await trashPage(page);
  await expect(page.locator('.trash-list li')).toHaveCount(1);
});
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`lifecycle ${language}: dirty sections, exact Undo and server Restore preserve saved fields`, async ({ page }) => {
    const { api, item, image, peer } = await setup(page, language);
    const original = structuredClone(item), other = structuredClone(peer);
    await page.locator(`a[href="#/items/${item.id}"]`).click();
    await page.locator('#detail-title').fill('Edited saved shirt');
    await expect(button(page, 'item.trash', language)).toBeDisabled();
    await button(page, 'detail.saveName', language).click();
    await expect(button(page, 'item.trash', language)).toBeEnabled();
    await page.locator('#detail-description').fill('Unsaved image description');
    await expect(button(page, 'item.trash', language)).toBeDisabled();
    await button(page, 'detail.saveDescription', language).click();
    await expect(button(page, 'item.trash', language)).toBeEnabled();
    const saved = structuredClone(item);
    await button(page, 'item.trash', language).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await button(page, 'common.undo', language).click();
    await expect(page.locator('.item-card')).toHaveCount(1);
    expect(item).toEqual({ ...saved, version: saved.version + 2, deleted_at: null, updated_at: item.updated_at });
    await move(page, item.id, language);
    await trashPage(page, language);
    await button(page, 'trash.restore', language).click();
    await expect(page.getByText(messages['lifecycle.restored'][language], { exact: true })).toBeVisible();
    expect(item.title).toBe('Edited saved shirt'); expect(image.alt_text).toBe('Unsaved image description');
    expect(item.category).toBe(original.category); expect(peer).toEqual(other);
    expect(api.files.size).toBe(4);
    expect(api.requests.filter(request => request.path.endsWith('/set_item_trashed'))).toHaveLength(4);
    expect(api.requests.some(request => request.path.startsWith('/functions/'))).toBe(false);
  });
}
test('Trash expires the convenience Undo without making Restore a client-clock decision', async ({ page }) => {
  const { item } = await setup(page);
  await page.clock.install();
  await move(page, item.id);
  await expect(button(page, 'common.undo')).toBeVisible();
  await page.clock.fastForward(8000);
  await expect(button(page, 'common.undo')).toHaveCount(0);
  await trashPage(page);
  item.deleted_at = '2020-01-01T00:00:00Z';
  await expect(button(page, 'trash.restore')).toBeEnabled();
  await button(page, 'trash.restore').click();
  await expect(page.getByRole('alert')).toHaveText(messages['error.conflict'].en);
  expect(item.deleted_at).toBe('2020-01-01T00:00:00Z');
});
test('lost Trash reply checks exact saved result without sending the change again', async ({ page }) => {
  const { api, item } = await setup(page, 'en', { lifecycleLoss: 'change' });
  await page.locator(`a[href="#/items/${item.id}"]`).click();
  await button(page, 'item.trash').click();
  await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.unconfirmed'].en);
  await expect(page.locator('#detail-title')).toBeDisabled();
  expect(api.requests.filter(request => request.path.endsWith('/set_item_trashed'))).toHaveLength(1);
  await button(page, 'lifecycle.check').click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.requests.filter(request => request.path.endsWith('/set_item_trashed'))).toHaveLength(1);
});
for (const loss of ['begin', 'delete', 'finish'] as const) {
  test(`lost ${loss}: explicit check/reload/resume, never generic absence success`, async ({ page }) => {
    const { api, item, image, peer } = await setup(page, 'en', { lifecycleLoss: loss });
    const other = structuredClone(peer);
    await move(page, item.id); await trashPage(page);
    await page.locator('.trash-list').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(item.title);
    await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.unconfirmed'].en);
    const deletes = api.requests.filter(request => request.method === 'DELETE').length;
    expect(deletes).toBe(loss === 'begin' ? 0 : loss === 'delete' ? 1 : 2);
    await page.waitForTimeout(250);
    expect(api.requests.filter(request => request.method === 'DELETE')).toHaveLength(deletes);
    const claimBeforeRefresh = structuredClone(api.deletionClaims.get(item.id));
    const writesBeforeRefresh = api.requests.filter(request => request.method !== 'GET' && !request.path.endsWith('/item_deletion_status'));
    await expect(button(page, 'common.refresh')).toBeEnabled();
    await button(page, 'common.refresh').click();
    await expect(button(page, 'common.refresh')).toBeEnabled();
    await expect(page.locator('.lifecycle-resume')).toContainText(item.title);
    await expect(page.locator('.trash-list button:enabled')).toHaveCount(0);
    expect(api.deletionClaims.get(item.id)).toEqual(claimBeforeRefresh);
    expect(api.requests.filter(request => request.method !== 'GET' && !request.path.endsWith('/item_deletion_status'))).toEqual(writesBeforeRefresh);
    if (loss === 'finish') {
      await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en }).click();
      await expect(page.getByText(messages['lifecycle.deleted'].en, { exact: true })).toHaveCount(0);
      await expect(button(page, 'lifecycle.resume')).toHaveCount(0);
    } else {
      const original = { ...api.deletionClaims.get(item.id)! };
      await page.reload(); await expect(page.locator('.trash-list li')).toHaveCount(1);
      await page.locator('.trash-list').getByRole('button', { name: messages['lifecycle.check'].en }).click();
      await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en }).click();
      await expect(button(page, 'lifecycle.resume')).toBeVisible();
      expect(api.deletionClaims.get(item.id)).toEqual(original);
      await button(page, 'common.refresh').click();
      await expect(button(page, 'lifecycle.resume')).toBeEnabled();
      expect(api.deletionClaims.get(item.id)).toEqual(original);
      expect(api.requests.filter(request => request.method === 'DELETE')).toHaveLength(deletes);
      await button(page, 'lifecycle.resume').click();
      await expect(page.getByText(messages['lifecycle.deleted'].en, { exact: true })).toBeVisible();
      expect(api.files.has(image.main_path) || api.files.has(image.thumb_path)).toBe(false);
    }
    expect(peer).toEqual(other);
  });
}
test('named confirmation refuses stale name/manifest and pending or unmanifested photos', async ({ page }) => {
  const { api, item, image } = await setup(page);
  await move(page, item.id); await trashPage(page);
  const open = () => page.locator('.trash-list').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
  await open();
  item.title = 'Changed elsewhere'; item.version++;
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['error.conflict'].en);
  expect(api.deletionClaims.size).toBe(0);
  expect(api.requests.some(request => request.method === 'DELETE')).toBe(false);
  await page.reload(); await expect(page.locator('.trash-list li')).toHaveCount(1);
  api.files.set(`${owners.a}/${item.id}/orphan.jpg`, api.fixture);
  await open(); await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.blocked'].en);
  api.files.delete(`${owners.a}/${item.id}/orphan.jpg`); image.state = 'pending';
  await open();
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['error.conflict'].en);
  expect(api.deletionClaims.size).toBe(0);
});
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`known blocked deletion ${language} is a neutral limitation with no claim or byte attempt`, async ({ page }) => {
    const { api, item } = await setup(page, language);
    await move(page, item.id, language); await trashPage(page, language);
    await expect(page.locator('.trash-list li')).toHaveCount(1);
    for (let n = 0; n < 3; n++) api.files.set(`${owners.a}/${item.id}/unmanifested-${n}.jpg`, api.fixture);
    const response = page.waitForResponse(value => value.url().endsWith('/rest/v1/rpc/item_deletion_status'));
    await button(page, 'lifecycle.delete', language).click();
    const rows: unknown = await (await response).json();
    expect(rows).toEqual([expect.objectContaining({ id: item.id, cleanup_blocked: true, unmanifested_count: 3 })]);
    await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.blocked'][language]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.deletionClaims.size).toBe(0);
    expect(api.requests.some(request => request.path.endsWith('/begin_item_deletion') || request.method === 'DELETE')).toBe(false);
  });
}
test('failed confirmation construction closes the dialog and reports an error without a partial intent', async ({ page }) => {
  const { api, item } = await setup(page);
  const pageErrors: Error[] = [];
  page.on('pageerror', error => pageErrors.push(error));
  await move(page, item.id); await trashPage(page);
  await button(page, 'lifecycle.delete').click();
  await page.evaluate(() => {
    const original = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = () => { crypto.randomUUID = original; throw new Error('Fictional nonce failure'); };
  });
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText(messages['error.unavailable'].en);
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.locator('.lifecycle-resume')).toHaveCount(0);
  await expect(button(page, 'trash.restore')).toBeEnabled();
  expect(api.deletionClaims.size).toBe(0);
  expect(api.requests.some(request => request.path.endsWith('/begin_item_deletion') || request.method === 'DELETE')).toBe(false);
  expect(pageErrors).toEqual([]);
  await button(page, 'lifecycle.delete').click();
  await button(page, 'common.cancel').click();
  await expect(button(page, 'lifecycle.delete')).toBeFocused();
});
test('Refresh retains an uncertain Restore snapshot and Check confirms without another write', async ({ page }) => {
  const { api, item } = await setup(page, 'en', { lifecycleLoss: 'change' });
  item.deleted_at = new Date().toISOString();
  await trashPage(page); await button(page, 'trash.restore').click();
  await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.unconfirmed'].en);
  const version = item.version;
  await button(page, 'common.refresh').click();
  await expect(page.locator('.trash-list li')).toHaveCount(0);
  await expect(button(page, 'lifecycle.check')).toBeEnabled();
  await button(page, 'lifecycle.check').click();
  await expect(page.getByText(messages['lifecycle.restored'].en, { exact: true })).toBeVisible();
  expect(item.version).toBe(version);
  expect(api.requests.filter(request => request.path.endsWith('/set_item_trashed'))).toHaveLength(1);
});
test('requested wardrobe order retains ordinal descending dates and ID tiebreaks', async ({ page }) => {
  const { api, item } = await setup(page);
  const other = api.seedSavedItem('a', 'Fictional tie'), newest = api.seedSavedItem('a', 'Fictional newest');
  newest.item.created_at = '2026-09-10T00:00:00Z';
  const tied = [item, other.item].sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  await button(page, 'wardrobe.refresh').click();
  await expect(page.locator('.item-card h2')).toHaveText([newest.item.title, ...tied.map(row => row.title)]);
});
test('standalone list states and initially offline Trash preserve pages across reconnect, not owners', async ({ page, context }) => {
  const { api, item } = await setup(page);
  Object.assign(item, { availability: 'laundry', lifecycle: 'archived', favourite: true, exclude_suggestions: true });
  await button(page, 'wardrobe.refresh').click();
  await expect(page.locator('.item-card')).toHaveCount(1);
  for (const key of ['availability.laundry', 'lifecycle.archived', 'lifecycle.excluded', 'item.favourite'] as const) {
    await expect(page.locator('.item-card').getByText(messages[key].en, { exact: true })).toBeVisible();
  }
  for (let n = 0; n < 41; n++) { const saved = api.seedSavedItem('a', `Fictional trash ${n}`); saved.item.deleted_at = new Date().toISOString(); }
  await context.setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await trashPage(page);
  await expect(button(page, 'common.refresh')).toBeDisabled();
  await expect(page.locator('.trash-list li')).toHaveCount(0);
  expect(api.requests.some(request => request.path.endsWith('/item_deletion_status'))).toBe(false);
  await context.setOffline(false);
  await expect(page.locator('.trash-list li')).toHaveCount(40);
  await button(page, 'wardrobe.more').click(); await expect(page.locator('.trash-list li')).toHaveCount(41);
  const displayed = await page.locator('.trash-list h2').allTextContents();
  expect([...displayed].sort()).toEqual(Array.from({ length: 41 }, (_, n) => `Fictional trash ${n}`).sort());
  const reads = api.requests.filter(request => request.path.endsWith('/item_deletion_status')).length;
  await context.setOffline(true);
  await expect(button(page, 'common.refresh')).toBeDisabled();
  await context.setOffline(false);
  await expect(button(page, 'common.refresh')).toBeEnabled();
  await page.waitForTimeout(250);
  await expect(page.locator('.trash-list h2')).toHaveText(displayed);
  expect(api.requests.filter(request => request.path.endsWith('/item_deletion_status'))).toHaveLength(reads);
  await button(page, 'common.refresh').click();
  await expect(page.locator('.trash-list li')).toHaveCount(40);
  const peerTrash = api.seedSavedItem('b', 'Robin trash');
  peerTrash.item.deleted_at = new Date().toISOString();
  await button(page, 'account.menu').click(); await button(page, 'auth.signOut').click();
  await signIn(page, 'b');
  await expect(page.locator('#trash-title')).toBeVisible();
  await expect(page.locator('.trash-list h2')).toHaveText(['Robin trash']);
  expect(api.requests.some(request => request.path.endsWith('/begin_item_deletion') || request.method === 'DELETE')).toBe(false);
});
test('bounded synthetic Trash and named-delete captures with functional/a11y assertions in every project', async ({ page }, info) => {
  const { api, item } = await setup(page);
  await move(page, item.id); await trashPage(page);
  const directory = path.resolve('test-results/i08-visual');
  const captures = [
    { language: 'en', width: 1280, trash: 'trash-en-desktop.png', deletion: 'delete-en-desktop.png' },
    { language: 'fi', width: 320, trash: 'trash-fi-mobile.png', deletion: 'delete-fi-mobile.png' },
  ] as const;
  for (const capture of captures) {
    if (capture.language === 'fi') {
      await button(page, 'account.menu').click(); await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await button(page, 'account.menu', 'fi').click();
    }
    await page.setViewportSize({ width: capture.width, height: 900 });
    await expect(page.locator('.trash-list li')).toHaveCount(1);
    const captureFile = async (file: string) => {
      expect(await page.evaluate(({ origin, language }) => location.origin === origin && location.hash === '#/trash'
        && document.documentElement.lang === language && !document.querySelector('input[type=password],#email')
        && !/eyJ|sb_|service_role|Bearer /i.test(document.body.innerText)
        && document.documentElement.scrollWidth <= innerWidth, { origin: new URL(info.project.use.baseURL!).origin, language: capture.language })).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (info.project.name === 'chromium') {
        await mkdir(directory, { recursive: true });
        const buffer = await page.screenshot({ path: path.join(directory, file), fullPage: true });
        expect(buffer.length > 24 && buffer.length <= 1024 * 1024).toBe(true);
      }
    };
    await captureFile(capture.trash);
    await page.locator('.trash-list').getByRole('button', { name: messages['lifecycle.delete'][capture.language], exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(item.title);
    await expect(page.getByRole('dialog')).toContainText(messages['lifecycle.noUndo'][capture.language]);
    await expect(button(page, 'common.cancel', capture.language)).toBeFocused();
    await captureFile(capture.deletion);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.trash-list').getByRole('button', { name: messages['lifecycle.delete'][capture.language], exact: true })).toBeFocused();
    expect(api.deletionClaims.size).toBe(0);
  }
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 2rem; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === 'chromium') {
    const expected = captures.flatMap(capture => [capture.trash, capture.deletion]).sort();
    expect((await readdir(directory)).sort()).toEqual(expected);
    for (const file of expected) { const stat = await lstat(path.join(directory, file)); expect(stat.isFile() && stat.size <= 1024 * 1024).toBe(true); }
  }
});
