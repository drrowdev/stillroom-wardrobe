import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const navLink = (page: Page, key: 'nav.wardrobe' | 'nav.outfits', language: Language = 'en') =>
  page.locator('.workspace-header nav').getByRole('link', { name: text(key, language), exact: true });
const leaveDialog = (page: Page) => page.locator('dialog[aria-labelledby="outfit-leave-title"]');
const form = (page: Page) => page.locator('form.outfit-editor');

function saves(page: Page) {
  const bodies: Row[] = [], rereads: string[] = [], writes: string[] = [], order: ('save' | 'reread')[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:54321') return;
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()) && url.pathname !== '/auth/v1/token') writes.push(url.pathname);
    if (url.pathname === '/rest/v1/rpc/save_outfit' && request.method() === 'POST') { bodies.push(request.postDataJSON() as Row); order.push('save'); }
    if (url.pathname === '/rest/v1/outfits' && request.method() === 'GET' && url.searchParams.has('id')) { rereads.push(url.searchParams.get('id')!); order.push('reread'); }
  });
  return { bodies, rereads, writes, order };
}
const refocus = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
function seedClothes(api: Api) {
  const top = api.seedSavedItem('a', 'Olive overshirt');
  const trousers = api.seedSavedItem('a', 'Navy trousers');
  Object.assign(trousers.item as Row, { category: 'bottom', colours: ['navy'], created_at: '2026-09-09T00:00:01Z' });
  const shoes = api.seedSavedItem('a', 'White trainers');
  Object.assign(shoes.item as Row, { category: 'footwear', colours: ['white'], created_at: '2026-09-09T00:00:02Z' });
  const peer = api.seedSavedItem('b', 'Robin private');
  return { top: top.item, trousers: trousers.item, shoes: shoes.item, peer: peer.item };
}
function seedOutfit(api: Api, itemIds: string[], extra: Row = {}, account: 'a' | 'b' = 'a') {
  const id = randomUUID(), owner = owners[account], now = new Date(Date.now() - 60000).toISOString();
  api.outfits.push({ id, owner_id: owner, title: 'Weekend', occasion: 'everyday', notes: '', favourite: false, deleted_at: null, version: 1, created_at: now, updated_at: now, ...extra });
  itemIds.forEach((itemId, position) => api.outfitItems.push({ owner_id: owner, outfit_id: id, item_id: itemId, position }));
  return id;
}
async function start(page: Page, language: Language = 'en', seed?: (api: Api, clothes: ReturnType<typeof seedClothes>) => void, hash = '') {
  const api = await mockBackend(page, { initialLanguage: language });
  const clothes = seedClothes(api);
  seed?.(api, clothes);
  await page.goto(`/${hash}`); await signIn(page);
  await expect(page.locator('.workspace-identity')).toBeVisible();
  return { api, clothes };
}
async function openOutfits(page: Page, language: Language = 'en') {
  await navLink(page, 'nav.outfits', language).click();
  await expect(page.locator('#outfits-title')).toBeFocused();
}
async function newOutfit(page: Page, language: Language = 'en') {
  await openOutfits(page, language);
  await button(page, 'outfits.create', language).first().click();
  await expect(page.locator('#outfit-editor-title')).toBeFocused();
  await expect(page.locator('.outfit-choice')).toHaveCount(3);
}
const choose = (page: Page, name: string, language: Language = 'en') =>
  page.getByRole('button', { name: text('a11y.selectItem', language, { name }), exact: true }).click();
async function fillNew(page: Page, name = 'Friday', language: Language = 'en') {
  await newOutfit(page, language);
  await page.locator('#outfit-name').fill(name);
  await choose(page, 'Olive overshirt', language); await choose(page, 'Navy trousers', language);
}
async function startEdit(page: Page, id: string, language: Language = 'en') {
  await openOutfits(page, language);
  await page.locator(`a[href="#/outfits/${id}"]`).click();
  await expect(page.locator('#outfit-detail-title')).toBeFocused();
  await button(page, 'outfits.edit', language).click();
  await expect(page.locator('#outfit-name')).toBeFocused();
}
async function saveOnce(page: Page, language: Language = 'en') {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/rest/v1/rpc/save_outfit' && value.request().method() === 'POST');
  await button(page, 'outfits.saveOutfit', language).click();
  await response;
}

test('I11 creates, orders and names an outfit, then shows it in the list and on its own page', async ({ page }) => {
  const { api, clothes } = await start(page);
  const log = saves(page);
  await openOutfits(page);
  await expect(page.getByText(text('outfits.empty'), { exact: true })).toBeVisible();
  await button(page, 'outfits.create').click();
  await expect(page).toHaveURL(/#\/outfits\/new$/);
  await expect(page.locator('#outfit-editor-title')).toHaveText(text('outfits.newTitle'));
  await choose(page, 'Olive overshirt'); await choose(page, 'White trainers');
  await expect(page.getByRole('button', { name: text('a11y.selectItem', 'en', { name: 'Olive overshirt' }) })).toHaveAttribute('aria-pressed', 'true');
  const slots = page.locator('.outfit-slot');
  await expect(slots).toHaveCount(2);
  await expect(slots.nth(1)).toContainText(text('outfits.meta', 'en', { category: text('categoryOne.footwear'), colour: text('colour.white') }));
  const down = page.getByRole('button', { name: text('a11y.moveDown', 'en', { name: 'Olive overshirt' }), exact: true });
  await down.focus(); await down.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: text('outfits.moved', 'en', { name: 'Olive overshirt', position: 2 }) })).toBeAttached();
  await expect(page.getByRole('button', { name: text('a11y.moveUp', 'en', { name: 'Olive overshirt' }), exact: true })).toBeFocused();
  await expect(slots.nth(0)).toContainText('White trainers');
  await page.locator('#outfit-name').fill('  Friday  ');
  await page.getByText(text('item.moreDetails'), { exact: true }).click();
  await page.locator('#outfit-occasion').selectOption('smart');
  await page.locator('#outfit-notes').fill('Dinner');
  await page.getByLabel(text('item.favourite'), { exact: true }).check();
  expect(log.bodies).toHaveLength(0);
  await saveOnce(page);
  await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
  await expect(page.getByRole('status').filter({ hasText: text('outfits.saved') })).toBeVisible();
  expect(log.bodies).toHaveLength(1);
  const body = log.bodies[0]!;
  expect(Object.keys(body).sort()).toEqual(['p_favourite', 'p_id', 'p_item_ids', 'p_notes', 'p_occasion', 'p_title']);
  expect(body).toMatchObject({ p_title: 'Friday', p_occasion: 'smart', p_notes: 'Dinner', p_favourite: true, p_item_ids: [clothes.shoes.id, clothes.top.id] });
  expect(page.url()).toContain(`#/outfits/${String(body.p_id)}`);
  const composition = page.getByRole('list', { name: text('outfits.composition', 'en', { name: 'Friday' }) });
  await expect(composition.getByRole('listitem')).toHaveCount(2);
  await expect(composition.getByRole('listitem').nth(0)).toContainText('White trainers');
  await expect(page.locator('.outfit-facts')).toContainText(text('occasion.smart'));
  await expect(page.locator('.outfit-facts')).toContainText('Dinner');
  await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
  await button(page, 'outfits.back').click();
  await expect(page.locator('.outfit-card')).toHaveCount(1);
  await expect(page.locator('.outfit-card')).toContainText('Friday');
  await expect(page.locator('.outfit-card')).toContainText('2 items');
  await expect(page.locator('.outfit-card')).toContainText(text('occasion.smart'));
  expect(api.outfits).toHaveLength(1);
  expect(api.outfitItems.map(link => [link.item_id, link.position])).toEqual([[clothes.shoes.id, 0], [clothes.top.id, 1]]);
  for (const call of api.requests.filter(value => value.path === '/rest/v1/outfits' || value.path === '/rest/v1/rpc/save_outfit')) {
    if (call.method !== 'OPTIONS') expect(call.owner).toBe(owners.a);
  }
});

