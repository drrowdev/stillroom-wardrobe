import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { pluralText, translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, signIn, type OutfitGenSetup } from './mock-backend';
import { expectNoIdentity, expectSignedIn, signOutThroughMenu } from './shell-support';

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
type StartOptions = { language?: Language; missing?: boolean; setup?: Partial<OutfitGenSetup>; consent?: boolean; hash?: string; suggestions?: boolean; autoUnassessed?: number; many?: number };
/** `setup` left out means an account the feature is not set up for; `missing` is a backend without it; `{}` is configured and active. */
async function start(page: Page, options: StartOptions = {}) {
  const language = options.language ?? 'en';
  const api = await mockBackend(page, { initialLanguage: language });
  const clothes = seed(api);
  const control = api.outfitgenControl;
  control.missing = options.missing === true;
  if (options.setup) control.setup[owners.a] = { configured: true, activated: true, ...options.setup };
  if (options.consent) control.consent[owners.a] = OUTFITGEN_NOTICE_REVISION;
  if (options.suggestions) for (const entry of sets(clothes)) control.suggestions.push({ id: crypto.randomUUID(), owner: owners.a, state: 'suggested', ...entry });
  // Full-size rows (a 40-character title, a 160-character reason) so that a long list is also a long reply.
  for (let index = 0; index < (options.many ?? 0); index++) {
    const reason = 'Quiet colours that stay calm together. '.repeat(5).slice(0, 160).trim();
    control.suggestions.push({ id: crypto.randomUUID(), owner: owners.a, state: 'suggested', itemIds: sets(clothes)[index % 2]!.itemIds,
      title: `${String(index).padStart(3, '0')} ${'Navy day '.repeat(5)}`.slice(0, 40).trim(), reason, occasion: 'smart', score: 8 });
  }
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
    for (const key of ['outfitgenC.sent', 'outfitgenC.when', 'outfitgenC.pictures', 'outfitgenC.processing', 'aiC.azureTrainingNotice', 'outfitgenC.stored', 'outfitgenC.charges',
      'outfitgenC.optOut2'] as const) await expect(card(page)).toContainText(text(key));
    const bodies: unknown[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/rest/v1/rpc/outfitgen_set_consent') bodies.push(request.postDataJSON()); });
    await toggle(page, false).click();
    await expect(sheet(page)).toContainText(text('outfitgenC.sent'));
    expect(bodies).toEqual([]);
    await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(toggle(page, true)).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    expect(bodies).toEqual([{ p_enabled: true, p_notice_revision: OUTFITGEN_NOTICE_REVISION }]);
    expect(api.outfitgenControl.consent[owners.a]).toBe(OUTFITGEN_NOTICE_REVISION);
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
    await expect(cards(page).first()).toContainText(text('outfitgen.score', 'en', { score: 9 }));
    await expect(cards(page).nth(1)).toContainText(text('outfitgen.score', 'en', { score: 8 }));
    const help = section(page).locator('details.suggested-help');
    await expect(help.getByText(text('outfitgen.scoreHelp'), { exact: true })).toBeHidden();
    await help.getByText(text('outfitgen.scoreHelpSummary'), { exact: true }).click();
    await expect(help.getByText(text('outfitgen.scoreHelp'), { exact: true })).toBeVisible();
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

  test('Undo says plainly when the list is full and stays available', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, suggestions: true });
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    api.outfitgenControl.undoCodes.push('PENDING_FULL');
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.full'));
    await expect(cards(page)).toHaveCount(1);
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(cards(page)).toHaveCount(2);
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
    expect(api.outfitgenControl.runs).toHaveLength(1);
    const body = api.outfitgenControl.runs[0]!.body as Row;
    expect(Object.keys(body).sort()).toEqual(['language', 'mode', 'requestId']);
    expect(body).toMatchObject({ mode: 'manual', language: 'en' });
    // A failed call ends the press and is never repeated.
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
    await section(page).locator('details.suggested-help summary').click();
    await expect(section(page).getByText(text('outfitgen.scoreHelp'), { exact: true })).toBeVisible();
    await axe(page);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const zoomed of [false, true]) {
      if (zoomed) await page.addStyleTag({ content: zoom });
      await noOverflow(page, 320);
      await section(page).locator('details.suggested-help p').scrollIntoViewIfNeeded();
      expect(await section(page).locator('details.suggested-help p').evaluate((node) => node.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
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
      await expect(cards(page).first()).toContainText(text('outfitgen.score', language, { score: 9 }));
      await expect(section(page).getByText(text('outfitgen.scoreHelpSummary', language), { exact: true })).toBeVisible();
    });
  }
  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`the score help opens and closes from the keyboard and fits 320 px at 200% text (${language})`, async ({ page }) => {
      await start(page, { language, setup: {}, consent: true, suggestions: true });
      await expect(cards(page)).toHaveCount(2);
      await page.setViewportSize({ width: 320, height: 900 });
      await page.addStyleTag({ content: zoom });
      const summary = section(page).locator('details.suggested-help summary');
      const help = section(page).locator('details.suggested-help p');
      await expect(summary).toHaveText(text('outfitgen.scoreHelpSummary', language));
      await expect(help).toBeHidden();
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(help).toBeVisible();
      await expect(help).toHaveText(text('outfitgen.scoreHelp', language));
      expect(await help.evaluate((node) => node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await axe(page);
      await page.keyboard.press('Space');
      await expect(help).toBeHidden();
    });
  }
});

