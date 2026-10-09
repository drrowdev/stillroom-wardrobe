import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n/all';
import { mockBackend, owners, signIn } from './mock-backend';
import { accountMenu, expectIdentity, expectSignedIn, openAccountMenu, settleShell } from './shell-support';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const cards = (page: Page) => page.locator('.today-card');
const bar = (page: Page) => page.locator('.weather-bar');
const weatherTrigger = (page: Page) => page.locator('#weather-trigger');
async function openDetails(page: Page) {
  await expect(weatherTrigger(page)).toBeVisible();
  if (await weatherTrigger(page).getAttribute('aria-expanded') !== 'true') await weatherTrigger(page).click();
  await expect(bar(page)).toBeVisible();
}
// The Outdoors | Indoors choice on Today.
const place = (page: Page, key: 'setting.outdoors' | 'setting.indoors', language: Language = 'en') =>
  bar(page).getByRole('group', { name: text('weather.place', language) }).getByRole('button', { name: text(key, language), exact: true });
const turnOn = (page: Page, language: Language = 'en') => bar(page).getByRole('link', { name: text('weather.turnOn', language), exact: true });
// The compact details keep the update time and credit on their own readable lines.
async function footerFits(page: Page) {
  const layout = await bar(page).locator('.weather-footer').evaluate(footer => {
    const [updated, credit] = [...footer.children].map(child => child.getBoundingClientRect());
    return { separator: getComputedStyle(footer.children[1]!, '::before').content, ownLine: credit!.top >= updated!.bottom - 0.5,
      fits: [...footer.children].every(child => child.scrollWidth <= child.clientWidth), width: innerWidth };
  });
  expect(layout.separator === 'none' && layout.ownLine && layout.fits, JSON.stringify(layout)).toBe(true);
}
async function detailsFit(page: Page) {
  await expect(bar(page)).toBeVisible();
  const layout = await bar(page).evaluate(panel => {
    const bounds = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const group = panel.querySelector('.weather-place')!, line = panel.querySelector('.weather-line')!;
    const buttons = [...panel.querySelectorAll('button')];
    return { panel: bounds(panel), group: bounds(group), line: bounds(line),
      scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
      controlsFit: buttons.every(button => button.scrollWidth <= button.clientWidth && button.getBoundingClientRect().height >= 44),
      readable: [line, ...buttons].every(element => parseFloat(getComputedStyle(element).fontSize) >= 14) };
  });
  expect(layout.group.bottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.line.top);
  for (const child of [layout.group, layout.line]) {
    expect(child.left).toBeGreaterThanOrEqual(layout.panel.left);
    expect(child.right).toBeLessThanOrEqual(layout.panel.right);
  }
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.controlsFit && layout.readable, JSON.stringify(layout)).toBe(true);
}
const user = { kind: 'user', revision: 1 };
const oulu = { weather_enabled: true, weather_city: 'Oulu, Finland', latitude: 65, longitude: 25.5 };
const malmo = { weather_enabled: true, weather_city: 'Malmö, Sweden', latitude: 55.6, longitude: 13 };
const places = {
  oulu: { id: 1, name: 'Oulu', admin1: 'North Ostrobothnia', country: 'Finland', latitude: 65.01236, longitude: 25.46816 },
  malmo: { id: 2, name: 'Malmö', admin1: 'Skåne', country: 'Sweden', latitude: 55.60587, longitude: 13.00073 },
};

// A reply for the city's local date at `now` and the next, 00:00 to 23:00, with daytime values as given.
type FixtureWeather = { temperature: number; current?: number | null; rain?: number; wind?: number };
function forecastReply(weather: FixtureWeather, offset = 10800, now = Date.now()) {
  const first = new Date(now + offset * 1000).toISOString().slice(0, 10);
  const time: string[] = [], temperature: number[] = [], rain: number[] = [], wind: number[] = [];
  for (let index = 0; index < 48; index++) {
    const day = new Date(Date.parse(`${first}T00:00:00Z`) + Math.floor(index / 24) * 86400000).toISOString().slice(0, 10);
    const hour = index % 24;
    time.push(`${day}T${String(hour).padStart(2, '0')}:00`);
    const daytime = hour >= 7 && hour <= 21;
    temperature.push(daytime ? weather.temperature : weather.temperature - 15);
    rain.push(daytime ? weather.rain ?? 5 : 100);
    wind.push(daytime ? weather.wind ?? 2 : 40);
  }
  return { latitude: 65, longitude: 25.5, timezone: 'Europe/Helsinki', utc_offset_seconds: offset,
    current_units: { time: 'iso8601', temperature_2m: '°C' },
    current: { time: new Date(Math.floor(now / 900_000) * 900_000 + offset * 1000).toISOString().slice(0, 16),
      temperature_2m: weather.current === undefined ? weather.temperature : weather.current },
    hourly: { time, temperature_2m: temperature, precipitation_probability: rain, wind_speed_10m: wind } };
}

const cors = { 'access-control-allow-origin': '*' };
const reply = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});

// Stands in for Open-Meteo. Registered after the mock backend, so it runs before the backend's default block. Any other
// external host is refused and recorded, and every test checks that none was asked.
let unexpected: string[] = [];
test.beforeEach(() => { unexpected = []; });
test.afterEach(() => { expect(unexpected).toEqual([]); });
async function service(page: Page) {
  const state = {
    requests: [] as URL[],
    completedForecasts: 0,
    results: [places.oulu] as Row[],
    weather: new Map<string, FixtureWeather>([['65.0', { temperature: 0 }], ['55.6', { temperature: 12 }]]),
    status: { search: 200, forecast: 200 },
    hold: { search: false, forecast: new Set<string>() },
    held: [] as { kind: 'search' | 'forecast'; url: URL; route: Route }[],
    // The instant the stand-in treats as now; tests with a fake page clock set it to match.
    clock: { at: null as number | null },
  };
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1' && !/^(geocoding-api|api)\.open-meteo\.com$/.test(url.hostname), async route => {
    unexpected.push(new URL(route.request().url()).origin);
    await route.abort('blockedbyclient').catch(() => {});
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname.endsWith('open-meteo.com')) state.requests.push(url);
  });
  page.on('requestfinished', request => {
    if (new URL(request.url()).hostname === 'api.open-meteo.com') state.completedForecasts++;
  });
  page.on('requestfailed', request => {
    if (new URL(request.url()).hostname === 'api.open-meteo.com') state.completedForecasts++;
  });
  await page.route(/^https:\/\/geocoding-api\.open-meteo\.com\//, async route => {
    const url = new URL(route.request().url());
    if (state.hold.search) { state.held.push({ kind: 'search', url, route }); return; }
    await reply(route, state.status.search === 200 ? { results: state.results } : { error: true }, state.status.search);
  });
  await page.route(/^https:\/\/api\.open-meteo\.com\//, async route => {
    const url = new URL(route.request().url());
    const latitude = url.searchParams.get('latitude') ?? '';
    if (state.hold.forecast.has(latitude)) { state.held.push({ kind: 'forecast', url, route }); return; }
    await reply(route, state.status.forecast === 200 ? forecastReply(state.weather.get(latitude) ?? { temperature: 20 }, 10800, state.clock.at ?? Date.now()) : { error: true }, state.status.forecast);
  });
  return {
    ...state,
    completedForecasts: () => state.completedForecasts,
    searches: () => state.requests.filter(url => url.hostname === 'geocoding-api.open-meteo.com'),
    forecasts: () => state.requests.filter(url => url.hostname === 'api.open-meteo.com'),
    async release(kind: 'search' | 'forecast', body: unknown, status = 200) {
      const entry = state.held.find(held => held.kind === kind);
      if (!entry) throw new Error(`No held ${kind} reply.`);
      state.held.splice(state.held.indexOf(entry), 1);
      await reply(entry.route, body, status);
    },
  };
}
type Service = Awaited<ReturnType<typeof service>>;

let serial = 0;
function add(api: Api, title: string, fields: Row, account: 'a' | 'b' = 'a') {
  const seeded = api.seedSavedItem(account, title);
  serial++;
  Object.assign(seeded.item as Row, { seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 1,
    created_at: `2026-09-09T00:00:${String(serial % 60).padStart(2, '0')}Z`, ...fields });
  return seeded.item;
}
// Ankle-length trousers by the owner's own entry, so only the tested weather detail is missing.
function basics(api: Api, account: 'a' | 'b' = 'a', bottom: Row = { lower_coverage: 2, field_provenance: { lower_coverage: user } }) {
  add(api, account === 'a' ? 'White shirt' : 'Robin shirt', { colours: ['white'] }, account);
  add(api, account === 'a' ? 'Navy trousers' : 'Robin trousers', { category: 'bottom', colours: ['navy'], ...bottom }, account);
  add(api, account === 'a' ? 'Black boots' : 'Robin boots', { category: 'footwear', colours: ['black'] }, account);
}

