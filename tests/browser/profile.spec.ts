import { expect, test, type Page, type Route, type Request as PlaywrightRequest, type Response as PlaywrightResponse } from '@playwright/test';
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
  await expect(page.locator('#profile-timezone')).toBeVisible();
}
const preferenceRequests = (api: { requests: { path: string }[] }) => api.requests.filter((request) => request.path.startsWith('/rest/v1/style_preferences'));
const timeZoneLabel = (page: Page, locale: string, zone: string) => page.evaluate(({ locale, zone }) => {
  const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')!.value;
  return `${zone.split('/').pop()!.replaceAll('_', ' ')} (${name})`;
}, { locale, zone });
const currencyLabel = (page: Page, locale: string, code: string) => page.evaluate(({ locale, code }) =>
  `${new Intl.DisplayNames(locale, { type: 'currency' }).of(code)} (${code})`, { locale, code });
const selectedText = (page: Page, id: string) => page.locator(id).evaluate((select) => (select as HTMLSelectElement).selectedOptions[0]?.text);
async function setup(page: Page, language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language });
  await page.goto('/'); await signIn(page); await settings(page, language);
  return api;
}
const consentCard = (page: Page) => page.locator('section[aria-labelledby="ai-consent-title"]');
// The removed aiC.reviewNotice copy, kept here only to prove it no longer appears.
const removedReviewNotice: Record<Language, string> = { en: 'Review every suggested detail before saving.',
  fi: 'Tarkista kaikki ehdotetut tiedot ennen tallennusta.', sv: 'Granska alla föreslagna uppgifter innan du sparar.' };
