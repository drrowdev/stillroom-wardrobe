import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { CLEANUP_NOTICE_REVISION } from '../../src/domain/enhancement';
import { TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { usdCents } from '../../src/domain/ai-presentation';
import { languages, translate, type Language, type MessageKey } from '../../src/i18n';
import '../../src/i18n/tryon';
import { aiFixture } from './ai-photo-first-support';
import { owners } from './mock-backend';

// UI1: the grouped Settings page. Functional and axe checks run in chromium, mobile and webkit-photo; the four bounded
// captures are written only in chromium.
const text = (key: MessageKey, language: Language = 'en', parameters: Record<string, string> = {}) => translate(language, key, parameters);
type Feature = 'analysis' | 'enhance' | 'tryon' | 'stylist';
const features: readonly Feature[] = ['analysis', 'enhance', 'tryon', 'stylist'];
const heading: Record<Feature, string> = { analysis: 'ai-consent-title', enhance: 'enhance-heading', tryon: 'tryon-heading', stylist: 'stylist-heading' };
const sheetId: Record<Feature, string> = { analysis: 'ai-consent', enhance: 'enhance', tryon: 'tryon', stylist: 'stylist' };
const consentPath: Record<Feature, string> = { analysis: '/rest/v1/rpc/ai_set_consent', enhance: '/rest/v1/rpc/enhance_set_consent',
  tryon: '/rest/v1/rpc/tryon_set_consent', stylist: '/rest/v1/rpc/stylist_set_consent' };
const revision: Record<Feature, number> = { analysis: 2, enhance: CLEANUP_NOTICE_REVISION, tryon: TRYON_NOTICE_REVISION, stylist: 1 };
const row = (page: Page, feature: Feature) => page.locator(`section[aria-labelledby="${heading[feature]}"]`);
const toggle = (page: Page, feature: Feature) => row(page, feature).getByRole('switch');
const sheet = (page: Page, feature: Feature) => page.locator(`dialog[aria-labelledby="${sheetId[feature]}-sheet-title"]`);
const sectionIds = ['settings-profile', 'settings-ai', 'settings-wardrobe', 'settings-data', 'settings-account'] as const;
const sectionLabels: MessageKey[] = ['settings.sectionProfile', 'settings.sectionAi', 'settings.sectionWardrobe', 'settings.sectionData', 'settings.sectionAccount'];

/** The pinned notice texts each sheet shows, in order, after its summary line where there is one. */
function sheetTexts(feature: Feature, language: Language): string[] {
  const keys: Record<Feature, MessageKey[]> = {
    analysis: ['aiC.processing', 'aiC.azureNotice', 'aiC.retentionTitle', 'aiC.azureTrainingNotice', 'aiC.retentionNotice',
      'aiC.chargesTitle', 'aiC.allowanceNotice', 'aiC.usageNotice', 'aiC.optOutNotice'],
    enhance: ['enhanceC.noticeSent', 'enhanceC.noticeRedraw', 'enhanceC.noticeProcessing', 'enhanceC.noticeCharges'],
    tryon: ['tryonC.noticeSent', 'tryonC.noticeResult', 'tryonC.noticeProcessing', 'tryonC.noticeCharges'],
    stylist: ['stylistC.fieldsTitle', 'stylistC.fields', 'stylistC.processing', 'stylistC.azureNotice', 'aiC.retentionTitle',
      'stylistC.trainingNotice', 'stylistC.retention', 'aiC.chargesTitle', 'stylistC.chargeNotice', 'stylistC.usageNotice', 'stylistC.optOut'],
  };
  const summary = feature === 'analysis' ? [text('aiC.offSummary', language, { limit: usdCents('100000000', language, 'limit') })]
    : feature === 'stylist' ? [text('stylistC.offSummary', language, { stylistLimit: usdCents('5000000', language, 'limit'), limit: usdCents('17940000', language, 'limit') })]
      : [];
  return [...summary, ...keys[feature].map((key) => text(key, language))];
}

type Options = { language?: Language; analysis?: boolean; enhance?: number | null; tryon?: number | null; stylist?: number | null;
  admin?: boolean; aiStatus?: 'fail'; missing?: Array<'enhance' | 'tryon'>; stylistSetup?: Record<string, unknown> | false; tryOnPaused?: boolean;
  /** Runs after sign-in, before Settings opens; routes added here take precedence over the fixture's. */ prepare?: () => Promise<void> };
/** Signs in and opens Settings with every feature activated; `null` means consent off, a number the consented revision. */
async function start(page: Page, options: Options = {}) {
  const language = options.language ?? 'en';
  const api = await aiFixture(page, language, options.analysis ?? false);
  const a = owners.a;
  api.enhanceControl.setup[a] = { activated: true };
  api.enhanceControl.consent[a] = options.enhance ?? null;
  api.tryonControl.setup[a] = { activated: true, ...(options.tryOnPaused ? { providerAvailable: false } : {}) };
  api.tryonControl.consent[a] = options.tryon ?? null;
  if (options.stylistSetup !== false) api.stylistControl.setup[a] = { configured: true, activated: true, ...options.stylistSetup };
  api.stylistControl.consent[a] = options.stylist ?? null;
  for (const name of options.missing ?? []) (name === 'enhance' ? api.enhanceControl : api.tryonControl).missing = true;
  if (options.admin) api.adminControl.admin = a;
  if (options.aiStatus === 'fail') {
    await page.route(/\/rest\/v1\/rpc\/ai_status$/, (route) => route.request().method() === 'OPTIONS' ? route.fallback()
      : route.fulfill({ status: 503, json: { message: 'Unavailable' } }));
  }
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && Object.values(consentPath).includes(url.pathname)) writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
  });
  await options.prepare?.();
  await openSettings(page);
  return { api, writes, consentWrites: (feature: Feature) => writes.filter((entry) => entry.path === consentPath[feature]) };
}
async function openSettings(page: Page) {
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#settings-title')).toBeVisible();
}
/** Holds the next consent write for a feature until `release` is called. */
async function holdConsent(page: Page, feature: Feature) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let used = false;
  await page.route((url) => url.pathname === consentPath[feature], async (route) => {
    if (route.request().method() !== 'OPTIONS' && !used) { used = true; await gate; }
    await route.fallback();
  });
  return release;
}
async function noViolations(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function sheetLines(page: Page, feature: Feature) {
  return sheet(page, feature).locator(`#${sheetId[feature]}-sheet-body`).evaluate((body) =>
    [...body.querySelectorAll('p, dt, dd')].filter((element) => !element.querySelector('p')).map((element) => (element.textContent ?? '').trim()));
}

test.describe('UI1 section layout', () => {
  test('sections are in order; the menu focuses each heading and marks the section in view; desktop menu is sticky', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start(page);
    expect(await page.locator('.settings-section').evaluateAll((sections) => sections.map((section) => section.id))).toEqual([...sectionIds]);
    const nav = page.getByRole('navigation', { name: text('settings.sections'), exact: true });
    await expect(nav.getByRole('button')).toHaveText(sectionLabels.map((key) => text(key)));
    await expect(nav).toHaveCSS('position', 'sticky');
    for (const [index, id] of sectionIds.entries()) {
      const item = nav.getByRole('button', { name: text(sectionLabels[index]!), exact: true });
      await item.click();
      await expect(page.locator(`#${id}-heading`)).toBeFocused();
      await expect(item).toHaveAttribute('aria-current', 'location');
      await expect(nav.locator('[aria-current]')).toHaveCount(1);
    }
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect.poll(() => nav.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(16);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(nav.getByRole('button', { name: text('settings.sectionProfile'), exact: true })).toHaveAttribute('aria-current', 'location');
    await noViolations(page);
  });

  for (const width of [390, 320]) {
    test(`at ${width}px the menu is a scrolling row and the page does not overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await start(page);
      const list = page.locator('.settings-nav ul');
      await expect(list).toHaveCSS('flex-direction', 'row');
      await expect(list).toHaveCSS('overflow-x', 'auto');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const last = page.locator('.settings-nav-item').last();
      await last.scrollIntoViewIfNeeded();
      const box = (await last.boundingBox())!;
      expect(box.x >= 0 && box.x + box.width <= width + 1).toBe(true);
      await last.click();
      await expect(page.locator('#settings-account-heading')).toBeFocused();
      await noViolations(page);
    });
  }
});

for (const feature of features) {
  test.describe(`UI1 ${feature} switch`, () => {
    for (const language of languages) {
      test(`${language}: the sheet shows the pinned notice and nothing is written before Turn on`, async ({ page }) => {
        const { consentWrites } = await start(page, { language });
        const control = toggle(page, feature);
        await expect(control).toHaveAttribute('aria-checked', 'false');
        await control.click();
        await expect(sheet(page, feature)).toBeVisible();
        expect(await sheetLines(page, feature)).toEqual(sheetTexts(feature, language));
        await noViolations(page);
        await sheet(page, feature).getByRole('button', { name: text('common.cancel', language), exact: true }).click();
        await expect(sheet(page, feature)).toHaveCount(0);
        await expect(control).toHaveAttribute('aria-checked', 'false');
        expect(consentWrites(feature)).toEqual([]);
      });
    }

    test('keyboard: Space opens, Escape cancels, Enter opens, Turn on waits for the reply, then one Turn off without a sheet', async ({ page }) => {
      const { consentWrites } = await start(page);
      const control = toggle(page, feature);
      await control.focus();
      await page.keyboard.press('Space');
      await expect(sheet(page, feature)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet(page, feature)).toHaveCount(0);
      await expect(control).toBeFocused();
      await expect(control).toHaveAttribute('aria-checked', 'false');
      expect(consentWrites(feature)).toEqual([]);

      const release = await holdConsent(page, feature);
      await page.keyboard.press('Enter');
      await expect(sheet(page, feature)).toBeVisible();
      await sheet(page, feature).getByRole('button', { name: text('aiC.enable'), exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => consentWrites(feature).length).toBe(1);
      expect(consentWrites(feature)[0]!.body).toMatchObject({ p_enabled: true, p_notice_revision: revision[feature] });
      await page.waitForTimeout(200);
      await expect(control).toHaveAttribute('aria-checked', 'false');
      release();
      await expect(control).toHaveAttribute('aria-checked', 'true');
      await expect(sheet(page, feature)).toHaveCount(0);
      await expect(control).toBeFocused();
      await noViolations(page);

      await page.keyboard.press('Space');
      await expect.poll(() => consentWrites(feature).length).toBe(2);
      expect(consentWrites(feature)[1]!.body).toMatchObject({ p_enabled: false });
      await expect(sheet(page, feature)).toHaveCount(0);
      await expect(control).toHaveAttribute('aria-checked', 'false');
      await expect(control).toBeFocused();
    });
  });
}

test.describe('UI1 row states', () => {
  test('renew shows an unchecked switch with Turn off; paused shows a checked switch', async ({ page }) => {
    await start(page, { enhance: CLEANUP_NOTICE_REVISION - 1, tryon: TRYON_NOTICE_REVISION, tryOnPaused: true });
    await expect(toggle(page, 'enhance')).toHaveAttribute('aria-checked', 'false');
    await expect(row(page, 'enhance').locator('#enhance-turn-off')).toHaveText(text('aiC.disable'));
    await expect(row(page, 'enhance')).toContainText(text('enhanceC.changed'));
    await expect(toggle(page, 'tryon')).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'tryon')).toContainText(text('tryonC.pausedText'));
    await noViolations(page);
  });

  test('a failed Turn on shows the error and the switch keeps the server value', async ({ page }) => {
    const { api } = await start(page);
    // A definite refusal; a lost or 5xx reply is an unknown outcome, which enhancement.spec covers.
    await page.route(/\/rest\/v1\/rpc\/enhance_set_consent$/, (route) => route.request().method() === 'OPTIONS' ? route.fallback()
      : route.fulfill({ json: { code: 'UNAVAILABLE' } }));
    await toggle(page, 'enhance').click();
    await sheet(page, 'enhance').getByRole('button', { name: text('aiC.enable'), exact: true }).click();
    await expect(row(page, 'enhance').getByRole('alert')).toHaveText(text('enhanceC.failed'));
    await expect(toggle(page, 'enhance')).toHaveAttribute('aria-checked', 'false');
    expect(api.enhanceControl.consent[owners.a]).toBeNull();
    await noViolations(page);
  });

  test('the sheet closes without writing when a passive read removes Turn on', async ({ page }) => {
    const { api, consentWrites } = await start(page);
    await toggle(page, 'enhance').click();
    await expect(sheet(page, 'enhance')).toBeVisible();
    const reads = api.enhanceControl.statusReads;
    api.enhanceControl.setup[owners.a] = { activated: false };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => api.enhanceControl.statusReads).toBeGreaterThan(reads);
    await expect(sheet(page, 'enhance')).toHaveCount(0);
    await expect(row(page, 'enhance')).toHaveCount(0);
    await expect(page.locator('#settings-ai-heading')).toBeFocused();
    expect(consentWrites('enhance')).toEqual([]);
  });
});

test.describe('UI1 spending summary and admin entry', () => {
  test('shows one reply\'s figures and the warning from 80 %; a non-admin sees the note', async ({ page }) => {
    await start(page, { aiStatus: 'fail', missing: ['enhance', 'tryon'], stylistSetup: { totalMicro: '16000000', totalAllowanceMicro: '20000000' } });
    const spend = page.locator('.ai-spend');
    await expect(spend.locator('.ai-spend-figure')).toHaveText(text('aiF.spent', 'en', { used: '$16.00', limit: '$20' }));
    await expect(spend).toContainText(text('aiC.warning'));
    await expect(page.locator('.ai-features').getByText(text('admin.note'), { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: text('admin.title'), exact: true })).toHaveCount(0);
    await noViolations(page);
  });

  test('an admin with no spending source still gets the admin link', async ({ page }) => {
    const { api } = await start(page, { admin: true, aiStatus: 'fail', missing: ['enhance', 'tryon'], stylistSetup: false });
    await expect(page.locator('.ai-features').getByRole('link', { name: text('admin.title'), exact: true })).toBeVisible();
    await expect.poll(() => api.stylistControl.statusReads).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(page.locator('.ai-spend')).toHaveCount(0);
    await noViolations(page);
  });

  test('a delayed newer try-on reply replaces the analysis figure', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await start(page, { missing: ['enhance'], stylistSetup: false, prepare: async () => {
      await page.route(/\/rest\/v1\/rpc\/tryon_status$/, async (route) => {
        if (route.request().method() !== 'OPTIONS') await gate;
        await route.fallback();
      });
    } });
    const figure = page.locator('.ai-spend-figure');
    await expect(figure).toHaveText(text('aiF.spent', 'en', { used: '$0.00', limit: '$100' }));
    release();
    await expect(figure).toHaveText(text('aiF.spent', 'en', { used: '$0.00', limit: '$20' }));
  });

  test('a cached figure is not shown again: returning waits for a new reply, and a failed one shows none', async ({ page }) => {
    const { api } = await start(page, { aiStatus: 'fail', missing: ['enhance', 'tryon'], stylistSetup: { totalMicro: '2000000', totalAllowanceMicro: '20000000' } });
    const figure = page.locator('.ai-spend-figure');
    await expect(figure).toHaveText(text('aiF.spent', 'en', { used: '$2.00', limit: '$20' }));
    await page.evaluate(() => { location.hash = '#/wardrobe'; });
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    api.stylistControl.setup[owners.a] = { configured: true, activated: true, totalMicro: '3000000', totalAllowanceMicro: '20000000' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route(/\/rest\/v1\/rpc\/stylist_status$/, async (route) => {
      if (route.request().method() !== 'OPTIONS' && !held) { held = true; await gate; }
      await route.fallback();
    });
    const reads = api.stylistControl.statusReads;
    await openSettings(page);
    await expect.poll(() => held).toBe(true);
    await page.waitForTimeout(200);
    await expect(page.locator('.ai-spend')).toHaveCount(0);
    release();
    await expect(figure).toHaveText(text('aiF.spent', 'en', { used: '$3.00', limit: '$20' }));
    expect(api.stylistControl.statusReads).toBeGreaterThan(reads);

    await page.evaluate(() => { location.hash = '#/wardrobe'; });
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const before = api.stylistControl.statusReads;
    api.stylistControl.statusFaults.push('fail');
    await openSettings(page);
    await expect.poll(() => api.stylistControl.statusReads).toBeGreaterThan(before);
    await page.waitForTimeout(300);
    await expect(page.locator('.ai-spend')).toHaveCount(0);
  });
});

test.describe('UI1 profile, language, sign out and forced colours', () => {
  test('profile Save is disabled until a change, then saves once; language still switches', async ({ page }) => {
    const { api } = await start(page);
    const patches: string[] = [];
    page.on('request', (request) => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/rest/v1/profiles') patches.push(request.url()); });
    const save = page.getByRole('button', { name: text('settings.saveProfile'), exact: true });
    await expect(save).toBeDisabled();
    await page.locator('#profile-display_name').fill('Sam');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText(text('settings.profileSaved'), { exact: true })).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(api.profiles[owners.a]!.display_name).toBe('Sam');
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: text('language.fi'), exact: true }).click();
    await expect(page.locator('#settings-title')).toHaveText(text('nav.settings', 'fi'));
    await expect(page.locator('.settings-nav-item').first()).toHaveText(text('settings.sectionProfile', 'fi'));
    await noViolations(page);
  });

  test('Sign out in Settings signs out', async ({ page }) => {
    await start(page);
    await page.locator('.account-sign-out').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
  });

  test('forced colours: checked and unchecked switches differ and the focus ring shows', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await start(page, { tryon: TRYON_NOTICE_REVISION });
    const thumb = (feature: Feature) => toggle(page, feature).locator('.switch-thumb')
      .evaluate((element) => element.getBoundingClientRect().left - element.parentElement!.getBoundingClientRect().left);
    await expect(toggle(page, 'tryon')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'enhance')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => await thumb('tryon') - await thumb('enhance')).toBeGreaterThanOrEqual(16);
    await toggle(page, 'enhance').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(toggle(page, 'enhance')).toBeFocused();
    const outline = await toggle(page, 'enhance').evaluate((element) => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
    expect(outline.style !== 'none' && outline.width > 0).toBe(true);
    await noViolations(page);
  });
});

test.describe('bounded UI1 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { name: 'settings-en-desktop', language: 'en', width: 1280, admin: true, large: false, states: 'on' },
    { name: 'settings-fi-mobile', language: 'fi', width: 390, admin: false, large: false, states: 'on' },
    { name: 'settings-sv-320-200', language: 'sv', width: 320, admin: false, large: true, states: 'mixed' },
    { name: 'consent-cleanup-en-mobile', language: 'en', width: 390, admin: false, large: false, states: 'sheet' },
  ] as const;
  for (const scene of scenes) {
    test(`${scene.name} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = scene.language;
      const write = testInfo.project.name === 'chromium';
      const directory = path.resolve('test-results/ui1-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      await page.setViewportSize({ width: scene.width, height: 900 });
      await start(page, scene.states === 'mixed'
        ? { language, analysis: true, enhance: CLEANUP_NOTICE_REVISION - 1, tryon: TRYON_NOTICE_REVISION, tryOnPaused: true, stylist: 1 }
        : { language, admin: scene.admin, analysis: scene.states === 'on', tryon: scene.states === 'on' ? TRYON_NOTICE_REVISION : null,
          stylist: scene.states === 'on' ? 1 : null });
      if (scene.large) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      if (scene.states === 'on') {
        for (const feature of ['analysis', 'tryon', 'stylist'] as const) await expect(toggle(page, feature)).toHaveAttribute('aria-checked', 'true');
        await expect(toggle(page, 'enhance')).toHaveAttribute('aria-checked', 'false');
        await expect(page.locator('.ai-spend-figure')).toBeVisible();
        if (scene.admin) await expect(page.getByRole('link', { name: text('admin.title', language), exact: true })).toBeVisible();
        else await expect(page.getByText(text('admin.note', language), { exact: true })).toBeVisible();
      } else if (scene.states === 'mixed') {
        await expect(toggle(page, 'enhance')).toHaveAttribute('aria-checked', 'false');
        await expect(row(page, 'enhance').locator('#enhance-turn-off')).toBeVisible();
        await expect(toggle(page, 'tryon')).toHaveAttribute('aria-checked', 'true');
        await expect(row(page, 'tryon')).toContainText(text('tryonC.pausedText', language));
        await row(page, 'enhance').scrollIntoViewIfNeeded();
      } else {
        await toggle(page, 'enhance').click();
        await expect(sheet(page, 'enhance')).toBeVisible();
      }
      expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
      await noViolations(page);
      expect(await page.evaluate(({ expectedLanguage, width }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
          .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
        return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
      }, { expectedLanguage: language, width: scene.width })).toBe(true);
      if (!write) return;
      const png = await page.screenshot({ fullPage: scene.states !== 'sheet', animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === scene.width).toBe(true);
      const file = await open(path.join(directory, `${scene.name}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
    });
  }
});
