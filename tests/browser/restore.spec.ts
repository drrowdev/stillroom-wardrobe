import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { canonical, encryptPart, sha256Hex, toBase64 } from '../../src/domain/export-format';
import { fitDimensions, JPEG_LIMITS, readJpegHeader } from '../../src/images/jpeg';
import { exifSegment, joinBytes, jpegSegment, listJpegMarkers } from '../fixtures/jpeg-helpers';
import { findMarker, findMarkers, flatJpeg } from '../fixtures/restore-jpeg-fixtures';
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
  // Each entry is `METHOD url`, so a read can be told from a write to the same address.
  page.on('request', request => { urls.push(`${request.method()} ${request.url()}`); });
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
    { scene: 'restore-reencoded', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' },
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
    const seeded = [seed(api, thumb, 'Fictional linen shirt'), seed(api, thumb, 'Fictional wool trousers')];
    // Progressive photos decode but are outside the app's own profile, so the preview says they will be re-encoded.
    if (selected.scene === 'restore-reencoded') for (const { images: [image] } of seeded) {
      const main = Buffer.from(flatJpeg({ width: 64, height: 48, mode: 'progressive' }));
      Object.assign(image!, { width: 64, height: 48, main_sha256: sha(main), main_bytes: main.length });
      api.files.set(String(image!.main_path), main);
    }
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
    if (selected.scene === 'restore-reencoded') await expect(card).toContainText(text('restore.reencoded_other', language, { count: '2' }));
    else await expect(card).not.toContainText(text('restore.reencoded_other', language, { count: '2' }));
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

// ---- Q6 byte-preserving restore (ADR22). ----
type Q6Photo = { main: Uint8Array; thumb: Uint8Array; width: number; height: number; thumbSha?: string; thumbLength?: number; item?: Row };
// A version 1 backup written directly, so a test controls every photo byte and manifest value; one item per photo.
async function v1Backup(photos: readonly Q6Photo[], exportId: string = randomUUID()): Promise<Part[]> {
  const owner = owners.a, now = '2026-09-01T00:00:00Z';
  const items: Row[] = [], images: Row[] = [], files: Row[] = [];
  for (const [index, photo] of photos.entries()) {
    const item = `5555${index.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`, image = `4444${index.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
    const mainHash = await sha256Hex(photo.main), thumbHash = photo.thumbSha ?? await sha256Hex(photo.thumb);
    const thumbLength = photo.thumbLength ?? photo.thumb.length;
    items.push({ id: item, owner_id: owner, title: `Fictional coat ${index + 1}`, category: 'outerwear', notes: '', currency: 'EUR', colours: [], seasons: [], style_tags: [], tags: [],
      favourite: false, availability: 'ready', lifecycle: 'active', exclude_suggestions: false, wear_more: false, deleted_at: null,
      created_at: now, updated_at: now, version: 1, ...photo.item });
    images.push({ id: image, owner_id: owner, item_id: item, state: 'ready', retired_at: null, main_path: `${owner}/${item}/${image}/main.jpg`,
      thumb_path: `${owner}/${item}/${image}/thumb.jpg`, main_bytes: photo.main.length, thumb_bytes: thumbLength, main_sha256: mainHash,
      thumb_sha256: thumbHash, width: photo.width, height: photo.height, alt_text: `A coat, photo ${index + 1}`, created_at: now });
    files.push({ imageId: image, variant: 'main', sha256: mainHash, byteLength: photo.main.length, mime: 'image/jpeg', base64: toBase64(photo.main) },
      { imageId: image, variant: 'thumb', sha256: thumbHash, byteLength: thumbLength, mime: 'image/jpeg', base64: toBase64(photo.thumb) });
  }
  const manifest = { export_id: exportId, owner_id: owner, created_at: '2026-09-02T00:00:00Z', tables: {
    profiles: [{ owner_id: owner, display_name: 'Owner', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR',
      created_at: now, updated_at: now, version: 1 }], items, item_images: images } };
  const part = { format: 'stillroom-export', schemaVersion: 1, exportId, partIndex: 0, partCount: 1,
    manifestSha256: await sha256Hex(canonical(manifest)), files, manifest };
  return [{ name: `stillroom-${exportId}-0.json.enc`, mimeType: 'application/octet-stream',
    buffer: Buffer.from(JSON.stringify(await encryptPart(part as never, passphrase))) }];
}
const flatThumb = (width: number, height: number, colour = [60, 128, 128]) => {
  const size = fitDimensions(width, height, JPEG_LIMITS.thumbSide);
  return flatJpeg({ ...size, colour });
};
const q6 = (main: Uint8Array, width: number, height: number): Q6Photo => ({ main, width, height, thumb: flatThumb(width, height) });
// Counts every decoder start: createImageBitmap calls and blob URLs given to images. `__q6Fault` makes later bitmaps 1 x 1.
async function countDecodes(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { __q6Decodes: number; __q6Fault: number | null };
    state.__q6Decodes = 0; state.__q6Fault = null;
    const original = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
      state.__q6Decodes++;
      if (state.__q6Fault !== null && state.__q6Decodes > state.__q6Fault) return original(new ImageData(1, 1));
      return original(...args);
    }) as typeof createImageBitmap;
    const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return source.get!.call(this); },
      set(value: string) { if (String(value).startsWith('blob:')) state.__q6Decodes++; source.set!.call(this, value); } });
  });
  return {
    count: () => page.evaluate(() => (window as unknown as { __q6Decodes: number }).__q6Decodes),
    faultAfter: (calls: number) => page.evaluate(value => { const state = window as unknown as { __q6Decodes: number; __q6Fault: number };
      state.__q6Fault = state.__q6Decodes + value; }, calls),
  };
}
// Settings also lists avoided pairs with a GET, which is not a write. Any other method there is, even one asking for rows back.
const writeUrls = (urls: string[]) => urls.filter(url => !/^GET \S+\/rest\/v1\/combination_rules\?select=/.test(url) && /reserve_|finalize_|save_outfit|restore_history_entry|combination_rules|suggestion_feedback|wear_events|image-change|\/storage\/v1\/object\/wardrobe\/(?!.*\?)/.test(url));
type Report = import('../../src/data/restore').RestoreResult;
test('the restore write filter exempts only the Settings GET of avoided pairs', () => {
  const base = 'http://127.0.0.1:54321/rest/v1/combination_rules';
  const read = `GET ${base}?select=id%2Cowner_id%2Citem_low%2Citem_high&owner_id=eq.x&order=id.asc&limit=500`;
  const writes = ['POST', 'PATCH', 'DELETE'].map(method => `${method} ${base}?select=id%2Cowner_id&on_conflict=owner_id%2Citem_low%2Citem_high`);
  expect(writeUrls([read, ...writes, `POST ${base}?on_conflict=owner_id%2Citem_low%2Citem_high`])).toEqual([...writes, `POST ${base}?on_conflict=owner_id%2Citem_low%2Citem_high`]);
  expect(writeUrls([`GET http://127.0.0.1:54321/rest/v1/suggestion_feedback?select=id`])).toHaveLength(1);
});
// The last restore's report, from the app's own module instance in the page.
const report = (page: Page) => page.evaluate(async () => {
  const module = '/src/data/restore.ts';
  const { restoreReport } = await import(module) as typeof import('../../src/data/restore');
  return restoreReport();
}) as Promise<Report | null>;
const byImage = (value: Report | null) => new Map((value?.photos ?? []).map(photo => [photo.sourceImageId, photo]));
// Makes every later JPEG the browser encodes, on canvases of the chosen size, come out with other bytes; 'none' undoes it.
const driftEncoder = (page: Page, which: 'thumbnail' | 'main' | 'none') => page.evaluate(({ which, side }) => {
  const state = window as unknown as { __q6ToBlob?: typeof HTMLCanvasElement.prototype.toBlob };
  const original = state.__q6ToBlob ??= HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = which === 'none' ? original : function (this: HTMLCanvasElement, callback: BlobCallback, type?: string, quality?: number) {
    const small = Math.max(this.width, this.height) <= side;
    original.call(this, callback, type, small === (which === 'thumbnail') ? 0.23 : quality);
  };
}, { which, side: JPEG_LIMITS.thumbSide });
// Average colour of a stored JPEG, decoded in the page.
async function averageColour(page: Page, bytes: Buffer): Promise<number[]> {
  return page.evaluate(async base64 => {
    const blob = new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const sum = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) for (let channel = 0; channel < 3; channel++) sum[channel]! += data[index + channel]!;
    return sum.map(value => value / (data.length / 4));
  }, bytes.toString('base64'));
}

