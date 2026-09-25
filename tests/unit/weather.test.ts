import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import viteConfig from '../../vite.config';
import {
  confirmedWeather, forecastCurrent, forecastExpiresAt, forecastLifetimeMs, localDate, summarizeForecast, validManualTemperature, weatherConfig,
  weatherContext, weatherPlace, type Forecast,
} from '../../src/domain/weather';
import { fetchForecast, forecastLimitBytes, geocodingLimitBytes, searchCities, WeatherError } from '../../src/providers/weather';
import { parseProfile, updateProfile } from '../../src/data/profile';
import { WeatherStore } from '../../src/features/today/use-weather';
import type { AppClient } from '../../src/data/client';

const owner = '10000000-0000-4000-8000-000000000001';
const values = { warmth: 3, lower_coverage: 2, min_temp: -5, max_temp: 20, rain_rating: 2, windproof: true };
const user = { kind: 'user', revision: 1 } as const;

describe('item weather facts count only from appropriate assertions', () => {
  it('treats absent or unknown provenance as unknown, even with stored values', () => {
    const none = { warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null };
    expect(confirmedWeather(values, {})).toEqual(none);
    const unknown = Object.fromEntries(Object.keys(values).map(field => [field, { kind: 'unknown', revision: 1 }]));
    expect(confirmedWeather(values, unknown)).toEqual(none);
  });
  it('uses the owner\'s own values and clears, and supported photo coverage only', () => {
    const own = Object.fromEntries(Object.keys(values).map(field => [field, user]));
    expect(confirmedWeather(values, own)).toEqual({ warmth: 3, lowerCoverage: 2, minTemp: -5, maxTemp: 20, rainRating: 2, windproof: true });
    const cleared = { warmth: null, lower_coverage: null, min_temp: null, max_temp: null, rain_rating: null, windproof: null };
    expect(confirmedWeather(cleared, own)).toEqual({ warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null });
    const observed = Object.fromEntries(Object.keys(values).map(field => [field, { kind: 'ai_observed', revision: 1 }]));
    expect(confirmedWeather(values, observed)).toMatchObject({ lowerCoverage: 2, warmth: null, rainRating: null, windproof: null, minTemp: null, maxTemp: null });
    const estimated = Object.fromEntries(Object.keys(values).map(field => [field, { kind: 'ai_estimated', revision: 1 }]));
    expect(confirmedWeather(values, estimated)).toEqual({ warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null });
    expect(confirmedWeather({ ...values, windproof: false }, own).windproof).toBe(false);
  });
});

describe('weather place and profile setting', () => {
  it('trims, bounds and rounds a chosen city', () => {
    expect(weatherPlace({ city: ' Helsinki, Finland ', latitude: 60.16952, longitude: 24.93545 })).toEqual({ city: 'Helsinki, Finland', latitude: 60.2, longitude: 24.9 });
    for (const bad of [{ city: '', latitude: 1, longitude: 1 }, { city: 'x'.repeat(101), latitude: 1, longitude: 1 }, { city: 'A\u0007', latitude: 1, longitude: 1 },
      { city: 'A', latitude: 91, longitude: 1 }, { city: 'A', latitude: 1, longitude: Number.NaN }, { city: 'A', latitude: '1', longitude: 1 }]) {
      expect(weatherPlace(bad)).toBeNull();
    }
  });
  it('reads a damaged stored setting as incomplete without locking the profile', () => {
    const base = { owner_id: owner, display_name: 'Me', ui_language: null, timezone: 'Europe/Helsinki', currency: 'EUR', version: 2 };
    expect(weatherConfig(parseProfile(base, owner))).toEqual({ status: 'off' });
    expect(weatherConfig(parseProfile({ ...base, weather_enabled: true, weather_city: 'Oulu', latitude: 65, longitude: 25.5 }, owner)))
      .toEqual({ status: 'on', place: { city: 'Oulu', latitude: 65, longitude: 25.5 } });
    for (const damaged of [{ weather_city: null }, { latitude: null }, { longitude: 'x' }, { weather_city: 'x'.repeat(200) }, { latitude: 400 }]) {
      const row = parseProfile({ ...base, weather_enabled: true, weather_city: 'Oulu', latitude: 65, longitude: 25.5, ...damaged }, owner);
      expect(weatherConfig(row)).toEqual({ status: 'incomplete' });
    }
    expect(parseProfile({ ...base, weather_enabled: 'yes' }, owner).weather_enabled).toBe(false);
  });
  it('writes a validated city or clears every weather column, version-checked', async () => {
    const calls: { body: unknown; filters: [string, unknown][]; select: string }[] = [];
    const row = { owner_id: owner, display_name: 'Me', ui_language: 'en', timezone: 'UTC', currency: 'EUR', version: 3,
      weather_enabled: true, weather_city: 'Oulu, Finland', latitude: 65, longitude: 25.5 };
    const client = { from: () => ({ update(body: unknown) {
      const call = { body, filters: [] as [string, unknown][], select: '' };
      calls.push(call);
      const chain = { eq(column: string, value: unknown) { call.filters.push([column, value]); return chain; },
        select(columns: string) { call.select = columns; return chain; }, abortSignal: () => chain,
        maybeSingle: () => Promise.resolve({ data: { ...row, version: 4 }, error: null }) };
      return chain;
    } }) } as unknown as AppClient;
    const scope = { ownerId: owner, epoch: 1, signal: new AbortController().signal };
    const baseline = parseProfile(row, owner);
    await updateProfile(client, scope, baseline, { kind: 'weather', place: { city: ' Oulu, Finland ', latitude: 65.0123, longitude: 25.4688 } });
    await updateProfile(client, scope, baseline, { kind: 'weather', place: null });
    expect(calls.map(call => call.body)).toEqual([
      { weather_enabled: true, weather_city: 'Oulu, Finland', latitude: 65, longitude: 25.5 },
      { weather_enabled: false, weather_city: null, latitude: null, longitude: null },
    ]);
    expect(calls[0]!.filters).toEqual([['owner_id', owner], ['version', 3]]);
    expect(calls[0]!.select).toContain('weather_enabled,weather_city,latitude,longitude');
    await expect(updateProfile(client, scope, baseline, { kind: 'weather', place: { city: '', latitude: 0, longitude: 0 } })).rejects.toThrow('error.unavailable');
    expect(calls).toHaveLength(2);
  });
});

