import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn, type StylistSetup } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const card = (page: Page) => page.locator('section[aria-labelledby="stylist-heading"]');
// UI1: the row's switch shows the server state; an unchecked switch opens the consent sheet, whose Turn on writes.
const toggle = (page: Page, on: boolean) => card(page).locator(`[role="switch"][aria-checked="${on}"]`);
const sheet = (page: Page) => page.locator('dialog[aria-labelledby="stylist-sheet-title"]');
const message = (page: Page) => page.locator('#stylist-message');
const sendButton = (page: Page, language: Language = 'en') => page.getByRole('button', { name: text('stylist.send', language), exact: true });
const ideas = (page: Page) => page.locator('.stylist-ideas .today-card');
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';

function seed(api: Api) {
  const add = (title: string, fields: Row, account: 'a' | 'b' = 'a') => {
    const { item } = api.seedSavedItem(account, title);
    Object.assign(item as Row, { seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 2, ...fields });
    return item as Row & { id: string };
  };
  return {
    shirt: add('White shirt', { colours: ['white'] }), trousers: add('Navy trousers', { category: 'bottom', colours: ['navy'] }),
    boots: add('Black boots', { category: 'footwear', colours: ['black'] }), dress: add('Green dress', { category: 'one_piece', colours: ['green'] }),
    peer: add('Robin private coat', { category: 'outerwear' }, 'b'),
  };
}
type Clothes = ReturnType<typeof seed>;
type StartOptions = { language?: Language; setup?: Partial<StylistSetup>; consent?: boolean; hash?: string; clothes?: boolean };
async function start(page: Page, options: StartOptions = {}) {
  const language = options.language ?? 'en';
  const api = await mockBackend(page, { initialLanguage: language });
  const clothes = options.clothes === false ? null : seed(api);
  if (options.setup !== undefined) api.stylistControl.setup[owners.a] = { configured: true, activated: true, ...options.setup };
  if (options.consent) api.stylistControl.consent[owners.a] = 1;
  await page.goto(options.hash ?? '/#/stylist'); await signIn(page);
  await expect(page.locator('.workspace-identity')).toBeVisible();
  return { api, clothes: clothes! };
}
const reply = (clothes: Clothes, extra: Row = {}) => ({ status: 200, body: { code: 'OK', reply: 'Two ideas for Friday.', outfits: [
  { itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id], note: 'Crisp and simple.' },
  { itemIds: [clothes.dress.id, clothes.boots.id], note: '' },
], ...extra } });
async function ask(page: Page, words: string, language: Language = 'en') {
  await message(page).fill(words);
  await sendButton(page, language).click();
}
function held() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release };
}
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const locator of [message(page), sendButton(page)]) {
    if (!await locator.count()) continue;
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
  }
}
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

