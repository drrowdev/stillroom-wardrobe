import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';
import { dismissKeyboard, expectIdentity, expectSignedIn, openAccountMenu, settleShell, shellNav } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const navLink = (page: Page, key: 'nav.today' | 'nav.wardrobe' | 'nav.outfits', language: Language = 'en') =>
  shellNav(page).getByRole('link', { name: text(key, language), exact: true });
const cards = (page: Page) => page.locator('.today-card');
// Today features one idea at a time.
const featured = (page: Page) => page.locator('.today-card.today-featured');
const ideaTitle = (page: Page) => page.locator('#today-featured-title');
const moreOptions = (page: Page) => page.locator('#today-more-options');
const menuPanel = (page: Page) => page.locator('#today-more-options-panel');
const menuButton = (page: Page, key: MessageKey, language: Language = 'en') => menuPanel(page).getByRole('button', { name: text(key, language), exact: true });
async function openMenu(page: Page) {
  if (await moreOptions(page).getAttribute('aria-expanded') !== 'true') await moreOptions(page).click();
  await expect(menuPanel(page)).toBeVisible();
}
async function fromMenu(page: Page, key: MessageKey, language: Language = 'en') {
  await openMenu(page);
  await menuButton(page, key, language).click();
}
// Read names only once the card's pieces have rendered, so a capture is never an empty list.
async function names(card: Locator) {
  await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
  return card.locator('.outfit-component-name').allTextContents();
}
const joined = (card: Locator) => card.evaluate(node => [...node.querySelectorAll('.outfit-component-name')].map(name => name.textContent ?? '').join(' + '));
async function allNames(page: Page) {
  await expect(featured(page).locator('.outfit-component-name')).not.toHaveCount(0);
  return [await joined(featured(page))];
}
// Show another, then wait until a different idea (or the end of the ideas) is showing.
async function showAnother(page: Page, language: Language = 'en') {
  const before = await ideaTitle(page).textContent();
  await button(page, 'today.more', language).click();
  await expect(ideaTitle(page).filter({ hasNotText: before ?? '' }).or(page.locator('#today-no-more, #today-gone'))).toBeVisible();
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
// Shows every idea with Show another until the ideas run out. Collapsed cards (hidden or avoided) are passed over.
async function pageThrough(page: Page, visit?: (card: Locator) => Promise<void>) {
  const seen: string[] = [];
  for (let round = 0; round < 40; round++) {
    await expect(ideaTitle(page).or(page.locator('#today-no-more'))).toBeVisible();
    if (await page.locator('#today-no-more').isVisible()) break;
    const card = featured(page);
    if (!await card.evaluate(node => node.classList.contains('today-card-hidden'))) {
      await expect(card.locator('.outfit-component-name')).not.toHaveCount(0);
      seen.push(await joined(card));
      await visit?.(card);
    }
    await showAnother(page);
  }
  return seen;
}
// Leaving Today and coming back starts again from the first idea.
async function startAgain(page: Page) {
  await navLink(page, 'nav.wardrobe').click();
  await navLink(page, 'nav.today').click();
  await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: 1 }));
}

test('I15 features one idea with reasons, shows every idea in turn and starts over', async ({ page }) => {
  const paths = traffic(page);
  await start(page);
  await expect(page.locator('#today-title')).toBeFocused();
  await expect(navLink(page, 'nav.today')).toHaveAttribute('aria-current', 'page');
  await expect(cards(page)).toHaveCount(1);
  await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: 1 }));
  const card = featured(page);
  await expect(card.locator('.today-pieces li')).toHaveCount(3);
  await expect(card.locator('.today-pieces img')).toHaveCount(3);
  await expect(card.locator('.today-reasons li').first()).toBeVisible();
  await expect(card.locator('.button-primary')).toHaveText(text('calendar.wearToday'));
  const first = await allNames(page);
  await showAnother(page);
  await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: 2 }));
  await expect(ideaTitle(page)).toBeFocused();
  await startAgain(page);
  const seen = await pageThrough(page);
  expect(seen).toHaveLength(3 * 2 * 2);
  expect(new Set(seen).size).toBe(12);
  await expect(page.locator('#today-no-more')).toBeFocused();
  await expect(button(page, 'today.more')).toHaveCount(0);
  await button(page, 'today.startOver').click();
  await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: 1 }));
  await expect(ideaTitle(page)).toBeFocused();
  expect(await allNames(page)).toEqual(first);
  expect(paths.filter(entry => /wear_event|\/functions\/|analy/i.test(entry))).toEqual([]);
});

