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
test('I10b deletion stops at forty dispatches and resumes explicitly; Swedish mobile accessibility capture', async ({ page }, info) => {
  const { api, item, peer } = await setup(page, 'sv');
  const other = structuredClone(peer);
  for (let n = 0; n < 41; n++) api.files.set(`${owners.a}/${item.id}/unfinished-${String(n).padStart(3, '0')}.jpg`, api.fixture);
  await move(page, item.id, 'sv'); await trashPage(page, 'sv');
  await button(page, 'deletion.prepare', 'sv').click();
  await expect(page.getByRole('dialog')).toContainText(item.title);
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].sv, exact: true }).click();
  await expect(button(page, 'lifecycle.resume', 'sv')).toBeEnabled();
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(40);
  expect(api.deletionClaims.size).toBe(0);
  expect(api.images.some(row => row.item_id === item.id)).toBe(true);
  await expect(button(page, 'deletion.cancel', 'sv')).toHaveCount(0);
  await expect(button(page, 'trash.restore', 'sv')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 1200 });
  expect(await page.evaluate(origin => location.origin === origin && location.hash === '#/trash'
    && document.documentElement.lang === 'sv' && document.documentElement.scrollWidth <= innerWidth
    && !document.querySelector('#email,input[type=password]'), new URL(info.project.use.baseURL!).origin)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  if (info.project.name === 'chromium') {
    const directory = path.resolve('test-results', 'i10b-visual');
    await mkdir(directory, { recursive: true });
    const buffer = await page.screenshot({ path: path.join(directory, 'deletion-resume-sv-mobile.png'), fullPage: false });
    expect(buffer.length).toBeLessThanOrEqual(1024 * 1024);
    expect(buffer.readUInt32BE(16)).toBe(320); expect(buffer.readUInt32BE(20)).toBe(1200);
  }
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button(page, 'lifecycle.resume', 'sv').click();
  await expect(page.getByText(messages['deletion.deleted'].sv, { exact: true })).toBeVisible();
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(43);
  expect(api.deletionOperations[0]?.receipt.phase).toBe('completed');
  expect(peer).toEqual(other);
});
test('I10b unsupported target blocks preparation; missing durable receipt never proves deletion', async ({ page }) => {
  const { api, item } = await setup(page);
  api.files.set(`${owners.a}/${item.id}/unsafe name.jpg`, api.fixture);
  await move(page, item.id); await trashPage(page);
  await button(page, 'deletion.prepare').click();
  await expect(page.getByText(messages['deletion.blocked'].en, { exact: true })).toBeVisible();
  expect(api.deletionOperations[0]?.receipt.phase).toBe('blocked_preflight');
  expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
  await page.route('**/rest/v1/rpc/item_deletion_operation_status', route => route.fulfill({ json: null }));
  await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.unconfirmed'].en);
  await expect(page.getByText(messages['deletion.deleted'].en, { exact: true })).toHaveCount(0);
  expect(api.items.some(row => row.id === item.id)).toBe(true);
});
test('I10b preparation stays reversible but an ambiguous authorization removes the earlier Undo', async ({ page }) => {
  const { api, item } = await setup(page);
  const instant = new Date('2026-09-22T12:00:00Z');
  await page.clock.install({ time: instant });
  await page.clock.pauseAt(new Date(instant.getTime() + 1000));
  await move(page, item.id);
  await expect(button(page, 'common.undo')).toBeVisible();
  await trashPage(page);
  await button(page, 'deletion.prepare').click();
  await page.getByRole('dialog').getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(button(page, 'trash.restore')).toBeEnabled();
  await button(page, 'common.back').click();
  await expect(button(page, 'common.undo')).toBeVisible();
  await trashPage(page);
  await button(page, 'deletion.prepare').click();
  await page.route('**/rest/v1/rpc/authorize_item_deletion', route => route.abort('failed'));
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
  await expect(page.getByText(messages['deletion.uncertain'].en, { exact: true })).toBeVisible();
  await expect(button(page, 'deletion.cancel')).toHaveCount(0);
  await button(page, 'common.back').click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(button(page, 'common.undo')).toHaveCount(0);
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(0);
  expect(api.items.some(row => row.id === item.id)).toBe(true);
});
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
    await button(page, 'detail.saveChanges', language).click();
    await expect(button(page, 'item.trash', language)).toBeEnabled();
    await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
    await page.locator('#detail-description').fill('Unsaved image description');
    await expect(button(page, 'item.trash', language)).toBeDisabled();
    await button(page, 'detail.saveChanges', language).click();
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
    await page.locator('.trash-list').getByRole('button', { name: messages['deletion.prepare'].en, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(item.title);
    await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(messages['lifecycle.unconfirmed'].en);
    const deletes = api.requests.filter(request => request.method === 'DELETE').length;
    expect(deletes).toBe(loss === 'begin' ? 0 : loss === 'delete' ? 1 : 2);
    await page.waitForTimeout(250);
    expect(api.requests.filter(request => request.method === 'DELETE')).toHaveLength(deletes);
    const claimBeforeRefresh = structuredClone(api.deletionClaims.get(item.id));
    const mutating = (request: typeof api.requests[number]) => request.method !== 'GET'
      && !['item_deletion_status', 'item_deletion_operations', 'item_deletion_operation_status'].some(name => request.path.endsWith(`/${name}`));
    const writesBeforeRefresh = api.requests.filter(mutating);
    await expect(button(page, 'common.refresh')).toBeEnabled();
    await button(page, 'common.refresh').click();
    await expect(button(page, 'common.refresh')).toBeEnabled();
    await expect(page.locator('.lifecycle-resume')).toContainText(item.title);
    await expect(page.locator('.trash-list button:enabled')).toHaveCount(0);
    expect(api.deletionClaims.get(item.id)).toEqual(claimBeforeRefresh);
    expect(api.requests.filter(mutating)).toEqual(writesBeforeRefresh);
    if (loss === 'finish') {
      await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en }).click();
      await expect(page.getByText(messages['deletion.deleted'].en, { exact: true })).toBeVisible();
      expect(api.deletionOperations[0]?.receipt.phase).toBe('completed');
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
      await expect(page.getByText(messages['deletion.deleted'].en, { exact: true })).toBeVisible();
      expect(api.files.has(image.main_path) || api.files.has(image.thumb_path)).toBe(false);
    }
    expect(peer).toEqual(other);
  });
}
test('named confirmation refuses stale name or inventory before any deletion', async ({ page }) => {
  const { api, item } = await setup(page);
  await move(page, item.id); await trashPage(page);
  const open = async () => {
    await page.locator('.trash-list').getByRole('button', { name: messages['deletion.prepare'].en, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(item.title);
  };
  await open();
  item.title = 'Changed elsewhere'; item.version++;
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['error.conflict'].en);
  expect(api.deletionClaims.size).toBe(0);
  expect(api.requests.some(request => request.method === 'DELETE')).toBe(false);
  await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en }).click();
  await button(page, 'deletion.cancel').click();
  await expect(button(page, 'trash.restore')).toBeEnabled();
  await open();
  api.files.set(`${owners.a}/${item.id}/orphan.jpg`, api.fixture);
  await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['error.conflict'].en);
  expect(api.deletionClaims.size).toBe(0);
});
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`pending and unmanifested deletion ${language} requires full preparation and explicit authorization`, async ({ page }) => {
    const { api, item } = await setup(page, language);
    await move(page, item.id, language); await trashPage(page, language);
    await expect(page.locator('.trash-list li')).toHaveCount(1);
    for (let n = 0; n < 3; n++) api.files.set(`${owners.a}/${item.id}/unmanifested-${n}.jpg`, api.fixture);
    const response = page.waitForResponse(value => value.url().endsWith('/rest/v1/rpc/item_deletion_status'));
    const pendingId = '31000000-0000-4000-8000-000000000001';
    const pending = { ...api.images.find(image => image.item_id === item.id)!, id: pendingId, state: 'pending',
      main_path: `${owners.a}/${item.id}/${pendingId}/main.jpg`, thumb_path: `${owners.a}/${item.id}/${pendingId}/thumb.jpg` };
    api.images.push(pending); api.files.set(String(pending.main_path), api.fixture);
    await button(page, 'deletion.prepare', language).click();
    const rows: unknown = await (await response).json();
    expect(rows).toEqual([expect.objectContaining({ id: item.id, cleanup_blocked: true, unmanifested_count: 3 })]);
    await expect(page.getByRole('dialog')).toContainText(item.title);
    expect(api.deletionOperations[0]?.receipt).toMatchObject({ phase: 'prepared', pendingTargets: 2, unmanifestedTargets: 3, registeredTargets: 2 });
    expect(api.deletionClaims.size).toBe(0);
    expect(api.requests.some(request => request.path.endsWith('/begin_item_deletion') || request.method === 'DELETE')).toBe(false);
    await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'][language], exact: true }).click();
    await expect(page.getByText(messages['deletion.deleted'][language], { exact: true })).toBeVisible();
    expect(api.images.some(image => image.item_id === item.id)).toBe(false);
    expect([...api.files.keys()].some(path => path.startsWith(`${owners.a}/${item.id}/`))).toBe(false);
    expect(api.deletionOperations[0]?.receipt.phase).toBe('completed');
  });
}
test('failed confirmation construction closes the dialog and reports an error without a partial intent', async ({ page }) => {
  const { api, item } = await setup(page);
  const pageErrors: Error[] = [];
  page.on('pageerror', error => pageErrors.push(error));
  await move(page, item.id); await trashPage(page);
  await page.evaluate(() => {
    const original = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = () => { crypto.randomUUID = original; throw new Error('Fictional nonce failure'); };
  });
  await button(page, 'deletion.prepare').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText(messages['error.unavailable'].en);
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.locator('.lifecycle-resume')).toHaveCount(0);
  await expect(button(page, 'trash.restore')).toBeEnabled();
  expect(api.deletionClaims.size).toBe(0);
  expect(api.requests.some(request => request.path.endsWith('/begin_item_deletion') || request.method === 'DELETE')).toBe(false);
  expect(pageErrors).toEqual([]);
  await button(page, 'deletion.prepare').click();
  await button(page, 'common.cancel').click();
  await expect(button(page, 'deletion.prepare')).toBeFocused();
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
    await page.locator('.trash-list').getByRole('button', { name: messages['deletion.prepare'][capture.language], exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(item.title);
    await expect(page.getByRole('dialog')).toContainText(messages['deletion.garmentWarning'][capture.language]);
    await expect(button(page, 'common.cancel', capture.language)).toBeFocused();
    await captureFile(capture.deletion);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.trash-list').getByRole('button', { name: messages['deletion.prepare'][capture.language], exact: true })).toBeFocused();
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
