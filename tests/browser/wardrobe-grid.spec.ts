import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, itemCount, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';
import { ordinal } from '../../src/features/wardrobe/search';

type Backend = Awaited<ReturnType<typeof mockBackend>>;
const button = (page: Page, key: keyof typeof messages, language: Language = 'en') =>
  page.getByRole('button', { name: messages[key][language], exact: true });
function wear(api: Backend, itemId: string | null, day: string, state = 'worn', account: 'a' | 'b' = 'a', deleted = false) {
  const event = randomUUID();
  api.wearEvents.push({ id: event, owner_id: owners[account], local_date: day, state, deleted_at: deleted ? '2026-09-03T00:00:00Z' : null });
  api.wearLinks.push({ id: randomUUID(), owner_id: owners[account], item_id: itemId, event_id: event });
}
async function open(page: Page, api: Backend, account: 'a' | 'b' = 'a') {
  await page.goto('/'); await signIn(page, account);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.locator('.item-card').first()).toBeVisible();
  expect(api.requests.some(request => request.path === '/rest/v1/items')).toBe(true);
}
const historyRequests = (api: Backend) => api.requests.filter(request => request.path === '/rest/v1/wear_event_items');
test.beforeEach(({ page }, info) => { void page; expect(info.retry, 'New wardrobe-grid flakiness blocks acceptance').toBe(0); });

for (const account of ['a', 'b'] as const) {
  test(`500 owned plus 500 foreign fixtures: ${account} keysets, windows and isolated search`, async ({ page }) => {
    const api = await mockBackend(page, { initialLanguage: 'en' });
    api.profiles[owners.b]!.ui_language = 'en';
    const other = account === 'a' ? 'b' : 'a';
    for (let n = 0; n < 500; n++) {
      api.seedSavedItem(account, `Owned ${String(n).padStart(3, '0')}`);
      api.seedSavedItem(other, `Foreign ${String(n).padStart(3, '0')}`);
    }
    const pending = api.seedSavedItem(account, 'Pending excluded'); pending.image.state = 'pending';
    const trashed = api.seedSavedItem(account, 'Trash excluded'); trashed.item.deleted_at = '2026-09-01T00:00:00Z';
    const queries: URL[] = [];
    page.on('request', request => { if (request.url().includes('/rest/v1/items?')) queries.push(new URL(request.url())); });
    await open(page, api, account);
    await expect(page.locator('.wardrobe-result-count')).toHaveText(itemCount('en', 500));
    await expect(page.locator('.item-card')).toHaveCount(40);
    expect(queries.some(url => url.searchParams.has('or'))).toBe(true);
    expect(queries.every(url => url.searchParams.get('owner_id') === `eq.${owners[account]}`)).toBe(true);
    await button(page, 'wardrobe.more').click(); await expect(page.locator('.item-card')).toHaveCount(80);
    await page.locator('#wardrobe-search').fill('Foreign');
    await expect(page.locator('.item-card')).toHaveCount(0);
    await expect(page.getByText(messages['wardrobe.noMatches'].en, { exact: true })).toBeVisible();
    await expect(page.locator('#wardrobe-search')).toBeVisible();
    await button(page, 'wardrobe.clearSearchFilters').click();
    await expect(page.locator('.item-card')).toHaveCount(40);
    await page.locator('#wardrobe-sort').selectOption('name');
    await expect(page.locator('.item-caption h2').first()).toHaveText('Owned 000');
    await page.locator('#wardrobe-search').fill('Owned 49');
    await expect(page.locator('.item-card')).toHaveCount(15);
    const matchingTitles = [49, 149, 249, 349, 449, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499]
      .map(n => `Owned ${String(n).padStart(3, '0')}`);
    await expect(page.locator('.item-caption h2')).toHaveText(matchingTitles);
    expect(historyRequests(api)).toHaveLength(0);
    await page.locator('.item-detail-link').first().click();
    await expect(page.locator('#item-detail-title')).toBeVisible();
    await button(page, 'common.back').click();
    await expect(page.locator('#wardrobe-search')).toHaveValue('Owned 49');
    await expect(page.locator('#wardrobe-sort')).toHaveValue('name');
    await expect(page.locator('.item-card')).toHaveCount(15);
    await expect(page.locator('.item-caption h2')).toHaveText(matchingTitles);
    await page.locator('#wardrobe-search').fill('Owned');
    await expect(page.locator('.wardrobe-result-count')).toHaveText(itemCount('en', 500));
    await expect(page.locator('.item-card')).toHaveCount(40);
    await button(page, 'wardrobe.more').click();
    await expect(page.locator('.item-card')).toHaveCount(80);
    await expect(page.locator('.item-caption h2').last()).toHaveText('Owned 079');
    await page.locator('.item-detail-link').last().click();
    await expect(page.locator('#item-detail-title')).toBeVisible();
    await button(page, 'common.back').click();
    await expect(page.locator('#wardrobe-search')).toHaveValue('Owned');
    await expect(page.locator('#wardrobe-sort')).toHaveValue('name');
    await expect(page.locator('.wardrobe-result-count')).toHaveText(itemCount('en', 500));
    await expect(page.locator('.item-card')).toHaveCount(80);
    await expect(page.locator('.item-caption h2').last()).toHaveText('Owned 079');
  });
}