// The mock signs Auth tokens against the real time, while these tests pin the page clock to a fixed hour and move it
// forward by hours. A long token keeps that session valid on the page clock, so only the forecast's age is tested.
const twoDays = 2 * 24 * 3600;
async function start(page: Page, options: { language?: Language; weather?: Row; route?: string; seed?: (api: Api, weather: Service) => void; weatherB?: Row; tokenSeconds?: number; details?: boolean } = {}) {
  const api = await mockBackend(page, { initialLanguage: options.language ?? 'en', ...options.tokenSeconds && { auth: { lifetime: options.tokenSeconds } }, weather: { ...options.weather && { a: options.weather }, ...options.weatherB && { b: options.weatherB } } });
  const weather = await service(page);
  options.seed?.(api, weather);
  await page.goto(`/#/${options.route ?? 'today'}`); await signIn(page);
  await expectSignedIn(page);
  if (options.route === 'settings') await settingsFocused(page);
  else if (options.details !== false) await openDetails(page);
  return { api, weather };
}
// Settings becomes visible before the lazy boundary's ready effect runs. That effect no longer takes focus from a control
// in the page (FOCUS1), but the waits stay: they pin the route focus itself and keep typing after it.
async function settingsFocused(page: Page) {
  await expect(page.locator('#settings-title, #weather-heading, #stylist-heading').and(page.locator(':focus'))).toHaveCount(1);
}
async function goTo(page: Page, route: 'today' | 'settings') {
  const changed = await page.evaluate(target => { const before = location.hash; location.hash = `#/${target}`; return before !== location.hash; }, route);
  await expect(page.locator(route === 'today' ? '#today-title' : '#settings-title')).toBeVisible();
  if (route === 'settings' && changed) await settingsFocused(page);
  if (route === 'today') await openDetails(page);
}
async function signOut(page: Page, language: Language) {
  await openAccountMenu(page, language);
  await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut', language), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
}
const celsius = (page: Page, value: number, language: Language = 'en') => page.evaluate(({ value, locale }) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: 'celsius', maximumFractionDigits: 0 }).format(value), { value, locale: locales[language] });
async function lowLine(page: Page, value: number, language: Language = 'en') {
  return text('weather.low', language, { temperature: await celsius(page, value, language) });
}
async function currentLine(page: Page, value: number, language: Language = 'en') {
  return text('weather.current', language, { temperature: await celsius(page, value, language) });
}
async function search(page: Page, query: string, language: Language = 'en') {
  await page.locator('#weather-city').fill(query);
  await button(page, 'common.search', language).click();
}

for (const language of ['en', 'fi', 'sv'] as const) test(`WEATHER2 ${language}: the header shows current temperature, distinct from the daytime low`, async ({ page }) => {
  const at = Date.parse('2026-10-08T11:05:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { language, weather: oulu, details: false, seed: (api, service) => {
    basics(api); service.clock.at = at; service.weather.set('65.0', { temperature: 6, current: 13, rain: 2, wind: 7 });
  } });
  const low = await lowLine(page, 6, language);
  const current = await currentLine(page, 13, language);
  await expect(weatherTrigger(page)).toHaveText(current);
  await expect(weatherTrigger(page)).toHaveAccessibleName(text('weather.summaryLabel', language, { summary: current }));
  await expect(weatherTrigger(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.workspace-header #weather-trigger')).toHaveCount(1);
  await expect(page.locator('.today-page .weather-bar')).toHaveCount(0);
  await expect(bar(page)).toBeHidden();
  await openDetails(page);
  await expect(bar(page).locator('.weather-heading')).toContainText('Oulu');
  await expect(bar(page).locator('.weather-chips li')).toHaveText([
    low, text('weather.rain', language, { chance: new Intl.NumberFormat(locales[language], { style: 'percent' }).format(.02) }),
    text('weather.wind', language, { speed: new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'meter-per-second' }).format(7) }),
  ]);
  await expect(bar(page).getByRole('link', { name: 'Open-Meteo.com' })).toBeVisible();
  const hours = bar(page).locator('.weather-hours li');
  await expect(hours).toHaveCount(15);
  await expect(hours.first().locator('time')).toHaveAttribute('datetime', '2026-10-08T07:00');
  await expect(hours.last().locator('time')).toHaveAttribute('datetime', '2026-10-08T21:00');
  await expect(hours.locator('span')).toHaveText(Array(15).fill(await celsius(page, 6, language)));
  await expect(bar(page).locator('.weather-current-time')).toHaveText(text('weather.currentEstimate', language, {
    time: await page.evaluate(({ locale, time }) => new Intl.DateTimeFormat(locale, {
      timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(time), { locale: locales[language], time: at - 5 * 60_000 }),
  }));
  await expect(bar(page).locator('.weather-footer')).toContainText(text('weather.updated', language, { time: '' }).trim());
  await bar(page).getByRole('button', { name: text('common.close', language), exact: true }).click();
  await expect(weatherTrigger(page)).toBeFocused();
  await openDetails(page);
  expect(weather.forecasts()).toHaveLength(1);
});

test('WEATHER1 disclosure: Escape and Close return focus; outside taps and leaving focus do not steal it', async ({ page }) => {
  await start(page, { weather: oulu, details: false, seed: api => basics(api) });
  const trigger = weatherTrigger(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused();
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(bar(page).getByRole('button', { name: text('common.close'), exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(place(page, 'setting.outdoors')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Space');
  await expect(bar(page)).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(bar(page)).toBeHidden();
  await openDetails(page);
  await place(page, 'setting.outdoors').focus();
  const occasion = page.getByRole('combobox', { name: text('outfits.occasion'), exact: true });
  await occasion.focus();
  await expect(bar(page)).toBeHidden();
  await expect(occasion).toBeFocused();
  await expect(page.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
});

test('WEATHER1 closing the details preserves entered temperature, while Cancel and Indoors keep their original meaning', async ({ page }) => {
  await start(page, { seed: api => basics(api) });
  await button(page, 'weather.enterTemperature').click();
  await page.locator('#weather-temperature').fill('-3');
  await page.keyboard.press('Escape');
  await expect(weatherTrigger(page)).toBeFocused();
  await openDetails(page);
  await expect(page.locator('#weather-temperature')).toHaveValue('-3');
  await button(page, 'weather.useTemperature').focus();
  await page.keyboard.press('Enter');
  await expect(weatherTrigger(page)).toHaveText(text('weather.manualSummary', 'en', { temperature: await celsius(page, -3) }));
  await expect(weatherTrigger(page)).toBeFocused();
  await expect(bar(page)).toContainText(text('weather.manualLine', 'en', { temperature: await celsius(page, -3) }));
  await button(page, 'weather.clearManual').focus();
  await page.keyboard.press('Enter');
  await expect(weatherTrigger(page)).toBeFocused();
  await button(page, 'weather.enterTemperature').click();
  await page.locator('#weather-temperature').fill('9');
  await button(page, 'common.cancel').click();
  await button(page, 'weather.enterTemperature').click();
  await expect(page.locator('#weather-temperature')).toHaveValue('');
  await place(page, 'setting.indoors').click();
  await expect(weatherTrigger(page)).toHaveText(text('setting.indoors'));
  await expect(bar(page).locator('.weather-line')).toHaveCount(0);
  await place(page, 'setting.outdoors').click();
  await expect(weatherTrigger(page)).toHaveText(text('weather.noForecast'));
});

test('WEATHER1 a forecast with unknown temperature never invents a header value', async ({ page }) => {
  const { weather } = await start(page, { weather: oulu, details: false, seed: (api, service) => {
    basics(api); service.hold.forecast.add('65.0');
  } });
  await expect(weatherTrigger(page)).toHaveText(text('weather.loadingSummary'));
  await expect.poll(() => weather.held.length).toBe(1);
  const reply = forecastReply({ temperature: 6, rain: 2, wind: 7 });
  await weather.release('forecast', { ...reply, current: null, hourly: { ...reply.hourly, temperature_2m: reply.hourly.time.map(() => null) } });
  await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
  await openDetails(page);
  await expect(bar(page).locator('.weather-chips li')).toHaveCount(2);
  await expect(bar(page)).not.toContainText('°C');
  await expect(bar(page).getByRole('link', { name: 'Open-Meteo.com' })).toBeVisible();
  expect(weather.forecasts()).toHaveLength(1);
});

test('WEATHER1 leaving Today removes the portal; returning and changing language reuse the same forecast', async ({ page }) => {
  const { weather } = await start(page, { weather: oulu, seed: api => basics(api) });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 0));
  await goTo(page, 'settings');
  await expect(weatherTrigger(page)).toHaveCount(0);
  await expect(page.locator('#weather-header-slot')).toBeEmpty();
  await goTo(page, 'today');
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 0));
  await openAccountMenu(page, 'en');
  await expect(bar(page)).toBeHidden();
  await accountMenu(page).getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 0, 'fi'));
  expect(weather.forecasts()).toHaveLength(1);
});

async function visibility(page: Page, hidden: boolean) {
  await page.evaluate(hidden => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function gradualMinute(page: Page, weather: Service) {
  const at = await page.evaluate(() => Date.now());
  let failedAt: number | null = null;
  for (let second = 0; second < 60; second++) {
    weather.clock.at = at + (second + 1) * 1000;
    const previous = weather.forecasts().length;
    await page.clock.runFor(1000);
    const requested = weather.forecasts().length;
    if (requested !== previous) {
      await expect.poll(weather.completedForecasts).toBe(requested);
      if (weather.status.forecast === 503) {
        await expect(bar(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeDisabled();
        failedAt = await page.evaluate(() => Date.now());
      }
    }
  }
  return failedAt;
}

test('WEATHER2 current expiry, held refresh and current-only changes preserve the chosen conservative idea', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:05:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); add(api, 'Grey shirt', { colours: ['grey'] });
    service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  await button(page, 'today.more').click();
  await openDetails(page);
  const idea = await cards(page).first().innerText();
  weather.hold.forecast.add('65.0');
  await page.clock.fastForward('00:10:01');
  await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  expect(weather.forecasts()).toHaveLength(1);
  await page.clock.fastForward('00:01:00');
  await expect.poll(() => weather.held.length).toBe(1);
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  await expect(cards(page).first()).toHaveText(idea, { useInnerText: true });
  await weather.release('forecast', forecastReply({ temperature: 4, current: 18 }, 10800, at + 11 * 60_000));
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 18));
  await expect(cards(page).first()).toHaveText(idea, { useInnerText: true });
  expect(weather.forecasts()).toHaveLength(2);
});

