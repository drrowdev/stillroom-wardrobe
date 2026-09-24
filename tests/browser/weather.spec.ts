import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { locales, translate, type Language, type MessageKey } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (page: Page, key: MessageKey, language: Language = 'en') => page.getByRole('button', { name: text(key, language), exact: true });
const cards = (page: Page) => page.locator('.today-card');
const bar = (page: Page) => page.locator('.weather-bar');
const user = { kind: 'user', revision: 1 };
const oulu = { weather_enabled: true, weather_city: 'Oulu, Finland', latitude: 65, longitude: 25.5 };
const malmo = { weather_enabled: true, weather_city: 'Malmö, Sweden', latitude: 55.6, longitude: 13 };
const places = {
  oulu: { id: 1, name: 'Oulu', admin1: 'North Ostrobothnia', country: 'Finland', latitude: 65.01236, longitude: 25.46816 },
  malmo: { id: 2, name: 'Malmö', admin1: 'Skåne', country: 'Sweden', latitude: 55.60587, longitude: 13.00073 },
};

// A reply for the city's current local date and the next, 00:00 to 23:00, with daytime values as given.
function forecastReply(weather: { temperature: number; rain?: number; wind?: number }, offset = 10800) {
  const first = new Date(Date.now() + offset * 1000).toISOString().slice(0, 10);
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
    hourly: { time, temperature_2m: temperature, precipitation_probability: rain, wind_speed_10m: wind } };
}

const cors = { 'access-control-allow-origin': '*' };
const reply = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});

// Stands in for Open-Meteo. Registered after the mock backend, so it runs before the backend's default block.
async function service(page: Page) {
  const state = {
    requests: [] as URL[],
    results: [places.oulu] as Row[],
    weather: new Map<string, { temperature: number; rain?: number; wind?: number }>([['65.0', { temperature: 0 }], ['55.6', { temperature: 12 }]]),
    status: { search: 200, forecast: 200 },
    hold: { search: false, forecast: new Set<string>() },
    held: [] as { kind: 'search' | 'forecast'; url: URL; route: Route }[],
  };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname.endsWith('open-meteo.com')) state.requests.push(url);
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
    await reply(route, state.status.forecast === 200 ? forecastReply(state.weather.get(latitude) ?? { temperature: 20 }) : { error: true }, state.status.forecast);
  });
  return {
    ...state,
    searches: () => state.requests.filter(url => url.hostname === 'geocoding-api.open-meteo.com'),
    forecasts: () => state.requests.filter(url => url.hostname === 'api.open-meteo.com'),
    async release(kind: 'search' | 'forecast', body: unknown) {
      const entry = state.held.find(held => held.kind === kind);
      if (!entry) throw new Error(`No held ${kind} reply.`);
      state.held.splice(state.held.indexOf(entry), 1);
      await reply(entry.route, body);
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

async function start(page: Page, options: { language?: Language; weather?: Row; route?: string; seed?: (api: Api, weather: Service) => void; weatherB?: Row } = {}) {
  const api = await mockBackend(page, { initialLanguage: options.language ?? 'en', weather: { ...options.weather && { a: options.weather }, ...options.weatherB && { b: options.weatherB } } });
  const weather = await service(page);
  options.seed?.(api, weather);
  await page.goto(`/#/${options.route ?? 'today'}`); await signIn(page);
  await expect(page.locator('.workspace-identity')).toBeVisible();
  return { api, weather };
}
async function goTo(page: Page, route: 'today' | 'settings') {
  await page.evaluate(target => { location.hash = `#/${target}`; }, route);
  await expect(page.locator(route === 'today' ? '#today-title' : '#settings-title')).toBeVisible();
}
async function signOut(page: Page, language: Language) {
  await page.getByRole('button', { name: text('account.menu', language) }).click();
  await page.getByRole('button', { name: text('auth.signOut', language), exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
}
const celsius = (page: Page, value: number, language: Language = 'en') => page.evaluate(({ value, locale }) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: 'celsius', maximumFractionDigits: 0 }).format(value), { value, locale: locales[language] });
async function lowLine(page: Page, value: number, language: Language = 'en') {
  return text('weather.low', language, { temperature: await celsius(page, value, language) });
}
async function search(page: Page, query: string, language: Language = 'en') {
  await page.locator('#weather-city').fill(query);
  await button(page, 'common.search', language).click();
}

test('I16 sends nothing until Search, then only the typed city; Use this city turns forecasts on and Turn off stops them', async ({ page }) => {
  const { api, weather } = await start(page, { route: 'settings', seed: api => basics(api) });
  const card = page.locator('.weather-card');
  await expect(card.getByText(text('weather.consent'), { exact: true })).toBeVisible();
  const disclosure = await card.locator('#weather-disclosure').boundingBox(), field = await page.locator('#weather-city').boundingBox();
  expect(disclosure!.y).toBeLessThan(field!.y);
  await page.locator('#weather-city').fill('Ou');
  await page.locator('#weather-city').focus();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: text('account.menu') }).click();
  await page.getByRole('banner').getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('banner').getByRole('button', { name: 'English', exact: true }).click();
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
  await expect(bar(page)).toContainText('Oulu, Finland');
  await expect(bar(page)).toContainText('(Europe/Helsinki)');
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await expect(bar(page).getByRole('link', { name: 'Open-Meteo.com' })).toHaveAttribute('href', 'https://open-meteo.com/');
  expect(weather.forecasts().map(url => Object.fromEntries(url.searchParams))).toEqual([{ latitude: '65.0', longitude: '25.5',
    hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '2' }]);
  // Going back to Today, focus and a language change reuse the forecast held in memory.
  await goTo(page, 'settings'); await goTo(page, 'today');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  if (!await page.getByRole('banner').getByRole('button', { name: 'Svenska', exact: true }).isVisible()) await page.getByRole('button', { name: text('account.menu') }).click();
  await page.getByRole('banner').getByRole('button', { name: 'Svenska', exact: true }).click();
  await expect(bar(page)).toContainText(await lowLine(page, 0, 'sv'));
  expect(weather.forecasts()).toHaveLength(1);
  await page.getByRole('banner').getByRole('button', { name: 'English', exact: true }).click();

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

test('I16 a failed forecast pauses before Try again, suggestions keep working, and manual entry and Staying in stay available', async ({ page }) => {
  await page.clock.install();
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.status.forecast = 503; } });
  await expect(bar(page)).toContainText(text('weather.failed'));
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page).getByRole('button', { name: text('common.retry'), exact: true })).toBeDisabled();
  await expect(button(page, 'weather.enterTemperature')).toBeEnabled();
  await expect(button(page, 'weather.stayingIn')).toBeEnabled();
  await goTo(page, 'settings'); await goTo(page, 'today');
  expect(weather.forecasts()).toHaveLength(1);
  weather.status.forecast = 200;
  await page.clock.fastForward('01:05');
  await bar(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  expect(weather.forecasts()).toHaveLength(2);
  await page.context().setOffline(true);
  await expect(bar(page)).toContainText(await lowLine(page, 0));
  await page.context().setOffline(false);
});