test('I15 Show another walks three ideas a page, then the next page, never one twice', async ({ page }) => {
  const { api } = await start(page);
  const shown: string[] = [];
  for (let index = 0; index < 6; index++) {
    await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: index + 1 }));
    shown.push((await allNames(page))[0]!);
    await showAnother(page);
  }
  expect(new Set(shown).size).toBe(6);
  await startAgain(page);
  expect((await pageThrough(page)).slice(0, 6)).toEqual(shown);
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

  await showAnother(page);
  const hiddenNames = await names(featured(page));
  const bodies: Row[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/rest/v1/suggestion_feedback' && request.method() === 'POST') bodies.push(request.postDataJSON() as Row);
  });
  await fromMenu(page, 'today.notForMe');
  await expect(featured(page)).toContainText(text('today.hidden'));
  await expect(featured(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeFocused();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ vote: -1, item_ids: [...idsOf(api, hiddenNames)].sort() });
  expect(api.suggestionFeedback.map(row => row.vote).sort()).toEqual([-1, 1]);
  await featured(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(featured(page).locator('.outfit-component-name')).toHaveText(hiddenNames);
  await expect(moreOptions(page)).toBeFocused();
  expect(api.suggestionFeedback.map(row => row.vote)).toEqual([1]);
  await fromMenu(page, 'today.notForMe');
  await expect(featured(page)).toContainText(text('today.hidden'));
  // A hidden idea keeps Show another.
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
  await showAnother(page);
  const hidden = featured(page);
  api.feedbackControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await fromMenu(page, 'today.notForMe');
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
  await showAnother(page);
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
  await showAnother(page);
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
  await expect(cards(page)).toHaveCount(1);
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
  await showAnother(page);
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
  await showAnother(page);
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

test('I15 a refresh keeps the idea showing when earlier ideas drop out, and moves on only when it goes', async ({ page }) => {
  const { api } = await start(page);
  const first = await names(featured(page));
  await showAnother(page);
  const second = await names(featured(page));
  await showAnother(page);
  const third = await names(featured(page));
  const title = await ideaTitle(page).textContent();
  const itemReads = () => api.requests.filter(entry => entry.path === '/rest/v1/items' && entry.method === 'GET').length;
  const refresh = async () => {
    const before = itemReads();
    await page.context().setOffline(true);
    await expect(page.locator('.notice-offline')).toBeVisible();
    await page.context().setOffline(false);
    await expect.poll(itemReads).toBeGreaterThan(before);
    await page.waitForTimeout(300);
  };
  const shown = [first, second, third].map(idea => idea.join(' + '));
  // Whatever a refresh does, the idea number stays and Today shows the same idea, one not shown yet, or a short status.
  const settled = async () => {
    await expect(ideaTitle(page).or(page.locator('#today-gone'))).toBeVisible();
    if (!await ideaTitle(page).isVisible()) {
      await expect(page.locator('#today-gone')).toHaveText(text('today.ideaGone'));
      await expect(button(page, 'today.more')).toBeEnabled();
      return null;
    }
    await expect(ideaTitle(page)).toHaveText(title!);
    return joined(featured(page));
  };
  // A refresh that changes the clothes but not the ideas keeps the idea showing.
  const renamed = first.find(name => !second.includes(name) && !third.includes(name))!;
  Object.assign(api.items.find(row => row.title === renamed)!, { title: `${renamed} 2`, version: 2 });
  await refresh();
  await expect(ideaTitle(page)).toHaveText(title!);
  await expect(featured(page).locator('.outfit-component-name')).toHaveText(third);

  // A piece only the first idea has goes to the laundry. The page is ranked again: the idea showing stays if it is still
  // on the page, and is otherwise replaced by one not shown yet. Ideas already shown never come back.
  Object.assign(api.items.find(row => row.title === `${renamed} 2`)!, { availability: 'laundry' });
  await refresh();
  const afterFirst = await settled();
  if (afterFirst !== null && afterFirst !== shown[2]) expect(shown).not.toContain(afterFirst);

  // A piece of the idea showing goes: it is replaced in the same way.
  const current = afterFirst?.split(' + ') ?? third;
  const leaving = current.find(name => !first.includes(name) && !second.includes(name)) ?? current[0]!;
  Object.assign(api.items.find(row => row.title === leaving)!, { availability: 'laundry' });
  await refresh();
  const afterCurrent = await settled();
  if (afterCurrent !== null) {
    expect(afterCurrent).not.toContain(leaving);
    expect(shown).not.toContain(afterCurrent);
  }
  await showAnother(page);
  const later = await pageThrough(page);
  for (const idea of later) expect(idea.includes(renamed) || idea.includes(leaving) || shown.includes(idea)).toBe(false);
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
  await expect(cards(page)).toHaveCount(1);
  const before = await allNames(page);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  for (const key of ['calendar.wearToday', 'today.save', 'today.like'] as const) await expect(featured(page).getByRole('button', { name: text(key), exact: true })).toBeDisabled();
  await expect(moreOptions(page)).toBeDisabled();
  const writes = paths.length;
  await page.context().setOffline(false);
  await openAccountMenu(page, 'en');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#today-title')).toHaveText(text('today.title', 'fi'));
  await expect(cards(page)).toHaveCount(1);
  expect(await allNames(page)).toEqual(before);
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
  await expect(ideaTitle(page)).toHaveText(text('today.idea', 'en', { number: 1 }));
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
    await expect(button(page, 'today.more')).toBeFocused();
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
    if (change === 'weather') await page.getByRole('button', { name: text('setting.indoors'), exact: true }).click();
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

test('Don\'t pair these avoids a two-piece idea at once, and Undo brings it back', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  expect(pieces).toHaveLength(2);
  await fromMenu(page, 'today.dontPair');
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.locator('.outfit-component-name')).toHaveText(pieces);
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeFocused();
  await expect(card.getByRole('button', { name: text('today.save'), exact: true })).toHaveCount(0);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, pieces[0]!, pieces[1]!) }]);
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(moreOptions(page)).toBeFocused();
  expect(await names(card)).toEqual(pieces);
  expect(api.combinationRules).toHaveLength(0);
});

