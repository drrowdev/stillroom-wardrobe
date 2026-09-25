import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn, type MockOptions } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
type Part = { name: string; mimeType: string; buffer: Buffer };
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) =>
  page.getByRole('button', { name: text(key, language, parameters), exact: true });
const restoreCard = (page: Page) => page.locator('.restore-card');
const backupCard = (page: Page) => page.locator('.backup-card');
const passphrase = 'fictional backup passphrase 42';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const slow = { timeout: 60_000 };
// Each backup part takes a 600k-iteration key derivation to write and again to read.
test.describe.configure({ timeout: 240_000 });

// A real small JPEG thumbnail, encoded by the browser, so the backup's thumbnails pass the restore checks.
async function thumbnail(page: Page): Promise<Buffer> {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 320;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#6b7a4f'; context.fillRect(0, 0, 256, 320);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]!;
  });
  return Buffer.from(data, 'base64');
}
// Seeds a saved item with `photos` photos: the earlier ones retired in order, the last one current.
function seed(api: Api, thumb: Buffer, title: string, photos = 1, account: 'a' | 'b' = 'a') {
  const { item, image } = api.seedSavedItem(account, title);
  // The fixture photo is 2 x 2 pixels; the backup checks the recorded size against the file.
  Object.assign(image, { width: 2, height: 2 });
  Object.assign(item, { colours: ['olive'], field_provenance: { category: { kind: 'ai_observed', revision: 3 }, colours: { kind: 'user', revision: 2 } } });
  const list: Row[] = [image];
  for (let index = 1; index < photos; index++) {
    const id = randomUUID(), prefix = `${owners[account]}/${String(item.id)}/${id}`;
    list.push({ ...image, id, alt_text: `${String(image.alt_text)}, photo ${index + 1}`, main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg` });
    api.images.push(list.at(-1)!);
    api.files.set(`${prefix}/main.jpg`, api.files.get(String(image.main_path))!);
  }
  list.forEach((photo, index) => {
    Object.assign(photo, { state: index === photos - 1 ? 'ready' : 'retired', retired_at: index === photos - 1 ? null : `2026-09-0${index + 1}T00:00:00Z`,
      thumb_sha256: sha(thumb), thumb_bytes: thumb.length });
    api.files.set(String(photo.thumb_path), thumb);
  });
  return { item, images: list };
}
function seedHistory(api: Api, shirt: Row, trousers: Row) {
  const outfit = randomUUID(), event = randomUUID(), now = '2026-09-09T00:00:00Z';
  api.outfits.push({ id: outfit, owner_id: owners.a, title: 'Fictional office outfit', occasion: 'Work', notes: '', favourite: true,
    deleted_at: null, version: 1, created_at: now, updated_at: now });
  [shirt, trousers].forEach((item, position) => api.outfitItems.push({ owner_id: owners.a, outfit_id: outfit, item_id: item.id, position }));
  const [low, high] = [String(shirt.id), String(trousers.id)].sort();
  api.combinationRules.push({ id: randomUUID(), owner_id: owners.a, item_low: low, item_high: high, created_at: now });
  api.suggestionFeedback.push({ id: randomUUID(), owner_id: owners.a, item_ids: [low, high], signature: 'x'.repeat(64), vote: 1, created_at: now });
  api.wearEvents.push({ id: event, owner_id: owners.a, outfit_id: outfit, local_date: '2026-09-08', timezone: 'Europe/Helsinki', state: 'worn',
    label: 'Daily outfit', deleted_at: null, version: 1, created_at: now, updated_at: now });
  api.wearLinks.push({ id: randomUUID(), owner_id: owners.a, event_id: event, item_id: shirt.id, title_snapshot: 'Fictional linen shirt', category_snapshot: 'top', import_id: null });
  api.wearLinks.push({ id: randomUUID(), owner_id: owners.a, event_id: event, item_id: null, title_snapshot: 'Fictional old scarf', category_snapshot: 'accessory', import_id: null });
}

async function start(page: Page, options: MockOptions = {}, language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language, ...options });
  api.profiles[owners.b]!.ui_language = language;
  const urls: string[] = [];
  page.on('request', request => { urls.push(request.url()); });
  await page.goto('/#/settings');
  const thumb = await thumbnail(page);
  return { api, urls, thumb };
}
async function settings(page: Page, account: 'a' | 'b') {
  await signIn(page, account);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#settings-title')).toBeVisible();
}
async function signOut(page: Page, language: Language = 'en') {
  await page.getByRole('button', { name: text('account.menu', language) }).click();
  await page.getByRole('button', { name: text('auth.signOut', language), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
}
// Makes a real backup through the Backup card and returns its parts as files.
async function backup(page: Page, language: Language = 'en'): Promise<Part[]> {
  await button(page, 'backup.create', language).click();
  await backupCard(page).getByLabel(text('backup.passphrase', language), { exact: true }).fill(passphrase);
  await backupCard(page).getByLabel(text('backup.repeat', language), { exact: true }).fill(passphrase);
  await button(page, 'backup.create', language).click();
  const buttons = backupCard(page).locator('.backup-parts li');
  await expect(buttons.first()).toBeVisible(slow);
  const count = await buttons.count();
  const parts: Part[] = [];
  for (let index = 0; index < count; index++) {
    const pending = page.waitForEvent('download');
    await button(page, 'backup.part', language, { n: index + 1, total: count }).click();
    const item = await pending;
    parts.push({ name: item.suggestedFilename(), mimeType: 'application/octet-stream', buffer: await readFile((await item.path())!) });
  }
  await button(page, 'backup.finish', language).click();
  return parts;
}
async function check(page: Page, parts: Part[], secret = passphrase, language: Language = 'en') {
  if (await button(page, 'restore.open', language).isVisible()) await button(page, 'restore.open', language).click();
  await restoreCard(page).locator('#restore-files').setInputFiles(parts);
  await restoreCard(page).getByLabel(text('backup.passphrase', language), { exact: true }).fill(secret);
  await button(page, 'restore.check', language).click();
}
const own = (rows: Row[], account: 'a' | 'b' = 'b') => rows.filter(row => row.owner_id === owners[account]);

test('I20 restore: a backup from another account is added through the checked save, with photo history and no analysis', async ({ page }) => {
  const { api, urls, thumb } = await start(page);
  const shirt = seed(api, thumb, 'Fictional linen shirt', 3);
  const trousers = seed(api, thumb, 'Fictional wool trousers');
  seedHistory(api, shirt.item, trousers.item);
  api.exportControl.attributions.set(String(shirt.item.id), [{ source_image_id: shirt.images[2]!.id, image_sha256: shirt.images[2]!.main_sha256,
    model_id: 'fixture-model', prompt_version: 1, fields: { category: 'top' } }]);
  await settings(page, 'a');
  const parts = await backup(page);
  await signOut(page);
  await settings(page, 'b');
  const profileBefore = structuredClone(api.profiles[owners.b]);
  await check(page, parts);
  const card = restoreCard(page);
  await expect(card.getByText(text('restore.add', 'en', { n: '2' }))).toBeVisible(slow);
  await expect(card).toContainText(text('restore.contents', 'en', { items: '2 items', outfits: '1 outfit' }));
  await expect(card).toContainText(text('restore.otherAccount'));
  await expect(card).toContainText(text('restore.kept'));
  await expect(card).toContainText(text('restore.attributions'));
  expect(own(api.items)).toHaveLength(0);
  await button(page, 'restore.start').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);

  const items = own(api.items);
  expect(items.map(row => row.title).sort()).toEqual(['Fictional linen shirt', 'Fictional wool trousers']);
  expect(items.some(row => row.id === shirt.item.id || row.id === trousers.item.id)).toBe(false);
  const restoredShirt = items.find(row => row.title === 'Fictional linen shirt')!;
  expect(restoredShirt.field_provenance).toMatchObject({ category: { kind: 'ai_observed', revision: 1 }, colours: { kind: 'user', revision: 1 } });
  const photos = own(api.images).filter(image => image.item_id === restoredShirt.id);
  expect(photos.map(image => image.state).sort()).toEqual(['ready', 'retired', 'retired']);
  expect(photos.find(image => image.state === 'ready')!.alt_text).toBe(shirt.images[2]!.alt_text);
  for (const image of own(api.images)) {
    const main = api.files.get(String(image.main_path)), small = api.files.get(String(image.thumb_path));
    expect(main && sha(main) === image.main_sha256 && small && sha(small) === image.thumb_sha256).toBeTruthy();
  }
  const outfits = own(api.outfits);
  expect(outfits).toEqual([expect.objectContaining({ title: 'Fictional office outfit', favourite: true })]);
  expect(own(api.outfitItems).map(link => link.item_id).sort()).toEqual(items.map(row => row.id).sort());
  expect(own(api.combinationRules)).toHaveLength(1);
  expect(own(api.suggestionFeedback)).toEqual([expect.objectContaining({ vote: 1 })]);
  expect(own(api.wearEvents)).toEqual([expect.objectContaining({ outfit_id: outfits[0]!.id, local_date: '2026-09-08', state: 'worn' })]);
  expect(own(api.wearLinks).map(link => [link.title_snapshot, link.item_id === null]).sort())
    .toEqual([['Fictional linen shirt', false], ['Fictional old scarf', true]]);
  expect(own(api.wearLinks).every(link => typeof link.import_id === 'string')).toBe(true);
  expect(api.profiles[owners.b]).toEqual(profileBefore);
  expect(urls.filter(url => /:54321\/.*analy/i.test(url))).toEqual([]);
  expect(urls.some(url => url.includes('/rpc/reserve_item_save'))).toBe(false);

  // Checking the same backup again finds everything already here; restoring it again adds nothing.
  await button(page, 'backup.finish').click();
  const reservations = api.restoreControl.reservations, count = api.items.length;
  await check(page, parts);
  await expect(card.getByText(text('restore.same', 'en', { n: '2' }))).toBeVisible(slow);
  await expect(card).toContainText(text('restore.add', 'en', { n: '0' }));
  await button(page, 'restore.start').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  expect(api.restoreControl.reservations).toBe(reservations);
  expect(api.items).toHaveLength(count);
  expect(own(api.wearLinks)).toHaveLength(2);
});

for (const loss of ['save reply', 'replacement reply', 'replacement reservation'] as const) {
  test(`I21 restore: a lost ${loss} is resumed without adding anything twice`, async ({ page }) => {
    const { api, thumb } = await start(page, loss === 'save reply' ? { loseFinalizeReplyOnce: true }
      : { imageChangeLoss: loss === 'replacement reply' ? 'finalizer' : 'reservation' });
    seed(api, thumb, 'Fictional linen shirt', 3);
    await settings(page, 'a');
    const parts = await backup(page);
    await signOut(page);
    await settings(page, 'b');
    await check(page, parts);
    await button(page, 'restore.start').click();
    await expect(restoreCard(page).getByRole('status')).toHaveText(text('restore.done'), slow);
    expect(own(api.items)).toHaveLength(1);
    expect(own(api.images).map(image => image.state).sort()).toEqual(['ready', 'retired', 'retired']);
    expect(api.imageChanges.filter(change => change.owner === owners.b).map(change => change.receipt.state)).toEqual(['completed', 'completed']);
  });
}

test('I21 restore: an item that could not be restored is reported, and running the restore again continues', async ({ page }) => {
  const { api, thumb } = await start(page);
  const shirt = seed(api, thumb, 'Fictional linen shirt', 2);
  const trousers = seed(api, thumb, 'Fictional wool trousers');
  seedHistory(api, shirt.item, trousers.item);
  await settings(page, 'a');
  const parts = await backup(page);
  await signOut(page);
  await settings(page, 'b');
  // The first item's replacement photo cannot be reserved twice in a row, so this run stops with that item unfinished.
  let blocked = 2;
  await page.route('**/rest/v1/rpc/reserve_image_change', async route => {
    if (blocked > 0) { blocked--; await route.abort('failed'); return; }
    await route.fallback();
  });
  await check(page, parts);
  await button(page, 'restore.start').click();
  const card = restoreCard(page);
  await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
  await expect(card.getByRole('alert')).toBeFocused();
  // The shirt and the outfit, rule, feedback and history that refer to it wait for the next run; nothing is written without it.
  await expect(card).toContainText(text('restore.notRestored', 'en', { n: '5' }));
  expect(own(api.items)).toHaveLength(2);
  for (const rows of [api.outfits, api.outfitItems, api.combinationRules, api.suggestionFeedback, api.wearEvents, api.wearLinks]) expect(own(rows)).toEqual([]);
  await button(page, 'restore.again').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  await expect(card).not.toContainText(text('restore.conflicts', 'en', { n: '1' }));
  const items = own(api.items);
  expect(items).toHaveLength(2);
  expect(own(api.images).map(image => image.state).sort()).toEqual(['ready', 'ready', 'retired']);
  const outfits = own(api.outfits);
  expect(outfits).toEqual([expect.objectContaining({ title: 'Fictional office outfit' })]);
  expect(own(api.outfitItems).map(link => link.item_id).sort()).toEqual(items.map(row => row.id).sort());
  expect(own(api.combinationRules)).toHaveLength(1);
  expect(own(api.suggestionFeedback)).toHaveLength(1);
  expect(own(api.wearEvents)).toEqual([expect.objectContaining({ outfit_id: outfits[0]!.id })]);
  const shirtId = items.find(row => row.title === 'Fictional linen shirt')!.id;
  expect(own(api.wearLinks).map(link => [link.title_snapshot, link.item_id]).sort())
    .toEqual([['Fictional linen shirt', shirtId], ['Fictional old scarf', null]]);
});

test('I21 restore: a stored photo that cannot be read for now is retried, and nothing that refers to it is written', async ({ page }) => {
  const { api, thumb } = await start(page);
  const shirt = seed(api, thumb, 'Fictional linen shirt', 2);
  const trousers = seed(api, thumb, 'Fictional wool trousers');
  seedHistory(api, shirt.item, trousers.item);
  await settings(page, 'a');
  const parts = await backup(page);
  await signOut(page);
  await settings(page, 'b');
  // First run: the shirt's replacement cannot be reserved, so the shirt stops after its first photo.
  let blocked = 2;
  await page.route('**/rest/v1/rpc/reserve_image_change', async route => {
    if (blocked > 0) { blocked--; await route.abort('failed'); return; }
    await route.fallback();
  });
  await check(page, parts);
  await button(page, 'restore.start').click();
  const card = restoreCard(page);
  await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
  const restoredShirt = own(api.items).find(row => row.title === 'Fictional linen shirt')!;
  const first = own(api.images).find(image => image.item_id === restoredShirt.id && image.state === 'ready')!;
  // Second run: reading the shirt's first photo back fails with 503 on both attempts. That is not a different photo.
  let unavailable = 0;
  await page.route(`**/storage/v1/object/wardrobe/${String(first.main_path)}`, async route => {
    if (route.request().method() === 'GET' && unavailable < 2) { unavailable++; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Unavailable"}' }); return; }
    await route.fallback();
  });
  await button(page, 'restore.again').click();
  await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
  expect(unavailable).toBe(2);
  await expect(card).toContainText(text('restore.notRestored', 'en', { n: '5' }));
  await expect(card).not.toContainText(text('restore.done'));
  for (const rows of [api.outfits, api.outfitItems, api.combinationRules, api.suggestionFeedback, api.wearEvents, api.wearLinks]) expect(own(rows)).toEqual([]);
  // Third run: the photo reads back as it was stored, the shirt is finished and everything is linked to it.
  await button(page, 'restore.again').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  await expect(card).not.toContainText(text('restore.conflicts', 'en', { n: '1' }));
  const items = own(api.items);
  expect(items).toHaveLength(2);
  expect(own(api.images).map(image => image.state).sort()).toEqual(['ready', 'ready', 'retired']);
  const outfits = own(api.outfits);
  expect(outfits).toHaveLength(1);
  expect(own(api.outfitItems).map(link => link.item_id).sort()).toEqual(items.map(row => row.id).sort());
  expect(own(api.combinationRules)).toHaveLength(1);
  expect(own(api.suggestionFeedback)).toHaveLength(1);
  expect(own(api.wearEvents)).toEqual([expect.objectContaining({ outfit_id: outfits[0]!.id })]);
  expect(own(api.wearLinks).map(link => [link.title_snapshot, link.item_id]).sort())
    .toEqual([['Fictional linen shirt', restoredShirt.id], ['Fictional old scarf', null]]);
});

test('I20 restore: an item in Trash or changed here is skipped and left as it is', async ({ page }) => {
  const { api, thumb } = await start(page);
  seed(api, thumb, 'Fictional linen shirt');
  seed(api, thumb, 'Fictional wool trousers');
  await settings(page, 'a');
  const parts = await backup(page);
  await signOut(page);
  await settings(page, 'b');
  await check(page, parts);
  await button(page, 'restore.start').click();
  const card = restoreCard(page);
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  await button(page, 'backup.finish').click();
  const [first, second] = own(api.items).sort((a, b) => String(a.title) < String(b.title) ? -1 : 1);
  first!.deleted_at = '2026-09-10T00:00:00Z';
  const changed = own(api.images).find(image => image.item_id === second!.id)!;
  changed.alt_text = 'Described again here';
  const before = structuredClone([first, second, changed]);
  await check(page, parts);
  await expect(card).toContainText(text('restore.inTrash', 'en', { n: '1' }), slow);
  await expect(card).toContainText(text('restore.conflicts', 'en', { n: '1' }));
  await button(page, 'restore.start').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  expect([first, second, changed]).toEqual(before);
  expect(own(api.items)).toHaveLength(2);
});

test('I20 restore: an item edited here, or with a missing or different stored photo, is skipped and left as it is', async ({ page }) => {
  const { api, thumb } = await start(page);
  seed(api, thumb, 'Fictional linen shirt');
  seed(api, thumb, 'Fictional wool trousers', 2);
  seed(api, thumb, 'Fictional rain jacket');
  await settings(page, 'a');
  const parts = await backup(page);
  await signOut(page);
  await settings(page, 'b');
  await check(page, parts);
  await button(page, 'restore.start').click();
  const card = restoreCard(page);
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  await button(page, 'backup.finish').click();
  const byTitle = (title: string) => own(api.items).find(row => row.title === title)!;
  const edited = byTitle('Fictional linen shirt');
  Object.assign(edited, { title: 'Fictional linen shirt, edited', version: Number(edited.version) + 1 });
  // The retired first photo of the trousers is gone from storage, and the jacket's thumbnail holds different bytes.
  const trousersPhotos = own(api.images).filter(image => image.item_id === byTitle('Fictional wool trousers').id);
  const retired = trousersPhotos.find(image => image.state === 'retired')!;
  api.files.delete(String(retired.main_path));
  const jacket = own(api.images).find(image => image.item_id === byTitle('Fictional rain jacket').id)!;
  const original = api.files.get(String(jacket.thumb_path))!;
  const different = Buffer.from(original); different.writeUInt8(different.readUInt8(different.length - 3) ^ 0xff, different.length - 3);
  api.files.set(String(jacket.thumb_path), different);
  const before = structuredClone({ items: own(api.items), images: own(api.images) });
  const reservations = api.restoreControl.reservations, changes = api.imageChanges.length;
  await check(page, parts);
  await expect(card).toContainText(text('restore.conflicts', 'en', { n: '1' }), slow);
  await button(page, 'restore.start').click();
  await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
  await expect(card).toContainText(text('restore.conflicts', 'en', { n: '3' }));
  expect({ items: own(api.items), images: own(api.images) }).toEqual(before);
  expect(api.files.has(String(retired.main_path))).toBe(false);
  expect(api.files.get(String(jacket.thumb_path))).toEqual(different);
  expect(api.restoreControl.reservations).toBe(reservations);
  expect(api.imageChanges).toHaveLength(changes);
});

test('I20 restore: wrong passphrase, missing parts, other files and too many files are refused before anything is written', async ({ page }) => {
  const { api, urls, thumb } = await start(page);
  seed(api, thumb, 'Fictional linen shirt');
  await settings(page, 'a');
  const parts = await backup(page);
  const card = restoreCard(page);
  const refuse = async (files: Part[], key: MessageKey, secret = passphrase) => {
    await check(page, files, secret);
    await expect(card.getByRole('alert')).toHaveText(text(key), slow);
    await expect(card.getByRole('alert')).toBeFocused();
    await button(page, 'backup.startAgain').click();
  };
  const writes = () => urls.filter(url => /reserve_|save_outfit|restore_history_entry|\/storage\/v1\/object\/wardrobe\/(?!.*\?)/.test(url)).length;
  const before = writes();
  await refuse(parts, 'restore.wrong', `${passphrase}!`);
  await refuse(parts.slice(1), 'restore.missing');
  await refuse([{ ...parts[0]!, buffer: Buffer.from('{"format":"other"}') }, parts[1]!], 'restore.invalid');
  await refuse([{ name: 'wardrobe.json.enc', mimeType: 'application/octet-stream', buffer: parts[0]!.buffer }], 'restore.invalid');
  const exportId = /^stillroom-([0-9a-f-]{36})-0\.json\.enc$/.exec(parts[0]!.name)![1]!;
  await refuse(Array.from({ length: 401 }, (_, index) => ({ name: `stillroom-${exportId}-${index}.json.enc`, mimeType: 'application/octet-stream',
    buffer: Buffer.from('{}') })), 'restore.tooLarge');
  expect(writes()).toBe(before);
  expect(own(api.items, 'a')).toHaveLength(1);
});

test('I20 restore: offline, signing out and accessibility at 320px and 200% text', async ({ page, context }) => {
  const { api, thumb } = await start(page);
  seed(api, thumb, 'Fictional linen shirt');
  await settings(page, 'a');
  const parts = await backup(page);
  const card = restoreCard(page);
  const axe = async () => expect((await new AxeBuilder({ page }).include('.restore-card').analyze()).violations).toEqual([]);
  await axe();
  await button(page, 'restore.open').click();
  await expect(card.locator('#restore-files')).toBeFocused();
  await expect(button(page, 'restore.check')).toBeDisabled();
  await axe();
  await check(page, parts);
  await expect(button(page, 'restore.start')).toBeVisible(slow);
  await axe();
  await context.setOffline(true);
  await expect(button(page, 'restore.start')).toBeDisabled();
  await expect(card).toContainText(text('restore.offline'));
  await context.setOffline(false);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe();
  }
  await signOut(page);
  await settings(page, 'b');
  await expect(card.locator('#restore-files')).toHaveCount(0);
  await expect(button(page, 'restore.start')).toHaveCount(0);
  expect(own(api.items)).toHaveLength(0);
});

test.describe('bounded P6b visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'restore-preview', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'restore-progress', project: 'mobile', language: 'sv', width: 320, suffix: 'sv-mobile' },
  ] as const;
  for (const selected of scenes) test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
    const language: Language = selected.language;
    const write = testInfo.project.name === selected.project;
    const directory = path.resolve('test-results/p6b-visual');
    if (write) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    }
    await page.setViewportSize({ width: selected.width, height: 900 });
    const { api, thumb } = await start(page, {}, language);
    api.profiles[owners.b]!.ui_language = language;
    seed(api, thumb, 'Fictional linen shirt');
    seed(api, thumb, 'Fictional wool trousers');
    await settings(page, 'a');
    const parts = await backup(page, language);
    await signOut(page, language);
    await settings(page, 'b');
    const card = restoreCard(page);
    let release: () => void = () => undefined;
    if (selected.scene === 'restore-progress') {
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/rest/v1/rpc/reserve_restored_item_save', async route => { await held; await route.fallback(); });
    }
    await check(page, parts, passphrase, language);
    await expect(button(page, 'restore.start', language)).toBeVisible(slow);
    if (selected.scene === 'restore-progress') {
      await button(page, 'restore.start', language).click();
      await expect(card.getByRole('status')).toHaveText(text('restore.progress', language, { n: '1', total: '2' }));
    }
    await card.scrollIntoViewIfNeeded();
    expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ expectedLanguage, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
        .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
      return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === 900
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
        && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
    }, { expectedLanguage: language, width: selected.width })).toBe(true);
    if (write) {
      const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
      const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    }
    release();
    if (selected.scene === 'restore-progress') await expect(card.getByRole('status')).toHaveText(text('restore.done', language), slow);
  });
});
