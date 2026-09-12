import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { garmentFields } from '../../src/domain/garment-fields';
import { provenanceFields } from '../../src/domain/attribute-provenance';
import { mockBackend, owners, signIn } from './mock-backend';
import { manualEntry } from './ai-photo-first-support';

async function setup(page: Page, language: Language = 'en', loseFinalizeReplyOnce = false) {
  const api = await mockBackend(page, { initialLanguage: language, loseFinalizeReplyOnce });
  await page.goto('/'); await signIn(page);
  await page.getByRole('button', { name: messages['wardrobe.add'][language], exact: true }).first().click();
  return api;
}
async function expand(page: Page, prefix: 'item' | 'detail') {
  await expect(page.locator(`#${prefix}-title`)).toBeVisible();
  const selector = prefix === 'item' ? '.capture-page details' : '.detail-name details';
  await page.locator(selector).evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  for (const button of await page.locator(`${prefix === 'item' ? '.capture-page' : '.detail-name'} .garment-toggle`).all()) {
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  }
}
async function photo(page: Page, api: Awaited<ReturnType<typeof mockBackend>>) {
  await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect(page.locator('#edit-photo')).toBeEnabled();
  await manualEntry(page);
}
async function fillFields(page: Page, language: Language) {
  const text = {
    title: 'Å manual overshirt 🌿', subcategory: 'Overshirt', brand: 'Fictional brand', size_label: 'M',
    material: 'Cotton', formality: '2', warmth: '3', min_temp: '-5', max_temp: '20', rain_rating: '1',
    upper_coverage: '2', lower_coverage: '0', purchase_date: '2024-02-29',
    purchase_price: language === 'en' ? '1,234.50' : '1 234,50', notes: '  Oma teksti\nEgen text  ', currency: 'USD',
  };
  for (const [key, value] of Object.entries(text)) await page.locator(`#item-${key}`).fill(value);
  const selections = { category: 'layer', pattern: 'checked', sleeve_length: 'long', garment_length: 'regular',
    windproof: 'false', favourite: 'true', availability: 'laundry', lifecycle: 'archived', exclude_suggestions: 'true', wear_more: 'true' };
  for (const [key, value] of Object.entries(selections)) await page.locator(`#item-${key}`).selectOption(value);
  for (const [key, value] of [['colours', 'olive'], ['seasons', 'autumn']]) await page.locator(`#item-${key} select`).selectOption(value!);
  for (const [key, value] of [['style_tags', 'calm'], ['tags', 'weekday']]) {
    await page.locator(`#item-${key}`).getByRole('button').click();
    await page.locator(`#item-${key} input`).fill(value!);
  }
  await page.locator('#item-alt').fill('  Fictional prepared overshirt  ');
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`blank photo description ${language}: truthful help, empty stored alt and named library link`, async ({ page }) => {
    const api = await setup(page, language);
    await photo(page, api);
    await expand(page, 'item');
    await expect(page.getByText(messages['capture.descriptionHelp'][language], { exact: true })).toBeVisible();
    await page.locator('#item-title').fill('Fictional shirt');
    await page.locator('#item-category').selectOption('top');
    await expect(page.locator('#item-alt')).toHaveValue('');
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.images[0]!.alt_text).toBe('');
    const link = page.locator(`a[href="#/items/${api.items[0]!.id}"]`);
    await expect(link.locator('img')).toHaveAttribute('alt', '');
    await expect(link).toHaveAccessibleName(`Fictional shirt ${messages['category.top'][language]}`);
    await link.click();
    await expect(page.locator('.detail-photo img')).toHaveAttribute('alt', '');
    await expect(page.locator('#detail-description')).toHaveValue('');
  });
  test(`all thirty manual fields ${language}: exact explicit capture Save, owned edit and clear`, async ({ page }) => {
    const api = await setup(page, language);
    const foreign = api.seedSavedItem('b'), originalForeign = structuredClone(foreign);
    const profiles = structuredClone(api.profiles);
    await photo(page, api);
    await expand(page, 'item');
    await fillFields(page, language);
    expect(api.items).toHaveLength(1);
    expect(api.images).toHaveLength(1);
    const count = api.files.size;
    for (const field of garmentFields) {
      await page.locator(`#item-${field}`).focus();
      await expect(page.locator(`#item-${field}`)).toBeFocused();
    }
    expect(api.files.size).toBe(count);
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const item = api.items.find((row) => row.owner_id === owners.a)!;
    const image = api.images.find((row) => row.owner_id === owners.a)!;
    expect(item).toMatchObject({ title: 'Å manual overshirt 🌿', category: 'layer', colours: ['olive'], seasons: ['autumn'],
      purchase_price: 1234.5, currency: 'USD', windproof: false, lower_coverage: 0,
      notes: '  Oma teksti\nEgen text  ', favourite: true, availability: 'laundry', lifecycle: 'archived' });
    expect(Object.keys(item.field_provenance as object)).toHaveLength(24);
    for (const field of provenanceFields) expect((item.field_provenance as Record<string, unknown>)[field]).toEqual({ kind: 'user', revision: 1 });
    expect(image.alt_text).toBe('Fictional prepared overshirt');
    const bytes = [...api.files].map(([key, buffer]) => [key, createHash('sha256').update(buffer).digest('hex')]);
    for (const variant of ['main', 'thumb']) {
      const buffer = api.files.get(String(image[`${variant}_path`]))!;
      expect(createHash('sha256').update(buffer).digest('hex')).toBe(image[`${variant}_sha256`]);
      expect(buffer.byteLength).toBe(image[`${variant}_bytes`]);
    }
    await page.locator(`a[href="#/items/${item.id}"]`).click();
    await expand(page, 'detail');
    await page.locator('#detail-description').fill('Sibling draft');
    for (const field of provenanceFields.filter((key) => key !== 'title' && key !== 'category')) {
      await page.locator(`#detail-${field}`).locator('xpath=..').getByRole('button', { name: new RegExp(`^${language === 'en' ? 'Clear' : language === 'fi' ? 'Tyhjennä' : 'Rensa'} `) }).click();
    }
    await page.locator('#detail-title').fill('Corrected name');
    await page.locator('#detail-category').selectOption('top');
    for (const [key, value] of [['currency', 'EUR'], ['favourite', 'false'], ['availability', 'ready'], ['lifecycle', 'active'], ['exclude_suggestions', 'false'], ['wear_more', 'false']]) {
      if (key === 'currency') await page.locator(`#detail-${key}`).fill(value!);
      else await page.locator(`#detail-${key}`).selectOption(value!);
    }
    await page.getByRole('button', { name: messages['detail.saveName'][language], exact: true }).click();
    await expect(page.getByText(messages['detail.nameSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#detail-description')).toHaveValue('Sibling draft');
    expect(item).toMatchObject({ colours: [], seasons: [], notes: '', material: null, purchase_price: null, purchase_date: null,
      warmth: null, windproof: null, currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active' });
    for (const field of provenanceFields) expect((item.field_provenance as Record<string, unknown>)[field]).toEqual({ kind: 'user', revision: 2 });
    await page.getByRole('button', { name: messages['detail.saveDescription'][language], exact: true }).click();
    await expect(page.getByText(messages['detail.descriptionSaved'][language], { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('#detail-title')).toHaveValue('Corrected name');
    await expect(page.locator('#detail-description')).toHaveValue('Sibling draft');
    expect(foreign).toEqual(originalForeign);
    expect(api.profiles).toEqual(profiles);
    expect([...api.files].map(([key, buffer]) => [key, createHash('sha256').update(buffer).digest('hex')])).toEqual(bytes);
  });
}
for (const language of ['fi', 'sv'] as const) {
  test(`equivalent saved formats ${language}: no write or discard, independent description draft`, async ({ page }) => {
    const api = await mockBackend(page, { initialLanguage: language });
    const { item, image } = api.seedSavedItem();
    Object.assign(item, { purchase_price: 12.5, min_temp: 7,
      field_provenance: Object.fromEntries(['title', 'purchase_price', 'min_temp'].map((field) => [field, { kind: 'user', revision: 1 }])) });
    const original = structuredClone(item);
    await page.goto('/'); await signIn(page);
    const link = page.locator(`a[href="#/items/${item.id}"]`);
    await link.click(); await expand(page, 'detail');
    const notice = page.getByText(messages['detail.noChanges'][language], { exact: true });
    await expect(notice).toHaveCount(0);
    await expect(page.locator('#detail-purchase_price')).toHaveValue('12.50');
    const requestStart = api.requests.length;
    await page.locator('#detail-purchase_price').fill('12,50');
    await page.locator('#detail-min_temp').fill('007');
    await page.locator('#detail-title').fill(`  ${item.title}  `);
    for (const field of ['purchase_price', 'min_temp', 'title']) {
      await expect(page.locator(`#detail-${field}`)).toHaveAttribute('aria-invalid', 'false');
    }
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.locator('.detail-name [role="alert"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: messages['detail.saveName'][language], exact: true })).toBeDisabled();
    await page.locator('.detail-name form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect(page.locator('#detail-purchase_price')).toHaveValue('12,50');
    await expect(page.locator('#detail-min_temp')).toHaveValue('007');
    await expect(page.locator('#detail-title')).toHaveValue(`  ${item.title}  `);
    await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.requests.slice(requestStart).filter((request) => request.path.startsWith('/rest/') && request.method !== 'GET')).toEqual([]);
    expect(item).toEqual(original);

    await link.click(); await expand(page, 'detail');
    await page.locator('#detail-purchase_price').fill('12,50');
    await page.locator('#detail-description').fill('Independent description');
    await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: messages['common.continueEditing'][language], exact: true }).click();
    await expect(page.locator('#detail-purchase_price')).toHaveValue('12,50');
    await expect(page.locator('#detail-description')).toHaveValue('Independent description');
    await expect(notice).toBeVisible();
    await page.getByRole('button', { name: messages['detail.saveDescription'][language], exact: true }).click();
    await expect(page.getByText(messages['detail.descriptionSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#detail-purchase_price')).toHaveValue('12,50');
    await expect(notice).toBeVisible();
    expect(image.alt_text).toBe('Independent description');
    expect(item).toEqual(original);
    expect(api.requests.slice(requestStart).filter((request) => request.path.startsWith('/rest/') && request.method !== 'GET')
      .map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/rest/v1/rpc/update_image_description', method: 'POST' }]);
    await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
test('invalid saved input, manual confirmations and explicit empty clears remain protected, not formatting notices', async ({ page }) => {
  const api = await mockBackend(page);
  const { item } = api.seedSavedItem();
  Object.assign(item, { purchase_price: 12.5, field_provenance: { purchase_price: { kind: 'user', revision: 1 }, notes: { kind: 'user', revision: 1 } } });
  await page.goto('/'); await signIn(page);
  await page.locator(`a[href="#/items/${item.id}"]`).click(); await expand(page, 'detail');
  const notice = page.getByText(messages['detail.noChanges'].en, { exact: true });
  const save = page.getByRole('button', { name: messages['detail.saveName'].en, exact: true });
  for (const [field, raw, original] of [['purchase_price', '12.', '12.50'], ['min_temp', '51', '']] as const) {
    await page.locator(`#detail-${field}`).fill(raw);
    await expect(page.locator(`#detail-${field}`)).toHaveAttribute('aria-invalid', 'true');
    await expect(notice).toHaveCount(0); await expect(save).toBeDisabled();
    await page.getByRole('button', { name: messages['common.back'].en, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
    await expect(page.locator(`#detail-${field}`)).toHaveValue(raw);
    await page.locator(`#detail-${field}`).fill(original);
  }
  await page.locator('#detail-title').fill(` ${item.title} `);
  await expect(save).toBeEnabled(); await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: messages['item.clearField'].en.replace('{field}', messages['item.notes'].en), exact: true }).click();
  await expect(save).toBeEnabled(); await expect(notice).toHaveCount(0);
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/rest/v1/items?*', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    await pending; await route.abort('failed');
  });
  await save.click();
  await expect(page.locator('#detail-title')).toBeDisabled();
  await expect(notice).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: messages['detail.check'].en, exact: true })).toBeVisible();
  await expect(page.locator('#detail-title')).toBeDisabled();
  await expect(notice).toHaveCount(0);
  expect(item.version).toBe(1);
});
test('unknown defaults, invalid raw input and manual empty clears remain distinct', async ({ page }) => {
  const api = await setup(page);
  expect(api.items).toHaveLength(0);
  await photo(page, api);
  await page.locator('#item-title').fill('🌿'.repeat(100));
  await page.locator('#item-category').selectOption('top');
  await expand(page, 'item');
  await page.locator('#item-warmth').fill('invalid');
  await page.locator('[aria-controls="item-seasons-group"]').click();
  await expect(page.locator('details.optional-details summary')).toHaveCount(1);
  await page.locator('details.optional-details summary').click();
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#item-warmth')).toBeFocused();
  await expect(page.locator('#item-warmth')).toHaveValue('invalid');
  expect(api.items).toHaveLength(0);
  await page.getByRole('button', { name: messages['item.clearField'].en.replace('{field}', messages['item.warmth'].en), exact: true }).click();
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]).toMatchObject({ colours: [], seasons: [], warmth: null, rain_rating: null, windproof: null,
    field_provenance: { title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 }, warmth: { kind: 'user', revision: 1 } } });
  expect(Object.keys(api.items[0]!.field_provenance as object)).toHaveLength(3);
  expect(api.images[0]!.alt_text).toBe('');
});
test('price entry locale and raw incomplete text survive language changes', async ({ page }) => {
  await setup(page);
  await expand(page, 'item');
  await page.locator('#item-purchase_price').fill('1,234.50');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await expect(page.locator('#item-purchase_price')).toHaveValue('1,234.50');
  await expect(page.locator('#item-purchase_price')).toHaveAttribute('aria-invalid', 'false');
  await page.locator('#item-purchase_price').fill('0,10');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await expect(page.locator('#item-purchase_price')).toHaveValue('0,10');
  await expect(page.locator('#item-purchase_price')).toHaveAttribute('aria-invalid', 'false');
  await page.locator('#item-purchase_price').fill('1.');
  await expect(page.locator('#item-purchase_price')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#item-purchase_price')).toHaveValue('1.');
});
test('synchronous capture latch and ambiguous commit retry retain full values, ids and actual bytes', async ({ page }) => {
  const api = await setup(page);
  await photo(page, api); await expand(page, 'item'); await fillFields(page, 'en');
  let commits = 0;
  await page.route('**/rest/v1/rpc/finalize_item_save', async (route) => {
    commits++;
    if (commits === 1) await route.abort('failed'); else await route.fallback();
  });
  await page.locator('.capture-layout').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
  expect(api.items).toHaveLength(1); expect(api.images).toHaveLength(1); expect(commits).toBe(1);
  const item = structuredClone(api.items[0]), image = structuredClone(api.images[0]);
  const bytes = [...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]);
  await expect(page.locator('#item-notes')).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items).toEqual([item]);
  expect(api.images[0]).toMatchObject({ id: image!.id, item_id: item!.id, state: 'ready' });
  expect([...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')])).toEqual(bytes);
  expect(commits).toBe(2);
  expect(api.requests.filter((request) => request.path === '/rest/v1/rpc/reserve_item_save')).toHaveLength(2);
  expect(api.requests.some((request) => request.method === 'POST'
    && ['/rest/v1/items', '/rest/v1/item_images', '/rest/v1/rpc/commit_image'].includes(request.path))).toBe(false);
});
for (const change of ['unchanged', 'missing main', 'missing thumb', 'caption', 'same-caption counter', 'item version', 'deleted item', 'retired image'] as const) {
  test(`checked completed Save retry: ${change}`, async ({ page }) => {
    const api = await setup(page, 'en', true);
    await photo(page, api); await expand(page, 'item'); await fillFields(page, 'en');
    const reserveBodies: unknown[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/rest/v1/rpc/reserve_item_save') reserveBodies.push(request.postDataJSON());
    });
    await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
    expect(api.images[0]!.state).toBe('ready');
    expect(api.items).toHaveLength(1); expect(api.images).toHaveLength(1); expect(api.files.size).toBe(2);
    const item = api.items[0]!, image = api.images[0]!;
    if (change === 'missing main') api.files.delete(String(image.main_path));
    if (change === 'missing thumb') api.files.delete(String(image.thumb_path));
    if (change === 'caption') image.alt_text = 'Changed elsewhere';
    if (change === 'same-caption counter') image.description_version = 2;
    if (change === 'item version') item.version = 2;
    if (change === 'deleted item') api.items.splice(0, 1);
    if (change === 'retired image') { image.state = 'retired'; image.retired_at = '2026-09-10T00:00:00Z'; }
    const itemsBefore = structuredClone(api.items), imagesBefore = structuredClone(api.images);
    const bytesBefore = [...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]);
    const start = api.requests.length;
    await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
    await expect(page.locator('#item-category')).toBeDisabled();
    await expect(page.locator('#item-alt')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
    if (change === 'unchanged') {
      await expect(page.locator('#wardrobe-title')).toBeVisible();
      expect(api.requests.filter((request) => request.path === '/rest/v1/rpc/finalize_item_save')).toHaveLength(2);
    } else {
      const key = change.startsWith('missing') ? 'error.uploadIncomplete' : 'error.conflict';
      await expect(page.getByRole('alert').locator('p')).toHaveText([messages[key].en, messages['capture.retryNote'].en]);
      await expect(page.locator('#item-title')).toHaveValue('Å manual overshirt 🌿');
      await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
      expect(api.requests.slice(start).filter((request) => request.method !== 'OPTIONS').map(({ path }) => path))
        .toEqual(['/rest/v1/rpc/reserve_item_save']);
      expect(api.requests.filter((request) => request.path === '/rest/v1/rpc/finalize_item_save')).toHaveLength(1);
    }
    expect(reserveBodies).toHaveLength(2);
    expect(reserveBodies[1]).toEqual(reserveBodies[0]);
    expect(api.items).toEqual(itemsBefore); expect(api.images).toEqual(imagesBefore);
    expect([...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')])).toEqual(bytesBefore);
    expect(api.uploadWire.posts).toBe(2);
  });
}
for (const malformed of [null, [], [{ item: {}, image: {}, state: 'completed', fingerprint: 'c'.repeat(64) }]]) {
  test(`checked Save rejects malformed reservation ${JSON.stringify(malformed)}`, async ({ page }) => {
    const api = await setup(page);
    await photo(page, api);
    await page.locator('#item-title').fill('Frozen draft');
    await page.locator('#item-category').selectOption('top');
    await page.route('**/rest/v1/rpc/reserve_item_save', (route) => route.fulfill({ json: malformed }));
    await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(page.getByRole('alert').locator('p')).toHaveText([messages['error.conflict'].en, messages['capture.retryNote'].en]);
    await expect(page.locator('#item-title')).toHaveValue('Frozen draft');
    await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    expect(api.requests.some((request) => request.path.startsWith('/storage/') || request.path === '/rest/v1/rpc/finalize_item_save')).toBe(false);
  });
}
test('complete creation form accessibility and bounded synthetic visual evidence', async ({ page }, testInfo) => {
  const api = await setup(page);
  await photo(page, api); await expand(page, 'item'); await fillFields(page, 'en');
  const directory = path.resolve('test-results/i29c-visual');
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const captures = [
    { language: 'en', width: 1280, file: 'garment-fields-en-desktop.png' },
    { language: 'fi', width: 320, file: 'garment-fields-fi-mobile.png' },
  ] as const;
  for (const capture of captures) {
    if (capture.language === 'fi') {
      await page.getByRole('button', { name: messages['account.menu'].en }).click();
      await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await page.getByRole('button', { name: messages['account.menu'].fi }).click();
    }
    await page.setViewportSize({ width: capture.width, height: 900 });
    expect(api.items.length === 0 && api.images.length === 0 && api.files.size === 0
      && api.profiles[owners.a]?.ui_language === capture.language
      && api.requests.filter((request) => request.path.startsWith('/rest/')).every((request) => request.owner === owners.a && request.ownerFilter === `eq.${owners.a}`)).toBe(true);
    expect(await page.evaluate(({ origin, language }) => {
      const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
      const values = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')]
        .filter(visible).map((element) => element.value).join('\n');
      const credentialLike = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      return location.origin === origin && location.hostname === '127.0.0.1' && location.hash === '#/items/new'
        && document.documentElement.lang === language && Boolean(document.querySelector('#capture-title'))
        && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
        && document.querySelector<HTMLInputElement>('#item-title')?.value === 'Å manual overshirt 🌿'
        && document.querySelector<HTMLSelectElement>('#item-category')?.value === 'layer'
        && !document.querySelector('input[type="password"], #email, #password')
        && !credentialLike.test(document.body.innerText) && !credentialLike.test(values);
    }, { origin, language: capture.language }), 'Synthetic complete-form capture guard').toBe(true);
    for (const field of garmentFields) await expect(page.locator(`#item-${field}`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= 11000)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (testInfo.project.name === 'chromium') {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, capture.file), fullPage: true });
    }
  }
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === 'chromium') {
    expect((await readdir(directory)).sort()).toEqual(captures.map((capture) => capture.file).sort());
    for (const capture of captures) {
      const file = path.join(directory, capture.file), metadata = await lstat(file);
      expect(metadata.isFile() && metadata.size > 24 && metadata.size <= 1024 * 1024).toBe(true);
      const handle = await open(file, 'r');
      try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await handle.read(header, 0, 24, 0);
        expect(bytesRead === 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && header.toString('ascii', 12, 16) === 'IHDR' && header.readUInt32BE(16) === capture.width).toBe(true);
      } finally { await handle.close(); }
    }
  }
});