test('WEATHER2 failed refresh and offline keep hourly forecast, with bounded retry and no stale-success loop', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:00:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  weather.status.forecast = 503;
  await page.clock.fastForward('00:16:01');
  await expect(bar(page)).toContainText(text('weather.refreshFailed'));
  await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  await expect(bar(page).locator('.weather-hours li')).toHaveCount(15);
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  const retry = bar(page).getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeDisabled();
  expect(weather.forecasts()).toHaveLength(2);
  await page.clock.fastForward('00:01:01');
  await expect(retry).toBeEnabled();
  expect(weather.forecasts()).toHaveLength(2);
  await page.context().setOffline(true);
  await expect(retry).toBeDisabled();
  await page.clock.fastForward('00:05:00');
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  expect(weather.forecasts()).toHaveLength(2);
  await page.context().setOffline(false);
  weather.status.forecast = 200;
  // The successful reply's valid-time is deliberately old; it must not start a retry loop or claim Now.
  await retry.click();
  await expect(bar(page)).not.toContainText(text('weather.refreshFailed'));
  await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  expect(weather.forecasts()).toHaveLength(3);
  await page.clock.fastForward('00:01:00');
  expect(weather.forecasts()).toHaveLength(3);
});

test('WEATHER2 hidden completion and visible return reuse one refresh, without hidden polling', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:00:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); service.clock.at = at;
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 0));
  await visibility(page, true);
  await page.clock.fastForward('00:30:01');
  await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
  expect(weather.forecasts()).toHaveLength(1);
  weather.hold.forecast.add('65.0');
  await visibility(page, false);
  await expect.poll(() => weather.held.length).toBe(1);
  await visibility(page, true);
  await weather.release('forecast', forecastReply({ temperature: 0, current: 13 }, 10800, at + 30 * 60_000));
  weather.hold.forecast.delete('65.0');
  await visibility(page, false);
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  expect(weather.forecasts()).toHaveLength(2);
  await page.clock.fastForward('00:01:00');
  expect(weather.forecasts()).toHaveLength(2);
});

test('WEATHER2 partial temperatures remain accessible unknown slots, not interpolated values', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:00:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => {
    basics(api); service.clock.at = at; service.hold.forecast.add('65.0');
  } });
  await expect.poll(() => weather.held.length).toBe(1);
  const data = forecastReply({ temperature: -3, current: 0 }, 10800, at);
  const temperatures: (number | null)[] = [...data.hourly.temperature_2m];
  temperatures[8] = null;
  await weather.release('forecast', { ...data, hourly: { ...data.hourly, temperature_2m: temperatures } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 0));
  const hours = bar(page).locator('.weather-hours li');
  await expect(hours).toHaveCount(15);
  await expect(hours.nth(0).locator('span')).toHaveText(await celsius(page, -3));
  await expect(hours.nth(1).locator('span')).toHaveText(text('weather.hourUnknown'));
  await expect(hours.nth(2).locator('span')).toHaveText(await celsius(page, -3));
  await expect(hours.last().locator('time')).toHaveAttribute('datetime', '2026-10-08T21:00');
});

test('WEATHER2 late-quarter cadence has brief grace gaps across successive quarters and retains the alternate idea', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:14:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); add(api, 'Grey shirt', { colours: ['grey'] });
    service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  await button(page, 'today.more').click();
  await openDetails(page);
  const idea = await cards(page).first().innerText();
  await page.clock.pauseAt(at + 10_000);
  for (let minute = 1; minute <= 32; minute++) {
    weather.weather.set('65.0', { temperature: 4, current: minute < 2 ? 13 : minute < 17 ? 18 : minute < 32 ? 19 : 20 });
    await gradualMinute(page, weather);
    const expectedRequests = minute < 2 ? 1 : minute < 17 ? 2 : minute < 32 ? 3 : 4;
    await expect.poll(() => weather.forecasts().length).toBe(expectedRequests);
    if ([1, 16, 31].includes(minute)) await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
    else await expect(weatherTrigger(page)).toHaveText(await currentLine(page, minute < 17 ? 18 : minute < 32 ? 19 : 20));
    await expect(bar(page)).toContainText(await lowLine(page, 4));
    await expect(cards(page).first()).toHaveText(idea, { useInnerText: true });
    await expect(cards(page).first()).toContainText(text('today.addCoat'));
  }
});

test('WEATHER2 gradual failure cadence retains forecast and retries no faster than the normal fifteen-minute fallback', async ({ page }) => {
  const at = Date.parse('2026-10-08T11:14:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  await page.clock.pauseAt(at + 10_000);
  weather.status.forecast = 503;
  for (let minute = 1; minute <= 33; minute++) {
    await gradualMinute(page, weather);
    await expect.poll(() => weather.forecasts().length).toBe(minute < 2 ? 1 : minute < 17 ? 2 : minute < 32 ? 3 : 4);
    await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
    await expect(bar(page)).toContainText(await lowLine(page, 4));
    await expect(cards(page).first()).toContainText(text('today.addCoat'));
    if (minute >= 2) {
      await expect(bar(page)).toContainText(text('weather.refreshFailed'));
      const retry = bar(page).getByRole('button', { name: text('common.retry'), exact: true });
      if ([2, 17, 32].includes(minute)) await expect(retry).toBeDisabled();
      else await expect(retry).toBeEnabled();
    }
  }
});

for (const outcome of ['missing', 'malformed', 'stale', 'future'] as const) test(`WEATHER2 partial-current cadence: ${outcome} success waits the normal interval without a storm`, async ({ page }) => {
  const at = Date.parse('2026-10-08T11:14:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  await page.clock.pauseAt(at + 10_000);
  await page.route(/^https:\/\/api\.open-meteo\.com\//, async route => {
    const now = weather.clock.at!;
    const data = forecastReply({ temperature: 4, current: 18 }, 10800, now);
    const body = { ...data, current: outcome === 'missing' ? undefined : outcome === 'malformed' ? { ...data.current, temperature_2m: '18' }
      : { ...data.current, time: new Date((outcome === 'stale' ? at - 15 * 60_000 : now + 15 * 60_000) + 10800 * 1000).toISOString().slice(0, 16) } };
    await reply(route, body);
  });
  for (let minute = 1; minute <= 33; minute++) {
    await gradualMinute(page, weather);
    await expect.poll(() => weather.forecasts().length).toBe(minute < 2 ? 1 : minute < 17 ? 2 : minute < 32 ? 3 : 4);
    await expect(weatherTrigger(page)).toHaveText(text('weather.currentUnavailable'));
    await expect(bar(page)).toContainText(await lowLine(page, 4));
    await expect(bar(page)).not.toContainText(text('weather.refreshFailed'));
    await expect(cards(page).first()).toContainText(text('today.addCoat'));
  }
});

for (const status of [200, 503]) test(`WEATHER2 held refresh retry joins one request and restores normal cadence after ${status}`, async ({ page }) => {
  const at = Date.parse('2026-10-08T11:14:00Z');
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => {
    basics(api); service.clock.at = at; service.weather.set('65.0', { temperature: 4, current: 13 });
  } });
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13));
  await page.clock.pauseAt(at + 10_000);
  weather.status.forecast = 503;
  let failedAt: number | null = null;
  for (let minute = 0; minute < 16; minute++) {
    const completedAt = await gradualMinute(page, weather);
    if (completedAt !== null) failedAt = completedAt;
  }
  await expect(bar(page)).toContainText(text('weather.refreshFailed'));
  const retry = bar(page).getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeEnabled();
  expect(weather.forecasts()).toHaveLength(2);
  if (failedAt === null) throw new Error('No settled failed refresh.');
  weather.hold.forecast.add('65.0');
  const due = failedAt + 15 * 60_000 + 50;
  const before = await page.evaluate(() => Date.now());
  const steps = Math.ceil((due - before) / 1000);
  for (let step = 0; step < steps && weather.held.length === 0; step++) {
    weather.clock.at = before + (step + 1) * 1000;
    await page.clock.runFor(1000);
    if (weather.forecasts().length === 3) await expect.poll(() => weather.held.length).toBe(1);
  }
  await expect.poll(() => weather.held.length).toBe(1);
  await retry.click();
  expect(weather.forecasts()).toHaveLength(3);
  expect(weather.held).toHaveLength(1);
  const now = await page.evaluate(() => Date.now());
  await weather.release('forecast', forecastReply({ temperature: 4, current: 18 }, 10800, now), status);
  await expect.poll(weather.completedForecasts).toBe(3);
  weather.hold.forecast.delete('65.0');
  weather.status.forecast = 200;
  weather.weather.set('65.0', { temperature: 4, current: 19 });
  if (status === 200) {
    await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 18));
    await expect(bar(page)).not.toContainText(text('weather.refreshFailed'));
  } else {
    await expect(retry).toBeDisabled();
    await expect(bar(page)).toContainText(text('weather.refreshFailed'));
  }
  for (let minute = 1; minute <= 16; minute++) {
    await gradualMinute(page, weather);
    await expect.poll(() => weather.forecasts().length).toBe(minute < 15 || minute === 15 && status === 503 ? 3 : 4);
    await expect(bar(page)).toContainText(await lowLine(page, 4));
    await expect(cards(page).first()).toContainText(text('today.addCoat'));
  }
  await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 19));
  await expect(bar(page)).not.toContainText(text('weather.refreshFailed'));
});

