import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
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
// Read names only once the card's pieces have rendered, so a capture is never an empty list.
async function names(card: Locator) {
  await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
  return card.locator('.outfit-component-name').allTextContents();
}
async function allNames(page: Page) {
  await expect(page.locator('.today-card .outfit-component-name')).not.toHaveCount(0);
  return page.locator('.today-card').evaluateAll(list => list.map(card =>
    [...card.querySelectorAll('.outfit-component-name')].map(node => node.textContent ?? '').join(' + ')));
}
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

test('I15 a choice whose reply is lost is checked against what was stored', async ({ page }) => {
  const { api } = await start(page);
  const checks: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/rest/v1/suggestion_feedback' && url.searchParams.has('signature') && request.method() === 'GET') checks.push(url.search);
  });
  const hidden = cards(page).nth(1);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await hidden.getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(hidden).toContainText(text('today.hidden'));
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
  expect(checks).toHaveLength(1);

  api.feedbackControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' });
  await hidden.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(hidden.getByRole('button', { name: text('today.notForMe'), exact: true })).toBeVisible();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback).toHaveLength(0);
  expect(checks).toHaveLength(2);

  const like = cards(page).nth(0).getByRole('button', { name: text('today.like'), exact: true });
  api.feedbackControl.faults.push({ method: 'POST', commit: false, fail: 503 });
  await like.click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  expect(api.suggestionFeedback).toHaveLength(0);
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);

  api.feedbackControl.faults.push({ method: 'DELETE', commit: false, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await like.click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(like).toBeDisabled();
  expect(api.suggestionFeedback).toHaveLength(1);
  await cards(page).nth(0).getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback).toHaveLength(0);
});

test('I15 a stored Not for me whose reply and check both fail is settled by Try again', async ({ page }) => {
  const { api } = await start(page);
  const card = cards(page).nth(1);
  const hiddenNames = await names(card);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(card.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
  for (const other of [cards(page).nth(0), cards(page).nth(2), card]) {
    for (const key of ['today.like', 'today.notForMe'] as const) await expect(other.getByRole('button', { name: text(key), exact: true })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: text('common.retry'), exact: true })).toHaveCount(1);
  await card.getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(card).toContainText(text('today.hidden'));
  await expect(card.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(card.locator('.outfit-component-name')).toHaveText(hiddenNames);
  expect(api.suggestionFeedback).toHaveLength(0);
});

test('I15 an unsettled choice keeps its card and Try again through a reconnect refresh', async ({ page }) => {
  const { api } = await start(page);
  const card = cards(page).nth(1);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  const reads = () => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length;
  const before = reads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(reads).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  await expect(cards(page)).toHaveCount(3);
  const retry = card.getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(card).toContainText(text('today.hidden'));
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
});

test('I15 paging and context stay put while a choice is written, so its Try again is kept', async ({ page }) => {
  const { api } = await start(page);
  const card = cards(page).nth(1);
  const shown = await names(card);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rest/v1/suggestion_feedback*', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.fallback();
  });
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  const more = page.getByRole('button', { name: text('today.more'), exact: true });
  await expect(more).toBeDisabled();
  const pickers = page.locator('.today-context select');
  await expect(pickers).toHaveCount(2);
  for (const picker of await pickers.all()) await expect(picker).toBeDisabled();
  release();
  const retry = card.getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible();
  await expect(more).toBeDisabled();
  await expect(card.locator('.outfit-component-name')).toHaveText(shown);
  await retry.click();
  await expect(card).toContainText(text('today.hidden'));
  await expect(more).toBeEnabled();
  for (const picker of await pickers.all()) await expect(picker).toBeEnabled();
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
});

test('I15 an older refresh never brings back a card hidden while it was loading', async ({ page }) => {
  const { api } = await start(page);
  const hiddenNames = await names(cards(page).nth(1));
  const gate = api.holdFeedbackReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(() => gate.held()).toBeGreaterThan(0);
  await cards(page).nth(1).getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));
  gate.release();
  await expect.poll(() => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));
  await cards(page).nth(1).getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(cards(page).nth(1).locator('.outfit-component-name')).toHaveText(hiddenNames);
  await cards(page).nth(1).getByRole('button', { name: text('today.notForMe'), exact: true }).click();
  await expect(cards(page).nth(1)).toContainText(text('today.hidden'));
  await navLink(page, 'nav.wardrobe').click();
  await navLink(page, 'nav.today').click();
  await expect(cards(page)).toHaveCount(3);
  expect(await pageThrough(page)).not.toContain(hiddenNames.join(' + '));
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
});

