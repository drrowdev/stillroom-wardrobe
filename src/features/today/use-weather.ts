import { useCallback, useEffect, useState } from 'react';
import { failureCooldownMs, forecastCurrent, forecastExpiresAt, type Forecast, type WeatherConfig, type WeatherOverride } from '../../domain/weather';
import { fetchForecast } from '../../providers/weather';

const placeKey = (latitude: number, longitude: number, city: string) => `${latitude}|${longitude}|${city}`;
export const weatherKey = (config: WeatherConfig) => config.status === 'on' ? placeKey(config.place.latitude, config.place.longitude, config.place.city) : null;

// Memory only, one per signed-in owner (the owner's wardrobe view is remounted on every owner change), and never persisted.
export class WeatherStore {
  private entry: { key: string; forecast: Forecast; fetchedAt: number } | null = null;
  private failure: { key: string; at: number } | null = null;
  private pending: { key: string; request: AbortController; reply: Promise<Forecast> } | null = null;
  override: WeatherOverride | null = null;
  // Drops anything held for another city, or everything when weather is off.
  keep(key: string | null): void {
    if (this.entry?.key !== key) this.entry = null;
    if (this.failure?.key !== key) this.failure = null;
    if (this.pending && this.pending.key !== key) { this.pending.request.abort(); this.pending = null; }
  }
  // One request per city at a time; a remounted Today screen joins it instead of asking again.
  load(key: string, place: { city: string; latitude: number; longitude: number }, now: () => number): Promise<Forecast> {
    if (this.pending?.key === key) return this.pending.reply;
    const request = new AbortController();
    const reply = fetchForecast(place, request.signal, now).finally(() => { if (this.pending?.request === request) this.pending = null; });
    reply.catch(() => undefined);
    this.pending = { key, request, reply };
    return reply;
  }
  read(key: string, now: number): { forecast: Forecast; fetchedAt: number } | null {
    return this.entry?.key === key && forecastCurrent(this.entry.forecast, this.entry.fetchedAt, now) ? this.entry : null;
  }
  save(key: string, forecast: Forecast, fetchedAt: number): void { this.entry = { key, forecast, fetchedAt }; this.failure = null; }
  fail(key: string, at: number): void { this.failure = { key, at }; }
  coolingUntil(key: string, now: number): number | null {
    const until = this.failure?.key === key ? this.failure.at + failureCooldownMs : null;
    return until !== null && until > now ? until : null;
  }
}

export type WeatherView =
  | { status: 'off' | 'incomplete' | 'offline' | 'loading' }
  | { status: 'ready'; city: string; forecast: Forecast; fetchedAt: number }
  | { status: 'failed'; retryAt: number };

export function useWeather(store: WeatherStore, config: WeatherConfig, online: boolean, now: () => number = Date.now) {
  const { status } = config;
  const place = config.status === 'on' ? config.place : null;
  const city = place?.city ?? '', latitude = place?.latitude ?? 0, longitude = place?.longitude ?? 0;
  const [view, setView] = useState<WeatherView>({ status: status === 'on' ? 'loading' : status });
  const [attempt, setAttempt] = useState(0);
  const [override, setOverrideState] = useState<WeatherOverride | null>(store.override);
  const setOverride = useCallback((next: WeatherOverride | null) => { store.override = next; setOverrideState(next); }, [store]);

  useEffect(() => {
    const key = status === 'on' ? placeKey(latitude, longitude, city) : null;
    store.keep(key);
    if (status !== 'on' || !key) { setView({ status: status === 'on' ? 'incomplete' : status }); return; }
    const cached = store.read(key, now());
    if (cached) { setView({ status: 'ready', city, ...cached }); return; }
    const cooling = store.coolingUntil(key, now());
    if (cooling !== null) { setView({ status: 'failed', retryAt: cooling }); return; }
    if (!online) { setView({ status: 'offline' }); return; }
    let live = true;
    setView({ status: 'loading' });
    store.load(key, { city, latitude, longitude }, now).then(forecast => {
      if (!live) return;
      const fetchedAt = now();
      store.save(key, forecast, fetchedAt);
      setView({ status: 'ready', city, forecast, fetchedAt });
    }, () => {
      if (!live) return;
      const at = now();
      store.fail(key, at);
      setView({ status: 'failed', retryAt: at + failureCooldownMs });
    });
    return () => { live = false; };
  }, [store, status, city, latitude, longitude, online, attempt, now]);

  // Try again becomes available when the short pause after a failure ends.
  const retryAt = view.status === 'failed' ? view.retryAt : null;
  const [, wake] = useState(0);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => wake(value => value + 1), Math.max(0, retryAt - now()) + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt, now]);
  const canRetry = view.status === 'failed' && online && view.retryAt <= now();
  const retry = useCallback(() => { if (canRetry) setAttempt(value => value + 1); }, [canRetry]);

  // A shown forecast stops counting at the end of its lifetime or at the city's midnight; the screen then asks again.
  const expiresAt = view.status === 'ready' ? forecastExpiresAt(view.forecast, view.fetchedAt) : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => setAttempt(value => value + 1), Math.max(0, expiresAt - now()) + 50);
    return () => window.clearTimeout(timer);
  }, [expiresAt, now]);

  const current = view.status !== 'ready' || forecastCurrent(view.forecast, view.fetchedAt, now());
  const forecast = view.status === 'ready' && current ? view.forecast : null;
  return { view: current ? view : { status: 'loading' } as WeatherView, forecast, override, setOverride, canRetry, retry };
}
