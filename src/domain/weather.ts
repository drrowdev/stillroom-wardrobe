import { fieldAssertion, type FieldProvenance, type ProvenanceField } from './attribute-provenance';
import type { EngineContext } from './recommendations';
import { isRecord } from './wardrobe';

// Weather for suggestions (blueprint 09 rule 6). Pure: callers pass the clock, and nothing here makes a request.
export type WeatherPlace = { city: string; latitude: number; longitude: number };
export type WeatherConfig = { status: 'off' } | { status: 'on'; place: WeatherPlace } | { status: 'incomplete' };
export type CurrentTemperature = { temperatureC: number; validAt: number };
export type HourlyTemperature = { time: string; temperatureC: number | null };
export type Forecast = {
  date: string; timeZone: string; utcOffsetSeconds: number;
  minTemperature: number | null; maxRain: number | null; maxWind: number | null;
  currentTemperature: CurrentTemperature | null; hourlyTemperatures: HourlyTemperature[];
};
export type WeatherOverride = { kind: 'manual'; temperatureC: number } | { kind: 'indoors' };
export type ItemWeather = {
  warmth: number | null; lowerCoverage: number | null; minTemp: number | null; maxTemp: number | null;
  rainRating: number | null; windproof: boolean | null;
};

export const daytimeHours = { first: 7, last: 21 } as const;
export const forecastLifetimeMs = 3 * 60 * 60 * 1000;
export const currentLifetimeMs = 15 * 60 * 1000;
export const failureCooldownMs = 60 * 1000;
export const manualTemperatureRange = { min: -40, max: 50 } as const;
const ranges = { temperature: [-60, 60], rain: [0, 100], wind: [0, 75] } as const;
const tenth = (value: number) => Math.round(value * 10) / 10;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Coordinates are kept to one decimal (about 10 km), matching the profile columns.
export function weatherPlace(value: { city: unknown; latitude: unknown; longitude: unknown }): WeatherPlace | null {
  if (typeof value.city !== 'string' || !finite(value.latitude) || !finite(value.longitude)) return null;
  const city = value.city.trim();
  if (!city || city.length > 100 || [...city].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  if (Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return null;
  return { city, latitude: tenth(value.latitude), longitude: tenth(value.longitude) };
}

export function weatherConfig(profile: { weather_enabled: boolean; weather_city: string | null; latitude: number | null; longitude: number | null }): WeatherConfig {
  if (!profile.weather_enabled) return { status: 'off' };
  const place = weatherPlace({ city: profile.weather_city, latitude: profile.latitude, longitude: profile.longitude });
  return place ? { status: 'on', place } : { status: 'incomplete' };
}

// Only the owner's own entries establish warmth, protection and temperature limits. Visible lower coverage may also come
// from a supported photo observation. Anything else, including an absent assertion, is unknown.
const ownerOnly: readonly ProvenanceField[] = ['warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof'];
export function confirmedWeather(values: { warmth: number | null; lower_coverage: number | null; min_temp: number | null; max_temp: number | null;
  rain_rating: number | null; windproof: boolean | null }, provenance: FieldProvenance): ItemWeather {
  const owned = (field: ProvenanceField) => ownerOnly.includes(field) && fieldAssertion(provenance, field).kind === 'user';
  const coverage = fieldAssertion(provenance, 'lower_coverage').kind;
  return {
    warmth: owned('warmth') ? values.warmth : null,
    lowerCoverage: coverage === 'user' || coverage === 'ai_observed' ? values.lower_coverage : null,
    minTemp: owned('min_temp') ? values.min_temp : null,
    maxTemp: owned('max_temp') ? values.max_temp : null,
    rainRating: owned('rain_rating') ? values.rain_rating : null,
    windproof: owned('windproof') ? values.windproof : null,
  };
}

// The city's local date for a given instant.
export function localDate(nowMs: number, utcOffsetSeconds: number): string {
  return new Date(nowMs + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

function wallTime(stamp: unknown): number | null {
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stamp)) return null;
  const time = Date.parse(`${stamp}:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 16) === stamp ? time : null;
}

function currentReading(value: Record<string, unknown>, date: string, offset: number, nowMs: number): CurrentTemperature | null {
  if (!isRecord(value.current) || !isRecord(value.current_units) || value.current_units.temperature_2m !== '°C') return null;
  const { time, temperature_2m: temperature } = value.current;
  const wall = wallTime(time);
  if (wall === null || typeof time !== 'string' || time.slice(0, 10) !== date
    || !finite(temperature) || temperature < ranges.temperature[0] || temperature > ranges.temperature[1]) return null;
  const validAt = wall - offset * 1000;
  if (nowMs < validAt || nowMs - validAt >= currentLifetimeMs) return null;
  // ISO times are city-local. Round-trip through the actual zone to reject a wrong offset, including DST transitions.
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: String(value.timezone), year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(validAt);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === name)?.value;
    if (`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}` !== time) return null;
  } catch { return null; }
  return { temperatureC: tenth(temperature), validAt };
}

// Summarizes an hourly Open-Meteo reply for the city's current date, 07:00–21:00 local time: the lowest temperature and
// the highest rain chance and wind. A metric with no usable hour stays unknown. Returns null for an unusable reply.
export function summarizeForecast(value: unknown, nowMs: number): Forecast | null {
  if (!isRecord(value) || !isRecord(value.hourly) || typeof value.timezone !== 'string'
    || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value.timezone) || !Number.isSafeInteger(value.utc_offset_seconds)) return null;
  const offset = value.utc_offset_seconds as number;
  if (Math.abs(offset) > 14 * 3600) return null;
  const { time, temperature_2m: temperature, precipitation_probability: rain, wind_speed_10m: wind } = value.hourly;
  if (!Array.isArray(time) || time.length > 96) return null;
  const date = localDate(nowMs, offset);
  const series = (list: unknown, [low, high]: readonly [number, number]) => {
    if (list === undefined) return [] as (number | null)[];
    if (!Array.isArray(list) || list.length !== time.length) return null;
    const result: (number | null)[] = [];
    for (const entry of list) {
      if (entry === null) result.push(null);
      else if (finite(entry) && entry >= low && entry <= high) result.push(entry);
      else return null;
    }
    return result;
  };
  const temperatures = series(temperature, ranges.temperature), rains = series(rain, ranges.rain), winds = series(wind, ranges.wind);
  if (!temperatures || !rains || !winds) return null;
  const hours: number[] = [];
  const seen = new Set<string>();
  for (const [index, stamp] of time.entries()) {
    if (wallTime(stamp) === null || typeof stamp !== 'string' || !stamp.endsWith(':00') || seen.has(stamp)) return null;
    seen.add(stamp);
    const hour = Number(stamp.slice(11, 13));
    if (stamp.slice(0, 10) === date && hour >= daytimeHours.first && hour <= daytimeHours.last) hours.push(index);
  }
  const pick = (list: (number | null)[], choose: (values: number[]) => number) => {
    const known = hours.map(index => list[index]).filter(finite);
    return known.length ? tenth(choose(known)) : null;
  };
  const summary = {
    date, timeZone: value.timezone, utcOffsetSeconds: offset,
    minTemperature: pick(temperatures, values => Math.min(...values)),
    maxRain: pick(rains, values => Math.max(...values)),
    maxWind: pick(winds, values => Math.max(...values)),
    currentTemperature: currentReading(value, date, offset, nowMs),
    hourlyTemperatures: Array.from({ length: daytimeHours.last - daytimeHours.first + 1 }, (_, index) => {
      const stamp = `${date}T${String(daytimeHours.first + index).padStart(2, '0')}:00`;
      const supplied = time.indexOf(stamp);
      return { time: stamp, temperatureC: supplied < 0 ? null : temperatures[supplied] ?? null };
    }),
  };
  return summary.minTemperature === null && summary.maxRain === null && summary.maxWind === null && summary.currentTemperature === null ? null : summary;
}

export function currentTemperature(forecast: Forecast, fetchedAtMs: number, nowMs: number): CurrentTemperature | null {
  const reading = forecast.currentTemperature;
  return reading && forecastCurrent(forecast, fetchedAtMs, nowMs) && nowMs >= reading.validAt
    && nowMs - reading.validAt < currentLifetimeMs && nowMs - fetchedAtMs < currentLifetimeMs
    ? reading : null;
}

export function currentExpiresAt(forecast: Forecast, fetchedAtMs: number): number | null {
  return forecast.currentTemperature
    ? Math.min(forecast.currentTemperature.validAt + currentLifetimeMs, fetchedAtMs + currentLifetimeMs, forecastExpiresAt(forecast, fetchedAtMs))
    : null;
}

// A cached forecast is used only for the same city on the city's same date and within its lifetime.
export function forecastCurrent(forecast: Forecast, fetchedAtMs: number, nowMs: number): boolean {
  return nowMs >= fetchedAtMs && nowMs - fetchedAtMs < forecastLifetimeMs && localDate(nowMs, forecast.utcOffsetSeconds) === forecast.date;
}

// The instant a forecast stops being current: the end of its lifetime or the city's next midnight, whichever is first.
export function forecastExpiresAt(forecast: Forecast, fetchedAtMs: number): number {
  const [year, month, day] = forecast.date.split('-').map(Number) as [number, number, number];
  return Math.min(fetchedAtMs + forecastLifetimeMs, Date.UTC(year, month - 1, day + 1) - forecast.utcOffsetSeconds * 1000);
}

export function validManualTemperature(value: number): boolean {
  return Number.isInteger(value) && value >= manualTemperatureRange.min && value <= manualTemperatureRange.max;
}

// Engine weather input. No weather gives the same context as before Phase 5; staying in turns every weather rule off,
// including the temperature. A manual temperature always wins over a forecast.
export function weatherContext(forecast: Forecast | null, override: WeatherOverride | null): Pick<EngineContext, 'setting' | 'temperatureC' | 'rainProbability' | 'windMetresPerSecond'> {
  if (override?.kind === 'indoors') return { setting: 'indoors' };
  if (override?.kind === 'manual') return { setting: 'outdoors', temperatureC: override.temperatureC };
  if (!forecast) return {};
  return {
    setting: 'outdoors',
    ...forecast.minTemperature !== null && { temperatureC: forecast.minTemperature },
    ...forecast.maxRain !== null && { rainProbability: forecast.maxRain },
    ...forecast.maxWind !== null && { windMetresPerSecond: forecast.maxWind },
  };
}