for (const language of ['en', 'fi', 'sv'] as const) {
  test(`compound facets, all sorts, history and no-match keyboard/a11y in ${language}`, async ({ page }) => {
    const api = await mockBackend(page, { initialLanguage: language });
    const first = api.seedSavedItem('a', 'Ää linen');
    Object.assign(first.item, { brand: 'Nordic', tags: ['soft'], colours: ['olive'], seasons: ['winter'], formality: 0,
      favourite: true, availability: 'laundry', lifecycle: 'archived', purchase_price: 0 });
    const second = api.seedSavedItem('a', 'Beta'), third = api.seedSavedItem('a', 'Gamma'), zero = api.seedSavedItem('a', 'Delta');
    Object.assign(second.item, { purchase_price: 2.02, currency: 'EUR' });
    Object.assign(third.item, { purchase_price: 1, currency: 'USD' });
    Object.assign(zero.item, { purchase_price: null, currency: 'USD' });
    const peer = api.seedSavedItem('b', 'Foreign');
    wear(api, first.item.id, '2026-09-01'); wear(api, first.item.id, '2026-09-01');
    wear(api, second.item.id, '2026-09-01'); wear(api, second.item.id, '2026-09-02');
    wear(api, zero.item.id, '2026-09-02', 'planned'); wear(api, zero.item.id, '2026-09-02', 'worn', 'a', true);
    wear(api, null, '2026-09-02'); wear(api, peer.item.id, '2026-09-02', 'worn', 'b');
    await open(page, api);
    await page.locator('#wardrobe-search').fill('äÄ nordic soft');
    await expect(page.locator('.item-card')).toHaveCount(1);
    await page.locator('.wardrobe-filters summary').focus(); await page.keyboard.press('Enter');
    for (const [name, value] of [['category', 'top'], ['colour', 'olive'], ['season', 'winter'], ['formality', '0'], ['availability', 'laundry'], ['lifecycle', 'archived'], ['favourite', 'yes']]) {
      await page.locator(`input[name="${name}"][value="${value}"]`).check();
    }
    await expect(page.locator('.item-card')).toHaveCount(1);
    await page.locator('input[name="favourite"][value="no"]').check();
    await expect(page.locator('.item-card')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await button(page, 'wardrobe.clearSearchFilters', language).click();
    await expect(page.locator('.item-card')).toHaveCount(4);
    expect(historyRequests(api)).toHaveLength(0);
    await page.locator('#wardrobe-sort').selectOption('leastWorn');
    const never = [third.item, zero.item].sort((a, b) => ordinal(a.id, b.id));
    await expect(page.locator('.item-caption h2')).toHaveText([...never.map(item => item.title), first.item.title, second.item.title]);
    expect(historyRequests(api)).toHaveLength(1);
    await page.locator('#wardrobe-sort').selectOption('lastWorn');
    await expect(page.locator('.item-caption h2')).toHaveText([second.item.title, first.item.title, ...never.map(item => item.title)]);
    expect(historyRequests(api)).toHaveLength(1);
    await page.locator('#wardrobe-sort').selectOption('price');
    await expect(page.locator('.item-caption h2')).toHaveText([first.item.title, second.item.title, third.item.title, zero.item.title]);
    await expect(page.locator('.wardrobe-price-heading')).toHaveText(['EUR', 'USD', messages['wardrobe.noPrice'][language]]);
    for (const [name, titles] of [
      ['EUR', [first.item.title, second.item.title]],
      ['USD', [third.item.title]],
      [messages['wardrobe.noPrice'][language], [zero.item.title]],
    ] as const) {
      const group = page.getByRole('group', { name, exact: true });
      await expect(group).toHaveCount(1);
      await expect(group.locator('p.wardrobe-price-heading')).toHaveText(name);
      await expect(group.getByRole('heading', { level: 2 })).toHaveText([...titles]);
    }
    await page.locator('#wardrobe-sort').selectOption('name');
    await expect(page.locator('.item-caption h2').first()).toHaveText(language === 'en' ? first.item.title : second.item.title);
    await page.locator('#wardrobe-sort').selectOption('newest');
    await expect(page.locator('.item-card')).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test('history pending/failure, switch-away and staged refresh retain a valid view without false zero', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const a = api.seedSavedItem('a', 'Alpha'), b = api.seedSavedItem('a', 'Beta');
  wear(api, a.item.id, '2026-09-01');
  await open(page, api);
  await page.locator('#wardrobe-sort').selectOption('name');
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const unavailable = { status: 503, headers: { 'Retry-After': '0', 'Access-Control-Expose-Headers': 'Retry-After' }, json: {} };
  await page.route('**/rest/v1/wear_event_items?*', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    entered = true; await held; await route.fulfill(unavailable);
  });
  await page.locator('#wardrobe-sort').selectOption('leastWorn');
  await expect.poll(() => entered).toBe(true);
  await expect(page.getByText(messages['wardrobe.historyLoading'].en)).toBeVisible();
  await expect(page.locator('.item-caption h2')).toHaveText(['Alpha', 'Beta']);
  await page.locator('#wardrobe-sort').selectOption('price');
  release!();
  await expect(page.locator('#wardrobe-sort')).toHaveValue('price');
  await page.unroute('**/rest/v1/wear_event_items?*');
  let selectionAttempts = 0;
  await page.route('**/rest/v1/wear_event_items?*', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    selectionAttempts++; return route.fulfill(unavailable);
  });
  await page.locator('#wardrobe-sort').selectOption('leastWorn');
  await expect(page.getByText(messages['wardrobe.historyUnavailable'].en)).toBeVisible();
  expect(selectionAttempts).toBe(4);
  await expect(page.locator('#wardrobe-sort')).toHaveValue('price');
  await expect(page.locator('.item-card')).toHaveCount(2);
  await page.unroute('**/rest/v1/wear_event_items?*');
  await page.getByRole('alert').getByRole('button').click();
  await expect(page.locator('#wardrobe-sort')).toHaveValue('leastWorn');
  await expect(page.locator('.item-caption h2')).toHaveText(['Beta', 'Alpha']);
  b.item.deleted_at = '2026-09-02T00:00:00Z';
  api.seedSavedItem('a', 'New saved item');
  let refreshAttempts = 0;
  await page.route('**/rest/v1/wear_event_items?*', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    refreshAttempts++; return route.fulfill(unavailable);
  });
  await button(page, 'wardrobe.refresh').click();
  await expect(page.getByText(messages['wardrobe.historyUnavailable'].en)).toBeVisible();
  expect(refreshAttempts).toBe(4);
  await expect(page.locator('.item-caption h2')).toHaveText(['Alpha']);
  await page.unroute('**/rest/v1/wear_event_items?*');
  await page.getByRole('alert').getByRole('button').click();
  await expect(page.locator('.item-caption h2')).toHaveText(['New saved item', 'Alpha']);
});

