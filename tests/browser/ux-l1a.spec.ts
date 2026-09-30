import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { languages, messages, type Language, type MessageKey } from '../../src/i18n';
import { aiFixture, addAiPhoto, editItem, openPhotoMenu } from './ai-photo-first-support';
import { mockBackend, signIn, type MockOptions } from './mock-backend';
import { expectIdentity } from './shell-support';

type Api = Awaited<ReturnType<typeof aiFixture>>;
const text = (key: MessageKey, language: Language = 'en') => messages[key][language];
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
// App-owned copy on the add and saved-item screens must not expose AI internals or developer wording.
const banned = [/gpt-/i, /\bUSD\b/, /micro/i, /revision/i, /verified/i, /provenance/i, /Check analysis status/i,
  /Request a new analysis/i, /\bClear /, /\bReset /];
const surfaceKeys = (Object.keys(messages) as MessageKey[]).filter((key) => /^(item|detail|capture|warmth|occasion|availability|lifecycle)\./.test(key)
  || ['aiC.filling', 'aiC.stillWorking', 'aiC.fillFailed', 'aiC.limit', 'aiC.needsCheck', 'aiC.keep', 'aiC.off', 'aiC.turnOn',
    'aiC.markSuggested', 'aiC.markEstimated'].includes(key));

async function auditCopy(page: Page) {
  const copy = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const element of document.querySelectorAll('[aria-label],[title],img[alt]')) {
      parts.push(element.getAttribute('aria-label') ?? '', element.getAttribute('title') ?? '');
    }
    const badge = [...document.querySelectorAll('body *')].some((element) => element.children.length === 0 && element.textContent?.trim() === '01');
    return { text: parts.join('\n'), badge };
  });
  for (const pattern of banned) expect(copy.text, `no ${pattern.source}`).not.toMatch(pattern);
  expect(copy.badge).toBe(false);
}
async function openSaved(page: Page, api: Api, warmth?: number) {
  const saved = api.seedSavedItem();
  if (warmth !== undefined) (saved.item as Record<string, unknown>).warmth = warmth;
  await page.reload();
  await expect(page.locator('.item-card')).toHaveCount(1);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  // UX2: a saved item opens as a view card; tests that change fields press Edit first.
  await expect(page.locator('#item-detail-title')).toHaveText(saved.item.title);
  await expect(page.locator('#detail-edit')).toBeEnabled();
  return saved;
}
function recordPatches(page: Page) {
  const patches: Array<{ url: URL; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/rest/v1/items') {
      patches.push({ url: new URL(request.url()), body: request.postDataJSON() as Record<string, unknown> });
    }
  });
  return patches;
}
async function leaveAdd(page: Page, language: Language = 'en') {
  await button(page, 'common.cancel', language).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.or(page.locator('#wardrobe-title'))).toBeVisible();
  if (await dialog.count()) await dialog.getByRole('button', { name: text('common.discard', language), exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
}
const sent = (body: Record<string, unknown>) => Object.keys(body).filter((key) => key !== 'field_provenance').sort();

test('L1a catalog copy for the add and saved-item screens is plain in every language', () => {
  for (const key of surfaceKeys) for (const language of languages) {
    for (const pattern of banned) expect(messages[key][language], `${key} ${language}`).not.toMatch(pattern);
  }
});

test('L1a add form shows only the essential fields; More details starts collapsed; audit ready, failed and off', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await expect(page.locator('#analysis-status')).toHaveCount(0);
  const details = page.locator('details.optional-details');
  await expect(details).toHaveCount(1);
  expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  expect(await page.locator('.garment-field').evaluateAll((fields) => fields
    .filter((field) => !field.closest('details') && field.getClientRects().length > 0)
    .map((field) => field.id || field.querySelector('[id]')?.id.replace(/-label$/, '')))).toEqual(['item-title', 'item-category', 'item-colours', 'item-seasons']);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  for (const id of ['#item-subcategory', '#item-pattern', '#item-brand', '#item-warmth', '#item-purchase_price', '#item-notes', '#item-tags-new']) {
    await expect(page.locator(id)).toBeHidden();
  }
  await auditCopy(page);
  await page.locator('details.optional-details > summary').click();
  await expect(page.locator('#item-warmth')).toBeVisible();
  await expect(page.locator('#item-pattern option[value=""]')).toHaveText(text('item.notSet'));
  await expect(page.locator('#item-alt')).toBeVisible();
  await auditCopy(page);
  api.mode('failed');
  await leaveAdd(page);
  await addAiPhoto(page, api);
  await expect(page.locator('#analysis-status')).toContainText(text('aiC.fillFailed'));
  await auditCopy(page);
  expect(api.items).toHaveLength(0);
});

test('L1a AI off shows one short line and no internals', async ({ page }) => {
  const api = await aiFixture(page, 'en', false);
  await addAiPhoto(page, api);
  await expect(page.locator('#analysis-status')).toContainText(text('aiC.off'));
  await auditCopy(page);
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(0);
});

