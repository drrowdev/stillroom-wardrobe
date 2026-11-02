import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n/all';
import { helsinkiOffsetSeconds } from './helsinki-offset';
import { mockBackend, owners, signIn } from './mock-backend';
import { dismissKeyboard, expectIdentity, expectSignedIn, openAccountMenu, settleShell, shellNav } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const navLink = (page: Page, key: 'nav.today' | 'nav.wardrobe' | 'nav.outfits', language: Language = 'en') =>
  shellNav(page).getByRole('link', { name: text(key, language), exact: true });
const cards = (page: Page) => page.locator('.today-card');
// Today shows up to three ideas together; the first card is "the idea showing" unless a test says otherwise.
const featured = (page: Page) => cards(page).first();
const idea = (page: Page, index: number) => cards(page).nth(index);
const ideaTitle = (page: Page) => page.locator('.today-idea-title').first();
const ideaTitleText = (number: number, total: number, language: Language = 'en') => text('today.ideaOf', language, { number, total });
const moreOptions = (page: Page, index = 0) => idea(page, index).locator('.today-menu-toggle');
const menuPanel = (page: Page, index = 0) => idea(page, index).locator('.today-menu-panel');
const menuButton = (page: Page, key: MessageKey, language: Language = 'en', index = 0) => menuPanel(page, index).getByRole('button', { name: text(key, language), exact: true });
async function openMenu(page: Page, index = 0) {
  if (await moreOptions(page, index).getAttribute('aria-expanded') !== 'true') await moreOptions(page, index).click();
  await expect(menuPanel(page, index)).toBeVisible();
}
async function fromMenu(page: Page, key: MessageKey, language: Language = 'en', index = 0) {
  await openMenu(page, index);
  await menuButton(page, key, language, index).click();
}
// Read names only once the card's pieces have rendered, so a capture is never an empty list.
async function names(card: Locator) {
  await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
  return card.locator('.outfit-component-name').allTextContents();
}
const joined = (card: Locator) => card.evaluate(node => [...node.querySelectorAll('.outfit-component-name')].map(name => name.textContent ?? '').join(' + '));
// The outfits of every card showing, in order. Collapsed cards (hidden) have no pieces and are left out.
async function pageIdeas(page: Page) {
  await expect(ideaTitle(page)).toBeVisible();
  const found: string[] = [];
  for (const card of await cards(page).all()) {
    if (await card.evaluate(node => node.classList.contains('today-card-hidden'))) continue;
    await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
    found.push(await joined(card));
  }
  return found;
}
// Show other ideas, then wait until a different set (or the end of the ideas) is showing.
async function showAnother(page: Page, language: Language = 'en') {
  const before = await ideaTitle(page).getAttribute('id', { timeout: 500 }).catch(() => null);
  await button(page, 'today.more', language).click();
  await expect(async () => {
    const ended = await page.locator('#today-no-more, #today-gone').count();
    const now = await ideaTitle(page).getAttribute('id', { timeout: 500 }).catch(() => null);
    expect(ended > 0 || now !== null && now !== before).toBe(true);
  }).toPass();
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
async function start(page: Page, language: Language = 'en', seed?: (api: Api, clothes: Clothes) => void,
  options: { clothes?: boolean; weather?: Row; prepare?: () => Promise<void> } = {}) {
  const api = await mockBackend(page, { initialLanguage: language, ...options.weather && { weather: { a: options.weather } } });
  const clothes = options.clothes === false ? null : seedClothes(api);
  seed?.(api, clothes!);
  await options.prepare?.();
  await page.goto('/#/today'); await signIn(page);
  await expectSignedIn(page);
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
// Shows every page of ideas with Show other ideas until the ideas run out. Collapsed cards (hidden) are passed over.
async function pageThrough(page: Page, visit?: (card: Locator) => Promise<void>) {
  const seen: string[] = [];
  for (let round = 0; round < 40; round++) {
    await expect(ideaTitle(page).or(page.locator('#today-no-more'))).toBeVisible();
    if (await page.locator('#today-no-more').isVisible()) break;
    for (const card of await cards(page).all()) {
      if (await card.evaluate(node => node.classList.contains('today-card-hidden'))) continue;
      await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
      seen.push(await joined(card));
      await visit?.(card);
    }
    await showAnother(page);
  }
  return seen;
}
// Leaving Today and coming back starts again from the first page of ideas.
async function startAgain(page: Page, total = 3) {
  await navLink(page, 'nav.wardrobe').click();
  await navLink(page, 'nav.today').click();
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, total));
}

test('I15 shows three ideas with reasons, pages through every idea and starts over', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(page.locator('#today-title')).toBeFocused();
  await expect(navLink(page, 'nav.today')).toHaveAttribute('aria-current', 'page');
  await expect(cards(page)).toHaveCount(3);
  for (const index of [0, 1, 2]) await expect(idea(page, index).locator('.today-idea-title')).toHaveText(ideaTitleText(index + 1, 3));
  const card = featured(page);
  await expect(card.locator('.today-pieces li')).toHaveCount(3);
  await expect(card.locator('.today-pieces img')).toHaveCount(3);
  await expect(card.locator('.today-reasons li').first()).toBeVisible();
  for (const each of await cards(page).all()) await expect(each.locator('.button-primary')).toHaveText(text('calendar.wearToday'));
  const first = await pageIdeas(page);
  expect(new Set(first).size).toBe(3);
  await showAnother(page);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.getByRole('status').filter({ hasText: text('today.newIdeas') })).toBeVisible();
  expect((await pageIdeas(page)).filter(entry => first.includes(entry))).toEqual([]);
  await startAgain(page);
  const seen = await pageThrough(page);
  expect(seen).toHaveLength(3 * 2 * 2);
  expect(new Set(seen).size).toBe(12);
  await expect(page.locator('#today-no-more')).toBeFocused();
  await expect(button(page, 'today.more')).toHaveCount(0);
  await button(page, 'today.startOver').click();
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3));
  await expect(ideaTitle(page)).toBeFocused();
  expect(await pageIdeas(page)).toEqual(first);
  expect(paths.filter(entry => /wear_event|\/functions\/|analy/i.test(entry))).toEqual([]);
});

test('I15 Show other ideas replaces the set with the next three, never repeating an idea', async ({ page }) => {
  const { api } = await start(page);
  const shown: string[] = [];
  for (let index = 0; index < 2; index++) {
    await expect(cards(page)).toHaveCount(3);
    shown.push(...await pageIdeas(page));
    // Pressed from the keyboard: Safari does not focus a button that is clicked.
    await button(page, 'today.more').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: text('today.newIdeas') })).toBeVisible();
    await expect(button(page, 'today.more')).toBeFocused();
  }
  expect(new Set(shown).size).toBe(6);
  await startAgain(page);
  expect((await pageThrough(page)).slice(0, 6)).toEqual(shown);
  expect(api.suggestionFeedback).toHaveLength(0);
});

