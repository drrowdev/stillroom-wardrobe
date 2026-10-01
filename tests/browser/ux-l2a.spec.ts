import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { languages, locales, messages, translate, type Language, type MessageKey } from '../../src/i18n';
import { azureAiReviewExpires } from '../../src/domain/ai-controls';
import { aiFixture, editItem } from './ai-photo-first-support';
import { owners } from './mock-backend';
import { utcPeriod } from '../../src/features/settings/ai-features-model';

type StatusPatch = { code?: string; consent?: { enabled?: boolean; noticeRevision?: number | null };
  policy?: Record<string, unknown>; usage?: { accountedMicro?: string; warning?: boolean }; serverTimeMs?: number;
  fail?: number; hold?: Promise<void> };
const text = (key: MessageKey, language: Language = 'en') => messages[key][language];
const card = (page: Page) => page.locator('section[aria-labelledby="ai-consent-title"]');
const cardButton = (page: Page, key: MessageKey, language: Language = 'en') => card(page).getByRole('button', { name: text(key, language), exact: true });
// UI1: the row's switch shows the server state; an unchecked switch opens the consent sheet, whose Turn on writes.
const toggle = (page: Page) => card(page).getByRole('switch');
const state = (page: Page, on: boolean) => card(page).locator(`[role="switch"][aria-checked="${on}"]`);
const sheet = (page: Page) => page.locator('dialog[aria-labelledby="ai-consent-sheet-title"]');
async function turnOn(page: Page, language: Language = 'en') {
  await toggle(page).click();
  await sheet(page).getByRole('button', { name: text('aiC.enable', language), exact: true }).click();
}
const spent = (page: Page) => page.locator('.ai-spend-figure');
const allowance = '20000000';
function money(language: Language, cents: number, limit = false) {
  const whole = limit && cents % 100 === 0;
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
}
/** A patched reply's time and period, both from one timestamp: an explicit time, or a minute after `now`. */
function statusStamp(now: number, serverTimeMs?: number) {
  const at = serverTimeMs ?? now + 60000;
  return { serverTimeMs: at, period: new Date(at).toISOString().slice(0, 7) };
}
test('L2a a patched reply\'s period matches its time across a month boundary', () => {
  const lastMinute = Date.UTC(2026, 8, 30, 23, 59, 30);
  for (const stamp of [statusStamp(lastMinute), statusStamp(lastMinute, lastMinute), statusStamp(Date.UTC(2026, 9, 1, 0, 0, 5), lastMinute)]) {
    expect(stamp.period).toBe(utcPeriod(stamp.serverTimeMs));
  }
  expect(statusStamp(lastMinute)).toEqual({ serverTimeMs: lastMinute + 60000, period: '2026-10' });
  expect(statusStamp(Date.UTC(2026, 9, 1, 0, 0, 5), lastMinute).period).toBe('2026-09');
});
async function start(page: Page, language: Language = 'en', enabled = false) {
  const api = await aiFixture(page, language, enabled);
  api.policy({ monthlyAllowanceMicro: allowance });
  let patch: StatusPatch | null = null;
  // A later route takes precedence; without a patch the fixture's own status reply is used unchanged. A patched reply is
  // dated a minute ahead: the mock's other feature statuses keep their own fixed allowance, and the shared spending summary
  // shows the newest reply, so this keeps it on the analysis figures these tests change, as one real backend policy would.
  await page.route(/\/rest\/v1\/rpc\/ai_status$/, async (route) => {
    const current = patch, request = route.request();
    if (request.method() === 'OPTIONS' || !current) { await route.fallback(); return; }
    if (current.hold) await current.hold;
    if (current.fail) { await route.fulfill({ status: current.fail, json: { message: 'Unavailable' } }); return; }
    if (!api.admitAiStatus(request)) { await route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } }); return; }
    const stored = api.consent.get(owners.a)!, enabledNow = current.consent?.enabled ?? stored;
    const revision = current.consent && 'noticeRevision' in current.consent ? current.consent.noticeRevision : enabledNow ? 2 : null;
    await route.fulfill({ json: {
      code: current.code ?? (enabledNow && revision === 2 ? 'OK' : 'CONSENT_REQUIRED'),
      ...statusStamp(Date.now(), current.serverTimeMs),
      consent: { enabled: enabledNow, noticeRevision: revision, consentedAt: enabledNow ? '2026-09-12T00:00:00Z' : null,
        profileVersion: String(api.profiles[owners.a]!.version) },
      policy: { activated: true, noticeRevision: 2, modelId: 'gpt-5.6-terra-2026-07-09', promptVersion: 1,
        executionManifestId: 'azure-eu-terra-devtest-v1', maxRequestMicro: '4097351', monthlyAllowanceMicro: allowance,
        maxRequestsPerHour: 200, resultTtlSeconds: 3600, ...current.policy },
      usage: { accountedMicro: '0', requestsLastHour: 0, warning: false, ...current.usage } } });
  });
  const log: Array<{ method: string; path: string; body: unknown }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:54321' || request.method() === 'OPTIONS') return;
    let body: unknown = null;
    try { body = request.postDataJSON(); } catch { /* not JSON */ }
    log.push({ method: request.method(), path: url.pathname, body });
  });
  const traffic = {
    status: () => log.filter((entry) => entry.path === '/rest/v1/rpc/ai_status').length,
    consent: () => log.filter((entry) => entry.path === '/rest/v1/rpc/ai_set_consent'),
    writes: () => log.filter((entry) => !['GET', 'HEAD'].includes(entry.method) && entry.path.startsWith('/rest/v1/')
      && !['/rest/v1/rpc/ai_status', '/rest/v1/rpc/stylist_status', '/rest/v1/rpc/enhance_status', '/rest/v1/rpc/admin_status', '/rest/v1/rpc/tryon_status'].includes(entry.path)).length,
    analysis: () => log.filter((entry) => entry.path.startsWith('/functions/v1/')).length,
  };
  return { api, traffic, setStatus: (next: StatusPatch | null) => { patch = next; } };
}
async function openSettings(page: Page, language: Language = 'en') {
  await page.getByRole('button', { name: text('account.menu', language) }).click();
  await page.getByRole('link', { name: text('nav.settings', language), exact: true }).click();
  await expect(page.locator('#settings-title')).toBeVisible();
  // The screen moves focus to its title in an effect after it appears (50-150 ms later in WebKit). Typing before that
  // could land in the field and then lose focus to the title, so wait for the screen to finish arriving.
  await expect(page.locator('#settings-title')).toBeFocused();
}
async function reread(page: Page, ready: () => Promise<void>) {
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await ready();
  }).toPass({ timeout: 10000 });
}
const offSummary = (language: Language, limit = money(language, 2000, true)) => translate(language, 'aiC.offSummary', { limit });
const usage = (language: Language, used: number, limit = money(language, 2000, true)) =>
  translate(language, 'aiF.spent', { used: money(language, used), limit });