// Hourly series for two local days starting at 00:00 on `first`.
function reply(first: string, offset: number, temperature: (hour: number) => number | null, extra: Record<string, unknown> = {}) {
  const time: string[] = [], temperatures: (number | null)[] = [], rain: number[] = [], wind: number[] = [];
  for (let index = 0; index < 48; index++) {
    const day = index < 24 ? first : new Date(Date.parse(`${first}T00:00Z`) + 86400000).toISOString().slice(0, 10);
    const hour = index % 24;
    time.push(`${day}T${String(hour).padStart(2, '0')}:00`);
    temperatures.push(temperature(hour + (index < 24 ? 0 : 100)));
    rain.push(hour === 12 && index < 24 ? 70 : 10);
    wind.push(hour === 8 && index < 24 ? 11.26 : 3);
  }
  return { timezone: 'Europe/Helsinki', utc_offset_seconds: offset,
    hourly: { time, temperature_2m: temperatures, precipitation_probability: rain, wind_speed_10m: wind }, ...extra };
}

describe('forecast summary', () => {
  it('uses the city\'s local daytime hours for its current date', () => {
    // 05:00 UTC is 08:00 in Helsinki (UTC+3).
    const now = Date.parse('2026-09-25T05:00:00Z');
    const forecast = summarizeForecast(reply('2026-09-25', 10800, hour => hour === 3 ? -20 : hour === 7 ? 4.04 : hour === 22 ? -9 : 10), now);
    expect(forecast).toEqual({ date: '2026-09-25', timeZone: 'Europe/Helsinki', utcOffsetSeconds: 10800, minTemperature: 4, maxRain: 70, maxWind: 11.3 });
  });
  it('switches date at the city\'s midnight, not UTC', () => {
    // 22:30 UTC on the 25th is 01:30 on the 26th in Helsinki.
    const forecast = summarizeForecast(reply('2026-09-25', 10800, hour => hour >= 100 ? 2 : 15), Date.parse('2026-09-25T22:30:00Z'));
    expect(forecast).toMatchObject({ date: '2026-09-26', minTemperature: 2, maxRain: 10 });
    expect(localDate(Date.parse('2026-09-25T22:30:00Z'), -18000)).toBe('2026-09-25');
    expect(localDate(Date.parse('2026-09-25T22:30:00Z'), 10800)).toBe('2026-09-26');
  });
  it('keeps missing metrics unknown and rejects unusable replies', () => {
    const now = Date.parse('2026-09-25T09:00:00Z');
    const partial = reply('2026-09-25', 0, () => null);
    expect(summarizeForecast(partial, now)).toMatchObject({ minTemperature: null, maxRain: 70 });
    const noWind = reply('2026-09-25', 0, () => 5);
    delete (noWind.hourly as Record<string, unknown>).wind_speed_10m;
    expect(summarizeForecast(noWind, now)).toMatchObject({ minTemperature: 5, maxWind: null });
    for (const bad of [null, {}, { ...reply('2026-09-25', 0, () => 5), timezone: '<script>' }, { ...reply('2026-09-25', 0, () => 5), utc_offset_seconds: 1.5 },
      reply('2026-09-25', 0, () => 500), reply('2026-09-25', 0, () => Number.NaN), reply('2026-09-01', 0, () => 5)]) {
      expect(summarizeForecast(bad, now)).toBeNull();
    }
    const short = reply('2026-09-25', 0, () => 5);
    (short.hourly as { temperature_2m: unknown[] }).temperature_2m.pop();
    expect(summarizeForecast(short, now)).toBeNull();
  });
  it('expires after its lifetime or when the city\'s date changes', () => {
    const forecast: Forecast = { date: '2026-09-25', timeZone: 'Europe/Helsinki', utcOffsetSeconds: 10800, minTemperature: 5, maxRain: null, maxWind: null };
    const fetched = Date.parse('2026-09-25T05:00:00Z');
    expect(forecastCurrent(forecast, fetched, fetched + forecastLifetimeMs - 1)).toBe(true);
    expect(forecastCurrent(forecast, fetched, fetched + forecastLifetimeMs)).toBe(false);
    expect(forecastCurrent(forecast, fetched, fetched - 1)).toBe(false);
    const late = Date.parse('2026-09-25T20:30:00Z');
    expect(forecastCurrent(forecast, late, late + 60 * 60 * 1000)).toBe(false);
    expect(forecastExpiresAt(forecast, fetched)).toBe(fetched + forecastLifetimeMs);
    expect(forecastExpiresAt(forecast, late)).toBe(Date.parse('2026-09-25T21:00:00Z'));
    expect(forecastCurrent(forecast, late, Date.parse('2026-09-25T21:00:00Z') - 1)).toBe(true);
    const behind: Forecast = { ...forecast, date: '2026-09-24', timeZone: 'America/New_York', utcOffsetSeconds: -14400 };
    expect(forecastExpiresAt(behind, Date.parse('2026-09-25T02:00:00Z'))).toBe(Date.parse('2026-09-25T04:00:00Z'));
  });
});