test('I11 checks the outfit only when Save is pressed and never sends an invalid one', async ({ page }) => {
  const { api } = await start(page);
  const log = saves(page);
  await newOutfit(page);
  await expect(page.locator('.field-error')).toHaveCount(0);
  await button(page, 'outfits.saveOutfit').click();
  await expect(page.locator('#outfit-name-error')).toHaveText(text('outfits.nameRequired'));
  await expect(page.locator('#outfit-items-error')).toHaveText(text('outfits.chooseAtLeastOne'));
  await expect(page.locator('#outfit-name')).toBeFocused();
  await page.locator('#outfit-name').fill('x'.repeat(101));
  await choose(page, 'Olive overshirt');
  await expect(page.locator('#outfit-name-error')).toHaveText(text('outfits.nameTooLong'));
  await page.locator('#outfit-name').fill('Rainy day');
  await page.getByText(text('item.moreDetails'), { exact: true }).click();
  await page.locator('#outfit-notes').fill('n'.repeat(2001));
  await page.getByText(text('item.moreDetails'), { exact: true }).click();
  await button(page, 'outfits.saveOutfit').click();
  await expect(page.locator('#outfit-notes')).toBeFocused();
  await expect(page.locator('#outfit-notes-error')).toHaveText(text('outfits.notesTooLong'));
  expect(log.bodies).toHaveLength(0);
  expect(api.outfits).toHaveLength(0);
});

test('I11 limits an outfit to twelve items and shows the limit only when it is reached', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  for (let n = 1; n <= 13; n++) api.seedSavedItem('a', `Item ${String(n).padStart(2, '0')}`);
  await page.goto('/'); await signIn(page);
  await openOutfits(page);
  await button(page, 'outfits.create').click();
  await expect(page.locator('.outfit-choice')).toHaveCount(13);
  await expect(page.getByText(text('outfits.limit'))).toHaveCount(0);
  for (let n = 1; n <= 12; n++) await choose(page, `Item ${String(n).padStart(2, '0')}`);
  await expect(page.locator('.outfit-slot')).toHaveCount(12);
  await choose(page, 'Item 13');
  await expect(page.getByRole('alert').filter({ hasText: text('outfits.limit') })).toBeVisible();
  await expect(page.locator('.outfit-slot')).toHaveCount(12);
  await page.getByRole('button', { name: text('a11y.removeItem', 'en', { name: 'Item 01' }), exact: true }).click();
  await expect(page.getByText(text('outfits.limit'))).toHaveCount(0);
  await expect(page.locator('.outfit-slot')).toHaveCount(11);
});

test('I11 edits an outfit from its page with the version it was loaded at', async ({ page }) => {
  let id = '';
  const { api, clothes } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id, clothes.trousers.id]); });
  const log = saves(page);
  await startEdit(page, id);
  await expect(page.locator('#outfit-name')).toHaveValue('Weekend');
  await page.locator('#outfit-name').fill('Long weekend');
  await page.getByRole('button', { name: text('a11y.removeItem', 'en', { name: 'Olive overshirt' }), exact: true }).click();
  await expect(page.getByRole('button', { name: text('a11y.removeItem', 'en', { name: 'Navy trousers' }), exact: true })).toBeFocused();
  await choose(page, 'White trainers');
  await saveOnce(page);
  await expect(page.locator('#outfit-detail-title')).toHaveText('Long weekend');
  await expect(page.locator('#outfit-detail-title')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: text('outfits.saved') })).toBeVisible();
  expect(log.bodies).toHaveLength(1);
  expect(log.bodies[0]).toMatchObject({ p_id: id, p_expected_version: 1, p_title: 'Long weekend', p_item_ids: [clothes.trousers.id, clothes.shoes.id] });
  expect(api.outfits[0]).toMatchObject({ version: 2, title: 'Long weekend' });
  await expect(button(page, 'outfits.edit')).toBeVisible();
});

test('I11 keeps trashed and archived items in place and reports deleted ones without guessing', async ({ page }) => {
  let id = '', empty = '';
  await start(page, 'en', (api, clothes) => {
    Object.assign(clothes.top as Row, { deleted_at: new Date().toISOString() });
    Object.assign(clothes.trousers as Row, { lifecycle: 'archived' });
    id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id]);
    api.outfitItems.find(link => link.outfit_id === id && link.item_id === clothes.shoes.id)!.position = 3;
    empty = seedOutfit(api, [], { title: 'Nothing left' });
  });
  await openOutfits(page);
  await expect(page.locator(`a[href="#/outfits/${empty}"]`)).toContainText(text('outfits.noItems'));
  await page.locator(`a[href="#/outfits/${id}"]`).click();
  const composition = page.getByRole('list', { name: text('outfits.composition', 'en', { name: 'Weekend' }) });
  await expect(composition.getByRole('listitem')).toHaveCount(3);
  await expect(composition.getByRole('listitem').nth(0)).toContainText(text('outfits.inTrash'));
  await expect(composition.getByRole('listitem').nth(1)).toContainText(text('detail.archived'));
  await expect(page.getByText(text('outfits.itemsDeleted'), { exact: true })).toBeVisible();
  await button(page, 'outfits.back').click();
  await page.locator(`a[href="#/outfits/${empty}"]`).click();
  await expect(page.getByText(text('outfits.noItemsLeft'), { exact: true })).toBeVisible();
  await expect(button(page, 'outfits.edit')).toBeVisible();
});