test('malformed refresh, offline search, language reset and logout never substitute an empty or foreign view', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  for (let n = 0; n < 81; n++) api.seedSavedItem('a', `Own ${n}`);
  api.seedSavedItem('b', 'Peer only');
  await open(page, api);
  await button(page, 'wardrobe.more').click(); await expect(page.locator('.item-card')).toHaveCount(80);
  await button(page, 'account.menu').click(); await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await button(page, 'account.menu', 'fi').click();
  await expect(page.locator('.item-card')).toHaveCount(40);
  await button(page, 'account.menu', 'fi').click(); await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en'); await button(page, 'account.menu').click();
  await expect(page.locator('.item-card')).toHaveCount(40);
  await button(page, 'account.menu').click(); await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi'); await button(page, 'account.menu', 'fi').click();
  await page.route('**/rest/v1/items?*', route => route.fulfill({ json: [{ malformed: true }] }));
  await button(page, 'wardrobe.refresh', 'fi').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.item-card')).toHaveCount(40);
  await page.unroute('**/rest/v1/items?*');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(button(page, 'wardrobe.refresh', 'fi')).toBeDisabled();
  await page.locator('#wardrobe-search').fill('Own 80');
  await expect(page.locator('.item-card')).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await button(page, 'account.menu', 'fi').click(); await button(page, 'auth.signOut', 'fi').click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('.item-caption h2')).toHaveText(['Peer only']);
  await expect(page.locator('#wardrobe-search')).toHaveValue('');
  await expect(page.locator('#wardrobe-sort')).toHaveValue('newest');
});