test('I16 a manual temperature needs no weather setting, is marked as yours and a late forecast never replaces it', async ({ page }) => {
  const { weather } = await start(page, { seed: api => { basics(api); add(api, 'Wool coat', { category: 'outerwear', colours: ['grey'] }); } });
  await expect(cards(page).first()).toBeVisible();
  await button(page, 'weather.enterTemperature').click();
  for (const bad of ['', 'cold', '51', '2.5']) {
    await page.locator('#weather-temperature').fill(bad);
    await button(page, 'weather.useTemperature').click();
    await expect(page.locator('#weather-temperature-error')).toHaveText(text('weather.invalidTemperature'));
    await expect(page.locator('#weather-temperature')).toHaveAttribute('aria-invalid', 'true');
  }
  await page.locator('#weather-temperature').fill('-5');
  await button(page, 'weather.useTemperature').click();
  await expect(bar(page)).toContainText(text('weather.manualLine', 'en', { temperature: await celsius(page, -5) }));
  await expect(cards(page).first()).toContainText('Wool coat');
  expect(weather.requests).toEqual([]);
  await button(page, 'weather.clearManual').click();
  await expect(bar(page)).not.toContainText(await celsius(page, -5));
  await expect(button(page, 'weather.enterTemperature')).toBeVisible();
  expect(weather.requests).toEqual([]);
});

test('I16 a manual temperature overrides a forecast, including one that arrives later', async ({ page }) => {
  const { weather } = await start(page, { weather: oulu, seed: (api, service) => { basics(api); service.hold.forecast.add('65.0'); } });
  await expect(cards(page).first()).toBeVisible();
  await expect(bar(page)).toContainText(text('weather.loading'));
  await button(page, 'weather.enterTemperature').click();
  await page.locator('#weather-temperature').fill('22');
  await button(page, 'weather.useTemperature').click();
  const manual = text('weather.manualLine', 'en', { temperature: await celsius(page, 22) });
  await expect(bar(page)).toContainText(manual);
  await weather.release('forecast', forecastReply({ temperature: -8 }));
  await expect(bar(page)).toContainText(manual);
  await expect(bar(page)).not.toContainText(await lowLine(page, -8));
  await expect(page.getByText(text('today.addCoat'), { exact: true })).toHaveCount(0);
  await button(page, 'weather.clearManual').click();
  await expect(bar(page)).toContainText(await lowLine(page, -8));
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
});

test('I16 Staying in turns every weather rule off, including the temperature', async ({ page }) => {
  await start(page, { weather: oulu, seed: api => basics(api) });
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
  await button(page, 'weather.stayingIn').click();
  await expect(bar(page)).toContainText(text('weather.indoorsLine'));
  await expect(cards(page).first()).not.toContainText(text('today.addCoat'));
  await expect(cards(page).first().getByRole('button', { name: text('today.save'), exact: true })).toBeVisible();
  await button(page, 'weather.goingOut').click();
  await expect(cards(page).first()).toContainText(text('today.addCoat'));
});