// Delays the lazy route's ready effect: once the city field is inserted, React's scheduler messages (which run the
// commit's passive effects) are held until released. The clock skip makes the scheduler yield instead of running them
// in the same task. A keystroke's own render still flushes them first, as it would on a slow device.
async function holdReadyAfterCityField(page: Page) {
  await page.addInitScript(() => {
    const state = { armed: false, held: false, queue: [] as (() => void)[] };
    (window as unknown as { readyHold: typeof state }).readyHold = state;
    const now = performance.now.bind(performance);
    let skew = 0;
    performance.now = () => now() + skew;
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!;
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      ...descriptor,
      set(this: MessagePort, handler: ((event: MessageEvent) => void) | null) {
        descriptor.set!.call(this, handler && ((event: MessageEvent) => {
          if (state.held) state.queue.push(() => handler.call(this, event)); else handler.call(this, event);
        }));
      },
    });
    const prototype = Node.prototype as unknown as Record<'appendChild' | 'insertBefore', (this: Node, ...args: unknown[]) => unknown>;
    for (const name of ['appendChild', 'insertBefore'] as const) {
      const original = prototype[name];
      prototype[name] = function (this: Node, ...args: unknown[]) {
        const result = original.apply(this, args);
        const node = args[0];
        if (state.armed && !state.held && this.isConnected && node instanceof Element
          && (node.id === 'weather-city' || node.querySelector('#weather-city'))) { state.held = true; skew += 50; }
        return result;
      };
    }
  });
}

test('FOCUS1 a late route-ready effect keeps the focus and every keystroke typed before it', async ({ page }) => {
  await holdReadyAfterCityField(page);
  // Settings arrives late, as on a slow connection: its chunk is held, so it shows through the Suspense retry.
  let releaseChunk = () => {};
  const chunkHeld = new Promise<void>(resolve => {
    void page.route(/\/profile-screen[.-][^/]*$/, async route => { resolve(); await new Promise<void>(go => { releaseChunk = go; }); await route.continue(); });
  });
  const { weather } = await start(page, { seed: api => basics(api) });
  await expect(cards(page).first()).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { readyHold: { armed: boolean } }).readyHold.armed = true;
    location.hash = '#/settings';
  });
  await chunkHeld;
  await expect(page.locator('.chunk-loading')).toBeVisible();
  releaseChunk();
  const field = page.locator('#weather-city');
  await expect(field).toBeVisible();
  // The hold engaged and the ready effect hasn't run: nothing in Settings has focus yet.
  expect(await page.evaluate(() => (window as unknown as { readyHold: { held: boolean } }).readyHold.held)).toBe(true);
  await expect(page.locator('#settings-title')).not.toBeFocused();
  await field.focus();
  await page.keyboard.type('Oulu');
  await page.evaluate(() => {
    const hold = (window as unknown as { readyHold: { held: boolean; queue: (() => void)[] } }).readyHold;
    hold.held = false;
    hold.queue.splice(0).forEach(run => run());
  });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Oulu');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio', { name: 'Oulu, North Ostrobothnia, Finland' })).toBeChecked();
  expect(weather.searches().map(url => url.searchParams.get('name'))).toEqual(['Oulu']);
});

test('I16 sends nothing until Search, then only the typed city; Use this city turns forecasts on and Turn off stops them', async ({ page }) => {
  const { api, weather } = await start(page, { route: 'settings', seed: api => basics(api) });
  const card = page.locator('.weather-card');
  await expect(card.getByText(text('weather.consent'), { exact: true })).toBeVisible();
  const disclosure = await card.locator('#weather-disclosure').boundingBox(), field = await page.locator('#weather-city').boundingBox();
  expect(disclosure!.y).toBeLessThan(field!.y);
  await page.locator('#weather-city').fill('Ou');
  await page.locator('#weather-city').focus();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await openAccountMenu(page, 'en');
  await accountMenu(page).getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await accountMenu(page).getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await goTo(page, 'today');
  await expect(cards(page).first()).toBeVisible();
  await goTo(page, 'settings');
  expect(weather.requests).toEqual([]);

  await search(page, '  Oulu ');
  await expect(page.getByRole('radio', { name: 'Oulu, North Ostrobothnia, Finland' })).toBeChecked();
  expect(weather.searches().map(url => Object.fromEntries(url.searchParams))).toEqual([{ name: 'Oulu', count: '5', language: 'en', format: 'json' }]);
  expect(weather.forecasts()).toEqual([]);
  await button(page, 'weather.useCity').click();
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject(oulu);
  await expect(card.getByText(text('weather.onFor', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();

  await goTo(page, 'today');
  // City and date only: the saved "Oulu, Finland" is shortened and the zone matches the profile's, so it isn't named.
  await expect(bar(page).locator('.weather-heading')).toContainText('Oulu, ');
  await expect(bar(page)).not.toContainText('Finland');
  await expect(bar(page)).not.toContainText('Europe/Helsinki');
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  // Each forecast detail is its own short chip, the low first.
  const chips = bar(page).locator('ul.weather-chips > li.weather-chip');
  await expect(chips.first()).toHaveText(await lowLine(page, 0));
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
  await expect(bar(page).getByRole('link', { name: 'Open-Meteo.com' })).toHaveAttribute('href', 'https://open-meteo.com/');
  await expect(bar(page).locator('.weather-footer')).toContainText(text('weather.credit'));
  await footerFits(page);
  // With a forecast, the only control is Outdoors | Indoors.
  await expect(place(page, 'setting.outdoors')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(turnOn(page)).toHaveCount(0);
  expect(weather.forecasts().map(url => Object.fromEntries(url.searchParams))).toEqual([{ latitude: '65.0', longitude: '25.5',
    current: 'temperature_2m', hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '2' }]);
  // Going back to Today, focus and a language change reuse the forecast held in memory.
  await goTo(page, 'settings'); await goTo(page, 'today');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  if (!await accountMenu(page).isVisible()) await openAccountMenu(page, 'en');
  await accountMenu(page).getByRole('button', { name: 'Svenska', exact: true }).click();
  await expect(bar(page)).toContainText(await lowLine(page, 0, 'sv'));
  expect(weather.forecasts()).toHaveLength(1);
  await accountMenu(page).getByRole('button', { name: 'English', exact: true }).click();

  await goTo(page, 'settings');
  await button(page, 'weather.changeCity').click();
  await expect(page.locator('#weather-city')).toBeVisible();
  await button(page, 'common.cancel').click();
  await expect(page.locator('#weather-city')).toHaveCount(0);
  await button(page, 'weather.turnOff').click();
  await expect(page.getByText(text('weather.savedOff'), { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ weather_enabled: false, weather_city: null, latitude: null, longitude: null });
  const count = weather.requests.length;
  await goTo(page, 'today');
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).not.toContainText('Oulu');
  expect(weather.requests).toHaveLength(count);
});

test('I16 search results: several cities, none found and a busy service keep the choice with the owner', async ({ page }) => {
  const { weather } = await start(page, { route: 'settings' });
  weather.results.splice(0, 1, places.oulu, places.malmo);
  await page.locator('#weather-city').fill('O');
  await expect(button(page, 'common.search')).toBeDisabled();
  expect(weather.requests).toEqual([]);
  await search(page, 'Oul');
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(button(page, 'weather.useCity')).toBeDisabled();
  await page.getByRole('radio', { name: 'Malmö, Skåne, Sweden' }).check();
  await expect(button(page, 'weather.useCity')).toBeEnabled();
  weather.results.splice(0);
  await search(page, 'Nowhere');
  await expect(page.getByText(text('weather.noResults'), { exact: true })).toBeVisible();
  weather.status.search = 429;
  await search(page, 'Oulu');
  await expect(page.getByRole('alert')).toHaveText(text('weather.busy'));
  weather.status.search = 500;
  await search(page, 'Oulu');
  await expect(page.getByRole('alert')).toHaveText(text('weather.searchFailed'));
  expect(weather.forecasts()).toEqual([]);
});

test('I16 an incomplete stored setting sends nothing and offers a new search or Turn off', async ({ page }) => {
  const { api, weather } = await start(page, { weather: { weather_enabled: true, weather_city: null, latitude: 65, longitude: 25.5 }, seed: api => basics(api) });
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).toContainText(text('weather.incompleteToday'));
  await goTo(page, 'settings');
  await expect(page.getByText(text('weather.incomplete'), { exact: true })).toBeVisible();
  await expect(page.locator('#weather-city')).toBeVisible();
  expect(weather.requests).toEqual([]);
  await button(page, 'weather.turnOff').click();
  await expect(page.getByText(text('weather.savedOff'), { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ weather_enabled: false, weather_city: null, latitude: null, longitude: null });
  expect(weather.requests).toEqual([]);
});

test('I16 a failed forecast pauses before Try again, suggestions keep working, and manual entry and Indoors stay available', async ({ page }) => {
  await page.clock.install();
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.status.forecast = 503; } });
  await expect(bar(page)).toContainText(text('weather.failed'));
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeDisabled();
  await expect(button(page, 'weather.enterTemperature')).toBeEnabled();
  await expect(place(page, 'setting.indoors')).toBeEnabled();
  await expect(turnOn(page)).toHaveCount(0);
  await goTo(page, 'settings'); await goTo(page, 'today');
  expect(weather.forecasts()).toHaveLength(1);
  weather.status.forecast = 200;
  await page.clock.fastForward('01:05');
  await bar(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  expect(weather.forecasts()).toHaveLength(2);
  await page.context().setOffline(true);
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await page.context().setOffline(false);
});

test('I16 a forecast stops counting after three hours; suggestions drop it and it is asked for again', async ({ page }) => {
  const at = Date.parse(`${new Date().toISOString().slice(0, 10)}T07:00:00Z`);
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => { basics(api); service.clock.at = at; } });
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  weather.status.forecast = 503;
  await page.clock.fastForward('02:59:00');
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(bar(page)).toContainText(text('weather.refreshFailed'));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  expect(weather.forecasts()).toHaveLength(2);
  weather.status.forecast = 200;
  weather.hold.forecast.add('65.0');
  await page.clock.fastForward('00:01:01');
  await expect(bar(page)).toContainText(text('weather.loading'));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(cards(page).first()).not.toContainText(text('today.addCoat'));
  // "Loading" renders before the mocked route logs the new request.
  await expect.poll(() => weather.forecasts().length).toBe(3);
  await weather.release('forecast', forecastReply({ temperature: 10 }, 10800, at + 3 * 3600_000));
  await expect(bar(page)).toContainText(await lowLine(page, 10));
});