test('I11 shows only the signed-in owner\'s outfits and treats another owner\'s outfit as unavailable', async ({ page }) => {
  let own = '', other = '';
  const { api } = await start(page, 'en', (api, clothes) => {
    own = seedOutfit(api, [clothes.top.id]);
    other = seedOutfit(api, [clothes.peer.id], { title: 'Robin outfit' }, 'b');
  });
  await openOutfits(page);
  await expect(page.locator('.outfit-card')).toHaveCount(1);
  await expect(page.locator(`a[href="#/outfits/${own}"]`)).toBeVisible();
  await expect(page.getByText('Robin outfit')).toHaveCount(0);
  await page.evaluate((hash) => { location.hash = hash; }, `#/outfits/${other}`);
  await expect(page.getByRole('alert').filter({ hasText: text('outfits.unavailable') })).toBeVisible();
  await expect(page.getByText('Robin outfit')).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#/outfits/not-an-id'; });
  await expect(page.getByRole('alert').filter({ hasText: text('outfits.unavailable') })).toBeVisible();
  for (const call of api.requests.filter(value => value.path === '/rest/v1/outfits' && value.method === 'GET')) {
    expect(call.owner).toBe(owners.a); expect(call.ownerFilter).toBe(`eq.${owners.a}`);
  }
});

test('I11 offers Add item when there are no clothes yet', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/'); await signIn(page);
  await openOutfits(page);
  await expect(page.getByText(text('outfits.noClothes'), { exact: true })).toBeVisible();
  await expect(button(page, 'outfits.create')).toHaveCount(0);
  await page.locator('.outfits-empty').getByRole('button', { name: text('wardrobe.add'), exact: true }).click();
  await expect(page).toHaveURL(/#\/items\/new$/);
});

test.describe('I11 unknown save results are settled by one read-only reread', () => {
  test('create committed but the reply was lost: saved with no second save', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'committedLost' };
    await saveOnce(page);
    await expect(button(page, 'common.saving')).toBeDisabled();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
    await expect(page.getByRole('status').filter({ hasText: text('outfits.saved') })).toBeVisible();
    expect(log.bodies).toHaveLength(1);
    expect(log.rereads.length).toBeGreaterThanOrEqual(1);
    expect(log.rereads[0]).toBe(`eq.${String(log.bodies[0]!.p_id)}`);
    expect(api.outfits).toHaveLength(1);
  });
  test('create not committed: not saved, then Try again resends the same outfit once', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'lost' };
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    expect(log.bodies).toHaveLength(1);
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
    expect(log.bodies).toHaveLength(2);
    expect(log.bodies[1]).toEqual(log.bodies[0]);
    expect(api.outfits).toHaveLength(1);
  });
  test('a transport failure is treated like an unknown result', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'transport' };
    await button(page, 'outfits.saveOutfit').click();
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    expect(log.bodies).toHaveLength(1);
    expect(log.rereads).toHaveLength(1);
  });
  test('edit committed but the reply was lost: saved at the next version with no second save', async ({ page }) => {
    let id = '';
    const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    const log = saves(page);
    await startEdit(page, id);
    await page.locator('#outfit-name').fill('Office');
    api.outfitControl.nextSave = { mode: 'committedLost' };
    await saveOnce(page);
    await expect(page.locator('#outfit-detail-title')).toHaveText('Office');
    expect(log.bodies).toHaveLength(1);
    expect(api.outfits[0]).toMatchObject({ version: 2, title: 'Office' });
  });
  test('edit not committed: Try again sends the same baseline version', async ({ page }) => {
    let id = '';
    const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    const log = saves(page);
    await startEdit(page, id);
    await page.locator('#outfit-name').fill('Office');
    api.outfitControl.nextSave = { mode: 'lost' };
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Office');
    expect(log.bodies).toHaveLength(2);
    expect(log.bodies[1]).toMatchObject({ p_expected_version: 1, p_title: 'Office' });
    expect(api.outfits[0]).toMatchObject({ version: 2 });
  });
  test('edit not committed, then changed elsewhere: Reload and nothing is overwritten', async ({ page }) => {
    let id = '';
    const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    const log = saves(page);
    await startEdit(page, id);
    await page.locator('#outfit-name').fill('Office');
    api.outfitControl.nextSave = { mode: 'lost' };
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    Object.assign(api.outfits[0]!, { title: 'Changed on phone', version: 2 });
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.changed') })).toBeVisible();
    await expect(page.locator('#outfit-name')).toHaveValue('Office');
    await expect(page.locator('#outfit-name')).toBeDisabled();
    await page.getByRole('alert').getByRole('button', { name: text('outfits.reload'), exact: true }).click();
    await expect(page.locator('#outfit-name')).toHaveValue('Changed on phone');
    expect(log.bodies).toHaveLength(2);
    expect(api.outfits[0]).toMatchObject({ version: 2, title: 'Changed on phone' });
  });
  for (const kind of ['create', 'edit'] as const) {
    test(`${kind}: a failed reread shows Still saving and Try again only rereads`, async ({ page }) => {
      let id = '';
      const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
      const log = saves(page);
      if (kind === 'create') await fillNew(page);
      else { await startEdit(page, id); await page.locator('#outfit-name').fill('Office'); }
      api.outfitControl.nextSave = { mode: 'lost' };
      api.outfitControl.readFailures = 1;
      const before = log.rereads.length;
      await saveOnce(page);
      await expect(page.getByRole('alert').filter({ hasText: text('outfits.stillSaving') })).toBeVisible();
      expect(log.rereads.length).toBe(before + 1);
      await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
      expect(log.rereads.length).toBe(before + 2);
      expect(log.bodies).toHaveLength(1);
    });
  }
  test('definitive rejections are shown without a reread', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'error', status: 403, body: { code: '42501', message: 'permission denied' } };
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSavedError') })).toBeVisible();
    expect(log.rereads).toHaveLength(0);
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
    expect(log.bodies[1]).toEqual(log.bodies[0]);
  });
  test('an invalid selection keeps the draft', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'error', status: 400, body: { code: 'P0001', message: 'Invalid selection' } };
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.invalidSelection') })).toBeVisible();
    await expect(page.locator('#outfit-name')).toHaveValue('Friday');
    await expect(page.locator('.outfit-slot')).toHaveCount(2);
    expect(log.rereads).toHaveLength(0);
  });
  test('a 5xx reply is unknown even when it carries a rejection code: reread before any resend', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'error', status: 503, body: { code: '42501', message: 'permission denied' } };
    await saveOnce(page);
    await expect(page.locator('#outfit-name')).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSavedError') })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    expect(log.order).toEqual(['save', 'reread']);
    await expect(page.locator('#outfit-name')).toHaveValue('Friday');
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
    expect(log.order.slice(0, 3)).toEqual(['save', 'reread', 'save']);
    expect(log.bodies[1]).toEqual(log.bodies[0]);
  });
  test('a reread that still fails with 503 after the client retries shows Still saving', async ({ page }) => {
    const { api } = await start(page);
    const log = saves(page);
    await fillNew(page);
    api.outfitControl.nextSave = { mode: 'lost' };
    api.outfitControl.readFailureStatus = 503;
    api.outfitControl.readFailures = 4;
    await saveOnce(page);
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.stillSaving') })).toBeVisible({ timeout: 15000 });
    expect(api.outfitControl.readFailures).toBe(0);
    expect(log.rereads).toHaveLength(4);
    await expect(page.locator('#outfit-name')).toHaveValue('Friday');
    await page.getByRole('alert').getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: text('outfits.notSaved') })).toBeVisible();
    expect(log.rereads).toHaveLength(5);
    expect(log.bodies).toHaveLength(1);
  });
});