test('I15 a held read for one account never shows after signing in as another', async ({ page }) => {
  let gate!: { held: () => number; release: () => void };
  const { api } = await start(page, 'en', api => { gate = api.holdFeedbackReads(); });
  await expect.poll(() => gate.held()).toBeGreaterThan(0);
  await button(page, 'account.menu').click(); await button(page, 'auth.signOut').click();
  const from = api.requests.length;
  await signIn(page, 'b');
  await expect(page.locator('.workspace-identity')).toBeVisible();
  gate.release();
  await expect(cards(page).locator('.outfit-component-name')).toHaveText(['Robin private']);
  await page.waitForTimeout(500);
  await expect(page.getByText(/White shirt|Pink tee|Green polo|Navy trousers|Red skirt|Black boots|Brown loafers/)).toHaveCount(0);
  const later = api.requests.slice(from).filter(entry => entry.path.startsWith('/rest/v1/'));
  expect(later.length).toBeGreaterThan(0);
  expect(later.every(entry => entry.owner === owners.b)).toBe(true);
  expect(api.suggestionFeedback).toHaveLength(0);
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
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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
  // Staying closes the dialog and returns focus to the Today link on the next frame; typing before that lands
  // while focus is still moving.
  await expect(page.locator('dialog[aria-labelledby="outfit-leave-title"]')).toHaveCount(0);
  await expect(navLink(page, 'nav.today')).toBeFocused();
  const bodies: Row[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/rest/v1/rpc/save_outfit') bodies.push(request.postDataJSON() as Row); });
  await page.locator('#outfit-name').fill('Friday');
  await expect(page.locator('#outfit-name')).toHaveValue('Friday');
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
  await expect(cards(page)).toHaveCount(3);
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

// Two-piece ideas: each dress with each pair of shoes.
function seedDresses(api: Api) {
  return [add(api, 'Blue dress', { category: 'one_piece', colours: ['blue'] }), add(api, 'Green dress', { category: 'one_piece', colours: ['green'] }),
    add(api, 'Black boots', { category: 'footwear', colours: ['black'] }), add(api, 'Brown loafers', { category: 'footwear', colours: ['brown'] })].map(entry => entry.item);
}
const pairOf = (api: Api, first: string, second: string) => {
  const ids = [first, second].map(name => String(api.items.find(row => row.title === name)!.id)).sort();
  return { item_low: ids[0], item_high: ids[1] };
};
const rulesOf = (api: Api) => api.combinationRules.map(row => ({ owner_id: row.owner_id, item_low: row.item_low, item_high: row.item_high }));
const dontPair = (card: Locator, language: Language = 'en') => card.getByRole('button', { name: text('today.dontPair', language), exact: true });
const together = (idea: string, first: string, second: string) => idea.includes(first) && idea.includes(second);

test('Don\'t pair these avoids a two-piece idea at once, and Undo brings it back', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  expect(pieces).toHaveLength(2);
  await dontPair(card).click();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.locator('.outfit-component-name')).toHaveText(pieces);
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeFocused();
  await expect(card.getByRole('button', { name: text('today.save'), exact: true })).toHaveCount(0);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, pieces[0]!, pieces[1]!) }]);
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(dontPair(card)).toBeFocused();
  expect(await names(card)).toEqual(pieces);
  expect(api.combinationRules).toHaveLength(0);
});

