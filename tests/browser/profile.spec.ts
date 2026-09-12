import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';
import { aiFixture } from './ai-photo-first-support';

async function settings(page: Page, language: Language = 'en') {
  await page.getByRole('button', { name: messages['account.menu'][language] }).click();
  await page.getByRole('link', { name: messages['nav.settings'][language], exact: true }).click();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(page.locator('#repeat_gap_days')).toBeVisible();
}
async function setup(page: Page, language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language });
  await page.goto('/'); await signIn(page); await settings(page, language);
  return api;
}
const profileUrl = 'http://127.0.0.1:54321/rest/v1/profiles*';
const preferenceUrl = 'http://127.0.0.1:54321/rest/v1/style_preferences*';
test('AI consent shares profile/language mutex and rebases only its own exact plus-one ACK', async ({ page }) => {
  const api = await aiFixture(page, 'en', false);
  await settings(page);
  await page.locator('#profile-display_name').fill('Preserved unsaved name');
  await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
  let held: Route | undefined;
  await page.route('**/rest/v1/rpc/ai_set_consent', (route) => { held = route; });
  await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByRole('button', { name: 'Suomi', exact: true })).toBeDisabled();
  await expect(page.locator('#profile-display_name')).toBeDisabled();
  await held!.fallback();
  await expect(page.getByText(messages['aiC.enabled'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#profile-display_name')).toHaveValue('Preserved unsaved name');
  await page.getByRole('button', { name: messages['settings.saveProfile'].en, exact: true }).click();
  await expect(page.getByText(messages['settings.profileSaved'].en, { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ version: 3, display_name: 'Preserved unsaved name', ui_language: 'en' });
  expect(api.calls.filter((call) => call.route.endsWith('/ai_set_consent'))).toHaveLength(1);
});
for (const failure of ['lost-ack', 'stale-profile'] as const) {
  test(`AI consent ${failure}: explicit read-only reconciliation cannot silently rebase dirty edits`, async ({ page }) => {
    const api = await aiFixture(page, 'en', false);
    await settings(page);
    const old = structuredClone(api.profiles[owners.a]);
    await page.locator('#profile-display_name').fill('My unsaved name');
    if (failure === 'lost-ack') {
      await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
        api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
        await route.abort('failed');
      });
    } else {
      await page.route(profileUrl, async (route) => {
        if (route.request().method() === 'GET') await route.fulfill({ json: old });
        else await route.fallback();
      });
    }
    await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
    await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: messages['aiC.enable'].en, exact: true })).toBeDisabled();
    if (failure === 'stale-profile') await page.unroute(profileUrl);
    let writes = 0;
    page.on('request', (request) => { if (request.url().endsWith('/ai_set_consent')) writes++; });
    await page.getByRole('button', { name: messages['aiC.checkConsent'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.enabled'].en, { exact: true })).toBeVisible();
    expect(writes).toBe(0);
    await expect(page.locator('#profile-display_name')).toHaveValue('My unsaved name');
    await page.getByRole('button', { name: messages['settings.saveProfile'].en, exact: true }).click();
    await expect(page.getByRole('button', { name: messages['settings.keepEdits'].en, exact: true })).toBeVisible();
    expect(api.profiles[owners.a]!.display_name).toBe('Alex');
  });
}
for (const action of ['save', 'reconcile'] as const) {
  test(`AI consent ${action} allows a measured aggregate above five seconds with bounded individual reads`, async ({ page }) => {
    const api = await aiFixture(page, 'en', false);
    await settings(page);
    await expect(page.getByText(messages['aiC.disabled'].en, { exact: true })).toBeVisible();
    await page.locator('#profile-display_name').fill('My slow-operation edits');
    let writes = 0;
    page.on('request', (request) => { if (request.url().endsWith('/ai_set_consent')) writes++; });
    if (action === 'reconcile') {
      await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
        api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
        await route.abort('failed');
      });
      await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
      await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
      await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    } else await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
    const timings: Array<{ path: string; start: number; elapsed?: number }> = [];
    const delay = action === 'save' ? 1500 : 2800;
    const statusLimit = action === 'save' ? 2 : 1;
    let statuses = 0;
    const delayCall = async (route: Route) => {
      if (route.request().method() === 'OPTIONS') { await route.fallback(); return; }
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/ai_status') && ++statuses > statusLimit) { await route.fallback(); return; }
      const timing: typeof timings[number] = { path: pathname, start: performance.now() };
      timings.push(timing);
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fallback();
      const response = await route.request().response();
      expect(response?.status()).toBe(200);
      timing.elapsed = performance.now() - timing.start;
    };
    await page.route('**/rest/v1/rpc/ai_status', delayCall);
    if (action === 'save') await page.route('**/rest/v1/rpc/ai_set_consent', delayCall);
    await page.route(profileUrl, delayCall);
    const writesBefore = writes, started = performance.now();
    await page.getByRole('button', { name: messages[action === 'save' ? 'aiC.enable' : 'aiC.checkConsent'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.enabled'].en, { exact: true })).toBeVisible({ timeout: 12000 });
    expect(performance.now() - started).toBeGreaterThan(5000);
    expect(performance.now() - started).toBeLessThan(20000);
    expect(timings).toHaveLength(action === 'save' ? 4 : 2);
    await expect.poll(() => timings.every((timing) => timing.elapsed !== undefined)).toBe(true);
    for (const timing of timings) {
      expect(timing.elapsed).toBeGreaterThanOrEqual(delay - 50);
      expect(timing.elapsed).toBeLessThan(5000);
    }
    expect(timings.map((timing) => timing.path)).toEqual(action === 'save'
      ? ['/rest/v1/rpc/ai_status', '/rest/v1/rpc/ai_set_consent', '/rest/v1/rpc/ai_status', '/rest/v1/profiles']
      : ['/rest/v1/rpc/ai_status', '/rest/v1/profiles']);
    expect(writes - writesBefore).toBe(action === 'save' ? 1 : 0);
    await page.unroute(profileUrl, delayCall);
    await expect(page.locator('#profile-display_name')).toHaveValue('My slow-operation edits');
    await page.getByRole('button', { name: messages['settings.saveProfile'].en, exact: true }).click();
    if (action === 'save') {
      await expect(page.getByText(messages['settings.profileSaved'].en, { exact: true })).toBeVisible();
      expect(api.profiles[owners.a]).toMatchObject({ version: 3, display_name: 'My slow-operation edits', ui_language: 'en' });
    } else {
      await expect(page.getByRole('button', { name: messages['settings.keepEdits'].en, exact: true })).toBeVisible();
      expect(api.profiles[owners.a]).toMatchObject({ version: 2, display_name: 'Alex', ui_language: 'en' });
    }
  });
}
type AiProfileWait = { started: number; aborted: number | null; released: boolean; release: () => Promise<void> };
type AiProfileWindow = Window & { aiProfileWait?: AiProfileWait };
for (const action of ['save', 'reconcile'] as const) {
  test(`AI consent ${action} releases the mutex at the profile call deadline and rejects its late result`, async ({ page }) => {
    const api = await aiFixture(page, 'en', false);
    await settings(page);
    await expect(page.getByText(messages['aiC.disabled'].en, { exact: true })).toBeVisible();
    let writes = 0;
    page.on('request', (request) => { if (request.url().endsWith('/ai_set_consent')) writes++; });
    if (action === 'reconcile') {
      await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
        api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
        await route.abort('failed');
      });
      await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
      await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
      await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    } else await page.getByRole('checkbox', { name: messages['aiC.agree'].en }).check();
    await page.route(profileUrl, async (route) => {
      expect(route.request().method()).toBe('GET');
      await route.fulfill({ json: { ...api.profiles[owners.a], display_name: 'Late unconfirmed profile' } });
    });
    // Model an SDK fetch promise that ignores abort until the test releases the actual response.
    await page.evaluate(() => {
      const target = window as AiProfileWindow, original = window.fetch;
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const response = await original(input, init);
        if (new URL(url, location.href).pathname !== '/rest/v1/profiles') return response;
        window.fetch = original;
        return new Promise<Response>((resolve) => {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          if (!signal) throw new Error('Profile read must carry its deadline signal');
          const state: AiProfileWait = { started: performance.now(), aborted: null, released: false,
            release: async () => {
              resolve(response);
              await new Promise((settled) => setTimeout(settled, 100));
              state.released = true;
            } };
          target.aiProfileWait = state;
          signal.addEventListener('abort', () => { state.aborted = performance.now(); }, { once: true });
        });
      };
    });
    const writesBefore = writes;
    await page.getByRole('button', { name: messages[action === 'save' ? 'aiC.enable' : 'aiC.checkConsent'].en, exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as AiProfileWindow).aiProfileWait))).toBe(true);
    await expect(page.locator('#profile-display_name')).toBeDisabled();
    await expect(page.getByRole('button', { name: messages['aiC.checkConsent'].en, exact: true })).toBeEnabled({ timeout: 6500 });
    const deadline = await page.evaluate(() => {
      const state = (window as AiProfileWindow).aiProfileWait!;
      return { elapsed: state.aborted === null ? null : state.aborted - state.started, released: state.released };
    });
    expect(deadline.released).toBe(false);
    expect(deadline.elapsed).not.toBeNull();
    expect(deadline.elapsed).toBeGreaterThanOrEqual(4500);
    expect(deadline.elapsed).toBeLessThan(6000);
    await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    await page.evaluate(async () => { await (window as AiProfileWindow).aiProfileWait!.release(); });
    await expect(page.locator('#profile-display_name')).toHaveValue('Alex');
    await expect(page.locator('.workspace-identity')).not.toContainText('Late unconfirmed profile');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText(messages['aiC.enabled'].en, { exact: true })).toHaveCount(0);
    await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: messages['aiC.enable'].en, exact: true })).toBeDisabled();
    expect(writes - writesBefore).toBe(action === 'save' ? 1 : 0);
    expect(api.profiles[owners.a]).toMatchObject({ version: 2, display_name: 'Alex', ui_language: 'en' });
  });
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`settings ${language}: private fields, preferences, clearing and persistence`, async ({ page }) => {
    const api = await setup(page, language);
    const beforeB = structuredClone(api.profiles[owners.b]);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (request) => { if (request.method() === 'PATCH') patches.push(request.postDataJSON() as Record<string, unknown>); });
    await page.locator('#profile-display_name').fill('Åsa oma stil 🌿');
    await page.locator('#profile-timezone').fill('Europe/Stockholm');
    await page.locator('#profile-currency').fill('SEK');
    await page.getByRole('button', { name: messages['settings.saveProfile'][language] }).click();
    await expect(page.getByText(messages['settings.profileSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-identity')).toContainText('Åsa oma stil 🌿');
    await page.locator('#style-tag').fill('oma 🌿 / egen');
    await page.getByRole('button', { name: messages['settings.addTag'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['colour.green'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['category.footwear'][language], exact: true }).click();
    await page.locator('#minimum_upper_coverage').selectOption('2');
    await page.locator('#cold_sensitivity').selectOption('-2');
    await page.locator('#repeat_gap_days').selectOption('14');
    await page.getByRole('button', { name: messages['settings.savePreferences'][language] }).click();
    await expect(page.getByText(messages['settings.preferencesSaved'][language], { exact: true })).toBeVisible();
    expect(api.preferences[owners.a]).toMatchObject({ style_tags: ['oma 🌿 / egen'], preferred_colours: ['green'], excluded_categories: ['footwear'], minimum_upper_coverage: 2, cold_sensitivity: -2, repeat_gap_days: 14 });
    await page.reload();
    await expect(page.locator('#profile-display_name')).toHaveValue('Åsa oma stil 🌿');
    await expect(page.getByRole('button', { name: messages['colour.green'][language], exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: messages['colour.green'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['category.footwear'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['settings.removeTag'][language].replace('{tag}', 'oma 🌿 / egen') }).click();
    await page.getByRole('button', { name: messages['settings.savePreferences'][language] }).click();
    await expect(page.getByText(messages['settings.preferencesSaved'][language], { exact: true })).toBeVisible();
    expect(api.preferences[owners.a]).toMatchObject({ style_tags: [], preferred_colours: [], excluded_categories: [] });
    expect(api.profiles[owners.b]).toEqual(beforeB);
    expect(patches[0]).toEqual({ display_name: 'Åsa oma stil 🌿', timezone: 'Europe/Stockholm', currency: 'SEK' });
    expect(patches.every((body) => !('owner_id' in body || 'version' in body))).toBe(true);
  });
}
test('consecutive profile/language saves preserve dirty inputs and do not remount', async ({ page }) => {
  const api = await setup(page);
  await page.locator('#profile-display_name').fill('Unsaved private name');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#profile-display_name')).toHaveValue('Unsaved private name');
  await page.getByRole('button', { name: messages['settings.saveProfile'].fi }).click();
  await expect(page.getByText(messages['settings.profileSaved'].fi, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Svenska', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await page.locator('#profile-display_name').fill('Nästa');
  await page.getByRole('button', { name: messages['settings.saveProfile'].sv }).click();
  await expect(page.getByText(messages['settings.profileSaved'].sv, { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ display_name: 'Nästa', ui_language: 'sv', version: 5, timezone: 'Europe/Helsinki', currency: 'EUR' });
});
test('serializes profile and language writes; success retains keyboard focus', async ({ page }) => {
  await setup(page);
  let held: Route | undefined;
  await page.route(profileUrl, async (route) => { if (route.request().method() === 'PATCH') held = route; else await route.fallback(); });
  await page.locator('#profile-display_name').fill('Changed');
  const save = page.getByRole('button', { name: 'Save profile', exact: true });
  await save.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByRole('button', { name: 'Suomi', exact: true })).toBeDisabled();
  await expect(page.locator('#profile-display_name')).toBeDisabled();
  await held!.fallback();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await expect(page.locator('#settings-title')).not.toBeFocused();
});
test('offline preserves inputs and each section reports only its own save', async ({ page, context }) => {
  await setup(page);
  await page.locator('#profile-display_name').fill('Offline name');
  await page.getByRole('button', { name: 'Green', exact: true }).click();
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeDisabled();
  await expect(page.locator('#profile-display_name')).toHaveValue('Offline name');
  await context.setOffline(false);
  await page.route(preferenceUrl, async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 400, json: { message: 'PRIVATE UPSTREAM TEXT' } });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('.settings-preferences [role="alert"]')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Style preferences saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('PRIVATE UPSTREAM TEXT')).toHaveCount(0);
});
test('external focus refresh cannot advance a dirty baseline; explicit conflict re-submit', async ({ page }) => {
  const api = await setup(page);
  await page.locator('#profile-display_name').fill('My draft');
  Object.assign(api.profiles[owners.a]!, { display_name: 'External saved name', currency: 'SEK', version: 2 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.workspace-identity')).toContainText('External saved name');
  await expect(page.locator('#profile-display_name')).toHaveValue('My draft');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep my edits for a new save' })).toBeVisible();
  expect(api.profiles[owners.a]!.display_name).toBe('External saved name');
  let reload: Route | undefined;
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === 'GET') reload = route; else await route.fallback();
  });
  await page.getByRole('button', { name: 'Keep my edits for a new save' }).click();
  await expect.poll(() => Boolean(reload)).toBe(true);
  await expect(page.locator('#profile-display_name')).toHaveValue('My draft');
  await reload!.fulfill({ json: structuredClone(api.profiles[owners.a]) });
  await expect(page.locator('#profile-display_name')).toHaveValue('My draft');
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]!.display_name).toBe('My draft');
});
test('older focus response cannot replace a newer profile save', async ({ page }) => {
  const api = await setup(page);
  const old = structuredClone(api.profiles[owners.a]);
  let held: Route | undefined;
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === 'GET' && !held) held = route; else await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#profile-display_name').fill('Newer saved name');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await held!.fulfill({ json: old });
  await expect(page.locator('.workspace-identity')).toContainText('Newer saved name');
  await expect(page.locator('#profile-display_name')).toHaveValue('Newer saved name');
});
test('empty missing preferences are unavailable, not defaults or an upsert', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' }); delete api.preferences[owners.a];
  await page.goto('/'); await signIn(page);
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#profile-display_name')).toHaveValue('Alex');
  await expect(page.getByText(messages['settings.preferencesUnavailable'].en)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toHaveCount(0);
  expect(api.requests.filter((request) => request.path === '/rest/v1/style_preferences').every((request) => request.method === 'GET')).toBe(true);
});
test('unknown persisted selections and long private tags remain visible and preserved', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const privateTag = 'Private🌿'.repeat(10);
  Object.assign(api.preferences[owners.a]!, { preferred_colours: ['custom-colour'], style_tags: [privateTag] });
  await page.goto('/'); await signIn(page); await settings(page);
  await expect(page.getByText('custom-colour', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: `Remove ${privateTag}`, exact: true })).toBeVisible();
  await page.locator('#cold_sensitivity').selectOption('1');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Style preferences saved.', { exact: true })).toBeVisible();
  expect(api.preferences[owners.a]).toMatchObject({ preferred_colours: ['custom-colour'], style_tags: [privateTag] });
});
test('localized timezone validation and known server rejection preserve input', async ({ page }) => {
  await setup(page);
  await page.locator('#profile-timezone').fill('Mars/Olympus');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText(messages['settings.invalidTimezone'].en)).toBeVisible();
  await page.locator('#profile-timezone').fill('Europe/Stockholm');
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 400, json: { code: 'P0001', message: 'Invalid timezone' } });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText(messages['settings.serverTimezone'].en)).toBeVisible();
  await expect(page.locator('#profile-timezone')).toHaveValue('Europe/Stockholm');
  await expect(page.locator('#profile-timezone')).toHaveAttribute('aria-invalid', 'true');
});
test('dirty settings Back and Forward use one guard without losing history', async ({ page }) => {
  await setup(page);
  await page.locator('#profile-display_name').fill('Unsaved settings');
  await page.evaluate(() => history.back());
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await expect(page.locator('#profile-display_name')).toHaveValue('Unsaved settings');
  await page.evaluate(() => history.back());
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.locator('#profile-display_name')).toHaveValue('Alex');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Add item', exact: true }).first().click();
  await page.locator('#item-title').fill('Unsaved garment');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await expect(page.locator('#item-title')).toHaveValue('Unsaved garment');
});
test('language change preserves unsaved garment draft and owner epoch', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' }); await page.goto('/'); await signIn(page);
  await page.getByRole('button', { name: 'Add item', exact: true }).first().click();
  await page.locator('#item-title').fill('My private garment');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#item-title')).toHaveValue('My private garment');
  await expect(page.locator('#item-category')).toHaveValue('top');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('reload and same-route history entries cannot bypass the dirty settings guard', async ({ page }) => {
  await setup(page);
  await page.reload();
  await expect(page.locator('#profile-display_name')).toHaveValue('Alex');
  await page.locator('#profile-display_name').fill('Retain after reload');
  await page.evaluate(() => history.back());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await expect(page.locator('#profile-display_name')).toHaveValue('Retain after reload');
  await page.evaluate(() => {
    history.pushState({ ...history.state, wardrobePosition: Number(history.state.wardrobePosition) + 1 }, '', '#/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.go(-2);
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await page.evaluate(() => { location.hash = '#/settings?unused'; });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
});
test('preferences conflict preserves selections until explicit reload or re-submit', async ({ page }) => {
  const api = await setup(page);
  await page.getByRole('button', { name: 'Green', exact: true }).click();
  Object.assign(api.preferences[owners.a]!, { preferred_colours: ['blue'], version: 2 });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('.settings-preferences [role="alert"]')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Keep my edits for a new save' }).click();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Style preferences saved.', { exact: true })).toBeVisible();
  expect(api.preferences[owners.a]?.preferred_colours).toEqual(['green']);
  await page.getByRole('button', { name: 'Red', exact: true }).click();
  Object.assign(api.preferences[owners.a]!, { preferred_colours: ['blue'], version: 4 });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.getByRole('button', { name: messages['settings.reload'].en }).click();
  await expect(page.getByRole('button', { name: 'Blue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Red', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeDisabled();
});
test('logout drops dirty settings; lower-version owner and late replies cannot mix', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' }); api.profiles[owners.a]!.version = 90;
  await page.goto('/'); await signIn(page); await settings(page);
  let held: Route | undefined;
  const old = structuredClone(api.profiles[owners.a]);
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes(owners.a)) held = route;
    else await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#profile-display_name').fill('Never show to Robin');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('.workspace-identity')).toContainText('Robin');
  await held!.fulfill({ json: old }).catch(() => {});
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.locator('#profile-display_name')).toHaveValue('Robin');
  await page.locator('#profile-display_name').fill('Robin ändrad');
  await page.getByRole('button', { name: messages['settings.saveProfile'].sv }).click();
  await expect(page.getByText(messages['settings.profileSaved'].sv, { exact: true })).toBeVisible();
  expect(api.profiles[owners.b]!.version).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('settings accessibility: 320px, keyboard, long text and 200% text', async ({ page }) => {
  await setup(page, 'fi');
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('#profile-display_name').fill('Å'.repeat(60));
  await page.getByRole('button', { name: messages['settings.saveProfile'].fi }).click();
  await expect(page.getByText(messages['settings.profileSaved'].fi, { exact: true })).toBeVisible();
  await page.locator('#profile-display_name').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#profile-timezone')).toBeFocused();
  await page.getByRole('button', { name: 'Vihreä', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Vihreä', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 2rem; }' });
  expect(await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > 320
      || getComputedStyle(element).overflowX === 'visible' && [...element.childNodes].some((node) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return false;
        const range = document.createRange(); range.selectNodeContents(node);
        return range.getBoundingClientRect().right > 320;
      }))
      .map((element) => element.parentElement?.className + ' > ' + element.tagName + '.' + element.className),
  }))).toEqual({ viewport: 320, width: 320, overflowing: [] });
});