const technical = [/gpt-/i, /micro-?usd/i, /\d{5,}/, /revision/i, /Accounted/i, /\bUSD\b/];

for (const language of languages) {
  test(`L2a off ${language}: one unchecked switch, short description, closed details and no technical copy`, async ({ page }) => {
    const { traffic } = await start(page, language);
    await openSettings(page, language);
    await expect(state(page, false)).toBeVisible();
    await expect(toggle(page)).toHaveCount(1);
    await expect(card(page).getByText(text('aiC.description', language), { exact: true })).toBeVisible();
    await expect(card(page).getByText(offSummary(language), { exact: true })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: text('aiC.enable', language), exact: true })).toHaveCount(0);
    await expect(cardButton(page, 'aiC.disable', language)).toHaveCount(0);
    await expect(card(page).getByRole('checkbox')).toHaveCount(0);
    await expect(card(page).locator('details')).toHaveCount(1);
    expect(await card(page).locator('details').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    const visible = await card(page).innerText();
    for (const pattern of technical) expect(visible).not.toMatch(pattern);
    expect(traffic.consent()).toHaveLength(0);
  });
}
test('L2a the sheet\'s Turn on is the consent: nothing before it, one write at the current notice, then a checked switch', async ({ page }) => {
  const { api, traffic } = await start(page);
  await openSettings(page);
  const version = Number(api.profiles[owners.a]!.version);
  await toggle(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByText(offSummary('en'), { exact: true })).toBeVisible();
  await expect(sheet(page).getByText(text('aiC.azureNotice'), { exact: true })).toBeVisible();
  await expect(state(page, false)).toHaveCount(1);
  expect(traffic.consent()).toHaveLength(0);
  await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
  await expect(state(page, true)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(state(page, true)).toBeFocused();
  await expect(spent(page)).toHaveText(translate('en', 'aiF.spent', { used: money('en', 0), limit: money('en', 2000, true) }));
  await expect(cardButton(page, 'aiC.disable')).toHaveCount(0);
  expect(traffic.consent().map((entry) => entry.body)).toEqual([{ p_enabled: true, p_notice_revision: 2, p_expected_version: version }]);
  expect(api.profiles[owners.a]!.version).toBe(version + 1);
});
test('L2a rapid double activation of Turn on sends one consent write', async ({ page }) => {
  const { traffic } = await start(page);
  await openSettings(page);
  await toggle(page).click();
  await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).dblclick();
  await expect(state(page, true)).toBeVisible();
  expect(traffic.consent()).toHaveLength(1);
  await toggle(page).click();
  await expect(state(page, false)).toBeVisible();
  await expect(toggle(page)).toBeEnabled();
  // WebKit does not focus a button on a mouse click; the keyboard steps start from the switch, as a keyboard user would.
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page).getByRole('button', { name: text('common.cancel'), exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(state(page, true)).toBeVisible();
  expect(traffic.consent().filter((entry) => (entry.body as { p_enabled: boolean }).p_enabled)).toHaveLength(2);
  expect(traffic.consent()).toHaveLength(3);
});
test('L2a On has a checked switch; focus, visibility and reconnect never write', async ({ page, context }) => {
  const { traffic } = await start(page, 'en', true);
  await openSettings(page);
  await expect(state(page, true)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  const input = page.locator('#profile-display_name');
  await input.focus();
  const before = traffic.status();
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => traffic.status() - before).toBeGreaterThanOrEqual(2);
  await expect(state(page, true)).toBeVisible();
  await expect(input).toBeFocused();
  expect(traffic.consent()).toHaveLength(0);
  expect(traffic.writes()).toBe(0);
  expect(traffic.analysis()).toBe(0);
});
test('L2a usage rounds up to cents, the limit follows the configured allowance, and the warning shows', async ({ page }) => {
  const { api, setStatus } = await start(page, 'en', true);
  await openSettings(page);
  await expect(spent(page)).toHaveText(usage('en', 0));
  setStatus({ usage: { accountedMicro: '7000' } });
  await reread(page, () => expect(spent(page)).toHaveText(usage('en', 1), { timeout: 1000 }));
  setStatus({ usage: { accountedMicro: '10001' } });
  await reread(page, () => expect(spent(page)).toHaveText(usage('en', 2), { timeout: 1000 }));
  await expect(page.locator('.ai-spend').getByText(text('aiC.warning'), { exact: true })).toHaveCount(0);
  setStatus({ usage: { accountedMicro: '16000000' } });
  await reread(page, () => expect(spent(page)).toHaveText(usage('en', 1600), { timeout: 1000 }));
  await expect(page.locator('.ai-spend').getByText(text('aiC.warning'), { exact: true })).toBeVisible();
  setStatus({ policy: { monthlyAllowanceMicro: '20015000' } });
  await reread(page, () => expect(spent(page)).toHaveText(usage('en', 0, money('en', 2001)), { timeout: 1000 }));
  expect(api.calls.filter((call) => call.route.endsWith('/ai_set_consent'))).toHaveLength(0);
});
test('L2a overlapping automatic reads keep one request in flight and never write', async ({ page }) => {
  const { traffic, setStatus } = await start(page);
  let release = () => {};
  setStatus({ hold: new Promise<void>((resolve) => { release = resolve; }) });
  const before = traffic.status();
  await openSettings(page);
  await expect.poll(() => traffic.status() - before).toBe(1);
  for (let n = 0; n < 3; n++) await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(300);
  expect(traffic.status() - before).toBe(1);
  setStatus(null);
  release();
  await expect(state(page, false)).toBeVisible();
  expect(traffic.consent()).toHaveLength(0);
  expect(traffic.writes()).toBe(0);
});
test('L2a a status reply that arrives after sign-out is discarded', async ({ page }) => {
  const { traffic, setStatus } = await start(page, 'en', true);
  let release = () => {};
  setStatus({ hold: new Promise<void>((resolve) => { release = resolve; }) });
  const before = traffic.status();
  await openSettings(page);
  await expect.poll(() => traffic.status() - before).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: text('account.menu') }).click();
  await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);
  expect(traffic.consent()).toHaveLength(0);
});
test('L2a a policy change after the card was shown needs Turn on again', async ({ page }) => {
  const { api, traffic } = await start(page);
  await openSettings(page);
  await expect(state(page, false)).toBeVisible();
  api.policy({ monthlyAllowanceMicro: '30000000' });
  await toggle(page).click();
  await expect(sheet(page).getByText(offSummary('en'), { exact: true })).toBeVisible();
  await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
  await expect(card(page).getByRole('alert')).toHaveText(text('aiC.changed'));
  await expect(sheet(page)).toHaveCount(0);
  expect(traffic.consent()).toHaveLength(0);
  await toggle(page).click();
  await expect(sheet(page).getByText(offSummary('en', money('en', 3000, true)), { exact: true })).toBeVisible();
  await sheet(page).getByRole('button', { name: text('aiC.enable'), exact: true }).click();
  await expect(state(page, true)).toBeVisible();
  expect(traffic.consent()).toHaveLength(1);
  await toggle(page).click();
  await expect(state(page, false)).toBeVisible();
  api.policy({ noticeRevision: 3 });
  await turnOn(page);
  await expect(card(page).getByText(text('aiC.inactive'), { exact: true })).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  expect(traffic.consent()).toHaveLength(2);
});
test('L2a an allowance change while On keeps it on with the new limit and no write', async ({ page }) => {
  const { api, traffic, setStatus } = await start(page, 'en', true);
  await openSettings(page);
  await expect(state(page, true)).toBeVisible();
  api.policy({ monthlyAllowanceMicro: '30000000' });
  setStatus({ policy: { monthlyAllowanceMicro: '30000000' } });
  await reread(page, () => expect(spent(page)).toHaveText(usage('en', 0, money('en', 3000, true)), { timeout: 1000 }));
  await expect(state(page, true)).toBeVisible();
  expect(traffic.consent()).toHaveLength(0);
});
test('L2a consent to an older notice shows Off with Turn on and Turn off, and writes only on Turn on', async ({ page }) => {
  const { api, traffic, setStatus } = await start(page, 'en', true);
  setStatus({ consent: { enabled: true, noticeRevision: 1 } });
  await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => { setStatus(null); await route.fallback(); });
  api.consent.set(owners.a, false);
  await openSettings(page);
  await expect(state(page, false)).toBeVisible();
  await expect(card(page).getByRole('status').getByText(text('aiC.changed'), { exact: true })).toBeVisible();
  await expect(toggle(page)).toHaveCount(1);
  await expect(cardButton(page, 'aiC.disable')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(200);
  expect(traffic.consent()).toHaveLength(0);
  await turnOn(page);
  await expect(state(page, true)).toBeVisible();
  expect(traffic.consent().map((entry) => (entry.body as { p_notice_revision: number }).p_notice_revision)).toEqual([2]);
});
test('L2a unavailable states show one line and only Turn off for stored consent', async ({ page }) => {
  const { traffic, setStatus } = await start(page, 'en', true);
  const unavailable = async () => {
    await expect(card(page).getByText(text('aiC.inactive'), { exact: true })).toBeVisible({ timeout: 1000 });
    await expect(card(page).locator('details')).toHaveCount(0);
    await expect(state(page, false)).toHaveCount(0);
  };
  setStatus({ code: 'UNCONFIGURED', consent: { enabled: false } });
  await openSettings(page);
  await unavailable();
  await expect(toggle(page)).toHaveCount(0);
  for (const patch of [{ code: 'INACTIVE' }, { code: 'UNAVAILABLE' }, { policy: { modelId: 'unrecognized-model' } },
    { policy: { noticeRevision: 1, modelId: 'gemini-3.8-flash', executionManifestId: 'google-eu-3.8-v1' } },
    { serverTimeMs: azureAiReviewExpires }, { consent: { enabled: true, noticeRevision: 1 }, policy: { modelId: 'unrecognized-model' } }] as StatusPatch[]) {
    setStatus(patch);
    await reread(page, unavailable);
    await expect(state(page, true)).toHaveCount(1);
  }
  setStatus({ code: 'INACTIVE' });
  await reread(page, unavailable);
  expect(traffic.consent()).toHaveLength(0);
  await toggle(page).click();
  // Turn off re-reads status before it writes, and the row reads Saving meanwhile, so wait for the write to settle.
  await expect.poll(() => traffic.consent().map((entry) => entry.body)).toMatchObject([{ p_enabled: false, p_notice_revision: null }]);
  await expect(card(page)).toHaveAttribute('aria-busy', 'false');
  await expect(toggle(page)).toHaveCount(0);
  await unavailable();
  expect(traffic.consent().map((entry) => entry.body)).toMatchObject([{ p_enabled: false, p_notice_revision: null }]);
});
test('L2a a failed status load offers Try again, which only reads', async ({ page }) => {
  const { traffic, setStatus } = await start(page);
  setStatus({ fail: 503 });
  await openSettings(page);
  await expect(card(page).getByText(text('aiC.loadFailed'), { exact: true })).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  setStatus(null);
  const before = traffic.status();
  await cardButton(page, 'common.retry').click();
  await expect(state(page, false)).toBeVisible();
  expect(traffic.status() - before).toBe(1);
  expect(traffic.consent()).toHaveLength(0);
  expect(traffic.writes()).toBe(0);
});
for (const language of languages) {
  test(`L2a How it works ${language} shows the recorded notice by keyboard before Turn on`, async ({ page }) => {
    const { traffic } = await start(page, language);
    await openSettings(page, language);
    const summary = card(page).locator('summary');
    await expect(summary).toHaveText(text('aiF.about', language));
    await expect(card(page).getByText(text('aiC.azureNotice', language), { exact: true })).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    for (const key of ['aiC.azureNotice', 'aiC.azureTrainingNotice', 'aiC.retentionNotice', 'aiC.allowanceNotice',
      'aiC.optOutNotice', 'aiC.usageNotice'] as const) {
      await expect(card(page).getByText(text(key, language), { exact: true })).toBeVisible();
    }
    await turnOn(page, language);
    await expect(state(page, true)).toBeVisible();
    expect(traffic.consent()).toHaveLength(1);
  });
}
for (const trigger of ['focus', 'visibilitychange', 'online'] as const) {
  test(`L2a an unconfirmed Turn on is resolved by ${trigger} with reads only and keeps dirty edits`, async ({ page }) => {
    const { api, traffic } = await start(page);
    await openSettings(page);
    await page.locator('#profile-display_name').fill('My unsaved name');
    await expect(page.locator('#profile-display_name')).toHaveValue('My unsaved name');
    await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
      api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
      await route.abort('failed');
    });
    await turnOn(page);
    await expect(card(page).getByText(text('aiC.reconcile'), { exact: true })).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
    await expect(cardButton(page, 'aiC.disable')).toHaveCount(0);
    const consentWrites = traffic.consent().length;
    await expect(async () => {
      await page.evaluate((name) => {
        if (name === 'visibilitychange') document.dispatchEvent(new Event(name)); else window.dispatchEvent(new Event(name));
      }, trigger);
      await expect(state(page, true)).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
    await expect(card(page).getByText(text('aiC.reconcile'), { exact: true })).toHaveCount(0);
    await expect(card(page).getByRole('alert')).toHaveCount(0);
    expect(traffic.consent()).toHaveLength(consentWrites);
    await expect(page.locator('#profile-display_name')).toHaveValue('My unsaved name');
    await page.getByRole('button', { name: text('settings.saveProfile'), exact: true }).click();
    await expect(page.getByRole('button', { name: text('settings.keepEdits'), exact: true })).toBeVisible();
    expect(api.profiles[owners.a]!.display_name).toBe('Alex');
  });
}
test('L2a a real offline and online transition resolves an unconfirmed Turn on once, with reads only', async ({ page, context }) => {
  const { api, traffic } = await start(page);
  await openSettings(page);
  await page.locator('#profile-display_name').fill('My unsaved name');
  await expect(page.locator('#profile-display_name')).toHaveValue('My unsaved name');
  await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
    api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
    await route.abort('failed');
  });
  await turnOn(page);
  await expect(card(page).getByText(text('aiC.reconcile'), { exact: true })).toBeVisible();
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  const consentWrites = traffic.consent().length;
  await page.waitForTimeout(300);
  await expect(state(page, true)).toHaveCount(0);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  await expect(state(page, true)).toBeVisible({ timeout: 10000 });
  await expect(card(page).getByText(text('aiC.reconcile'), { exact: true })).toHaveCount(0);
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  expect(traffic.consent()).toHaveLength(consentWrites);
  await expect(page.locator('#profile-display_name')).toHaveValue('My unsaved name');
});
for (const [language, width, zoom] of [['en', 1280, false], ['fi', 320, false], ['sv', 1280, true]] as const) {
  test(`L2a accessibility ${language}: every card state at ${width}${zoom ? ' and 200% text' : ''}`, async ({ page: fresh }) => {
    test.slow();
    const { api, setStatus } = await start(fresh, language);
    await fresh.setViewportSize({ width, height: 900 });
    if (zoom) await fresh.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const check = async () => {
      expect((await new AxeBuilder({ page: fresh }).analyze()).violations).toEqual([]);
      expect(await fresh.evaluate(() => {
        const section = document.querySelector('section[aria-labelledby="ai-consent-title"]')!;
        const buttons = [...section.querySelectorAll<HTMLElement>('button, summary')].filter((element) => element.getClientRects().length);
        return document.documentElement.scrollWidth <= innerWidth && buttons.every((element) => element.getBoundingClientRect().height >= 44)
          && section.querySelector('h3') !== null;
      })).toBe(true);
    };
    await openSettings(fresh, language);
    await expect(state(fresh, false)).toBeVisible();
    await check();
    await card(fresh).locator('summary').focus();
    await fresh.keyboard.press('Enter');
    await expect(card(fresh).getByText(text('aiC.azureNotice', language), { exact: true })).toBeVisible();
    await check();
    setStatus({ consent: { enabled: true, noticeRevision: 1 } });
    await reread(fresh, () => expect(cardButton(fresh, 'aiC.disable', language)).toBeVisible({ timeout: 1000 }));
    await check();
    setStatus({ code: 'UNCONFIGURED' });
    await reread(fresh, () => expect(card(fresh).getByText(text('aiC.inactive', language), { exact: true })).toBeVisible({ timeout: 1000 }));
    await check();
    setStatus(null);
    await reread(fresh, () => expect(state(fresh, false)).toBeVisible({ timeout: 1000 }));
    await fresh.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
      api.consent.set(owners.a, true); api.profiles[owners.a]!.version = Number(api.profiles[owners.a]!.version) + 1;
      await route.abort('failed');
    });
    await turnOn(fresh, language);
    await expect(card(fresh).getByText(text('aiC.reconcile', language), { exact: true })).toBeVisible();
    await check();
    await fresh.unroute('**/rest/v1/rpc/ai_set_consent');
    await cardButton(fresh, 'common.retry', language).click();
    await expect(state(fresh, true)).toBeVisible();
    await check();
    setStatus({ fail: 503 });
    await fresh.reload();
    if (zoom) await fresh.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(fresh.locator('#settings-title')).toBeVisible();
    await expect(card(fresh).getByText(text('aiC.loadFailed', language), { exact: true })).toBeVisible();
    await check();
  });
}
for (const availability of ['laundry', 'repair', 'lent'] as const) {
  test(`L2a saved item keeps stored availability ${availability} without showing or sending it`, async ({ page }) => {
    const api = await aiFixture(page);
    const patches: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/rest/v1/items') patches.push(request.postDataJSON() as Record<string, unknown>);
    });
    const saved = api.seedSavedItem();
    (saved.item as Record<string, unknown>).availability = availability;
    await page.reload();
    await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
    await editItem(page);
    await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
    await expect(page.locator('.detail-availability')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: text(`availability.${availability}`), exact: true })).toHaveCount(0);
    await expect(page.getByText('Availability', { exact: true })).toHaveCount(0);
    await page.locator('#detail-title').fill('Renamed');
    await page.getByRole('button', { name: text('detail.saveChanges'), exact: true }).click();
    await expect(page.getByText(text('detail.saved'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: text('detail.archive'), exact: true }).click();
    await page.getByRole('button', { name: text('detail.unarchive'), exact: true }).click();
    await expect(page.getByRole('button', { name: text('detail.archive'), exact: true })).toBeVisible();
    expect(patches).toHaveLength(3);
    for (const patch of patches) {
      expect(Object.hasOwn(patch, 'availability')).toBe(false);
      expect(Object.keys((patch.field_provenance ?? {}) as Record<string, unknown>)).not.toContain('availability');
    }
    expect(saved.item.availability).toBe(availability);
  });
}
for (const language of languages) {
  test(`L2a header ${language} shows the name without a Private badge`, async ({ page }) => {
    await aiFixture(page, language);
    const identity = page.locator('.workspace-identity');
    await expect(identity).toHaveText('Alex');
    await expect(identity).toHaveAttribute('aria-label', text('account.identity', language));
    await expect(identity.locator('.identity-separator')).toHaveCount(0);
    for (const other of languages) expect(await identity.innerText()).not.toContain(({ en: 'Private', fi: 'Yksityinen', sv: 'Privat' })[other]);
  });
}

test.describe('bounded L2a visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`settings off, details, on and unavailable ${selected.suffix} retain functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language, { setStatus } = await start(page, language);
      const write = testInfo.project.name === selected.project;
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/ux-l2a-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async (name: 'settings-off' | 'settings-details' | 'settings-on' | 'settings-unavailable') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        if (!write) return;
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await openSettings(page, language);
      await expect(state(page, false)).toBeVisible();
      await card(page).scrollIntoViewIfNeeded();
      await capture('settings-off');
      await card(page).locator('summary').click();
      await expect(card(page).getByText(text('aiC.azureNotice', language), { exact: true })).toBeVisible();
      await capture('settings-details');
      await turnOn(page, language);
      await expect(state(page, true)).toBeVisible();
      await expect(spent(page)).toHaveText(usage(language, 0));
      await capture('settings-on');
      setStatus({ code: 'UNCONFIGURED', consent: { enabled: false } });
      await reread(page, () => expect(card(page).getByText(text('aiC.inactive', language), { exact: true })).toBeVisible({ timeout: 1000 }));
      await capture('settings-unavailable');
    });
  }
});