test('Don\'t pair these asks which two, hides other ideas with them now and keeps them apart afterwards', async ({ page }) => {
  const { api } = await start(page);
  await expect(cards(page)).toHaveCount(3);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  expect(pieces).toHaveLength(3);
  await dontPair(card).click();
  const chooser = card.getByRole('group', { name: text('today.pickPair'), exact: true });
  await expect(chooser.locator('legend')).toBeFocused();
  await chooser.getByRole('button', { name: text('common.cancel'), exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expect(dontPair(card)).toBeFocused();
  expect(api.combinationRules).toHaveLength(0);

  await dontPair(card).click();
  const confirm = chooser.getByRole('button', { name: text('today.pairConfirm'), exact: true });
  const boxes = chooser.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  await expect(confirm).toBeDisabled();
  await boxes.nth(0).check();
  await expect(confirm).toBeDisabled();
  await boxes.nth(2).check();
  await expect(confirm).toBeEnabled();
  await boxes.nth(1).check();
  await expect(confirm).toBeDisabled();
  await boxes.nth(1).uncheck();
  const [first, second] = [pieces[0]!, pieces[2]!];
  // Another idea on this page holds the same two pieces before the choice.
  expect((await allNames(page)).filter(idea => together(idea, first, second)).length).toBeGreaterThanOrEqual(1);
  await confirm.click();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.locator('.outfit-component-name')).toHaveText([first, second]);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, first, second) }]);
  const rest = await cards(page).evaluateAll(list => list.filter(node => !node.querySelector('[role=status]'))
    .map(node => [...node.querySelectorAll('.outfit-component-name')].map(name => name.textContent ?? '').join(' + ')));
  for (const idea of rest) expect(together(idea, first, second)).toBe(false);

  await button(page, 'today.more').click();
  for (const idea of await pageThrough(page)) expect(together(idea, first, second)).toBe(false);
  await navLink(page, 'nav.wardrobe').click();
  await navLink(page, 'nav.today').click();
  const all = await pageThrough(page);
  expect(all.length).toBeGreaterThan(0);
  for (const idea of all) expect(together(idea, first, second)).toBe(false);
});

test('Don\'t pair these checks a lost reply against what was stored and settles an unknown Undo with Try again', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const card = cards(page).nth(0);
  const pieces = await names(card);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await dontPair(card).click();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(1);

  api.pairControl.faults.push({ method: 'DELETE', commit: false, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
  await expect(cards(page).nth(1).getByRole('button', { name: text('today.like'), exact: true })).toBeDisabled();
  await expect(button(page, 'today.more')).toBeDisabled();
  expect(api.combinationRules).toHaveLength(1);
  await card.getByRole('button', { name: text('common.retry'), exact: true }).click();
  expect(await names(card)).toEqual(pieces);
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(0);

  api.pairControl.faults.push({ method: 'POST', commit: false, fail: 503 });
  await dontPair(card).click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(dontPair(card)).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
});

test('Don\'t pair these settles a stored choice whose reply and check were lost when Today refreshes after a reconnect', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  const reads = () => api.requests.filter(entry => entry.path === '/rest/v1/combination_rules' && entry.method === 'GET').length;
  const reconnect = async () => {
    const before = reads();
    await page.context().setOffline(true);
    await expect(page.locator('.notice-offline')).toBeVisible();
    await page.context().setOffline(false);
    await expect.poll(reads).toBeGreaterThan(before);
  };
  // The pair is stored, but neither its reply nor the check that follows arrives.
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await dontPair(card).click();
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  await expect(button(page, 'today.more')).toBeDisabled();
  expect(api.combinationRules).toHaveLength(1);
  await reconnect();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.locator('.outfit-component-name')).toHaveText(pieces);
  await expect(card.getByRole('button', { name: text('today.save'), exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(cards(page).nth(1).getByRole('button', { name: text('today.like'), exact: true })).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);

  // The same for an Undo that removed the pair.
  api.pairControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  expect(api.combinationRules).toHaveLength(0);
  await reconnect();
  await expect(dontPair(card)).toBeEnabled();
  expect(await names(card)).toEqual(pieces);
  await expect(card.getByRole('status')).toHaveCount(0);
  await expect(button(page, 'today.more')).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
});

// Holds the read-back of one avoided pair (the exact low/high read) until released; the list read passes.
async function holdPairCheck(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  const pattern = /\/rest\/v1\/combination_rules\?.*item_low=/;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    held++;
    await gate;
    await route.fallback();
  };
  await page.route(pattern, handler);
  return { held: () => held, release, off: () => page.unroute(pattern, handler) };
}