test.describe('I11 an open editor survives a refresh that finds the outfit removed', () => {
  test('while the draft is dirty: the draft stays, locked, until the owner leaves', async ({ page }) => {
    let id = '';
    const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    const log = saves(page);
    await startEdit(page, id);
    await page.locator('#outfit-name').fill('Office');
    api.outfits[0]!.deleted_at = new Date().toISOString();
    await refocus(page);
    await expect(form(page).getByRole('alert').filter({ hasText: text('outfits.unavailable') })).toBeVisible();
    await expect(page.locator('#outfit-name')).toHaveValue('Office');
    await expect(page.locator('#outfit-name')).toBeDisabled();
    await expect(page.locator('.outfit-slot')).toHaveCount(1);
    await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
    await navLink(page, 'nav.wardrobe').click();
    await expect(leaveDialog(page)).toContainText(text('outfits.discardBody'));
    await leaveDialog(page).getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(page.locator('#outfit-name')).toHaveValue('Office');
    await form(page).getByRole('alert').getByRole('button', { name: text('outfits.back'), exact: true }).click();
    await expect(leaveDialog(page)).toContainText(text('outfits.discardBody'));
    await leaveDialog(page).getByRole('button', { name: text('outfits.leave'), exact: true }).click();
    await expect(page.locator('#outfits-title')).toBeVisible();
    expect(log.bodies).toHaveLength(0);
  });
  test('while a save result is unknown: the attempt stays frozen and its reread reports the removal', async ({ page }) => {
    let id = '';
    const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    const log = saves(page);
    await startEdit(page, id);
    await page.locator('#outfit-name').fill('Office');
    api.outfitControl.nextSave = { mode: 'lost' };
    await saveOnce(page);
    api.outfits[0]!.deleted_at = new Date().toISOString();
    await refocus(page);
    await navLink(page, 'nav.wardrobe').click();
    await expectLeaveWording(page, 'en');
    await expect(page.locator('#outfit-name')).toHaveValue('Office');
    await leaveDialog(page).getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(form(page).getByRole('alert').filter({ hasText: text('outfits.unavailable') })).toBeVisible();
    await expect(page.locator('#outfit-name')).toHaveValue('Office');
    await expect(page.locator('#outfit-name')).toBeDisabled();
    expect(log.bodies).toHaveLength(1);
    expect(api.outfitControl.saves).toBe(1);
  });
});

test.describe('I11 selected garments keep current labels after leaving the picker', () => {
  for (const kind of ['create', 'edit'] as const) {
    test(`${kind}: archive, trash and restore a selected garment elsewhere`, async ({ page }) => {
      let id = '';
      const { clothes } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
      const log = saves(page);
      if (kind === 'create') await fillNew(page);
      else { await startEdit(page, id); await page.locator('#outfit-name').fill('Office'); await choose(page, 'Navy trousers'); }
      const picked = clothes.trousers as Row;
      const slot = page.locator('.outfit-slot').filter({ hasText: 'Navy trousers' });
      const choice = page.getByRole('button', { name: text('a11y.selectItem', 'en', { name: 'Navy trousers' }), exact: true });
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      picked.lifecycle = 'archived'; await refocus(page);
      await expect(slot).toContainText(text('detail.archived'));
      await expect(choice).toHaveCount(0);
      picked.lifecycle = 'active'; picked.deleted_at = new Date().toISOString(); await refocus(page);
      await expect(slot).toContainText(text('outfits.inTrash'));
      await expect(page.getByText(text('outfits.unavailableItem'), { exact: true })).toHaveCount(0);
      picked.deleted_at = null; await refocus(page);
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await expect(slot).not.toContainText(text('outfits.inTrash'));
      picked.lifecycle = 'archived'; await refocus(page);
      await expect(slot).toContainText(text('detail.archived'));
      await expect(page.locator('#outfit-name')).toHaveValue(kind === 'create' ? 'Friday' : 'Office');
      await expect(page.locator('.outfit-slot')).toHaveCount(2);
      await saveOnce(page);
      await expect(page.locator('#outfit-detail-title')).toHaveText(kind === 'create' ? 'Friday' : 'Office');
      expect(log.bodies).toHaveLength(1);
      expect(log.bodies[0]).toMatchObject({ p_item_ids: [clothes.top.id, clothes.trousers.id], ...kind === 'edit' ? { p_expected_version: 1 } : {} });
    });
  }
});