test('Show other ideas offers other bottoms, tops and shoes within six ideas when one bottom is slightly favoured', async ({ page }) => {
  const seed = (api: Api) => {
    ['Linen shirt', 'Cotton tee', 'Oxford shirt', 'Poplin shirt', 'Jersey tee', 'Camp shirt'].forEach(title => add(api, title, { colours: ['white'], seasons: ['summer'] }));
    add(api, 'Favourite chinos', { category: 'bottom', colours: ['navy'], favourite: true, seasons: ['summer'] });
    add(api, 'Plain chinos', { category: 'bottom', colours: ['navy'], seasons: ['summer'] });
    ['Boots', 'Loafers', 'Trainers', 'Sandals'].forEach(title => add(api, title, { category: 'footwear', colours: ['black'], seasons: ['summer'] }));
  };
  const { api } = await start(page, 'en', seed, { clothes: false });
  const shown: string[][] = [];
  for (let index = 0; index < 2; index++) {
    await expect(cards(page)).toHaveCount(3);
    for (const card of await cards(page).all()) shown.push(await names(card));
    await showAnother(page);
  }
  const bottoms = shown.map(pieces => pieces.find(name => /chinos/.test(name)));
  expect(new Set(bottoms)).toEqual(new Set(['Favourite chinos', 'Plain chinos']));
  expect(new Set(shown.map(pieces => pieces.join('+'))).size).toBe(6);
  expect(new Set(shown.flatMap(pieces => pieces.filter(name => /shirt|tee/.test(name)))).size).toBe(6);
  expect(new Set(shown.flatMap(pieces => pieces.filter(name => ['Boots', 'Loafers', 'Trainers', 'Sandals'].includes(name)))).size).toBe(4);
  await startAgain(page);
  expect(await names(featured(page))).toEqual(shown[0]);
  expect(api.suggestionFeedback).toHaveLength(0);
});
test('I15 Like persists, Don\'t suggest this outfit hides it for good and Undo brings it back', async ({ page }) => {
  const { api } = await start(page);
  const liked = await names(featured(page));
  const likeButton = featured(page).getByRole('button', { name: text('today.like'), exact: true });
  await likeButton.click();
  await expect(likeButton).toHaveAttribute('aria-pressed', 'true');
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);
  expect(await names(featured(page))).toEqual(liked);

  const second = idea(page, 1);
  const hiddenNames = await names(second);
  const others = [await names(featured(page)), await names(idea(page, 2))];
  const bodies: Row[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/rest/v1/suggestion_feedback' && request.method() === 'POST') bodies.push(request.postDataJSON() as Row);
  });
  await fromMenu(page, 'today.notForMe', 'en', 1);
  await expect(second).toContainText(text('today.hidden'));
  await expect(second.getByRole('button', { name: text('common.undo'), exact: true })).toBeFocused();
  // The other two ideas stay where they are.
  await expect(cards(page)).toHaveCount(3);
  expect(await names(featured(page))).toEqual(others[0]);
  expect(await names(idea(page, 2))).toEqual(others[1]);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ vote: -1, item_ids: [...idsOf(api, hiddenNames)].sort() });
  expect(api.suggestionFeedback.map(row => row.vote).sort()).toEqual([-1, 1]);
  await second.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(second.locator('.outfit-component-name')).toHaveText(hiddenNames);
  await expect(moreOptions(page, 1)).toBeFocused();
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);
  await fromMenu(page, 'today.notForMe', 'en', 1);
  await expect(second).toContainText(text('today.hidden'));
  // A hidden idea keeps Show other ideas.
  await expect(button(page, 'today.more')).toBeEnabled();

  await startAgain(page);
  let likedSeen = 0;
  const everything = await pageThrough(page, async card => {
    if (await card.getByRole('button', { name: text('today.like'), exact: true }).getAttribute('aria-pressed') === 'true') {
      likedSeen++;
      expect(await names(card)).toEqual(liked);
    }
  });
  expect(likedSeen).toBe(1);
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
  const hidden = idea(page, 1);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await fromMenu(page, 'today.notForMe', 'en', 1);
  await expect(hidden).toContainText(text('today.hidden'));
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
  expect(checks).toHaveLength(1);

  api.feedbackControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' });
  await hidden.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(hidden.getByRole('button', { name: text('today.like'), exact: true })).toBeVisible();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback).toHaveLength(0);
  expect(checks).toHaveLength(2);

  const like = featured(page).getByRole('button', { name: text('today.like'), exact: true });
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
  await expect(moreOptions(page)).toBeDisabled();
  expect(api.suggestionFeedback).toHaveLength(1);
  await featured(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.suggestionFeedback).toHaveLength(0);
});

test('I15 a stored Don\'t suggest whose reply and check both fail is settled by Try again', async ({ page }) => {
  const { api } = await start(page);
  const card = featured(page);
  const hiddenNames = await names(card);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.notForMe');
  await expect(card.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
  await expect(card.getByRole('button', { name: text('today.like'), exact: true })).toBeDisabled();
  await expect(moreOptions(page)).toBeDisabled();
  await expect(button(page, 'today.more')).toBeDisabled();
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
  const card = featured(page);
  const title = await ideaTitle(page).textContent();
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.notForMe');
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  const reads = () => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length;
  const before = reads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(reads).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  await expect(cards(page)).toHaveCount(3);
  await expect(ideaTitle(page)).toHaveText(title!);
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
  const card = featured(page);
  const shown = await names(card);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rest/v1/suggestion_feedback*', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.fallback();
  });
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.notForMe');
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

test('I15 an older refresh never brings back an idea hidden while it was loading', async ({ page }) => {
  const { api } = await start(page);
  const hiddenNames = await names(featured(page));
  const gate = api.holdFeedbackReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(() => gate.held()).toBeGreaterThan(0);
  await fromMenu(page, 'today.notForMe');
  await expect(featured(page)).toContainText(text('today.hidden'));
  gate.release();
  await expect.poll(() => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await expect(featured(page)).toContainText(text('today.hidden'));
  await featured(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(featured(page).locator('.outfit-component-name')).toHaveText(hiddenNames);
  await fromMenu(page, 'today.notForMe');
  await expect(featured(page)).toContainText(text('today.hidden'));
  await startAgain(page);
  expect(await pageThrough(page)).not.toContain(hiddenNames.join(' + '));
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([-1]);
});

test('I15 a refresh keeps the ideas showing, drops a card that goes and never swaps in another', async ({ page }) => {
  const { api } = await start(page);
  const shown = await pageIdeas(page);
  expect(shown).toHaveLength(3);
  const itemReads = () => api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length;
  const refresh = async () => {
    const before = itemReads();
    await page.context().setOffline(true);
    await expect(page.locator('.notice-offline')).toBeVisible();
    await page.context().setOffline(false);
    await expect.poll(itemReads).toBeGreaterThan(before);
    await page.waitForTimeout(300);
  };
  // A refresh that changes the clothes but not the ideas keeps every card.
  const pieces = shown.map(idea => idea.split(' + '));
  const renamed = pieces[0]!.find(name => !pieces[1]!.includes(name) && !pieces[2]!.includes(name)) ?? pieces[0]![0]!;
  Object.assign(api.items.find(row => row.title === renamed)!, { title: `${renamed} 2`, version: 2 });
  await refresh();
  await expect(cards(page)).toHaveCount(3);
  const before = shown.map(idea => idea.replace(renamed, `${renamed} 2`));
  expect(await pageIdeas(page)).toEqual(before);

  // A piece goes to the laundry. The page is ranked again. Cards without that piece stay, in their order, and no new idea is mixed in;
  // if every card goes, the ideas not shown before take their place.
  const leaving = pieces[0]!.find(name => name !== renamed)!;
  Object.assign(api.items.find(row => row.title === leaving)!, { availability: 'laundry' });
  await refresh();
  await expect(cards(page).first().or(page.locator('#today-gone'))).toBeVisible();
  const remaining = await cards(page).count() ? await pageIdeas(page) : [];
  for (const idea of remaining) expect(idea).not.toContain(leaving);
  const kept = remaining.filter(idea => before.includes(idea));
  expect(kept.length === 0 || kept.length === remaining.length).toBe(true);
  expect(kept).toEqual(before.filter(idea => kept.includes(idea)));
  if (!remaining.length) await expect(page.locator('#today-gone')).toHaveText(text('today.ideaGone'));
  await expect(button(page, 'today.more')).toBeEnabled();
  // Show other ideas then offers ideas not shown before and without the piece that went.
  const onScreen = remaining;
  await showAnother(page);
  for (const idea of await pageThrough(page)) {
    expect(before).not.toContain(idea);
    expect(onScreen).not.toContain(idea);
    expect(idea).not.toContain(leaving);
  }
});

test('I15 an idea shown before a refresh pushed it off the page does not come back on the next page', async ({ page }) => {
  const seed = (api: Api) => {
    ['Linen shirt', 'Cotton tee', 'Oxford shirt', 'Poplin shirt', 'Jersey tee'].forEach(title => add(api, title, { colours: ['white'] }));
    ['Favourite polo 1', 'Favourite polo 2', 'Favourite polo 3'].forEach(title => add(api, title, { colours: ['white'], favourite: true, availability: 'laundry' }));
    add(api, 'Chinos', { category: 'bottom', colours: ['navy'] });
    add(api, 'Boots', { category: 'footwear', colours: ['black'] });
  };
  const { api } = await start(page, 'en', seed, { clothes: false });
  const shown = await pageIdeas(page);
  expect(shown).toHaveLength(3);
  const before = api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length;
  // Three favourites come back from the laundry and rank first: every idea already shown leaves the page.
  for (const row of api.items.filter(item => String(item.title).startsWith('Favourite polo'))) Object.assign(row, { availability: 'ready', version: 2 });
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(() => api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length).toBeGreaterThan(before);
  await page.waitForTimeout(300);
  // Every idea shown has left the page, so the ideas not shown before take their place; nothing shown comes back.
  await expect.poll(async () => (await cards(page).count()) === 3 && (await pageIdeas(page)).every(idea => !shown.includes(idea))).toBe(true);
  const fresh = await pageIdeas(page);
  expect(fresh.every(idea => idea.includes('Favourite polo'))).toBe(true);
  await button(page, 'today.more').click();
  const later = await pageThrough(page);
  // Nothing already shown returns, and every idea not shown yet is still reached.
  expect(later.filter(idea => shown.includes(idea) || fresh.includes(idea))).toEqual([]);
  expect(new Set(later).size).toBe(later.length);
  expect(new Set([...shown, ...fresh, ...later]).size).toBe(8);
  // Start over forgets what was shown: the earlier ideas can come back.
  await button(page, 'today.startOver').click();
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3));
  expect((await pageThrough(page)).some(idea => shown.includes(idea))).toBe(true);
});
test('I15 a held read for one account never shows after signing in as another', async ({ page }) => {
  let gate!: { held: () => number; release: () => void };
  const { api } = await start(page, 'en', api => { gate = api.holdFeedbackReads(); });
  await expect.poll(() => gate.held()).toBeGreaterThan(0);
  await openAccountMenu(page, 'en'); await button(page, 'auth.signOut').click();
  const from = api.requests.length;
  await signIn(page, 'b');
  await expectSignedIn(page);
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
  await expect(button(page, 'calendar.wearToday')).toHaveCount(0);
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
  await expect(featured(page)).toBeVisible();
  const chosen = await names(featured(page));
  const ids = chosen.map(name => String(api.items.find(row => row.title === name)!.id));
  await featured(page).getByRole('button', { name: text('today.save'), exact: true }).click();
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

test('I15 offline keeps the idea visible but disables wearing, saving and choices; a language change keeps the same idea', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(cards(page)).toHaveCount(3);
  const before = await pageIdeas(page);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  for (const each of await cards(page).all()) {
    for (const key of ['calendar.wearToday', 'today.save', 'today.like'] as const) await expect(each.getByRole('button', { name: text(key), exact: true })).toBeDisabled();
  }
  for (const index of [0, 1, 2]) await expect(moreOptions(page, index)).toBeDisabled();
  const writes = paths.length;
  await page.context().setOffline(false);
  await openAccountMenu(page, 'en');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#today-title')).toHaveText(text('today.title', 'fi'));
  await expect(cards(page)).toHaveCount(3);
  expect(await pageIdeas(page)).toEqual(before);
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3, 'fi'));
  await expect(button(page, 'today.more', 'fi')).toBeVisible();
  expect(paths.slice(0, writes).filter(entry => entry.startsWith('POST /rest/v1/suggestion') || entry.startsWith('DELETE'))).toEqual([]);
  expect(paths.filter(entry => /wear_event|\/functions\/|analy/i.test(entry))).toEqual([]);
});

