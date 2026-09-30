import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';
import { accountTrigger, closeAccountMenu, expectSignedIn, isNarrow, openAccountMenu, shellNav } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const now = new Date('2026-09-16T09:00:00Z');
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const money = (amount: number, currency: string, language: Language = 'en') => new Intl.NumberFormat(locales[language], { style: 'currency', currency }).format(amount);
const shortDate = (iso: string, language: Language = 'en') => new Intl.DateTimeFormat(locales[language], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${iso}T12:00:00Z`));
const card = (page: Page, id: string) => page.locator(`section[aria-labelledby="${id}"]`);
const navLink = (page: Page, language: Language, key: MessageKey) =>
  shellNav(page).getByRole('link', { name: text(key, language), exact: true });

function seedLook(api: Api, date: string, items: Row[], state: 'planned' | 'worn' = 'worn', account: 'a' | 'b' = 'a', deleted = false) {
  const id = randomUUID(), owner = owners[account], at = '2026-09-10T08:00:00Z';
  api.wearEvents.push({ id, owner_id: owner, outfit_id: null, local_date: date, timezone: 'Europe/Helsinki', state, label: 'Look', deleted_at: deleted ? at : null, version: 1, created_at: at, updated_at: at });
  for (const item of items) api.wearLinks.push({ id: randomUUID(), owner_id: owner, event_id: id, item_id: item.id, title_snapshot: item.title, category_snapshot: item.category });
}
function wardrobe(api: Api) {
  const item = (title: string, extra: Row = {}) => Object.assign(api.seedSavedItem('a', title).item as Row, extra);
  const coat = item('Wool coat', { category: 'outerwear', purchase_price: 240, currency: 'EUR', purchase_date: '2026-09-02' });
  const shirt = item('Linen shirt', { purchase_price: 45.5, currency: 'EUR', purchase_date: '2026-08-20' });
  const jeans = item('Blue jeans', { category: 'bottom', purchase_price: 80, currency: 'USD', purchase_date: '2026-07-01' });
  const scarf = item('Grey scarf', { category: 'accessory' });
  const boots = item('Leather boots', { category: 'footwear', purchase_price: 150, currency: 'EUR' });
  const peer = Object.assign(api.seedSavedItem('b', 'Robin private').item as Row, { purchase_price: 999, currency: 'EUR' });
  // Coat: two looks on 3 Sep count once, plus 11 and 15 Sep. A plan and a removed look never count.
  seedLook(api, '2026-09-03', [coat, shirt]);
  seedLook(api, '2026-09-03', [coat]);
  seedLook(api, '2026-09-11', [coat, jeans]);
  seedLook(api, '2026-09-15', [coat, scarf]);
  seedLook(api, '2026-09-20', [boots], 'planned');
  seedLook(api, '2026-09-12', [boots], 'worn', 'a', true);
  seedLook(api, '2026-09-14', [peer], 'worn', 'b');
  return { coat, shirt, jeans, scarf, boots, peer };
}
async function start<T>(page: Page, language: Language = 'en', seed: (api: Api) => T = wardrobe as (api: Api) => T, hash = '#/statistics', after?: () => Promise<unknown>) {
  await page.clock.setFixedTime(now);
  const api = await mockBackend(page, { initialLanguage: language });
  const seeded = seed(api);
  // Routes added after the mock backend take precedence over it.
  if (after) await after();
  await page.goto(`/${hash}`); await signIn(page, 'a');
  await expectSignedIn(page);
  return { api, seeded };
}
async function navFits(page: Page, language: Language) {
  expect(await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.top-nav, .tab-bar')].find(element => getComputedStyle(element).display !== 'none')!, header = nav.parentElement!;
    return nav.scrollWidth <= nav.clientWidth && document.documentElement.scrollWidth <= innerWidth
      && nav.getBoundingClientRect().right <= header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 0.5;
  })).toBe(true);
  const keys = isNarrow(page) ? ['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar'] as const : ['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar', 'nav.statistics'] as const;
  for (const key of keys) {
    const box = await navLink(page, language, key).boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= innerWidthOf(page) && box.height >= 44).toBe(true);
  }
}
const innerWidthOf = (page: Page) => page.viewportSize()!.width;
const monthName = (month: string, language: Language = 'en') => new Intl.DateTimeFormat(locales[language], { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${month}-15T12:00:00Z`));
const spendLine = (label: string, amount: string, count: number, language: Language = 'en') =>
  `${label}${text('stats.spendLine', language, { amount, items: text(count === 1 ? 'stats.itemCount_one' : 'stats.itemCount_other', language, { count }) })}`;

