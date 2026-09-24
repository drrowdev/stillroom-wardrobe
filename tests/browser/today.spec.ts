import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const navLink = (page: Page, key: 'nav.today' | 'nav.wardrobe' | 'nav.outfits', language: Language = 'en') =>
  page.locator('.workspace-header nav').getByRole('link', { name: text(key, language), exact: true });
const cards = (page: Page) => page.locator('.today-card');
const names = (card: Locator) => card.locator('.outfit-component-name').allTextContents();
const allNames = (page: Page) => page.locator('.today-card').evaluateAll(list => list.map(card =>
  [...card.querySelectorAll('.outfit-component-name')].map(node => node.textContent ?? '').join(' + ')));
const missing = (language: Language, categories: MessageKey[]) =>
  text('today.missing', language, { categories: new Intl.ListFormat(locales[language], { type: 'conjunction' }).format(categories.map(key => text(key, language))) });

let serial = 0;
function add(api: Api, title: string, fields: Row, account: 'a' | 'b' = 'a') {
  const seeded = api.seedSavedItem(account, title);
  serial++;
  Object.assign(seeded.item as Row, { seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 1,
    created_at: `2026-09-09T00:00:${String(serial % 60).padStart(2, '0')}Z`, ...fields });
  return seeded;
}
function seedClothes(api: Api) {
  const tops = [add(api, 'White shirt', { colours: ['white'] }), add(api, 'Pink tee', { colours: ['pink'] }), add(api, 'Green polo', { colours: ['green'] })];
  const bottoms = [add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'] }), add(api, 'Red skirt', { category: 'bottom', colours: ['red'] })];
  const shoes = [add(api, 'Black boots', { category: 'footwear', colours: ['black'] }), add(api, 'Brown loafers', { category: 'footwear', colours: ['brown'] })];
  const peer = add(api, 'Robin private', { colours: ['white'] }, 'b');
  return { tops: tops.map(entry => entry.item), bottoms: bottoms.map(entry => entry.item), shoes: shoes.map(entry => entry.item), peer: peer.item };
}
type Clothes = ReturnType<typeof seedClothes>;
async function start(page: Page, language: Language = 'en', seed?: (api: Api, clothes: Clothes) => void, options: { clothes?: boolean } = {}) {
  const api = await mockBackend(page, { initialLanguage: language });
  const clothes = options.clothes === false ? null : seedClothes(api);
  seed?.(api, clothes!);
  await page.goto('/#/today'); await signIn(page);
  await expect(page.locator('.workspace-identity')).toBeVisible();
  await expect(page.locator('#today-title')).toHaveText(text('today.title', language));
  return { api, clothes: clothes! };
}
function traffic(page: Page) {
  const paths: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:54321') paths.push(`${request.method()} ${url.pathname}`);
  });
  return paths;
}
async function pageThrough(page: Page) {
  const seen: string[] = [];
  for (let round = 0; round < 20; round++) {
    if (await page.getByText(text('today.noMore'), { exact: true }).isVisible()) break;
    await expect(cards(page).first()).toBeVisible();
    seen.push(...await allNames(page));
    await button(page, 'today.more').click();
  }
  return seen;
}

test('I15 shows up to three ideas with reasons, pages through every idea and starts over', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(page.locator('#today-title')).toBeFocused();
  await expect(navLink(page, 'nav.today')).toHaveAttribute('aria-current', 'page');
  await expect(cards(page)).toHaveCount(3);
  for (const card of await cards(page).all()) {
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.today-pieces li')).toHaveCount(3);
    await expect(card.locator('.today-pieces img')).toHaveCount(3);
    await expect(card.locator('.today-reasons li').first()).toBeVisible();
  }
  const first = await allNames(page);
  const seen = await pageThrough(page);
  expect(seen).toHaveLength(3 * 2 * 2);
  expect(new Set(seen).size).toBe(12);
  await expect(button(page, 'today.more')).toHaveCount(0);
  await button(page, 'today.startOver').click();
  await expect(cards(page)).toHaveCount(3);
  expect(await allNames(page)).toEqual(first);
  expect(paths.filter(entry => /wear_event|\/functions\/|analy/i.test(entry))).toEqual([]);
});