test('I15 More options opens and closes with the keyboard and returns focus to its button', async ({ page }) => {
  await start(page);
  const toggle = moreOptions(page);
  await expect(toggle).toHaveAccessibleName(text('common.moreOptions'));
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(menuPanel(page)).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(menuButton(page, 'today.notForMe')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menuButton(page, 'today.dontPair')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menuPanel(page)).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(menuPanel(page)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(menuPanel(page)).toBeHidden();
  // Focus in the context row stays there while the ideas change.
  const occasion = page.getByRole('combobox', { name: text('outfits.occasion'), exact: true });
  await occasion.focus();
  await occasion.selectOption('smart');
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3));
  await page.waitForTimeout(300);
  await expect(occasion).toBeFocused();
});

test('I15 accessibility: axe on every state, keyboard, 320px and 200% text with the menu open', async ({ page }) => {
  await start(page);
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await axe();
  await fromMenu(page, 'today.notForMe');
  await expect(featured(page)).toContainText(text('today.hidden'));
  await axe();
  await featured(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(moreOptions(page)).toBeFocused();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) { await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' }); await settleShell(page); }
    await expect(featured(page)).toBeVisible();
    expect(await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.top-nav, .tab-bar')].find(element => getComputedStyle(element).display !== 'none')!, header = nav.parentElement!;
      return document.documentElement.scrollWidth <= innerWidth && nav.scrollWidth <= nav.clientWidth
        && nav.getBoundingClientRect().right <= header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 0.5;
    })).toBe(true);
    for (const key of ['nav.today', 'nav.wardrobe', 'nav.outfits'] as const) {
      const link = navLink(page, key);
      await dismissKeyboard(page);
      await link.focus();
      await expect(link).toBeFocused();
      const box = await link.boundingBox();
      // WebKit can place a reflowed tab's edge one 1/64 px layout unit past the viewport; allow sub-pixel rounding.
      expect(box !== null && box.x >= 0 && box.x + box.width <= 320.5 && box.height >= 44).toBe(true);
    }
    await featured(page).getByRole('button', { name: text('calendar.wearToday'), exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(featured(page).getByRole('button', { name: text('today.save'), exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(featured(page).getByRole('button', { name: text('today.like'), exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(moreOptions(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menuPanel(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await featured(page).locator('button').all()) {
      if (!await control.isVisible()) continue;
      const box = await control.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44).toBe(true);
    }
    await axe();
    await page.keyboard.press('Escape');
    await expect(moreOptions(page)).toBeFocused();
  }
});

// Records save_wear_event bodies and can hold their replies; reads of a look by its ID can be failed.
async function wearRoutes(page: Page) {
  const held: Array<() => Promise<void>> = [];
  const bodies: Row[] = [];
  const state = { hold: false, failReads: false, reads: 0 };
  await page.route(url => url.pathname === '/rest/v1/rpc/save_wear_event', route => {
    bodies.push(route.request().postDataJSON() as Row);
    if (!state.hold) return route.fallback();
    return new Promise<void>(resolve => { held.push(() => route.fallback().then(resolve)); });
  });
  await page.route(url => url.pathname === '/rest/v1/wear_events' && (url.searchParams.get('id') ?? '').startsWith('eq.'), route => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.reads++;
    return state.failReads ? route.abort() : route.fallback();
  });
  return { held, bodies, state };
}
const wearPanel = (page: Page) => page.locator('#today-wear-panel');
const wearButton = (page: Page) => featured(page).getByRole('button', { name: text('calendar.wearToday'), exact: true });
const idsOf = (api: Api, titles: string[]) => titles.map(title => String(api.items.find(row => row.title === title)!.id));

test('I15 Wear today marks the idea as worn once, with Undo', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  const pieces = await names(featured(page));
  await wearButton(page).click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  await expect(wearPanel(page)).toContainText(pieces[0]!);
  const undo = wearPanel(page).getByRole('button', { name: text('common.undo'), exact: true });
  await expect(undo).toBeFocused();
  expect(wear.bodies).toHaveLength(1);
  expect(wear.bodies[0]).toMatchObject({ p_item_ids: idsOf(api, pieces), p_state: 'worn', p_outfit_id: null, p_label: text('calendar.defaultLook') });
  expect(api.wearEvents.filter(row => row.owner_id === owners.a && row.deleted_at === null)).toHaveLength(1);
  await undo.click();
  await expect(wearPanel(page)).toContainText(text('calendar.undone'));
  expect(api.wearEvents.filter(row => row.owner_id === owners.a && row.deleted_at === null)).toHaveLength(0);
  await wearPanel(page).getByRole('button', { name: text('common.close'), exact: true }).click();
  await expect(wearPanel(page)).toHaveCount(0);
  await wearButton(page).click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  expect(wear.bodies).toHaveLength(2);
  expect(wear.bodies[1]!.p_id).not.toBe(wear.bodies[0]!.p_id);
});

test('I15 an unknown Wear today stays with its own idea: no other idea can write until it is settled', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  const ideaA = await names(featured(page));
  // The look is not stored and its reread fails, so the outcome is unknown.
  api.wearControl.next = { mode: 'lost' };
  wear.state.failReads = true;
  await wearButton(page).click();
  const retry = wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(wearPanel(page)).toContainText(ideaA[0]!);
  const attempt = wear.bodies[0]!;
  expect(attempt.p_item_ids).toEqual(idsOf(api, ideaA));

  for (const change of ['another', 'page', 'occasion', 'weather'] as const) {
    if (change === 'another') await showAnother(page);
    if (change === 'page') { await showAnother(page); await showAnother(page); }
    if (change === 'occasion') await page.getByRole('combobox', { name: text('outfits.occasion'), exact: true }).selectOption('smart');
    if (change === 'weather') {
      await page.locator('#weather-trigger').click();
      await page.getByRole('button', { name: text('setting.indoors'), exact: true }).click();
    }
    await expect(featured(page)).toBeVisible();
    await expect(wearButton(page)).toBeDisabled();
    await expect(wearButton(page)).toHaveAttribute('aria-describedby', 'today-wear-panel');
    await expect(wearPanel(page)).toContainText(ideaA[0]!);
    await expect(retry).toBeVisible();
  }
  expect(wear.bodies).toHaveLength(1);

  wear.state.failReads = false;
  await retry.click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  expect(wear.bodies).toHaveLength(2);
  expect(wear.bodies[1]).toMatchObject({ p_id: attempt.p_id, p_item_ids: attempt.p_item_ids });
  const stored = api.wearEvents.filter(row => row.owner_id === owners.a);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.id).toBe(attempt.p_id);
  await expect(wearButton(page)).toBeEnabled();
});

test('I15 coming back to Today reads an unconfirmed Wear today back before the idea showing can write', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  await showAnother(page);
  const ideaA = await names(featured(page));
  api.wearControl.next = { mode: 'lost' };
  wear.state.failReads = true;
  await wearButton(page).click();
  await expect(wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible({ timeout: 15_000 });
  const attempt = wear.bodies[0]!;
  wear.state.reads = 0;
  await startAgain(page);
  // The first idea shows, but the kept look is read back by its own ID first, and nothing is sent.
  await expect.poll(() => wear.state.reads).toBeGreaterThan(0);
  await expect(wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(wearPanel(page)).toContainText(ideaA[0]!);
  await expect(wearButton(page)).toBeDisabled();
  expect(wear.bodies).toHaveLength(1);
  // Reads work again: the look was not stored, so Try again sends that same look.
  wear.state.failReads = false;
  await wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  expect(wear.bodies[1]).toMatchObject({ p_id: attempt.p_id, p_item_ids: attempt.p_item_ids });
  await wearPanel(page).getByRole('button', { name: text('common.close'), exact: true }).click();
  const ideaOne = await names(featured(page));
  await wearButton(page).click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  expect(wear.bodies).toHaveLength(3);
  expect(wear.bodies[2]!.p_id).not.toBe(attempt.p_id);
  expect(wear.bodies[2]!.p_item_ids).toEqual(idsOf(api, ideaOne));
});

test('I15 a Wear today stored but changed since offers no Undo', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  // Stored, but the reply and the check are lost.
  api.wearControl.next = { mode: 'committedLost' };
  wear.state.failReads = true;
  await wearButton(page).click();
  const retry = wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  const stored = api.wearEvents.filter(row => row.owner_id === owners.a);
  expect(stored).toHaveLength(1);
  // Changed on another device before it is checked again.
  Object.assign(stored[0]!, { label: 'Changed elsewhere', version: Number(stored[0]!.version) + 1 });
  wear.state.failReads = false;
  await retry.click();
  await expect(wearPanel(page)).toContainText(text('calendar.alreadySaved'));
  await expect(wearPanel(page).getByRole('button', { name: text('common.undo'), exact: true })).toHaveCount(0);
  expect(wear.bodies).toHaveLength(1);
  await expect(wearButton(page)).toBeEnabled();
});

test('I15 a Wear today being written holds navigation, survives a refresh and is not shown to another account', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  wear.state.hold = true;
  const title = await ideaTitle(page).textContent();
  const pieces = await names(featured(page));
  await wearButton(page).click();
  await expect.poll(() => wear.held.length).toBe(1);
  await expect(button(page, 'today.more')).toBeDisabled();
  await page.locator('#weather-trigger').click();
  await expect(page.getByRole('button', { name: text('setting.outdoors'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: text('setting.indoors'), exact: true })).toBeDisabled();
  await expect(button(page, 'weather.enterTemperature')).toBeDisabled();
  await page.locator('#weather-details').getByRole('button', { name: text('common.close'), exact: true }).click();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.locator('.notice-offline')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(ideaTitle(page)).toHaveText(title!);
  await expect(featured(page).locator('.outfit-component-name')).toHaveText(pieces);
  await navLink(page, 'nav.wardrobe').click();
  await expect(page.locator('#today-title')).toBeVisible();
  expect(wear.bodies).toHaveLength(1);
  wear.state.hold = false;
  await wear.held.shift()!();
  await expect(page.locator('#today-title')).toHaveCount(0);
  expect(wear.bodies).toHaveLength(1);
  expect(api.wearEvents.filter(row => row.owner_id === owners.a)).toHaveLength(1);

  // An unknown Wear today belongs to its own owner session.
  await navLink(page, 'nav.today').click();
  await expect(ideaTitle(page)).toBeVisible();
  api.wearControl.next = { mode: 'lost' };
  wear.state.failReads = true;
  await showAnother(page);
  await wearButton(page).click();
  await expect(wearPanel(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible({ timeout: 15_000 });
  await openAccountMenu(page, 'en'); await button(page, 'auth.signOut').click();
  await signIn(page, 'b');
  await expectSignedIn(page);
  await expect(page.locator('#today-title')).toBeVisible();
  await expect(cards(page).locator('.outfit-component-name')).toHaveText(['Robin private']);
  await expect(wearPanel(page)).toHaveCount(0);
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
const together = (idea: string, first: string, second: string) => idea.includes(first) && idea.includes(second);

const undoPair = (page: Page, language: Language = 'en') => button(page, 'today.undoPair', language);
const ideaNames = (page: Page) => featured(page).locator('.outfit-component-name');
const pairWrites = (paths: string[]) => paths.filter(entry => entry.startsWith('POST') && entry.includes('combination_rules')).length;
// Records whether the summary this change removed is ever rendered, even briefly.
async function watchSummary(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { summaryShown: boolean };
    w.summaryShown = false;
    new MutationObserver(() => { if (/suggested together|ehdoteta yhdessä|föreslås inte tillsammans/.test(document.body.innerText)) w.summaryShown = true; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return async () => page.evaluate(() => (window as unknown as { summaryShown: boolean }).summaryShown);
}

test('Don\'t pair these saves a two-piece pair once, removes only that idea and Undo brings it back', async ({ page }) => {
  const paths = traffic(page);
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const before = await pageIdeas(page);
  const pieces = await names(featured(page));
  expect(pieces).toHaveLength(2);
  const summaryShown = await watchSummary(page);
  await fromMenu(page, 'today.dontPair');
  await expect(undoPair(page)).toBeVisible();
  // The idea goes and the others stay, in their order, without a replacement.
  await expect(cards(page)).toHaveCount(2);
  expect(await pageIdeas(page)).toEqual(before.slice(1));
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 2));
  for (const idea of await pageIdeas(page)) expect(together(idea, pieces[0]!, pieces[1]!)).toBe(false);
  await expect(undoPair(page)).toHaveText(text('common.undo'));
  await expect(ideaTitle(page)).toBeFocused();
  await expect(featured(page).getByRole('button', { name: text('today.save'), exact: true })).toBeEnabled();
  expect(await summaryShown()).toBe(false);
  expect(pairWrites(paths)).toBe(1);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, pieces[0]!, pieces[1]!) }]);

  await undoPair(page).click();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
  expect(await pageIdeas(page)).toEqual(before);
  await expect(ideaTitle(page)).toBeFocused();
  expect(api.combinationRules).toHaveLength(0);
  expect(await summaryShown()).toBe(false);
});

test('Don\'t pair these removes each idea, moves on to the next page when none is left, then the end, and keeps Undo for the latest pair', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const avoided: string[][] = [];
  // Four ideas over two pages: the third avoided pair empties the first page.
  for (let round = 0; round < 4; round++) {
    const idea = await names(featured(page));
    avoided.push(idea);
    await fromMenu(page, 'today.dontPair');
    if (round < 2) await expect(cards(page)).toHaveCount(2 - round);
    if (round === 2) await expect(cards(page)).toHaveCount(1);
    if (round < 3) {
      await expect(ideaNames(page)).not.toHaveText(idea);
      const next = await names(featured(page));
      for (const earlier of avoided) expect(together(next.join(' + '), earlier[0]!, earlier[1]!)).toBe(false);
    }
  }
  await expect(page.locator('#today-no-more')).toBeVisible();
  await expect(page.locator('#today-no-more')).toBeFocused();
  await expect(undoPair(page)).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(4);
  // Undo allows only the latest pair.
  await undoPair(page).click();
  await expect(undoPair(page)).toHaveCount(0);
  expect(rulesOf(api)).toHaveLength(3);
  expect(rulesOf(api)).not.toContainEqual({ owner_id: owners.a, ...pairOf(api, avoided[3]![0]!, avoided[3]![1]!) });
  await startAgain(page, 1);
  expect((await pageThrough(page)).filter(idea => together(idea, avoided[3]![0]!, avoided[3]![1]!))).toHaveLength(1);
});

test('Don\'t pair these asks which two, then removes the ideas holding both and keeps the two apart afterwards', async ({ page }) => {
  const paths = traffic(page);
  const { api } = await start(page);
  await expect(cards(page)).toHaveCount(3);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  expect(pieces).toHaveLength(3);
  await fromMenu(page, 'today.dontPair');
  const chooser = card.getByRole('group', { name: text('today.pickPair'), exact: true });
  await expect(chooser.locator('legend')).toBeFocused();
  await chooser.getByRole('button', { name: text('common.cancel'), exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expect(moreOptions(page)).toBeFocused();
  expect(api.combinationRules).toHaveLength(0);
  expect(pairWrites(paths)).toBe(0);

  await fromMenu(page, 'today.dontPair');
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
  const summaryShown = await watchSummary(page);
  await confirm.click();
  await expect(undoPair(page)).toBeVisible();
  await expect(ideaTitle(page)).toBeFocused();
  expect(await summaryShown()).toBe(false);
  expect(pairWrites(paths)).toBe(1);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, first, second) }]);
  // The idea showing and every later idea keep the two apart.
  const all = await pageThrough(page);
  expect(all.length).toBeGreaterThan(0);
  for (const idea of all) expect(together(idea, first, second)).toBe(false);
  await startAgain(page);
  for (const idea of await pageThrough(page)) expect(together(idea, first, second)).toBe(false);
});