describe('weather in suggestions', () => {
  const forecast: Forecast = { date: '2026-09-25', timeZone: 'UTC', utcOffsetSeconds: 0, minTemperature: -3, maxRain: 65, maxWind: null };
  it('maps a forecast, a manual temperature and staying in to engine input', () => {
    expect(weatherContext(null, null)).toEqual({});
    expect(weatherContext(forecast, null)).toEqual({ setting: 'outdoors', temperatureC: -3, rainProbability: 65 });
    expect(weatherContext(forecast, { kind: 'manual', temperatureC: 12 })).toEqual({ setting: 'outdoors', temperatureC: 12 });
    expect(weatherContext(null, { kind: 'manual', temperatureC: 12 })).toEqual({ setting: 'outdoors', temperatureC: 12 });
    expect(weatherContext(forecast, { kind: 'indoors' })).toEqual({ setting: 'indoors' });
  });
  it('accepts whole manual temperatures from -40 to 50', () => {
    expect([-40, 0, 50].every(validManualTemperature)).toBe(true);
    expect([-41, 51, 1.5, Number.NaN].some(validManualTemperature)).toBe(false);
  });
  it('keeps forecasts in memory for one city only and pauses retries after a failure', () => {
    const store = new WeatherStore();
    const at = Date.parse('2026-09-25T09:00:00Z');
    store.save('a', forecast, at);
    expect(store.read('a', at + 1000)).not.toBeNull();
    expect(store.read('b', at + 1000)).toBeNull();
    store.keep('b');
    expect(store.read('a', at + 1000)).toBeNull();
    store.fail('b', 1000);
    expect(store.coolingUntil('b', 30000)).toBe(61000);
    expect(store.coolingUntil('b', 61000)).toBeNull();
    store.keep(null);
    expect(store.coolingUntil('b', 30000)).toBeNull();
  });
});