test.describe('ST1b stylist', () => {
  test('stays out of sight until the stylist is set up for the account', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
    const { api } = await start(page, { hash: '/#/today' });
    await expect(page.locator('#today-title')).toBeVisible();
    await expect(page.locator('.today-card').first()).toBeVisible();
    await expect(page.getByRole('button', { name: text('stylist.open'), exact: true })).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(page.locator('#stylist-heading')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(page.locator('#stylist-title')).toBeFocused();
    await expect(page.getByText(text('stylist.unavailable'), { exact: true })).toBeVisible();
    await expect(message(page)).toHaveCount(0);
    expect(api.stylistControl.chats).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a backend without the stylist hides it the same way', async ({ page }) => {
    const api = await mockBackend(page);
    api.stylistControl.missing = true;
    await page.goto('/#/settings'); await signIn(page);
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect.poll(() => api.stylistControl.statusReads + api.requests.filter((r) => r.path === '/rest/v1/rpc/stylist_status').length).toBeGreaterThan(0);
    await expect(page.locator('#stylist-heading')).toHaveCount(0);
  });

  test('is turned on and off in Settings with the full notice', async ({ page }) => {
    const { api } = await start(page, { setup: {}, hash: '/#/today' });
    const open = page.getByRole('button', { name: text('stylist.open'), exact: true });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.locator('#stylist-title')).toBeFocused();
    await expect(page.getByText(text('stylist.off'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: text('aiC.turnOn'), exact: true }).click();
    await expect(page.locator('#stylist-heading')).toBeFocused();
    await expect(page.locator('#stylist-heading')).toHaveText(text('stylistC.settings'));
    await expect(toggle(page, false)).toBeVisible();
    await expect(card(page)).toContainText(text('aiF.upTo', 'en', { limit: '$5' }));
    await card(page).getByText(text('aiF.about'), { exact: true }).click();
    for (const key of ['stylistC.fields', 'stylistC.azureNotice', 'stylistC.trainingNotice', 'stylistC.retention', 'stylistC.chargeNotice',
      'stylistC.usageNotice', 'stylistC.optOut'] as const) await expect(card(page)).toContainText(text(key));
    const bodies: unknown[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/rest/v1/rpc/stylist_set_consent') bodies.push(request.postDataJSON()); });
    await toggle(page, false).click();
    await expect(sheet(page)).toContainText(text('stylistC.offSummary', 'en', { stylistLimit: '$5', limit: '$17.94' }));
    expect(bodies).toEqual([]);
    await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(toggle(page, true)).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    await expect(toggle(page, true)).toBeFocused();
    await expect(card(page)).toContainText(text('aiC.usage', 'en', { used: '$0.00', limit: '$5' }));
    expect(bodies).toEqual([{ p_enabled: true, p_notice_revision: 1 }]);
    expect(api.stylistControl.consent[owners.a]).toBe(1);
    await toggle(page, true).click();
    await expect(toggle(page, false)).toBeVisible();
    expect(bodies.at(-1)).toEqual({ p_enabled: false, p_notice_revision: null });
    // The server's notice moved on between the read and the write.
    await page.route('http://127.0.0.1:54321/rest/v1/rpc/stylist_set_consent', (route) => route.fulfill({ json: { code: 'CONFIG_CHANGED' } }), { times: 1 });
    await toggle(page, false).click();
    await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(card(page).getByRole('alert')).toHaveText(text('stylistC.changed'));
    await expect(toggle(page, false)).toBeVisible();
  });

  test('keeps Turn off when this app version cannot use the stylist, and settles a lost reply by reading again (M2)', async ({ page }) => {
    const { api } = await start(page, { setup: { modelId: 'another-model' }, consent: true, hash: '/#/settings' });
    await expect(page.locator('#stylist-heading')).toHaveText(text('stylistC.settings'));
    await expect(card(page)).toContainText(text('stylist.unavailable'));
    await expect(card(page).getByRole('button', { name: text('aiC.enable'), exact: true })).toHaveCount(0);
    api.stylistControl.consentFaults.push('lost');
    api.stylistControl.statusFaults.push('fail');
    await toggle(page, true).click();
    await expect(card(page)).toContainText(text('stylist.unresolved'));
    await card(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
    // Consent is off now; without a notice this version can show, the card stays with no way to turn it on.
    await expect(card(page)).toContainText(text('stylist.unavailable'));
    await expect(card(page).getByRole('button')).toHaveCount(0);
    expect(api.stylistControl.consent[owners.a]).toBeNull();
    await page.evaluate(() => { location.hash = '#/today'; });
    await expect(page.locator('#today-title')).toBeVisible();
    await expect(page.getByRole('button', { name: text('stylist.open'), exact: true })).toHaveCount(0);
  });

  test('replies with idea cards built from local clothes, and Save opens the editor without saving', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    api.stylistControl.replies.push(reply(clothes, { reply: 'Try <b>this</b> https://example.test {"tool_calls":[{"name":"save_outfit"}]}' }));
    const writes: string[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/rest/v1/rpc/save_outfit')) writes.push(request.url()); });
    await ask(page, 'Dinner with friends on Friday');
    await expect(page.locator('.stylist-assistant .stylist-text').first()).toHaveText('Try <b>this</b> https://example.test {"tool_calls":[{"name":"save_outfit"}]}');
    await expect(page.locator('.stylist-assistant b, .stylist-assistant a')).toHaveCount(0);
    await expect(ideas(page)).toHaveCount(2);
    await expect(ideas(page).nth(0)).toContainText('White shirt');
    await expect(ideas(page).nth(0)).toContainText('Crisp and simple.');
    await expect(ideas(page).nth(1)).toContainText('Green dress');
    await expect(page.locator('.stylist-user .stylist-text')).toHaveText('Dinner with friends on Friday');
    await expect(message(page)).toHaveValue('');
    const [sent] = api.stylistControl.chats;
    expect(sent!.owner).toBe(owners.a);
    const body = sent!.body as Row;
    expect(Object.keys(body).sort()).toEqual(['history', 'message', 'occasion', 'requestId', 'season', 'weather']);
    expect(body).toMatchObject({ message: 'Dinner with friends on Friday', history: [], occasion: 'everyday', weather: null });
    expect(JSON.stringify(body)).not.toMatch(/White shirt|Navy trousers|Robin/);
    // The second message carries the first exchange, with outfits by item ID only.
    await ask(page, 'Something warmer');
    await expect(page.locator('.stylist-assistant')).toHaveCount(2);
    const second = api.stylistControl.chats[1]!.body as Row;
    expect(second.history).toEqual([{ role: 'user', text: 'Dinner with friends on Friday' }, { role: 'assistant',
      text: 'Try <b>this</b> https://example.test {"tool_calls":[{"name":"save_outfit"}]}',
      outfits: [[clothes.shirt.id, clothes.trousers.id, clothes.boots.id], [clothes.dress.id, clothes.boots.id]] }]);
    expect(second.requestId).not.toBe(body.requestId);
    await ideas(page).nth(0).getByRole('button', { name: text('today.save'), exact: true }).click();
    await expect(page.locator('#outfit-editor-title')).toBeFocused();
    await expect(page.locator('.outfit-slot')).toHaveCount(3);
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: text('outfits.back'), exact: true }).click();
    const leave = page.locator('dialog[aria-labelledby="outfit-leave-title"]');
    await leave.getByRole('button').last().click();
    await expect(page.locator('#outfits-title')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(page.locator('#stylist-title')).toBeVisible();
    await expect(page.locator('.stylist-assistant')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('#stylist-title')).toBeVisible();
    await expect(message(page)).toBeVisible();
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
  });

  test('rechecks ideas when returning and on each reply (M6)', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    api.stylistControl.replies.push(reply(clothes));
    await ask(page, 'Work tomorrow');
    await expect(ideas(page)).toHaveCount(2);
    const save = (index: number) => ideas(page).nth(index).getByRole('button', { name: text('today.save'), exact: true });
    await expect(save(0)).toBeEnabled();
    // Trashed and put in the laundry while the conversation stays on screen.
    (clothes.trousers as Row).deleted_at = '2026-10-02T00:00:00Z';
    (clothes.dress as Row).availability = 'laundry';
    await page.evaluate(() => { location.hash = '#/today'; });
    await expect(page.locator('#today-title')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(ideas(page).nth(0)).toContainText(text('stylist.itemGone'));
    await expect(ideas(page).nth(1)).toContainText(text('stylist.itemUnavailable'));
    await expect(save(0)).toBeDisabled();
    await expect(save(1)).toBeDisabled();
    // Back from the laundry: the next reply reloads the wardrobe.
    (clothes.dress as Row).availability = 'ready';
    await ask(page, 'And now?');
    await expect(page.locator('.stylist-assistant')).toHaveCount(2);
    await expect(save(1)).toBeEnabled();
    // A failed reload is not treated as a missing item: Save waits for a good load.
    await page.route('http://127.0.0.1:54321/rest/v1/items**', (route) => route.fulfill({ status: 400, json: { code: 'PGRST000', message: 'Unavailable' } }));
    await ask(page, 'One more');
    await expect(page.getByText(text('stylist.wardrobeFailed'), { exact: true })).toBeVisible();
    await expect(save(1)).toBeDisabled();
    await expect(page.getByText(text('stylist.itemGone'), { exact: true })).toHaveCount(1);
  });

  test('shows each refusal plainly and keeps the typed text (M5)', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    api.stylistControl.replies.push({ status: 429, body: { code: 'RATE_LIMIT' } });
    await ask(page, 'First try');
    await expect(page.getByRole('alert')).toHaveText(text('stylist.rate'));
    await expect(message(page)).toHaveValue('First try');
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
    // Refused for the shared limit: photo analysis used it, not the stylist.
    api.stylistControl.replies.push({ status: 402, body: { code: 'ALLOWANCE' } });
    api.stylistControl.setup[owners.a] = { ...api.stylistControl.setup[owners.a], totalMicro: '17900000' };
    await sendButton(page).click();
    await expect(page.getByText(text('stylist.limitShared'), { exact: true })).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.getByText(text('stylist.limitOwn'), { exact: true })).toHaveCount(0);
    // Then the stylist is paused after a failure.
    api.stylistControl.setup[owners.a] = { configured: true, activated: true };
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(sendButton(page)).toBeEnabled();
    api.stylistControl.replies.push({ status: 409, body: { code: 'INACTIVE' } });
    api.stylistControl.setup[owners.a] = { configured: true, activated: false };
    await sendButton(page).click();
    await expect(page.getByText(text('stylist.paused'), { exact: true })).toBeVisible();
    await expect(message(page)).toHaveCount(0);
  });

  test('drops a late reply after Clear, sign-out or a change of account', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    api.stylistControl.setup[owners.b] = { configured: true, activated: true };
    api.stylistControl.consent[owners.b] = 1;
    const first = held();
    api.stylistControl.replies.push({ ...reply(clothes), hold: first.hold });
    await ask(page, 'Held question');
    await expect(page.locator('.stylist-actions button[type=submit]')).toHaveText(text('stylist.sending'));
    await expect(page.locator('.stylist-user')).toContainText('Held question');
    await page.getByRole('button', { name: text('stylist.clear'), exact: true }).click();
    await expect(page.locator('[role="status"].sr-only')).toHaveText(text('stylist.cleared'));
    first.release();
    await page.waitForTimeout(300);
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
    await expect(message(page)).toHaveValue('');
    const second = held();
    api.stylistControl.replies.push({ ...reply(clothes), hold: second.hold });
    await ask(page, 'Question before signing out');
    await page.getByRole('button', { name: text('account.menu') }).click();
    await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    await signIn(page, 'b');
    await expect(page.locator('.workspace-identity')).toContainText('Robin');
    second.release();
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(page.locator('#stylist-message')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
    await expect(page.locator('#stylist-message')).toHaveValue('');
    await expect(page.getByText('Question before signing out')).toHaveCount(0);
  });

  test('Clear still works after consent is withdrawn and after a pause', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    const clearButton = page.getByRole('button', { name: text('stylist.clear'), exact: true });
    api.stylistControl.replies.push(reply(clothes));
    await ask(page, 'Before turning off');
    await expect(ideas(page)).toHaveCount(2);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await toggle(page, true).click();
    await expect(toggle(page, false)).toBeVisible();
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(page.getByText(text('stylist.off'), { exact: true })).toBeVisible();
    await expect(message(page)).toHaveCount(0);
    await expect(page.locator('.stylist-turn')).toHaveCount(2);
    await clearButton.click();
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
    await expect(clearButton).toHaveCount(0);
    await expect(page.locator('#stylist-title')).toBeFocused();
    // On again, then paused by the server while a conversation is on screen.
    api.stylistControl.consent[owners.a] = 1;
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    api.stylistControl.replies.push(reply(clothes));
    await ask(page, 'Before the pause');
    await expect(ideas(page)).toHaveCount(2);
    api.stylistControl.setup[owners.a] = { configured: true, activated: false };
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.getByText(text('stylist.paused'), { exact: true })).toBeVisible();
    await expect(message(page)).toHaveCount(0);
    await clearButton.click();
    await expect(page.locator('.stylist-turn')).toHaveCount(0);
  });

  test('an unsent draft can be cleared after a withdrawal or a pause, and is gone when turned on again', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const clearButton = page.getByRole('button', { name: text('stylist.clear'), exact: true });
    await message(page).fill('Draft before turning off');
    await expect(clearButton).toBeVisible();
    await page.evaluate(() => { location.hash = '#/settings'; });
    await toggle(page, true).click();
    await expect(toggle(page, false)).toBeVisible();
    await page.evaluate(() => { location.hash = '#/stylist'; });
    await expect(page.getByText(text('stylist.off'), { exact: true })).toBeVisible();
    await expect(message(page)).toHaveCount(0);
    await clearButton.click();
    await expect(clearButton).toHaveCount(0);
    api.stylistControl.consent[owners.a] = 1;
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(message(page)).toHaveValue('');
    // The same after a pause.
    await message(page).fill('Draft before the pause');
    api.stylistControl.setup[owners.a] = { configured: true, activated: false };
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.getByText(text('stylist.paused'), { exact: true })).toBeVisible();
    await clearButton.click();
    await expect(clearButton).toHaveCount(0);
    api.stylistControl.setup[owners.a] = { configured: true, activated: true };
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(message(page)).toHaveValue('');
    expect(api.stylistControl.chats).toHaveLength(0);
  });

  test('a manual temperature on Today is not sent while weather is turned off', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true, hash: '/#/today' });
    await page.getByRole('button', { name: text('weather.enterTemperature'), exact: true }).click();
    await page.locator('#weather-temperature').fill('22');
    await page.getByRole('button', { name: text('weather.useTemperature'), exact: true }).click();
    await expect(page.locator('#weather-temperature')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/stylist'; });
    api.stylistControl.replies.push(reply(clothes));
    await ask(page, 'What should I wear?');
    await expect(ideas(page)).toHaveCount(2);
    expect((api.stylistControl.chats[0]!.body as Row).weather).toBeNull();
  });

  test('offline keeps the draft and sends nothing; nothing is stored in the browser', async ({ page, context }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    api.stylistControl.replies.push(reply(clothes, { reply: 'reply-marker-7f3a' }));
    await ask(page, 'message-marker-91c2');
    await expect(page.getByText('reply-marker-7f3a')).toBeVisible();
    const stored = await page.evaluate(async () => {
      const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) parts.push(request.url, await (await cache.match(request))!.text());
      }
      const databases = await indexedDB.databases();
      parts.push(JSON.stringify(databases));
      return parts.join('\n');
    });
    expect(stored).not.toMatch(/message-marker-91c2|reply-marker-7f3a/);
    await context.setOffline(true);
    await page.evaluate(() => dispatchEvent(new Event('offline')));
    await message(page).fill('Offline words');
    await expect(page.getByText(text('stylist.offline'), { exact: true })).toBeVisible();
    await expect(sendButton(page)).toBeDisabled();
    await message(page).press('Enter');
    expect(api.stylistControl.chats).toHaveLength(1);
    await expect(message(page)).toHaveValue('Offline words\n');
    await context.setOffline(false);
  });

  test('passes axe and fits 320 px at 200% text, with a polite live region', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    await expect(page.locator('#stylist-title')).toBeVisible();
    await axe(page);
    api.stylistControl.replies.push(reply(clothes));
    await ask(page, 'Keyboard only');
    await expect(ideas(page)).toHaveCount(2);
    await expect(page.locator('[role="status"].sr-only')).toHaveText(text('stylist.replied'));
    await expect(message(page)).toBeFocused();
    await axe(page);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const zoomed of [false, true]) {
      if (zoomed) await page.addStyleTag({ content: zoom });
      await noOverflow(page, 320);
      await ideas(page).nth(1).getByRole('button', { name: text('today.save'), exact: true }).scrollIntoViewIfNeeded();
      await axe(page);
    }
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#stylist-heading')).toBeVisible();
    await card(page).getByText(text('aiF.about'), { exact: true }).click();
    await noOverflow(page, 320);
    await axe(page);
  });
});