test('Don\'t pair these keeps the idea and says so when the write is rejected, and a second try moves on', async ({ page }) => {
  const paths = traffic(page);
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const pieces = await names(featured(page));
  const summaryShown = await watchSummary(page);
  api.pairControl.faults.push({ method: 'POST', commit: false, fail: 503 });
  await fromMenu(page, 'today.dontPair');
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(ideaNames(page)).toHaveText(pieces);
  await expect(undoPair(page)).toHaveCount(0);
  await expect(moreOptions(page)).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
  await fromMenu(page, 'today.dontPair');
  await expect(undoPair(page)).toBeVisible();
  await expect(ideaNames(page)).not.toHaveText(pieces);
  expect(pairWrites(paths)).toBe(2);
  expect(api.combinationRules).toHaveLength(1);
  expect(await summaryShown()).toBe(false);
});

test('Don\'t pair these checks a lost reply against what was stored, moves on once and settles Undo that fails or is unknown', async ({ page }) => {
  const paths = traffic(page);
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const pieces = await names(featured(page));
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await fromMenu(page, 'today.dontPair');
  await expect(undoPair(page)).toBeVisible();
  await expect(ideaNames(page)).not.toHaveText(pieces);
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(1);
  expect(pairWrites(paths)).toBe(1);
  const next = await names(featured(page));

  // A rejected Undo says so and stays available.
  api.pairControl.faults.push({ method: 'DELETE', commit: false, fail: 503 });
  await undoPair(page).click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(undoPair(page)).toBeEnabled();
  await expect(undoPair(page)).toBeFocused();
  expect(api.combinationRules).toHaveLength(1);
  await expect(ideaNames(page)).toHaveText(next);

  // An Undo whose outcome is unknown keeps everything locked until Try again settles it.
  api.pairControl.faults.push({ method: 'DELETE', commit: false, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await undoPair(page).click();
  const retry = page.locator('.today-undo').getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(button(page, 'today.more')).toBeDisabled();
  await expect(moreOptions(page)).toBeDisabled();
  // Saving or wearing would leave Today and lose this Try again.
  await expect(featured(page).getByRole('button', { name: text('today.save'), exact: true })).toBeDisabled();
  await expect(featured(page).getByRole('button', { name: text('calendar.wearToday'), exact: true })).toBeDisabled();
  expect(api.combinationRules).toHaveLength(1);
  await retry.click();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(ideaNames(page)).toHaveText(pieces);
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  await expect(ideaTitle(page)).toBeFocused();
  await expect(featured(page).getByRole('button', { name: text('today.save'), exact: true })).toBeEnabled();
  await expect(featured(page).getByRole('button', { name: text('calendar.wearToday'), exact: true })).toBeEnabled();
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
  const summaryShown = await watchSummary(page);
  // The pair is stored, but neither its reply nor the check that follows arrives.
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.dontPair');
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  await expect(button(page, 'today.more')).toBeDisabled();
  await expect(undoPair(page)).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(1);
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeFocused();
  await reconnect();
  await expect(undoPair(page)).toBeVisible();
  await expect(ideaNames(page)).not.toHaveText(pieces);
  await expect(ideaTitle(page)).toBeFocused();
  await expect(page.getByRole('button', { name: text('common.retry'), exact: true })).toHaveCount(0);
  await expect(button(page, 'today.more')).toBeEnabled();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);

  // The same for an Undo that removed the pair.
  api.pairControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await undoPair(page).click();
  await expect(page.locator('.today-undo').getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  expect(api.combinationRules).toHaveLength(0);
  await reconnect();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(ideaNames(page)).toHaveText(pieces);
  await expect(ideaTitle(page)).toBeFocused();
  await expect(moreOptions(page)).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
  expect(await summaryShown()).toBe(false);
});

// Holds the read-back of one avoided pair (the exact low/high read) until released; the list read passes.
const oulu = { weather_enabled: true, weather_city: 'Oulu, Finland', latitude: 65, longitude: 25.5 };
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
  const paths = traffic(page);
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
    await expect(undoPair(page)).toHaveCount(0);
    await expect(button(page, 'today.more')).toBeDisabled();
  };

  // 1. A refresh starts after the pair is stored and before its check fails, and finishes after it.
  const check = await holdPairCheck(page);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.dontPair');
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
  await expect(undoPair(page)).toBeEnabled();
  await expect(ideaNames(page)).not.toHaveText(pieces);
  await expect(button(page, 'today.more')).toBeEnabled();
  await undoPair(page).click();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(ideaNames(page)).toHaveText(pieces);
  expect(api.combinationRules).toHaveLength(0);
  await check.off();

  // 2. A refresh starts and finishes while the check is still held; the check fails afterwards.
  const later = await holdPairCheck(page);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 }, { method: 'READ', commit: false, fail: 500 });
  await fromMenu(page, 'today.dontPair');
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
  await expect(undoPair(page)).toBeEnabled();
  await expect(ideaNames(page)).not.toHaveText(pieces);
  await expect(button(page, 'today.more')).toBeEnabled();
  expect(api.combinationRules).toHaveLength(1);
  // One write per avoid and one Try again: a refresh never adds a write.
  expect(pairWrites(paths)).toBe(3);
});

