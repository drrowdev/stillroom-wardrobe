import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import { adminStartLimits, mockBackend, owners, signIn } from './mock-backend';
import { expectSignedIn, openAccountMenu } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Parameters = Record<string, string | number>;
const text = (key: MessageKey, language: Language | Parameters = 'en', parameters?: Parameters) =>
  typeof language === 'string' ? translate(language, key, parameters) : translate('en', key, language);
const account = (page: Page, number: 1 | 2) => page.locator(`section[aria-labelledby="admin-account-${number}"]`);
const field = (page: Page, number: 1 | 2, feature: string, key: string) => page.locator(`#admin-account-${number}-${feature}-${key}`);
const button = (scope: Page | ReturnType<Page['locator']>, key: MessageKey, language: Language = 'en') =>
  scope.getByRole('button', { name: text(key, language), exact: true });
const dialog = (page: Page) => page.locator('dialog[open]');
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

async function start(page: Page, options: { language?: Language; admin?: boolean; hash?: string; now?: Date } = {}) {
  const language = options.language ?? 'en';
  const api = await mockBackend(page, { initialLanguage: language });
  if (options.admin !== false) api.adminControl.admin = owners.a;
  if (options.now) api.adminControl.now = options.now;
  await page.goto(options.hash ?? '/#/admin'); await signIn(page);
  await expectSignedIn(page);
  return api;
}
async function openScreen(page: Page) {
  await expect(page.locator('#admin-title')).toBeVisible();
  await expect(account(page, 1)).toBeVisible();
}
// The exact tables are inside each account's collapsed Details; their rows are read whether or not it is open.
const row = (page: Page, number: 1 | 2, label: MessageKey, index = 0) => account(page, number).locator('table').nth(index)
  .locator('tr', { has: page.getByRole('rowheader', { name: text(label), exact: true, includeHidden: true }) });
const details = (page: Page, number: 1 | 2) => account(page, number).locator('details.admin-details');
const summary = (page: Page, number: 1 | 2) => account(page, number).locator('.admin-summary > div');
const probe = (feature: MessageKey, amount: string) => text('admin.probe', { feature: text(feature), amount });
async function edit(page: Page, number: 1 | 2) {
  await button(account(page, number), 'admin.edit').click();
  await expect(account(page, number).locator('form')).toBeVisible();
}
async function writes(api: Api, count: number) { await expect.poll(() => api.adminControl.writes.length).toBe(count); }