/** A reply that waits until the test lets it go, so the state in between can be looked at. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const ok = (suggested: number, judged: number, remaining: boolean) => ({ status: 200, body: { code: 'OK', suggested, judged, remaining } });
const progressLine = (language: Language, left: number, found: number) => text('outfitgen.passProgress', language, {
  left: pluralText(language, 'outfitgen.passLeft', left), found: pluralText(language, 'outfitgen.passFound', found) });
const stoppedLine = (left: number) => pluralText('en', 'outfitgen.passStopped', left);
const button = (page: Page) => section(page).locator('#suggested-find');
const stopLabel = (language: Language = 'en') => text('outfitgen.passStop', language);
const setVisibility = (page: Page, value: 'hidden' | 'visible') => page.evaluate((state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}, value);
/** Lets a minute of page time and real time pass: a pass that was meant to end has sent nothing since, and its later replies are untouched. */
async function expectNothingLater(page: Page, control: Api['outfitgenControl'], posts: number, unused: number) {
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(control.runs).toHaveLength(posts);
  expect(control.replies).toHaveLength(unused);
}

test.describe('OUTFITGEN3 one press works through the unchecked garments', () => {
  test('calls one at a time with progress, shows what it found at once, keeps focus on the one button, and ends with one result', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push(
      { ...ok(1, 5, true), add: [sets(clothes)[0]!], unassessed: 4 },
      { ...ok(0, 4, true), unassessed: 2, hold: held.promise },
      { ...ok(1, 3, false), add: [sets(clothes)[1]!], unassessed: 0 });
    await find(page).click();
    await expect(section(page).locator('.suggested-pass')).toHaveText(progressLine('en', 4, 1));
    await expect(button(page)).toHaveText(stopLabel());
    await expect(button(page)).toBeFocused();
    await expect(cards(page)).toHaveCount(1);
    expect(control.runs).toHaveLength(2);
    // The progress is plain text outside every live region; the one status region carries only the start and the result.
    expect(await section(page).locator('.suggested-pass').evaluate((node) => node.closest('[aria-live], [role="status"], [role="alert"]') === null)).toBe(true);
    await expect(section(page).locator('[role="status"]')).toHaveCount(1);
    await expect(section(page).getByRole('status')).toHaveText(text('outfitgen.finding'));
    held.release();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passAll'));
    await expect(section(page).getByRole('status')).toContainText(pluralText('en', 'outfitgen.found', 2));
    await expect(cards(page)).toHaveCount(2);
    await expect(section(page).locator('.suggested-pass')).toHaveCount(0);
    await expect(button(page)).toHaveText(text('outfitgen.find'));
    await expect(button(page)).toBeFocused();
    expect(control.runs).toHaveLength(3);
    const ids = control.runs.map((run) => (run.body as Row).requestId);
    expect(new Set(ids).size).toBe(3);
    expect(control.runs.every((run) => (run.body as Row).mode === 'manual')).toBe(true);
  });

  test('Stop lets the check in flight finish, sends nothing more, and the next press continues', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    await button(page).click();
    await expect(button(page)).toHaveText(text('outfitgen.passStopping'));
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page)).toBeFocused();
    held.release();
    await expect(section(page).getByRole('status')).toContainText(stoppedLine(5));
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passContinue'));
    await expect(button(page)).toHaveText(text('outfitgen.find'));
    await expect(button(page)).toBeFocused();
    await expectNothingLater(page, control, 1, 1);
    // The next press picks up where this one stopped.
    control.replies.push({ ...ok(0, 2, false), unassessed: 0 });
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passAll'));
    expect(control.runs).toHaveLength(3);
  });

  const stops: [string, { status: number; body: unknown }, MessageKey][] = [
    ['the list is full', { status: 409, body: { code: 'PENDING_FULL' } }, 'outfitgen.full'],
    ['another check is running (for example a picture holding the same owner lock)', { status: 503, body: { code: 'BUSY' } }, 'outfitgen.busy'],
    ['the server limits the calls', { status: 429, body: { code: 'RATE_LIMIT' } }, 'outfitgen.rateLimit'],
    ['the monthly budget is used', { status: 429, body: { code: 'ALLOWANCE' } }, 'outfitgenC.limit'],
    ['the spending guard has paused', { status: 403, body: { code: 'PAUSED' } }, 'aiGuard.paused'],
  ];
  for (const [name, reply, key] of stops) {
    test(`stops with its own line, and no further call, when ${name}`, async ({ page }) => {
      const { api } = await start(page, { setup: {}, consent: true });
      api.outfitgenControl.unassessed = 6;
      api.outfitgenControl.replies.push({ ...ok(0, 4, true), unassessed: 4 }, reply, { ...ok(0, 4, true), unassessed: 2 });
      await find(page).click();
      await expect(section(page).getByRole('status')).toContainText(text(key));
      await expect(section(page).getByRole('status')).toContainText(stoppedLine(4));
      await expect(find(page)).toBeVisible();
      await expectNothingLater(page, api.outfitgenControl, 2, 1);
    });
  }
  test('the spending guard\'s own notice carries a link to Settings', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    api.outfitgenControl.unassessed = 6;
    api.outfitgenControl.replies.push({ status: 403, body: { code: 'PAUSED' } });
    await find(page).click();
    await expect(section(page).getByRole('status').getByRole('link', { name: text('aiGuard.settingsLink') })).toHaveAttribute('href', '#/settings');
  });

  test('a failed call stops at once, is not repeated, and what the server holds is read again', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    control.replies.push({ status: 502, body: { code: 'FAILED' } }, { ...ok(0, 4, true), unassessed: 3 });
    const reads = control.listReads;
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.failed'));
    await expectNothingLater(page, control, 1, 1);
    expect(control.listReads).toBeGreaterThan(reads);
  });

  test('stops before the next call when consent is turned off meanwhile', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    control.consent[owners.a] = null;
    held.release();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.off'));
    await expectNothingLater(page, control, 1, 1);
  });

  test('another window or device already making a call: nothing is sent', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    api.outfitgenControl.unassessed = 6;
    api.outfitgenControl.live = true;
    api.outfitgenControl.replies.push({ ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.busy'));
    await expectNothingLater(page, api.outfitgenControl, 0, 1);
  });

  test('signing out mid-run sends nothing more and leaves nothing behind for the next owner', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(1, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    await signOutThroughMenu(page);
    await expectNoIdentity(page);
    held.release();
    await expectNothingLater(page, control, 1, 1);
    await signIn(page);
    await expectSignedIn(page);
    await expect(section(page).locator('.suggested-pass')).toHaveCount(0);
    await expect(find(page)).toBeEnabled();
    await expectNothingLater(page, control, 1, 1);
  });

  for (const how of ['hidden', 'pagehide'] as const) {
    test(`a page that went away (${how}) during a call ends the pass for good, even when it comes back`, async ({ page }) => {
      const { api } = await start(page, { setup: {}, consent: true });
      const control = api.outfitgenControl;
      control.unassessed = 6;
      const held = gate();
      control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
      await find(page).click();
      await expect(button(page)).toHaveText(stopLabel());
      if (how === 'hidden') await setVisibility(page, 'hidden'); else await page.evaluate(() => dispatchEvent(new Event('pagehide')));
      await setVisibility(page, 'visible');
      await page.evaluate(() => dispatchEvent(new Event('pageshow')));
      held.release();
      await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passContinue'));
      await expectNothingLater(page, control, 1, 1);
      await page.evaluate(() => dispatchEvent(new Event('focus')));
      await expectNothingLater(page, control, 1, 1);
    });
  }

  test('leaving the screen pauses the pass, and coming back shows where it stopped without restarting it', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    await page.evaluate(() => { location.hash = '#/today'; });
    await expect(section(page)).toHaveCount(0);
    held.release();
    await page.waitForTimeout(300);
    await page.evaluate(() => { location.hash = '#/outfits'; });
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passContinue'));
    await expectNothingLater(page, control, 1, 1);
  });

  test('keeps focus on the one button when the pass ends because the budget is used up or the network is gone', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    control.setup[owners.a] = { ...control.setup[owners.a], totalMicro: '17900000' };
    held.release();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgenC.limit'));
    await expect(button(page)).toHaveText(text('outfitgen.find'));
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page)).toBeFocused();
    await expectNothingLater(page, control, 1, 1);
    // Nothing happens when the marked button is pressed.
    await button(page).dispatchEvent('click');
    await expectNothingLater(page, control, 1, 1);
  });

  test('keeps focus on the one button when the network goes while the last call is in flight', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    const control = api.outfitgenControl;
    control.unassessed = 6;
    const held = gate();
    control.replies.push({ ...ok(0, 4, true), unassessed: 5, hold: held.promise }, { ...ok(0, 4, true), unassessed: 3 });
    await find(page).click();
    await expect(button(page)).toHaveText(stopLabel());
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); dispatchEvent(new Event('offline')); });
    held.release();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passContinue'));
    await expect(button(page)).toHaveText(text('outfitgen.find'));
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page)).toBeFocused();
    await expectNothingLater(page, control, 1, 1);
  });

  test('pressing twice quickly makes one pass', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    api.outfitgenControl.unassessed = 0;
    api.outfitgenControl.replies.push(ok(0, 2, false));
    await button(page).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.nothingNew'));
    await expectNothingLater(page, api.outfitgenControl, 1, 0);
  });

  test('with nothing unchecked a press makes one call, whatever the reply says', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true });
    api.outfitgenControl.unassessed = 0;
    api.outfitgenControl.replies.push(ok(0, 2, true), ok(0, 2, true));
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.nothingNew'));
    await expectNothingLater(page, api.outfitgenControl, 1, 1);
  });

  test('fits 320 px at 200% text and passes axe while it runs', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, suggestions: true });
    api.outfitgenControl.unassessed = 6;
    api.outfitgenControl.replies.push({ ...ok(0, 4, true), unassessed: 4, hold: gate().promise });
    await page.setViewportSize({ width: 320, height: 900 });
    await find(page).click();
    await expect(section(page).locator('.suggested-pass')).toHaveText(progressLine('en', 6, 0));
    for (const zoomed of [false, true]) {
      if (zoomed) await page.addStyleTag({ content: zoom });
      await noOverflow(page, 320);
      await axe(page);
    }
  });

  for (const language of ['fi', 'sv'] as const) {
    test(`shows progress and Stop in ${language}`, async ({ page }) => {
      const { api } = await start(page, { language, setup: {}, consent: true });
      api.outfitgenControl.unassessed = 6;
      api.outfitgenControl.replies.push({ ...ok(0, 4, true), unassessed: 4, hold: gate().promise });
      await find(page, language).click();
      await expect(section(page).locator('.suggested-pass')).toHaveText(progressLine(language, 6, 0));
      await expect(button(page)).toHaveText(stopLabel(language));
    });
  }
});