test('I16 a forecast stops counting at the city\'s midnight and the next day\'s is asked for', async ({ page }) => {
  const at = Date.parse(`${new Date().toISOString().slice(0, 10)}T20:50:00Z`);
  await page.clock.install({ time: at });
  const { weather } = await start(page, { weather: oulu, tokenSeconds: twoDays, seed: (api, service) => { basics(api); service.clock.at = at; } });
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  weather.clock.at = at + 11 * 60_000;
  weather.weather.set('65.0', { temperature: 4 });
  await page.clock.fastForward('00:10:01');
  await expect(bar(page)).toContainText(await lowLine(page, 4));
  expect(weather.forecasts()).toHaveLength(2);
});

test('I16 an unfinished outfit still names what the weather needs, without claims', async ({ page }) => {
  await start(page, { weather: oulu, seed: api => {
    add(api, 'White shirt', { colours: ['white'] });
    add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'], lower_coverage: 2, warmth: 4, field_provenance: { lower_coverage: user, warmth: user } });
  } });
  const card = cards(page).first();
  await expect(card).toContainText(text('today.missing', 'en', { categories: text('categoryOne.footwear') }));
  await expect(card).toContainText(text('today.addCoat'));
  await expect(card).not.toContainText(text('today.reasonWarmth'));
});

test('I16 a manual temperature needs no weather setting, is marked as yours and a late forecast never replaces it', async ({ page }) => {
  const { weather } = await start(page, { seed: api => { basics(api); add(api, 'Wool coat', { category: 'outerwear', colours: ['grey'] }); } });
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).toContainText(text('weather.noForecast'));
  await button(page, 'weather.enterTemperature').click();
  await expect(page.locator('#weather-temperature')).toBeFocused();
  for (const bad of ['', 'cold', '51', '2.5']) {
    await page.locator('#weather-temperature').fill(bad);
    await button(page, 'weather.useTemperature').click();
    await expect(page.locator('#weather-temperature-error')).toHaveText(text('weather.invalidTemperature'));
    await expect(page.locator('#weather-temperature')).toHaveAttribute('aria-invalid', 'true');
  }
  await page.locator('#weather-temperature').fill('-5');
  await button(page, 'weather.useTemperature').click();
  await expect(bar(page)).toContainText(text('weather.manualLine', 'en', { temperature: await celsius(page, -5) }));
  await expect(bar(page)).not.toContainText(text('weather.noForecast'));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(cards(page).first()).toContainText('Wool coat');
  expect(weather.requests).toEqual([]);
  await button(page, 'weather.clearManual').click();
  await expect(bar(page)).not.toContainText(await celsius(page, -5));
  await expect(bar(page)).toContainText(text('weather.noForecast'));
  await expect(button(page, 'weather.enterTemperature')).toBeVisible();
  expect(weather.requests).toEqual([]);
});

// Enter temperature is only offered without a forecast; one entered then keeps priority when a forecast arrives later.
test('I16 a manual temperature overrides a forecast, including one that arrives later', async ({ page }) => {
  const { weather } = await start(page, { seed: (api, service) => { basics(api); service.hold.forecast.add('65.0'); } });
  await expect(cards(page).first()).toBeVisible();
  await button(page, 'weather.enterTemperature').click();
  await page.locator('#weather-temperature').fill('22');
  await button(page, 'weather.useTemperature').click();
  const manual = text('weather.manualLine', 'en', { temperature: await celsius(page, 22) });
  await expect(bar(page)).toContainText(manual);
  await goTo(page, 'settings');
  await search(page, 'Oulu');
  await button(page, 'weather.useCity').click();
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();
  await goTo(page, 'today');
  await expect.poll(() => weather.held.length).toBe(1);
  await expect(bar(page)).toContainText(manual);
  await weather.release('forecast', forecastReply({ temperature: -8 }));
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).toContainText(manual);
  await expect(bar(page)).not.toContainText(await lowLine(page, -8));
  await expect(page.getByText(text('today.addCoat'), { exact: true })).toHaveCount(0);
  await button(page, 'weather.clearManual').click();
  await expect(bar(page)).toContainText(await lowLine(page, -8));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
});

test('I16 Indoors turns every weather rule off, including the temperature', async ({ page }) => {
  await start(page, { weather: oulu, seed: api => basics(api) });
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  await expect(place(page, 'setting.outdoors')).toHaveAttribute('aria-pressed', 'true');
  await expect(place(page, 'setting.indoors')).toHaveAttribute('aria-pressed', 'false');
  await place(page, 'setting.indoors').click();
  await expect(place(page, 'setting.indoors')).toHaveAttribute('aria-pressed', 'true');
  await expect(place(page, 'setting.outdoors')).toHaveAttribute('aria-pressed', 'false');
  // UI1 removed the indoors line; the pressed Indoors toggle is the only indication.
  await expect(bar(page)).not.toContainText('Weather isn\'t used indoors.');
  await expect(bar(page)).not.toContainText(await lowLine(page, 0));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(cards(page).first()).not.toContainText(text('today.addCoat'));
  await expect(cards(page).first().getByRole('button', { name: text('today.save'), exact: true })).toBeVisible();
  await place(page, 'setting.outdoors').click();
  await expect(place(page, 'setting.outdoors')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
});

test('Indoors also replaces a manual temperature, and has no temperature actions without a forecast', async ({ page }) => {
  await start(page, { seed: api => basics(api) });
  await button(page, 'weather.enterTemperature').click();
  await page.locator('#weather-temperature').fill('3');
  await button(page, 'weather.useTemperature').click();
  await expect(bar(page)).toContainText(text('weather.manualLine', 'en', { temperature: await celsius(page, 3) }));
  await place(page, 'setting.indoors').click();
  await expect(place(page, 'setting.indoors')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar(page)).not.toContainText(text('weather.noForecast'));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(button(page, 'weather.clearManual')).toHaveCount(0);
  await expect(turnOn(page)).toHaveCount(0);
  await place(page, 'setting.outdoors').click();
  await expect(bar(page)).toContainText(text('weather.noForecast'));
  await expect(bar(page)).not.toContainText(await celsius(page, 3));
});

test('with weather off, Today says there is no forecast and Turn on weather opens the Weather card in Settings', async ({ page }) => {
  const { weather } = await start(page, { seed: api => basics(api) });
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).toContainText(text('weather.noForecast'));
  await expect(turnOn(page)).toHaveAttribute('href', '#/settings');
  await expect(button(page, 'weather.enterTemperature')).toBeVisible();
  await expect(place(page, 'setting.outdoors')).toHaveAttribute('aria-pressed', 'true');
  await turnOn(page).click();
  await expect(page.locator('#settings-title')).toBeVisible();
  await expect(page.locator('#weather-heading')).toBeFocused();
  await expect(page.locator('#weather-city')).toBeVisible();
  expect(weather.requests).toEqual([]);
  // A later, ordinary visit to Settings focuses the page heading again.
  await goTo(page, 'today'); await goTo(page, 'settings');
  await expect(page.locator('#settings-title')).toBeFocused();
});

test('while the forecast loads there are no temperature actions, and Outdoors | Indoors stays available', async ({ page }) => {
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.hold.forecast.add('65.0'); } });
  await expect(bar(page)).toContainText(text('weather.loading'));
  await expect.poll(() => weather.held.length).toBe(1);
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await expect(turnOn(page)).toHaveCount(0);
  await expect(place(page, 'setting.indoors')).toBeEnabled();
  await expect(place(page, 'setting.outdoors')).toBeEnabled();
  await weather.release('forecast', forecastReply({ temperature: 0 }));
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
});

