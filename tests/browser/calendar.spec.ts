import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n';
import { formatDay, formatMonth } from '../../src/domain/local-date';
import { mockBackend, owners, signIn } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
// Wednesday 16 September 2026, noon in Helsinki (the fixture profile's time zone).
const now = new Date('2026-09-16T09:00:00Z');
const today = '2026-09-16';
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const day = (page: Page, date: string) => page.locator(`.calendar-day[data-date="${date}"]`);
const dialog = (page: Page) => page.locator('dialog.plan-dialog');
const cards = (page: Page) => page.locator('.calendar-day-panel .look-card');
const navLink = (page: Page, language: Language, key: 'nav.calendar' | 'nav.outfits' | 'nav.today' | 'nav.wardrobe') =>
  page.locator('.workspace-header nav').getByRole('link', { name: text(key, language), exact: true });

function seedClothes(api: Api) {
  const top = api.seedSavedItem('a', 'Olive overshirt').item as Row;
  const trousers = api.seedSavedItem('a', 'Navy trousers').item as Row;
  Object.assign(trousers, { category: 'bottom', created_at: '2026-09-09T00:00:01Z' });
  const peer = api.seedSavedItem('b', 'Robin private').item as Row;
  return { top, trousers, peer };
}
function seedOutfit(api: Api, itemIds: unknown[], title = 'Weekend') {
  const id = randomUUID(), at = '2026-09-10T08:00:00Z';
  api.outfits.push({ id, owner_id: owners.a, title, occasion: 'everyday', notes: '', favourite: false, deleted_at: null, version: 1, created_at: at, updated_at: at });
  itemIds.forEach((itemId, position) => api.outfitItems.push({ owner_id: owners.a, outfit_id: id, item_id: itemId, position }));
  return id;
}
function seedLook(api: Api, date: string, label: string, items: Row[], state: 'planned' | 'worn' = 'planned', account: 'a' | 'b' = 'a') {
  const id = randomUUID(), owner = owners[account], at = '2026-09-10T08:00:00Z';
  api.wearEvents.push({ id, owner_id: owner, outfit_id: null, local_date: date, timezone: 'Europe/Helsinki', state, label, deleted_at: null, version: 1, created_at: at, updated_at: at });
  for (const item of items) api.wearLinks.push({ id: randomUUID(), owner_id: owner, event_id: id, item_id: item.id, title_snapshot: item.title, category_snapshot: item.category });
  return id;
}
async function start(page: Page, language: Language = 'en', seed?: (api: Api, clothes: ReturnType<typeof seedClothes>) => void, hash = '#/calendar') {
  await page.clock.setFixedTime(now);
  const api = await mockBackend(page, { initialLanguage: language });
  api.wearControl.now = now;
  const clothes = seedClothes(api);
  seed?.(api, clothes);
  await page.goto(`/${hash}`); await signIn(page, 'a');
  await expect(page.locator('.workspace-identity')).toBeVisible();
  return { api, clothes };
}
function traffic(page: Page) {
  const saves: Row[] = [], patches: { query: string; body: Row }[] = [], writes: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:54321') return;
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()) && url.pathname !== '/auth/v1/token') writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/rest/v1/rpc/save_wear_event') saves.push(request.postDataJSON() as Row);
    if (url.pathname === '/rest/v1/wear_events' && request.method() === 'PATCH') patches.push({ query: url.search, body: request.postDataJSON() as Row });
  });
  return { saves, patches, writes };
}
const event = (api: Api, id: unknown) => api.wearEvents.find(row => row.id === id)!;