test('L1a warmth keeps a stored 4, sends no warmth key when untouched and 2 for Medium', async ({ page }) => {
  const api = await aiFixture(page);
  const patches = recordPatches(page);
  const { item } = await openSaved(page, api, 4);
  await editItem(page);
  await page.locator('details.optional-details > summary').click();
  await expect(page.locator('#detail-warmth')).toHaveValue('4');
  await expect(page.locator('#detail-warmth option:checked')).toHaveText(text('warmth.warm'));
  await page.locator('#detail-title').fill('Warm overshirt');
  await button(page, 'detail.saveChanges').click();
  await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(sent(patches[0]!.body)).toEqual(['title']);
  expect(patches[0]!.url.searchParams.get('version')).toBe('eq.1');
  expect(item.warmth).toBe(4);
  await editItem(page);
  await page.locator('details.optional-details > summary').click();
  await page.locator('#detail-warmth').selectOption({ label: text('warmth.medium') });
  await button(page, 'detail.saveChanges').click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]!.body).toMatchObject({ warmth: 2 });
  expect(sent(patches[1]!.body)).toEqual(['warmth']);
  expect(item.warmth).toBe(2);
  await auditCopy(page);
});

test('L1a saved item has no availability control; stored availability survives edits, Archive and Unarchive', async ({ page }) => {
  const api = await aiFixture(page);
  const patches = recordPatches(page);
  const saved = api.seedSavedItem();
  (saved.item as Record<string, unknown>).availability = 'laundry';
  await page.reload();
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await auditCopy(page);
  await editItem(page);
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  const { item } = saved;
  await auditCopy(page);
  await expect(page.locator('.detail-availability, input[name="detail-availability"]')).toHaveCount(0);
  for (const value of ['ready', 'laundry', 'repair', 'lent'] as const) {
    await expect(page.getByRole('radio', { name: text(`availability.${value}`), exact: true })).toHaveCount(0);
  }
  await page.locator('#detail-title').fill('Edited title');
  await expect(button(page, 'detail.archive')).toBeDisabled();
  await button(page, 'detail.saveChanges').click();
  await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(sent(patches[0]!.body)).toEqual(['title']);
  await expect(button(page, 'detail.archive')).toBeEnabled();
  await button(page, 'detail.archive').click();
  await expect(button(page, 'detail.unarchive')).toBeVisible();
  const archive = () => patches[1]!, unarchive = () => patches[2]!;
  expect(sent(archive().body)).toEqual(['lifecycle']);
  expect(archive().body.lifecycle).toBe('archived');
  expect(archive().url.searchParams.get('version')).toBe('eq.2');
  await button(page, 'detail.unarchive').click();
  await expect(button(page, 'detail.archive')).toBeVisible();
  expect(patches).toHaveLength(3);
  expect(sent(unarchive().body)).toEqual(['lifecycle']);
  expect(unarchive().body.lifecycle).toBe('active');
  expect(unarchive().url.searchParams.get('version')).toBe('eq.3');
  for (const patch of patches) {
    expect(Object.hasOwn(patch.body, 'availability')).toBe(false);
    expect(Object.keys((patch.body.field_provenance ?? {}) as Record<string, unknown>)).not.toContain('availability');
  }
  expect(item.lifecycle).toBe('active');
  expect(item.availability).toBe('laundry');
  await expect(button(page, 'item.trash')).toBeEnabled();
  expect(api.requests.some((call) => call.method === 'DELETE')).toBe(false);
});

test('L1a accessibility: add and saved item at 1280, 320 and 200% text; keyboard More details and invalid focus', async ({ page }) => {
  test.slow();
  const api = await aiFixture(page);
  const axe = async () => {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  await addAiPhoto(page, api);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await axe();
  await page.locator('details.optional-details > summary').focus();
  await page.keyboard.press('Enter');
  expect(await page.locator('details.optional-details').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await axe();
  await leaveAdd(page);
  const patches = recordPatches(page);
  await openSaved(page, api);
  await axe();
  await editItem(page);
  await axe();
  await page.locator('#detail-title').fill('');
  await button(page, 'detail.saveChanges').click();
  await expect(page.locator('#detail-title')).toBeFocused();
  expect(patches).toHaveLength(0);
});

test.describe('bounded L1a visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`add, More details, failed and saved item ${selected.suffix} retain functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language, api = await aiFixture(page, language);
      const write = testInfo.project.name === selected.project;
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/ux-l1a-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async (name: 'add-ready' | 'add-failed' | 'more-details' | 'saved-item') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await expectIdentity(page, 'Alex');
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && document.querySelector('#account-trigger') !== null
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        if (!write) return;
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      // UX2 (plan §9): add-ready is step 1 before a photo; add-failed is step 1 after a failed camera photo, with the
      // camera help; more-details is step 2 with More details open; saved-item is the view card.
      await button(page, 'wardrobe.add', language).first().click();
      await expect(page.locator('#choose-photo')).toBeVisible();
      await expect(page.locator('#item-title')).toHaveCount(0);
      await expect(page.locator('.copy-details')).toHaveCount(0);
      await capture('add-ready');
      await page.locator('input[type=file][capture]').setInputFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: api.fixture.subarray(0, -2) });
      await expect(page.locator('.photo-panel [role=alert]')).toBeVisible();
      await expect(page.locator('.copy-details > summary')).toHaveText(text('photo.cameraHelp', language));
      await expect(page.locator('#item-title')).toHaveCount(0);
      await capture('add-failed');
      await leaveAdd(page, language);
      await addAiPhoto(page, api, language);
      await expect(page.locator('#item-category')).not.toHaveValue('');
      await expect(page.locator('#analysis-status')).toHaveCount(0);
      await page.locator('details.optional-details > summary').click();
      await expect(page.locator('#item-warmth')).toBeVisible();
      await capture('more-details');
      await leaveAdd(page, language);
      api.mode('failed');
      await addAiPhoto(page, api, language);
      await expect(page.locator('#analysis-status')).toContainText(text('aiC.fillFailed', language));
      await leaveAdd(page, language);
      expect(api.items).toHaveLength(0);
      await openSaved(page, api);
      await expect(page.locator('.item-facts .item-fact')).not.toHaveCount(0);
      await expect(page.locator('.detail-page form, .detail-page input, .detail-page select, .detail-page textarea')).toHaveCount(0);
      await capture('saved-item');
    });
  }
});