test.describe('I11 outfits follow garment changes (F3)', () => {
  for (const dirty of [false, true]) {
    test(`a permanent garment delete while the editor is ${dirty ? 'dirty keeps the draft' : 'clean follows the saved outfit'}`, async ({ page }) => {
      let id = '';
      const { api, clothes } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id]); });
      const log = saves(page);
      await startEdit(page, id);
      await expect(page.locator('.outfit-slot')).toHaveCount(3);
      if (dirty) await page.locator('#outfit-name').fill('Long weekend');
      api.items.splice(api.items.findIndex(row => row.id === clothes.trousers.id), 1);
      api.outfitItems.splice(api.outfitItems.findIndex(link => link.item_id === clothes.trousers.id), 1);
      expect(api.outfits[0]).toMatchObject({ version: 1 });
      await refocus(page);
      if (dirty) {
        await expect(page.getByText(text('outfits.unavailableItem'), { exact: true })).toBeVisible();
        await expect(page.locator('.outfit-slot')).toHaveCount(3);
        await expect(page.locator('#outfit-name')).toHaveValue('Long weekend');
        expect(log.bodies).toHaveLength(0);
        return;
      }
      await expect(page.locator('.outfit-slot')).toHaveCount(2);
      await expect(page.getByText('Navy trousers')).toHaveCount(0);
      await expect(page.getByText(text('outfits.unavailableItem'), { exact: true })).toHaveCount(0);
      await page.locator('#outfit-name').fill('Long weekend');
      await saveOnce(page);
      await expect(page.locator('#outfit-detail-title')).toHaveText('Long weekend');
      expect(log.bodies).toHaveLength(1);
      expect(log.bodies[0]).toMatchObject({ p_id: id, p_expected_version: 1, p_item_ids: [clothes.top.id, clothes.shoes.id] });
    });
  }
  test('a replaced photo is requested on returning to outfits', async ({ page }) => {
    let id = '';
    const { api, clothes } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    await openOutfits(page);
    await expect(page.locator('.outfit-card img')).toHaveCount(1);
    await navLink(page, 'nav.wardrobe').click();
    const old = api.images.find(image => image.item_id === clothes.top.id)!;
    const imageId = randomUUID(), base = `${owners.a}/${String(clothes.top.id)}/${imageId}`;
    api.images.push({ ...old, id: imageId, created_at: '2026-09-10T00:00:00Z', main_path: `${base}/main.jpg`, thumb_path: `${base}/thumb.jpg` });
    old.state = 'retired'; old.retired_at = '2026-09-10T00:00:00Z';
    api.files.set(`${base}/main.jpg`, api.fixture); api.files.set(`${base}/thumb.jpg`, api.fixture);
    await openOutfits(page);
    await expect(page.locator('.outfit-card img')).toHaveCount(1);
    await expect.poll(() => api.requests.some(request => request.path === `/storage/v1/object/wardrobe/${base}/thumb.jpg`)).toBe(true);
    await page.locator(`a[href="#/outfits/${id}"]`).click();
    await expect(page.locator('.outfit-composition img')).toHaveCount(1);
  });
  test('archive, trash, restore and permanent deletion update labels and gaps on returning', async ({ page }) => {
    let id = '';
    const { api, clothes } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id]); });
    const item = (component: Row) => api.items.find(row => row.id === component.id)!;
    const composition = page.getByRole('list', { name: text('outfits.composition', 'en', { name: 'Weekend' }) });
    const visit = async () => {
      await navLink(page, 'nav.wardrobe').click();
      await expect(page.locator('#wardrobe-title')).toBeFocused();
      return async () => { await page.goBack(); await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend'); };
    };
    await openOutfits(page);
    await page.locator(`a[href="#/outfits/${id}"]`).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
    let back = await visit(); item(clothes.top).lifecycle = 'archived'; await back();
    await expect(composition.getByRole('listitem').nth(0)).toContainText(text('detail.archived'));
    back = await visit(); item(clothes.top).lifecycle = 'active'; item(clothes.top).deleted_at = new Date().toISOString(); await back();
    await expect(composition.getByRole('listitem').nth(0)).toContainText(text('outfits.inTrash'));
    back = await visit(); item(clothes.top).deleted_at = null; await back();
    await expect(composition.getByRole('listitem').nth(0)).not.toContainText(text('outfits.inTrash'));
    await expect(composition.getByRole('listitem').nth(0)).not.toContainText(text('detail.archived'));
    await expect(page.getByText(text('outfits.itemsDeleted'), { exact: true })).toHaveCount(0);
    back = await visit();
    api.items.splice(api.items.indexOf(item(clothes.trousers)), 1);
    api.outfitItems.splice(api.outfitItems.findIndex(link => link.item_id === clothes.trousers.id), 1);
    await back();
    await expect(page.getByText(text('outfits.itemsDeleted'), { exact: true })).toBeVisible();
    await expect(composition.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('Navy trousers')).toHaveCount(0);
    await button(page, 'outfits.back').click();
    await expect(page.locator(`a[href="#/outfits/${id}"]`)).toContainText('2 items');
  });
  test('missing and denied photos show the placeholder', async ({ page }) => {
    let id = '', denied = '';
    await start(page, 'en', (api, clothes) => {
      id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id]);
      api.files.delete(String(api.images.find(image => image.item_id === clothes.top.id)!.thumb_path));
      denied = String(api.images.find(image => image.item_id === clothes.trousers.id)!.thumb_path);
    });
    await page.route(url => url.pathname === `/storage/v1/object/wardrobe/${denied}`, route => route.fulfill({ status: 400, json: { statusCode: '403', message: 'Denied' } }));
    await openOutfits(page);
    await page.locator(`a[href="#/outfits/${id}"]`).click();
    const composition = page.locator('.outfit-composition');
    await expect(composition.locator('.photo-unavailable')).toHaveCount(2);
    await expect(composition.locator('.photo-unavailable').first()).toContainText(text('photo.missing'));
    await expect(composition.locator('img')).toHaveCount(1);
  });
  test('a held outfit response after a route change is ignored', async ({ page }) => {
    await start(page, 'en', (api, clothes) => { seedOutfit(api, [clothes.top.id]); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = 0;
    await page.route(url => url.pathname === '/rest/v1/outfits', async route => {
      held++; await gate; await route.fallback().catch(() => undefined);
    });
    await openOutfits(page);
    await expect.poll(() => held).toBe(1);
    await navLink(page, 'nav.wardrobe').click();
    await expect(page.locator('#wardrobe-title')).toBeFocused();
    release();
    await page.waitForTimeout(500);
    await expect(page.locator('#wardrobe-title')).toBeFocused();
    await expect(page.locator('.outfit-card')).toHaveCount(0);
    await expect(page.getByText('Weekend')).toHaveCount(0);
  });
  test('a held response for one account never renders after signing in as another', async ({ page }) => {
    await start(page, 'en', (api, clothes) => {
      seedOutfit(api, [clothes.top.id]);
      seedOutfit(api, [clothes.peer.id], { title: 'Robin outfit' }, 'b');
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = 0;
    const requested: (string | null)[] = [];
    await page.route(url => url.pathname === '/rest/v1/outfits', async route => {
      const payload = route.request().headers().authorization?.split(' ')[1]?.split('.')[1];
      requested.push(payload ? String((JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown }).sub) : null);
      if (++held === 1) await gate;
      await route.fallback().catch(() => undefined);
    });
    await openOutfits(page);
    await expect.poll(() => held).toBe(1);
    expect(requested).toEqual([owners.a]);
    await button(page, 'account.menu').click(); await button(page, 'auth.signOut').click();
    await signIn(page, 'b');
    await expect(page.locator('.workspace-identity')).toBeVisible();
    await navLink(page, 'nav.outfits').click();
    await expect(page.locator('.outfit-card')).toContainText('Robin outfit');
    release();
    await page.waitForTimeout(500);
    await expect(page.getByText('Weekend')).toHaveCount(0);
    await expect(page.locator('.outfit-card')).toHaveCount(1);
    expect(requested.slice(1).length).toBeGreaterThan(0);
    expect(requested.slice(1).every(owner => owner === owners.b)).toBe(true);
  });
  test('a deletion read race is reloaded once and then shows the gap', async ({ page }) => {
    let id = '', reads = 0;
    const { api, clothes } = await start(page, 'en', (api, clothes) => {
      id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id]);
      api.items.splice(api.items.indexOf(clothes.trousers as never), 1);
    });
    await page.route(url => url.pathname === '/rest/v1/outfits' && url.searchParams.has('id'), async route => {
      if (++reads === 2) api.outfitItems.splice(api.outfitItems.findIndex(link => link.item_id === clothes.trousers.id), 1);
      await route.fallback();
    });
    await page.evaluate((hash) => { location.hash = hash; }, `#/outfits/${id}`);
    await expect(page.getByText(text('outfits.itemsDeleted'), { exact: true })).toBeVisible();
    const composition = page.getByRole('list', { name: text('outfits.composition', 'en', { name: 'Weekend' }) });
    await expect(composition.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText(text('outfits.unavailableItem'), { exact: true })).toHaveCount(0);
    expect(reads).toBe(2);
  });
  test('a link that stays unreadable after one reload shows as unavailable and blocks Save until removed', async ({ page }) => {
    let id = '';
    const { api, clothes } = await start(page, 'en', (api, clothes) => {
      id = seedOutfit(api, [clothes.top.id, clothes.trousers.id]);
      api.items.splice(api.items.indexOf(clothes.trousers as never), 1);
    });
    const log = saves(page);
    await page.evaluate((hash) => { location.hash = hash; }, `#/outfits/${id}`);
    const composition = page.getByRole('list', { name: text('outfits.composition', 'en', { name: 'Weekend' }) });
    await expect(composition.getByRole('listitem').nth(1)).toContainText(text('outfits.unavailableItem'));
    expect(log.rereads).toHaveLength(2);
    await button(page, 'outfits.edit').click();
    await expect(page.locator('.outfit-slot').nth(1)).toContainText(text('outfits.unavailableItem'));
    await page.locator('#outfit-name').fill('Office');
    await button(page, 'outfits.saveOutfit').click();
    await expect(page.locator('#outfit-items-error')).toHaveText(text('outfits.removeUnavailable'));
    expect(log.bodies).toHaveLength(0);
    await page.getByRole('button', { name: text('a11y.removeItem', 'en', { name: text('outfits.unavailableItem') }), exact: true }).click();
    await saveOnce(page);
    await expect(page.locator('#outfit-detail-title')).toHaveText('Office');
    expect(log.bodies[0]).toMatchObject({ p_item_ids: [clothes.top.id], p_expected_version: 1 });
    expect(api.outfits[0]).toMatchObject({ version: 2 });
  });
});

