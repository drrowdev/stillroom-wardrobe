import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { pluralText, translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, signIn, type OutfitGenSetup } from './mock-backend';
import { expectSignedIn } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const section = (page: Page) => page.locator('section[aria-labelledby="suggested-title"]');
const cards = (page: Page) => section(page).locator('.suggested-card');
const card = (page: Page) => page.locator('section[aria-labelledby="outfitgen-heading"]');
const toggle = (page: Page, on: boolean) => card(page).locator(`[role="switch"][aria-checked="${on}"]`);
const sheet = (page: Page) => page.locator('dialog[aria-labelledby="outfitgen-sheet-title"]');
const find = (page: Page, language: Language = 'en') => section(page).getByRole('button', { name: text('outfitgen.find', language), exact: true });
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

function seed(api: Api) {
  const add = (title: string, fields: Row) => {
    const { item } = api.seedSavedItem('a', title);
    Object.assign(item as Row, { seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 2, ...fields });
    return item as Row & { id: string };
  };
  return { shirt: add('White shirt', { colours: ['white'] }), trousers: add('Navy trousers', { category: 'bottom', colours: ['navy'] }),
    boots: add('Black boots', { category: 'footwear', colours: ['black'] }), dress: add('Green dress', { category: 'one_piece', colours: ['green'] }) };
}
type Clothes = ReturnType<typeof seed>;
const sets = (clothes: Clothes) => [
  { itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id], title: 'Crisp navy', reason: 'Quiet colours that stay calm together.', occasion: 'smart', score: 9 },
  { itemIds: [clothes.dress.id, clothes.boots.id], title: 'Green day', reason: 'One piece and dark boots.', occasion: 'everyday', score: 8 },
];
type StartOptions = { language?: Language; missing?: boolean; setup?: Partial<OutfitGenSetup>; consent?: boolean; hash?: string; suggestions?: boolean; autoUnassessed?: number };
/** `setup` left out means an account the feature is not set up for; `missing` is a backend without it; `{}` is configured and active. */
async function start(page: Page, options: StartOptions = {}) {
  const language = options.language ?? 'en';
  const api = await mockBackend(page, { initialLanguage: language });
  const clothes = seed(api);
  const control = api.outfitgenControl;
  control.missing = options.missing === true;
  if (options.setup) control.setup[owners.a] = { configured: true, activated: true, ...options.setup };
  if (options.consent) control.consent[owners.a] = 1;
  if (options.suggestions) for (const entry of sets(clothes)) control.suggestions.push({ id: crypto.randomUUID(), owner: owners.a, state: 'suggested', ...entry });
  control.autoUnassessed = options.autoUnassessed ?? 0;
  control.unassessed = control.autoUnassessed;
  await page.clock.install();
  await page.goto(options.hash ?? '/#/outfits'); await signIn(page);
  await expectSignedIn(page);
  return { api, clothes };
}
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const locator of [section(page).locator('button').first(), cards(page).first()]) {
    if (!await locator.count()) continue;
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= width + 1).toBe(true);
  }
}

