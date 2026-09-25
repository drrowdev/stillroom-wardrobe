import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { verifyParts, type JpegCheck } from '../../src/domain/export-format';
import { assertSanitizedJpeg, readJpegHeader } from '../../src/images/jpeg';
import { mockBackend, signIn } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) =>
  page.getByRole('button', { name: text(key, language, parameters), exact: true });
const card = (page: Page) => page.locator('.backup-card');
const passphrase = 'fictional backup passphrase 42';
const checkJpeg: JpegCheck = (bytes, _variant, width, height) => {
  const header = readJpegHeader(bytes);
  if (header.width !== width || header.height !== height) throw new Error('Unexpected fixture size.');
  assertSanitizedJpeg(bytes, width, height);
};

function add(api: Api, title: string, account: 'a' | 'b' = 'a') {
  const seeded = api.seedSavedItem(account, title);
  Object.assign(seeded.image as Row, { width: 2, height: 2 });
  return seeded;
}
async function start(page: Page, options: { language?: Language; seed?: (api: Api) => void } = {}) {
  const api = await mockBackend(page, { initialLanguage: options.language ?? 'en' });
  options.seed?.(api);
  const bodies: string[] = [];
  page.on('request', request => { bodies.push(request.url(), request.postData() ?? ''); });
  await page.goto('/#/settings'); await signIn(page);
  await expect(page.locator('#settings-title')).toBeVisible();
  return { api, bodies };
}
async function fill(page: Page, first = passphrase, second = first, language: Language = 'en') {
  const field = card(page).getByLabel(text('backup.passphrase', language), { exact: true });
  if (!await field.isVisible()) {
    await button(page, 'backup.create', language).click();
    await expect(field).toBeFocused();
  }
  await card(page).getByLabel(text('backup.passphrase', language), { exact: true }).fill(first);
  await card(page).getByLabel(text('backup.repeat', language), { exact: true }).fill(second);
}
async function download(page: Page, action: () => Promise<void>): Promise<Download> {
  const pending = page.waitForEvent('download');
  await action();
  return pending;
}
async function contents(item: Download) { return readFile((await item.path())!, 'utf8'); }

test('I18 backup: every part downloads, decrypts offline and holds only saved data', async ({ page }) => {
  const { api, bodies } = await start(page, { seed: api => {
    const shirt = add(api, 'Fictional linen shirt');
    add(api, 'Fictional wool trousers');
    const draft = api.seedSavedItem('a', 'Unsaved draft');
    Object.assign(draft.image as Row, { state: 'pending' });
    add(api, 'Robin coat', 'b');
    api.exportControl.attributions.set(String(shirt.item.id), [{ source_image_id: shirt.image.id, image_sha256: shirt.image.main_sha256,
      model_id: 'fixture-model', prompt_version: 1, fields: { title: 'Fictional linen shirt' } }]);
  } });
  await fill(page);
  await button(page, 'backup.create').click();
  const parts = card(page).locator('.backup-parts li');
  await expect(parts).toHaveCount(2);
  const texts: string[] = [];
  const names: string[] = [];
  for (let index = 0; index < 2; index++) {
    const item = await download(page, () => button(page, 'backup.part', 'en', { n: index + 1, total: 2 }).click());
    names.push(item.suggestedFilename());
    texts.push(await contents(item));
    await expect(parts.nth(index)).toContainText(text('backup.partDone'));
  }
  const summary = await verifyParts(texts, passphrase, checkJpeg);
  expect(names).toEqual([0, 1].map(index => `stillroom-${summary.exportId}-${index}.json.enc`));
  expect(summary).toMatchObject({ parts: 2, items: 2, photos: 2 });
  expect(summary.metadata.tables.items.map(row => row.title).sort()).toEqual(['Fictional linen shirt', 'Fictional wool trousers']);
  expect(summary.metadata.tables.item_attributions).toEqual([expect.objectContaining({ model_id: 'fixture-model', source_image_excluded: false })]);
  expect(summary.metadata.tables.profiles[0]).not.toHaveProperty('weather_enabled');
  expect(JSON.stringify(summary.metadata)).not.toContain('Robin');
  await expect(card(page).getByRole('status')).toHaveText(text('backup.done', 'en', { items: '2 items', photos: '2 photos' }));
  expect(api.exportControl.manifests).toBe(2);
  expect(bodies.some(body => body.includes(passphrase))).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(passphrase);
  await button(page, 'backup.finish').click();
  await expect(card(page).getByLabel(text('backup.passphrase'), { exact: true })).toHaveCount(0);
});