test('spending: wardrobe value, average cost per wear, category and month totals in one currency', async ({ page }) => {
  await start(page);
  const spend = card(page, 'stats-spending');
  await expect(spend.getByRole('heading', { level: 2 })).toHaveText(text('stats.spending'));
  // Active EUR items: coat 240, shirt 45.50, boots 150. Worn: coat 3 days and shirt 1 day, so (240 + 45.50) / 4.
  const figures = spend.locator('.stats-figures > div');
  await expect(figures.nth(0)).toHaveText(`${text('stats.value')}${money(435.5, 'EUR')}`);
  await expect(figures.nth(1)).toHaveText(`${text('stats.averageCostPerWear')}${money(71.38, 'EUR')}`);
  await expect(spend.locator('section[aria-labelledby="stats-by-category"] li')).toHaveText([
    spendLine(text('category.top'), money(45.5, 'EUR'), 1), spendLine(text('category.footwear'), money(150, 'EUR'), 1),
    spendLine(text('category.outerwear'), money(240, 'EUR'), 1),
  ]);
  await expect(spend.locator('section[aria-labelledby="stats-by-month"] li')).toHaveText([
    spendLine(monthName('2026-09'), money(240, 'EUR'), 1), spendLine(monthName('2026-08'), money(45.5, 'EUR'), 1),
  ]);
  await expect(spend.locator('.stats-note')).toHaveText([
    text('stats.undated_one', 'en', { count: 1 }), text('stats.onlyCurrency', 'en', { currency: 'EUR' }), text('stats.priced_other', 'en', { priced: 4, total: 5 }),
  ]);
  await expect(spend).not.toContainText('USD');
  await expect(page.locator('main')).not.toContainText(money(999, 'EUR'));
  // The one currency choice switches both money cards together.
  await expect(page.getByLabel(text('stats.currency'))).toHaveCount(1);
  await page.getByLabel(text('stats.currency')).selectOption('USD');
  await expect(figures.nth(0)).toHaveText(`${text('stats.value')}${money(80, 'USD')}`);
  await expect(figures.nth(1)).toHaveText(`${text('stats.averageCostPerWear')}${money(80, 'USD')}`);
  await expect(spend.locator('section[aria-labelledby="stats-by-month"] li')).toHaveText([spendLine(monthName('2026-07'), money(80, 'USD'), 1)]);
  await expect(page.getByRole('table', { name: text('stats.costCaption', 'en', { currency: 'USD' }) })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('spending: without prices it says how many items have one, and shows no amounts', async ({ page }) => {
  await start(page, 'en', api => {
    const w = wardrobe(api);
    for (const row of [w.coat, w.shirt, w.jeans, w.boots]) row.purchase_price = null;
    return w;
  });
  const spend = card(page, 'stats-spending');
  await expect(spend).toContainText(text('stats.spendingNoPrices'));
  await expect(spend.locator('.stats-figures')).toHaveCount(0);
  await expect(spend.locator('.stats-priced')).toHaveText(text('stats.priced_other', 'en', { priced: 0, total: 5 }));
  await expect(page.getByLabel(text('stats.currency'))).toHaveCount(0);
});

test('I13: distinct-day counts, the lists and cost per wear kept in each currency', async ({ page }) => {
  await start(page);
  await expect(page.locator('#statistics-title')).toBeFocused();
  if (isNarrow(page)) {
    // On a phone Statistics is in More, which marks it as the current page.
    await expect(accountTrigger(page)).toHaveClass(/tab-more-current/);
    await expect((await openAccountMenu(page, 'en')).getByRole('link', { name: text('nav.statistics'), exact: true })).toHaveAttribute('aria-current', 'page');
    await closeAccountMenu(page);
  } else await expect(navLink(page, 'en', 'nav.statistics')).toHaveAttribute('aria-current', 'page');
  const most = card(page, 'stats-most').locator('li');
  await expect(most).toHaveCount(4);
  await expect(most.nth(0)).toHaveText(`Wool coat${text('stats.wears_other', 'en', { count: 3 })} · ${text('stats.lastWornOn', 'en', { date: shortDate('2026-09-15') })}`);
  await expect(most.nth(1)).toContainText('Grey scarf');
  await expect(most.nth(1)).toContainText(text('stats.wears_one', 'en', { count: 1 }));
  await expect(card(page, 'stats-unworn').getByRole('link')).toHaveText(['Leather boots']);
  // The profile currency comes first; the other currency is chosen, never added in.
  const table = page.getByRole('table', { name: text('stats.costCaption', 'en', { currency: 'EUR' }) });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(1)).toHaveText(`Wool coat${money(240, 'EUR')}3${money(80, 'EUR')}`);
  await expect(table.getByRole('row').nth(2)).toHaveText(`Linen shirt${money(45.5, 'EUR')}1${money(45.5, 'EUR')}`);
  await expect(table.getByRole('row').nth(3)).toHaveText(`Leather boots${money(150, 'EUR')}0${text('stats.neverWorn')}`);
  await expect(page.locator('.stats-table')).not.toContainText('USD');
  await expect(card(page, 'stats-cost').locator('.stats-note')).toHaveText(text('stats.unpriced_one', 'en', { count: 1 }));
  await page.getByLabel(text('stats.currency')).selectOption('USD');
  const usd = page.getByRole('table', { name: text('stats.costCaption', 'en', { currency: 'USD' }) });
  await expect(usd.getByRole('row')).toHaveCount(2);
  await expect(usd.getByRole('row').nth(1)).toHaveText(`Blue jeans${money(80, 'USD')}1${money(80, 'USD')}`);
  await expect(page.locator('main')).not.toContainText('Robin private');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('I13: with one priced currency there is no currency choice', async ({ page }) => {
  await start(page, 'en', api => {
    const w = wardrobe(api);
    w.jeans.purchase_price = null;
    return w;
  });
  const table = page.getByRole('table', { name: text('stats.costCaption', 'en', { currency: 'EUR' }) });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(page.getByLabel(text('stats.currency'))).toHaveCount(0);
  await expect(page.locator('.stats-currency')).toHaveCount(0);
  await expect(card(page, 'stats-cost').locator('.stats-note')).toHaveText(text('stats.unpriced_other', 'en', { count: 2 }));
});

test('I13: the item page shows the same count and last worn as Statistics', async ({ page }) => {
  const { seeded } = await start(page, 'en', wardrobe);
  const coat = card(page, 'stats-most').locator('li').first();
  const expected = `${text('stats.wears_other', 'en', { count: 3 })} · ${text('stats.lastWornOn', 'en', { date: shortDate('2026-09-15') })}`;
  await expect(coat.locator('.stats-meta')).toHaveText(expected);
  await coat.getByRole('link', { name: 'Wool coat' }).click();
  await expect(page.locator('.detail-wear')).toHaveText(expected);
  await page.goto(`/#/items/${String(seeded.boots.id)}`);
  await expect(page.locator('.detail-wear')).toHaveText(text('stats.neverWorn'));
});

test('I13: an empty history points to the calendar; nothing else is shown', async ({ page }) => {
  await start(page, 'en', api => { seedLook(api, '2026-09-20', [api.seedSavedItem('a', 'Unworn tee').item as Row], 'planned'); });
  await expect(page.locator('.stats-empty')).toContainText(text('stats.empty'));
  await expect(page.locator('.stats-empty').getByRole('link', { name: text('nav.calendar') })).toHaveAttribute('href', '#/calendar');
  await expect(page.locator('.stats-table')).toHaveCount(0);
  // Spending does not depend on wear history, so it is still shown.
  await expect(card(page, 'stats-spending')).toContainText(text('stats.spendingNoPrices'));
  await expect(card(page, 'stats-spending').locator('.stats-priced')).toHaveText(text('stats.priced_one', 'en', { priced: 0, total: 1 }));
});

test('I13: a failed read offers a retry, and offline figures are marked as possibly out of date', async ({ page, context }) => {
  test.setTimeout(60_000);
  let failing = true;
  await start(page, 'en', wardrobe, '#/statistics', () => page.route(url => url.pathname === '/rest/v1/wear_event_items', route => failing ? route.fulfill({ status: 500, json: { code: 'XX000' } }) : route.fallback()));
  await expect(page.getByRole('alert')).toContainText(text('wardrobe.historyUnavailable'), { timeout: 20_000 });
  failing = false;
  await page.getByRole('alert').getByRole('button', { name: text('common.retry') }).click();
  await expect(card(page, 'stats-most').locator('li')).toHaveCount(4);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.locator('.statistics-page [role="status"]')).toHaveText(text('stats.offline'));
  await expect(card(page, 'stats-most').locator('li')).toHaveCount(4);
  await context.setOffline(false);
});

test('spending: archived and sold prices never count as wardrobe value', async ({ page }) => {
  // Only EUR price is on a sold item; the one USD price is active. Zero-priced active items still count.
  await start(page, 'en', api => {
    const w = wardrobe(api);
    for (const row of [w.shirt, w.boots]) row.purchase_price = null;
    w.coat.lifecycle = 'sold';
    return w;
  });
  const spend = card(page, 'stats-spending');
  await expect(spend.locator('p').first()).toHaveText(text('stats.spendingNoPricesIn', 'en', { currency: 'EUR' }));
  await expect(spend.locator('.stats-figures')).toHaveCount(0);
  await expect(spend.locator('.stats-priced')).toHaveText(text('stats.priced_other', 'en', { priced: 1, total: 4 }));
  // The sold coat keeps its historical cost per wear.
  await expect(page.getByRole('table', { name: text('stats.costCaption', 'en', { currency: 'EUR' }) }).getByRole('row').nth(1)).toContainText('Wool coat');
  await page.getByLabel(text('stats.currency')).selectOption('USD');
  await expect(spend.locator('.stats-figures > div').first()).toHaveText(`${text('stats.value')}${money(80, 'USD')}`);
});

test('spending: with only inactive prices it shows the no-price state', async ({ page }) => {
  await start(page, 'en', api => {
    const w = wardrobe(api);
    for (const row of [w.shirt, w.boots, w.jeans]) row.purchase_price = null;
    w.coat.lifecycle = 'archived';
    return w;
  });
  const spend = card(page, 'stats-spending');
  await expect(spend.locator('p').first()).toHaveText(text('stats.spendingNoPrices'));
  await expect(spend).not.toContainText(money(0, 'EUR'));
  await expect(spend.locator('.stats-priced')).toHaveText(text('stats.priced_other', 'en', { priced: 0, total: 4 }));
});

test('spending: genuinely zero-priced active items show a zero value, not the empty state', async ({ page }) => {
  await start(page, 'en', api => {
    const w = wardrobe(api);
    for (const row of [w.coat, w.shirt, w.boots]) row.purchase_price = 0;
    w.jeans.purchase_price = null;
    return w;
  });
  const figures = card(page, 'stats-spending').locator('.stats-figures > div');
  await expect(figures.nth(0)).toHaveText(`${text('stats.value')}${money(0, 'EUR')}`);
  await expect(figures.nth(1)).toHaveText(`${text('stats.averageCostPerWear')}${money(0, 'EUR')}`);
});

for (const language of ['fi', 'sv'] as const) {
  test(`I13 in ${language === 'fi' ? 'Finnish' : 'Swedish'} at 320px and 200% text: the nav, the lists and the table fit`, async ({ page }) => {
    await start(page, language);
    await expect(page.locator('#statistics-title')).toHaveText(text('nav.statistics', language));
    await expect(card(page, 'stats-most').locator('li').first()).toContainText(text('stats.wears_other', language, { count: 3 }));
    await expect(page.locator('.stats-table tbody tr').first()).toContainText(money(80, 'EUR', language));
    await expect(card(page, 'stats-spending').locator('.stats-figures > div').first()).toContainText(money(435.5, 'EUR', language));
    await expect(card(page, 'stats-spending').locator('section[aria-labelledby="stats-by-month"] li').first()).toContainText(monthName('2026-09', language));
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    await navFits(page, language);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

// The longest display name the profile allows (60 characters).
const longName = 'Alexandra Montgomery-Wellington Fairweather Lindqvist Ahonen';
for (const language of ['fi', 'sv', 'en'] as const) {
  test(`I13: the five-link header fits with the longest display name between the phone and desktop layouts (${language})`, async ({ page }) => {
    expect([...longName].length).toBe(60);
    await start(page, language, api => { api.profiles[owners.a]!.display_name = longName; return wardrobe(api); });
    // The name is in the header only in the desktop layout; the widths below are all desktop.
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const hash of ['#/statistics', '#/wardrobe']) {
      await page.goto(`/${hash}`);
      await expectSignedIn(page);
      await expect(page.locator('.account-button span[title]')).toHaveAttribute('title', longName);
      for (const width of [651, 720, 800, 900, 901, 925, 950, 1000, 1100, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(async () => {
          await navFits(page, language);
          expect(await page.evaluate(() => {
            const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            const account = box('.account-button'), brand = box('.workspace-header .brand'), nav = box('.workspace-header nav');
            // The account menu stays beside the brand; the nav shares that row or takes the next one.
            const besideBrand = account.top < brand.bottom && account.bottom > brand.top;
            const navPlaced = nav.top < brand.bottom && nav.bottom > brand.top || nav.top >= Math.max(brand.bottom, account.bottom) - 0.5;
            return document.documentElement.scrollWidth <= innerWidth && account.left >= 0 && account.right <= innerWidth && besideBrand && navPlaced;
          })).toBe(true);
        }).toPass({ timeout: 5_000 });
      }
    }
  });
}

test.describe('bounded I13 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 390, zoom: false, suffix: 'fi-mobile' },
    { project: 'mobile', language: 'sv', width: 320, zoom: true, suffix: 'sv-320-200' },
  ] as const;
  const browserLocale = { en: 'en-GB', fi: 'fi-FI', sv: 'sv-SE' } as const;
  for (const selected of scenes) test.describe(selected.language, () => { test.use({ locale: browserLocale[selected.language] }); test(`overview ${selected.suffix}`, async ({ page }, testInfo: TestInfo) => {
    test.skip(testInfo.project.name !== selected.project, 'Captured in one project; the functional checks above run in every project.');
    const language: Language = selected.language;
    const directory = path.resolve('test-results/i13-visual');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    await page.setViewportSize({ width: selected.width, height: 900 });
    await start(page, language);
    await expect(card(page, 'stats-most').locator('li')).toHaveCount(4);
    if (selected.zoom) {
      await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      expect(await page.locator('#statistics-title').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(34);
      await navFits(page, language);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ expectedLanguage, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
        && !privatePattern.test(document.body.innerText) && !document.body.innerText.includes('Robin private');
    }, { expectedLanguage: language, width: selected.width })).toBe(true);
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
    const file = await open(path.join(directory, `overview-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  }); });
});