test.describe('UX L1c saved item layout', () => {
  async function openDetail(page: Page, language: Language = 'en', options: MockOptions = {}) {
    const api = await mockBackend(page, { ...options, initialLanguage: language });
    const saved = api.seedSavedItem();
    await page.goto('/'); await signIn(page);
    await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
    // UX2: the item opens as a view card; tests of the form press Edit first.
    await expect(page.locator('#item-detail-title')).toHaveText(saved.item.title);
    await expect(page.locator('.detail-photo img')).toBeVisible();
    return { api, ...saved };
  }
  const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const setMore = (page: Page, open: boolean) => page.locator('details.optional-details')
    .evaluate((details, value) => { (details as HTMLDetailsElement).open = value; }, open);
  // The trash section keeps its card class from TrashAction; on this page it must render without a box.
  const flatTrash = (page: Page) => page.locator('.detail-item-actions > section.lifecycle-actions').evaluate((section) => {
    const style = getComputedStyle(section);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
      style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every((value) => parseFloat(value) === 0)
      && ['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor) && style.backgroundImage === 'none';
  });
  // The alert takes its own line inside the trash section and never covers its buttons.
  const alertOwnLine = (page: Page) => page.locator('.detail-item-actions > section.lifecycle-actions').evaluate((section) => {
    const alert = section.querySelector('[role="alert"]')?.getBoundingClientRect();
    const buttons = [...section.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    return Boolean(alert) && buttons.length > 0 && buttons.every((box) => alert!.bottom <= box.top + 0.5);
  });
  const boxedContainers = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.detail-page section, .detail-page div, .detail-page fieldset')]
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[role="alert"], dialog'))
    .filter((element) => {
      const style = getComputedStyle(element);
      return (['Top', 'Right', 'Bottom', 'Left'] as const).every((side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none');
    }).map((element) => element.className));
  function hold(page: Page, pattern: RegExp, method?: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return page.route(pattern, async (route) => {
      if (!method || route.request().method() === method) await gate;
      await route.fallback();
    }).then(() => release);
  }

  // UX2: the item opens as a view card (photo, Photo options, facts and Edit, then the quiet action row); the form card
  // appears after Edit, without the photo actions. The old single-mode pins are split into these two shapes.
  const shape = (page: Page) => page.evaluate(() => {
    const names = (selector: string) => [...document.querySelector(selector)!.children].map((child) => child.className);
    const box = (element: Element | null) => element!.getBoundingClientRect();
    const row = document.querySelector('.detail-item-actions')!;
    const archive = box(row.querySelector('.detail-archive button')), trash = box(row.querySelector('.lifecycle-actions button'));
    const photo = box(document.querySelector('.detail-photo')), media = box(document.querySelector('.detail-media'));
    const groupElement = document.querySelector('.detail-media .photo-actions'), group = groupElement && box(groupElement);
    const card = box(document.querySelector('.item-view, .detail-name'));
    return {
      layout: names('.detail-layout'), media: names('.detail-media'), sections: names('.detail-sections'), row: names('.detail-item-actions'),
      actions: [...document.querySelectorAll('.detail-page .photo-actions')].map((element) => [...element.querySelectorAll('button')].map((button) => button.textContent)),
      underPhoto: group ? group.top - photo.bottom >= 0 && group.top - photo.bottom <= 24 : null,
      inColumn: group ? group.left >= media.left - 0.5 && group.right <= media.right + 0.5 : null,
      oneRow: Math.abs(archive.top - trash.top) <= 1, afterCard: box(row).top >= card.bottom,
    };
  });

  test('L1c accessibility at 1280: photo actions under the photo, one form card and one quiet action row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDetail(page);
    expect(await shape(page)).toEqual({
      layout: ['detail-media', 'detail-sections'], media: ['detail-photo', 'photo-actions photo-menu', 'detail-wear'],
      sections: ['item-view', 'item-recovery', 'detail-item-actions'], row: ['detail-archive', 'settings-card lifecycle-actions'],
      actions: [[text('capture.photoOptions'), text('imageChange.replace'), text('imageChange.recover')]],
      underPhoto: true, inColumn: true, oneRow: true, afterCard: true,
    });
    expect(await boxedContainers(page)).toEqual([]);
    await expect(page.locator('.detail-page form')).toHaveCount(0);
    expect(await flatTrash(page)).toBe(true);
    await axe(page);
    // Keyboard open, so Escape is pressed inside the disclosure (WebKit does not focus a clicked button).
    await page.locator('#photo-menu').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#photo-menu-panel')).toBeVisible();
    await axe(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#photo-menu')).toBeFocused();
    await editItem(page);
    expect(await shape(page)).toEqual({
      layout: ['detail-media', 'detail-sections'], media: ['detail-photo', 'detail-wear'],
      sections: ['lifecycle-edit-lock', 'item-recovery', 'detail-item-actions'], row: ['detail-archive', 'settings-card lifecycle-actions'],
      actions: [], underPhoto: null, inColumn: null, oneRow: true, afterCard: true,
    });
    expect(await boxedContainers(page)).toEqual(['settings-card detail-name']);
    expect(await page.locator('.detail-name form').count()).toBe(1);
    expect(await flatTrash(page)).toBe(true);
    await axe(page);
    await setMore(page, true);
    expect(await boxedContainers(page)).toEqual(['settings-card detail-name']);
    await axe(page);
  });

  test('L1c form: Save ends the form, even spacing and the status right under Save', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDetail(page);
    await editItem(page);
    const form = page.locator('.detail-name form');
    // UX2: the form ends with its action row, Save first and Cancel after it.
    expect(await form.evaluate((element) => {
      const actions = element.lastElementChild!, buttons = [...actions.querySelectorAll('button')];
      const seasons = element.querySelector('#detail-seasons')!.getBoundingClientRect();
      const more = element.querySelector('details.optional-details')!.getBoundingClientRect();
      return { last: actions.classList.contains('item-edit-actions') && buttons[0]!.classList.contains('button-primary')
        && buttons.at(-1)!.id === 'detail-cancel-edit' && buttons.length === 2,
      gaps: [more.top - seasons.bottom, actions.getBoundingClientRect().top - more.bottom] };
    })).toEqual({ last: true, gaps: [20, 20] });
    await page.locator('#detail-title').fill('Edited overshirt');
    await button(page, 'detail.saveChanges').click();
    const status = page.getByText(text('detail.saved'), { exact: true });
    await expect(status).toBeVisible();
    // Save returns to the view card; the status sits right under it, with focus on Edit.
    await expect(page.locator('#detail-edit')).toBeFocused();
    const distance = await status.evaluate((element) => {
      const edit = document.querySelector('#detail-edit');
      return element.parentElement?.classList.contains('item-recovery') && element.parentElement.previousElementSibling?.matches('section.item-view') && edit
        ? element.getBoundingClientRect().top - edit.getBoundingClientRect().bottom : null;
    });
    expect(distance).not.toBeNull();
    expect(distance!).toBeGreaterThanOrEqual(0);
    expect(distance!).toBeLessThanOrEqual(16);
  });

  test('L1c the photo holds only the image, with no generated content or overlay', async ({ page }) => {
    await openDetail(page);
    expect(await page.locator('.detail-photo').evaluate((photo) => {
      const image = photo.firstElementChild;
      const empty = (element: Element, pseudo: string) => ['none', 'normal'].includes(getComputedStyle(element, pseudo).content);
      photo.scrollIntoView({ block: 'center' });
      const box = photo.getBoundingClientRect();
      return photo.children.length === 1 && image instanceof HTMLImageElement
        && document.elementFromPoint(box.right - 8, box.top + 8) === image
        && [photo, image].every((element) => empty(element, '::before') && empty(element, '::after'));
    })).toBe(true);
  });

  for (const language of languages) {
    test(`L1c accessibility ${language}: single column at 320 and 430 px and text-resize coverage`, async ({ page }) => {
      test.slow();
      await openDetail(page, language);
      const check = async (width: number) => {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const media = box('.detail-media'), sections = box('.detail-sections'), photo = box('.detail-photo');
          // UX2: in view mode Photo options sits under the photo; in edit mode there is no photo action group.
          const groupElement = document.querySelector('.detail-media .photo-actions');
          const group = groupElement ? groupElement.getBoundingClientRect() : { top: photo.bottom, bottom: photo.bottom };
          const card = box('.item-view, .detail-name'), row = box('.detail-item-actions');
          const overlaps = (selector: string) => {
            const boxes = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length).map((element) => element.getBoundingClientRect());
            return boxes.some((a, index) => boxes.slice(index + 1).some((b) => a.right > b.left + 0.5 && b.right > a.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5));
          };
          // Checkboxes are 20 px inside a clickable label; measure the label for them and the control for everything else.
          const small = [...document.querySelectorAll<HTMLElement>('.detail-page button, .detail-page select, .detail-page input, .detail-page textarea, .detail-page summary')]
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => element instanceof HTMLInputElement && element.type === 'checkbox' ? element.closest('label') ?? element : element)
            .filter((element) => element.getBoundingClientRect().height < 43.5)
            .map((element) => element.id || element.textContent || element.tagName);
          return { column: Math.abs(media.left - sections.left) < 1,
            order: photo.bottom <= group.top + 0.5 && group.bottom <= card.top + 0.5 && card.bottom <= row.top + 0.5,
            fits: document.documentElement.scrollWidth <= innerWidth,
            overlap: overlaps('.detail-media .photo-actions button') || overlaps('.detail-item-actions button') || overlaps('.item-edit-actions button'), small };
        })).toEqual({ column: true, order: true, fits: true, overlap: false, small: [] });
      };
      const reachable = async () => {
        const save = button(page, 'detail.saveChanges', language), archive = button(page, 'detail.archive', language), trash = button(page, 'item.trash', language);
        for (const control of [save, archive, trash]) { await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); }
        await expect(save).toBeDisabled();
        await expect(archive).toBeEnabled();
        await expect(trash).toBeEnabled();
      };
      const viewReachable = async () => {
        const edit = page.locator('#detail-edit'), archive = button(page, 'detail.archive', language), trash = button(page, 'item.trash', language);
        for (const control of [page.locator('#photo-menu'), edit, archive, trash]) { await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); await expect(control).toBeEnabled(); }
      };
      for (const width of [320, 430]) await check(width);
      await viewReachable();
      await axe(page);
      await editItem(page);
      for (const open of [false, true]) {
        await setMore(page, open);
        for (const width of [320, 430]) await check(width);
        await axe(page);
      }
      // Text-resize coverage, not browser zoom: doubles root-relative sizes and the inherited body/control text.
      const resize = await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      expect(await page.evaluate(() => {
        const size = (element: Element) => parseFloat(getComputedStyle(element).fontSize);
        const one = (selector: string) => size(document.querySelector(selector)!);
        return { body: one('body'), title: one('#detail-title') >= 32, category: one('#detail-category') >= 32, colour: one('#detail-colours-add') >= 32,
          save: one('.detail-name form .item-edit-actions > button.button-primary') >= 28,
          row: [...document.querySelectorAll('.detail-item-actions button')].every((element) => size(element) >= 28) };
      })).toEqual({ body: 32, title: true, category: true, colour: true, save: true, row: true });
      for (const open of [false, true]) {
        await setMore(page, open);
        await check(320);
        await reachable();
        await axe(page);
      }
      await page.locator('#detail-cancel-edit').click();
      await expect(page.locator('#detail-edit')).toBeFocused();
      expect(await page.evaluate(() => [...document.querySelectorAll('.item-view dt, .item-view dd, #detail-edit')]
        .every((element) => parseFloat(getComputedStyle(element).fontSize) >= 28))).toBe(true);
      await check(320);
      await viewReachable();
      await axe(page);
      await resize.evaluate((element) => (element as Element).remove());
    });
  }

  test('L1c clean and dirty states: disabled controls and keyboard order', async ({ page }) => {
    await openDetail(page);
    const save = button(page, 'detail.saveChanges'), archive = button(page, 'detail.archive'), trash = button(page, 'item.trash');
    // UX2: Replace photo and Previous photos sit under Photo options on the view card and are not rendered in edit mode.
    await openPhotoMenu(page);
    for (const control of [button(page, 'imageChange.replace'), button(page, 'imageChange.recover'), archive, trash]) await expect(control).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.locator('#detail-edit').focus();
    await page.keyboard.press('Tab'); await expect(archive).toBeFocused();
    await page.keyboard.press('Tab'); await expect(trash).toBeFocused();
    await editItem(page);
    const summary = page.locator('details.optional-details > summary');
    await expect(save).toBeDisabled();
    await expect(page.locator('#photo-menu')).toHaveCount(0);
    for (const control of [archive, trash]) await expect(control).toBeEnabled();
    await summary.focus();
    await page.keyboard.press('Tab'); await expect(page.locator('#detail-cancel-edit')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(archive).toBeFocused();
    await page.keyboard.press('Tab'); await expect(trash).toBeFocused();
    await page.locator('#detail-title').fill('Edited overshirt');
    await expect(save).toBeEnabled();
    for (const control of [archive, trash]) await expect(control).toBeDisabled();
    await summary.focus();
    await page.keyboard.press('Tab'); await expect(save).toBeFocused();
  });

  test('L1c Enter in Name saves once and shows the status under Save', async ({ page }) => {
    await openDetail(page);
    await editItem(page);
    const patches = recordPatches(page);
    await page.locator('#detail-title').fill('Keyboard overshirt');
    await page.locator('#detail-title').press('Enter');
    const status = page.getByText(text('detail.saved'), { exact: true });
    await expect(status).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(sent(patches[0]!.body)).toEqual(['title']);
    // UX2: Save returns to the view card with the status right under it and focus on Edit.
    expect(await status.evaluate((element) => element.parentElement?.previousElementSibling?.matches('section.item-view') === true
      && document.activeElement?.id === 'detail-edit')).toBe(true);
  });

  test('L1c a held save disables the photo and item actions and sends nothing twice', async ({ page }) => {
    await openDetail(page);
    await editItem(page);
    const patches = recordPatches(page);
    const release = await hold(page, /\/rest\/v1\/items(?:\?|$)/, 'PATCH');
    const others = [button(page, 'detail.archive'), button(page, 'item.trash')];
    await page.locator('#detail-title').fill('Held overshirt');
    await button(page, 'detail.saveChanges').click();
    await expect(button(page, 'common.saving')).toBeDisabled();
    await expect(page.locator('#detail-cancel-edit')).toBeDisabled();
    await expect(page.locator('#photo-menu')).toHaveCount(0);
    for (const control of others) await expect(control).toBeDisabled();
    await page.locator('.detail-name form .item-edit-actions > button.button-primary').evaluate((element) => { (element as HTMLButtonElement).click(); });
    expect(patches).toHaveLength(1);
    release();
    await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
    await openPhotoMenu(page);
    for (const control of [button(page, 'imageChange.replace'), button(page, 'imageChange.recover'), ...others]) await expect(control).toBeEnabled();
    expect(patches).toHaveLength(1);
  });

  test('L1c a held trash request keeps Archive disabled without a write', async ({ page }) => {
    await openDetail(page);
    const patches = recordPatches(page);
    const release = await hold(page, /\/rest\/v1\/rpc\/set_item_trashed$/);
    const archive = button(page, 'detail.archive');
    await button(page, 'item.trash').click();
    await expect(archive).toBeDisabled();
    await expect(page.locator('#detail-edit')).toBeDisabled();
    await archive.evaluate((element) => { (element as HTMLButtonElement).click(); });
    expect(patches).toHaveLength(0);
    release();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(patches).toHaveLength(0);
  });

  test('L1c an unconfirmed trash result keeps Check in the quiet row and the rest locked', async ({ page }) => {
    const { api } = await openDetail(page, 'en', { lifecycleLoss: 'change' });
    const patches = recordPatches(page);
    const trashCalls = () => api.requests.filter((request) => request.path.endsWith('/set_item_trashed')).length;
    await button(page, 'item.trash').click();
    const section = page.locator('.detail-item-actions > section.lifecycle-actions');
    await expect(section.getByRole('alert')).toHaveText(text('lifecycle.unconfirmed'));
    const check = section.getByRole('button', { name: text('lifecycle.check'), exact: true });
    await expect(check).toBeEnabled();
    await expect(button(page, 'detail.archive')).toBeDisabled();
    // UX2: the view card's Edit stays locked while the result is unknown.
    await expect(page.locator('#detail-edit')).toBeDisabled();
    expect(await flatTrash(page)).toBe(true);
    expect(await alertOwnLine(page)).toBe(true);
    expect(patches).toHaveLength(0);
    expect(api.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(trashCalls()).toBe(1);
    await check.click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(trashCalls()).toBe(1);
  });

  test('L1c a rejected trash request shows its alert on its own line in the flat section', async ({ page }) => {
    const { item } = await openDetail(page);
    (item as Record<string, unknown>).version = Number(item.version) + 1;
    await button(page, 'item.trash').click();
    const section = page.locator('.detail-item-actions > section.lifecycle-actions');
    await expect(section.getByRole('alert')).toBeVisible();
    await expect(section.getByRole('alert')).not.toHaveText(text('lifecycle.unconfirmed'));
    await expect(button(page, 'item.trash')).toBeEnabled();
    expect(await flatTrash(page)).toBe(true);
    expect(await alertOwnLine(page)).toBe(true);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await alertOwnLine(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('L1c accessibility: Archive and Unarchive stay in the quiet row', async ({ page }) => {
    await openDetail(page);
    const patches = recordPatches(page);
    const row = page.locator('.detail-item-actions');
    await button(page, 'detail.archive').click();
    await expect(row.locator('.detail-archive')).toContainText(text('detail.archived'));
    await expect(row.getByRole('button', { name: text('detail.unarchive'), exact: true })).toBeEnabled();
    await expect(row.locator('section.lifecycle-actions')).toHaveCount(1);
    // UX2: the view card has no boxed container; the form card appears after Edit.
    expect(await boxedContainers(page)).toEqual([]);
    await axe(page);
    await row.getByRole('button', { name: text('detail.unarchive'), exact: true }).click();
    await expect(row.getByRole('button', { name: text('detail.archive'), exact: true })).toBeEnabled();
    expect(patches.map((patch) => patch.body.lifecycle)).toEqual(['archived', 'active']);
  });
});

// UX2 plan §8: the two-step add flow, the photo options and the item view card. Text assertions only.
test.describe('UX2 add item steps and the item view card', () => {
  const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const good = (api: Api) => ({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
  const broken = (api: Api) => ({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: api.fixture.subarray(0, -2) });
  const libraryInput = (page: Page) => page.locator('.photo-panel input[type=file]:not([capture])');
  const cameraInput = (page: Page) => page.locator('.photo-panel input[type=file][capture]');
  const analyses = (api: Api) => api.calls.filter((call) => call.route.endsWith('/analyze-clothing')).length;
  const libraryWrites = (api: Api) => api.items.length + api.images.length + api.files.size + api.uploadWire.posts
    + api.requests.filter((call) => /(?:reserve_(?:analyzed_|restored_)?item_save(?:_v2)?|reserve_image_change|finalize_item_save|\/finalize-[\w-]+|commit_image)$/.test(call.path)).length;
  const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  async function openAdd(page: Page, language: Language = 'en') {
    await button(page, 'wardrobe.add', language).first().click();
    await expect(page.locator('#choose-photo')).toBeVisible();
  }
  async function stepTwo(page: Page, api: Api) {
    // As a user does: Choose photo, then the file; focus then moves to the basics.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#choose-photo').click()]);
    await chooser.setFiles(good(api));
    await expect(page.locator('.capture-photo img')).toBeVisible();
    await expect(page.locator('#capture-basics')).toBeFocused();
    await expect(page.locator('#item-category')).not.toHaveValue('');
  }

  test('UX2 step 1 has one primary Choose photo and Take photo, no fields; camera help only after a camera failure or dismissal', async ({ page }) => {
    const api = await aiFixture(page);
    await openAdd(page);
    const group = page.locator('.photo-panel .photo-actions');
    await expect(group.locator('button')).toHaveText([text('capture.library'), text('capture.camera')]);
    await expect(group.locator('.button-primary')).toHaveCount(1);
    await expect(page.locator('#choose-photo')).toHaveClass(/button-primary/);
    await expect(page.locator('.details-panel, #item-title, #photo-menu, details.optional-details')).toHaveCount(0);
    await expect(page.locator('.copy-details')).toHaveCount(0);
    await axe(page);
    // Choose photo opens the photo library, not the camera.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#choose-photo').click()]);
    expect(await chooser.element().getAttribute('capture')).toBeNull();
    // A library photo that fails shows the error but not the camera help.
    await chooser.setFiles(broken(api));
    await expect(page.locator('.photo-panel [role=alert]')).toBeVisible();
    await expect(page.locator('.copy-details')).toHaveCount(0);
    await expect(page.locator('#item-title')).toHaveCount(0);
    // A camera photo that fails shows it.
    await cameraInput(page).setInputFiles(broken(api));
    await expect(page.locator('.copy-details > summary')).toHaveText(text('photo.cameraHelp'));
    await leaveAdd(page);
    // A dismissed camera shows it too.
    await openAdd(page);
    await expect(page.locator('.copy-details')).toHaveCount(0);
    await cameraInput(page).dispatchEvent('cancel');
    await expect(page.locator('.copy-details > summary')).toHaveText(text('photo.cameraHelp'));
    await axe(page);
    expect(analyses(api)).toBe(0);
    expect(libraryWrites(api)).toBe(0);
  });

  test('UX2 step 2 opens on the basics, AI-filled, with More details collapsed; nothing is saved before Save', async ({ page }) => {
    const api = await aiFixture(page);
    await openAdd(page);
    await stepTwo(page, api);
    for (const id of ['#item-title', '#item-category', '#item-colours', '#item-seasons']) await expect(page.locator(id).first()).toBeVisible();
    await expect(page.locator('#item-title')).not.toHaveValue('');
    const details = page.locator('details.optional-details');
    expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    await expect(details.locator('#item-alt')).toHaveCount(1);
    await expect(page.locator('#item-alt')).toBeHidden();
    // Before Save: exactly one analysis, and no reservation, item, image, Storage upload or publication.
    await page.waitForTimeout(300);
    expect(analyses(api)).toBe(1);
    expect(libraryWrites(api)).toBe(0);
    await page.locator('#item-title').fill('Blue overshirt');
    expect(libraryWrites(api)).toBe(0);
    await page.locator('.save-actions .button-primary').click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.items).toHaveLength(1);
    expect(api.items[0]!.title).toBe('Blue overshirt');
    expect(api.images).toHaveLength(1);
    expect(api.requests.filter((call) => /reserve_(?:analyzed_)?item_save$/.test(call.path))).toHaveLength(1);
    expect(analyses(api)).toBe(1);
  });

  test('UX2 Photo options: keyboard, Escape back to the toggle, frozen while saving; a new photo keeps typed values', async ({ page }) => {
    const api = await aiFixture(page);
    await openAdd(page);
    await stepTwo(page, api);
    const toggle = page.locator('#photo-menu'), panel = page.locator('#photo-menu-panel');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('button')).toHaveText([text('capture.replace'), text('capture.camera'), text('photo.edit')]);
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button').first()).toBeFocused();
    await axe(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.locator('#item-title').fill('Kept title');
    await openPhotoMenu(page);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel.getByRole('button', { name: text('capture.replace'), exact: true }).click()]);
    expect(await chooser.element().getAttribute('capture')).toBeNull();
    await chooser.setFiles(good(api));
    await expect.poll(() => analyses(api)).toBe(2);
    await expect(page.locator('#item-title')).toHaveValue('Kept title');
    await expect(toggle).toBeFocused();
    expect(libraryWrites(api)).toBe(0);
    // While the save runs, Photo options is disabled.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/rest\/v1\/rpc\/reserve_(?:analyzed_)?item_save$/, async (route) => { await gate; await route.fallback(); });
    await page.locator('.save-actions .button-primary').click();
    await expect(toggle).toBeDisabled();
    release();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.items).toHaveLength(1);
  });

  test('UX2 a failed replacement in step 2 keeps the details and offers Choose photo again', async ({ page }) => {
    const api = await aiFixture(page);
    await openAdd(page);
    await stepTwo(page, api);
    await page.locator('#item-title').fill('Typed title');
    await libraryInput(page).setInputFiles(broken(api));
    await expect(page.locator('.photo-panel [role=alert]')).toBeVisible();
    await expect(page.locator('#item-title')).toHaveValue('Typed title');
    await expect(page.locator('#photo-menu')).toHaveCount(0);
    await expect(page.locator('#choose-photo')).toBeVisible();
    await expect(page.locator('.photo-panel .photo-actions').getByRole('button', { name: text('capture.camera'), exact: true })).toBeVisible();
    // Save with no photo points to Choose photo and sends nothing.
    await page.locator('#item-title').press('Enter');
    await expect(page.locator('#choose-photo')).toBeFocused();
    expect(libraryWrites(api)).toBe(0);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#choose-photo').click()]);
    await chooser.setFiles(good(api));
    await expect(page.locator('.capture-photo img')).toBeVisible();
    await expect(page.locator('#photo-menu')).toBeFocused();
    await expect(page.locator('#item-title')).toHaveValue('Typed title');
    expect(libraryWrites(api)).toBe(0);
  });

  test('UX2 leaving a changed step 2 asks first; Keep editing keeps the values and Discard saves nothing', async ({ page }) => {
    const api = await aiFixture(page);
    await openAdd(page);
    await stepTwo(page, api);
    await page.locator('#item-title').fill('Unsaved title');
    await page.locator('.save-actions .button-quiet').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#item-title')).toHaveValue('Unsaved title');
    await page.locator('.save-actions .button-quiet').click();
    await dialog.getByRole('button', { name: text('common.discard'), exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(libraryWrites(api)).toBe(0);
  });

  test('UX2 item view card: no form controls; Edit, Cancel, a dirty Cancel and Save move focus as planned', async ({ page }) => {
    const api = await aiFixture(page);
    const patches = recordPatches(page);
    await openSaved(page, api);
    await expect(page.locator('.detail-page form, .detail-page input, .detail-page select, .detail-page textarea')).toHaveCount(0);
    await expect(page.locator('.item-facts .item-fact')).not.toHaveCount(0);
    await page.locator('#photo-menu').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#photo-menu-panel').getByRole('button')).toHaveText([text('imageChange.replace'), text('imageChange.recover')]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#photo-menu')).toBeFocused();
    await editItem(page);
    await page.locator('#detail-cancel-edit').click();
    await expect(page.locator('#detail-edit')).toBeFocused();
    await editItem(page);
    await page.locator('#detail-title').fill('Changed title');
    await page.locator('#detail-cancel-edit').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(page.locator('#detail-title')).toHaveValue('Changed title');
    await page.locator('#detail-cancel-edit').click();
    await dialog.getByRole('button', { name: text('common.discard'), exact: true }).click();
    await expect(page.locator('#detail-edit')).toBeFocused();
    expect(patches).toHaveLength(0);
    await editItem(page);
    await expect(page.locator('#detail-title')).not.toHaveValue('Changed title');
    await page.locator('#detail-title').fill('Saved title');
    await button(page, 'detail.saveChanges').click();
    await expect(page.locator('.item-recovery')).toContainText(text('detail.saved'));
    await expect(page.locator('#detail-edit')).toBeFocused();
    await expect(page.locator('#item-detail-title')).toHaveText('Saved title');
    expect(patches).toHaveLength(1);
  });

  test('UX2 an unknown save result stays in edit with Cancel disabled and offers Check', async ({ page }) => {
    const api = await aiFixture(page);
    await openSaved(page, api);
    await editItem(page);
    let patches = 0;
    await page.route('**/rest/v1/items?*', async (route) => {
      if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
      patches++;
      await route.abort('failed');
    });
    await page.locator('#detail-title').fill('Lost title');
    await button(page, 'detail.saveChanges').click();
    await expect(page.locator('.item-recovery').getByRole('button', { name: text('detail.check'), exact: true })).toBeVisible();
    await expect(page.locator('#detail-cancel-edit')).toBeDisabled();
    await expect(page.locator('#detail-edit')).toHaveCount(0);
    expect(patches).toBe(1);
  });

  test('UX2 a lost Archive reply keeps Check and Reload on the view card, locks Edit and sends once', async ({ page }) => {
    const api = await aiFixture(page);
    const { item } = await openSaved(page, api);
    let archives = 0;
    await page.route('**/rest/v1/items?*', async (route) => {
      if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
      archives++;
      // The write reaches the backend; only the reply is lost.
      const body = route.request().postDataJSON() as { lifecycle: string };
      Object.assign(item, { lifecycle: body.lifecycle, version: Number(item.version) + 1 });
      await route.abort('failed');
    });
    await button(page, 'detail.archive').click();
    const recovery = page.locator('.item-recovery');
    await expect(recovery.getByRole('alert')).toBeVisible();
    const check = recovery.getByRole('button', { name: text('detail.check'), exact: true });
    await expect(check).toBeVisible();
    await expect(recovery.getByRole('button', { name: text('detail.reload'), exact: true })).toBeVisible();
    await expect(page.locator('section.item-view')).toBeVisible();
    await expect(page.locator('#detail-edit')).toBeDisabled();
    // Leaving asks first while the result is unknown.
    await page.locator('.detail-page > button.text-button').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: text('common.continueEditing'), exact: true }).click();
    await expect(check).toBeVisible();
    await check.click();
    await expect(button(page, 'detail.unarchive')).toBeVisible();
    await expect(page.locator('#detail-edit')).toBeEnabled();
    expect(archives).toBe(1);
    expect(item.lifecycle).toBe('archived');
  });

  test('UX2 the trash section stays mounted across Edit and Cancel; a lost trash reply locks the form', async ({ page }) => {
    const { api } = await (async () => {
      const api = await mockBackend(page, { lifecycleLoss: 'change' });
      const saved = api.seedSavedItem();
      await page.goto('/'); await signIn(page);
      await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
      await expect(page.locator('#detail-edit')).toBeEnabled();
      return { api };
    })();
    const trashCalls = () => api.requests.filter((request) => request.path.endsWith('/set_item_trashed')).length;
    const section = await page.locator('.detail-item-actions > section.lifecycle-actions').elementHandle();
    await editItem(page);
    await page.locator('#detail-cancel-edit').click();
    await expect(page.locator('#detail-edit')).toBeFocused();
    expect(await section!.evaluate((element) => element.isConnected)).toBe(true);
    await editItem(page);
    await button(page, 'item.trash').click();
    await expect(page.locator('.detail-item-actions > section.lifecycle-actions').getByRole('alert')).toHaveText(text('lifecycle.unconfirmed'));
    expect(await section!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator('#detail-cancel-edit')).toBeDisabled();
    await expect(page.locator('#detail-title')).toBeDisabled();
    expect(trashCalls()).toBe(1);
    await page.locator('.detail-item-actions > section.lifecycle-actions').getByRole('button', { name: text('lifecycle.check'), exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(trashCalls()).toBe(1);
  });

  for (const language of ['fi', 'sv'] as const) {
    test(`UX2 ${language}: step 1, step 2, Photo options, crop, view and edit fit 320px and 200% text with no axe violations`, async ({ page }) => {
      test.slow();
      const api = await aiFixture(page, language);
      const check = async () => {
        for (const width of [320, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await fits(page), `${language} ${width}`).toBe(true);
        }
        await page.setViewportSize({ width: 320, height: 900 });
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        expect(await fits(page), `${language} 200%`).toBe(true);
        await axe(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
        await page.setViewportSize({ width: 1280, height: 900 });
      };
      await openAdd(page, language);
      await check();
      await stepTwo(page, api);
      await check();
      await openPhotoMenu(page);
      await check();
      await page.locator('#edit-photo').click();
      await expect(page.locator('section.crop-editor')).toBeVisible();
      expect(await page.locator('details.crop-exact').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
      await check();
      await page.locator('#crop-cancel').click();
      await expect(page.locator('#photo-menu')).toBeFocused();
      await leaveAdd(page, language);
      const saved = api.seedSavedItem();
      await page.reload();
      await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
      await expect(page.locator('#detail-edit')).toBeEnabled();
      await check();
      await editItem(page);
      await check();
    });
  }
});