test('an incomplete setting says why there is no forecast and offers only Enter temperature', async ({ page }) => {
  await start(page, { weather: { weather_enabled: true, weather_city: null, latitude: 65, longitude: 25.5 }, seed: api => basics(api) });
  await expect(bar(page)).toContainText(text('weather.incompleteToday'));
  await expect(button(page, 'weather.enterTemperature')).toBeVisible();
  await expect(turnOn(page)).toHaveCount(0);
});

test('going offline before the forecast arrives says so and offers Enter temperature', async ({ page }) => {
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.hold.forecast.add('65.0'); } });
  await expect.poll(() => weather.held.length).toBe(1);
  await expect(button(page, 'weather.enterTemperature')).toHaveCount(0);
  await page.context().setOffline(true);
  await expect(bar(page)).toContainText(text('weather.offline'));
  await expect(button(page, 'weather.enterTemperature')).toBeEnabled();
  await expect(turnOn(page)).toHaveCount(0);
  await page.context().setOffline(false);
});

test('the forecast names its time zone only when it differs from the profile\'s, in plain words', async ({ page }) => {
  await start(page, { weather: oulu, seed: api => { basics(api); api.profiles[owners.a]!.timezone = 'Europe/Stockholm'; } });
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  const zone = await page.evaluate(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', timeZoneName: 'longGeneric' })
    .formatToParts(Date.now()).find(part => part.type === 'timeZoneName')?.value ?? '');
  expect(zone).not.toBe('');
  await expect(bar(page).locator('.weather-heading')).toContainText(`(${zone})`);
  await expect(bar(page)).not.toContainText('Europe/Helsinki');
});

test.describe('I16 weather gaps on each idea, without suitability claims', () => {
  const cases: { name: string; forecast: { temperature: number; rain?: number; wind?: number }; bottom?: Row; extra?: Row; expected: MessageKey[]; absent: MessageKey[] }[] = [
    { name: 'cold with no coat', forecast: { temperature: 0 }, expected: ['today.addCoat'], absent: ['today.reasonWarmth', 'today.checkLength'] },
    { name: 'cold with unknown length, including an unconfirmed value', forecast: { temperature: 0 }, bottom: { lower_coverage: 2 },
      extra: { category: 'outerwear', colours: ['grey'] }, expected: ['today.checkLength'], absent: ['today.addCoat', 'today.reasonWarmth'] },
    { name: 'unknown rain protection, including an unconfirmed value', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 2 }, expected: [], absent: ['today.reasonRain', 'today.noRain', 'today.noCover'] },
    { name: 'unknown wind protection', forecast: { temperature: 15, wind: 12 },
      extra: { category: 'layer', colours: ['grey'], windproof: null, field_provenance: { windproof: user } }, expected: [], absent: ['today.reasonWind', 'today.noCover'] },
    { name: 'protection marked as inadequate', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 0, field_provenance: { rain_rating: user } }, expected: ['today.noRain'], absent: ['today.reasonRain'] },
    { name: 'rain protection confirmed by the owner', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 2, field_provenance: { rain_rating: user } }, expected: ['today.reasonRain'], absent: ['today.noRain'] },
  ];
  for (const entry of cases) test(entry.name, async ({ page }) => {
    await start(page, { weather: oulu, seed: (api, service) => {
      basics(api, 'a', entry.bottom);
      if (entry.extra) add(api, 'Grey cover', entry.extra);
      service.weather.set('65.0', entry.forecast);
    } });
    const card = cards(page).first();
    for (const key of entry.expected) await expect(card).toContainText(text(key));
    for (const key of entry.absent) await expect(card).not.toContainText(text(key));
    await expect(card).not.toContainText(unsaidRain);
    await expect(card).not.toContainText(unsaidWind);
    await expect(card).not.toContainText(text('today.missing', 'en', { categories: text('categoryOne.outerwear') }));
  });
  const lengthAdvice = {
    en: 'Check that these bottoms cover your ankles in cold weather.',
    fi: 'Tarkista, että nämä alaosat peittävät nilkat kylmällä säällä.',
    sv: 'Kontrollera att de här plaggen täcker anklarna i kallt väder.',
  } as const;
  const unsaidLength = /length of these bottoms isn't recorded|pituutta ei ole merkitty|Längden på de här plaggen är inte angiven/i;
  for (const language of ['en', 'fi', 'sv'] as const) test(`unknown length of the bottoms gives the ankle advice in ${language}`, async ({ page }) => {
    await start(page, { language, weather: oulu, seed: (api, service) => {
      basics(api, 'a', { lower_coverage: 2 });
      add(api, 'Grey coat', { category: 'outerwear', colours: ['grey'] });
      service.weather.set('65.0', { temperature: 0 });
    } });
    const missing = cards(page).first().locator('.today-missing');
    await expect(missing).toHaveText(lengthAdvice[language]);
    await expect(missing).toHaveText(text('today.checkLength', language));
    await expect(cards(page).first()).not.toContainText(unsaidLength);
  });
});

// The old English, Finnish and Swedish sentences, matched as text so the checks outlive their catalog keys.
const unsaidRain = /Rain protection|sateenkest|Regnskydd/i;
const unsaidWind = /Wind protection isn't recorded|tuulenpitävyyttä ei ole merkitty|Vindskydd är inte angivet/i;
test.describe('I16 unknown rain protection is not mentioned on Today', () => {
  const forecast = { temperature: 15, rain: 80, wind: 12 };
  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`a complete idea says nothing about it in ${language}`, async ({ page }) => {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api); add(api, 'Grey layer', { category: 'layer', colours: ['grey'], rain_rating: null });
        service.weather.set('65.0', { temperature: 15, rain: 80 });
      } });
      const card = cards(page).first();
      await expect(card).toBeVisible();
      await expect(card.locator('.today-missing')).toHaveCount(0);
      await expect(card).not.toContainText(unsaidRain);
      for (const key of ['today.reasonRain', 'today.noRain', 'today.noCover'] as const) await expect(card).not.toContainText(text(key, language));
    });

    test(`an unfinished idea keeps only its missing-categories line in ${language}`, async ({ page }) => {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        add(api, 'White shirt', { colours: ['white'] });
        add(api, 'Navy trousers', { category: 'bottom', colours: ['navy'], lower_coverage: 2, field_provenance: { lower_coverage: user } });
        add(api, 'Grey layer', { category: 'layer', colours: ['grey'], rain_rating: null });
        service.weather.set('65.0', { temperature: 15, rain: 80 });
      } });
      const card = cards(page).first();
      await expect(card).toContainText(text('today.missing', language, { categories: text('categoryOne.footwear', language) }));
      await expect(card.locator('.today-missing')).toHaveCount(1);
      await expect(card).not.toContainText(unsaidRain);
    });

    test(`unknown rain beside a layer that only resists wind does not claim that nothing suits the weather in ${language}`, async ({ page }) => {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api); add(api, 'Grey layer', { category: 'layer', colours: ['grey'], rain_rating: null, windproof: true, field_provenance: { windproof: user } });
        service.weather.set('65.0', forecast);
      } });
      const card = cards(page).first();
      await expect(card).toBeVisible();
      await expect(card.locator('.today-missing')).toHaveCount(0);
      await expect(card).not.toContainText(text('today.noCover', language));
      await expect(card).not.toContainText(unsaidRain);
    });

    test(`unknown rain and unknown wind show no weather note in ${language}`, async ({ page }) => {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api); add(api, 'Grey layer', { category: 'layer', colours: ['grey'], rain_rating: null, windproof: null, field_provenance: { windproof: user } });
        service.weather.set('65.0', forecast);
      } });
      const card = cards(page).first();
      await expect(card).toBeVisible();
      await expect(card.locator('.today-missing')).toHaveCount(0);
      await expect(card).not.toContainText(unsaidWind);
      await expect(card).not.toContainText(text('today.noCover', language));
      await expect(card).not.toContainText(unsaidRain);
    });
  }
});

for (const [from, to] of [['a', 'b'], ['b', 'a']] as const) {
  test(`I16 a held forecast for one owner never reaches the next (${from} to ${to})`, async ({ page }) => {
    const language = { a: 'en', b: 'sv' } as const;
    const latitude = { a: '65.0', b: '55.6' } as const;
    const city = { a: 'Oulu', b: 'Malmö' } as const;
    const api = await mockBackend(page, { initialLanguage: 'en', weather: { a: oulu, b: malmo } });
    const weather = await service(page);
    basics(api, 'a'); basics(api, 'b');
    weather.hold.forecast.add(latitude[from]);
    await page.goto('/#/today'); await signIn(page, from);
    await expect.poll(() => weather.held.length).toBe(1);
    await signOut(page, language[from]);
    await signIn(page, to);
    await expect(page.locator('#today-title')).toBeVisible();
    await openDetails(page);
    await expect(bar(page)).toContainText(city[to]);
    await weather.release('forecast', forecastReply({ temperature: -30 }));
    await expect(bar(page)).toContainText(city[to]);
    await expect(bar(page)).not.toContainText(city[from]);
    await expect(bar(page)).not.toContainText(await celsius(page, -30, language[to]));
  });
}

