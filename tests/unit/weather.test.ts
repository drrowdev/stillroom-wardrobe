import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import viteConfig from '../../vite.config';
import {
  confirmedWeather, currentExpiresAt, currentLifetimeMs, currentTemperature, forecastCurrent, forecastExpiresAt, forecastLifetimeMs, localDate, summarizeForecast, validManualTemperature, weatherConfig,
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
    expect(forecast).toEqual({ date: '2026-09-25', timeZone: 'Europe/Helsinki', utcOffsetSeconds: 10800, minTemperature: 4, maxRain: 70, maxWind: 11.3,
      currentTemperature: null, hourlyTemperatures: Array.from({ length: 15 }, (_, index) => ({
        time: `2026-09-25T${String(index + 7).padStart(2, '0')}:00`, temperatureC: index === 0 ? 4.04 : 10,
      })) });
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
    const forecast: Forecast = { date: '2026-09-25', timeZone: 'Europe/Helsinki', utcOffsetSeconds: 10800, minTemperature: 5, maxRain: null, maxWind: null,
      currentTemperature: null, hourlyTemperatures: [] };
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
  const forecast: Forecast = { date: '2026-09-25', timeZone: 'UTC', utcOffsetSeconds: 0, minTemperature: -3, maxRain: 65, maxWind: null,
    currentTemperature: null, hourlyTemperatures: [] };
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
      current: 'temperature_2m', hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '2' });
    expect(requests[0]!.url.searchParams.has('city')).toBe(false);
    stub({ reason: 'limit' }, 429);
    await expect(fetchForecast({ city: 'Oulu', latitude: 65, longitude: 25.5 }, new AbortController().signal, () => now)).rejects.toEqual(new WeatherError('busy'));
    stub({ reason: 'x' }, 500);
    await expect(searchCities('Oulu', 'en', new AbortController().signal)).rejects.toEqual(new WeatherError('unavailable'));
  });

  describe('WEATHER2 current and hourly temperatures are distinct', () => {
    const now = Date.parse('2026-10-08T11:05:00Z');
    const current = (time = '2026-10-08T14:00', temperature_2m: unknown = 13) => ({ current: { time, temperature_2m },
      current_units: { time: 'iso8601', temperature_2m: '°C' } });
    const forecast = (extra: Record<string, unknown> = {}) =>
      summarizeForecast(reply('2026-10-08', 10800, hour => hour === 7 ? 6 : hour === 21 ? -2 : 12, { ...current(), ...extra }), now)!;
    it('uses the supplied current metric and every daytime hour, including morning and 21:00', () => {
      const data = forecast();
      expect(data.currentTemperature).toEqual({ temperatureC: 13, validAt: Date.parse('2026-10-08T11:00:00Z') });
      expect(data.hourlyTemperatures).toHaveLength(15);
      expect(data.hourlyTemperatures[0]).toEqual({ time: '2026-10-08T07:00', temperatureC: 6 });
      expect(data.hourlyTemperatures[14]).toEqual({ time: '2026-10-08T21:00', temperatureC: -2 });
      expect(weatherContext(data, null)).toEqual({ setting: 'outdoors', temperatureC: -2, rainProbability: 70, windMetresPerSecond: 11.3 });
      expect(weatherContext({ ...data, currentTemperature: { temperatureC: 50, validAt: now }, hourlyTemperatures: [] }, null)).toEqual(weatherContext(data, null));
    });
    it('keeps current unavailable for missing, null, invalid, future, stale, wrong-date or wrong-zone readings', () => {
      for (const extra of [{ current: undefined }, { current: null }, current(undefined, null), current(undefined, Number.NaN),
        current(undefined, 61), current(undefined, '13'), current('2026-10-08T14:06'), current('2026-10-08T13:50'),
        current('2026-10-07T14:00'), current('2026-02-30T14:00'), current('2026-10-08T24:00'),
        { ...current(), timezone: 'Europe/Stockholm' }, { ...current(), current_units: { temperature_2m: '°F' } }]) {
        const data = forecast(extra);
        expect(data.currentTemperature).toBeNull();
        expect(data.minTemperature).toBe(-2);
        expect(data.hourlyTemperatures[0]!.temperatureC).toBe(6);
      }
    });
    it('expires current at its valid-time or fetch boundary without expiring the conservative forecast', () => {
      const data = forecast();
      const expires = Date.parse('2026-10-08T11:15:00Z');
      expect(currentTemperature(data, now, expires - 1)?.temperatureC).toBe(13);
      expect(currentTemperature(data, now, expires)).toBeNull();
      expect(currentTemperature(data, now, now - 1)).toBeNull();
      expect(currentExpiresAt(data, now)).toBe(expires);
      expect(forecastCurrent(data, now, expires)).toBe(true);
      const later = { ...data, currentTemperature: { temperatureC: 13, validAt: now + currentLifetimeMs - 1 } };
      expect(currentTemperature(later, now, now)).toBeNull();
      expect(currentExpiresAt(later, now)).toBe(now + currentLifetimeMs);
      expect(currentTemperature(data, now, now + forecastLifetimeMs)).toBeNull();
    });
    it('preserves missing hourly slots without interpolation, and supports a usable current-only metric', () => {
      const input = reply('2026-10-08', 10800, hour => hour === 7 ? 0 : hour === 8 ? null : -3, current());
      for (const values of Object.values(input.hourly)) values.splice(10, 1);
      const data = summarizeForecast(input, now)!;
      expect(data.hourlyTemperatures.slice(0, 4)).toEqual([
        { time: '2026-10-08T07:00', temperatureC: 0 }, { time: '2026-10-08T08:00', temperatureC: null },
        { time: '2026-10-08T09:00', temperatureC: -3 }, { time: '2026-10-08T10:00', temperatureC: null },
      ]);
      const only = forecast({ hourly: { time: [] } });
      expect(only.currentTemperature?.temperatureC).toBe(13);
      expect(only.hourlyTemperatures.every(hour => hour.temperatureC === null)).toBe(true);
      expect(weatherContext(only, null)).toEqual({ setting: 'outdoors' });
      for (const bad of ['2026-02-30T07:00', '2026-10-08T07:30', '2026-10-08T24:00']) {
        expect(forecast({ hourly: { time: [bad], temperature_2m: [2] } })).toBeNull();
      }
      expect(forecast({ hourly: { time: ['2026-10-08T07:00', '2026-10-08T07:00'], temperature_2m: [2, 3] } })).toBeNull();
    });
    it('validates DST offsets and the city-local date before using current, including outside daytime', () => {
      const parse = (stamp: string, zone: string, offset: number, at: string) =>
        summarizeForecast(reply(stamp.slice(0, 10), offset, () => -5, { timezone: zone, ...current(stamp, -2) }), Date.parse(at))!;
      expect(parse('2026-10-25T03:00', 'Europe/Helsinki', 10800, '2026-10-25T00:05Z').currentTemperature?.temperatureC).toBe(-2);
      expect(parse('2026-10-25T03:00', 'Europe/Helsinki', 7200, '2026-10-25T01:05Z').currentTemperature?.temperatureC).toBe(-2);
      expect(parse('2026-10-25T04:00', 'Europe/Helsinki', 10800, '2026-10-25T01:05Z').currentTemperature).toBeNull();
      expect(parse('2026-03-29T03:00', 'Europe/Helsinki', 7200, '2026-03-29T01:05Z').currentTemperature).toBeNull();
      expect(parse('2026-10-09T00:00', 'Europe/Helsinki', 10800, '2026-10-08T21:05Z').date).toBe('2026-10-09');
      expect(parse('2026-10-08T23:00', 'America/New_York', -14400, '2026-10-09T03:05Z').currentTemperature?.temperatureC).toBe(-2);
      expect(parse('2026-10-08T06:00', 'Europe/Helsinki', 10800, '2026-10-08T03:05Z').currentTemperature?.temperatureC).toBe(-2);
    });
    it('single-flights refresh requests and retains a valid forecast through failure cooldown', async () => {
      const store = new WeatherStore(), data = forecast();
      store.save('city', data, now);
      let complete!: (response: Response) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
      const place = { city: 'Synthetic city', latitude: 65, longitude: 25.5 };
      const at = now + currentLifetimeMs;
      try {
        const first = store.load('city', place, () => at), second = store.load('city', place, () => at);
        expect(second).toBe(first);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(store.refreshAt('city', data, now)).toBe(at + currentLifetimeMs);
        expect(store.read('city', at)?.forecast).toBe(data);
        complete(new Response('{}', { status: 503 }));
        await expect(first).rejects.toEqual(new WeatherError('unavailable'));
        store.fail('city', at);
        expect(store.refreshAt('city', data, now)).toBe(at + currentLifetimeMs);
        expect(store.read('city', at + 60_000)?.forecast).toBe(data);
        expect(store.coolingUntil('city', at + 59_999)).toBe(at + 60_000);
        expect(store.coolingUntil('city', at + 60_000)).toBeNull();
        store.allowRetry('city');
        expect(store.refreshAt('city', data, now)).toBe(at + 60_000);
        expect(store.retryAt('city')).toBeNull();
        store.keep(null);
        expect(store.read('city', at)).toBeNull();
        expect(store.pendingFor('city')).toBe(false);
      } finally { vi.unstubAllGlobals(); }
    });
    it('schedules usable current from strict expiry plus request grace, not from fetch plus fifteen minutes', () => {
      const store = new WeatherStore();
      const fetchedAt = Date.parse('2026-10-08T11:14:00Z');
      const data = summarizeForecast(reply('2026-10-08', 10800, () => 4, {
        current_units: { temperature_2m: '°C' }, current: { time: '2026-10-08T14:00', temperature_2m: 13 },
      }), fetchedAt)!;
      store.save('city', data, fetchedAt);
      expect(currentTemperature(data, fetchedAt, Date.parse('2026-10-08T11:15:00Z'))).toBeNull();
      expect(store.refreshAt('city', data, fetchedAt)).toBe(Date.parse('2026-10-08T11:16:00Z'));
      expect(store.refreshAt('city', { ...data, currentTemperature: null }, fetchedAt)).toBe(fetchedAt + currentLifetimeMs);
      expect(store.refreshAt('city', { ...data, currentTemperature: { temperatureC: 13, validAt: fetchedAt + 1 } }, fetchedAt))
        .toBe(fetchedAt + currentLifetimeMs);
      store.fail('city', Date.parse('2026-10-08T11:16:05Z'));
      expect(store.refreshAt('city', data, fetchedAt)).toBe(Date.parse('2026-10-08T11:31:05Z'));
      store.allowRetry('city');
      expect(store.refreshAt('city', data, fetchedAt)).toBe(fetchedAt + 60_000);
    });
    it.each([200, 503])('clears explicit retry when joining a pending automatic request, including status %i', async status => {
      const store = new WeatherStore(), data = forecast();
      store.save('city', data, now);
      store.fail('city', now + currentLifetimeMs);
      const attemptedAt = now + 2 * currentLifetimeMs;
      let complete!: (response: Response) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
      try {
        const place = { city: 'Synthetic city', latitude: 65, longitude: 25.5 };
        const pending = store.load('city', place, () => attemptedAt);
        store.allowRetry('city');
        expect(store.load('city', place, () => attemptedAt)).toBe(pending);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(store.refreshAt('city', data, now)).toBe(attemptedAt + currentLifetimeMs);
        const body = reply('2026-10-08', 10800, () => 4, current('2026-10-08T14:30', 18));
        complete(new Response(JSON.stringify(body), { status }));
        if (status === 200) {
          const updated = await pending;
          expect(store.refreshAt('city', updated, attemptedAt)).toBe(Date.parse('2026-10-08T11:46:00Z'));
          expect(store.retryAt('city')).toBeNull();
        } else {
          await expect(pending).rejects.toEqual(new WeatherError('unavailable'));
          expect(store.refreshAt('city', data, now)).toBe(attemptedAt + currentLifetimeMs);
          expect(store.coolingUntil('city', attemptedAt)).toBe(attemptedAt + 60_000);
        }
      } finally { vi.unstubAllGlobals(); }
    });
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
