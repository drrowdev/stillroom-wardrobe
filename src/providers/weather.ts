import type { Language } from '../i18n';
import { isRecord } from '../domain/wardrobe';
import { summarizeForecast, weatherPlace, type Forecast, type WeatherPlace } from '../domain/weather';

// Open-Meteo (no key or account). Only the typed city name or the saved city's rounded coordinates are sent: no cookies,
// referrer, headers or account details. Nothing is cached by the browser.
export const geocodingOrigin = 'https://geocoding-api.open-meteo.com';
export const forecastOrigin = 'https://api.open-meteo.com';
const timeoutMs = 5000;

export class WeatherError extends Error {
  constructor(readonly code: 'unavailable' | 'busy') { super(code); this.name = 'WeatherError'; }
}
export type CityResult = WeatherPlace & { id: string; label: string };

async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (response.status === 429) throw new WeatherError('busy');
  if (!response.ok) throw new WeatherError('unavailable');
  try { return await response.json() as unknown; } catch { throw new WeatherError('unavailable'); }
}

export async function searchCities(query: string, language: Language, signal: AbortSignal): Promise<CityResult[]> {
  const name = query.trim();
  if (name.length < 2 || name.length > 100) return [];
  const url = new URL('/v1/search', geocodingOrigin);
  url.search = new URLSearchParams({ name, count: '5', language, format: 'json' }).toString();
  const reply = await getJson(url, signal);
  if (!isRecord(reply)) throw new WeatherError('unavailable');
  if (reply.results === undefined) return [];
  if (!Array.isArray(reply.results) || reply.results.length > 5) throw new WeatherError('unavailable');
  const seen = new Set<string>();
  return reply.results.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    const parts = [entry.name, entry.admin1, entry.country].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    const unique = parts.filter((part, index) => parts.indexOf(part) === index);
    const label = unique.join(', ');
    const city = unique.length > 1 && label.length <= 100 ? `${unique[0]}, ${unique[unique.length - 1]}` : entry.name;
    const place = weatherPlace({ city, latitude: entry.latitude, longitude: entry.longitude });
    if (!place) return [];
    const id = `${place.latitude}|${place.longitude}|${place.city}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ ...place, id, label: label.length <= 200 ? label : place.city }];
  });
}

export async function fetchForecast(place: WeatherPlace, signal: AbortSignal, nowMs: () => number = Date.now): Promise<Forecast> {
  const url = new URL('/v1/forecast', forecastOrigin);
  url.search = new URLSearchParams({
    latitude: place.latitude.toFixed(1), longitude: place.longitude.toFixed(1),
    hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '2',
  }).toString();
  const forecast = summarizeForecast(await getJson(url, signal), nowMs());
  if (!forecast) throw new WeatherError('unavailable');
  return forecast;
}