test.describe('I11 header follows the committed route', () => {
  test('clicks, back and forward, and settings', async ({ page }) => {
    let id = '';
    await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
    await expect(navLink(page, 'nav.wardrobe')).toHaveAttribute('aria-current', 'page');
    await openOutfits(page);
    await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
    await expect(navLink(page, 'nav.outfits')).toHaveClass(/active-nav/);
    await expect(navLink(page, 'nav.wardrobe')).not.toHaveAttribute('aria-current', 'page');
    await page.locator(`a[href="#/outfits/${id}"]`).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
    await navLink(page, 'nav.wardrobe').click();
    await expect(page.locator('#wardrobe-title')).toBeFocused();
    await expect(navLink(page, 'nav.wardrobe')).toHaveAttribute('aria-current', 'page');
    await expect(navLink(page, 'nav.wardrobe')).toHaveClass(/active-nav/);
    await page.goBack();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
    await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await expect(navLink(page, 'nav.wardrobe')).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: text('account.menu'), exact: true }).click();
    await page.locator('.account-popover').getByRole('link', { name: text('nav.settings'), exact: true }).click();
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(page.locator('.workspace-header nav [aria-current]')).toHaveCount(0);
  });
  test('a direct load of an outfit page shows Outfits as current', async ({ page }) => {
    let id = '';
    await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); }, '');
    await page.evaluate((hash) => { history.replaceState(null, '', hash); }, `#/outfits/${id}`);
    await page.reload();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
    await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
  });
  test('a cancelled leave by click or by history keeps the editor and the header', async ({ page }) => {
    await start(page);
    await newOutfit(page);
    await page.locator('#outfit-name').fill('Draft');
    await navLink(page, 'nav.wardrobe').click();
    await expect(leaveDialog(page)).toContainText(text('outfits.discardBody'));
    await leaveDialog(page).getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/outfits\/new$/);
    await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(leaveDialog(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/outfits\/new$/);
    await leaveDialog(page).getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(page.locator('#outfit-name')).toHaveValue('Draft');
    await expect(navLink(page, 'nav.outfits')).toHaveAttribute('aria-current', 'page');
    await navLink(page, 'nav.wardrobe').click();
    await leaveDialog(page).getByRole('button', { name: text('outfits.leave'), exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await expect(navLink(page, 'nav.wardrobe')).toHaveAttribute('aria-current', 'page');
  });
});

const forbidden: MessageKey[] = ['aiC.cancelling', 'aiC.leaveWarning', 'aiC.leave', 'common.discard'];
const forbiddenWords = ['refund', 'cancellation', 'hyvitys', 'peruminen', 'återbetalning', 'avbrytning'];
async function expectLeaveWording(page: Page, language: Language) {
  const dialog = leaveDialog(page);
  await expect(dialog).toContainText(text('outfits.leaveUnresolved', language));
  await expect(dialog.getByRole('button', { name: text('common.continueEditing', language), exact: true })).toBeFocused();
  const content = (await dialog.innerText()).toLocaleLowerCase(language);
  for (const key of forbidden) for (const other of languages) expect(content).not.toContain(text(key, other).toLocaleLowerCase(language));
  for (const word of forbiddenWords) expect(content).not.toContain(word);
}