test('Don\'t pair these is unavailable offline and sends nothing', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(cards(page)).toHaveCount(3);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await expect(moreOptions(page)).toBeDisabled();
  await page.context().setOffline(false);
  expect(paths.filter(entry => entry.includes('combination_rules') && !entry.startsWith('GET'))).toEqual([]);
});

test('Undo for a pair is unavailable offline and does not move focus while Today refreshes', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await fromMenu(page, 'today.dontPair');
  await expect(undoPair(page)).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await expect(undoPair(page)).toBeDisabled();
  await page.context().setOffline(false);
  await expect(undoPair(page)).toBeEnabled();
  // Focus on the context row stays there through the refresh a reconnect starts.
  const occasion = page.getByRole('combobox', { name: text('outfits.occasion'), exact: true });
  await occasion.focus();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await page.waitForTimeout(400);
  await expect(occasion).toBeFocused();
  expect(api.combinationRules).toHaveLength(1);
  // A new context starts again from the first ideas, and the old Undo goes.
  await occasion.selectOption('smart');
  await expect(undoPair(page)).toHaveCount(0);
});

// The focus move after a confirmed pair is queued for the next frame. If Occasion takes focus before that frame runs, the move must not take it back.
test('A pending move to the next idea does not take focus from Occasion after a pair is confirmed', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  // A held callback counts as a focus request when the call that queued it came from the Today screen's source (its only frame callbacks are focus moves).
  const focusRequests = () => page.evaluate(() => (window as unknown as { frameHold?: FrameHold }).frameHold?.focusRequests() ?? -1);
  const release = () => page.evaluate(() => (window as unknown as { frameHold?: FrameHold }).frameHold?.release());
  const occasion = page.getByRole('combobox', { name: text('outfits.occasion'), exact: true });
  try {
    await holdFrames(page, 'today-screen');
    const before = await focusRequests();
    expect(before).toBeGreaterThanOrEqual(0);
    await fromMenu(page, 'today.dontPair');
    await expect(undoPair(page)).toBeEnabled();
    // The pair has been confirmed and the move to the next idea has queued its focus, which is waiting for a frame while focus is lost.
    await expect.poll(focusRequests).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.activeElement?.matches('body, main') ?? false)).toBe(true);
    expect(api.combinationRules).toHaveLength(1);
    await occasion.focus();
    await expect(occasion).toBeFocused();
    await release();
    // Two frames: the one queued before, and any it queues in turn.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(occasion).toBeFocused();
  } finally {
    await release();
    await page.waitForFunction(() => !(window as unknown as { frameHold?: FrameHold }).frameHold);
  }
});