test.describe('Q6 byte-preserving restore', () => {
  test('photos made by the app are kept byte for byte; thumbnails are made again from them', async ({ page }) => {
    const { api, urls, thumb } = await start(page);
    // Real photos from the app's own image preparation, non-square and dense.
    const photos = await page.evaluate(async () => {
      // The Vite dev server serves the app's own image code to the page.
      const module = '/src/images/process-image.ts';
      const { prepareImage } = await import(module) as typeof import('../../src/images/process-image');
      const made: { main: string; width: number; height: number }[] = [];
      for (const [width, height] of [[1200, 900], [900, 1200]] as const) {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d')!;
        for (let y = 0; y < height; y += 10) for (let x = 0; x < width; x += 10) {
          context.fillStyle = `rgb(${(x * 7 + y) % 256},${(y * 5) % 256},${(x + y * 3) % 256})`; context.fillRect(x, y, 10, 10);
        }
        const blob = await new Promise<Blob>(resolve => { canvas.toBlob(value => { resolve(value!); }, 'image/jpeg', 0.95); });
        const prepared = await prepareImage(blob);
        const bytes = new Uint8Array(await prepared.main.arrayBuffer());
        made.push({ main: btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')), width: prepared.width, height: prepared.height });
      }
      return made;
    });
    const originals: Buffer[] = [];
    for (const [index, photo] of photos.entries()) {
      const main = Buffer.from(photo.main, 'base64');
      originals.push(main);
      const image = seed(api, thumb, `Fictional photo ${index + 1}`).images[0]!;
      Object.assign(image, { width: photo.width, height: photo.height, main_sha256: sha(main), main_bytes: main.length });
      api.files.set(String(image.main_path), main);
    }
    await settings(page, 'a');
    const parts = await backup(page);
    await signOut(page);
    await settings(page, 'b');
    await check(page, parts);
    const card = restoreCard(page);
    await expect(card.getByText(text('restore.add', 'en', { n: '2' }))).toBeVisible(slow);
    await expect(card).not.toContainText(text('restore.reencoded_other', 'en', { count: '2' }));
    await expect(card).not.toContainText(text('restore.reencoded_one', 'en', { count: '1' }));
    const before = originals.map(sha);
    await button(page, 'restore.start').click();
    await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
    const restored = own(api.images);
    expect(restored.map(image => image.main_sha256).sort()).toEqual([...before].sort());
    for (const image of restored) {
      const main = api.files.get(String(image.main_path))!, small = api.files.get(String(image.thumb_path))!;
      expect(originals.some(original => original.equals(main))).toBe(true);
      expect(sha(small)).toBe(image.thumb_sha256);
      expect(sha(small)).not.toBe(sha(thumb));
      const size = fitDimensions(Number(image.width), Number(image.height), JPEG_LIMITS.thumbSide);
      expect(readJpegHeader(small)).toMatchObject(size);
    }
    expect(urls.filter(url => /:54321\/.*analy/i.test(url))).toEqual([]);
  });

  test('photos outside the app profile are re-encoded at their size; a new thumbnail replaces an unrelated one', async ({ page }) => {
    const { api } = await start(page);
    const kept = flatJpeg({ width: 1200, height: 900, colour: [200, 110, 150] });
    const baseline = flatJpeg({ width: 96, height: 64, colour: [90, 140, 100] });
    const unusedTable = jpegSegment(0xc4, new Uint8Array([0, 0, 0, 0, 12, ...new Array<number>(12).fill(0), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    const photos = [
      // Baseline and in profile, with a backup thumbnail of the right size that shows something else.
      { ...q6(kept, 1200, 900), thumb: flatThumb(1200, 900, [30, 150, 100]) },
      q6(flatJpeg({ width: 640, height: 480, mode: 'progressive' }), 640, 480),
      q6(flatJpeg({ width: 480, height: 640, mode: 'restart', restartInterval: 2 }), 480, 640),
      q6(flatJpeg({ width: 400, height: 400, segments: [exifSegment(1)] }), 400, 400),
      // An unused table after the scan, and fill bytes between segments: both decode, neither is the app's output.
      q6(joinBytes(baseline.subarray(0, baseline.length - 2), unusedTable, new Uint8Array([0xff, 0xd9])), 96, 64),
      q6(joinBytes(baseline.subarray(0, 2), new Uint8Array([0xff, 0xff]), baseline.subarray(2)), 96, 64),
    ];
    await settings(page, 'b');
    await check(page, await v1Backup(photos));
    const card = restoreCard(page);
    await expect(card.getByText(text('restore.add', 'en', { n: '6' }))).toBeVisible(slow);
    await expect(card).toContainText(text('restore.reencoded_other', 'en', { count: '5' }));
    await button(page, 'restore.start').click();
    await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
    const restored = own(api.images).sort((a, b) => String(a.alt_text) < String(b.alt_text) ? -1 : 1);
    expect(restored.map(image => [image.width, image.height])).toEqual(photos.map(photo => [photo.width, photo.height]));
    const [first, ...others] = restored;
    const firstMain = api.files.get(String(first!.main_path))!;
    expect(firstMain.equals(Buffer.from(kept))).toBe(true);
    for (const [index, image] of others.entries()) {
      const main = api.files.get(String(image.main_path))!;
      expect(sha(main)).not.toBe(sha(Buffer.from(photos[index + 1]!.main)));
      expect(readJpegHeader(main)).toMatchObject({ width: photos[index + 1]!.width, height: photos[index + 1]!.height });
      expect(listJpegMarkers(main).filter(marker => marker === 0xe1 || marker === 0xc2 || marker === 0xdd || (marker >= 0xd0 && marker <= 0xd7))).toEqual([]);
    }
    // The stored thumbnail matches the main photo's colour, not the unrelated backup thumbnail of the same size.
    const small = api.files.get(String(first!.thumb_path))!;
    expect(readJpegHeader(small)).toMatchObject(fitDimensions(1200, 900, JPEG_LIMITS.thumbSide));
    const [mainColour, thumbColour, unrelated] = [await averageColour(page, firstMain), await averageColour(page, small),
      await averageColour(page, Buffer.from(photos[0]!.thumb))];
    const distance = (a: number[], b: number[]) => Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
    expect(distance(mainColour, thumbColour)).toBeLessThan(8);
    expect(distance(unrelated, thumbColour)).toBeGreaterThan(40);
    // The report after success: planned files kept apart from the stored ones, and every stored file the one planned.
    const done = [...byImage(await report(page)).values()];
    expect(done).toHaveLength(photos.length);
    expect(done.map(photo => [photo.planned.main, photo.outcome])).toEqual([['preserved', 'written'], ...new Array(5).fill(['reencoded', 'written'])]);
    expect(done[0]!.planned.mainSha256).toBe(sha(Buffer.from(kept)));
    for (const [index, photo] of done.entries()) {
      expect(photo.planned.sourceSha256).toBe(sha(Buffer.from(photos[index]!.main)));
      expect(photo.stored).toEqual({ mainSha256: photo.planned.mainSha256, thumbSha256: photo.planned.thumbSha256 });
      expect(restored[index]).toMatchObject({ main_sha256: photo.planned.mainSha256, thumb_sha256: photo.planned.thumbSha256 });
    }
  });

  test('a malformed, oversized or mismatched photo refuses the backup before any decoder starts, with nothing written', async ({ page }) => {
    const decodes = await countDecodes(page);
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const base = flatJpeg({ width: 64, height: 48 });
    const progressive = flatJpeg({ width: 64, height: 48, mode: 'progressive' });
    const scanAt = (bytes: Uint8Array, index: number) => findMarkers(bytes, 0xda)[index]!;
    const insert = (bytes: Uint8Array, offset: number, ...parts: Uint8Array[]) => joinBytes(bytes.subarray(0, offset), ...parts, bytes.subarray(offset));
    const dqt = findMarker(base, 0xdb), dqtEnd = dqt + 2 + base[dqt + 2]! * 256 + base[dqt + 3]!;
    const hostile: [string, Q6Photo][] = [
      ['extra bytes in the scan', q6(insert(base, base.length - 2, new Uint8Array([0x12])), 64, 48)],
      ['empty DQT', q6(joinBytes(base.subarray(0, dqt), jpegSegment(0xdb, new Uint8Array(0)), base.subarray(dqtEnd)), 64, 48)],
      ['oversized DRI', q6(insert(base, 2, jpegSegment(0xdd, new Uint8Array([0, 1, 0]))), 64, 48)],
      ['second frame', q6(insert(base, base.length - 2, jpegSegment(0xc0, new Uint8Array([8, 0, 48, 0, 64, 1, 1, 0x11, 0]))), 64, 48)],
      ['too many scans', q6(insert(progressive, progressive.length - 2,
        ...new Array<Uint8Array>(40).fill(progressive.subarray(scanAt(progressive, 3), progressive.length - 2))), 64, 48)],
      ['metadata between scans', q6(insert(progressive, scanAt(progressive, 1), exifSegment(1)), 64, 48)],
      ['MPF with a second image', q6(joinBytes(flatJpeg({ width: 64, height: 48, segments: [jpegSegment(0xe2, joinBytes(new TextEncoder().encode('MPF\0'), new Uint8Array(12)))] }),
        flatJpeg({ width: 32, height: 24 })), 64, 48)],
      ['size different from the backup', q6(base, 48, 64)],
      ['over the photo size limit', q6(flatJpeg({ width: 64, height: 48, segments: new Array<Uint8Array>(8).fill(jpegSegment(0xfe, new Uint8Array(65000))) }), 64, 48)],

      ['thumbnail hash', { ...q6(base, 64, 48), thumbSha: '0'.repeat(64) }],
      ['thumbnail length', { ...q6(base, 64, 48), thumbLength: flatThumb(64, 48).length + 1 }],
    ];
    const card = restoreCard(page);
    const before = writeUrls(urls).length;
    for (const [name, photo] of hostile) {
      const start = await decodes.count();
      // A good photo first: the refused one is later in the backup.
      await check(page, await v1Backup([q6(flatJpeg({ width: 40, height: 40 }), 40, 40), photo]));
      await expect(card.getByRole('alert'), name).toHaveText(text('restore.invalid'), slow);
      expect([name, await decodes.count()]).toEqual([name, start]);
      await button(page, 'backup.startAgain').click();
    }
    expect(writeUrls(urls)).toHaveLength(before);
    expect(own(api.items)).toEqual([]);
    expect(own(api.images)).toEqual([]);
  });

  test('a garment the restore could not save refuses the whole backup at Check, naming only its position', async ({ page }) => {
    const decodes = await countDecodes(page);
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const photo = () => q6(flatJpeg({ width: 40, height: 40 }), 40, 40);
    const card = restoreCard(page);
    for (const [name, item] of [['empty title', { title: '' }], ['unknown category', { category: 'cape' }],
      ['out-of-range value', { formality: 9 }], ['colour that is not text', { colours: [7] }]] as const) {
      const start = await decodes.count();
      await check(page, await v1Backup([photo(), { ...photo(), item }, photo()]));
      await expect(card.getByRole('alert'), name).toHaveText(text('restore.invalidGarment', 'en', { item: 2, total: 3 }), slow);
      await expect(card.getByRole('alert'), name).not.toContainText('Fictional coat');
      expect([name, await decodes.count()]).toEqual([name, start]);
      await button(page, 'backup.startAgain').click();
    }
    expect(writeUrls(urls)).toEqual([]);
    expect(own(api.items)).toEqual([]);
    expect(own(api.images)).toEqual([]);
  });

  test('a photo turned by its orientation, late in the backup, refuses it fresh and when resuming, with nothing more written', async ({ page }) => {
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const exportId = randomUUID();
    const good = [q6(flatJpeg({ width: 40, height: 40 }), 40, 40), q6(flatJpeg({ width: 48, height: 32 }), 48, 32)];
    // Orientation 6 on a non-square photo swaps its decoded size.
    const turned = q6(flatJpeg({ width: 64, height: 48, segments: [exifSegment(6)] }), 64, 48);
    const card = restoreCard(page);
    await check(page, await v1Backup([...good, turned], exportId));
    await expect(card.getByRole('alert')).toHaveText(text('restore.invalid'), slow);
    expect(writeUrls(urls)).toEqual([]);
    await button(page, 'backup.startAgain').click();
    // The same backup without that photo is partly restored, then the one with it is checked again.
    let blocked = 2;
    await page.route('**/rest/v1/rpc/reserve_restored_item_save', async route => {
      if (blocked > 0 && route.request().postData()?.includes('photo 2')) { blocked--; await route.abort('failed'); return; }
      await route.fallback();
    });
    await check(page, await v1Backup([...good, q6(flatJpeg({ width: 64, height: 48 }), 64, 48)], exportId));
    await button(page, 'restore.start').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
    // The report after a partial failure: the other two photos written with the planned files, photo 2 not.
    const partial = [...byImage(await report(page)).values()];
    expect(partial.map(photo => photo.outcome)).toEqual(['written', 'failed', 'written']);
    expect(partial[1]!.stored).toBeNull();
    for (const photo of [partial[0]!, partial[2]!]) expect(photo.stored).toEqual({ mainSha256: photo.planned.mainSha256, thumbSha256: photo.planned.thumbSha256 });
    const snapshot = structuredClone({ items: own(api.items), images: own(api.images) });
    const writes = writeUrls(urls).length;
    await button(page, 'common.cancel').click();
    await check(page, await v1Backup([...good, turned], exportId));
    await expect(card.getByRole('alert')).toHaveText(text('restore.invalid'), slow);
    expect(writeUrls(urls)).toHaveLength(writes);
    expect({ items: own(api.items), images: own(api.images) }).toEqual(snapshot);
  });

  test('a photo that no longer passes its checks while restoring stops the whole restore and asks for a new check', async ({ page }) => {
    const decodes = await countDecodes(page);
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const parts = await v1Backup([q6(flatJpeg({ width: 40, height: 40 }), 40, 40), q6(flatJpeg({ width: 48, height: 32 }), 48, 32),
      q6(flatJpeg({ width: 64, height: 48 }), 64, 48)]);
    await check(page, parts);
    const card = restoreCard(page);
    await expect(button(page, 'restore.start')).toBeVisible(slow);
    const captured = { items: own(api.items).length, images: own(api.images).length };
    // Each photo is decoded twice while restoring (its size, then its thumbnail): the second photo's first decode fails.
    await decodes.faultAfter(2);
    await button(page, 'restore.start').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.recheck'), slow);
    await expect(card.getByRole('alert')).toBeFocused();
    await expect(button(page, 'restore.start')).toHaveCount(0);
    await expect(button(page, 'restore.check')).toBeVisible();
    // The first photo was written and verified; nothing after the failure was.
    expect(captured).toEqual({ items: 0, images: 0 });
    expect(own(api.items)).toHaveLength(1);
    expect(own(api.images)).toEqual([expect.objectContaining({ state: 'ready', width: 40, height: 40 })]);
    expect(writeUrls(urls).filter(url => url.includes('reserve_restored_item_save'))).toHaveLength(1);
    // The report after the stop keeps what was written: the photos not reached are not written.
    expect([...byImage(await report(page)).values()].map(photo => photo.outcome)).toEqual(['written', 'failed', 'skipped']);
    // Checked again, the restore continues from there.
    await decodes.faultAfter(1_000_000);
    await button(page, 'restore.check').click();
    await expect(card.getByText(text('restore.same', 'en', { n: '1' }))).toBeVisible(slow);
    await button(page, 'restore.start').click();
    await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
    expect(own(api.items)).toHaveLength(3);
  });

  test('a thumbnail or re-encoded photo that would come out different after Check stops before anything is reserved', async ({ page }) => {
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const card = restoreCard(page);
    const reserves = () => writeUrls(urls).filter(url => /reserve_/.test(url)).length;
    // A kept photo whose new thumbnail changes, then a re-encoded photo whose main file changes.
    for (const [which, photo] of [['thumbnail', q6(flatJpeg({ width: 1200, height: 900 }), 1200, 900)],
      ['main', q6(flatJpeg({ width: 640, height: 480, mode: 'progressive' }), 640, 480)]] as const) {
      await driftEncoder(page, 'none');
      await check(page, await v1Backup([photo]));
      await expect(button(page, 'restore.start')).toBeVisible(slow);
      await driftEncoder(page, which);
      await button(page, 'restore.start').click();
      await expect(card.getByRole('alert'), which).toHaveText(text('restore.recheck'), slow);
      await expect(button(page, 'restore.start')).toHaveCount(0);
      expect([which, reserves()]).toEqual([which, 0]);
      const [stopped] = byImage(await report(page)).values();
      expect(stopped).toMatchObject({ outcome: 'failed', stored: null, planned: { main: which === 'thumbnail' ? 'preserved' : 'reencoded' } });
    }
    expect(own(api.items)).toEqual([]);
    expect(own(api.images)).toEqual([]);
  });

  test('photos are read from the chosen files again while restoring, even from a part Check already read', async ({ page }) => {
    const { api, urls } = await start(page);
    await settings(page, 'b');
    const card = restoreCard(page);
    const exportId = randomUUID();
    const first = q6(flatJpeg({ width: 40, height: 40 }), 40, 40);
    // Both photos are in the same part, which Check has already read and decrypted.
    const parts = await v1Backup([first, q6(flatJpeg({ width: 48, height: 32 }), 48, 32)], exportId);
    const changed = await v1Backup([first, q6(flatJpeg({ width: 48, height: 32, colour: [20, 90, 200] }), 48, 32)], exportId);
    const swap = (mode: 'fail' | 'other' | 'file', other = '') => page.evaluate(({ mode, other }) => {
      const state = window as unknown as { __q6Text?: typeof Blob.prototype.text; __q6Reads: number };
      state.__q6Text ??= Blob.prototype.text;
      state.__q6Reads = 0;
      const original = state.__q6Text;
      Blob.prototype.text = function () {
        state.__q6Reads++;
        if (mode === 'fail') return Promise.reject(new DOMException('The file could not be read.', 'NotReadableError'));
        return mode === 'other' ? Promise.resolve(other) : original.call(this);
      };
    }, { mode, other });
    const reads = () => page.evaluate(() => (window as unknown as { __q6Reads: number }).__q6Reads);
    // The file can no longer be read.
    await check(page, parts);
    await expect(button(page, 'restore.start')).toBeVisible(slow);
    await swap('fail');
    await button(page, 'restore.start').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.recheck'), slow);
    expect(await reads()).toBeGreaterThan(0);
    expect(writeUrls(urls)).toEqual([]);
    // The file now holds another photo 2 under the same backup: photo 1 is written, then the restore stops.
    await swap('file');
    await button(page, 'restore.check').click();
    await expect(button(page, 'restore.start')).toBeVisible(slow);
    await swap('other', changed[0]!.buffer.toString('utf8'));
    await button(page, 'restore.start').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.recheck'), slow);
    expect(await reads()).toBeGreaterThanOrEqual(2);
    expect(writeUrls(urls).filter(url => url.includes('reserve_restored_item_save'))).toHaveLength(1);
    expect(own(api.images)).toEqual([expect.objectContaining({ width: 40, height: 40, state: 'ready' })]);
    expect([...byImage(await report(page)).values()].map(photo => photo.outcome)).toEqual(['written', 'failed']);
  });

  test('an item reserved with other photo files is blocked: never overwritten, dependents held and the restore reported incomplete', async ({ page }) => {
    const { api, thumb } = await start(page);
    const shirt = seed(api, thumb, 'Fictional linen shirt');
    const trousers = seed(api, thumb, 'Fictional wool trousers');
    seedHistory(api, shirt.item, trousers.item);
    await settings(page, 'a');
    const parts = await backup(page);
    await signOut(page);
    await settings(page, 'b');
    // The shirt's first photo is reserved but its upload never arrives, on both attempts.
    let failures = 2;
    await page.route('**/storage/v1/object/wardrobe/**', async route => {
      if (route.request().method() === 'POST' && failures > 0) { failures--; await route.abort('failed'); return; }
      await route.fallback();
    });
    await check(page, parts);
    await button(page, 'restore.start').click();
    const card = restoreCard(page);
    await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
    // That reservation was made with other files, as an earlier version that re-encoded every photo would have.
    const pending = own(api.images).find(image => image.state === 'pending')!;
    Object.assign(pending, { thumb_sha256: 'e'.repeat(64), thumb_bytes: 1234 });
    const before = structuredClone({ items: own(api.items), images: own(api.images) });
    await button(page, 'restore.again').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.incomplete'), slow);
    await expect(card.getByRole('alert')).toBeFocused();
    await expect(card).toContainText(text('restore.blocked', 'en', { n: '1' }));
    await expect(button(page, 'restore.again')).toHaveCount(0);
    const pendingAfter = own(api.images).find(image => image.id === pending.id)!;
    expect(pendingAfter).toEqual(before.images.find(image => image.id === pending.id));
    expect(own(api.items).map(row => row.id).sort()).toEqual(before.items.map(row => row.id).sort());
    for (const rows of [api.outfits, api.outfitItems, api.combinationRules, api.suggestionFeedback, api.wearEvents]) expect(own(rows)).toEqual([]);
    await button(page, 'backup.finish').click();
    await expect(button(page, 'restore.open')).toBeVisible();
  });
});