test.describe('I11 leaving while a save result is unknown (E1)', () => {
  for (const kind of ['create', 'edit'] as const) {
    for (const window of ['delay', 'offline'] as const) {
      test(`${kind}: leaving during the ${window === 'delay' ? 'one-second reread delay' : 'offline wait'} warns and sends nothing`, async ({ page, context }) => {
        let id = '';
        const { api } = await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id]); });
        const log = saves(page);
        if (kind === 'create') await fillNew(page);
        else { await startEdit(page, id); await page.locator('#outfit-name').fill('Office'); }
        api.outfitControl.nextSave = { mode: 'lost' };
        const rereadsBefore = log.rereads.length;
        await saveOnce(page);
        await expect(form(page)).toHaveAttribute('aria-busy', 'false');
        if (window === 'offline') {
          await context.setOffline(true);
          await page.waitForTimeout(1500);
          expect(log.rereads.length).toBe(rereadsBefore);
        }
        const writes = log.writes.length;
        await navLink(page, 'nav.wardrobe').click();
        await expectLeaveWording(page, 'en');
        await expect(leaveDialog(page)).not.toContainText(text('outfits.discardBody'));
        await leaveDialog(page).getByRole('button', { name: text('outfits.leave'), exact: true }).click();
        await expect(page.locator('#wardrobe-title')).toBeVisible();
        if (window === 'offline') await context.setOffline(false);
        await page.waitForTimeout(1500);
        expect(log.writes.length).toBe(writes);
        expect(log.bodies).toHaveLength(1);
        expect(log.rereads.length).toBe(rereadsBefore);
        expect(api.outfitControl.saves).toBe(1);
      });
    }
  }
  for (const language of languages) {
    test(`${language}: after a failed reread the leave dialog says the change may be saved`, async ({ page }) => {
      const { api } = await start(page, language);
      const log = saves(page);
      await fillNew(page, 'Friday', language);
      api.outfitControl.nextSave = { mode: 'lost' };
      api.outfitControl.readFailures = 1;
      await saveOnce(page, language);
      await expect(page.getByRole('alert').filter({ hasText: text('outfits.stillSaving', language) })).toBeVisible();
      await navLink(page, 'nav.wardrobe', language).click();
      await expectLeaveWording(page, language);
      await leaveDialog(page).getByRole('button', { name: text('common.continueEditing', language), exact: true }).click();
      await expect(page).toHaveURL(/#\/outfits\/new$/);
      await expect(page.locator('#outfit-name')).toHaveValue('Friday');
      await expect(navLink(page, 'nav.outfits', language)).toHaveAttribute('aria-current', 'page');
      const writes = log.writes.length;
      await page.goBack();
      await expectLeaveWording(page, language);
      await leaveDialog(page).getByRole('button', { name: text('outfits.leave', language), exact: true }).click();
      await expect(page.locator('#outfits-title')).toBeVisible();
      await page.waitForTimeout(1200);
      expect(log.writes.length).toBe(writes);
      expect(log.bodies).toHaveLength(1);
    });
  }
});

test('I11 outfits accessibility: list, editor with errors, detail and the leave dialog', async ({ page }) => {
  let id = '';
  await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id, clothes.trousers.id], { notes: 'Dinner', favourite: true }); });
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await openOutfits(page); await axe();
  await page.locator(`a[href="#/outfits/${id}"]`).click();
  await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend'); await axe();
  await button(page, 'outfits.back').click();
  await button(page, 'outfits.create').click();
  await expect(page.locator('.outfit-choice')).toHaveCount(3);
  await button(page, 'outfits.saveOutfit').click();
  await expect(page.locator('#outfit-name-error')).toBeVisible(); await axe();
  await page.locator('#outfit-name').fill('Draft');
  await navLink(page, 'nav.wardrobe').click();
  await expect(leaveDialog(page)).toBeVisible(); await axe();
});

test('I11 outfits accessibility: keyboard, 320px and 200% text, with the header nav on every screen', async ({ page }) => {
  let id = '';
  await start(page, 'en', (api, clothes) => { id = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id], { notes: 'Dinner', favourite: true }); });
  await page.setViewportSize({ width: 320, height: 900 });
  const screens: [string, string][] = [['#/wardrobe', 'wardrobe-title'], ['#/outfits', 'outfits-title'], [`#/outfits/${id}`, 'outfit-detail-title'],
    ['#/outfits/new', 'outfit-editor-title'], ['#/settings', 'settings-title'], ['#/trash', 'trash-title']];
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const textSizes = async () => {
    await page.evaluate((value) => { location.hash = value; }, `#/outfits/${id}`);
    await button(page, 'outfits.edit').click();
    await expect(page.locator('.outfit-slot .outfit-component-name').first()).toBeVisible();
    const sizes = await page.evaluate(() => ['label[for="outfit-name"]', '.outfit-slot .outfit-component-name', '#outfit-name']
      .map(selector => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize)));
    await button(page, 'outfits.back').first().click();
    await expect(page.locator('#outfits-title')).toBeVisible();
    return sizes;
  };
  const normal = await textSizes();
  for (const zoom of [false, true]) {
    if (zoom) {
      await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      expect(await textSizes()).toEqual(normal.map(size => size * 2));
    }
    for (const [hash, title] of screens) {
      await page.evaluate((value) => { location.hash = value; }, hash);
      await expect(page.locator(`#${title}`)).toBeVisible();
      // Font-independent: the nav row stays inside the header's content box, so wider fonts cannot push it past 320px.
      expect(await page.evaluate(() => {
        const nav = document.querySelector('.workspace-header nav')!, header = nav.parentElement!;
        return nav.scrollWidth <= nav.clientWidth
          && nav.getBoundingClientRect().right <= header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 0.5;
      })).toBe(true);
      for (const key of ['nav.wardrobe', 'nav.outfits'] as const) {
        const link = navLink(page, key);
        await link.focus();
        await expect(link).toBeFocused();
        const box = await link.boundingBox();
        expect(box !== null && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44).toBe(true);
      }
      expect(await fits()).toBe(true);
    }
    await page.evaluate((value) => { location.hash = value; }, `#/outfits/${id}`);
    await button(page, 'outfits.edit').click();
    await expect(page.locator('#outfit-name')).toBeFocused();
    await page.locator('#outfit-name').press('Tab');
    await expect(page.locator('.outfit-slot').first().locator(':focus')).toHaveCount(1);
    await page.getByText(text('item.moreDetails'), { exact: true }).click();
    expect(await fits()).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await button(page, 'outfits.back').first().click();
    await expect(page.locator('#outfits-title')).toBeVisible();
  }
});