test('late metadata and old-owner history cannot replace the current snapshot', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const saved = api.seedSavedItem('a', 'Original');
  api.seedSavedItem('b', 'Peer only');
  await open(page, api);
  let releaseMetadata: (() => void) | undefined, releaseHistory: (() => void) | undefined;
  const metadata = new Promise<void>(resolve => { releaseMetadata = resolve; });
  const history = new Promise<void>(resolve => { releaseHistory = resolve; });
  let enteredMetadata = false, enteredHistory = false;
  const stale = structuredClone(api.items.filter(item => item.owner_id === owners.a));
  await page.route('**/rest/v1/items?*', async route => {
    if (enteredMetadata) { await route.fallback(); return; }
    enteredMetadata = true; await metadata; await route.fulfill({ json: stale });
  });
  try {
    await button(page, 'wardrobe.refresh').click();
    await expect.poll(() => enteredMetadata).toBe(true);
    saved.item.title = 'Current';
    await button(page, 'wardrobe.refresh').click();
    await expect(page.locator('.item-caption h2')).toHaveText(['Current']);
    releaseMetadata!();
    await expect(page.locator('.item-caption h2')).toHaveText(['Current']);
    await page.unroute('**/rest/v1/items?*');
    await page.route('**/rest/v1/wear_event_items?*', async route => {
      enteredHistory = true; await history; await route.fulfill({ json: [] });
    });
    await page.locator('#wardrobe-sort').selectOption('leastWorn');
    await expect.poll(() => enteredHistory).toBe(true);
    await button(page, 'account.menu').click(); await button(page, 'auth.signOut').click();
    await expect(page.locator('#email')).toBeVisible(); await signIn(page, 'b');
    await expect(page.locator('.item-caption h2')).toHaveText(['Peer only']);
    releaseHistory!();
    await expect(page.locator('#wardrobe-sort')).toHaveValue('newest');
    await expect(page.locator('.item-caption h2')).toHaveText(['Peer only']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    releaseMetadata!(); releaseHistory!();
    await page.unroute('**/rest/v1/items?*');
    await page.unroute('**/rest/v1/wear_event_items?*');
  }
});

test('viewport admission bounds mounted photos and frozen global concurrency, including failed photos', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  const api = await mockBackend(page, { initialLanguage: 'en' });
  for (let n = 0; n < 100; n++) api.seedSavedItem('a', `Own ${n}`);
  let active = 0, peak = 0, started = 0;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/storage/v1/object/wardrobe/**/thumb.jpg', async route => {
    started++; active++; peak = Math.max(peak, active);
    await held; active--; await route.fallback();
  });
  await open(page, api);
  await expect(page.locator('.item-card')).toHaveCount(40);
  await expect.poll(() => started).toBeGreaterThan(0);
  expect(started).toBeLessThanOrEqual(4);
  release!();
  await expect(page.locator('.item-photo img').first()).toBeVisible();
  expect(peak).toBeLessThanOrEqual(4);
  expect(started).toBeLessThan(40);
  await page.locator('.item-card').nth(39).scrollIntoViewIfNeeded();
  await expect(page.locator('.item-card').nth(39).locator('img')).toBeVisible();
  expect(started).toBeLessThanOrEqual(40);
  const previous = started;
  await page.locator('.item-card').first().scrollIntoViewIfNeeded();
  expect(started).toBe(previous);
  await page.unroute('**/storage/v1/object/wardrobe/**/thumb.jpg');
  await page.route('**/storage/v1/object/wardrobe/**/thumb.jpg', route => route.fulfill({ status: 404, json: {} }));
  api.seedSavedItem('a', 'Uncached photo');
  await button(page, 'wardrobe.refresh').click();
  await expect(page.locator('.wardrobe-result-count')).toHaveText(itemCount('en', 101));
  await page.locator('#wardrobe-search').fill('Uncached photo');
  await expect(page.locator('.item-card')).toHaveCount(1);
  await expect(page.locator('.item-caption h2')).toHaveText('Uncached photo');
  await expect(page.locator('.photo-unavailable')).toHaveText(messages['photo.missing'].en);
});