test('Don\'t pair these keeps an unsettled card with only Try again when a refresh overlaps its check, in either order', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  const feedbackReads = () => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length;
  const settlingCard = async () => {
    await expect(cards(page)).toHaveCount(3);
    await expect(card.locator('.outfit-component-name')).toHaveText(pieces);
    await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeEnabled();
    for (const key of ['today.save', 'today.like', 'today.notForMe', 'today.dontPair', 'common.undo'] as const) {
      await expect(card.getByRole('button', { name: text(key), exact: true })).toHaveCount(0);
    }
    await expect(button(page, 'today.more')).toBeDisabled();
  };

  // 1. A refresh starts after the pair is stored and before its check fails, and finishes after it.
  const check = await holdPairCheck(page);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await dontPair(card).click();
  await expect.poll(check.held).toBe(1);
  const gate = api.holdFeedbackReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(() => gate.held()).toBeGreaterThan(0);
  check.release();
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  gate.release();
  await expect.poll(feedbackReads).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await settlingCard();
  expect(api.combinationRules).toHaveLength(1);
  await card.getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(dontPair(card)).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
  await check.off();

  // 2. A refresh starts and finishes while the check is still held; the check fails afterwards.
  const later = await holdPairCheck(page);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await dontPair(card).click();
  await expect.poll(later.held).toBe(1);
  const before = feedbackReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(feedbackReads).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  // Still being checked: the card stays, and nothing on it can be saved.
  await expect(cards(page)).toHaveCount(3);
  await expect(card.getByRole('button', { name: text('today.save'), exact: true })).toBeDisabled();
  later.release();
  await settlingCard();
  // A refresh started after the check failed finds the pair stored and settles it.
  const after = feedbackReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(feedbackReads).toBeGreaterThan(after);
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  expect(api.combinationRules).toHaveLength(1);
});

test('Don\'t pair these is unavailable offline and sends nothing', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(cards(page)).toHaveCount(3);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await expect(dontPair(cards(page).nth(0))).toBeDisabled();
  await page.context().setOffline(false);
  expect(paths.filter(entry => entry.includes('combination_rules') && !entry.startsWith('GET'))).toEqual([]);
});

test('Don\'t pair these accessibility: axe on the chooser and the hidden card, keyboard, 320px and 200% text', async ({ page }) => {
  await start(page);
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    const card = cards(page).nth(0);
    await dontPair(card).focus();
    await page.keyboard.press('Enter');
    const chooser = card.getByRole('group', { name: text('today.pickPair'), exact: true });
    await expect(chooser.locator('legend')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(chooser.getByRole('button', { name: text('today.pairConfirm'), exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await chooser.locator('input, button').all()) {
      const box = await control.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 320).toBe(true);
    }
    await axe();
    await chooser.getByRole('button', { name: text('today.pairConfirm'), exact: true }).press('Enter');
    await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe();
    await card.getByRole('button', { name: text('common.undo'), exact: true }).press('Enter');
    await expect(dontPair(card)).toBeFocused();
  }
});

async function openSettings(page: Page, language: Language, seed: (api: Api) => void) {
  const api = await mockBackend(page, { initialLanguage: language });
  seed(api);
  await page.goto('/#/settings'); await signIn(page);
  await expect(page.locator('#settings-title')).toBeVisible();
  return api;
}
const avoidPair = (api: Api, first: Row, second: Row) => {
  const [low, high] = [String(first.id), String(second.id)].sort();
  api.combinationRules.push({ id: randomUUID(), owner_id: first.owner_id, item_low: low, item_high: high, created_at: '2026-09-09T00:00:00Z' });
};

test('Avoided pairs in Settings lists own pairs with both pieces, skips a trashed piece and removes a pair', async ({ page }) => {
  const api = await openSettings(page, 'en', api => {
    const clothes = seedClothes(api);
    const trashed = add(api, 'Old jacket', { category: 'outerwear', deleted_at: '2026-09-10T00:00:00Z' }).item;
    const peerShoes = add(api, 'Robin shoes', { category: 'footwear' }, 'b').item;
    avoidPair(api, clothes.tops[0]!, clothes.bottoms[1]!);
    avoidPair(api, clothes.tops[1]!, trashed);
    avoidPair(api, clothes.peer, peerShoes);
  });
  const section = page.locator('section[aria-labelledby="avoided-pairs-heading"]');
  await expect(section.getByRole('heading', { name: text('pairs.title'), exact: true })).toBeVisible();
  const rows = section.locator('.avoided-pair');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator('.outfit-component-name')).toHaveText(['White shirt', 'Red skirt']);
  await rows.nth(0).scrollIntoViewIfNeeded();
  await expect(rows.nth(0).locator('img')).toHaveCount(2);
  await expect(section).not.toContainText('Old jacket');
  await expect(section).not.toContainText('Robin');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const remove = rows.nth(0).getByRole('button', { name: text('pairs.removeLabel', 'en', { items: 'White shirt and Red skirt' }), exact: true });
  await expect(remove).toHaveText(text('pairs.remove'));
  await remove.click();
  await expect(section.getByText(text('pairs.empty'), { exact: true })).toBeVisible();
  await expect(section.getByRole('heading', { name: text('pairs.title'), exact: true })).toBeFocused();
  expect(api.combinationRules.map(row => row.owner_id).sort()).toEqual([owners.a, owners.b]);
  expect(api.combinationRules.some(row => row.owner_id === owners.a && api.items.find(item => item.id === row.item_low || item.id === row.item_high)?.title === 'White shirt')).toBe(false);
  const reads = api.requests.filter(entry => entry.path === '/rest/v1/combination_rules');
  for (const entry of reads) expect(entry.owner === owners.a && entry.ownerFilter === `eq.${owners.a}`).toBe(true);
});