// The page's animation-frame functions are replaced until every held callback has run or been cancelled, then restored. Held callbacks get ids of their own
// (from 1,000,000) that stay valid for cancelAnimationFrame after release: the page's caller keeps its id, which maps to the native one until the callback has run.
type FrameHold = { focusRequests: () => number; release: () => void };
async function holdFrames(page: Page, source: string) {
  await page.evaluate(source => {
    const nativeRequest = window.requestAnimationFrame;
    const nativeCancel = window.cancelAnimationFrame;
    const held = new Map<number, { callback: FrameRequestCallback; focus: boolean }>();
    const queued = new Map<number, number>();
    const limit = 500;
    const first = 1_000_000;
    let next = first;
    let releasing = false;
    const restore = () => {
      if (!releasing || held.size > 0 || queued.size > 0) return;
      window.requestAnimationFrame = nativeRequest;
      window.cancelAnimationFrame = nativeCancel;
      delete (window as unknown as { frameHold?: FrameHold }).frameHold;
    };
    window.requestAnimationFrame = callback => {
      if (releasing || held.size >= limit) return nativeRequest.call(window, callback);
      const id = next++;
      held.set(id, { callback, focus: new Error().stack?.includes(source) === true });
      return id;
    };
    window.cancelAnimationFrame = id => {
      if (held.delete(id)) return;
      const native = queued.get(id);
      if (native !== undefined) { queued.delete(id); nativeCancel.call(window, native); restore(); return; }
      // An id from this hold that has already run or been cancelled is not a native id.
      if (id < first) nativeCancel.call(window, id);
    };
    (window as unknown as { frameHold?: FrameHold }).frameHold = {
      focusRequests: () => [...held.values()].filter(entry => entry.focus).length,
      release: () => {
        if (releasing) return;
        releasing = true;
        for (const [id, { callback }] of [...held]) {
          held.delete(id);
          queued.set(id, nativeRequest.call(window, time => { queued.delete(id); try { callback(time); } finally { restore(); } }));
        }
        restore();
      },
    };
  }, source);
}

test('Held animation frames honour cancellation before and after release, run once, and restore the page functions', async ({ page }) => {
  await page.evaluate(() => Object.assign(window, { frameOriginals: [window.requestAnimationFrame, window.cancelAnimationFrame] }));
  await holdFrames(page, 'none');
  const outcome = await page.evaluate(async () => {
    const ran: string[] = [];
    const before = requestAnimationFrame(() => ran.push('cancelled before release'));
    const after = requestAnimationFrame(() => ran.push('cancelled after release'));
    requestAnimationFrame(() => ran.push('kept'));
    cancelAnimationFrame(before);
    (window as unknown as { frameHold: FrameHold }).frameHold.release();
    // Released and queued natively, not yet run: the caller's original id must still cancel it.
    cancelAnimationFrame(after);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const originals = (window as unknown as { frameOriginals: unknown[] }).frameOriginals;
    return { ran, restored: window.requestAnimationFrame === originals[0] && window.cancelAnimationFrame === originals[1],
      control: 'frameHold' in window };
  });
  expect(outcome).toEqual({ ran: ['kept'], restored: true, control: false });
});

// Holds a write to the pairs table (the pair choice, or its Undo) until released.
async function holdPairWrite(page: Page, method: 'POST' | 'DELETE') {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  await page.route(/\/rest\/v1\/combination_rules/, async route => {
    if (route.request().method() !== method) { await route.fallback(); return; }
    held++;
    await gate;
    await route.fallback();
  });
  return { held: () => held, release };
}

test('Undo for a pair holds Save and Wear today while it is written, and until a Try again settles it', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const pieces = await names(featured(page));
  await fromMenu(page, 'today.dontPair');
  await expect(undoPair(page)).toBeVisible();
  const save = featured(page).getByRole('button', { name: text('today.save'), exact: true });
  const wearToday = featured(page).getByRole('button', { name: text('calendar.wearToday'), exact: true });
  await expect(save).toBeEnabled();
  await expect(wearToday).toBeEnabled();

  // While the Undo is on its way, leaving Today would lose it.
  const write = await holdPairWrite(page, 'DELETE');
  await undoPair(page).click();
  await expect.poll(write.held).toBe(1);
  await expect(undoPair(page)).toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeDisabled();
  await expect(wearToday).toBeDisabled();
  write.release();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(ideaNames(page)).toHaveText(pieces);
  await expect(save).toBeEnabled();
  await expect(wearToday).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
});