test.describe('I16 weather gaps on each idea, without suitability claims', () => {
  const cases: { name: string; forecast: { temperature: number; rain?: number; wind?: number }; bottom?: Row; extra?: Row; expected: MessageKey[]; absent: MessageKey[] }[] = [
    { name: 'cold with no coat', forecast: { temperature: 0 }, expected: ['today.addCoat'], absent: ['today.reasonWarmth', 'today.checkLength'] },
    { name: 'cold with unknown length, including an unconfirmed value', forecast: { temperature: 0 }, bottom: { lower_coverage: 2 },
      extra: { category: 'outerwear', colours: ['grey'] }, expected: ['today.checkLength'], absent: ['today.addCoat', 'today.reasonWarmth'] },
    { name: 'unknown rain protection, including an unconfirmed value', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 2 }, expected: ['today.checkRain'], absent: ['today.reasonRain', 'today.noRain'] },
    { name: 'unknown wind protection', forecast: { temperature: 15, wind: 12 },
      extra: { category: 'layer', colours: ['grey'], windproof: null, field_provenance: { windproof: user } }, expected: ['today.checkWind'], absent: ['today.reasonWind'] },
    { name: 'protection marked as inadequate', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 0, field_provenance: { rain_rating: user } }, expected: ['today.noRain'], absent: ['today.reasonRain', 'today.checkRain'] },
    { name: 'rain protection confirmed by the owner', forecast: { temperature: 15, rain: 80 },
      extra: { category: 'layer', colours: ['grey'], rain_rating: 2, field_provenance: { rain_rating: user } }, expected: ['today.reasonRain'], absent: ['today.checkRain', 'today.noRain'] },
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
    await expect(card).not.toContainText(text('today.missing', 'en', { categories: text('categoryOne.outerwear') }));
  });
});

for (const [from, to] of [['a', 'b'], ['b', 'a']] as const) {
  test(`I16 a held forecast for one owner never reaches the next (${from} to ${to})`, async ({ page }) => {
    const language = { a: 'en', b: 'sv' } as const;
    const latitude = { a: '65.0', b: '55.6' } as const;
    const city = { a: 'Oulu, Finland', b: 'Malmö, Sweden' } as const;
    const api = await mockBackend(page, { initialLanguage: 'en', weather: { a: oulu, b: malmo } });
    const weather = await service(page);
    basics(api, 'a'); basics(api, 'b');
    weather.hold.forecast.add(latitude[from]);
    await page.goto('/#/today'); await signIn(page, from);
    await expect.poll(() => weather.held.length).toBe(1);
    await signOut(page, language[from]);
    await signIn(page, to);
    await expect(page.locator('#today-title')).toBeVisible();
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
  await expect(bar(page)).toContainText('Malmö, Sweden');
  await weather.release('forecast', forecastReply({ temperature: -30 }));
  await expect(bar(page)).toContainText(await lowLine(page, 12));
  await expect(bar(page)).not.toContainText('Oulu');

  weather.hold.forecast.add('65.0');
  await goTo(page, 'settings');
  await button(page, 'weather.changeCity').click();
  weather.results.splice(0, 1, places.oulu);
  await search(page, 'Oulu');
  await button(page, 'weather.useCity').click();
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
  await expect(page.locator('.workspace-identity')).toContainText('Robin');
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
  await page.getByRole('button', { name: text('account.menu') }).click();
  await page.getByRole('banner').getByRole('button', { name: 'Suomi', exact: true }).click();
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
  await button(page, 'weather.enterTemperature').click();
  await button(page, 'weather.useTemperature').click();
  await expect(page.locator('#weather-temperature-error')).toBeVisible();
  await axe();
  await goTo(page, 'settings');
  await button(page, 'weather.changeCity').click();
  await search(page, 'Oulu');
  await expect(page.getByRole('radio')).toHaveCount(1);
  await axe();
  await page.setViewportSize({ width: 320, height: 900 });
  for (const route of ['settings', 'today'] as const) for (const zoom of [false, true]) {
    await goTo(page, route);
    if (zoom) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (route === 'today') {
      await button(page, 'weather.stayingIn').focus();
      await page.keyboard.press('Enter');
      await expect(bar(page)).toContainText(text('weather.indoorsLine'));
      await button(page, 'weather.goingOut').click();
    }
    await axe();
  }
});

test.describe('bounded I16 visual evidence', () => {
  test.describe.configure({ retries: 0 });
  const scenes = [
    { scene: 'settings', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'settings', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' },
    { scene: 'today-forecast', project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { scene: 'today-unavailable', project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' },
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
      await expect(cards(page).first()).toContainText(text('today.reasonRain', language));
    } else {
      await start(page, { language, weather: oulu, seed: (api, service) => { basics(api); service.status.forecast = 503; } });
      await expect(bar(page)).toContainText(text('weather.failed', language));
      await expect(cards(page).first()).toBeVisible();
    }
    expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
    await expect(page.locator('.workspace-identity')).toContainText('Alex');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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
});