test('I16 a held forecast or search is dropped after a city change, Turn off or signing out', async ({ page }) => {
  const { api, weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.hold.forecast.add('65.0'); } });
  await expect.poll(() => weather.held.length).toBe(1);
  await goTo(page, 'settings');
  await button(page, 'weather.changeCity').click();
  weather.results.splice(0, 1, places.malmo);
  await search(page, 'Malmö');
  await button(page, 'weather.useCity').click();
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Malmö, Sweden' }), { exact: true })).toBeVisible();
  await goTo(page, 'today');
  await expect(bar(page)).toContainText('Malmö');
  await weather.release('forecast', forecastReply({ temperature: -30 }));
  await expect(bar(page)).toContainText(await lowLine(page, 12));
  await expect(bar(page)).not.toContainText('Oulu');

  weather.hold.forecast.add('65.0');
  await goTo(page, 'settings');
  await button(page, 'weather.changeCity').click();
  weather.results.splice(0, 1, places.oulu);
  await search(page, 'Oulu');
  await button(page, 'weather.useCity').click();
  // Navigation is held back while a profile save is in progress, so wait for the save as above.
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();
  await goTo(page, 'today');
  await expect.poll(() => weather.held.length).toBe(1);
  await goTo(page, 'settings');
  await button(page, 'weather.turnOff').click();
  await expect(page.getByText(text('weather.savedOff'), { exact: true })).toBeVisible();
  await goTo(page, 'today');
  await weather.release('forecast', forecastReply({ temperature: -30 }));
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).not.toContainText('Oulu');
  await expect(bar(page)).not.toContainText(await celsius(page, -30));
  expect(api.profiles[owners.a]!.weather_enabled).toBe(false);

  await goTo(page, 'settings');
  weather.hold.search = true;
  await search(page, 'Oulu');
  await expect.poll(() => weather.held.length).toBe(1);
  await signOut(page, 'en');
  await signIn(page, 'b');
  await expectIdentity(page, 'Robin');
  await goTo(page, 'settings');
  await weather.release('search', { results: [places.oulu] });
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('#weather-city')).toHaveValue('');
  expect(api.profiles[owners.b]).toMatchObject({ weather_enabled: false, weather_city: null });
});