test('I12 plans a look from a saved outfit, marks it worn, undoes it, removes it and brings it back', async ({ page }) => {
  let outfitId = '';
  const { api, clothes } = await start(page, 'en', (api, clothes) => { outfitId = seedOutfit(api, [clothes.top.id, clothes.trousers.id]); });
  const seen = traffic(page);
  await expect(page.locator('#calendar-title')).toBeFocused();
  await expect(navLink(page, 'en', 'nav.calendar')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#calendar-month')).toHaveText(formatMonth('2026-09', 'en-GB'));
  await expect(day(page, today)).toHaveAttribute('aria-current', 'date');
  await expect(day(page, today)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#calendar-day-title')).toHaveText(formatDay(today, 'en-GB'));
  await expect(page.locator('.calendar-day-panel')).toContainText(text('calendar.empty'));

  const opener = button(page, 'calendar.planLook');
  await opener.click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#plan-date')).toHaveValue(today);
  await expect(page.getByRole('radio', { name: text('calendar.fromOutfit') })).toBeChecked();
  await expect(page.locator('#plan-outfit')).toHaveValue(outfitId);
  await expect(page.locator('#plan-label')).toHaveValue('Weekend');
  await dialog(page).getByRole('button', { name: text('calendar.add') }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.added'));
  const created = seen.saves[0]!;
  expect(created).toEqual({ p_id: created.p_id, p_local_date: today, p_timezone: 'Europe/Helsinki', p_state: 'planned', p_label: 'Weekend',
    p_outfit_id: outfitId, p_item_ids: [clothes.top.id, clothes.trousers.id] });
  const card = cards(page).first();
  await expect(card.getByRole('heading', { name: 'Weekend' })).toBeVisible();
  await expect(card).toContainText(text('calendar.planned'));
  await expect(card.getByRole('link', { name: 'Olive overshirt' })).toHaveAttribute('href', `#/items/${clothes.top.id}`);
  await expect(day(page, today)).toHaveAccessibleName(text('calendar.dayLooks_one', 'en', { date: formatDay(today, 'en-GB'), count: 1 }));

  await card.getByRole('button', { name: text('calendar.markWorn') }).click();
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.markedWornDone'));
  const undo = page.locator('.calendar-notice').getByRole('button', { name: text('common.undo') });
  await expect(undo).toBeFocused();
  await expect(card).toContainText(text('calendar.worn'));
  expect(seen.saves[1]).toMatchObject({ p_id: created.p_id, p_state: 'worn', p_expected_version: 1 });
  expect([...seen.saves[1]!.p_item_ids as string[]].sort()).toEqual([clothes.top.id, clothes.trousers.id].map(String).sort());
  await undo.click();
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.undone'));
  await expect(card).toContainText(text('calendar.planned'));
  expect(seen.saves[2]).toMatchObject({ p_id: created.p_id, p_state: 'planned', p_expected_version: 2 });
  expect(event(api, created.p_id)).toMatchObject({ state: 'planned', version: 3, deleted_at: null });

  await card.getByRole('button', { name: text('calendar.remove') }).click();
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.removed'));
  await expect(cards(page)).toHaveCount(0);
  expect(seen.patches[0]!.query).toContain(`version=eq.3`);
  expect(seen.patches[0]!.query).toContain(`owner_id=eq.${owners.a}`);
  expect(typeof seen.patches[0]!.body.deleted_at).toBe('string');
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.undone'));
  await expect(cards(page)).toHaveCount(1);
  expect(seen.patches[1]).toEqual({ query: expect.stringContaining('version=eq.4'), body: { deleted_at: null } });
  expect(event(api, created.p_id)).toMatchObject({ state: 'planned', version: 5, deleted_at: null });
  // Links and their snapshots are written only by save_wear_event.
  expect(seen.writes.every(write => write === 'POST /rest/v1/rpc/save_wear_event' || write === 'PATCH /rest/v1/wear_events')).toBe(true);
  expect(api.wearLinks.filter(link => link.event_id === created.p_id).map(link => link.title_snapshot).sort()).toEqual(['Navy trousers', 'Olive overshirt']);
});

test('I12 future days cannot be marked worn, a stale undo is a conflict, and another account never appears', async ({ page }) => {
  let future = '', past = '';
  const { api } = await start(page, 'en', (api, clothes) => {
    future = seedLook(api, '2026-09-20', 'Sunday lunch', [clothes.top]);
    past = seedLook(api, '2026-09-15', 'Office', [clothes.top, clothes.trousers]);
    seedLook(api, today, 'Robin look', [clothes.peer], 'planned', 'b');
  });
  const seen = traffic(page);
  await expect(page.locator('.calendar-day-panel')).toContainText(text('calendar.empty'));
  await expect(page.getByText('Robin look')).toHaveCount(0);

  await day(page, '2026-09-20').click();
  await expect(cards(page).first().getByRole('button', { name: text('calendar.markWorn') })).toBeDisabled();
  await expect(cards(page).first()).toContainText(text('calendar.futureWorn'));
  await button(page, 'calendar.planLook').click();
  await expect(page.locator('#plan-date')).toHaveValue('2026-09-20');
  await expect(page.getByRole('checkbox', { name: text('calendar.markWorn') })).toBeDisabled();
  await button(page, 'common.cancel').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(button(page, 'calendar.planLook')).toBeFocused();

  await day(page, '2026-09-15').click();
  await cards(page).first().getByRole('button', { name: text('calendar.markWorn') }).click();
  const undo = page.locator('.calendar-notice').getByRole('button', { name: text('common.undo') });
  await expect(undo).toBeFocused();
  // Another device changes the look before Undo; the stale version must not overwrite it.
  Object.assign(event(api, past), { label: 'Office, edited elsewhere', version: 3 });
  await undo.click();
  await expect(page.getByRole('alert')).toContainText(text('error.conflict'));
  expect(seen.saves.at(-1)).toMatchObject({ p_id: past, p_state: 'planned', p_expected_version: 2 });
  expect(event(api, past)).toMatchObject({ state: 'worn', label: 'Office, edited elsewhere', version: 3 });
  await page.getByRole('alert').getByRole('button', { name: text('outfits.reload') }).click();
  await expect(cards(page).first().getByRole('heading', { name: 'Office, edited elsewhere' })).toBeVisible();

  // The server's own future check is mapped as well, whichever save_wear_event version answers.
  api.wearControl.next = { mode: 'error', status: 400, body: { code: 'P0001', message: 'A future plan cannot count as worn' } };
  await day(page, today).click();
  await button(page, 'calendar.planLook').click();
  await dialog(page).getByRole('checkbox', { name: 'Olive overshirt' }).check();
  await page.getByRole('checkbox', { name: text('calendar.markWorn') }).check();
  await dialog(page).getByRole('button', { name: text('calendar.add') }).click();
  await expect(dialog(page).getByRole('alert')).toContainText(text('calendar.future'));
  expect(api.wearEvents.filter(row => row.owner_id === owners.a && row.local_date === today)).toHaveLength(0);
  expect(event(api, future)).toMatchObject({ state: 'planned', version: 1 });
});

test('I12 an outfit can be worn today or planned for a date, and a lost reply is confirmed by a reread', async ({ page }) => {
  let outfitId = '';
  const { api } = await start(page, 'en', (api, clothes) => { outfitId = seedOutfit(api, [clothes.top.id, clothes.trousers.id], 'Dinner'); }, '');
  await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
  await expect(page.locator('#outfit-detail-title')).toHaveText('Dinner');
  api.wearControl.next = { mode: 'committedLost' };
  await button(page, 'calendar.wearToday').click();
  await expect(page.locator('.outfit-view .notice-success')).toContainText(text('calendar.markedWornDone'));
  const worn = api.wearEvents.filter(row => row.owner_id === owners.a);
  expect(worn).toHaveLength(1);
  expect(worn[0]).toMatchObject({ local_date: today, state: 'worn', label: 'Dinner', outfit_id: outfitId, version: 1 });
  expect(api.wearControl.saves).toBe(1);
  const undo = page.locator('.outfit-view .notice-success').getByRole('button', { name: text('common.undo') });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(page.locator('.outfit-view .notice-success')).toContainText(text('calendar.undone'));
  expect(worn[0]).toMatchObject({ version: 2, deleted_at: expect.any(String) });

  await button(page, 'calendar.plan').click();
  await expect(page.locator('#calendar-title')).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#plan-outfit')).toHaveValue(outfitId);
  await page.locator('#plan-date').fill('2026-09-18');
  await dialog(page).getByRole('button', { name: text('calendar.add') }).click();
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.added'));
  await expect(day(page, '2026-09-18')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page).first().getByRole('heading', { name: 'Dinner' })).toBeVisible();
  await expect(page.locator('#calendar-title')).toBeVisible();
});

test('I12 leaving during Wear today waits for the reply, and coming back to an unknown outcome reads it back before any resend', async ({ page }) => {
  let outfitId = '';
  const { api } = await start(page, 'en', (api, clothes) => { outfitId = seedOutfit(api, [clothes.top.id, clothes.trousers.id], 'Dinner'); }, '');
  const { saves } = traffic(page);
  const held: Array<() => Promise<void>> = [];
  // The client retries failed reads itself, so a read failure lasts for a whole phase.
  let failReads = false, reads = 0;
  await page.route(url => url.pathname === '/rest/v1/rpc/save_wear_event', route => new Promise<void>(resolve => {
    held.push(() => route.fallback().then(resolve));
  }));
  await page.route(url => url.pathname === '/rest/v1/wear_events' && (url.searchParams.get('id') ?? '').startsWith('eq.'), route => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads++;
    if (failReads) return route.abort();
    return route.fallback();
  });
  await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
  await expect(page.locator('#outfit-detail-title')).toHaveText('Dinner');
  // The server stores the look, but its reply is lost and the reread fails too, so the outcome stays unknown.
  api.wearControl.next = { mode: 'committedLost' };
  failReads = true;
  await button(page, 'calendar.wearToday').click();
  await expect.poll(() => held.length).toBe(1);
  await expect(button(page, 'calendar.plan')).toBeDisabled();
  await expect(button(page, 'outfits.edit')).toBeDisabled();
  await navLink(page, 'en', 'nav.outfits').click();
  await expect(page.locator('#outfit-detail-title')).toHaveText('Dinner');
  expect(page.url()).toContain(`#/outfits/${outfitId}`);
  await held.shift()!();
  // Once the write has settled (after the client's own read retries), the queued navigation goes ahead.
  await expect(page.locator('#outfits-title')).toBeVisible({ timeout: 15_000 });
  expect(reads).toBeGreaterThan(0);
  expect(api.wearEvents.filter(row => row.owner_id === owners.a)).toHaveLength(1);

  // Coming back reads the kept look first; while that read fails nothing is sent again.
  reads = 0;
  await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
  const problem = page.locator('.outfit-view .notice-error');
  await expect(problem).toContainText(text('calendar.unknown'), { timeout: 15_000 });
  expect(reads).toBeGreaterThan(0);
  expect(saves).toHaveLength(1);
  failReads = false; reads = 0;
  await problem.getByRole('button', { name: text('common.retry') }).click();
  await expect(page.locator('.outfit-view .notice-success')).toContainText(text('calendar.markedWornDone'));
  expect(reads).toBeGreaterThan(0);
  expect(held).toHaveLength(0);
  expect(saves).toHaveLength(1);
  expect(api.wearEvents.filter(row => row.owner_id === owners.a)).toHaveLength(1);
  await expect(button(page, 'calendar.plan')).toBeEnabled();
  await expect(button(page, 'outfits.edit')).toBeEnabled();
});

test('I12 leaving the calendar while Mark as worn is on its way waits for the reply', async ({ page }) => {
  let lookId = '';
  const { api } = await start(page, 'en', (api, clothes) => { lookId = seedLook(api, today, 'Morning walk', [clothes.top]); });
  const held: Array<() => Promise<void>> = [];
  await page.route(url => url.pathname === '/rest/v1/rpc/save_wear_event', route => new Promise<void>(resolve => {
    held.push(() => route.fallback().then(resolve));
  }));
  await expect(cards(page)).toHaveCount(1);
  await cards(page).getByRole('button', { name: text('calendar.markWorn') }).click();
  await expect.poll(() => held.length).toBe(1);
  await navLink(page, 'en', 'nav.outfits').click();
  await expect(page.locator('#calendar-title')).toBeVisible();
  await held.shift()!();
  await expect(page.locator('#outfits-title')).toBeVisible();
  expect(event(api, lookId)).toMatchObject({ state: 'worn', version: 2 });
  expect(api.wearControl.saves).toBe(1);
});

// Reads of one look by ID (the reconciliation reads) can be failed for a whole phase; the month list is not affected.
async function lookReads(page: Page) {
  const control = { fail: false, count: 0 };
  await page.route(url => url.pathname === '/rest/v1/wear_events' && (url.searchParams.get('id') ?? '').startsWith('eq.'), route => {
    if (route.request().method() !== 'GET') return route.fallback();
    control.count++;
    return control.fail ? route.abort() : route.fallback();
  });
  return control;
}

test('I12 a plan whose reply was lost is shown again when the dialog reopens, and Retry reads it back instead of adding it twice', async ({ page }) => {
  const { api } = await start(page, 'en');
  const { saves } = traffic(page);
  const reads = await lookReads(page);
  const mine = () => api.wearEvents.filter(row => row.owner_id === owners.a);
  api.wearControl.next = { mode: 'committedLost' };
  reads.fail = true;
  await button(page, 'calendar.planLook').click();
  await dialog(page).getByRole('checkbox', { name: 'Olive overshirt' }).check();
  await page.locator('#plan-label').fill('Market day');
  await dialog(page).getByRole('button', { name: text('calendar.add') }).click();
  await expect(dialog(page).getByRole('alert')).toContainText(text('calendar.unknown'), { timeout: 15_000 });
  await expect(dialog(page)).toContainText('Market day');
  await expect(page.locator('#plan-date')).toHaveCount(0);
  expect(mine()).toHaveLength(1);
  await dialog(page).getByRole('button', { name: text('common.cancel') }).click();
  await expect(dialog(page)).toHaveCount(0);

  await navLink(page, 'en', 'nav.outfits').click();
  await expect(page.locator('#outfits-title')).toBeVisible();
  await navLink(page, 'en', 'nav.calendar').click();
  await expect(page.locator('#calendar-title')).toBeVisible();
  reads.count = 0;
  await button(page, 'calendar.planLook').click();
  // Reopening shows the kept plan, not a blank form, and reads it back before anything else.
  await expect(dialog(page).getByRole('status')).toHaveText(text('calendar.checkingPlan'));
  await expect(dialog(page)).toContainText('Market day');
  await expect(page.locator('#plan-date')).toHaveCount(0);
  await expect(dialog(page).getByRole('alert')).toContainText(text('calendar.unknown'), { timeout: 15_000 });
  await expect(dialog(page).getByRole('button', { name: text('calendar.startOver') })).toHaveCount(0);
  expect(reads.count).toBeGreaterThan(0);
  expect(saves).toHaveLength(1);

  reads.fail = false; reads.count = 0;
  await dialog(page).getByRole('button', { name: text('common.retry') }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.calendar-notice')).toContainText(text('calendar.added'));
  expect(reads.count).toBeGreaterThan(0);
  expect(saves).toHaveLength(1);
  expect(mine()).toHaveLength(1);
  expect(mine()[0]).toMatchObject({ id: saves[0]!.p_id, label: 'Market day', local_date: today, state: 'planned', version: 1 });
  await expect(cards(page)).toHaveCount(1);
  // The kept plan is settled, so the next plan starts from a blank form.
  await button(page, 'calendar.planLook').click();
  await expect(page.locator('#plan-date')).toHaveValue(today);
  expect(saves).toHaveLength(1);
});

test('I12 a lost Wear today reply whose look has since changed elsewhere counts as saved and is never recorded again', async ({ page }) => {
  let outfitId = '';
  const { api } = await start(page, 'en', (api, clothes) => { outfitId = seedOutfit(api, [clothes.top.id, clothes.trousers.id], 'Dinner'); }, '');
  const { saves } = traffic(page);
  const reads = await lookReads(page);
  const mine = () => api.wearEvents.filter(row => row.owner_id === owners.a);
  await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
  await expect(page.locator('#outfit-detail-title')).toHaveText('Dinner');
  api.wearControl.next = { mode: 'committedLost' };
  reads.fail = true;
  await button(page, 'calendar.wearToday').click();
  const problem = page.locator('.outfit-view .notice-error');
  await expect(problem).toContainText(text('calendar.unknown'), { timeout: 15_000 });
  expect(mine()).toHaveLength(1);
  // Another device edits the stored look before this one can confirm it.
  Object.assign(mine()[0]!, { label: 'Dinner, edited elsewhere', state: 'planned', version: 2 });
  reads.fail = false;
  await problem.getByRole('button', { name: text('common.retry') }).click();
  const done = page.locator('.outfit-view .notice-success');
  await expect(done).toContainText(text('calendar.alreadySaved'));
  await expect(done.getByRole('button', { name: text('common.undo') })).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(mine()).toHaveLength(1);
  expect(mine()[0]).toMatchObject({ label: 'Dinner, edited elsewhere', version: 2 });

  // The attempt is settled: coming back reads and sends nothing more.
  await navLink(page, 'en', 'nav.outfits').click();
  await expect(page.locator('#outfits-title')).toBeVisible();
  reads.count = 0;
  await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
  await expect(button(page, 'calendar.wearToday')).toBeEnabled();
  await expect(page.locator('.outfit-view .notice-error')).toHaveCount(0);
  expect(reads.count).toBe(0);
  expect(saves).toHaveLength(1);
  expect(mine()).toHaveLength(1);
});

test('I12 in Finnish and Swedish: Monday-first weeks, arrow keys, the agenda, and the nav at 320px and 200% text', async ({ page }) => {
  await start(page, 'fi', (api, clothes) => {
    seedLook(api, '2026-09-14', 'Toimisto', [clothes.top, clothes.trousers], 'worn');
    seedLook(api, '2026-09-22', 'Teatteri', [clothes.top]);
  });
  const fi = locales.fi;
  await expect(page.locator('.calendar-grid th').first().locator('abbr')).toHaveAttribute('title', new Intl.DateTimeFormat(fi, { weekday: 'long', timeZone: 'UTC' }).format(new Date('2024-01-01T12:00:00Z')));
  await expect(page.locator('#calendar-month')).toHaveText(formatMonth('2026-09', fi));
  await day(page, today).focus();
  await page.keyboard.press('ArrowRight');
  await expect(day(page, '2026-09-17')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(day(page, '2026-09-24')).toBeFocused();
  await expect(day(page, '2026-09-24')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await expect(day(page, '2026-09-07')).toBeFocused();
  await expect(page.locator('.calendar-grid [tabindex="0"]')).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await button(page, 'calendar.agenda', 'fi').click();
  await expect(button(page, 'calendar.agenda', 'fi')).toHaveAttribute('aria-pressed', 'true');
  const headings = page.locator('.calendar-agenda > li > h3');
  await expect(headings).toHaveText([formatDay('2026-09-14', fi), formatDay('2026-09-22', fi)]);
  await expect(page.locator('.calendar-agenda')).toContainText(text('calendar.worn', 'fi'));
  await page.getByRole('button', { name: text('calendar.nextMonth', 'fi') }).click();
  await expect(page.locator('.calendar-page')).toContainText(text('calendar.agendaEmpty', 'fi'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
  await navFits(page, 'fi');
});

async function navFits(page: Page, language: Language) {
  await expect(page.locator('#calendar-title')).toHaveText(text('nav.calendar', language));
  expect(await page.evaluate(() => {
    const nav = document.querySelector('.workspace-header nav')!, header = nav.parentElement!;
    return nav.scrollWidth <= nav.clientWidth && document.documentElement.scrollWidth <= innerWidth
      && nav.getBoundingClientRect().right <= header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 0.5;
  })).toBe(true);
  for (const key of ['nav.today', 'nav.wardrobe', 'nav.outfits', 'nav.calendar'] as const) {
    const box = await navLink(page, language, key).boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44).toBe(true);
  }
}

// Day cells never overlap one another, stay inside the grid, and every cell in a week row has the same height.
async function gridFits(page: Page) {
  const problems = await page.locator('.calendar-grid').evaluate(grid => {
    const found: string[] = [], bounds = grid.getBoundingClientRect();
    for (const row of grid.querySelectorAll('tbody tr')) {
      const boxes = [...row.querySelectorAll('.calendar-day')].map(day => ({ date: (day as HTMLElement).dataset.date, box: day.getBoundingClientRect(),
        inner: [...day.children].map(child => child.getBoundingClientRect()) }));
      if (new Set(boxes.map(value => Math.round(value.box.height))).size > 1) found.push('uneven row');
      boxes.forEach((value, index) => {
        const next = boxes[index + 1];
        if (next && value.box.right > next.box.left + 0.5) found.push(`${value.date} overlaps`);
        if (value.box.left < bounds.left - 0.5 || value.box.right > bounds.right + 0.5) found.push(`${value.date} outside`);
        if (value.inner.some(inner => inner.width > 0 && (inner.left < value.box.left - 0.5 || inner.right > value.box.right + 0.5))) found.push(`${value.date} content spills`);
      });
    }
    return found;
  });
  expect(problems).toEqual([]);
}

test('I12 in Swedish at 320px and 200% text: the grid, the nav and the plan dialog fit', async ({ page }) => {
  await start(page, 'sv', (api, clothes) => { seedOutfit(api, [clothes.top.id]); seedLook(api, today, 'Kontoret', [clothes.top]); });
  await expect(page.locator('.calendar-grid th').first().locator('abbr')).toHaveAttribute('title', new Intl.DateTimeFormat(locales.sv, { weekday: 'long', timeZone: 'UTC' }).format(new Date('2024-01-01T12:00:00Z')));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
  await navFits(page, 'sv');
  await gridFits(page);
  await expect(cards(page).first().getByRole('button', { name: text('calendar.markWorn', 'sv') })).toBeVisible();
  await button(page, 'calendar.planLook', 'sv').click();
  await expect(page.locator('#plan-outfit')).toBeVisible();
  // The two source options never run into each other, whether they sit side by side or wrap.
  expect(await page.locator('.plan-source .check').evaluateAll(labels => {
    const [a, b] = labels.map(label => label.getBoundingClientRect());
    return !!a && !!b && (a.right + 8 <= b.left || a.bottom <= b.top);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(button(page, 'calendar.planLook', 'sv')).toBeFocused();
});

test.describe('bounded I12 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'month', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'day-looks', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'agenda', project: 'mobile', language: 'fi', width: 390, zoom: false, suffix: 'fi-mobile' },
    { scene: 'plan', project: 'mobile', language: 'sv', width: 390, zoom: false, suffix: 'sv-mobile' },
    { scene: 'month', project: 'mobile', language: 'fi', width: 320, zoom: true, suffix: 'fi-320-200' },
  ] as const;
  // The native date field follows the browser locale, so each capture uses its language's locale.
  const browserLocale = { en: 'en-GB', fi: 'fi-FI', sv: 'sv-SE' } as const;
  for (const selected of scenes) test.describe(selected.language, () => { test.use({ locale: browserLocale[selected.language] }); test(`${selected.scene} ${selected.suffix}`, async ({ page }, testInfo: TestInfo) => {
    test.skip(testInfo.project.name !== selected.project, 'Captured in one project; the functional checks above run in every project.');
    const language: Language = selected.language;
    const directory = path.resolve('test-results/i12-visual');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    await page.setViewportSize({ width: selected.width, height: 900 });
    let pastId = '';
    await start(page, language, (api, clothes) => {
      seedOutfit(api, [clothes.top.id, clothes.trousers.id], 'Weekend');
      seedLook(api, '2026-09-03', 'Office', [clothes.top, clothes.trousers], 'worn');
      seedLook(api, '2026-09-11', 'Dinner', [clothes.top], 'worn');
      pastId = seedLook(api, today, 'Morning walk', [clothes.top, clothes.trousers]);
      seedLook(api, today, 'Theatre', [clothes.trousers]);
      seedLook(api, '2026-09-24', 'Weekend trip', [clothes.top, clothes.trousers]);
    });
    await expect(cards(page)).toHaveCount(2);
    if (selected.scene === 'day-looks') {
      const card = cards(page).filter({ hasText: 'Morning walk' });
      await card.getByRole('button', { name: text('calendar.markWorn', language) }).click();
      await expect(page.locator('.calendar-notice').getByRole('button', { name: text('common.undo', language) })).toBeFocused();
      await expect(card).toContainText(text('calendar.worn', language));
      expect(pastId).not.toBe('');
    } else if (selected.scene === 'agenda') {
      await button(page, 'calendar.agenda', language).click();
      await expect(page.locator('.calendar-agenda > li')).toHaveCount(4);
    } else if (selected.scene === 'plan') {
      await button(page, 'calendar.planLook', language).click();
      await expect(page.locator('#plan-outfit')).toBeVisible();
      await expect(page.locator('#plan-label')).toHaveValue('Weekend');
    }
    if (selected.zoom) {
      await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      expect(await page.locator('#calendar-month').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(34);
      await gridFits(page);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ expectedLanguage, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
        && !privatePattern.test(document.body.innerText);
    }, { expectedLanguage: language, width: selected.width })).toBe(true);
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  }); });
});