test('Don\'t pair these asks which two, hides other ideas with them now and keeps them apart afterwards', async ({ page }) => {
  const { api } = await start(page);
  await expect(cards(page)).toHaveCount(1);
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
  await confirm.click();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.locator('.outfit-component-name')).toHaveText([first, second]);
  expect(rulesOf(api)).toEqual([{ owner_id: owners.a, ...pairOf(api, first, second) }]);
  // The rest of this page and every later idea keep the two apart at once.
  await showAnother(page);
  for (const idea of await pageThrough(page)) expect(together(idea, first, second)).toBe(false);
  await startAgain(page);
  const all = await pageThrough(page);
  expect(all.length).toBeGreaterThan(0);
  for (const idea of all) expect(together(idea, first, second)).toBe(false);
});

test('Don\'t pair these checks a lost reply against what was stored and settles an unknown Undo with Try again', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  const card = cards(page).nth(0);
  const pieces = await names(card);
  api.pairControl.faults.push({ method: 'POST', commit: true, fail: 503 });
  await fromMenu(page, 'today.dontPair');
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(1);

  api.pairControl.faults.push({ method: 'DELETE', commit: false, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
  await expect(button(page, 'today.more')).toBeDisabled();
  expect(api.combinationRules).toHaveLength(1);
  await card.getByRole('button', { name: text('common.retry'), exact: true }).click();
  expect(await names(card)).toEqual(pieces);
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);
  expect(api.combinationRules).toHaveLength(0);

  api.pairControl.faults.push({ method: 'POST', commit: false, fail: 503 });
  await fromMenu(page, 'today.dontPair');
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toBeVisible();
  await expect(moreOptions(page)).toBeEnabled();
  expect(api.combinationRules).toHaveLength(0);
});

test('Don\'t pair these settles a stored choice whose reply and check were lost when Today refreshes after a reconnect', async ({ page }) => {
  const { api } = await start(page, 'en', api => { seedDresses(api); }, { clothes: false });
  await expect(cards(page)).toHaveCount(1);
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
  await fromMenu(page, 'today.dontPair');
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  await expect(button(page, 'today.more')).toBeDisabled();
  expect(api.combinationRules).toHaveLength(1);
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeFocused();
  await reconnect();
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeFocused();
  await expect(card.locator('.outfit-component-name')).toHaveText(pieces);
  await expect(card.getByRole('button', { name: text('today.save'), exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  await expect(page.getByText(text('today.voteFailed'), { exact: true })).toHaveCount(0);

  // The same for an Undo that removed the pair.
  api.pairControl.faults.push({ method: 'DELETE', commit: true, fail: 'abort' }, { method: 'READ', commit: false, fail: 500 });
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(card.getByRole('button', { name: text('common.retry'), exact: true })).toBeVisible();
  expect(api.combinationRules).toHaveLength(0);
  await reconnect();
  await expect(moreOptions(page)).toBeEnabled();
  // Settled with the pair allowed again: focus rests on More options.
  await expect(moreOptions(page)).toBeFocused();
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
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).nth(0);
  const pieces = await names(card);
  const feedbackReads = () => api.requests.filter(entry => entry.path === '/rest/v1/suggestion_feedback' && entry.method === 'GET').length;
  const settlingCard = async () => {
    await expect(cards(page)).toHaveCount(1);
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
  await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
  await expect(card.getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  await expect(button(page, 'today.more')).toBeEnabled();
  await card.getByRole('button', { name: text('common.undo'), exact: true }).click();
  await expect(moreOptions(page)).toBeEnabled();
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
  await expect(cards(page)).toHaveCount(1);
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
  await expect(cards(page)).toHaveCount(1);
  await page.context().setOffline(true);
  await expect(page.locator('.notice-offline')).toBeVisible();
  await expect(moreOptions(page)).toBeDisabled();
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
    await expect(card.getByRole('status')).toHaveText(text('today.pairHidden'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe();
    await card.getByRole('button', { name: text('common.undo'), exact: true }).press('Enter');
    await expect(moreOptions(page)).toBeFocused();
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
        await expect(cards(page)).toHaveCount(1);
        // Photos load as they scroll into view; bring the last piece in before the full-page capture.
        await featured(page).locator('.today-pieces li').last().scrollIntoViewIfNeeded();
        await expect(page.locator('.today-card img')).toHaveCount(3);
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
        await fromMenu(page, 'today.dontPair', language);
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