test('I16 weather, language and profile saves interleave, and a stale weather save asks to reload', async ({ page }) => {
  const { api } = await start(page, { route: 'settings' });
  await search(page, 'Oulu');
  await button(page, 'weather.useCity').click();
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();
  await openAccountMenu(page, 'en');
  await accountMenu(page).getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.locator('#profile-display_name').fill('Alex K');
  await button(page, 'settings.saveProfile', 'fi').click();
  await expect(page.getByText(text('settings.profileSaved', 'fi'), { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ ...oulu, ui_language: 'fi', display_name: 'Alex K' });
  await expect(page.getByText(text('weather.onFor', 'fi', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();

  api.profiles[owners.a]!.version = Number(api.profiles[owners.a]!.version) + 5;
  api.profiles[owners.a]!.display_name = 'Changed elsewhere';
  await button(page, 'weather.turnOff', 'fi').click();
  await expect(page.getByRole('alert')).toHaveText(text('error.conflict', 'fi'));
  expect(api.profiles[owners.a]).toMatchObject(oulu);
  await button(page, 'settings.reload', 'fi').click();
  await expect(page.locator('#profile-display_name')).toHaveValue('Changed elsewhere');
  await button(page, 'weather.turnOff', 'fi').click();
  await expect(page.getByText(text('weather.savedOff', 'fi'), { exact: true })).toBeVisible();
  expect(api.profiles[owners.a]).toMatchObject({ weather_enabled: false, display_name: 'Changed elsewhere', ui_language: 'fi' });
});

test('I16 accessibility: axe, keyboard, 320px and 200% text for the weather card and forecast line', async ({ page }) => {
  await start(page, { weather: oulu, seed: api => basics(api) });
  const axe = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await axe();
  await place(page, 'setting.indoors').focus();
  await page.keyboard.press('Enter');
  await expect(place(page, 'setting.indoors')).toHaveAttribute('aria-pressed', 'true');
  await axe();
  await page.keyboard.press('Shift+Tab');
  await expect(place(page, 'setting.outdoors')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  // Without a forecast: No forecast, Turn on weather and the temperature form with its error.
  await goTo(page, 'settings');
  await button(page, 'weather.turnOff').click();
  await expect(page.getByText(text('weather.savedOff'), { exact: true })).toBeVisible();
  await goTo(page, 'today');
  await expect(turnOn(page)).toBeVisible();
  await axe();
  await button(page, 'weather.enterTemperature').click();
  await button(page, 'weather.useTemperature').click();
  await expect(page.locator('#weather-temperature-error')).toBeVisible();
  await axe();
  await button(page, 'common.cancel').click();
  await goTo(page, 'settings');
  await search(page, 'Oulu');
  await expect(page.getByRole('radio')).toHaveCount(1);
  await axe();
  await button(page, 'weather.useCity').click();
  await expect(page.getByText(text('weather.savedOn', 'en', { city: 'Oulu, Finland' }), { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const route of ['settings', 'today'] as const) for (const zoom of [false, true]) {
    await goTo(page, route);
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (route === 'today') {
      await expect(bar(page)).toContainText(await lowLine(page, 0));
      await footerFits(page);
      // Both choices stay whole and inside the bar.
      for (const key of ['setting.outdoors', 'setting.indoors'] as const) {
        expect(await place(page, key).evaluate(element => {
          const box = element.getBoundingClientRect(), parent = element.closest('.weather-bar')!.getBoundingClientRect();
          return element.scrollWidth <= element.clientWidth && box.left >= parent.left && box.right <= parent.right;
        })).toBe(true);
      }
      await place(page, 'setting.indoors').focus();
      await page.keyboard.press('Enter');
      await expect(place(page, 'setting.indoors')).toHaveAttribute('aria-pressed', 'true');
      await place(page, 'setting.outdoors').click();
    }
    await axe();
  }
});

test.describe('WEATHER1 visual', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    ...(['en', 'fi', 'sv'] as const).flatMap(language => [
      { scene: 'compact' as const, language, width: 390, project: 'mobile', suffix: `${language}-narrow` },
      { scene: 'compact' as const, language, width: 1280, project: 'chromium', suffix: `${language}-wide` },
    ]),
    { scene: 'details' as const, language: 'en' as const, width: 320, project: 'mobile', suffix: 'en-narrow' },
    { scene: 'manual-error' as const, language: 'en' as const, width: 320, project: 'mobile', suffix: 'en-narrow' },
  ];
  for (const selected of scenes) test(`${selected.scene} ${selected.suffix}`, async ({ page }, testInfo) => {
    const at = Date.parse('2026-10-08T07:00:00Z');
    await page.clock.install({ time: at });
    await page.setViewportSize({ width: selected.width, height: 900 });
    const { weather } = await start(page, { language: selected.language, weather: oulu, details: false, tokenSeconds: twoDays,
      seed: (api, service) => {
        basics(api); service.clock.at = at;
        service.weather.set('65.0', { temperature: 6, rain: 2, wind: 7 });
        if (selected.scene === 'manual-error') service.status.forecast = 503;
      } });
    await expectIdentity(page, 'Alex');
    if (selected.scene === 'manual-error') {
      await expect(weatherTrigger(page)).toHaveText(text('weather.unavailableSummary', selected.language));
      await openDetails(page);
      await expect(bar(page)).toContainText(text('weather.failed'));
      await expect(bar(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeDisabled();
      await button(page, 'weather.enterTemperature').click();
      await page.locator('#weather-temperature').fill('cold');
      await button(page, 'weather.useTemperature').click();
      await expect(page.locator('#weather-temperature-error')).toHaveText(text('weather.invalidTemperature'));
    } else {
      await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 6, selected.language));
      await expect(bar(page)).toBeHidden();
      if (selected.scene === 'details') {
        await openDetails(page);
        await expect(bar(page).locator('.weather-heading')).toContainText('Oulu');
        await expect(bar(page).locator('.weather-chips li')).toHaveCount(3);
        await footerFits(page);
      }
    }
    await expect(cards(page).first()).toBeVisible();
    if (selected.scene === 'compact') await expect(bar(page)).toBeHidden();
    else await expect(bar(page)).toBeVisible();
    expect(weather.forecasts()).toHaveLength(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ language, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
        .filter(field => field.getClientRects().length).map(field => field.value).join('\n');
      return location.hostname === '127.0.0.1' && document.documentElement.lang === language && innerWidth === width && innerHeight === 900
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
        && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
    }, { language: selected.language, width: selected.width })).toBe(true);
    if (testInfo.project.name !== selected.project) return;
    const directory = path.resolve('test-results/weather1-visual');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  });
});

test.describe('bounded I16 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'settings', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'settings', project: 'mobile', language: 'fi', width: 320, zoom: false, suffix: 'fi-mobile' },
    { scene: 'today-forecast', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'today-forecast', project: 'mobile', language: 'fi', width: 320, zoom: false, suffix: 'fi-mobile' },
    { scene: 'today-forecast', project: 'mobile', language: 'fi', width: 320, zoom: true, suffix: 'fi-320-200' },
    { scene: 'today-off', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'today-off', project: 'mobile', language: 'sv', width: 320, zoom: true, suffix: 'sv-320-200' },
    { scene: 'today-indoors', project: 'mobile', language: 'sv', width: 320, zoom: false, suffix: 'sv-mobile' },
    { scene: 'today-unavailable', project: 'mobile', language: 'fi', width: 320, zoom: false, suffix: 'fi-mobile' },
    { scene: 'today-unknown-rain', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'today-unknown-rain', project: 'mobile', language: 'fi', width: 320, zoom: false, suffix: 'fi-mobile' },
    { scene: 'today-unknown-rain', project: 'mobile', language: 'sv', width: 320, zoom: true, suffix: 'sv-320-200' },
    { scene: 'today-check-length', project: 'chromium', language: 'en', width: 1280, zoom: false, suffix: 'en-desktop' },
    { scene: 'today-check-length', project: 'mobile', language: 'fi', width: 320, zoom: false, suffix: 'fi-mobile' },
  ] as const;
  for (const selected of scenes) test(`${selected.scene} ${selected.suffix} retains functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
    const language: Language = selected.language;
    const write = testInfo.project.name === selected.project;
    const directory = path.resolve('test-results/i16-visual');
    if (write) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    }
    await page.setViewportSize({ width: selected.width, height: 900 });
    if (selected.scene === 'settings') {
      await start(page, { language, route: 'settings' });
      await search(page, 'Oulu', language);
      await expect(page.getByRole('radio')).toHaveCount(1);
    } else if (selected.scene === 'today-forecast') {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api); add(api, 'Grey rain jacket', { category: 'outerwear', colours: ['grey'], rain_rating: 2, field_provenance: { rain_rating: user } });
        service.weather.set('65.0', { temperature: 4, rain: 70, wind: 6 });
      } });
      await expect(bar(page)).toContainText(await lowLine(page, 4, language));
      await footerFits(page);
      await expect(cards(page).first()).toContainText(text('today.reasonRain', language));
      await expect(button(page, 'weather.enterTemperature', language)).toHaveCount(0);
    } else if (selected.scene === 'today-off') {
      await start(page, { language, seed: api => basics(api) });
      await expect(bar(page)).toContainText(text('weather.noForecast', language));
      await expect(turnOn(page, language)).toBeVisible();
      await expect(button(page, 'weather.enterTemperature', language)).toBeVisible();
      await expect(cards(page).first()).toBeVisible();
    } else if (selected.scene === 'today-indoors') {
      await start(page, { language, weather: oulu, seed: api => basics(api) });
      await expect(bar(page)).toContainText(await lowLine(page, 0, language));
      await place(page, 'setting.indoors', language).click();
      await expect(place(page, 'setting.indoors', language)).toHaveAttribute('aria-pressed', 'true');
      await expect(cards(page).first()).toBeVisible();
    } else if (selected.scene === 'today-unknown-rain') {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api); add(api, 'Grey layer', { category: 'layer', colours: ['grey'], rain_rating: null });
        service.weather.set('65.0', { temperature: 12, rain: 70, wind: 4 });
      } });
      await expect(bar(page)).toContainText(await lowLine(page, 12, language));
      await expect(cards(page).first()).toBeVisible();
      await expect(cards(page).first().locator('.today-missing')).toHaveCount(0);
      await expect(cards(page).first()).not.toContainText(unsaidRain);
    } else if (selected.scene === 'today-check-length') {
      await start(page, { language, weather: oulu, seed: (api, service) => {
        basics(api, 'a', { lower_coverage: 2 }); add(api, 'Grey coat', { category: 'outerwear', colours: ['grey'] });
        service.weather.set('65.0', { temperature: 0 });
      } });
      await expect(bar(page)).toContainText(await lowLine(page, 0, language));
      await expect(cards(page).first().locator('.today-missing')).toHaveText(text('today.checkLength', language));
      await expect(button(page, 'weather.enterTemperature', language)).toHaveCount(0);
    } else {
      await start(page, { language, weather: oulu, seed: (api, service) => { basics(api); service.status.forecast = 503; } });
      await expect(bar(page)).toContainText(text('weather.failed', language));
      await expect(cards(page).first()).toBeVisible();
    }
    expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
    if (selected.zoom) {
      await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      expect(await place(page, 'setting.outdoors', language).evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(27);
    }
    await expectIdentity(page, 'Alex');
    if (selected.scene.startsWith('today')) await openDetails(page);
    if (selected.scene === 'today-indoors') await expect(bar(page).locator('.weather-line')).toHaveCount(0);
    // Indoors shows no weather line since UI1, so only the other Today scenes have one to place the choice against.
    else if (selected.scene.startsWith('today')) {
      // The place choice leads the forecast inside the header disclosure at every width.
      await detailsFit(page);
      if (selected.scene === 'today-forecast' && selected.zoom) {
        await page.setViewportSize({ width: selected.width, height: 568 });
        await settleShell(page);
        await detailsFit(page);
        await page.setViewportSize({ width: selected.width, height: 900 });
        await settleShell(page);
      }
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(({ expectedLanguage, width }) => {
      const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
        .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
      return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width && innerHeight === 900
        && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
        && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
    }, { expectedLanguage: language, width: selected.width })).toBe(true);
    if (selected.scene === 'today-check-length') {
      // The advice must show in the image itself: close the weather details, bring the sentence to the middle of the view and check nothing is drawn over it.
      await weatherTrigger(page).click();
      await expect(weatherTrigger(page)).toHaveAttribute('aria-expanded', 'false');
      const advice = cards(page).first().locator('.today-missing');
      await advice.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await expect(advice).toBeInViewport({ ratio: 1 });
      expect(await advice.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const points = [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.top + 2], [rect.left + 2, rect.bottom - 2], [rect.right - 2, rect.bottom - 2], [rect.left + rect.width / 2, rect.top + rect.height / 2]] as const;
        return points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))) && element.scrollWidth <= element.clientWidth;
      }), 'The advice sentence is not covered or clipped').toBe(true);
    }
    if (!write) return;
    const png = await page.screenshot({ fullPage: selected.scene !== 'today-check-length', animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === selected.width).toBe(true);
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'wx');
    try { await file.writeFile(png); } finally { await file.close(); }
  });

});

test.describe('WEATHER2 visual', () => {
    test.describe.configure({ retries: 0 });
    const scenes = (['en', 'fi', 'sv'] as const).flatMap(language => [
      { language, width: 320, height: 568, project: 'mobile', suffix: `${language}-narrow` },
      { language, width: 1280, height: 900, project: 'chromium', suffix: `${language}-wide` },
    ]);
    for (const selected of scenes) test(`current and hourly ${selected.suffix}`, async ({ page }, testInfo) => {
      const at = Date.parse('2026-10-08T11:05:00Z');
      await page.clock.install({ time: at });
      await page.setViewportSize({ width: selected.width, height: selected.height });
      const { weather } = await start(page, { language: selected.language, weather: oulu, tokenSeconds: twoDays,
        seed: (api, service) => { basics(api); service.clock.at = at; service.hold.forecast.add('65.0'); } });
      await expect.poll(() => weather.held.length).toBe(1);
      const data = forecastReply({ temperature: 6, current: 13, rain: 2, wind: 7 }, 10800, at);
      data.hourly.temperature_2m = data.hourly.time.map(time => {
        const hour = Number(time.slice(11, 13));
        return hour < 10 ? 6 : hour < 13 ? 10 : hour < 17 ? 14 : 8;
      });
      await weather.release('forecast', data);
      await expect(weatherTrigger(page)).toHaveText(await currentLine(page, 13, selected.language));
      await expect(bar(page)).toContainText(await lowLine(page, 6, selected.language));
      const hours = bar(page).locator('.weather-hours li');
      await expect(hours).toHaveCount(15);
      await expect(hours.first().locator('time')).toHaveAttribute('datetime', '2026-10-08T07:00');
      await expect(hours.last().locator('time')).toHaveAttribute('datetime', '2026-10-08T21:00');
      await expect(hours.first().locator('span')).toHaveText(await celsius(page, 6, selected.language));
      await expect(hours.nth(7).locator('span')).toHaveText(await celsius(page, 14, selected.language));
      await expect(hours.last().locator('span')).toHaveText(await celsius(page, 8, selected.language));
      await expectIdentity(page, 'Alex');
      await openDetails(page);
      await detailsFit(page);
      await footerFits(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const zoom = await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      await detailsFit(page);
      await hours.last().scrollIntoViewIfNeeded();
      expect(await bar(page).locator('.weather-hours').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await zoom.evaluate(element => { element.parentNode?.removeChild(element); });
      await bar(page).evaluate(element => { element.scrollTop = 0; });
      await detailsFit(page);
      expect(weather.forecasts()).toHaveLength(1);
      expect(await page.evaluate(({ language, width, height }) => {
        const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
          .filter(field => field.getClientRects().length).map(field => field.value).join('\n');
        return location.hostname === '127.0.0.1' && document.documentElement.lang === language && innerWidth === width && innerHeight === height
          && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
          && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
      }, selected)).toBe(true);
      if (testInfo.project.name !== selected.project) return;
      const directory = path.resolve('test-results/weather2-visual');
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      const png = await page.screenshot({ fullPage: false, animations: 'disabled', type: 'png', scale: 'css' });
      expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && png.readUInt32BE(16) === selected.width && png.readUInt32BE(20) === selected.height).toBe(true);
      const file = await open(path.join(directory, `current-hourly-${selected.suffix}.png`), 'wx');
      try { await file.writeFile(png); } finally { await file.close(); }
  });
});