// OUTFITGEN-PENDING100: the waiting list holds 100 suggestions.
test.describe('OUTFITGEN-PENDING100 the waiting list of 100', () => {
  test('lists 100 suggestions from a reply far above 32 KB, and fits 320 px at 200% text', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, many: 100 });
    const reply = JSON.stringify(api.outfitgenControl.suggestions.map((entry) => ({ id: entry.id, itemIds: entry.itemIds, title: entry.title, reason: entry.reason,
      occasion: entry.occasion, score: entry.score, createdAt: '2026-11-06T10:00:00Z' })));
    expect(reply.length).toBeGreaterThan(32_768);
    await expect(section(page).getByRole('heading', { level: 2 })).toHaveText(text('outfitgen.titleCount', 'en', { count: 100 }));
    await expect(cards(page)).toHaveCount(100);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const zoomed of [false, true]) {
      if (zoomed) await page.addStyleTag({ content: zoom });
      await noOverflow(page, 320);
      await cards(page).nth(99).scrollIntoViewIfNeeded();
      await axe(page);
    }
  });

  test('a press with 100 waiting suggestions sends nothing and says the list is full', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, many: 100 });
    api.outfitgenControl.unassessed = 6;
    await expect(cards(page)).toHaveCount(100);
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.full'));
    await expectNothingLater(page, api.outfitgenControl, 0, 0);
  });

  test('a press with 99 waiting suggestions still checks, and the list then holds 100', async ({ page }) => {
    const { api, clothes } = await start(page, { setup: {}, consent: true, many: 99 });
    api.outfitgenControl.unassessed = 2;
    api.outfitgenControl.replies.push({ ...ok(1, 2, false), add: [sets(clothes)[0]!], unassessed: 0 });
    await expect(cards(page)).toHaveCount(99);
    await find(page).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.passAll'));
    await expect(cards(page)).toHaveCount(100);
    expect(api.outfitgenControl.runs).toHaveLength(1);
  });

  test('Undo at 100 says the list is full, and works again once there is room', async ({ page }) => {
    const { api } = await start(page, { setup: {}, consent: true, many: 100 });
    await expect(cards(page)).toHaveCount(100);
    const title = api.outfitgenControl.suggestions[0]!.title as string;
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title }), exact: true }).click();
    await expect(cards(page)).toHaveCount(99);
    api.outfitgenControl.undoCodes.push('PENDING_FULL');
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText(text('outfitgen.full'));
    await expect(cards(page)).toHaveCount(99);
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(cards(page)).toHaveCount(100);
  });
});