test('I18 backup: a photo that changed after the snapshot stops the backup', async ({ page }) => {
  const { api } = await start(page, { seed: api => { add(api, 'Fictional linen shirt'); } });
  await fill(page);
  await button(page, 'backup.create').click();
  await expect(card(page).locator('.backup-parts li')).toHaveCount(2);
  const image = api.images[0]!;
  api.files.set(String(image.main_path), Buffer.concat([api.files.get(String(image.main_path))!, Buffer.from([0])]));
  await button(page, 'backup.part', 'en', { n: 2, total: 2 }).click();
  await expect(card(page).getByRole('alert')).toHaveText(text('backup.changed'));
  await expect(card(page).getByRole('alert')).toBeFocused();
  await button(page, 'backup.startAgain').click();
  await expect(card(page).getByLabel(text('backup.passphrase'), { exact: true })).toHaveCount(0);
});

test('I18 backup: an item that changes while the backup is prepared stops it', async ({ page }) => {
  const { api } = await start(page, { seed: api => { add(api, 'Fictional linen shirt'); } });
  api.exportControl.beforeAttribution = () => { api.items[0]!.title = 'Renamed meanwhile'; api.exportControl.beforeAttribution = null; };
  await fill(page);
  await button(page, 'backup.create').click();
  await expect(card(page).getByRole('alert')).toHaveText(text('backup.changed'));
  await expect(card(page).locator('.backup-parts')).toHaveCount(0);
});

test('I18 backup: passphrase checks, offline, and the plain JSON download', async ({ page, context }) => {
  const { api } = await start(page, { seed: api => { add(api, 'Fictional linen shirt'); } });
  await fill(page, 'too short');
  await button(page, 'backup.create').click();
  await expect(card(page).getByRole('alert')).toHaveText(text('backup.short'));
  await fill(page, passphrase, `${passphrase}!`);
  await button(page, 'backup.create').click();
  await expect(card(page).getByRole('alert')).toHaveText(text('backup.mismatch'));
  expect(api.exportControl.manifests).toBe(0);
  await context.setOffline(true);
  await expect(button(page, 'backup.create')).toBeDisabled();
  await expect(button(page, 'backup.json')).toBeDisabled();
  await expect(card(page)).toContainText(text('backup.offline'));
  await context.setOffline(false);
  const item = await download(page, () => button(page, 'backup.json').click());
  expect(item.suggestedFilename()).toMatch(/^stillroom-[0-9a-f-]{36}\.json$/);
  const plain = JSON.parse(await contents(item)) as { format: string; tables: Record<string, Row[]> };
  expect(plain.format).toBe('stillroom-saved');
  expect(plain.tables.items!.map(row => row.title)).toEqual(['Fictional linen shirt']);
  expect(plain.tables.profiles![0]).not.toHaveProperty('weather_enabled');
  expect(JSON.stringify(plain)).not.toContain('base64');
});

test('I18 backup: signing out drops the prepared backup and the passphrase', async ({ page }) => {
  await start(page, { seed: api => { add(api, 'Fictional linen shirt'); add(api, 'Robin coat', 'b'); } });
  await fill(page);
  await button(page, 'backup.create').click();
  await expect(card(page).locator('.backup-parts li')).toHaveCount(2);
  await page.getByRole('button', { name: text('account.menu') }).click();
  await page.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(card(page).locator('.backup-parts')).toHaveCount(0);
  await expect(card(page).getByLabel(text('backup.passphrase', 'sv'), { exact: true })).toHaveCount(0);
});

test('I18 accessibility: axe, 320px and 200% text for the backup card', async ({ page }) => {
  await start(page, { seed: api => { add(api, 'Fictional linen shirt'); } });
  const axe = async () => expect((await new AxeBuilder({ page }).include('.backup-card').analyze()).violations).toEqual([]);
  await axe();
  await fill(page, 'short');
  await button(page, 'backup.create').click();
  await expect(card(page).getByRole('alert')).toBeFocused();
  await axe();
  await fill(page);
  await card(page).getByLabel(text('backup.repeat'), { exact: true }).press('Enter');
  await expect(card(page).locator('.backup-parts li')).toHaveCount(2);
  await axe();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe();
  }
});

test.describe('bounded P6a visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'backup', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'backup-parts', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' },
  ] as const;
  for (const selected of scenes) test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
    const language: Language = selected.language;
    const write = testInfo.project.name === selected.project;
    const directory = path.resolve('test-results/p6a-visual');
    if (write) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    }
    await page.setViewportSize({ width: selected.width, height: 900 });
    await start(page, { language, seed: api => { add(api, 'Fictional linen shirt'); } });
    if (selected.scene === 'backup-parts') {
      await fill(page, passphrase, passphrase, language);
      await button(page, 'backup.create', language).click();
      await expect(card(page).locator('.backup-parts li')).toHaveCount(2);
    } else {
      await expect(button(page, 'backup.create', language)).toBeEnabled();
    }
    await card(page).scrollIntoViewIfNeeded();
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
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  });
});