test('I11 list collages fill the card for one to four items, and the editor favourite is a small inline checkbox', async ({ page }) => {
  await start(page, 'en', (api, clothes) => {
    const scarf = api.seedSavedItem('a', 'Grey scarf').item as Row;
    const all = [clothes.top.id, clothes.trousers.id, clothes.shoes.id, String(scarf.id)];
    for (const count of [1, 2, 3, 4]) seedOutfit(api, all.slice(0, count), { title: `Look ${count}`, created_at: new Date(Date.now() - count * 60000).toISOString() });
  });
  await openOutfits(page);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.outfit-card')).toHaveCount(4);
    await expect(page.locator('.outfit-card img')).toHaveCount(10);
    const layouts = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.outfit-card-thumbs')].map(box => {
      const outer = box.getBoundingClientRect(), style = getComputedStyle(box);
      const inner = { left: outer.left + parseFloat(style.borderLeftWidth), top: outer.top + parseFloat(style.borderTopWidth),
        width: box.clientWidth, height: box.clientHeight };
      const cells = [...box.children].map(cell => { const rect = cell.getBoundingClientRect();
        return { fill: cell.classList.contains('outfit-thumb-fill'), background: getComputedStyle(cell).backgroundColor,
          x: (rect.left - inner.left) / inner.width, y: (rect.top - inner.top) / inner.height, w: rect.width / inner.width, h: rect.height / inner.height }; });
      return { title: box.closest('.outfit-card')!.querySelector('h2')!.textContent, background: style.backgroundColor, cells };
    }));
    const near = (value: number, expected: number) => Math.abs(value - expected) < 0.04;
    for (const layout of layouts) {
      const count = Number(layout.title!.split(' ')[1]);
      const cells = layout.cells;
      expect(cells.length).toBe(count === 3 ? 4 : count);
      for (const cell of cells) expect(near(cell.h, count <= 2 ? 1 : 0.5) && near(cell.w, count === 1 ? 1 : 0.5)).toBe(true);
      if (count === 2) expect(near(cells[0]!.x, 0) && near(cells[1]!.x, 0.5) && cells.every(cell => near(cell.y, 0))).toBe(true);
      if (count >= 3) expect(cells.map(cell => [Math.round(cell.x * 2), Math.round(cell.y * 2)])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
      const fill = cells.filter(cell => cell.fill);
      expect(fill.length).toBe(count === 3 ? 1 : 0);
      for (const cell of fill) expect(cell.background !== layout.background && cell.background !== 'rgba(0, 0, 0, 0)').toBe(true);
    }
  }
  for (const [language, width] of [['en', 1280], ['en', 320], ['fi', 320]] as const) {
    if (language === 'fi') {
      await page.getByRole('button', { name: text('account.menu', 'en') }).click();
      await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
    }
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { location.hash = '#/outfits/new'; });
    await expect(page.locator('#outfit-editor-title')).toBeVisible();
    const favourite = page.locator('#outfit-favourite');
    if (!(await favourite.isVisible())) await page.getByText(text('item.moreDetails', language), { exact: true }).click();
    await expect(favourite).toBeVisible();
    const shape = await favourite.evaluate((input) => {
      const label = input.closest('label')!, words = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange(); range.selectNodeContents(words);
      const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
      const box = input.getBoundingClientRect(), textBox = range.getBoundingClientRect();
      return { width: box.width, height: box.height, lines: lines.size, after: textBox.left >= box.right, gap: textBox.left - box.right,
        labelWidth: label.getBoundingClientRect().width, text: words.textContent };
    });
    expect(shape.text).toBe(text('item.favourite', language));
    expect(shape.width <= 24 && shape.height <= 24 && shape.lines === 1 && shape.after && shape.gap < 16 && shape.labelWidth < 200).toBe(true);
    if (language !== 'fi') continue;
    await page.locator('label.check').filter({ has: favourite }).click();
    await expect(favourite).toBeChecked();
  }
});

test.describe('bounded I11 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`list, editor and detail ${selected.suffix} retain functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      let weekend = '', errands = '';
      await start(page, language, (api, clothes) => {
        const scarf = api.seedSavedItem('a', 'Grey scarf').item as Row;
        Object.assign(scarf, { category: 'accessory', colours: ['grey'], created_at: '2026-09-09T00:00:03Z' });
        Object.assign(clothes.top as Row, { deleted_at: new Date().toISOString() });
        weekend = seedOutfit(api, [clothes.top.id, clothes.trousers.id, clothes.shoes.id, String(scarf.id)], { title: 'Weekend', notes: 'Dinner', occasion: 'smart' });
        errands = seedOutfit(api, [clothes.trousers.id, clothes.shoes.id], { title: 'Errands', created_at: new Date(Date.now() - 120000).toISOString() });
        api.outfitItems.find(link => link.outfit_id === errands && link.item_id === clothes.shoes.id)!.position = 2;
        seedOutfit(api, [String(scarf.id), clothes.trousers.id, clothes.shoes.id], { title: 'Office', occasion: 'business', created_at: new Date(Date.now() - 180000).toISOString() });
      });
      const write = testInfo.project.name === selected.project;
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/i11-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async (name: 'list' | 'editor' | 'detail') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        await expect(page.locator('.workspace-identity')).toContainText('Alex');
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === 900
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        if (!write) return;
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await openOutfits(page, language);
      await expect(page.locator('.outfit-card')).toHaveCount(3);
      await expect(page.locator('.outfit-card-thumbs-4')).toHaveCount(1);
      await expect(page.locator('.outfit-card-thumbs-2')).toHaveCount(1);
      await expect(page.locator('.outfit-card-thumbs-3 .outfit-thumb-fill')).toHaveCount(1);
      await expect(page.locator('.outfit-card img').first()).toBeVisible();
      await capture('list');
      await page.locator(`a[href="#/outfits/${errands}"]`).click();
      await expect(page.locator('#outfit-detail-title')).toHaveText('Errands');
      await expect(page.locator('.outfit-composition img')).toHaveCount(2);
      await expect(page.getByText(text('outfits.itemsDeleted', language), { exact: true })).toBeVisible();
      await capture('detail');
      await button(page, 'outfits.back', language).click();
      await page.locator(`a[href="#/outfits/${weekend}"]`).click();
      await expect(page.locator('#outfit-detail-title')).toHaveText('Weekend');
      await button(page, 'outfits.edit', language).click();
      await expect(page.locator('#outfit-name')).toBeFocused();
      await expect(page.locator('.outfit-slot')).toHaveCount(4);
      await expect(page.locator('.outfit-slot').nth(0)).toContainText(text('outfits.inTrash', language));
      await expect(page.locator('.outfit-slot img')).toHaveCount(4);
      await page.getByText(text('item.moreDetails', language), { exact: true }).click();
      await expect(page.locator('#outfit-notes')).toHaveValue('Dinner');
      await capture('editor');
    });
  }
});
