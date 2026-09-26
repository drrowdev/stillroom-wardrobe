// I26 release journey: the owner's ten release steps in one sitting, on fictional data and the browser mock backend. This
// is the browser half of the release check; the backend half is the local restore drill (tests/integration). Step 10,
// the VoiceOver/TalkBack pass on the owner's phone, is an owner device gate and is only recorded here, never passed.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { verifyParts, type JpegCheck } from '../../src/domain/export-format';
import { translate, type MessageKey } from '../../src/i18n';
import { assertSanitizedJpeg, readJpegHeader } from '../../src/images/jpeg';
import { addAiPhoto, aiFixture } from './ai-photo-first-support';
import { owners } from './mock-backend';

type Row = Record<string, unknown>;
const lang = 'fi' as const;
const text = (key: MessageKey, parameters?: Record<string, string | number>) => translate(lang, key, parameters);
const button = (page: Page, key: MessageKey, parameters?: Record<string, string | number>) =>
  page.getByRole('button', { name: text(key, parameters), exact: true });
const navLink = (page: Page, key: 'nav.today' | 'nav.wardrobe' | 'nav.outfits') =>
  page.locator('.workspace-header nav').getByRole('link', { name: text(key), exact: true });
const passphrase = 'fictional release passphrase 10';
const checkJpeg: JpegCheck = (bytes, _variant, width, height) => {
  const header = readJpegHeader(bytes);
  if (header.width !== width || header.height !== height) throw new Error('Unexpected fixture size.');
  assertSanitizedJpeg(bytes, width, height);
};
const shirt = 'Vihreä pellavapaita', trousers = 'Laivastonsiniset housut', outfitName = 'Perjantai';

test('I26 release journey: the owner\'s ten steps on fictional data', async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  testInfo.annotations.push({ type: 'owner gate', description: 'Step 10: VoiceOver (iPhone) and TalkBack (Android) pass on the owner\'s phones.' });
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });

  let api!: Awaited<ReturnType<typeof aiFixture>>;
  await test.step('1. sign in', async () => {
    // The fixture opens the app and signs in as the fictional owner A.
    api = await aiFixture(page, 'en');
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const seeded = api.seedSavedItem('a', trousers);
    Object.assign(seeded.item as Row, { category: 'bottom', colours: ['navy'] });
    Object.assign(seeded.image as Row, { width: 2, height: 2 });
  });

  await test.step('2. set the language', async () => {
    await page.getByRole('button', { name: translate('en', 'account.menu') }).click();
    await page.getByRole('button', { name: 'Suomi', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect.poll(() => api.profiles[owners.a]?.ui_language).toBe(lang);
    const menu = page.getByRole('button', { name: text('account.menu') });
    if (await menu.getAttribute('aria-expanded') === 'true') await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  await test.step('3. add an item from a photo, edit a field and Save', async () => {
    await addAiPhoto(page, api, lang);
    await expect(page.locator('#item-category')).not.toHaveValue('', { timeout: 30_000 });
    await expect(page.locator('#item-title')).not.toHaveValue('');
    expect(api.items.map(row => row.title)).toEqual([trousers]);
    await page.locator('#item-title').fill(shirt);
    await button(page, 'capture.save').click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const saved = api.items.find(row => row.title === shirt);
    expect(saved).toBeTruthy();
    expect(saved!.field_provenance).toMatchObject({ title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 } });
    expect(api.calls.filter(call => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    await expect(page.locator('.item-card')).toHaveCount(2);
  });

  await test.step('4. search', async () => {
    await page.locator('#wardrobe-search').fill('pellava');
    await expect(page.locator('.item-caption h2')).toHaveText([shirt]);
    await page.locator('#wardrobe-search').fill('');
    await expect(page.locator('.item-card')).toHaveCount(2);
  });

  await test.step('5. create an outfit and reorder it', async () => {
    await navLink(page, 'nav.outfits').click();
    await expect(page.locator('#outfits-title')).toBeFocused();
    await button(page, 'outfits.create').first().click();
    await expect(page.locator('#outfit-editor-title')).toBeFocused();
    for (const name of [shirt, trousers]) await page.getByRole('button', { name: text('a11y.selectItem', { name }), exact: true }).click();
    await expect(page.locator('.outfit-slot')).toHaveCount(2);
    const down = page.getByRole('button', { name: text('a11y.moveDown', { name: shirt }), exact: true });
    await down.focus(); await down.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: text('outfits.moved', { name: shirt, position: 2 }) })).toBeAttached();
    await expect(page.locator('.outfit-slot').nth(0)).toContainText(trousers);
    await page.locator('#outfit-name').fill(outfitName);
    await button(page, 'outfits.saveOutfit').click();
    await expect(page.locator('#outfit-detail-title')).toHaveText(outfitName);
    const ids = [api.items.find(row => row.title === trousers)!.id, api.items.find(row => row.title === shirt)!.id];
    expect(api.outfitItems.filter(link => link.owner_id === owners.a).map(link => [link.item_id, link.position])).toEqual([[ids[0], 0], [ids[1], 1]]);
  });

  await test.step('6. open Today', async () => {
    await navLink(page, 'nav.today').click();
    await expect(page.locator('#today-title')).toHaveText(text('today.title'));
    await expect(navLink(page, 'nav.today')).toHaveAttribute('aria-current', 'page');
  });

  await test.step('7. create a backup and verify it', async () => {
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#settings-title')).toBeVisible();
    const card = page.locator('.backup-card');
    await button(page, 'backup.create').click();
    await card.getByLabel(text('backup.passphrase'), { exact: true }).fill(passphrase);
    await card.getByLabel(text('backup.repeat'), { exact: true }).fill(passphrase);
    await button(page, 'backup.create').click();
    const parts = card.locator('.backup-parts li');
    await expect(parts.first()).toBeVisible({ timeout: 60_000 });
    const count = await parts.count();
    const texts: string[] = [];
    for (let index = 0; index < count; index++) {
      const pending = page.waitForEvent('download');
      await button(page, 'backup.part', { n: index + 1, total: count }).click();
      texts.push(await readFile((await (await pending).path())!, 'utf8'));
    }
    const summary = await verifyParts(texts, passphrase, checkJpeg);
    expect(summary).toMatchObject({ parts: count, items: 2, photos: 2 });
    expect(summary.metadata.tables.items.map(row => row.title).sort()).toEqual([trousers, shirt].sort());
    expect(summary.metadata.tables.outfits.map(row => row.title)).toEqual([outfitName]);
    await button(page, 'backup.finish').click();
  });

  await test.step('8. offline notice', async () => {
    await context.setOffline(true);
    await expect(page.locator('.notice-offline')).toContainText(text('common.offline'));
    await context.setOffline(false);
    await expect(page.locator('.notice-offline')).toHaveCount(0);
  });

  await test.step('9. sign out; nothing private is shown when the app is opened again', async () => {
    await page.getByRole('button', { name: text('account.menu') }).click();
    await page.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    const leaks = async () => page.evaluate(values => {
      const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      return values.filter(value => document.body.innerText.includes(value) || stored.includes(value));
    }, [shirt, trousers, outfitName]);
    expect(await leaks()).toEqual([]);
    await page.goto('/');
    await expect(page.locator('#email')).toBeVisible();
    expect(await leaks()).toEqual([]);
    expect(await page.evaluate(async () => ('caches' in window ? (await caches.keys()).length : 0))).toBe(0);
  });

  expect(errors).toEqual([]);
});