// Cool days (10 degrees by day) for today and tomorrow, as Open-Meteo's forecast would reply, held until released.
function coldForecast(now = Date.now()) {
  const offset = helsinkiOffsetSeconds(now);
  const first = new Date(now + offset * 1000).toISOString().slice(0, 10);
  const time: string[] = [], temperature: number[] = [], rain: number[] = [], wind: number[] = [];
  for (let index = 0; index < 48; index++) {
    const day = new Date(Date.parse(`${first}T00:00:00Z`) + Math.floor(index / 24) * 86400000).toISOString().slice(0, 10);
    const hour = index % 24;
    const daytime = hour >= 7 && hour <= 21;
    time.push(`${day}T${String(hour).padStart(2, '0')}:00`);
    temperature.push(daytime ? 10 : -5); rain.push(daytime ? 5 : 100); wind.push(daytime ? 2 : 40);
  }
  return { latitude: 65, longitude: 25.5, timezone: 'Europe/Helsinki', utc_offset_seconds: offset,
    current_units: { time: 'iso8601', temperature_2m: '°C' },
    current: { time: new Date(Math.floor(now / 900_000) * 900_000 + offset * 1000).toISOString().slice(0, 16), temperature_2m: 10 },
    hourly: { time, temperature_2m: temperature, precipitation_probability: rain, wind_speed_10m: wind } };
}
async function heldForecast(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let served = 0;
  await page.route(/^https:\/\/api\.open-meteo\.com\//, async route => {
    await gate;
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(coldForecast()) }).catch(() => {});
    served++;
  });
  return { release, served: () => served };
}
// At 10 degrees the Green dress alone is the right warmth and the Blue dress is not, so the first idea changes when the forecast arrives.
function seedWarmth(api: Api) {
  for (const [title, category, warmth] of [['Blue dress', 'one_piece', 0], ['Green dress', 'one_piece', 3], ['Black boots', 'footwear', null], ['Brown loafers', 'footwear', null]] as const) {
    add(api, title, { category, warmth, colours: ['blue'], ...warmth !== null && { field_provenance: { warmth: { kind: 'user', revision: 1 } } } });
  }
}

for (const mode of ['avoid', 'undo', 'undo-lost-reply'] as const) {
  test(`A pair choice confirmed after a new forecast arrives does not move the new context (${mode})`, async ({ page }) => {
    let forecast!: Awaited<ReturnType<typeof heldForecast>>;
    const { api } = await start(page, 'en', api => { seedWarmth(api); }, { clothes: false, weather: oulu, prepare: async () => { forecast = await heldForecast(page); } });
    await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3));
    // Begin on a Blue dress idea, which the forecast will not rank first.
    const slot = (await pageIdeas(page)).findIndex(entry => entry.startsWith('Blue dress'));
    expect(slot).toBeGreaterThanOrEqual(0);
    const original = await names(idea(page, slot));
    expect(original[0]).toBe('Blue dress');
    let hold: { release: () => void };
    if (mode === 'avoid') {
      const write = await holdPairWrite(page, 'POST');
      await fromMenu(page, 'today.dontPair', 'en', slot);
      await expect.poll(write.held).toBe(1);
      hold = write;
    } else {
      await fromMenu(page, 'today.dontPair', 'en', slot);
      await expect(undoPair(page)).toBeVisible();
      if (mode === 'undo') {
        const write = await holdPairWrite(page, 'DELETE');
        await undoPair(page).click();
        await expect.poll(write.held).toBe(1);
        hold = write;
      } else {
        const check = await holdPairCheck(page);
        api.pairControl.faults.push({ method: 'DELETE', commit: true, fail: 503 });
        await undoPair(page).click();
        await expect.poll(check.held).toBe(1);
        hold = check;
      }
    }
    // The forecast arrives while the choice is still being settled, and only counts once it is.
    forecast.release();
    await expect.poll(forecast.served).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    hold.release();
    // The new weather starts from its own first idea: the confirmation of the old one neither pins that idea nor pages on.
    await expect(button(page, 'today.more')).toBeEnabled();
    await expect(undoPair(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 3));
    await expect(page.locator('#today-gone, #today-no-more')).toHaveCount(0);
    const first = await names(featured(page));
    expect(first[0]).toBe('Green dress');
    expect(api.combinationRules).toHaveLength(mode === 'avoid' ? 1 : 0);
    // The idea that was showing is still among this weather's ideas, after the first.
    const seen = await pageThrough(page);
    expect(seen[0]).toBe(first.join(' + '));
    const originalIdea = original.join(' + ');
    expect(seen.includes(originalIdea)).toBe(mode !== 'avoid');
  });
}