test('I15 Like persists, Not for me hides the outfit for good and Undo brings it back', async ({ page }) => {
  const { api } = await start(page);
  const liked = await names(cards(page).nth(0));
  const likeButton = cards(page).nth(0).getByRole('button', { name: text('today.like'), exact: true });
  await likeButton.click();
  await expect(likeButton).toHaveAttribute('aria-pressed', 'true');
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);
  expect(await names(cards(page).nth(0))).toEqual(liked);

  const hiddenNames = await names(cards(page).nth(1));
  await cards(page).nth(1).getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));
  expect(api.suggestionFeedback.map(row => row.vote).sort()).toEqual([-1, 1]);
  await cards(page).nth(1).getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(cards(page).nth(1).locator('.outfit-component-name')).toHaveText(hiddenNames);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);
  await cards(page).nth(1).getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));

  await navLink(page, 'nav.wardrobe').click();
  await navLink(page, 'nav.today').click();
  await expect(cards(page)).toHaveCount(3);
  const likedCard = cards(page).filter({ has: page.getByRole('button', { name: text('today.like'), exact: true, pressed: true }) });
  await expect(likedCard).toHaveCount(1);
  expect(await names(likedCard)).toEqual(liked);
  const everything = await pageThrough(page);
  expect(everything).not.toContain(hiddenNames.join(' + '));
  expect(everything).toHaveLength(11);
});

test('I15 never suggests laundry, archived, excluded, photo-pending or another account\'s clothes, or an excluded pair', async ({ page }) => {
  const { api } = await start(page, 'en', (api, clothes) => {
    add(api, 'Laundry top', { colours: ['white'], availability: 'laundry' });
    add(api, 'Archived top', { colours: ['white'], lifecycle: 'archived' });
    add(api, 'Excluded top', { colours: ['white'], exclude_suggestions: true });
    const pending = add(api, 'Pending photo top', { colours: ['white'] });
    Object.assign(pending.image as Row, { state: 'pending' });
    const [low, high] = [String(clothes.tops[0]!.id), String(clothes.bottoms[0]!.id)].sort();
    api.combinationRules.push({ id: randomUUID(), owner_id: owners.a, item_low: low, item_high: high, created_at: '2026-09-09T00:00:00Z' });
    api.suggestionFeedback.push({ id: randomUUID(), owner_id: owners.b, item_ids: [String(clothes.peer.id)], signature: 'f'.repeat(64), vote: -1 });
  });
  const everything = await pageThrough(page);
  expect(everything).toHaveLength(3 * 2 * 2 - 2);
  for (const idea of everything) {
    expect(idea).not.toMatch(/Laundry|Archived|Excluded|Pending|Robin/);
    expect(idea.includes('White shirt') && idea.includes('Navy trousers')).toBe(false);
  }
  const reads = api.requests.filter(entry => ['/rest/v1/combination_rules', '/rest/v1/suggestion_feedback'].includes(entry.path));
  expect(reads.length).toBeGreaterThanOrEqual(2);
  for (const entry of reads) expect(entry.owner === owners.a && entry.ownerFilter === `eq.${owners.a}`).toBe(true);
});

test('I15 shows a partial start that leads to Add item', async ({ page }) => {
  await start(page, 'en', api => { add(api, 'Only shirt', { colours: ['white'] }); }, { clothes: false });
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('.outfit-component-name')).toHaveText(['Only shirt']);
  await expect(page.getByText(missing('en', ['categoryOne.bottom', 'categoryOne.footwear']), { exact: true })).toBeVisible();
  await expect(button(page, 'today.save')).toHaveCount(0);
  await button(page, 'wardrobe.add').click();
  await expect(page.locator('#capture-title')).toBeFocused();
});

