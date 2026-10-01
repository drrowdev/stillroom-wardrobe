import { expect, test, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, signIn } from './mock-backend';
import { expectIdentity, expectNoIdentity, signOutThroughMenu } from './shell-support';
import { closeDataTask, dataRow, heldExits, openDataTask, settingsBack, settingsFromWardrobe, taskHeading, tryExitWhileHeld } from './data-task-support';

type Reply = { status: number; json: Record<string, unknown> };
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string>) => translate(language, key, parameters);
const card = (page: Page) => page.locator('.delete-card');
const button = (page: Page, key: MessageKey, language: Language = 'en') =>
  card(page).getByRole('button', { name: text(key, language), exact: true });
const functionUrl = 'http://127.0.0.1:54321/functions/v1/delete-account';
const secret = 'fictional delete password';
const authKeys = (page: Page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
  .filter((key) => /auth|token|sb-/i.test(key)));
const isAuthRequest = (url: string) => url.startsWith('http://127.0.0.1:54321/auth/v1/');
function trackAuth(page: Page) {
  const pending = new Set<unknown>();
  page.on('request', (request) => { if (isAuthRequest(request.url())) pending.add(request); });
  const done = (request: Request) => { pending.delete(request); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return () => pending.size;
}
/** After sign-out: no auth request left in flight, storage empty and still empty, and a reload restores nothing. */
async function expectNoSessionLeft(page: Page, pendingAuth: () => number) {
  await expect.poll(async () => ({ pending: pendingAuth(), keys: await authKeys(page) })).toEqual({ pending: 0, keys: [] });
  expect(await authKeys(page)).toEqual([]);
  // A restored session would send its token again, even where the app then signs out on its own.
  const reused: string[] = [];
  const watch = (request: Request) => { if ((request.headers().authorization ?? '').endsWith('.browser-fixture')) reused.push(request.url()); };
  page.on('request', watch);
  await page.reload();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#settings-title, #deletion-recovery-title')).toHaveCount(0);
  await expect.poll(pendingAuth).toBe(0);
  page.off('request', watch);
  expect(reused).toEqual([]);
  expect(await authKeys(page)).toEqual([]);
}

async function start(page: Page, replies: Reply[], language: Language = 'en', frozen?: 'retry' | 'in_progress' | 'contact') {
  await mockBackend(page, { initialLanguage: language });
  const auth = trackAuth(page);
  const bodies: string[] = [];
  const status = { value: frozen ?? 'none' };
  if (frozen) {
    // A frozen account: normal profile access is refused, only its own deletion status is readable.
    await page.route(/\/rest\/v1\/profiles(\?|$)/, route => route.fulfill({ status: 403, json: { code: '42501', message: 'permission denied' } }));
    await page.route('http://127.0.0.1:54321/rest/v1/rpc/deletion_status', route => route.fulfill({ status: 200, json: { state: status.value } }));
  }
  await page.route(functionUrl, async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    bodies.push(route.request().postData() ?? '');
    const reply = replies.shift() ?? { status: 500, json: { code: 'INTERNAL' } };
    if (typeof reply.json.state === 'string') status.value = reply.json.state;
    await route.fulfill({ status: reply.status, json: reply.json, headers: { 'content-type': 'application/json' } });
  });
  await page.goto('/#/settings'); await signIn(page);
  if (!frozen) await expect(page.locator('#settings-title')).toBeVisible();
  else {
    // The profile, and so its language, is unreadable; the entry screen's language choice still applies.
    await expect(page.locator('#deletion-recovery-title')).toBeFocused();
    await page.locator(`.language-selector button[lang="${language}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
  }
  return { bodies, status, auth };
}
// Account deletion opens as a task view from the Data and privacy rows, with its form shown and the heading focused.
async function openForm(page: Page, language: Language = 'en') {
  await openDataTask(page, 'delete');
  await expect(taskHeading(page, 'delete')).toHaveText(text('delete.title', language));
  await expect(card(page).getByLabel(text('delete.password', language), { exact: true })).toBeVisible();
}
async function fill(page: Page, language: Language = 'en', password = secret) {
  await card(page).getByLabel(text('delete.password', language), { exact: true }).fill(password);
  await card(page).getByLabel(text('delete.confirm', language), { exact: true }).check();
  await card(page).getByLabel(text('delete.phraseLabel', language, { phrase: text('delete.phraseValue', language) }), { exact: true })
    .fill(text('delete.phraseValue', language));
}
const phraseField = (page: Page, language: Language = 'en') =>
  card(page).getByLabel(text('delete.phraseLabel', language, { phrase: text('delete.phraseValue', language) }), { exact: true });

test('I22 the delete action needs the password, the confirmation and the typed phrase, and sends only the password', async ({ page }) => {
  const { bodies } = await start(page, [{ status: 403, json: { code: 'PASSWORD' } }]);
  await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveCount(0);
  await openForm(page);
  const submit = button(page, 'delete.button');
  await expect(submit).toBeDisabled();
  await card(page).getByLabel(text('delete.password'), { exact: true }).fill(secret);
  await expect(submit).toBeDisabled();
  await card(page).getByLabel(text('delete.confirm'), { exact: true }).check();
  await expect(submit).toBeDisabled();
  await phraseField(page).fill('delete account');
  await expect(submit).toBeDisabled();
  await phraseField(page).fill('  Delete My Account ');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(card(page).getByRole('alert')).toHaveText(text('delete.wrongPassword'));
  await expect(card(page).getByRole('alert')).toBeFocused();
  await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveValue('');
  expect(bodies).toEqual([JSON.stringify({ password: secret })]);
  await expect(card(page).locator('.button-danger')).toHaveCount(1);
  await expect(card(page).locator('button')).toHaveText([text('delete.backupFirst'), text('delete.button')]);
  await closeDataTask(page, 'delete');
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('#settings-title')).toBeVisible();
});

for (const language of ['en', 'fi', 'sv'] as const) test(`I22 the typed phrase is in the chosen language (${language})`, async ({ page }) => {
  await start(page, [], language);
  await openForm(page, language);
  await card(page).getByLabel(text('delete.password', language), { exact: true }).fill(secret);
  await card(page).getByLabel(text('delete.confirm', language), { exact: true }).check();
  const submit = button(page, 'delete.button', language);
  const other = language === 'en' ? 'fi' : 'en';
  await phraseField(page, language).fill(text('delete.phraseValue', other));
  await expect(submit).toBeDisabled();
  await phraseField(page, language).fill(text('delete.phraseValue', language));
  await expect(submit).toBeEnabled();
  await closeDataTask(page, 'delete');
  await openForm(page, language);
  await expect(phraseField(page, language)).toHaveValue('');
  await expect(card(page).getByLabel(text('delete.password', language), { exact: true })).toHaveValue('');
  await expect(card(page).getByLabel(text('delete.confirm', language), { exact: true })).not.toBeChecked();
  await expect(submit).toBeDisabled();
});

test('I22 unfinished deletion replies explain what to do next', async ({ page }) => {
  await start(page, [
    { status: 503, json: { state: 'retry' } },
    { status: 202, json: { state: 'in_progress' } },
    { status: 200, json: { unexpected: true } },
    { status: 409, json: { state: 'contact' } },
  ]);
  await openForm(page);
  for (const key of ['delete.retry', 'delete.inProgress', 'delete.failed', 'delete.contact'] as const) {
    await fill(page);
    await button(page, 'delete.button').click();
    await expect(card(page).getByRole('alert')).toHaveText(text(key));
    await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveValue('');
  }
  await card(page).getByLabel(text('delete.password'), { exact: true }).fill(secret);
  await expect(button(page, 'delete.button')).toBeDisabled();
  await expect(page.locator('#settings-title')).toBeVisible();
});

test('I22 a finished deletion signs out, says so and leaves no session behind', async ({ page }) => {
  const { auth } = await start(page, [{ status: 200, json: { state: 'complete' } }], 'fi');
  await openForm(page, 'fi');
  await fill(page, 'fi');
  await button(page, 'delete.button', 'fi').click();
  await expect(page.locator('#email')).toBeVisible();
  // Signing out drops the account's language, so the sign-in screen uses the browser language.
  await expect(page.getByRole('status').filter({ hasText: text('delete.done') })).toBeVisible();
  await expectNoSessionLeft(page, auth);
});

const recovery = (page: Page) => page.locator('section[aria-labelledby="deletion-recovery-title"]');
test('I22 a frozen account signs in to the recovery screen, retries and finishes', async ({ page }) => {
  const { bodies, auth } = await start(page, [{ status: 503, json: { state: 'retry' } }, { status: 200, json: { state: 'complete' } }], 'en', 'retry');
  await expect(page.locator('#settings-title')).toHaveCount(0);
  await expectNoIdentity(page);
  const finish = recovery(page).getByRole('button', { name: text('delete.finish'), exact: true });
  await expect(finish).toBeDisabled();
  const field = recovery(page).getByLabel(text('delete.password'), { exact: true });
  await field.fill(secret);
  await finish.click();
  await expect(recovery(page).getByRole('alert')).toHaveText(text('delete.retry'));
  await expect(field).toHaveValue('');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await field.fill(secret);
  // Hold the local sign-out's logout request until the signed-out screen shows, then release it.
  let release = () => {};
  let received = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const arrived = new Promise<void>((resolve) => { received = resolve; });
  await page.route('http://127.0.0.1:54321/auth/v1/logout**', async (route) => { received(); await held; await route.fallback(); });
  await finish.click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: text('delete.done') })).toBeVisible();
  await arrived;
  // The logout request is still held: the credentials must already be gone.
  expect(await authKeys(page)).toEqual([]);
  release();
  expect(bodies).toEqual([JSON.stringify({ password: secret }), JSON.stringify({ password: secret })]);
  await expectNoSessionLeft(page, auth);
});

test('I22 a frozen account past its retry budget is told to contact the operator and can sign out', async ({ page }) => {
  await start(page, [], 'sv', 'contact');
  await expect(recovery(page).getByRole('status')).toHaveText(text('delete.contact', 'sv'));
  await expect(recovery(page).getByRole('button', { name: text('delete.finish', 'sv'), exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await recovery(page).getByRole('button', { name: text('auth.signOut', 'sv'), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
});

test('UX5 make a backup first opens the backup view and clears the deletion form', async ({ page }) => {
  await start(page, []);
  await openForm(page);
  await fill(page);
  await button(page, 'delete.backupFirst').click();
  await expect(taskHeading(page, 'backup')).toBeFocused();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('#delete-password, #delete-phrase')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveCount(1);
  await settingsBack(page).click();
  await expect(dataRow(page, 'delete')).toBeFocused();
  await openForm(page);
  await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveValue('');
  await expect(card(page).getByLabel(text('delete.confirm'), { exact: true })).not.toBeChecked();
  await expect(phraseField(page)).toHaveValue('');
});

async function holdDeletion(page: Page) {
  const held = { route: undefined as Route | undefined, sent: 0 };
  await page.route(functionUrl, async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    held.sent++;
    if (!held.route) held.route = route; else await route.fallback();
  });
  await fill(page);
  await button(page, 'delete.button').click();
  await expect.poll(() => Boolean(held.route)).toBe(true);
  await expect(card(page).getByRole('status')).toHaveText(text('delete.working'));
  return held;
}

for (const exit of heldExits) {
  test(`UX5 while a deletion runs, ${exit} waits; after a lost reply it is followed with nothing sent again`, async ({ page }) => {
    const { bodies } = await start(page, []);
    await settingsFromWardrobe(page);
    await openForm(page);
    const held = await holdDeletion(page);
    await expect(button(page, 'delete.backupFirst')).toBeDisabled();
    const followed = await tryExitWhileHeld(page, 'delete', exit);
    expect(held.sent).toBe(1);
    await held.route!.abort('connectionreset');
    await followed();
    expect([held.sent, bodies.length]).toEqual([1, 0]);
    // Returning shows a cleared form.
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#settings-title')).toBeVisible();
    await openForm(page);
    await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveValue('');
    expect(held.sent).toBe(1);
  });
}

test('UX5 signing out while a deletion runs cancels the wait; the next account starts with an empty form', async ({ page }) => {
  await start(page, []);
  await openForm(page);
  const held = await holdDeletion(page);
  await signOutThroughMenu(page);
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#delete-password, #delete-phrase')).toHaveCount(0);
  await held.route!.abort('connectionreset').catch(() => undefined);
  await signIn(page, 'b');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await dataRow(page, 'delete').click();
  await expect(card(page).locator('[role=alert], [role=status]:not(:empty)')).toHaveCount(0);
  await expect(page.locator('#delete-password')).toHaveValue('');
  await expect(page.locator('#delete-phrase')).toHaveValue('');
  await expect(settingsBack(page)).toBeEnabled();
  expect(held.sent).toBe(1);
});

test('UX5 a lost deletion reply keeps its message and the form in the view, with nothing sent again', async ({ page }) => {
  await start(page, []);
  await openForm(page);
  let sent = 0;
  await page.route(functionUrl, async route => { if (route.request().method() === 'POST') { sent++; await route.abort('connectionreset'); } else await route.fallback(); });
  await fill(page);
  await button(page, 'delete.button').click();
  await expect(card(page).getByRole('alert')).toHaveText(text('delete.failed'));
  await expect(card(page).getByRole('alert')).toBeFocused();
  await expect(settingsBack(page)).toBeEnabled();
  await expect(card(page).getByLabel(text('delete.password'), { exact: true })).toHaveValue('');
  expect(sent).toBe(1);
});

test('I22 accessibility: axe, 320px and 200% text for the delete card', async ({ page }) => {
  await start(page, [{ status: 503, json: { state: 'retry' } }]);
  const axe = async () => expect((await new AxeBuilder({ page }).include('.delete-card').analyze()).violations).toEqual([]);
  await openForm(page);
  await axe();
  await fill(page);
  await button(page, 'delete.button').click();
  await expect(card(page).getByRole('alert')).toBeFocused();
  await axe();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const zoom of [false, true]) {
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe();
  }
});

test.describe('bounded P6c visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'delete-account', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'delete-account', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' },
    { scene: 'delete-recovery', project: 'chromium', language: 'sv', width: 1280, suffix: 'sv-desktop' },
    { scene: 'delete-recovery', project: 'mobile', language: 'en', width: 320, suffix: 'en-mobile' },
  ] as const;
  for (const selected of scenes) test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
    const language: Language = selected.language;
    const write = testInfo.project.name === selected.project;
    const directory = path.resolve('test-results/p6c-visual');
    if (write) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    }
    await page.setViewportSize({ width: selected.width, height: 900 });
    const recovering = selected.scene === 'delete-recovery';
    await start(page, [{ status: 503, json: { state: 'retry' } }], language, recovering ? 'retry' : undefined);
    if (recovering) {
      await recovery(page).getByLabel(text('delete.password', language), { exact: true }).fill(secret);
      await recovery(page).getByRole('button', { name: text('delete.finish', language), exact: true }).click();
      await expect(recovery(page).getByRole('alert')).toHaveText(text('delete.retry', language));
    } else if (selected.suffix === 'fi-mobile') {
      await openForm(page, language);
      await fill(page, language);
      await button(page, 'delete.button', language).click();
      await expect(card(page).getByRole('alert')).toHaveText(text('delete.retry', language));
    } else {
      await openForm(page, language);
      await expect(button(page, 'delete.button', language)).toBeDisabled();
    }
    if (!recovering) await card(page).scrollIntoViewIfNeeded();
    expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
    if (recovering) await expectNoIdentity(page);
    else await expectIdentity(page, 'Alex');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ expectedLanguage, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      const visible = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
        .filter((field) => field.getClientRects().length);
      const fields = visible.map((field) => field.value).join('\n');
      const passwords = visible.filter((field) => field.type === 'password');
      return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === 900
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('#email,#password')
        && passwords.every((field) => field.value === '' && field.closest('.delete-card,[aria-labelledby="deletion-recovery-title"]'))
        && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
    }, { expectedLanguage: language, width: selected.width })).toBe(true);
    if (!write) return;
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  });
});