test('Avoided pairs shows a failed removal, checks a lost reply and fits 320px at 200% text', async ({ page }) => {
  const api = await openSettings(page, 'sv', api => {
    const clothes = seedClothes(api);
    avoidPair(api, clothes.tops[0]!, clothes.bottoms[0]!);
    avoidPair(api, clothes.tops[1]!, clothes.shoes[0]!);
  });
  const section = page.locator('section[aria-labelledby="avoided-pairs-heading"]');
  const rows = section.locator('.avoided-pair');
  await expect(rows).toHaveCount(2);
  api.pairControl.faults.push({ method: 'DELETE', commit: false, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await rows.nth(0).locator('button').click();
  await expect(rows.nth(0).getByRole('alert')).toHaveText(text('pairs.removeFailed', 'sv'));
  expect(api.combinationRules).toHaveLength(2);
  api.pairControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' });
  await rows.nth(0).locator('button').click();
  await expect(rows).toHaveCount(1);
  expect(api.combinationRules).toHaveLength(1);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
  await section.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await rows.nth(0).locator('button').boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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

test.describe('bounded Don\'t pair visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [{ scene: 'pair-chooser', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile', zoom: false },
    { scene: 'pair-chooser', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-320-200', zoom: true },
    { scene: 'pair-hidden', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop', zoom: false },
    { scene: 'avoided-pairs', project: 'mobile', language: 'sv', width: 320, suffix: 'sv-mobile', zoom: false }] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/i15-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      let fullPage = true;
      // The chooser is captured as its own element, so its actions are never cut off by the viewport.
      let element: Locator | null = null;
      if (selected.scene === 'avoided-pairs') {
        await openSettings(page, language, api => {
          const clothes = seedClothes(api);
          avoidPair(api, clothes.tops[0]!, clothes.bottoms[1]!);
          avoidPair(api, clothes.tops[1]!, clothes.shoes[0]!);
        });
        const section = page.locator('section[aria-labelledby="avoided-pairs-heading"]');
        await expect(section.locator('.avoided-pair')).toHaveCount(2);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('img')).toHaveCount(4);
        await section.evaluate(node => node.scrollIntoView({ block: 'start' }));
        fullPage = false;
      } else {
        const { api } = await start(page, language);
        if (selected.zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
        const card = cards(page).nth(0);
        // Photos load as they scroll into view.
        await card.locator('.today-pieces li').last().scrollIntoViewIfNeeded();
        await expect(card.locator('img')).toHaveCount(3);
        await dontPair(card, language).click();
        const chooser = card.getByRole('group', { name: text('today.pickPair', language), exact: true });
        await chooser.getByRole('checkbox').nth(0).check();
        if (selected.scene === 'pair-hidden') {
          await chooser.getByRole('checkbox').nth(2).check();
          await chooser.getByRole('button', { name: text('today.pairConfirm', language), exact: true }).click();
          await expect(card.getByRole('status')).toHaveText(text('today.pairHidden', language));
          expect(api.combinationRules).toHaveLength(1);
          await cards(page).last().scrollIntoViewIfNeeded();
          await page.evaluate(() => scrollTo(0, 0));
        } else {
          // One piece ticked: Confirm waits for a second.
          await expect(chooser.getByRole('button', { name: text('today.pairConfirm', language), exact: true })).toBeDisabled();
          await expect(chooser.getByRole('button', { name: text('common.cancel', language), exact: true })).toBeEnabled();
          await chooser.locator('label').last().scrollIntoViewIfNeeded();
          await expect(chooser.locator('img')).toHaveCount(3);
          element = chooser;
        }
      }
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await expect(page.locator('.workspace-identity')).toContainText('Alex');
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === 900
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: language, width: selected.width })).toBe(true);
      if (!write) return;
      const png = element ? await element.screenshot({ animations: 'disabled', type: 'png', scale: 'css' })
        : await page.screenshot({ fullPage, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && (element ? png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= selected.width : png.readUInt32BE(16) === selected.width)).toBe(true);
      const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});