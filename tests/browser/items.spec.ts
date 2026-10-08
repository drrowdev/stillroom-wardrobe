import { test, expect, type Page, type TestInfo, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { codePreloaded } from './lazy-support';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n/all';
import { mockBackend, owners, signIn, type MockOptions } from './mock-backend';
import { editItem } from './ai-photo-first-support';
import { closeAccountMenu, openAccountMenu } from './shell-support';

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
  await openAccountMenu(page, language);
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
  // UX5: Restore is the one primary action on a row; permanent deletion is a quieter text action.
  await expect(button(page, 'trash.restore')).toHaveClass(/\bbutton-primary\b/);
  await expect(button(page, 'deletion.prepare')).toHaveClass(/\btext-button\b/);
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
type TrashApi = Awaited<ReturnType<typeof mockBackend>>;
function seedTrashOutfit(api: TrashApi, itemId: string, title = 'Saved outfit', now = new Date().toISOString()) {
  const id = randomUUID();
  api.outfits.push({ id, owner_id: owners.a, title, occasion: 'everyday', notes: '', favourite: false,
    deleted_at: now, version: 1, created_at: now, updated_at: now });
  api.outfitItems.push({ owner_id: owners.a, outfit_id: id, item_id: itemId, position: 0 });
  return id;
}
async function batchSetup(page: Page, language: Language = 'en', count = 1, withOutfit = true, options: MockOptions = {}) {
  const api = await mockBackend(page, { ...options, initialLanguage: language });
  const clothes = Array.from({ length: count }, (_, n) => {
    const saved = api.seedSavedItem('a', `Trashed shirt ${n + 1}`);
    saved.item.deleted_at = new Date().toISOString(); return saved;
  });
  const active = api.seedSavedItem('a', 'Active shirt'), peer = api.seedSavedItem('b', 'Robin private');
  const outfitId = withOutfit ? seedTrashOutfit(api, String(clothes[0]!.item.id)) : null;
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await trashPage(page, language);
  await expect(page.locator('.trash-list').first().getByRole('listitem')).toHaveCount(Math.min(count, 40));
  return { api, clothes, active, peer, outfitId };
}
const batchDialog = (page: Page) => page.locator('dialog[aria-labelledby="empty-trash-title"]');
const progress = (page: Page) => page.locator('.empty-trash-progress');
async function confirmBatch(page: Page, language: Language = 'en') {
  await page.locator('#empty-trash-button').click();
  await expect(batchDialog(page)).toBeVisible();
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'][language], exact: true }).click();
}
async function batchCapture(page: Page, info: TestInfo, name: string, language: Language) {
  expect(info.retry).toBe(0);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(({ origin, language }) => location.origin === origin && location.hash === '#/trash'
    && document.documentElement.lang === language && document.documentElement.scrollWidth <= innerWidth
    && !document.querySelector('#email,input[type=password]'), { origin: new URL(info.project.use.baseURL!).origin, language })).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  if (info.project.name === 'chromium') {
    const directory = path.resolve('test-results', 'trash1-visual'); await mkdir(directory, { recursive: true });
    const buffer = await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: false });
    expect(buffer.length).toBeLessThanOrEqual(1024 * 1024);
    expect(buffer.readUInt32BE(16)).toBe(320); expect(buffer.readUInt32BE(20)).toBe(900);
  }
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`TRASH1 one mixed confirmation is reversible before consent (${language})`, async ({ page }, info) => {
    const { api } = await batchSetup(page, language);
    await page.locator('#empty-trash-button').click();
    await expect(batchDialog(page)).toContainText(messages['emptyTrash.consequences'][language]);
    await expect(batchDialog(page)).toContainText(messages['deletion.garmentWarning'][language]);
    expect(api.deletionOperations).toHaveLength(0); expect(api.outfitLifecycleControl.writes).toHaveLength(0);
    await batchCapture(page, info, `confirmation-${language}`, language);
    await expect(batchDialog(page).getByRole('button', { name: messages['common.cancel'][language], exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(batchDialog(page)).toHaveCount(0);
    await expect(page.locator('#empty-trash-button')).toBeFocused();
    expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
    expect(api.deletionOperations).toHaveLength(0); expect(api.outfitLifecycleControl.writes).toHaveLength(0);
  });
}
test('TRASH1 includes every clothes page, preserves active/peer/history and excludes new trash', async ({ page }) => {
  const { api, clothes, active, peer, outfitId } = await batchSetup(page, 'en', 41);
  const intact = structuredClone({ active: active.item, peer: peer.item, image: peer.image });
  const event = randomUUID();
  api.wearEvents.push({ id: event, owner_id: owners.a, outfit_id: outfitId, local_date: '2026-01-01', timezone: 'Europe/Helsinki',
    state: 'worn', label: 'Historical outfit', deleted_at: null, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  api.wearLinks.push({ id: randomUUID(), owner_id: owners.a, event_id: event, item_id: clothes[0]!.item.id, title_snapshot: 'Historical shirt', category_snapshot: 'top' });
  await page.locator('#empty-trash-button').click(); await expect(batchDialog(page)).toContainText('41 items');
  const added = api.seedSavedItem('a', 'Added after confirmation snapshot'); added.item.deleted_at = new Date().toISOString();
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true }).click();
  for (const itemId of clothes.map(saved => String(saved.item.id)).sort()) {
    await expect.poll(() => api.deletionOperations.find(value => value.receipt.itemId === itemId)?.receipt.phase).toBe('completed');
  }
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
  expect(api.deletionOperations.filter(value => value.receipt.phase === 'completed')).toHaveLength(41);
  expect(api.items.some(row => row.id === added.item.id)).toBe(true);
  expect(api.outfits.some(row => row.id === outfitId)).toBe(false);
  expect({ active: active.item, peer: peer.item, image: peer.image }).toEqual(intact);
  expect(api.wearEvents[0]).toMatchObject({ outfit_id: null, label: 'Historical outfit', local_date: '2026-01-01', state: 'worn' });
  expect(api.wearLinks[0]).toMatchObject({ title_snapshot: 'Historical shirt', category_snapshot: 'top' });
  const writes = api.requests.filter(call => call.path.endsWith('/delete_trashed_outfit') || call.path.endsWith('/prepare_item_deletion'));
  expect(writes[0]!.path).toContain('delete_trashed_outfit');
  expect(api.requests.some(call => call.path.startsWith('/functions/'))).toBe(false);
});
test('TRASH1 restored targets are skipped, and bounded photos require deliberate Resume', async ({ page }, info) => {
  const { api, clothes } = await batchSetup(page, 'en', 2, false);
  const saved = clothes[0]!, targetId = String(saved.item.id);
  for (let n = 0; n < 21; n++) {
    const imageId = randomUUID(), main = `${owners.a}/${targetId}/${imageId}/main.jpg`, thumb = `${owners.a}/${targetId}/${imageId}/thumb.jpg`;
    api.images.push({ ...saved.image, id: imageId, item_id: targetId, main_path: main, thumb_path: thumb, state: 'retired', retired_at: new Date().toISOString() });
    api.files.set(main, api.fixture); api.files.set(thumb, api.fixture);
  }
  await page.locator('#empty-trash-button').click(); await expect(batchDialog(page)).toBeVisible();
  Object.assign(clothes[1]!.item, { deleted_at: null, version: 2 });
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true }).click();
  await expect(progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true })).toBeEnabled();
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(40);
  await batchCapture(page, info, 'progress-en', 'en');
  await progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true }).click();
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
  await expect(progress(page)).toContainText(messages['emptyTrash.skipped'].en);
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(44);
  expect(api.items.some(row => row.id === clothes[1]!.item.id)).toBe(true);
});
for (const checkWith of ['batch', 'global'] as const) {
  test(`TRASH1 lost outfit reply uses ${checkWith} Check without resending`, async ({ page }) => {
    const { api } = await batchSetup(page);
    await page.route('**/rest/v1/rpc/delete_trashed_outfit', async route => {
      api.outfitControl.readFailures = 100; await route.fallback();
    });
    api.outfitLifecycleControl.scripts.push({ mode: 'committedLost' });
    await confirmBatch(page);
    await expect(progress(page).getByRole('alert')).toContainText(messages['emptyTrash.checkFirst'].en);
    expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
    api.outfitControl.readFailures = 0;
    if (checkWith === 'global') {
      await page.locator('.notice-error').getByRole('button', { name: messages['lifecycle.check'].en, exact: true }).click();
      await expect(page.locator('.notice-error').getByRole('button', { name: messages['lifecycle.check'].en, exact: true })).toHaveCount(0);
    }
    await progress(page).getByRole('button', { name: messages['lifecycle.check'].en, exact: true }).click();
    await expect(progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true })).toBeEnabled();
    expect(api.outfitLifecycleControl.writes).toHaveLength(1);
    expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
    await progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true }).click();
    await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
    expect(api.outfitLifecycleControl.writes).toHaveLength(1);
  });
}
test('TRASH1 transient outfit conflict resumes same confirmed intent, running try-on blocks clothes', async ({ page }) => {
  const { api, outfitId } = await batchSetup(page);
  api.outfitLifecycleControl.scripts.push({ mode: 'error', status: 400, body: { code: '22023', message: 'Request conflict' } });
  await confirmBatch(page);
  await expect(progress(page)).toContainText(messages['outfitTrash.notSaved'].en);
  expect(api.outfitLifecycleControl.writes).toHaveLength(1);
  api.tryonControl.chains.push({ id: randomUUID(), owner: owners.a, outfitId: outfitId!, steps: [], nextStep: 1, state: 'running', resultId: null, expiresAtMs: Date.now() + 60000 });
  await progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true }).click();
  await expect(progress(page)).toContainText(messages['outfitTrash.busy'].en);
  expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
  api.tryonControl.chains[0]!.expiresAtMs = Date.now() - 1;
  await progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true }).click();
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
  expect(api.outfitLifecycleControl.writes.map(write => write.body.p_id)).toEqual([outfitId, outfitId, outfitId]);
  await expect(batchDialog(page)).toHaveCount(0);
});
for (const navigation of ['back-write', 'back-check', 'tab-write', 'back-clothes'] as const) {
  test(`TRASH1 ${navigation} commits navigation and stops all later targets`, async ({ page }, info) => {
    expect(info.retry).toBe(0);
    const { api } = await batchSetup(page, 'en', 2, navigation !== 'back-clothes');
    const dispatches: string[] = [];
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'DELETE' || /\/(prepare_item_deletion|inventory_item_deletion|authorize_item_deletion|begin_prepared_item_deletion|finish_item_deletion|delete_trashed_outfit)$/.test(pathname))
        dispatches.push(pathname);
    });
    let held: Route | null = null;
    if (navigation === 'back-check') {
      await page.route('**/rest/v1/rpc/delete_trashed_outfit', async route => { api.outfitControl.readFailures = 100; await route.fallback(); });
      api.outfitLifecycleControl.scripts.push({ mode: 'committedLost' });
      await confirmBatch(page);
      await expect(progress(page).getByRole('alert')).toContainText(messages['emptyTrash.checkFirst'].en);
      api.outfitControl.readFailures = 0;
      await page.route(url => url.pathname === '/rest/v1/outfits' && url.searchParams.has('id'), async route => {
        if (!held) held = route; else await route.fallback();
      });
      await progress(page).getByRole('button', { name: messages['lifecycle.check'].en, exact: true }).click();
    } else {
      await page.route(navigation === 'back-clothes' ? '**/rest/v1/rpc/prepare_item_deletion' : '**/rest/v1/rpc/delete_trashed_outfit',
        async route => { if (!held) held = route; else await route.fallback(); });
      await confirmBatch(page);
    }
    await expect.poll(() => held !== null).toBe(true);
    const before = [...dispatches];
    // Row locks must span pre-reads, outfit settlement and garment calls, not just the hook busy flag.
    await expect(page.locator('.trash-list').first().getByRole('button', { name: messages['trash.restore'].en, exact: true }).first()).toBeDisabled();
    if (navigation === 'tab-write') await page.getByRole('navigation').getByRole('link', { name: messages['nav.outfits'].en, exact: true }).click();
    else await page.goBack();
    if (navigation !== 'back-clothes') await expect(page.locator('#trash-title')).toBeVisible();
    await held!.fallback();
    await expect(page.locator(navigation === 'tab-write' ? '#outfits-title' : '#wardrobe-title')).toBeVisible();
    await trashPage(page);
    await expect(progress(page)).toContainText(messages['emptyTrash.paused'].en);
    expect(dispatches).toEqual(before);
    expect(api.deletionOperations.filter(value => value.receipt.phase === 'completed')).toHaveLength(0);
    expect(api.requests.some(call => call.method === 'DELETE')).toBe(false);
  });
}
test('TRASH1 row actions stay locked between outfit settlement and clothing pre-read', async ({ page }) => {
  const { api } = await batchSetup(page);
  await page.locator('#empty-trash-button').click(); await expect(batchDialog(page)).toBeVisible();
  let held: Route | null = null;
  await page.route('**/rest/v1/rpc/item_deletion_status', async route => { if (!held) held = route; else await route.fallback(); });
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true }).click();
  await expect.poll(() => held !== null).toBe(true);
  expect(api.outfitLifecycleControl.writes).toHaveLength(1);
  await expect(page.locator('.trash-list').first().getByRole('button', { name: messages['trash.restore'].en, exact: true })).toBeDisabled();
  await expect(page.locator('.trash-list').first().getByRole('button', { name: messages['deletion.prepare'].en, exact: true })).toBeDisabled();
  expect(api.deletionOperations).toHaveLength(0);
  await held!.fallback();
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
});
test('TRASH1 known cleanup blockers prevent destructive consent without silently excluding items', async ({ page }) => {
  const { api, clothes } = await batchSetup(page);
  api.files.set(`${owners.a}/${clothes[0]!.item.id}/unsafe name.jpg`, api.fixture);
  await page.locator('#empty-trash-button').click();
  await expect(batchDialog(page)).toContainText(messages['emptyTrash.blocked'].en);
  await expect(batchDialog(page)).toContainText(messages['deletion.blocked'].en);
  await expect(batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true })).toBeDisabled();
  expect(api.outfitLifecycleControl.writes).toHaveLength(0);
  expect(api.deletionOperations).toHaveLength(0);
  await page.keyboard.press('Escape');
});
test('TRASH1 double consent clicks dispatch once; no-op empty and offline never authorize', async ({ page }) => {
  const { api } = await batchSetup(page);
  await page.context().setOffline(true); await expect(page.locator('#empty-trash-button')).toBeDisabled();
  await page.context().setOffline(false);
  await page.locator('#empty-trash-button').click();
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true })
    .evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
  expect(api.outfitLifecycleControl.writes).toHaveLength(1);
  expect(api.deletionOperations).toHaveLength(1);
  await progress(page).getByRole('button', { name: messages['common.close'].en, exact: true }).click();
  await expect(page.locator('#empty-trash-button')).toBeEnabled();
  await page.locator('#empty-trash-button').click();
  await expect(page.locator('#empty-trash-button')).toBeEnabled();
  await expect(batchDialog(page)).toHaveCount(0);
  expect(api.outfitLifecycleControl.writes).toHaveLength(1); expect(api.deletionOperations).toHaveLength(1);
});
test('TRASH1 full reload requires new remaining-only consent and resumes durable receipts without repeat DELETE', async ({ page }) => {
  const { api } = await batchSetup(page, 'en', 1, true, { lifecycleLoss: 'delete' });
  await confirmBatch(page);
  await expect(progress(page).getByRole('alert')).toContainText(messages['lifecycle.unconfirmed'].en);
  expect(api.outfitLifecycleControl.writes).toHaveLength(1);
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(1);
  await page.reload(); await expect(page.locator('#trash-title')).toBeVisible();
  await expect(page.locator('.empty-trash-progress')).toHaveCount(0);
  expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(1);
  await page.locator('#empty-trash-button').click();
  await expect(batchDialog(page)).toContainText('1 item'); await expect(batchDialog(page)).toContainText('0 outfits');
  await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true }).click();
  await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
  const paths = api.requests.filter(call => call.method === 'DELETE').map(call => call.path);
  expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(2);
});
for (const existing of [false, true]) {
  test(`TRASH1 repair legacy claim with existing prepared operation ${existing}`, async ({ page }) => {
    const { api, clothes } = await batchSetup(page, 'en', 1, false);
    const item = clothes[0]!.item, itemId = String(item.id), requestId = randomUUID();
    const expectedVersion = Number(item.version);
    api.deletionClaims.set(itemId, { request_id: requestId, expected_version: expectedVersion, started_at: new Date().toISOString() });
    item.version = expectedVersion + 1;
    await page.locator('.trash-page .page-heading').getByRole('button', { name: messages['common.refresh'].en, exact: true }).click();
    const rowCheck = page.locator('.trash-list').first().getByRole('button', { name: messages['lifecycle.check'].en, exact: true });
    await expect(rowCheck).toBeEnabled();
    if (existing) {
      await rowCheck.click();
      await expect(page.locator('dialog[aria-labelledby="delete-item-heading"]')).toBeVisible();
      expect(api.deletionOperations[0]?.receipt).toMatchObject({ phase: 'prepared', expectedVersion: expectedVersion + 1,
        begin: { request_id: requestId, expected_version: expectedVersion, version: expectedVersion + 1 } });
      await page.reload(); await expect(page.locator('#trash-title')).toBeVisible();
    }
    const preparedBefore = api.requests.filter(call => call.path.endsWith('/prepare_item_deletion')).length;
    await confirmBatch(page);
    await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
    expect(api.deletionOperations).toHaveLength(1);
    expect(api.deletionOperations[0]?.receipt).toMatchObject({ requestId, itemId, phase: 'completed' });
    expect(api.requests.filter(call => call.path.endsWith('/prepare_item_deletion'))).toHaveLength(preparedBefore + (existing ? 0 : 1));
    const deletes = api.requests.filter(call => call.method === 'DELETE').map(call => call.path);
    expect(deletes).toHaveLength(2); expect(new Set(deletes).size).toBe(2);
  });
}
for (const individual of ['prepare', 'finish', 'restore', 'restore-unknown', 'outfit', 'outfit-unknown'] as const) {
  test(`TRASH1 repair paused controls serialize an individual ${individual}`, async ({ page }) => {
    const { api, clothes, active } = await batchSetup(page, 'en', 1, false, individual === 'restore-unknown' ? { lifecycleLoss: 'change' } : {});
    const batchId = String(clothes[0]!.item.id);
    await page.locator('#empty-trash-button').click(); await expect(batchDialog(page)).toBeVisible();
    const other = api.seedSavedItem('a', 'Independent shirt'); other.item.deleted_at = new Date().toISOString();
    const otherId = String(other.item.id);
    if (individual.startsWith('outfit')) seedTrashOutfit(api, String(active.item.id), 'Independent outfit', new Date(Date.now() - 60_000).toISOString());
    let conflict = true;
    await page.route('**/rest/v1/rpc/authorize_item_deletion', async route => {
      if (conflict && route.request().postDataJSON().p_item_id === batchId) {
        conflict = false; await route.fulfill({ status: 400, json: { code: '22023', message: 'Request conflict' } });
      } else await route.fallback();
    });
    await batchDialog(page).getByRole('button', { name: messages['emptyTrash.action'].en, exact: true }).click();
    const controls = [
      progress(page).getByRole('button', { name: messages['lifecycle.check'].en, exact: true }),
      progress(page).getByRole('button', { name: messages['lifecycle.resume'].en, exact: true }),
      progress(page).getByRole('button', { name: messages['deletion.cancel'].en, exact: true }),
    ];
    for (const control of controls) await expect(control).toBeEnabled();
    const ownOperation = api.deletionOperations.find(operation => operation.receipt.itemId === batchId)!;
    const original = structuredClone(ownOperation.receipt);
    const otherRow = page.locator('.trash-list li').filter({ has: page.getByRole('heading', { name: 'Independent shirt', exact: true }) });
    let held: Route | null = null;
    const heldRpc = individual.startsWith('outfit') ? 'set_outfit_trashed'
      : individual.startsWith('restore') ? 'set_item_trashed' : individual === 'finish' ? 'authorize_item_deletion' : 'prepare_item_deletion';
    await page.route(`**/rest/v1/rpc/${heldRpc}`, async route => {
      const body = route.request().postDataJSON();
      if (!held && (individual.startsWith('outfit') || body.p_item_id === otherId)) held = route;
      else await route.fallback();
    });
    if (individual.startsWith('outfit')) {
      if (individual === 'outfit-unknown') {
        api.outfitLifecycleControl.scripts.push({ mode: 'committedLost' });
      }
      await page.locator('.outfit-trash .trash-list li').filter({ has: page.getByRole('heading', { name: 'Independent outfit', exact: true }) })
        .getByRole('button', { name: messages['trash.restore'].en, exact: true }).click();
    } else if (individual.startsWith('restore')) {
      await otherRow.getByRole('button', { name: messages['trash.restore'].en, exact: true }).click();
    } else {
      await otherRow.getByRole('button', { name: messages['deletion.prepare'].en, exact: true }).click();
      if (individual === 'finish') {
        const dialog = page.locator('dialog[aria-labelledby="delete-item-heading"]');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
      }
    }
    await expect.poll(() => held !== null).toBe(true);
    for (const control of controls) await expect(control).toBeDisabled();
    expect(ownOperation.receipt).toEqual(original);
    expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(0);
    if (individual === 'outfit-unknown') api.outfitControl.readFailures = 100;
    await held!.fallback();
    if (individual === 'prepare') {
      const dialog = page.locator('dialog[aria-labelledby="delete-item-heading"]');
      await expect(dialog).toBeVisible();
      for (const control of controls) await expect(control).toBeDisabled();
      await dialog.getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => api.deletionOperations.find(operation => operation.receipt.itemId === otherId)?.receipt.phase).toBe('cancelled');
    } else if (individual === 'outfit-unknown') {
      const globalCheck = page.locator('.notice-error').getByRole('button', { name: messages['lifecycle.check'].en, exact: true });
      await expect(globalCheck).toBeEnabled();
      for (const control of controls) await expect(control).toBeDisabled();
      expect(ownOperation.receipt).toEqual(original);
      api.outfitControl.readFailures = 0;
      await globalCheck.click(); await expect(globalCheck).toHaveCount(0);
    } else if (individual === 'finish') {
      await expect(page.locator('.lifecycle-resume')).toHaveCount(0);
      expect(api.deletionOperations.find(operation => operation.receipt.itemId === otherId)?.receipt.phase).toBe('completed');
    } else if (individual === 'restore-unknown') {
      await expect(page.locator('.trash-page > .notice-error')).toBeVisible();
      const restoreCheck = page.locator('.trash-page > button').filter({ hasText: messages['lifecycle.check'].en });
      await expect(restoreCheck).toBeEnabled();
      for (const control of controls) await expect(control).toBeDisabled();
      expect(ownOperation.receipt).toEqual(original);
      await restoreCheck.click(); await expect(restoreCheck).toHaveCount(0);
      await expect(otherRow).toHaveCount(0); expect(other.item.deleted_at).toBeNull();
      expect(api.trashControl.calls).toHaveLength(1);
    } else if (individual === 'restore') {
      await expect(otherRow).toHaveCount(0); expect(other.item.deleted_at).toBeNull();
    } else {
      await expect(page.locator('.outfit-trash .trash-list li')).toHaveCount(0);
    }
    for (const control of controls) await expect(control).toBeEnabled();
    const beforeCheck = api.requests.filter(call => call.method === 'DELETE').length;
    await controls[0]!.click();
    await expect(controls[1]!).toBeEnabled();
    expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(beforeCheck);
    expect(ownOperation.receipt).toEqual(original);
    if (individual === 'prepare') {
      await controls[2]!.click();
      await expect.poll(() => ownOperation.receipt.phase).toBe('cancelled');
      expect(api.requests.filter(call => call.method === 'DELETE')).toHaveLength(0);
    } else {
      await controls[1]!.click();
      await expect(progress(page)).toContainText(messages['emptyTrash.finished'].en);
      expect(ownOperation.receipt.phase).toBe('completed');
      const paths = api.requests.filter(call => call.method === 'DELETE').map(call => call.path);
      expect(paths).toHaveLength(individual === 'finish' ? 4 : 2); expect(new Set(paths).size).toBe(paths.length);
      expect(api.items.some(row => row.id === otherId)).toBe(individual !== 'finish');
    }
  });
}
test('account-menu Trash navigation remains unique alongside the Undo notice link', async ({ page }) => {
  const { item } = await setup(page);
  await move(page, item.id);
  await openAccountMenu(page, 'en');
  await expect(page.getByRole('link', { name: messages['nav.trash'].en, exact: true })).toHaveCount(2);
  await expect(page.locator('.lifecycle-undo').getByRole('link', { name: messages['nav.trash'].en, exact: true })).toBeVisible();
  await expect(page.locator('.account-popover').getByRole('link', { name: messages['nav.trash'].en, exact: true })).toBeVisible();
  await closeAccountMenu(page);
  await trashPage(page);
  await expect(page.locator('.trash-list li')).toHaveCount(1);
});
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`lifecycle ${language}: dirty sections, exact Undo and server Restore preserve saved fields`, async ({ page }) => {
    const { api, item, image, peer } = await setup(page, language);
    const original = structuredClone(item), other = structuredClone(peer);
    await page.locator(`a[href="#/items/${item.id}"]`).click();
    await editItem(page);
    await page.locator('#detail-title').fill('Edited saved shirt');
    await expect(button(page, 'item.trash', language)).toBeDisabled();
    await button(page, 'detail.saveChanges', language).click();
    await expect(button(page, 'item.trash', language)).toBeEnabled();
    await editItem(page);
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
  // UX2: the item opens as a view card; its Edit stays locked while the Trash result is unknown.
  await expect(page.locator('#detail-edit')).toBeDisabled();
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
  await codePreloaded(page);
  await context.setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await trashPage(page);
  await expect(button(page, 'common.refresh')).toBeDisabled();
  await expect(page.locator('.trash-list li')).toHaveCount(0);
  expect(api.requests.some(request => request.path.endsWith('/item_deletion_status'))).toBe(false);
  await context.setOffline(false);
  await expect(page.locator('.trash-list li')).toHaveCount(40);
  await button(page, 'wardrobe.more').click(); await expect(page.locator('.trash-list li')).toHaveCount(41);
  const displayed = await page.locator('.trash-page > .trash-list h3').allTextContents();
  expect([...displayed].sort()).toEqual(Array.from({ length: 41 }, (_, n) => `Fictional trash ${n}`).sort());
  const reads = api.requests.filter(request => request.path.endsWith('/item_deletion_status')).length;
  await context.setOffline(true);
  await expect(button(page, 'common.refresh')).toBeDisabled();
  await context.setOffline(false);
  await expect(button(page, 'common.refresh')).toBeEnabled();
  await page.waitForTimeout(250);
  await expect(page.locator('.trash-page > .trash-list h3')).toHaveText(displayed);
  expect(api.requests.filter(request => request.path.endsWith('/item_deletion_status'))).toHaveLength(reads);
  await button(page, 'common.refresh').click();
  await expect(page.locator('.trash-list li')).toHaveCount(40);
  const peerTrash = api.seedSavedItem('b', 'Robin trash');
  peerTrash.item.deleted_at = new Date().toISOString();
  await openAccountMenu(page, 'en'); await button(page, 'auth.signOut').click();
  await signIn(page, 'b');
  await expect(page.locator('#trash-title')).toBeVisible();
  await expect(page.locator('.trash-page > .trash-list h3')).toHaveText(['Robin trash']);
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
      await openAccountMenu(page, 'en'); await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await closeAccountMenu(page);
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
