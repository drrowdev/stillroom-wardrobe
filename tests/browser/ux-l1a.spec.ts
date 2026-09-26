import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { languages, messages, type Language, type MessageKey } from '../../src/i18n';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';
import { mockBackend, signIn, type MockOptions } from './mock-backend';

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
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
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
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
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
      await addAiPhoto(page, api, language);
      await expect(page.locator('#item-category')).not.toHaveValue('');
      await expect(page.locator('#analysis-status')).toHaveCount(0);
      await capture('add-ready');
      await page.locator('details.optional-details > summary').click();
      await expect(page.locator('#item-warmth')).toBeVisible();
      await capture('more-details');
      await leaveAdd(page, language);
      api.mode('failed');
      await addAiPhoto(page, api, language);
      await expect(page.locator('#analysis-status')).toContainText(text('aiC.fillFailed', language));
      await capture('add-failed');
      await leaveAdd(page, language);
      expect(api.items).toHaveLength(0);
      await openSaved(page, api);
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
    await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
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

  test('L1c accessibility at 1280: photo actions under the photo, one form card and one quiet action row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDetail(page);
    const shape = await page.evaluate(() => {
      const names = (selector: string) => [...document.querySelector(selector)!.children].map((child) => child.className);
      const box = (element: Element | null) => element!.getBoundingClientRect();
      const row = document.querySelector('.detail-item-actions')!;
      const archive = box(row.querySelector('.detail-archive button')), trash = box(row.querySelector('.lifecycle-actions button'));
      const photo = box(document.querySelector('.detail-photo')), group = box(document.querySelector('.detail-media .photo-actions'));
      const media = box(document.querySelector('.detail-media')), card = box(document.querySelector('.detail-name'));
      return {
        layout: names('.detail-layout'), media: names('.detail-media'), sections: names('.detail-sections'), row: names('.detail-item-actions'),
        actions: [...document.querySelectorAll('.detail-page .photo-actions')].map((element) => [...element.querySelectorAll('button')].map((button) => button.textContent)),
        underPhoto: group.top - photo.bottom >= 0 && group.top - photo.bottom <= 24,
        inColumn: group.left >= media.left - 0.5 && group.right <= media.right + 0.5,
        oneRow: Math.abs(archive.top - trash.top) <= 1, afterCard: box(row).top >= card.bottom,
      };
    });
    expect(shape).toEqual({
      layout: ['detail-media', 'detail-sections'], media: ['detail-photo', 'photo-actions', 'detail-wear'],
      sections: ['lifecycle-edit-lock', 'detail-item-actions'], row: ['detail-archive', 'settings-card lifecycle-actions'],
      actions: [[text('imageChange.replace'), text('imageChange.recover')]],
      underPhoto: true, inColumn: true, oneRow: true, afterCard: true,
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
    const form = page.locator('.detail-name form');
    expect(await form.evaluate((element) => {
      const last = [...element.querySelectorAll('button')].at(-1);
      const seasons = element.querySelector('#detail-seasons')!.getBoundingClientRect();
      const more = element.querySelector('details.optional-details')!.getBoundingClientRect();
      const save = element.querySelector(':scope > button.button-primary')!.getBoundingClientRect();
      return { last: last?.parentElement === element && last.classList.contains('button-primary'), gaps: [more.top - seasons.bottom, save.top - more.bottom] };
    })).toEqual({ last: true, gaps: [20, 20] });
    await page.locator('#detail-title').fill('Edited overshirt');
    await button(page, 'detail.saveChanges').click();
    const status = page.getByText(text('detail.saved'), { exact: true });
    await expect(status).toBeVisible();
    const distance = await status.evaluate((element) => {
      const save = element.previousElementSibling;
      return save instanceof HTMLButtonElement && save.classList.contains('button-primary')
        ? element.getBoundingClientRect().top - save.getBoundingClientRect().bottom : null;
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
          const group = box('.detail-media .photo-actions'), card = box('.detail-name'), row = box('.detail-item-actions');
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
            overlap: overlaps('.detail-media .photo-actions button') || overlaps('.detail-item-actions button'), small };
        })).toEqual({ column: true, order: true, fits: true, overlap: false, small: [] });
      };
      const reachable = async () => {
        const save = button(page, 'detail.saveChanges', language), archive = button(page, 'detail.archive', language), trash = button(page, 'item.trash', language);
        for (const control of [save, archive, trash]) { await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); }
        await expect(save).toBeDisabled();
        await expect(archive).toBeEnabled();
        await expect(trash).toBeEnabled();
      };
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
          save: one('.detail-name form > button.button-primary') >= 28,
          row: [...document.querySelectorAll('.detail-item-actions button')].every((element) => size(element) >= 28) };
      })).toEqual({ body: 32, title: true, category: true, colour: true, save: true, row: true });
      for (const open of [false, true]) {
        await setMore(page, open);
        await check(320);
        await reachable();
        await axe(page);
      }
      await resize.evaluate((element) => (element as Element).remove());
    });
  }

  test('L1c clean and dirty states: disabled controls and keyboard order', async ({ page }) => {
    await openDetail(page);
    const save = button(page, 'detail.saveChanges'), archive = button(page, 'detail.archive'), trash = button(page, 'item.trash');
    const others = [button(page, 'imageChange.replace'), button(page, 'imageChange.recover'), archive, trash];
    const summary = page.locator('details.optional-details > summary');
    await expect(save).toBeDisabled();
    for (const control of others) await expect(control).toBeEnabled();
    await summary.focus();
    await page.keyboard.press('Tab'); await expect(archive).toBeFocused();
    await page.keyboard.press('Tab'); await expect(trash).toBeFocused();
    await page.locator('#detail-title').fill('Edited overshirt');
    await expect(save).toBeEnabled();
    for (const control of others) await expect(control).toBeDisabled();
    await summary.focus();
    await page.keyboard.press('Tab'); await expect(save).toBeFocused();
  });

  test('L1c Enter in Name saves once and shows the status under Save', async ({ page }) => {
    await openDetail(page);
    const patches = recordPatches(page);
    await page.locator('#detail-title').fill('Keyboard overshirt');
    await page.locator('#detail-title').press('Enter');
    const status = page.getByText(text('detail.saved'), { exact: true });
    await expect(status).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(sent(patches[0]!.body)).toEqual(['title']);
    expect(await status.evaluate((element) => element.previousElementSibling?.matches('button.button-primary') === true
      && !document.activeElement?.closest('.detail-item-actions, .photo-actions'))).toBe(true);
  });

  test('L1c a held save disables the photo and item actions and sends nothing twice', async ({ page }) => {
    await openDetail(page);
    const patches = recordPatches(page);
    const release = await hold(page, /\/rest\/v1\/items(?:\?|$)/, 'PATCH');
    const others = [button(page, 'imageChange.replace'), button(page, 'imageChange.recover'), button(page, 'detail.archive'), button(page, 'item.trash')];
    await page.locator('#detail-title').fill('Held overshirt');
    await button(page, 'detail.saveChanges').click();
    await expect(button(page, 'common.saving')).toBeDisabled();
    for (const control of others) await expect(control).toBeDisabled();
    await page.locator('.detail-name form > button.button-primary').evaluate((element) => { (element as HTMLButtonElement).click(); });
    expect(patches).toHaveLength(1);
    release();
    await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
    for (const control of others) await expect(control).toBeEnabled();
    expect(patches).toHaveLength(1);
  });

  test('L1c a held trash request keeps Archive disabled without a write', async ({ page }) => {
    await openDetail(page);
    const patches = recordPatches(page);
    const release = await hold(page, /\/rest\/v1\/rpc\/set_item_trashed$/);
    const archive = button(page, 'detail.archive');
    await button(page, 'item.trash').click();
    await expect(archive).toBeDisabled();
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
    await expect(page.locator('#detail-title')).toBeDisabled();
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
    expect(await boxedContainers(page)).toEqual(['settings-card detail-name']);
    await axe(page);
    await row.getByRole('button', { name: text('detail.unarchive'), exact: true }).click();
    await expect(row.getByRole('button', { name: text('detail.archive'), exact: true })).toBeEnabled();
    expect(patches.map((patch) => patch.body.lifecycle)).toEqual(['archived', 'active']);
  });
});