test.describe('OUTFITGEN1b suggested outfits', () => {
  test('is invisible and makes no calls where the backend has no outfit generation or the account is not set up', async ({ page }) => {
    const { api } = await start(page, { missing: true, autoUnassessed: 2 });
    await expect(page.locator('#outfits-title')).toBeVisible();
    await page.clock.fastForward(120_000);
    await expect(section(page)).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(page.locator('#outfitgen-heading')).toHaveCount(0);
    expect(api.outfitgenControl.runs).toEqual([]);
  });

  test('stays hidden for an account that was never set up, and makes no run', async ({ page }) => {
    const { api } = await start(page, { setup: { configured: false }, autoUnassessed: 2 });
    await expect(page.locator('#outfits-title')).toBeVisible();
    await expect.poll(() => api.outfitgenControl.statusReads).toBeGreaterThan(0);
    await page.clock.fastForward(120_000);
    await expect(section(page)).toHaveCount(0);
    expect(api.outfitgenControl.runs).toEqual([]);
  });

  test('asks for consent where consent is missing, and never runs without it', async ({ page }) => {
    const { api } = await start(page, { setup: {}, autoUnassessed: 2 });
    await expect(section(page).getByText(text('outfitgen.off'), { exact: true })).toBeVisible();
    await expect(find(page)).toHaveCount(0);
    await page.clock.fastForward(120_000);
    expect(api.outfitgenControl.runs).toEqual([]);
    await section(page).getByRole('link', { name: text('aiC.turnOn'), exact: true }).click();
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(card(page)).toBeVisible();
  });

  test('is turned on and off in Settings with the full notice', async ({ page }) => {
    const { api } = await start(page, { setup: {}, hash: '/#/settings' });
    await expect(page.locator('#outfitgen-heading')).toHaveText(text('outfitgenC.settings'));
    await expect(toggle(page, false)).toBeVisible();
    await card(page).getByText(text('aiF.about'), { exact: true }).click();
    for (const key of ['outfitgenC.sent', 'outfitgenC.when', 'outfitgenC.processing', 'aiC.azureTrainingNotice', 'outfitgenC.stored', 'outfitgenC.charges',
      'outfitgenC.optOut'] as const) await expect(card(page)).toContainText(text(key));
    const bodies: unknown[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/rest/v1/rpc/outfitgen_set_consent') bodies.push(request.postDataJSON()); });
    await toggle(page, false).click();
    await expect(sheet(page)).toContainText(text('outfitgenC.sent'));
    expect(bodies).toEqual([]);
    await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(toggle(page, true)).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    expect(bodies).toEqual([{ p_enabled: true, p_notice_revision: 1 }]);
    expect(api.outfitgenControl.consent[owners.a]).toBe(1);
    await toggle(page, true).click();
    await expect(toggle(page, false)).toBeVisible();
    expect(bodies.at(-1)).toEqual({ p_enabled: false, p_notice_revision: null });
    // The server's notice moved on between the read and the write.
    await page.route('http://127.0.0.1:54321/rest/v1/rpc/outfitgen_set_consent', (route) => route.fulfill({ json: { code: 'CONFIG_CHANGED' } }), { times: 1 });
    await toggle(page, false).click();
    await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(card(page).getByRole('alert')).toHaveText(text('outfitgenC.changed'));
  });

  test('shows the suggestions with their garments; Keep saves a normal outfit', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, suggestions: true });
    await expect(section(page).getByRole('heading', { level: 2 })).toHaveText(text('outfitgen.titleCount', 'en', { count: 2 }));
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).first()).toContainText('Quiet colours that stay calm together.');
    await expect(cards(page).first()).toContainText(text('occasion.smart'));
    await expect(cards(page).first().locator('.outfit-thumb')).toHaveCount(3);
    await cards(page).first().getByRole('button', { name: text('outfitgen.keepLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.kept'));
    await expect(page.locator('.outfit-grid .outfit-card').filter({ hasText: 'Crisp navy' })).toHaveCount(1);
    expect(api.outfitgenControl.suggestions.filter((entry) => entry.state === 'kept')).toHaveLength(1);
    expect(api.outfits.filter((entry) => entry.owner_id === owners.a && entry.title === 'Crisp navy')).toHaveLength(1);
  });

  test('Remove hides a suggestion and Undo brings it back', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, suggestions: true });
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.removed'));
    expect(api.outfitgenControl.suggestions.filter((entry) => entry.state === 'removed')).toHaveLength(1);
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(cards(page)).toHaveCount(2);
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.restored'));
    // A set whose vote changed in Today can't be undone, and the card stays gone.
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    api.outfitgenControl.undoCodes.push('CONFLICT');
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.undoConflict'));
    await expect(cards(page)).toHaveCount(1);
  });

  test('says plainly when a suggestion can no longer be kept', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, suggestions: true });
    const keep = (title: string) => cards(page).filter({ hasText: title }).getByRole('button', { name: text('outfitgen.keepLabel', 'en', { title }), exact: true });
    api.outfitgenControl.decisionCodes.push('BUSY');
    await keep('Crisp navy').click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.decideBusy'));
    await expect(cards(page)).toHaveCount(2);
    api.outfitgenControl.decisionCodes.push('STALE');
    await keep('Crisp navy').click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.stale'));
    await expect(cards(page)).toHaveCount(1);
    api.outfitgenControl.decisionCodes.push('IN_TRASH');
    await keep('Green day').click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.inTrash'));
    await expect(cards(page)).toHaveCount(0);
    expect(api.outfits.filter((entry) => entry.owner_id === owners.a)).toHaveLength(0);
  });

  test('Find new outfits makes one manual call and reports what it found', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    await expect(section(page).getByText(text('outfitgen.none'), { exact: true })).toBeVisible();
    api.outfitgenControl.replies.push({ status: 200, body: { code: 'OK', suggested: 1, judged: 6, remaining: true }, add: [sets(clothes)[0]!] });
    await find(page).click();
    await expect(cards(page)).toHaveCount(1);
    await expect(section(page).getByRole('status')).toContainText(pluralText('en', 'outfitgen.found', 1));
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.more'));
    expect(api.outfitgenControl.runs).toHaveLength(1);
    const body = api.outfitgenControl.runs[0]!.body as Row;
    expect(Object.keys(body).sort()).toEqual(['language', 'mode', 'requestId']);
    expect(body).toMatchObject({ mode: 'manual', language: 'en' });
    api.outfitgenControl.replies.push({ status: 502, body: { code: 'FAILED' } });
    await find(page).click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.failed'));
    expect(api.outfitgenControl.runs).toHaveLength(2);
    api.outfitgenControl.replies.push({ status: 503, body: { code: 'BUSY' } });
    await find(page).click();
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.busy'));
  });

  test('runs once, automatically, when the app opens with something new and consent given', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true, autoUnassessed: 2 });
    api.outfitgenControl.replies.push({ status: 200, body: { code: 'OK', suggested: 1, judged: 3, remaining: false }, add: [sets(clothes)[1]!] });
    await expect.poll(() => api.outfitgenControl.statusReads).toBeGreaterThan(0);
    await page.clock.fastForward(5_000);
    await expect.poll(() => api.outfitgenControl.runs.length).toBe(1);
    expect(api.outfitgenControl.runs[0]!.body).toMatchObject({ mode: 'auto', language: 'en' });
    await expect(cards(page)).toHaveCount(1);
    await page.clock.fastForward(600_000);
    expect(api.outfitgenControl.runs).toHaveLength(1);
  });

  test('a failed automatic run is quiet and is not retried', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, autoUnassessed: 2 });
    api.outfitgenControl.replies.push({ status: 502, body: { code: 'FAILED' } });
    await expect.poll(() => api.outfitgenControl.statusReads).toBeGreaterThan(0);
    await page.clock.fastForward(5_000);
    await expect.poll(() => api.outfitgenControl.runs.length).toBe(1);
    await page.clock.fastForward(1_800_000);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    expect(api.outfitgenControl.runs).toHaveLength(1);
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    await expect(section(page).getByText(text('outfitgen.failed'), { exact: true })).toHaveCount(0);
  });

  test('shows the limit and keeps the manual button off when the monthly budget is used', async ({ page }) => {
    await start(page, { setup: { totalMicro: '17900000' }, consent: true });
    await expect(section(page).getByText(text('outfitgenC.limit'), { exact: true })).toBeVisible();
    await expect(find(page)).toBeDisabled();
  });

  test('passes axe and fits 320 px at 200% text', async ({ page }) => {
    await start(page, { setup: {}, consent: true, suggestions: true });
    await expect(cards(page)).toHaveCount(2);
    await axe(page);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const zoomed of [false, true]) {
      if (zoomed) await page.addStyleTag({ content: zoom });
      await noOverflow(page, 320);
      await cards(page).nth(1).scrollIntoViewIfNeeded();
      await axe(page);
    }
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#outfitgen-heading')).toBeVisible();
    await card(page).getByText(text('aiF.about'), { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe(page);
  });

  for (const language of ['fi', 'sv'] as const) {
    test(`reads naturally in ${language}`, async ({ page }) => {
      await start(page, { language, setup: {}, consent: true, suggestions: true });
      await expect(section(page).getByRole('heading', { level: 2 })).toHaveText(text('outfitgen.titleCount', language, { count: 2 }));
      await expect(find(page, language)).toBeVisible();
      await expect(cards(page).first().getByRole('button', { name: text('outfitgen.keepLabel', language, { title: 'Crisp navy' }), exact: true })).toBeVisible();
      await expect(cards(page).first()).toContainText(text('occasion.smart', language));
    });
  }
});
