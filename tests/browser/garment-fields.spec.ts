import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { provenanceFields } from '../../src/domain/attribute-provenance';
import { moreFields, visibleFields } from '../../src/domain/item-details';
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
}
const shownFields = [...visibleFields, ...moreFields];
const shownProvenance = provenanceFields.filter((field) => shownFields.some((shown) => shown === field));
async function photo(page: Page, api: Awaited<ReturnType<typeof mockBackend>>) {
  await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect(page.locator('#edit-photo')).toBeEnabled();
  await manualEntry(page);
}
async function fillFields(page: Page, language: Language) {
  const text = {
    title: 'Å manual overshirt 🌿', subcategory: 'Overshirt', brand: 'Fictional brand', size_label: 'M',
    material: 'Cotton', purchase_date: '2024-02-29',
    purchase_price: language === 'en' ? '1,234.50' : '1 234,50', notes: '  Oma teksti\nEgen text  ',
  };
  for (const [key, value] of Object.entries(text)) await page.locator(`#item-${key}`).fill(value);
  const selections = { category: 'layer', pattern: 'checked', formality: '2', warmth: '3' };
  for (const [key, value] of Object.entries(selections)) await page.locator(`#item-${key}`).selectOption(value);
  await page.locator('#item-colours-add').selectOption('olive');
  await page.locator('#item-seasons-autumn').check();
  await page.locator('#item-tags-new').fill('weekday');
  await page.locator('#item-tags-new').press('Enter');
  await page.locator('#item-favourite').check();
  await page.locator('#item-alt').fill('  Fictional prepared overshirt  ');
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`blank photo description ${language}: truthful help, empty stored alt and named library link`, async ({ page }) => {
    const api = await setup(page, language);
    await photo(page, api);
    await expand(page, 'item');
    await expect(page.getByText(messages['capture.descriptionHelp'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#item-category-help, #item-windproof-help')).toHaveCount(0);
    expect(await page.locator('.capture-page').evaluate((element) =>
      [...element.querySelectorAll('[aria-describedby]')].every((control) =>
        control.getAttribute('aria-describedby')!.split(/\s+/).every((id) => document.getElementById(id))))).toBe(true);
    await expect(page.locator('#item-alt')).toHaveValue('');
    await page.locator('#item-title').fill('Fictional shirt');
    await page.locator('#item-category').selectOption('top');
    // The description follows the name until it is edited; clearing it keeps it empty.
    await expect(page.locator('#item-alt')).toHaveValue('Fictional shirt');
    await page.locator('#item-alt').fill('');
    await page.locator('#item-title').fill('Fictional shirt ');
    await page.locator('#item-title').fill('Fictional shirt');
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
    expect(await page.locator('.detail-page').evaluate((element) =>
      [...element.querySelectorAll('[aria-describedby]')].every((control) =>
        control.getAttribute('aria-describedby')!.split(/\s+/).every((id) => document.getElementById(id))))).toBe(true);
  });
  test(`every shown field ${language}: exact explicit capture Save, owned edit and clear, hidden columns untouched`, async ({ page }) => {
    const api = await setup(page, language);
    const foreign = api.seedSavedItem('b'), originalForeign = structuredClone(foreign);
    const profiles = structuredClone(api.profiles);
    await photo(page, api);
    await expand(page, 'item');
    await fillFields(page, language);
    expect(api.items).toHaveLength(1);
    expect(api.images).toHaveLength(1);
    const count = api.files.size;
    for (const field of shownFields) {
      await page.locator(`#item-${field}`).focus();
      await expect(page.locator(`#item-${field}`)).toBeFocused();
    }
    expect(api.files.size).toBe(count);
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const item = api.items.find((row) => row.owner_id === owners.a)!;
    const image = api.images.find((row) => row.owner_id === owners.a)!;
    expect(item).toMatchObject({ title: 'Å manual overshirt 🌿', category: 'layer', colours: ['olive'], seasons: ['autumn'],
      subcategory: 'Overshirt', pattern: 'checked', brand: 'Fictional brand', size_label: 'M', material: 'Cotton',
      formality: 2, warmth: 3, purchase_date: '2024-02-29', purchase_price: 1234.5, tags: ['weekday'],
      notes: '  Oma teksti\nEgen text  ', favourite: true,
      currency: 'EUR', windproof: null, min_temp: null, max_temp: null, rain_rating: null, upper_coverage: null, lower_coverage: null,
      sleeve_length: null, garment_length: null, style_tags: [], availability: 'ready', lifecycle: 'active',
      exclude_suggestions: false, wear_more: false });
    expect(Object.keys(item.field_provenance as object).sort()).toEqual([...shownProvenance].sort());
    for (const field of shownProvenance) expect((item.field_provenance as Record<string, unknown>)[field]).toEqual({ kind: 'user', revision: 1 });
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
    for (const key of ['subcategory', 'brand', 'size_label', 'material', 'purchase_price', 'purchase_date', 'notes']) await page.locator(`#detail-${key}`).fill('');
    for (const key of ['pattern', 'formality', 'warmth']) await page.locator(`#detail-${key}`).selectOption('');
    await page.getByRole('button', { name: messages['item.removeColour'][language].replace('{colour}', messages['colour.olive'][language]), exact: true }).click();
    await page.locator('#detail-seasons-autumn').uncheck();
    await page.getByRole('button', { name: messages['item.removeTag'][language].replace('{tag}', 'weekday'), exact: true }).click();
    await page.locator('#detail-favourite').uncheck();
    await page.locator('#detail-title').fill('Corrected name');
    await page.locator('#detail-category').selectOption('top');
    await page.getByRole('button', { name: messages['detail.saveChanges'][language], exact: true }).click();
    await expect(page.getByText(messages['detail.saved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#detail-description')).toHaveValue('Sibling draft');
    expect(image.alt_text).toBe('Sibling draft');
    expect(item).toMatchObject({ title: 'Corrected name', category: 'top', colours: [], seasons: [], tags: [], notes: '',
      subcategory: null, pattern: null, brand: null, size_label: null, material: null, formality: null, purchase_price: null,
      purchase_date: null, warmth: null, windproof: null, currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active' });
    expect(Object.keys(item.field_provenance as object).sort()).toEqual([...shownProvenance].sort());
    for (const field of shownProvenance) expect((item.field_provenance as Record<string, unknown>)[field]).toEqual({ kind: 'user', revision: 2 });
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
    await page.locator('#detail-title').fill(`  ${item.title}  `);
    await expect(page.locator('#detail-min_temp')).toHaveCount(0);
    for (const field of ['purchase_price', 'title']) {
      await expect(page.locator(`#detail-${field}`)).toHaveAttribute('aria-invalid', 'false');
    }
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.locator('.detail-name [role="alert"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: messages['detail.saveChanges'][language], exact: true })).toBeDisabled();
    await page.locator('.detail-name form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect(page.locator('#detail-purchase_price')).toHaveValue('12,50');
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
    await page.getByRole('button', { name: messages['detail.saveChanges'][language], exact: true }).click();
    await expect(page.getByText(messages['detail.saved'][language], { exact: true })).toBeVisible();
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
test('hidden saved values and their provenance survive a name-only edit as a sparse version-checked patch', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const { item } = api.seedSavedItem(), foreign = api.seedSavedItem('b', 'Robin private').item;
  Object.assign(item, { min_temp: -5, max_temp: 25, rain_rating: 1, windproof: true, upper_coverage: 2, lower_coverage: 1,
    sleeve_length: 'long', garment_length: 'regular', currency: 'USD', lifecycle: 'archived', availability: 'laundry',
    exclude_suggestions: true, wear_more: true, style_tags: ['relaxed'], warmth: 4,
    field_provenance: { title: { kind: 'user', revision: 1 }, min_temp: { kind: 'user', revision: 2 },
      sleeve_length: { kind: 'unknown', revision: 3 }, style_tags: { kind: 'unknown', revision: 1 },
      windproof: { kind: 'user', revision: 1 }, warmth: { kind: 'user', revision: 1 } } });
  const before = structuredClone(item), peer = structuredClone(foreign);
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/rest/v1/items') {
      patches.push({ url: request.url(), body: request.postDataJSON() as Record<string, unknown> });
    }
  });
  await page.goto('/'); await signIn(page);
  await page.evaluate((id) => { location.hash = `#/items/${id}`; }, item.id); await expand(page, 'detail');
  await expect(page.locator('#detail-warmth')).toHaveValue('4');
  for (const hidden of ['min_temp', 'max_temp', 'rain_rating', 'windproof', 'sleeve_length', 'garment_length', 'currency',
    'lifecycle', 'availability', 'exclude_suggestions', 'wear_more', 'style_tags', 'upper_coverage', 'lower_coverage']) {
    await expect(page.locator(`#detail-${hidden}`)).toHaveCount(0);
  }
  await page.locator('#detail-title').fill('Renamed overshirt');
  await page.getByRole('button', { name: messages['detail.saveChanges'].en, exact: true }).click();
  await expect(page.getByText(messages['detail.saved'].en, { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(Object.keys(patches[0]!.body).sort()).toEqual(['field_provenance', 'title']);
  expect(new URL(patches[0]!.url).searchParams.get('version')).toBe(`eq.${before.version}`);
  const changed = ['title', 'version', 'updated_at', 'field_provenance'];
  const unchanged = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !changed.includes(key)));
  expect(item.title).toBe('Renamed overshirt'); expect(item.version).toBe(before.version + 1);
  expect(unchanged(item)).toEqual(unchanged(before));
  expect(item.field_provenance).toEqual({ ...before.field_provenance, title: { kind: 'user', revision: 2 } });
  expect(foreign).toEqual(peer);
});
test('invalid saved input, manual confirmations and explicit empty clears remain protected, not formatting notices', async ({ page }, testInfo) => {
  let interceptedItemPatches = 0;
  type Count = 0 | 1 | 'more' | null;
  type Field = 'title' | 'purchase_price' | 'size_label' | 'other';
  type Stage = 'setup' | 'open-detail' | `${'purchase_price' | 'size_label'}-${'invalid' | 'back' | 'continue' | 'restore'}`
    | 'title-fill' | 'title-save-enabled' | 'clear-notes' | 'notes-save-enabled' | 'register-patch' | 'save' | 'pending-write' | 'failed-write';
  type Failure = 'metadata' | 'clock' | 'fixture' | 'presentation' | 'serialization' | 'oversize' | 'emission';
  type FieldState = { expectedValue: boolean | null; ariaInvalid: boolean | null; disabled: boolean | null };
  type Presentation = {
    title: FieldState; price: FieldState; sizeLabel: FieldState; saveDisabled: boolean | null;
    errorPresent: boolean | null; checkPresent: boolean | null; reloadPresent: boolean | null;
    navigatorOnline: boolean | null; offlineVisible: boolean | null;
    invalidFields: Field[] | null; focus: Field | 'save' | 'dialog' | 'none' | null; visibleDialogs: Count;
  };
  type Fixture = Awaited<ReturnType<typeof mockBackend>>;
  const evidence: {
    test: 'garment-fields'; case: 'saved-input-confirmations'; project: 'chromium' | 'mobile' | 'webkit-photo' | null;
    retry: 0 | 1 | null; repeat: 0 | null; stage: Stage; bodyCompleted: boolean;
    elapsedReference: 'node-original-body-start'; elapsedMs: number | null; captureError: boolean; failures: Failure[];
    interceptedItemPatches: Count; mockRecordedItemPatches: Count; itemPatchHandlerInvocations: Count;
    fixtureVersionUnchanged: boolean | null; presentation: Presentation | null;
  } = {
    test: 'garment-fields', case: 'saved-input-confirmations', project: null, retry: null, repeat: null,
    stage: 'setup', bodyCompleted: false, elapsedReference: 'node-original-body-start', elapsedMs: null,
    captureError: false, failures: [], interceptedItemPatches: null, mockRecordedItemPatches: null,
    itemPatchHandlerInvocations: null, fixtureVersionUnchanged: null, presentation: null,
  };
  let observedApi: Fixture | undefined, observedItem: ReturnType<Fixture['seedSavedItem']>['item'] | undefined;
  let stage: Stage = 'setup', startedAt: number | null = null;
  function fail(reason: Failure) {
    evidence.captureError = true;
    if (!evidence.failures.includes(reason)) evidence.failures.push(reason);
  }
  function count(value: number): Count {
    if (!Number.isSafeInteger(value) || value < 0) { fail('fixture'); return null; }
    return value === 0 ? 0 : value === 1 ? 1 : 'more';
  }
  async function snapshot() {
    evidence.stage = stage;
    try {
      const project = testInfo.project.name;
      if (project === 'chromium' || project === 'mobile' || project === 'webkit-photo') evidence.project = project;
      else fail('metadata');
      if (testInfo.retry === 0 || testInfo.retry === 1) evidence.retry = testInfo.retry;
      else fail('metadata');
      if (testInfo.repeatEachIndex === 0) evidence.repeat = 0;
      else fail('metadata');
    } catch { fail('metadata'); }
    try {
      const elapsed = startedAt === null ? null : Math.floor(performance.now() - startedAt);
      if (elapsed !== null && Number.isSafeInteger(elapsed) && elapsed >= 0) evidence.elapsedMs = elapsed;
      else fail('clock');
    } catch { fail('clock'); }
    try {
      evidence.interceptedItemPatches = count(interceptedItemPatches);
      if (observedApi) {
        const recorded = observedApi.requests.filter((request) => request.method === 'PATCH' && request.path === '/rest/v1/items').length;
        evidence.mockRecordedItemPatches = count(recorded);
        evidence.itemPatchHandlerInvocations = count(interceptedItemPatches + recorded);
      } else fail('fixture');
      if (observedItem && typeof observedItem.version === 'number') evidence.fixtureVersionUnchanged = observedItem.version === 1;
      else fail('fixture');
    } catch { fail('fixture'); }
    try {
      const result = await page.evaluate(({ checkName, reloadName }) => {
        let captureError = false;
        const field = (key: 'title' | 'purchase_price' | 'size_label', expected: string): FieldState => {
          const matches = document.querySelectorAll(`#detail-${key}`);
          const input = matches.length === 1 ? matches[0] : null;
          if (!(input instanceof HTMLInputElement)) {
            captureError = true;
            return { expectedValue: null, ariaInvalid: null, disabled: null };
          }
          const invalid = input.getAttribute('aria-invalid');
          if (invalid !== 'true' && invalid !== 'false') captureError = true;
          return { expectedValue: input.value === expected, ariaInvalid: invalid === 'true' ? true : invalid === 'false' ? false : null,
            disabled: input.disabled };
        };
        const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
        const section = document.querySelector('.detail-name');
        const main = document.querySelector('.workspace-main');
        const saves = document.querySelectorAll('.detail-name form > button.button-primary');
        const firstSave = saves.length === 1 ? saves[0] : null;
        const save = firstSave instanceof HTMLButtonElement ? firstSave : null;
        if (!section || !main || !save) captureError = true;
        const buttonPresent = (name: string) => section
          ? [...section.querySelectorAll('button')].some((button) => button.textContent === name) : null;
        const classify = (element: Element): Field => element.id === 'detail-title' ? 'title'
          : element.id === 'detail-purchase_price' ? 'purchase_price' : element.id === 'detail-size_label' ? 'size_label' : 'other';
        const active = document.activeElement;
        const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"]')].filter(visible);
        const presentation: Presentation = {
          title: field('title', ' Olive overshirt '), price: field('purchase_price', '12.50'), sizeLabel: field('size_label', ''),
          saveDisabled: save ? save.disabled : null,
          errorPresent: section ? section.querySelector('[role="alert"]') !== null : null,
          checkPresent: buttonPresent(checkName), reloadPresent: buttonPresent(reloadName),
          navigatorOnline: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
          offlineVisible: main ? [...main.querySelectorAll('.notice-offline')].some(visible) : null,
          invalidFields: section ? [...new Set([...section.querySelectorAll('[aria-invalid="true"]')].map(classify))] : null,
          focus: !active || active === document.body ? 'none' : active === save ? 'save'
            : dialogs.some((dialog) => dialog.contains(active)) ? 'dialog' : classify(active),
          visibleDialogs: dialogs.length === 0 ? 0 : dialogs.length === 1 ? 1 : 'more',
        };
        if (presentation.navigatorOnline === null) captureError = true;
        return { captureError, presentation };
      }, { checkName: messages['detail.check'].en, reloadName: messages['detail.reload'].en });
      evidence.presentation = result.presentation;
      if (result.captureError) fail('presentation');
    } catch { fail('presentation'); }
  }
  function emit() {
    let record: string;
    try { record = JSON.stringify(evidence); }
    catch {
      fail('serialization');
      record = '{"test":"garment-fields","case":"saved-input-confirmations","project":null,"retry":null,"repeat":null,"captureError":true,"failures":["serialization"]}';
    }
    try {
      if (Buffer.byteLength(record, 'utf8') > 2048) {
        fail('oversize');
        record = '{"test":"garment-fields","case":"saved-input-confirmations","project":null,"retry":null,"repeat":null,"captureError":true,"failures":["oversize"]}';
      }
      console.log(record);
    } catch {
      fail('emission');
      try { console.error('Garment-form diagnostic emission failed.'); } catch { fail('emission'); }
    }
  }
  try { startedAt = performance.now(); } catch { fail('clock'); }
  try {
    const api = await mockBackend(page);
    observedApi = api;
    const { item } = api.seedSavedItem();
    observedItem = item;
    Object.assign(item, { purchase_price: 12.5, field_provenance: { purchase_price: { kind: 'user', revision: 1 }, notes: { kind: 'user', revision: 1 } } });
    await page.goto('/'); await signIn(page);
    stage = 'open-detail';
    await page.locator(`a[href="#/items/${item.id}"]`).click(); await expand(page, 'detail');
    const notice = page.getByText(messages['detail.noChanges'].en, { exact: true });
    const save = page.getByRole('button', { name: messages['detail.saveChanges'].en, exact: true });
    for (const [field, raw, original] of [['purchase_price', '12.', '12.50'], ['size_label', 'x'.repeat(51), '']] as const) {
      stage = `${field}-invalid`;
      await page.locator(`#detail-${field}`).fill(raw);
      await expect(page.locator(`#detail-${field}`)).toHaveAttribute('aria-invalid', 'true');
      await expect(notice).toHaveCount(0);
      await save.click(); await expect(page.locator(`#detail-${field}`)).toBeFocused();
      stage = `${field}-back`;
      await page.getByRole('button', { name: messages['common.back'].en, exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      stage = `${field}-continue`;
      await page.getByRole('dialog').getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
      await expect(page.locator(`#detail-${field}`)).toHaveValue(raw);
      // Closing the dialog returns focus on the next frame; editing before then would type into the returned focus target.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      stage = `${field}-restore`;
      await page.locator(`#detail-${field}`).fill(original);
      await expect(page.locator(`#detail-${field}`)).toHaveValue(original);
      await expect(page.locator(`#detail-${field}`)).toHaveAttribute('aria-invalid', 'false');
    }
    stage = 'title-fill';
    await page.locator('#detail-title').fill(` ${item.title} `);
    stage = 'title-save-enabled';
    await expect(save).toBeEnabled(); await expect(notice).toHaveCount(0);
    stage = 'clear-notes';
    await page.locator('#detail-notes').fill('');
    stage = 'notes-save-enabled';
    await expect(save).toBeEnabled(); await expect(notice).toHaveCount(0);
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    stage = 'register-patch';
    await page.route('**/rest/v1/items?*', async (route) => {
      if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
      interceptedItemPatches = Math.min(interceptedItemPatches + 1, 2);
      await pending; await route.abort('failed');
    });
    stage = 'save';
    await save.click();
    stage = 'pending-write';
    await expect(page.locator('#detail-title')).toBeDisabled();
    await expect(notice).toHaveCount(0);
    release();
    stage = 'failed-write';
    await expect(page.getByRole('button', { name: messages['detail.check'].en, exact: true })).toBeVisible();
    await expect(page.locator('#detail-title')).toBeDisabled();
    await expect(notice).toHaveCount(0);
    expect(item.version).toBe(1);
    evidence.bodyCompleted = true;
  } finally {
    try { await snapshot(); } catch { fail('presentation'); }
    try { emit(); } catch { fail('emission'); }
  }
  expect(evidence.captureError, 'Garment-form diagnostic capture must be complete.').toBe(false);
});
test('unknown defaults, invalid raw input and manual empty clears remain distinct', async ({ page }) => {
  const api = await setup(page);
  expect(api.items).toHaveLength(0);
  await photo(page, api);
  await page.locator('#item-title').fill('🌿'.repeat(100));
  await page.locator('#item-category').selectOption('top');
  await expand(page, 'item');
  await page.locator('#item-size_label').fill('x'.repeat(51));
  await expect(page.locator('details.optional-details summary')).toHaveCount(1);
  await page.locator('details.optional-details summary').click();
  await expect(page.locator('details.optional-details')).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('details.optional-details')).toHaveAttribute('open', '');
  await expect(page.locator('#item-size_label')).toBeFocused();
  await expect(page.locator('#item-size_label')).toHaveValue('x'.repeat(51));
  expect(api.items).toHaveLength(0);
  await page.locator('#item-size_label').fill('');
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]).toMatchObject({ colours: [], seasons: [], size_label: null, warmth: null, rain_rating: null, windproof: null,
    field_provenance: { title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 }, size_label: { kind: 'user', revision: 1 } } });
  expect(Object.keys(api.items[0]!.field_provenance as object)).toHaveLength(3);
  // An untouched description is the name-based default.
  expect(api.images[0]!.alt_text).toBe('🌿'.repeat(100));
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
      && api.requests.filter((request) => request.path.startsWith('/rest/')).every((request) => request.owner === owners.a
        && (request.path === '/rest/v1/rpc/ai_status'
          ? request.method === 'POST' && request.ownerFilter === null : request.ownerFilter === `eq.${owners.a}`))).toBe(true);
    expect(api.statusProofs()).toEqual(api.requests.filter((request) => request.path === '/rest/v1/rpc/ai_status')
      .map(() => ({ owner: owners.a, issuedBearer: true, emptyObject: true })));
    expect(api.statusProofs().length).toBeGreaterThan(0);
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
    for (const field of shownFields) await expect(page.locator(`#item-${field}`)).toBeVisible();
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