test('Don\'t pair these accessibility: axe on the chooser and the next idea, keyboard, 320px and 200% text', async ({ page }) => {
  await start(page);
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    const card = cards(page).nth(0);
    await moreOptions(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(menuButton(page, 'today.dontPair')).toBeFocused();
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
    await expect(undoPair(page)).toBeVisible();
    await expect(ideaTitle(page)).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await undoPair(page).boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 320).toBe(true);
    await axe();
    await undoPair(page).press('Enter');
    await expect(undoPair(page)).toHaveCount(0);
    await expect(ideaTitle(page)).toBeFocused();
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
  // WebKit can place a reflowed tab's edge one 1/64 px layout unit past the viewport; allow sub-pixel rounding.
  expect(box !== null && box.x >= 0 && box.x + box.width <= 320.5 && box.height >= 44).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test('Today lays the ideas out as a swipe row on a phone and side by side on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const set = page.locator('.today-set');
  await expect(cards(page)).toHaveCount(3);
  const boxOf = async (index: number) => (await idea(page, index).boundingBox())!;
  const row = (await set.boundingBox())!;
  const [first, second] = [await boxOf(0), await boxOf(1)];
  // One card is mostly visible and the next one peeks in; the row scrolls, the page does not.
  expect(first.width).toBeGreaterThanOrEqual(row.width * 0.8);
  expect(second.x).toBeGreaterThan(first.x + first.width);
  expect(second.x).toBeLessThan(390 - 16);
  expect(second.x + second.width).toBeGreaterThan(390);
  expect(await set.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).scrollSnapType.startsWith('x'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Reaching a card with the keyboard brings it into view. WebKit's scroll on focus inside a snap row is not deterministic, so only the
  // Chromium-based projects assert it.
  await idea(page, 2).getByRole('button', { name: text('calendar.wearToday'), exact: true }).focus();
  if (test.info().project.name !== 'webkit-photo') {
    await expect.poll(async () => { const box = await boxOf(2); return box.x >= 0 && box.x + box.width <= 390 + 1; }).toBe(true);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(async () => { const boxes = [await boxOf(0), await boxOf(1), await boxOf(2)]; return boxes.every(box => Math.abs(box.y - boxes[0]!.y) < 1) && boxes[1]!.x > boxes[0]!.x && boxes[2]!.x > boxes[1]!.x; }).toBe(true);
  expect(await set.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('Today shows the ideas that exist when fewer than three can be made', async ({ page }) => {
  await start(page, 'en', api => {
    add(api, 'Only shirt', { colours: ['white'] });
    add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'] });
    add(api, 'Grey trousers', { category: 'bottom', colours: ['grey'] });
    add(api, 'Black boots', { category: 'footwear', colours: ['black'] });
  }, { clothes: false });
  await expect(cards(page)).toHaveCount(2);
  await expect(ideaTitle(page)).toHaveText(ideaTitleText(1, 2));
  await expect(idea(page, 1).locator('.today-idea-title')).toHaveText(ideaTitleText(2, 2));
  await showAnother(page);
  await expect(page.locator('#today-no-more')).toHaveText(text('today.noMore'));
});

test('Don\'t pair these removes only its card when other ideas share the pair, and the pair keeps them off the next page', async ({ page }) => {
  const { api } = await start(page, 'en', api => {
    for (const [title, colour] of [['White shirt', 'white'], ['Pink tee', 'pink'], ['Green polo', 'green']] as const) add(api, title, { colours: [colour] });
    add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'] });
    add(api, 'Black boots', { category: 'footwear', colours: ['black'] });
  }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const before = await pageIdeas(page);
  const avoid = async () => {
    await fromMenu(page, 'today.dontPair');
    const chooser = featured(page).getByRole('group', { name: text('today.pickPair'), exact: true });
    await chooser.getByRole('checkbox').nth(1).check();
    await chooser.getByRole('checkbox').nth(2).check();
    await chooser.getByRole('button', { name: text('today.pairConfirm'), exact: true }).click();
    await expect(undoPair(page)).toBeVisible();
  };
  await avoid();
  // All three ideas hold the pair, but only the card it was chosen on goes.
  await expect(cards(page)).toHaveCount(2);
  expect(await pageIdeas(page)).toEqual(before.slice(1));
  expect(api.combinationRules).toHaveLength(1);
  await undoPair(page).click();
  await expect(undoPair(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
  expect(await pageIdeas(page)).toEqual(before);
  await avoid();
  await expect(cards(page)).toHaveCount(2);
  // The stored pair applies from the next page on: no idea is left.
  await button(page, 'today.more').click();
  await expect(page.locator('#today-no-more')).toHaveText(text('today.noMore'));
});

test('A refresh that drops the card holding focus hands focus to the nearest card left, and never takes it from elsewhere', async ({ page }) => {
  const { api } = await start(page, 'en', api => {
    for (const [title, colour] of [['White shirt', 'white'], ['Pink tee', 'pink'], ['Green polo', 'green']] as const) add(api, title, { colours: [colour] });
    add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'] });
    add(api, 'Black boots', { category: 'footwear', colours: ['black'] });
  }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const before = await pageIdeas(page);
  const itemReads = () => api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length;
  const refresh = async () => {
    const reads = itemReads();
    await page.context().setOffline(true);
    await expect(page.locator('.notice-offline')).toBeVisible();
    await page.context().setOffline(false);
    await expect.poll(itemReads).toBeGreaterThan(reads);
    await page.waitForTimeout(300);
  };
  const top = (index: number) => before[index]!.split(' + ')[0]!;
  // The middle card's top goes to the laundry while focus is on that card.
  await idea(page, 1).getByRole('button', { name: text('today.like'), exact: true }).focus();
  Object.assign(api.items.find(row => row.title === top(1))!, { availability: 'laundry', version: 2 });
  await refresh();
  await expect(cards(page)).toHaveCount(2);
  expect(await pageIdeas(page)).toEqual([before[0], before[2]]);
  await expect(idea(page, 1).locator('.today-idea-title')).toBeFocused();

  // With focus elsewhere, a dropped card does not move it.
  const occasion = page.getByRole('combobox', { name: text('outfits.occasion'), exact: true });
  await idea(page, 1).getByRole('button', { name: text('today.like'), exact: true }).focus();
  await occasion.focus();
  Object.assign(api.items.find(row => row.title === top(2))!, { availability: 'laundry', version: 2 });
  await refresh();
  await expect(cards(page)).toHaveCount(1);
  await expect(occasion).toBeFocused();
});

test('Undo of an avoided pair restores its card even when a refresh has replaced the other cards', async ({ page }) => {
  const { api } = await start(page, 'en', api => {
    for (const [title, colour] of [['White shirt', 'white'], ['Pink tee', 'pink'], ['Green polo', 'green'], ['Blue tee', 'blue'], ['Grey top', 'grey']] as const) add(api, title, { colours: [colour] });
    add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'] });
    add(api, 'Black boots', { category: 'footwear', colours: ['black'] });
  }, { clothes: false });
  await expect(cards(page)).toHaveCount(3);
  const before = await pageIdeas(page);
  const top = (index: number) => before[index]!.split(' + ')[0]!;
  await fromMenu(page, 'today.dontPair');
  const chooser = featured(page).getByRole('group', { name: text('today.pickPair'), exact: true });
  await chooser.getByRole('checkbox').nth(1).check();
  await chooser.getByRole('checkbox').nth(2).check();
  await chooser.getByRole('button', { name: text('today.pairConfirm'), exact: true }).click();
  await expect(undoPair(page)).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  // A refresh drops the two cards left; the avoided card's idea is still on the ranked page, and two others take their place.
  const itemReads = () => api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length;
  for (const index of [1, 2]) Object.assign(api.items.find(row => row.title === top(index))!, { availability: 'laundry', version: 2 });
  const reads = itemReads();
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(itemReads).toBeGreaterThan(reads);
  await expect(undoPair(page)).toBeEnabled();
  await expect.poll(async () => (await pageIdeas(page)).every(idea => !before.includes(idea))).toBe(true);
  const replaced = await pageIdeas(page);
  expect(replaced).toHaveLength(2);
  await undoPair(page).click();
  await expect(undoPair(page)).toHaveCount(0);
  // The undone card is back on the page, and focus is on a card that is rendered.
  await expect(cards(page)).toHaveCount(3);
  expect(await pageIdeas(page)).toContain(before[0]);
  await expect(page.locator('.today-idea-title:focus')).toHaveCount(1);
});

test('Save as outfit and Wear today act on the idea of the card they are on', async ({ page }) => {
  const { api } = await start(page);
  const wear = await wearRoutes(page);
  const third = await names(idea(page, 2));
  await idea(page, 2).getByRole('button', { name: text('calendar.wearToday'), exact: true }).click();
  await expect(wearPanel(page)).toContainText(text('calendar.markedWornDone'));
  expect(wear.bodies).toHaveLength(1);
  expect(wear.bodies[0]).toMatchObject({ p_item_ids: idsOf(api, third) });
  const second = await names(idea(page, 1));
  await idea(page, 1).getByRole('button', { name: text('today.save'), exact: true }).click();
  await expect(page.locator('#outfit-editor-title')).toBeFocused();
  await expect(page.locator('.outfit-slot .outfit-component-name')).toHaveText(second);
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
        await expectIdentity(page, 'Alex');
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
        const like = featured(page).getByRole('button', { name: text('today.like', language), exact: true });
        await like.click();
        await expect(like).toHaveAttribute('aria-pressed', 'true');
        expect(api.suggestionFeedback).toHaveLength(1);
        await expect(cards(page)).toHaveCount(3);
        // Photos load as they scroll into view; bring every card's last piece in before the full-page capture.
        for (const card of await cards(page).all()) await card.locator('.today-pieces li').last().scrollIntoViewIfNeeded();
        await expect(page.locator('.today-card img')).toHaveCount(9);
        if (selected.suffix === 'en-desktop') {
          await openMenu(page);
          await expect(menuButton(page, 'today.dontPair', language)).toBeVisible();
        }
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
        await start(page, language);
        if (selected.zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
        const card = cards(page).nth(0);
        // Photos load as they scroll into view.
        await card.locator('.today-pieces li').last().scrollIntoViewIfNeeded();
        await expect(card.locator('img')).toHaveCount(3);
        await fromMenu(page, 'today.dontPair', language);
        const chooser = card.getByRole('group', { name: text('today.pickPair', language), exact: true });
        await chooser.getByRole('checkbox').nth(0).check();
        // One piece ticked: Confirm waits for a second.
        await expect(chooser.getByRole('button', { name: text('today.pairConfirm', language), exact: true })).toBeDisabled();
        await expect(chooser.getByRole('button', { name: text('common.cancel', language), exact: true })).toBeEnabled();
        await chooser.locator('label').last().scrollIntoViewIfNeeded();
        await expect(chooser.locator('img')).toHaveCount(3);
        element = chooser;
      }
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await expectIdentity(page, 'Alex');
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

test.describe('bounded PAIR1 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [{ project: 'chromium', language: 'en', width: 1280, height: 900, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 390, height: 844, suffix: 'fi-mobile' }] as const;
  for (const selected of scenes) {
    test(`next idea with compact Undo ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/i15-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: selected.height });
      const { api } = await start(page, language, api => { seedDresses(api); }, { clothes: false });
      const pieces = await names(featured(page));
      const photos = async (count: number) => {
        for (const card of await cards(page).all()) await card.locator('.today-pieces li').last().scrollIntoViewIfNeeded();
        await expect(page.locator('.today-card img')).toHaveCount(count);
      };
      await photos(6);
      const summaryShown = await watchSummary(page);
      await fromMenu(page, 'today.dontPair', language);
      await expect(undoPair(page, language)).toBeVisible();
      await expect(ideaNames(page)).not.toHaveText(pieces);
      await expect(cards(page)).toHaveCount(2);
      await photos(4);
      await expect(ideaTitle(page)).toBeFocused();
      expect(await summaryShown()).toBe(false);
      expect(api.combinationRules).toHaveLength(1);
      await page.evaluate(() => scrollTo(0, 0));
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await expectIdentity(page, 'Alex');
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(({ expectedLanguage, width, height }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === height
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText);
      }, { expectedLanguage: language, width: selected.width, height: selected.height })).toBe(true);
      if (!write) return;
      const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
      const file = await open(path.join(directory, `pair-next-${selected.suffix}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});