test('logout revokes admitted URLs and rejects a late previous-owner photo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const ready = api.seedSavedItem('a', 'Ready photo'), late = api.seedSavedItem('a', 'Late photo');
  api.seedSavedItem('b', 'Peer photo');
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { document.documentElement.setAttribute('data-i09-revoked', url); revoke(url); };
  });
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  await page.route(`**/storage/v1/object/wardrobe/${late.image.thumb_path}`, async route => {
    entered = true; await held;
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: api.files.get(late.image.thumb_path)! });
  });
  try {
    await open(page, api);
    const image = page.locator(`a[href="#/items/${ready.item.id}"] img`);
    await expect(image).toBeVisible();
    const oldUrl = await image.getAttribute('src'); expect(oldUrl).toMatch(/^blob:/);
    await expect.poll(() => entered).toBe(true);
    await button(page, 'account.menu').click(); await button(page, 'auth.signOut').click();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-i09-revoked', oldUrl!);
    await signIn(page, 'b');
    await expect(page.locator('.item-caption h2')).toHaveText(['Peer photo']);
    release!();
    await expect(page.locator('.item-photo img')).toHaveCount(1);
    await expect(page.locator('.item-caption h2')).toHaveText(['Peer photo']);
    await expect(page.locator('.item-photo img')).not.toHaveAttribute('src', oldUrl!);
  } finally {
    release!();
    await page.unroute(`**/storage/v1/object/wardrobe/${late.image.thumb_path}`);
  }
});

test('layout boundaries, translated filters, 200% text and exactly two bounded synthetic capture definitions', async ({ page }, info) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  for (let n = 0; n < 12; n++) {
    const saved = api.seedSavedItem('a', `Fictional garment ${n + 1}`);
    Object.assign(saved.item, { colours: ['olive'], purchase_price: n === 11 ? null : n, currency: n < 6 ? 'EUR' : 'USD' });
  }
  await open(page, api); await page.locator('#wardrobe-sort').selectOption('price');
  for (const width of [320, 599, 600, 650, 899, 900, 1250]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator('.item-grid').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width < 600 ? 2 : width < 900 ? 3 : width < 1250 ? 4 : 5);
    expect(await page.locator('.item-card').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().width >= 140))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const directory = path.resolve('test-results/i09-visual');
  for (const capture of [
    { language: 'en', width: 1280, height: 900, project: 'chromium', file: 'wardrobe-grid-en-desktop.png' },
    { language: 'fi', width: 320, height: 1200, project: 'mobile', file: 'wardrobe-filters-fi-mobile.png' },
  ] as const) {
    if (capture.language === 'fi') {
      await button(page, 'account.menu').click(); await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi'); await button(page, 'account.menu', 'fi').click();
      await page.locator('.wardrobe-filters summary').click();
    }
    await page.setViewportSize({ width: capture.width, height: capture.height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('.item-card')).toHaveCount(12);
    await expect.poll(() => page.locator('.item-photo').evaluateAll(photos => photos.every(photo => {
      const bounds = photo.getBoundingClientRect();
      if (bounds.top > innerHeight + 200 || bounds.bottom < -200) return true;
      const image = photo.querySelector('img');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    }))).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ language, origin }) => location.origin === origin && location.hash !== '#/items/new'
      && document.documentElement.lang === language && !document.querySelector('input[type=password],#email')
      && document.documentElement.scrollWidth <= innerWidth, { language: capture.language, origin: new URL(info.project.use.baseURL!).origin })).toBe(true);
    if (info.project.name === capture.project) {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, capture.file), fullPage: false, scale: 'css' });
      const stat = await lstat(path.join(directory, capture.file));
      expect(stat.isFile() && stat.size > 24 && stat.size <= 1024 * 1024).toBe(true);
    }
  }
  expect(await page.locator('.item-caption > span, .wardrobe-price, .wardrobe-choice, .wardrobe-tools > label, .collection-bar').evaluateAll(labels =>
    labels.length > 0 && labels.every(label => Number.parseFloat(getComputedStyle(label).fontSize) >= 14))).toBe(true);
  const measureText = () => page.evaluate(() => ({
    root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    body: Number.parseFloat(getComputedStyle(document.body).fontSize),
    labels: [...document.querySelectorAll('.item-caption > span, .wardrobe-price, .wardrobe-choice, .wardrobe-tools > label, .collection-bar')]
      .map(label => Number.parseFloat(getComputedStyle(label).fontSize)),
  }));
  const before = await measureText();
  expect(before.labels.length).toBeGreaterThan(0);
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 1rem; }' });
  const after = await measureText();
  expect(after.root).toBe(before.root * 2);
  expect(after.body).toBe(before.body * 2);
  expect(after.labels).toHaveLength(before.labels.length);
  expect(after.labels).toEqual(before.labels.map(size => size * 2));
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.client).toBe(320);
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(await page.locator('.wardrobe-choice').evaluateAll(labels => labels.every(label => label.getBoundingClientRect().height >= 44))).toBe(true);
  expect(await page.locator('.item-caption > span').evaluateAll(labels => labels.every(label => Number.parseFloat(getComputedStyle(label).fontSize) >= 14))).toBe(true);
});