test.describe('bounded ST1b visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'chat', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop', zoom: false },
    { scene: 'chat', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile', zoom: false },
    { scene: 'consent', project: 'mobile', language: 'sv', width: 320, suffix: 'sv-mobile', zoom: false },
    { scene: 'paused', project: 'mobile', language: 'en', width: 320, suffix: 'en-320-200', zoom: true },
  ] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/st1b-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      if (selected.scene === 'chat') {
        const { api, clothes } = await start(page, { language, setup: {}, consent: true });
        api.stylistControl.replies.push(reply(clothes, { reply: language === 'fi' ? 'Kaksi ideaa perjantaille.' : 'Two ideas for Friday.' }));
        await ask(page, language === 'fi' ? 'Illallinen ystävien kanssa perjantaina' : 'Dinner with friends on Friday', language);
        await expect(ideas(page)).toHaveCount(2);
        await ideas(page).nth(1).scrollIntoViewIfNeeded();
        await expect(page.locator('.stylist-ideas img')).toHaveCount(5);
        await page.evaluate(() => scrollTo(0, 0));
      } else if (selected.scene === 'consent') {
        await start(page, { language, setup: {}, hash: '/#/settings' });
        await expect(toggle(page, false)).toBeVisible();
        await card(page).getByText(text('aiF.about', language), { exact: true }).click();
        await expect(card(page)).toContainText(text('stylistC.optOut', language));
      } else {
        await start(page, { language, setup: { activated: false }, consent: true });
        await page.addStyleTag({ content: zoom });
        await expect(page.getByText(text('stylist.paused', language), { exact: true })).toBeVisible();
      }
      if (selected.zoom) await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await expect(page.locator('.workspace-identity')).toContainText('Alex');
      await axe(page);
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
      const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});