describe('Open-Meteo requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  function stub(body: unknown, status = 200) {
    const requests: { url: URL; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: URL, init: RequestInit) => {
      requests.push({ url: new URL(url), init });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    });
    return requests;
  }
  it('sends only the typed city, without credentials or referrer', async () => {
    const requests = stub({ results: [
      { name: 'Turku', admin1: 'Southwest Finland', country: 'Finland', latitude: 60.45148, longitude: 22.26869, id: 1 },
      { name: 'Turku', admin1: 'Southwest Finland', country: 'Finland', latitude: 60.44, longitude: 22.26, id: 2 },
      { name: 'Bad', latitude: 'x', longitude: 1 },
    ] });
    const found = await searchCities('  Turku ', 'fi', new AbortController().signal);
    expect(found).toEqual([{ city: 'Turku, Finland', latitude: 60.5, longitude: 22.3, id: '60.5|22.3|Turku, Finland', label: 'Turku, Southwest Finland, Finland' },
      { city: 'Turku, Finland', latitude: 60.4, longitude: 22.3, id: '60.4|22.3|Turku, Finland', label: 'Turku, Southwest Finland, Finland' }]);
    const [request] = requests;
    expect(request!.url.origin).toBe('https://geocoding-api.open-meteo.com');
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({ name: 'Turku', count: '5', language: 'fi', format: 'json' });
    expect(request!.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' });
    expect(request!.init.headers).toBeUndefined();
    expect(await searchCities('a', 'en', new AbortController().signal)).toEqual([]);
    expect(requests).toHaveLength(1);
  });
  it('sends only rounded coordinates for the forecast and reports a busy service', async () => {
    const now = Date.parse('2026-09-25T09:00:00Z');
    const requests = stub(reply('2026-09-25', 0, () => 8));
    await fetchForecast({ city: 'Oulu', latitude: 65.01, longitude: 25.47 }, new AbortController().signal, () => now);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ latitude: '65.0', longitude: '25.5',
      hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '2' });
    expect(requests[0]!.url.searchParams.has('city')).toBe(false);
    stub({ reason: 'limit' }, 429);
    await expect(fetchForecast({ city: 'Oulu', latitude: 65, longitude: 25.5 }, new AbortController().signal, () => now)).rejects.toEqual(new WeatherError('busy'));
    stub({ reason: 'x' }, 500);
    await expect(searchCities('Oulu', 'en', new AbortController().signal)).rejects.toEqual(new WeatherError('unavailable'));
  });
  it('rejects an oversized reply without reading or parsing all of it', async () => {
    let pulled = 0, cancelled = false;
    const endless = () => new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(16 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(endless(), { status: 200 })));
    await expect(searchCities('Oulu', 'en', new AbortController().signal)).rejects.toEqual(new WeatherError('unavailable'));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
    pulled = 0; cancelled = false;
    const now = Date.parse('2026-09-25T09:00:00Z');
    await expect(fetchForecast({ city: 'Oulu', latitude: 65, longitude: 25.5 }, new AbortController().signal, () => now)).rejects.toEqual(new WeatherError('unavailable'));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(18);
    cancelled = false;
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(endless(), { status: 200, headers: { 'content-length': String(forecastLimitBytes + 1) } })));
    await expect(fetchForecast({ city: 'Oulu', latitude: 65, longitude: 25.5 }, new AbortController().signal, () => now)).rejects.toEqual(new WeatherError('unavailable'));
    expect(cancelled).toBe(true);
    const padded = JSON.stringify(reply('2026-09-25', 0, () => 8)).padEnd(geocodingLimitBytes + 10, ' ');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(padded, { status: 200 })));
    expect((await fetchForecast({ city: 'Oulu', latitude: 65, longitude: 25.5 }, new AbortController().signal, () => now)).minTemperature).toBe(8);
    await expect(searchCities('Oulu', 'en', new AbortController().signal)).rejects.toEqual(new WeatherError('unavailable'));
  });
});

describe('deployed headers', () => {
  it('allow only the backend and the two Open-Meteo hosts for connections, and no location access', async () => {
    const config = await (viteConfig as (env: { mode: string; command: 'build' }) => Promise<{ plugins: Plugin[] }> | { plugins: Plugin[] })({ mode: 'test', command: 'build' });
    const plugin = config.plugins.flat().find(entry => entry && (entry as Plugin).name === 'private-app-headers') as Plugin;
    let source = '';
    const hook = plugin.generateBundle as unknown as (this: { emitFile: (file: { source: string }) => void }) => void;
    hook.call({ emitFile: file => { source = file.source; } });
    const csp = /Content-Security-Policy: (.*)/.exec(source)![1]!;
    const connect = csp.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src'))!.split(/\s+/).filter(Boolean);
    expect(connect.filter(entry => entry.includes('open-meteo'))).toEqual(['https://geocoding-api.open-meteo.com', 'https://api.open-meteo.com']);
    expect(connect.filter(entry => entry !== 'connect-src' && entry !== "'self'" && !entry.includes('open-meteo')).every(entry => !entry.includes('*'))).toBe(true);
    expect(csp).toContain("default-src 'self'");
    expect(source).toContain('Permissions-Policy: geolocation=()');
  });
});