test('synthetic settings visual evidence retains functional assertions in every project', async ({ page }, testInfo) => {
  const api = await setup(page);
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const directory = path.resolve('test-results/i06-visual');
  const captures = [
    { language: 'en', width: 1280, file: 'profile-en-desktop.png' },
    { language: 'fi', width: 320, file: 'profile-fi-mobile.png' },
  ] as const;
  await page.locator('#style-tag').fill('oma 🌿 / egen');
  await page.getByRole('button', { name: messages['settings.addTag'].en, exact: true }).click();
  await page.getByRole('button', { name: 'Green', exact: true }).click();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Style preferences saved.', { exact: true })).toBeVisible();
  for (const capture of captures) {
    if (capture.language === 'fi') {
      await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
    }
    await page.setViewportSize({ width: capture.width, height: 900 });
    expect(api.profiles[owners.a]?.owner_id === owners.a
      && api.profiles[owners.a]?.ui_language === capture.language
      && api.requests.filter((request) => request.path.startsWith('/rest/'))
        .every((request) => request.owner === owners.a && (request.ownerFilter === `eq.${owners.a}`
          || request.path === '/rest/v1/rpc/ai_status' && request.ownerFilter === null))).toBe(true);
    expect(await page.evaluate(({ origin, language }) => {
      const visible = (element: Element) => element.getClientRects().length > 0
        && getComputedStyle(element).visibility === 'visible';
      const values = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')]
        .filter(visible).map((element) => element.value).join('\n');
      const credentialLike = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      return location.origin === origin && location.hostname === '127.0.0.1'
        && location.hash === '#/settings' && document.documentElement.lang === language
        && Boolean(document.querySelector('#settings-title'))
        && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
        && document.querySelector<HTMLInputElement>('#profile-display_name')?.value === 'Alex'
        && document.querySelector<HTMLInputElement>('#profile-timezone')?.value === 'Europe/Helsinki'
        && document.querySelector<HTMLInputElement>('#profile-currency')?.value === 'EUR'
        && !document.querySelector('input[type="password"], #email, #password')
        && !credentialLike.test(document.body.innerText) && !credentialLike.test(values);
    }, { origin, language: capture.language }), 'Synthetic settings capture guard').toBe(true);
    await expect(page.getByRole('button', { name: messages['colour.green'][capture.language], exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: messages['settings.saveProfile'][capture.language], exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (testInfo.project.name === 'chromium') {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, capture.file), fullPage: true });
    }
  }
  if (testInfo.project.name === 'chromium') {
    expect((await readdir(directory)).sort()).toEqual(captures.map((capture) => capture.file).sort());
    for (const capture of captures) {
      const file = path.join(directory, capture.file);
      const metadata = await lstat(file);
      expect(metadata.isFile() && metadata.size > 24 && metadata.size <= 1024 * 1024, 'Bounded PNG file').toBe(true);
      const handle = await open(file, 'r');
      try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        expect(bytesRead === 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && header.toString('ascii', 12, 16) === 'IHDR' && header.readUInt32BE(16) === capture.width,
        'PNG type and viewport width').toBe(true);
      } finally { await handle.close(); }
    }
  }
});