const profileUrl = 'http://127.0.0.1:54321/rest/v1/profiles*';
test('AI consent shares profile/language mutex and rebases only its own exact plus-one ACK', async ({ page }) => {
  const api = await aiFixture(page, 'en', false);
  await settings(page);
  await page.locator('#profile-display_name').fill('Preserved unsaved name');
  let held: Route | undefined;
  await page.route('**/rest/v1/rpc/ai_set_consent', (route) => { held = route; });
  await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByRole('button', { name: 'Suomi', exact: true })).toBeDisabled();
  await expect(page.locator('#profile-display_name')).toBeDisabled();
  await held!.fallback();
  await expect(page.getByRole('heading', { name: messages['aiC.enabled'].en, exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    await expect(consentCard(page).getByRole('button', { name: messages['aiC.enable'].en, exact: true })).toHaveCount(0);
    await expect(consentCard(page).getByRole('button', { name: messages['aiC.disable'].en, exact: true })).toHaveCount(0);
    if (failure === 'stale-profile') await page.unroute(profileUrl);
    let writes = 0;
    page.on('request', (request) => { if (request.url().endsWith('/ai_set_consent')) writes++; });
    await consentCard(page).getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
    await expect(page.getByRole('heading', { name: messages['aiC.enabled'].en, exact: true })).toBeVisible();
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
    const countWrite = (request: PlaywrightRequest) => { if (request.url().endsWith('/ai_set_consent')) writes++; };
    if (action === 'reconcile') {
      await page.route('**/rest/v1/rpc/ai_set_consent', async (route) => {
        api.consent.set(owners.a, true); api.profiles[owners.a]!.version = 2;
        await route.abort('failed');
      });
      await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
      await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    }
    const timings = new Map<PlaywrightRequest, { path: string; start: number; elapsed?: number; status?: number }>();
    const recordResponse = (response: PlaywrightResponse) => {
      const timing = timings.get(response.request());
      if (timing) { timing.status = response.status(); timing.elapsed = performance.now() - timing.start; }
    };
    const delay = action === 'save' ? 1500 : 2800;
    const statusLimit = action === 'save' ? 2 : 1;
    let statuses = 0;
    const delayCall = async (route: Route) => {
      if (route.request().method() === 'OPTIONS') { await route.fallback(); return; }
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/ai_status') && ++statuses > statusLimit) { await route.fallback(); return; }
      timings.set(route.request(), { path: pathname, start: performance.now() });
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fallback();
      return;
    };
    await page.route('**/rest/v1/rpc/ai_status', delayCall);
    if (action === 'save') await page.route('**/rest/v1/rpc/ai_set_consent', delayCall);
    await page.route(profileUrl, delayCall);
    page.on('response', recordResponse);
    page.on('request', countWrite);
    try {
      const writesBefore = writes, started = performance.now();
      await consentCard(page).getByRole('button', { name: messages[action === 'save' ? 'aiC.enable' : 'common.retry'].en, exact: true }).click();
      await expect(page.getByRole('heading', { name: messages['aiC.enabled'].en, exact: true })).toBeVisible({ timeout: 12000 });
      expect(performance.now() - started).toBeGreaterThan(5000);
      expect(performance.now() - started).toBeLessThan(20000);
      expect(timings.size).toBe(action === 'save' ? 4 : 2);
      await expect.poll(() => [...timings.values()].every((timing) => timing.elapsed !== undefined)).toBe(true);
      for (const timing of timings.values()) {
        expect(timing.status).toBe(200);
        expect(timing.elapsed).toBeGreaterThanOrEqual(delay - 50);
        expect(timing.elapsed).toBeLessThan(5000);
      }
      expect([...timings.values()].map((timing) => timing.path)).toEqual(action === 'save'
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
    } finally {
      page.off('response', recordResponse);
      page.off('request', countWrite);
      await page.unroute(profileUrl, delayCall);
      await page.unroute('**/rest/v1/rpc/ai_status', delayCall);
      if (action === 'save') await page.unroute('**/rest/v1/rpc/ai_set_consent', delayCall);
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
      await page.getByRole('button', { name: messages['aiC.enable'].en, exact: true }).click();
      await expect(page.getByText(messages['aiC.reconcile'].en, { exact: true }).first()).toBeVisible();
    }
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
    await consentCard(page).getByRole('button', { name: messages[action === 'save' ? 'aiC.enable' : 'common.retry'].en, exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as AiProfileWindow).aiProfileWait))).toBe(true);
    await expect(page.locator('#profile-display_name')).toBeDisabled();
    await expect(consentCard(page).getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeEnabled({ timeout: 6500 });
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
    await expect(consentCard(page).getByRole('button', { name: messages['aiC.enable'].en, exact: true })).toHaveCount(0);
    await expect(consentCard(page).getByRole('button', { name: messages['aiC.disable'].en, exact: true })).toHaveCount(0);
    expect(writes - writesBefore).toBe(action === 'save' ? 1 : 0);
    expect(api.profiles[owners.a]).toMatchObject({ version: 2, display_name: 'Alex', ui_language: 'en' });
  });
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`unconfigured settings ${language}: neutral status without fabricated provider consent`, async ({ page }) => {
    const api = await setup(page, language);
    const consent = page.locator('section[aria-labelledby="ai-consent-title"]');
    await expect(consent.getByText(messages['aiC.inactive'][language], { exact: true })).toBeVisible();
    for (const key of ['aiC.notice', 'aiC.azureNotice', 'aiC.trainingNotice', 'aiC.azureTrainingNotice', 'aiC.offSummary'] as const)
      await expect(consent.getByText(messages[key][language], { exact: true })).toHaveCount(0);
    await expect(consent.getByRole('checkbox')).toHaveCount(0);
    await expect(consent.getByRole('button', { name: messages['aiC.enable'][language], exact: true })).toHaveCount(0);
    await expect(consent.getByRole('button', { name: messages['aiC.disable'][language], exact: true })).toHaveCount(0);
    expect(await consent.evaluate((element) => !element.querySelector('details'))).toBe(true);
    expect(api.requests.filter((request) => request.path.endsWith('/ai_set_consent'))).toHaveLength(0);
  });
  test(`settings ${language}: private fields, pickers and persistence; style preferences stay hidden`, async ({ page }) => {
    const api = await aiFixture(page, language);
    await settings(page, language);
    const consent = page.locator('section[aria-labelledby="ai-consent-title"]');
    // The fixture starts with analysis on: one Turn off, no Turn on, and the notice only inside a closed disclosure.
    await expect(consent.getByRole('heading', { name: messages['aiC.enabled'][language], exact: true })).toBeVisible();
    await expect(consent.getByRole('button', { name: messages['aiC.enable'][language], exact: true })).toHaveCount(0);
    await expect(consent.getByRole('button', { name: messages['aiC.disable'][language], exact: true })).toHaveCount(1);
    await expect(consent.getByRole('checkbox')).toHaveCount(0);
    await expect(consent.locator('details')).toHaveCount(1);
    expect(await consent.locator('details').evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    await expect(consent.getByText(removedReviewNotice[language], { exact: true })).toHaveCount(0);
    await consent.locator('summary').click();
    for (const key of ['aiC.azureNotice', 'aiC.azureTrainingNotice', 'aiC.retentionNotice', 'aiC.allowanceNotice', 'aiC.usageNotice', 'aiC.optOutNotice'] as const) {
      await expect(consent.getByText(messages[key][language], { exact: true })).toBeVisible();
    }
    expect(await consent.evaluate((element) =>
      [...element.querySelectorAll('.fine')].every((copy) => parseFloat(getComputedStyle(copy).fontSize) >= 14)
      && element.querySelector('summary')!.getBoundingClientRect().height >= 44)).toBe(true);
    const beforeB = structuredClone(api.profiles[owners.b]);
    const beforePreferences = structuredClone(api.preferences[owners.a]);
    await expect(page.locator('#profile-timezone')).toHaveJSProperty('tagName', 'SELECT');
    await expect(page.locator('#profile-currency')).toHaveJSProperty('tagName', 'SELECT');
    const patches: Record<string, unknown>[] = [];
    page.on('request', (request) => { if (request.method() === 'PATCH') patches.push(request.postDataJSON() as Record<string, unknown>); });
    await page.locator('#profile-display_name').fill('Åsa oma stil 🌿');
    await page.locator('#profile-timezone').selectOption('Europe/Stockholm');
    await page.locator('#profile-currency').selectOption('SEK');
    await page.getByRole('button', { name: messages['settings.saveProfile'][language] }).click();
    await expect(page.getByText(messages['settings.profileSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-identity')).toContainText('Åsa oma stil 🌿');
    await page.reload();
    await expect(page.locator('#profile-display_name')).toHaveValue('Åsa oma stil 🌿');
    await expect(page.locator('#profile-timezone')).toHaveValue('Europe/Stockholm');
    await expect(page.locator('#profile-currency')).toHaveValue('SEK');
    await expect(page.locator('#preferences-heading')).toHaveCount(0);
    await expect(page.locator('.settings-preferences')).toHaveCount(0);
    expect(preferenceRequests(api)).toEqual([]);
    expect(api.preferences[owners.a]).toEqual(beforePreferences);
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
  await page.locator('#profile-currency').selectOption('SEK');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  await expect(page.locator('#profile-display_name')).toHaveValue('Offline name');
  await expect(page.locator('#profile-currency')).toHaveValue('SEK');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
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
test('settings never reads or writes stored style preferences', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const privateTag = 'Private🌿'.repeat(10);
  Object.assign(api.preferences[owners.a]!, { preferred_colours: ['custom-colour'], style_tags: [privateTag], cold_sensitivity: 2 });
  const stored = structuredClone(api.preferences[owners.a]);
  await page.goto('/'); await signIn(page); await settings(page);
  await expect(page.getByText('custom-colour', { exact: false })).toHaveCount(0);
  await expect(page.getByText(messages['settings.preferencesUnavailable'].en)).toHaveCount(0);
  await expect(page.getByRole('button', { name: messages['settings.savePreferences'].en, exact: true })).toHaveCount(0);
  await page.locator('#profile-display_name').fill('Alex renamed');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  expect(preferenceRequests(api)).toEqual([]);
  expect(api.preferences[owners.a]).toEqual(stored);
});
test('a saved time zone and currency missing from the browser list stay selected and unchanged', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Intl.supportedValuesOf.bind(Intl);
    Intl.supportedValuesOf = ((key: Parameters<typeof Intl.supportedValuesOf>[0]) =>
      original(key).filter((value) => value !== 'Europe/Helsinki' && value !== 'EUR')) as typeof Intl.supportedValuesOf;
  });
  const api = await setup(page);
  expect(await page.evaluate(() => Intl.supportedValuesOf('timeZone').includes('Europe/Helsinki') || Intl.supportedValuesOf('currency').includes('EUR'))).toBe(false);
  await expect(page.locator('#profile-timezone')).toHaveValue('Europe/Helsinki');
  await expect(page.locator('#profile-currency')).toHaveValue('EUR');
  await expect(page.locator('#profile-timezone option[value="Europe/Helsinki"]')).toHaveCount(1);
  await expect(page.locator('#profile-currency option[value="EUR"]')).toHaveCount(1);
  expect(await selectedText(page, '#profile-timezone')).toBe(await timeZoneLabel(page, 'en-GB', 'Europe/Helsinki'));
  expect(await selectedText(page, '#profile-currency')).toBe(await currencyLabel(page, 'en-GB', 'EUR'));
  const patches: unknown[] = [];
  page.on('request', (request) => { if (request.method() === 'PATCH' && request.url().includes('/rest/v1/profiles')) patches.push(request.postDataJSON()); });
  await page.locator('#profile-display_name').fill('Name only');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ display_name: 'Name only', timezone: 'Europe/Helsinki', currency: 'EUR' }]);
  expect(api.profiles[owners.a]).toMatchObject({ timezone: 'Europe/Helsinki', currency: 'EUR' });
});
test('changing language keeps the selected time zone and currency and relabels them', async ({ page }) => {
  const api = await setup(page);
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#profile-timezone')).toHaveValue('Europe/Helsinki');
  await expect(page.locator('#profile-currency')).toHaveValue('EUR');
  await expect.poll(() => selectedText(page, '#profile-timezone')).toBe(await timeZoneLabel(page, 'fi-FI', 'Europe/Helsinki'));
  expect(await selectedText(page, '#profile-currency')).toBe(await currencyLabel(page, 'fi-FI', 'EUR'));
  expect(api.profiles[owners.a]).toMatchObject({ ui_language: 'fi', timezone: 'Europe/Helsinki', currency: 'EUR' });
  await expect(page.getByRole('button', { name: messages['settings.saveProfile'].fi, exact: true })).toBeDisabled();
});
test('without Intl value lists both fields fall back to validated text input', async ({ page }) => {
  await page.addInitScript(() => { delete (Intl as { supportedValuesOf?: unknown }).supportedValuesOf; });
  const api = await setup(page);
  const timezone = page.locator('#profile-timezone');
  const currency = page.locator('#profile-currency');
  await expect(timezone).toHaveJSProperty('tagName', 'INPUT');
  await expect(currency).toHaveJSProperty('tagName', 'INPUT');
  const patches: unknown[] = [];
  page.on('request', (request) => { if (request.method() === 'PATCH' && request.url().includes('/rest/v1/profiles')) patches.push(request.postDataJSON()); });
  await timezone.fill('Mars/Olympus');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['settings.enterTimezone'].en);
  await expect(timezone).toHaveAttribute('aria-invalid', 'true');
  await timezone.fill('Europe/Stockholm');
  await currency.fill('sek');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(messages['settings.enterCurrency'].en);
  await expect(currency).toHaveAttribute('aria-invalid', 'true');
  await expect(timezone).not.toHaveAttribute('aria-invalid', 'true');
  await currency.fill('SEK');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await expect(currency).not.toHaveAttribute('aria-invalid', 'true');
  expect(patches).toEqual([{ display_name: 'Alex', timezone: 'Europe/Stockholm', currency: 'SEK' }]);
  expect(api.profiles[owners.a]).toMatchObject({ timezone: 'Europe/Stockholm', currency: 'SEK' });
});
test('known server time zone rejection keeps the picked value', async ({ page }) => {
  await setup(page);
  await page.locator('#profile-timezone').selectOption('Europe/Stockholm');
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
  await page.keyboard.press('Tab');
  await expect(page.locator('#profile-currency')).toBeFocused();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await page.locator('#profile-timezone').evaluate((select: HTMLSelectElement) => {
    const style = getComputedStyle(select);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return context.measureText(select.selectedOptions[0]!.text).width <= available;
  }), 'Selected time zone label fits the closed select at 320px').toBe(true);
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
  // Clipping inside a closed native select at 200% is left to coordinator visual review.
  for (const id of ['#profile-timezone', '#profile-currency']) {
    expect(await page.locator(id).evaluate((select) => { const box = select.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })).toBe(true);
  }
  expect(await selectedText(page, '#profile-timezone')).toBe(await timeZoneLabel(page, 'fi-FI', 'Europe/Helsinki'));
  expect(await selectedText(page, '#profile-currency')).toBe(await currencyLabel(page, 'fi-FI', 'EUR'));
});

test('synthetic settings visual evidence retains functional assertions in every project', async ({ page }, testInfo) => {
  const api = await setup(page);
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const directory = path.resolve('test-results/i06-visual');
  const captures = [
    { language: 'en', width: 1280, file: 'profile-en-desktop.png' },
    { language: 'fi', width: 320, file: 'profile-fi-mobile.png' },
  ] as const;
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