test('I15 with no clothes shows a short empty state with Add item', async ({ page }) => {
  await start(page, 'en', api => { add(api, 'Robin private', { colours: ['white'] }, 'b'); }, { clothes: false });
  await expect(page.getByText(text('today.empty'), { exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(button(page, 'wardrobe.add')).toBeVisible();
});

test('I15 Save as outfit opens a filled-in editor and saves once through save_outfit', async ({ page }) => {
  const { api } = await start(page);
  await page.getByRole('combobox', { name: text('outfits.occasion'), exact: true }).selectOption('smart');
  await expect(cards(page).first()).toBeVisible();
  const chosen = await names(cards(page).nth(0));
  const ids = chosen.map(name => String(api.items.find(row => row.title === name)!.id));
  await cards(page).nth(0).getByRole('button', { name: text('today.save'), exact: true }).click();
  await expect(page.locator('#outfit-editor-title')).toBeFocused();
  await expect(page.locator('.outfit-slot .outfit-component-name')).toHaveText(chosen);
  await navLink(page, 'nav.today').click();
  await expect(page.locator('dialog[aria-labelledby="outfit-leave-title"]')).toBeVisible();
  await page.locator('dialog[aria-labelledby="outfit-leave-title"]').getByRole('button').first().click();
  await expect(page.locator('#outfit-editor-title')).toBeVisible();
  const bodies: Row[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/rest/v1/rpc/save_outfit') bodies.push(request.postDataJSON() as Row); });
  await page.locator('#outfit-name').fill('Friday');
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/rest/v1/rpc/save_outfit');
  await button(page, 'outfits.saveOutfit').click();
  await response;
  await expect(page.locator('#outfit-detail-title')).toHaveText('Friday');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ p_item_ids: ids, p_occasion: 'smart', p_title: 'Friday' });
  expect(api.outfits).toHaveLength(1);
});

test('I15 offline keeps ideas visible but disables saving and choices; a language change keeps the same ideas', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  const before = await allNames(page);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  for (const key of ['today.save', 'today.like', 'today.notForMe'] as const) await expect(cards(page).nth(0).getByRole('button', { name: text(key), exact: true })).toBeDisabled();
  const writes = paths.length;
  await page.context().setOffline(false);
  await page.getByRole('button', { name: text('account.menu', 'en') }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#today-title')).toHaveText(text('today.title', 'fi'));
  await expect(cards(page)).toHaveCount(3);
  expect(await allNames(page)).toEqual(before);
  await expect(button(page, 'today.more', 'fi')).toBeVisible();
  expect(paths.slice(0, writes).filter(entry => entry.startsWith('POST /rest/v1/suggestion') || entry.startsWith('DELETE'))).toEqual([]);
  expect(paths.filter(entry => /wear_event|\/functions\/|analy/i.test(entry))).toEqual([]);
});

test('I15 accessibility: axe on every state, keyboard, 320px and 200% text with three nav links', async ({ page }) => {
  await start(page);
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await axe();
  await cards(page).nth(1).getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));
  await axe();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    await expect(cards(page).first()).toBeVisible();
    expect(await page.evaluate(() => {
      const nav = document.querySelector('.workspace-header nav')!, header = nav.parentElement!;
      return document.documentElement.scrollWidth <= innerWidth && nav.scrollWidth <= nav.clientWidth
        && nav.getBoundingClientRect().right <= header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 0.5;
    })).toBe(true);
    for (const key of ['nav.today', 'nav.wardrobe', 'nav.outfits'] as const) {
      const link = navLink(page, key);
      await link.focus();
      await expect(link).toBeFocused();
      const box = await link.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44).toBe(true);
    }
    const save = cards(page).nth(0).getByRole('button', { name: text('today.save'), exact: true });
    await save.focus();
    await page.keyboard.press('Tab');
    await expect(cards(page).nth(0).getByRole('button', { name: text('today.like'), exact: true })).toBeFocused();
    await axe();
  }
});

test.describe('bounded I15 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) for (const scene of ['ideas', 'missing'] as const) {
    test(`${scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/i15-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async () => {
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
        const file = await open(path.join(directory, `${scene}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await page.setViewportSize({ width: selected.width, height: 900 });
      if (scene === 'ideas') {
        const { api } = await start(page, language);
        const like = cards(page).nth(0).getByRole('button', { name: text('today.like', language), exact: true });
        await like.click();
        await expect(like).toHaveAttribute('aria-pressed', 'true');
        expect(api.suggestionFeedback).toHaveLength(1);
        await expect(cards(page)).toHaveCount(3);
        // Photos load as they scroll into view; bring the last idea in before the full-page capture.
        await cards(page).nth(2).scrollIntoViewIfNeeded();
        await expect(page.locator('.today-card img')).toHaveCount(9);
        await page.evaluate(() => scrollTo(0, 0));
      } else {
        await start(page, language, api => { add(api, 'Only shirt', { colours: ['white'] }); }, { clothes: false });
        await expect(cards(page)).toHaveCount(1);
        await expect(page.getByText(missing(language, ['categoryOne.bottom', 'categoryOne.footwear']), { exact: true })).toBeVisible();
        await expect(page.locator('.today-card img')).toHaveCount(1);
      }
      await capture();
    });
  }
});