// December 2026 back to July 2026 includes the longest month names in each language.
const fixedMonths = {
  en: ['December 2026', 'November 2026', 'October 2026', 'September 2026', 'August 2026', 'July 2026'],
  fi: ['joulukuu 2026', 'marraskuu 2026', 'lokakuu 2026', 'syyskuu 2026', 'elokuu 2026', 'heinäkuu 2026'],
  sv: ['december 2026', 'november 2026', 'oktober 2026', 'september 2026', 'augusti 2026', 'juli 2026'],
} as const;
async function expectMonthsFit(page: Page, language: Language) {
  await page.setViewportSize({ width: 320, height: 900 });
  await start(page, { language, now: new Date(Date.UTC(2026, 11, 15)) });
  await openScreen(page);
  for (const zoomed of [false, true]) {
    if (zoomed) await page.addStyleTag({ content: zoom });
    if (zoomed) await expect(page.locator('html')).toHaveCSS('font-size', '32px');
    const fit = await page.locator('#admin-month').evaluate((select: HTMLSelectElement) => {
      const style = getComputedStyle(select);
      // Only without a native appearance is the padding the whole space beside the text.
      if (style.appearance !== 'none') throw new Error(`appearance ${style.appearance}`);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = style.font;
      const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { room, labels: [...select.options].map((option) => ({ label: option.text, width: context.measureText(option.text).width })) };
    });
    expect(fit.labels.map((entry) => entry.label)).toEqual(fixedMonths[language]);
    for (const entry of fit.labels) expect(entry.width, `${entry.label} zoomed=${String(zoomed)}`).toBeLessThanOrEqual(fit.room);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.describe('AD1b admin spending and limits', () => {
  test('anyone who is not the admin sees the note, and the admin screen is not available', async ({ page }) => {
    const api = await start(page, { admin: false, hash: '/#/settings' });
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect(page.locator('.ai-features').getByText(text('admin.note'), { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: text('admin.title'), exact: true })).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/admin'; });
    await expect(page.locator('#admin-title')).toBeVisible();
    await expect(page.getByText(text('admin.unavailable'), { exact: true })).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    expect(api.adminControl.spendingReads).toEqual([]);
    expect(api.adminControl.writes).toEqual([]);
    await axe(page);
    await button(page, 'common.back').click();
    await expect(page.locator('#settings-title')).toBeVisible();
  });

  test('a backend without the admin functions shows the note', async ({ page }) => {
    const api = await mockBackend(page);
    api.adminControl.missing = true;
    await page.goto('/#/settings'); await signIn(page);
    await expect(page.getByText(text('admin.note'), { exact: true })).toBeVisible();
  });

  test('a failed admin check shows nothing in Settings', async ({ page }) => {
    const api = await mockBackend(page);
    api.adminControl.admin = owners.a;
    api.adminControl.statusFaults.push('fail');
    await page.goto('/#/settings'); await signIn(page);
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect.poll(() => api.adminControl.statusReads).toBe(1);
    await expect(page.getByText(text('admin.note'), { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: text('admin.title'), exact: true })).toHaveCount(0);
  });

  test('the admin opens exact spending per account and feature', async ({ page }) => {
    const api = await start(page, { hash: '/#/settings' });
    await page.locator('.ai-features').getByRole('link', { name: text('admin.title'), exact: true }).click();
    await openScreen(page);
    await expect(page.locator('#admin-title')).toBeFocused();
    await expect(page.getByText('Spending recorded by the app. Some amounts are estimates. Calls made outside the app aren\'t included.', { exact: true })).toBeVisible();
    // The plain summary: Used is confirmed plus estimated, Pending is still reserved, from the same month as the table,
    // rounded to cents for display only (1.779407 and 4.586711); the exact amounts stay in Details.
    await expect(summary(page, 1)).toHaveText([`${text('admin.used')}$1.78`, `${text('admin.pending')}$4.59`, `${text('admin.requests')}9`]);
    for (const block of ['.admin-summary', '.admin-use']) for (const exact of ['$1.779407', '$4.586711', '$6.366118']) {
      await expect(account(page, 1).locator(block)).not.toContainText(exact);
    }
    await expect(summary(page, 2).nth(2)).toContainText(text('admin.requests'));
    for (const number of [1, 2] as const) await expect(details(page, number)).not.toHaveAttribute('open');
    await expect(account(page, 1).getByText(probe('admin.enhancement', '$0.26'), { exact: true })).toBeHidden();
    await expect(account(page, 1).locator('table')).toHaveCount(2);
    await expect(account(page, 1).locator('table').first()).toBeHidden();
    // The bars beside the current use are decorative; the text says the same.
    const bars = account(page, 1).locator('.admin-use .usage-bar');
    await expect(bars.first()).toHaveAttribute('aria-hidden', 'true');
    expect(await bars.first().locator('span').evaluate(span => (span as HTMLElement).style.width)).toBe('31.8%');
    await expect(row(page, 1, 'admin.tagging').locator('td')).toHaveText(['$1.234567', '$0.30', '$4.097351', '$5.631918', '5']);
    await expect(row(page, 1, 'admin.stylist').locator('td')).toHaveText(['$0.00', '$0.00484', '$0.12936', '$0.1342', '2']);
    await expect(row(page, 1, 'admin.enhancement').locator('td')).toHaveText(['$0.00', '$0.00', '$0.00', '$0.00', '0']);
    await expect(row(page, 1, 'admin.tryOn').locator('td')).toHaveText(['$0.24', '$0.00', '$0.36', '$0.60', '2']);
    await expect(row(page, 1, 'admin.total').locator('td')).toHaveText(['$1.474567', '$0.30484', '$4.586711', '$6.366118', '9']);
    await expect(account(page, 1)).toContainText(text('admin.usedOf', { used: '$6.37', limit: '$20.00' }));
    await expect(account(page, 1)).toContainText(text('admin.usedOf', { used: '$0.60', limit: '$8.00' }));
    await details(page, 1).locator('summary').click();
    await expect(account(page, 1).locator('table').first()).toBeVisible();
    await expect(account(page, 1).getByText(probe('admin.enhancement', '$0.26'), { exact: true })).toBeVisible();
    await expect(account(page, 1).getByText(probe('admin.tryOn', '$1.80'), { exact: true })).toBeVisible();
    // Setup holds appear only inside Details, apart from this month's figures and the current use.
    await expect(details(page, 1).locator('p.stats-note')).toHaveText([probe('admin.enhancement', '$0.26'), probe('admin.tryOn', '$1.80')]);
    await expect(account(page, 1).locator('p.stats-note')).toHaveCount(3);
    // The limits show only the monthly limit and requests per hour; the per-request amounts are not shown anywhere.
    await expect(account(page, 1).locator('table').nth(1).locator('thead th')).toHaveText([text('admin.feature'), text('admin.monthly'), text('admin.perHour')]);
    await expect(account(page, 1).locator('table').first().locator('thead th').nth(3)).toHaveText('In progress');
    await expect(row(page, 1, 'admin.tryOn', 1).locator('td')).toHaveText(['$8.00', '6']);
    await expect(row(page, 2, 'admin.tryOn', 1).locator('td')).toHaveText(['–', '–']);
    await expect(account(page, 2).locator('.admin-use')).toContainText(text('admin.notSetUp'));
    await expect(account(page, 2)).not.toContainText(probe('admin.enhancement', '').split(',')[0]!);
    await expect(row(page, 1, 'admin.allFeatures', 1).locator('td')).toHaveText(['$20.00', '30']);
    await expect(row(page, 1, 'admin.stylist', 1).locator('td')).toHaveText(['$5.00', '20']);
    await expect(row(page, 2, 'admin.enhancement', 1).locator('td')).toHaveText(['–', '–']);
    for (const hidden of ['$4.097351', '$0.12936', '$0.36']) await expect(account(page, 1).locator('table').nth(1)).not.toContainText(hidden);
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/@example|user-[ab]|10000000-0000|a{63}|b{63}/);
    // An earlier month shows that month only; the current block stays on this month.
    const month = page.locator('#admin-month');
    await expect(month.locator('option')).toHaveCount(6);
    const earlier = await month.locator('option').nth(1).getAttribute('value');
    await month.selectOption(earlier!);
    await expect(row(page, 1, 'admin.tagging').locator('td')).toHaveText(['$2.60', '$0.00', '$0.00', '$2.60', '8']);
    await expect(row(page, 1, 'admin.tryOn').locator('td')).toHaveText(['$0.00', '$0.00', '$0.00', '$0.00', '0']);
    // Nothing is reserved in that month, so Used is the whole total.
    await expect(row(page, 1, 'admin.total').locator('td').nth(2)).toHaveText('$0.00');
    await expect(row(page, 1, 'admin.total').locator('td').nth(3)).toHaveText('$2.732345');
    await expect(summary(page, 1)).toHaveText([`${text('admin.used')}$2.73`, `${text('admin.pending')}$0.00`, `${text('admin.requests')}10`]);
    await expect(account(page, 1)).toContainText(text('admin.usedOf', { used: '$6.37', limit: '$20.00' }));
    await axe(page);
    await button(page, 'admin.moreMonths').click();
    await expect(month.locator('option')).toHaveCount(12);
    await expect(month).toHaveValue(earlier!);
    await expect(button(page, 'admin.moreMonths')).toHaveCount(0);
    expect(api.adminControl.spendingReads.map((read) => read.months)).toEqual([6, 12]);
  });

  test('a limit change is confirmed, sent exactly and shown', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 2);
    await expect(field(page, 2, 'shared', 'monthlyAllowanceMicro')).toBeFocused();
    // Only the monthly limit and requests per hour are offered; the per-request amounts are not fields.
    await expect(account(page, 2).locator('form label')).toHaveText([text('admin.monthly'), text('admin.perHour'), text('admin.monthly'), text('admin.perHour')]);
    await expect(account(page, 2).locator('form input[id$="-maxRequestMicro"]')).toHaveCount(0);
    await expect(account(page, 2).locator('form')).not.toContainText(/4[.,]097351|0[.,]12936/);
    await expect(field(page, 2, 'enhancement', 'monthlyAllowanceMicro')).toHaveCount(0);
    await expect(button(account(page, 2), 'admin.review')).toBeDisabled();
    await axe(page);
    await field(page, 2, 'stylist', 'monthlyAllowanceMicro').fill('3');
    await button(account(page, 2), 'admin.review').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('heading')).toHaveText(text('admin.confirmTitle', { number: 2 }));
    await expect(dialog(page).locator('li')).toHaveText([`${text('admin.stylist')}, ${text('admin.monthly')}: $2.00 → $3.00`]);
    await axe(page);
    await dialog(page).getByLabel(text('admin.reason'), { exact: true }).selectOption('RAISE');
    await button(dialog(page), 'admin.confirm').click();
    await expect(page.getByText(text('admin.saved'), { exact: true })).toBeVisible();
    await expect(page.getByText(text('admin.saved'), { exact: true })).toBeFocused();
    // Every per-request value is sent exactly as read.
    const initial = adminStartLimits()[2]!;
    expect(api.adminControl.writes).toEqual([{ owner: owners.a, body: {
      p_admission_no: 2, p_account_version: `${'b'.repeat(63)}1`, p_expected: initial,
      p_limits: { ...initial, stylist: { ...initial.stylist, monthlyAllowanceMicro: '3000000' } }, p_reason_code: 'RAISE' } }]);
    expect(api.adminControl.writes[0]!.body.p_limits).toMatchObject({ shared: { maxRequestMicro: '4097351' }, stylist: { maxRequestMicro: '129360' } });
    await expect(row(page, 2, 'admin.stylist', 1).locator('td')).toHaveText(['$3.00', '20']);
    await expect(account(page, 2).locator('form')).toHaveCount(0);
  });

  test('a try-on limit is edited like the others and sent with all four features', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 1);
    await expect(account(page, 1).getByRole('group', { name: text('admin.tryOn'), exact: true })).toBeVisible();
    await field(page, 1, 'tryOn', 'monthlyAllowanceMicro').fill('21');
    await button(account(page, 1), 'admin.review').click();
    await expect(page.locator('#admin-account-1-tryOn-monthlyAllowanceMicro-error')).toHaveText(text('admin.aboveShared'));
    await field(page, 1, 'tryOn', 'monthlyAllowanceMicro').fill('6');
    await field(page, 1, 'tryOn', 'maxRequestsPerHour').fill('4');
    await button(account(page, 1), 'admin.review').click();
    await expect(dialog(page).locator('li')).toHaveText([`${text('admin.tryOn')}, ${text('admin.monthly')}: $8.00 → $6.00`,
      `${text('admin.tryOn')}, ${text('admin.perHour')}: 6 → 4`]);
    await button(dialog(page), 'admin.confirm').click();
    await expect(page.getByText(text('admin.saved'), { exact: true })).toBeFocused();
    const initial = adminStartLimits()[1]!;
    expect(api.adminControl.writes).toEqual([{ owner: owners.a, body: {
      p_admission_no: 1, p_account_version: `${'a'.repeat(63)}1`, p_expected: initial,
      p_limits: { ...initial, tryOn: { monthlyAllowanceMicro: '6000000', maxRequestMicro: '360000', maxRequestsPerHour: 4 } } } }]);
    await expect(row(page, 1, 'admin.tryOn', 1).locator('td')).toHaveText(['$6.00', '4']);
  });

  test('cancelling the confirmation returns to the form and sends nothing', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 1);
    await field(page, 1, 'shared', 'maxRequestsPerHour').fill('40');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'common.cancel').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(button(account(page, 1), 'admin.review')).toBeFocused();
    await expect(field(page, 1, 'shared', 'maxRequestsPerHour')).toHaveValue('40');
    expect(api.adminControl.writes).toEqual([]);
  });

  test('Cancel in the form returns focus to Edit limits, with Details still closed', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 1);
    await field(page, 1, 'shared', 'maxRequestsPerHour').fill('40');
    await button(account(page, 1), 'common.cancel').click();
    await expect(account(page, 1).locator('form')).toHaveCount(0);
    await expect(button(account(page, 1), 'admin.edit')).toBeFocused();
    await expect(details(page, 1)).not.toHaveAttribute('open');
    expect(api.adminControl.writes).toEqual([]);
  });

  test('checks the values before asking to confirm', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 1);
    await field(page, 1, 'shared', 'monthlyAllowanceMicro').fill('50.000001');
    await field(page, 1, 'stylist', 'maxRequestsPerHour').fill('1001');
    await field(page, 1, 'enhancement', 'monthlyAllowanceMicro').fill('1,5');
    await button(account(page, 1), 'admin.review').click();
    await expect(account(page, 1).getByRole('alert')).toHaveText(text('admin.invalid'));
    await expect(account(page, 1).getByRole('alert')).toBeFocused();
    await expect(field(page, 1, 'enhancement', 'monthlyAllowanceMicro')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#admin-account-1-enhancement-monthlyAllowanceMicro-error')).toHaveText(text('admin.errFormat'));
    // A monthly limit below the hidden per-request amount (0.15) is reported on the monthly limit.
    await field(page, 1, 'enhancement', 'monthlyAllowanceMicro').fill('0.1');
    await button(account(page, 1), 'admin.review').click();
    await expect(page.locator('#admin-account-1-enhancement-monthlyAllowanceMicro-error')).toHaveText(text('admin.belowMinimum'));
    await expect(field(page, 1, 'enhancement', 'monthlyAllowanceMicro')).toHaveAttribute('aria-invalid', 'true');
    await field(page, 1, 'enhancement', 'monthlyAllowanceMicro').fill('2');
    await button(account(page, 1), 'admin.review').click();
    await expect(page.locator('#admin-account-1-shared-monthlyAllowanceMicro-error')).toHaveText(text('admin.overAppLimit'));
    await expect(page.locator('#admin-account-1-stylist-maxRequestsPerHour-error')).toHaveText(text('admin.errHour'));
    await axe(page);
    await field(page, 1, 'shared', 'monthlyAllowanceMicro').fill('50');
    await field(page, 1, 'stylist', 'maxRequestsPerHour').fill('20');
    await field(page, 1, 'stylist', 'monthlyAllowanceMicro').fill('50.5');
    await button(account(page, 1), 'admin.review').click();
    await expect(page.locator('#admin-account-1-stylist-monthlyAllowanceMicro-error')).toHaveText(text('admin.aboveShared'));
    expect(api.adminControl.writes).toEqual([]);
    // A retyped equal value is no change.
    await field(page, 1, 'stylist', 'monthlyAllowanceMicro').fill('5.000');
    await field(page, 1, 'shared', 'monthlyAllowanceMicro').fill('20.0');
    await button(account(page, 1), 'admin.review').click();
    await expect(page.getByText(text('admin.unchanged'), { exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(api.adminControl.writes).toEqual([]);
  });

  test('shows the server refusal against its field', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    api.adminControl.writeReplies.push({ status: 200, body: { code: 'INVALID_LIMITS', field: 'stylist.maxRequestsPerHour', reason: 'RANGE' } });
    await edit(page, 1);
    await field(page, 1, 'stylist', 'maxRequestsPerHour').fill('25');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(page.locator('#admin-account-1-stylist-maxRequestsPerHour-error')).toHaveText(text('admin.errHour'));
    await expect(field(page, 1, 'stylist', 'maxRequestsPerHour')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 1, 'stylist', 'maxRequestsPerHour')).toHaveValue('25');
    await expect(account(page, 1).getByRole('alert')).toBeFocused();
    await writes(api, 1);
  });

  test('a server refusal of the hidden per-request amount is shown on the monthly limit', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    api.adminControl.writeReplies.push({ status: 200, body: { code: 'INVALID_LIMITS', field: 'stylist.maxRequestMicro', reason: 'BELOW_RESERVATION' } });
    await edit(page, 1);
    await field(page, 1, 'stylist', 'monthlyAllowanceMicro').fill('0.2');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(page.locator('#admin-account-1-stylist-monthlyAllowanceMicro-error')).toHaveText(text('admin.belowMinimum'));
    await expect(field(page, 1, 'stylist', 'monthlyAllowanceMicro')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(page, 1, 'stylist', 'monthlyAllowanceMicro')).toHaveValue('0.2');
    await expect(account(page, 1).getByRole('alert')).toBeFocused();
    await writes(api, 1);
    expect(api.adminControl.writes[0]!.body.p_limits).toMatchObject({ stylist: { monthlyAllowanceMicro: '200000', maxRequestMicro: '129360' } });
  });

  test('warns when the new limit is below this month\'s use', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    const lowered = { ...adminStartLimits()[1]!, stylist: { monthlyAllowanceMicro: '130000', maxRequestMicro: '129360', maxRequestsPerHour: 20 } };
    api.adminControl.writeReplies.push({ status: 200, body: { code: 'OK', limits: lowered, belowUse: true } });
    await edit(page, 1);
    await field(page, 1, 'stylist', 'monthlyAllowanceMicro').fill('0.13');
    await button(account(page, 1), 'admin.review').click();
    await dialog(page).getByLabel(text('admin.reason'), { exact: true }).selectOption('PAUSE');
    await button(dialog(page), 'admin.confirm').click();
    await expect(account(page, 1).getByRole('status').filter({ hasText: text('admin.saved') })).toHaveText(`${text('admin.saved')} ${text('admin.belowUse')}`);
    expect(api.adminControl.writes[0]?.body.p_reason_code).toBe('PAUSE');
  });

  test('a change made elsewhere is reported and the current values are shown', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 2);
    api.adminControl.limits[2] = { ...adminStartLimits()[2]!, shared: { monthlyAllowanceMicro: '12000000', maxRequestMicro: '4097351', maxRequestsPerHour: 30 } };
    await field(page, 2, 'shared', 'maxRequestsPerHour').fill('31');
    await button(account(page, 2), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(account(page, 2).getByRole('alert')).toHaveText(text('admin.conflict'));
    await expect(account(page, 2).getByRole('alert')).toBeFocused();
    await expect(details(page, 2)).not.toHaveAttribute('open');
    await expect(account(page, 2).locator('form')).toHaveCount(0);
    await expect(row(page, 2, 'admin.allFeatures', 1).locator('td')).toHaveText(['$12.00', '30']);
    await expect(button(account(page, 2), 'admin.edit')).toBeEnabled();
    expect(api.adminControl.limits[2]?.shared.maxRequestsPerHour).toBe(30);
  });

  test('an unconfirmed save says so and reloads', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    api.adminControl.writeReplies.push('lost', { status: 200, body: { code: 'UNCHANGED', limits: adminStartLimits()[1] } });
    await edit(page, 1);
    await field(page, 1, 'shared', 'maxRequestsPerHour').fill('31');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(account(page, 1).getByRole('alert')).toHaveText(text('admin.unknown'));
    await expect(account(page, 1).getByRole('alert')).toBeFocused();
    await expect(details(page, 1)).not.toHaveAttribute('open');
    await expect.poll(() => api.adminControl.spendingReads.length).toBe(2);
    await edit(page, 1);
    await field(page, 1, 'shared', 'maxRequestsPerHour').fill('31');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(page.getByText(text('admin.unchanged'), { exact: true })).toBeVisible();
    await writes(api, 2);
  });

  async function saveHourLost(page: Page, api: Api) {
    api.adminControl.writeReplies.push('appliedLost');
    await edit(page, 1);
    await field(page, 1, 'shared', 'maxRequestsPerHour').fill('31');
    await button(account(page, 1), 'admin.review').click();
    await button(dialog(page), 'admin.confirm').click();
    await expect(account(page, 1).getByRole('alert')).toHaveText(text('admin.unknown'));
    expect(api.adminControl.limits[1]!.shared.maxRequestsPerHour).toBe(31);
  }
  const hourCell = (page: Page) => row(page, 1, 'admin.allFeatures', 1).locator('td').nth(1);

  test('after a lost reply, editing waits until a fresh read has arrived', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    api.adminControl.spendingFaults.push('hold');
    await saveHourLost(page, api);
    await expect.poll(() => api.adminControl.releaseSpending !== null).toBe(true);
    await expect(button(account(page, 1), 'admin.edit')).toBeDisabled();
    await expect(hourCell(page)).toHaveText('30');
    await expect(account(page, 1).getByRole('alert')).toHaveText(text('admin.unknown'));
    api.adminControl.releaseSpending!();
    await expect(hourCell(page)).toHaveText('31');
    await expect(button(account(page, 1), 'admin.edit')).toBeEnabled();
    expect(api.adminControl.writes).toHaveLength(1);
    expect(api.adminControl.spendingReads).toHaveLength(2);
  });

  test('after a lost reply and a failed read, only a new read is offered', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    api.adminControl.spendingFaults.push('fail');
    await saveHourLost(page, api);
    await expect(account(page, 1).getByText(text('admin.checkFailed'), { exact: true })).toBeVisible();
    await expect(button(account(page, 1), 'admin.edit')).toBeDisabled();
    await expect(hourCell(page)).toHaveText('30');
    await expect(account(page, 1).locator('form, dialog')).toHaveCount(0);
    await axe(page);
    await button(account(page, 1), 'admin.checkAgain').click();
    await expect(hourCell(page)).toHaveText('31');
    await expect(button(account(page, 1), 'admin.edit')).toBeEnabled();
    await expect(account(page, 1).getByText(text('admin.checkFailed'), { exact: true })).toHaveCount(0);
    expect(api.adminControl.writes).toHaveLength(1);
    expect(api.adminControl.spendingReads).toHaveLength(3);
  });

  test('recorded use is shown even where a feature has no limits', async ({ page }) => {
    const api = await mockBackend(page);
    api.adminControl.admin = owners.a;
    api.adminControl.limits[2] = null;
    // Account 2 has enhancement use held from an earlier month and no enhancement use in this month's history.
    api.adminControl.extraUsage = { 2: { enhancement: 150_000 } };
    await page.goto('/#/admin'); await signIn(page);
    await openScreen(page);
    const use = account(page, 2).locator('.admin-use > div');
    // Rounded to cents here (5.169475 and 0.00484); Details keeps the exact amounts.
    await expect(use.nth(0).locator('dd')).toContainText('$5.17');
    await expect(use.nth(2).locator('dd')).toHaveText(`$0.00${text('admin.notSetUp')}`);
    await expect(use.nth(3).locator('dd')).toHaveText(`$0.15${text('admin.notSetUp')}`);
    await expect(row(page, 2, 'admin.enhancement').locator('td')).toHaveText(['$0.00', '$0.00', '$0.00', '$0.00', '0']);
    await expect(account(page, 2)).toContainText(text('admin.notSetUp'));
    await expect(button(account(page, 2), 'admin.edit')).toHaveCount(0);
  });

  test('signing out ends the admin view, and the next account cannot see it', async ({ page }) => {
    const api = await start(page);
    await openScreen(page);
    await edit(page, 1);
    await openAccountMenu(page, 'en');
    await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    const discard = page.getByRole('button', { name: text('common.discard'), exact: true });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await expect(page.locator('#email')).toBeVisible();
    await signIn(page, 'b');
    await expectSignedIn(page);
    await page.evaluate(() => { location.hash = '#/admin'; });
    // Account B reads its own profile language, which is Swedish in the fixture.
    await expect(page.getByText(text('admin.unavailable', 'sv'), { exact: true })).toBeVisible();
    await expect(page.locator('table, form')).toHaveCount(0);
    expect(api.adminControl.spendingReads.filter((read) => read.owner === owners.b)).toEqual([]);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.getByText(text('admin.note', 'sv'), { exact: true })).toBeVisible();
  });

  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`every ${language} month label fits the select at 320 px, at 100 % and 200 % text size`, async ({ page }) => {
      await expectMonthsFit(page, language);
    });
  }

  test.describe('in forced colours', () => {
    test.use({ forcedColors: 'active' });
    test('the month select keeps a visible arrow, a focus ring, keyboard use and the narrow fit', async ({ page }) => {
      await expectMonthsFit(page, 'fi');
      expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
      const select = page.locator('#admin-month');
      const drawn = await select.evaluate((element) => {
        const style = getComputedStyle(element);
        return { supported: CSS.supports('forced-color-adjust', 'none'), adjust: style.getPropertyValue('forced-color-adjust'), image: style.backgroundImage, color: style.color };
      });
      // Chromium computes the drawn arrow as 'none' in forced colours unless the select opts out; WebKit never forces colours.
      if (drawn.supported) expect(drawn.adjust).toBe('none');
      expect(drawn.image).toContain('linear-gradient');
      // The arrow uses the same system colour as the text.
      expect(drawn.image).toContain(drawn.color);

      await page.locator('#admin-title').click();
      let focused = false;
      for (let step = 0; step < 40 && !focused; step += 1) {
        await page.keyboard.press('Tab');
        focused = await select.evaluate((element) => document.activeElement === element);
      }
      expect(focused).toBe(true);
      const ring = await select.evaluate((element) => {
        const style = getComputedStyle(element);
        return { visible: element.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      expect(ring).toEqual({ visible: true, style: 'solid', width: 3 });
      const first = await select.inputValue();
      await page.keyboard.press('ArrowDown');
      await expect(select).not.toHaveValue(first);
      await expect(select.locator('option:checked')).toHaveText(fixedMonths.fi[1]);
    });
  });

  test('a failed load can be retried', async ({ page }) => {
    const api = await mockBackend(page);
    api.adminControl.admin = owners.a;
    api.adminControl.spendingFaults.push('fail');
    await page.goto('/#/admin'); await signIn(page);
    await expect(page.getByRole('alert')).toContainText(text('admin.loadFailed'));
    await button(page, 'common.retry').click();
    await openScreen(page);
  });
});

test.describe('bounded AD1b visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'spending', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop', zoom: false },
    { scene: 'edit-confirm', project: 'mobile', language: 'fi', width: 390, suffix: 'fi-mobile', zoom: false },
    { scene: 'spending', project: 'mobile', language: 'sv', width: 320, suffix: 'sv-320-200', zoom: true },
    { scene: 'settings-note', project: 'mobile', language: 'en', width: 390, suffix: 'en-mobile', zoom: false },
  ] as const;
  for (const selected of scenes) {
    test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      const directory = path.resolve('test-results/ad1-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: selected.width, height: 900 });
      if (selected.scene === 'settings-note') {
        await start(page, { language, admin: false, hash: '/#/settings' });
        const note = page.getByText(text('admin.note', language), { exact: true });
        await expect(note).toBeVisible();
      } else {
        const api = await start(page, { language });
        await openScreen(page);
        if (selected.zoom) await page.addStyleTag({ content: zoom });
        // The narrow capture shows the exact tables, which must fit at 320 px and 200 % text.
        if (selected.zoom) await details(page, 1).locator('summary').click();
        if (selected.scene === 'edit-confirm') {
          await button(account(page, 2), 'admin.edit', language).click();
          await field(page, 2, 'stylist', 'monthlyAllowanceMicro').fill('2,5');
          await button(account(page, 2), 'admin.review', language).click();
          await expect(dialog(page)).toBeVisible();
          await expect(dialog(page).locator('li')).toHaveCount(1);
          expect(api.adminControl.writes).toEqual([]);
        }
      }
      if (selected.zoom) await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await axe(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|@example|[0-9a-f]{32}|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
          .filter((entry) => entry.getClientRects().length).map((entry) => entry.value).join('\n');
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
