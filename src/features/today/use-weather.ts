import { useCallback, useEffect, useState } from 'react';
import { currentExpiresAt, currentLifetimeMs, currentTemperature, failureCooldownMs, forecastCurrent, forecastExpiresAt, type Forecast, type WeatherConfig, type WeatherOverride } from '../../domain/weather';
import { fetchForecast } from '../../providers/weather';

const placeKey = (latitude: number, longitude: number, city: string) => `${latitude}|${longitude}|${city}`;
export const weatherKey = (config: WeatherConfig) => config.status === 'on' ? placeKey(config.place.latitude, config.place.longitude, config.place.city) : null;

// Memory only, one per signed-in owner (the owner's wardrobe view is remounted on every owner change), and never persisted.
export class WeatherStore {
  private entry: { key: string; forecast: Forecast; fetchedAt: number } | null = null;
  private failure: { key: string; at: number } | null = null;
  private pending: { key: string; request: AbortController; reply: Promise<Forecast> } | null = null;
  private attempt: { key: string; at: number } | null = null;
  private manualRetry: string | null = null;
  override: WeatherOverride | null = null;
  // Drops anything held for another city, or everything when weather is off.
  keep(key: string | null): void {
    if (this.entry?.key !== key) this.entry = null;
    if (this.failure?.key !== key) this.failure = null;
    if (this.attempt?.key !== key) this.attempt = null;
    if (this.manualRetry !== key) this.manualRetry = null;
    if (this.pending && this.pending.key !== key) { this.pending.request.abort(); this.pending = null; }
  }
  // One request per city at a time; a remounted Today screen joins it instead of asking again.
  load(key: string, place: { city: string; latitude: number; longitude: number }, now: () => number): Promise<Forecast> {
    this.manualRetry = null;
    if (this.pending?.key === key) return this.pending.reply;
    const request = new AbortController();
    this.attempt = { key, at: now() };
    const reply = fetchForecast(place, request.signal, now).then(forecast => {
      if (this.pending?.request === request) this.save(key, forecast, now());
      return forecast;
    }, error => {
      if (this.pending?.request === request) this.fail(key, now());
      throw error;
    }).finally(() => { if (this.pending?.request === request) this.pending = null; });
    reply.catch(() => undefined);
    this.pending = { key, request, reply };
    return reply;
  }
  read(key: string, now: number): { forecast: Forecast; fetchedAt: number } | null {
    return this.entry?.key === key && forecastCurrent(this.entry.forecast, this.entry.fetchedAt, now) ? this.entry : null;
  }
  pendingFor(key: string): boolean { return this.pending?.key === key; }
  save(key: string, forecast: Forecast, fetchedAt: number): void { this.entry = { key, forecast, fetchedAt }; this.failure = null; }
  fail(key: string, at: number): void { this.failure = { key, at }; }
  coolingUntil(key: string, now: number): number | null {
    const until = this.failure?.key === key ? this.failure.at + failureCooldownMs : null;
    return until !== null && until > now ? until : null;
  }
  retryAt(key: string): number | null { return this.failure?.key === key ? this.failure.at + failureCooldownMs : null; }
  allowRetry(key: string): void {
    if (this.failure?.key === key) this.failure = null;
    this.manualRetry = key;
  }
  refreshAt(key: string, forecast: Forecast, fetchedAt: number): number {
    const attemptedAt = this.attempt?.key === key ? this.attempt.at : fetchedAt;
    const failedAt = this.failure?.key === key ? this.failure.at : null;
    if (this.manualRetry === key) return attemptedAt + failureCooldownMs;
    // A newer request/failure supersedes the cached observation's already-due deadline.
    if (this.pendingFor(key) || failedAt !== null || attemptedAt > fetchedAt) {
      return Math.max(fetchedAt, attemptedAt, failedAt ?? fetchedAt) + currentLifetimeMs;
    }
    const expiry = currentTemperature(forecast, fetchedAt, fetchedAt) ? currentExpiresAt(forecast, fetchedAt) : null;
    return expiry === null ? Math.max(fetchedAt, attemptedAt) + currentLifetimeMs
      : Math.max(expiry + failureCooldownMs, attemptedAt + failureCooldownMs);
  }
}

export type WeatherView =
  | { status: 'off' | 'incomplete' | 'offline' | 'loading' }
  | { status: 'ready'; city: string; forecast: Forecast; fetchedAt: number; retryAt: number | null }
  | { status: 'failed'; retryAt: number };

export function useWeather(store: WeatherStore, config: WeatherConfig, online: boolean, now: () => number = Date.now) {
  const { status } = config;
  const place = config.status === 'on' ? config.place : null;
  const city = place?.city ?? '', latitude = place?.latitude ?? 0, longitude = place?.longitude ?? 0;
  const key = weatherKey(config);
  const [state, setState] = useState<{ key: string | null; view: WeatherView }>({ key, view: { status: status === 'on' ? 'loading' : status } });
  const view: WeatherView = state.key === key ? state.view : { status: status === 'on' ? 'loading' : status };
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [, wake] = useState(0);
  const [override, setOverrideState] = useState<WeatherOverride | null>(store.override);
  const setOverride = useCallback((next: WeatherOverride | null) => { store.override = next; setOverrideState(next); }, [store]);
  useEffect(() => {
    const change = () => { setVisible(document.visibilityState !== 'hidden'); wake(value => value + 1); };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  useEffect(() => {
    const key = status === 'on' ? placeKey(latitude, longitude, city) : null;
    store.keep(key);
    const setView = (view: WeatherView) => setState({ key, view });
    if (status !== 'on' || !key) { setView({ status: status === 'on' ? 'incomplete' : status }); return; }
    const cached = store.read(key, now());
    const ready = () => {
      const entry = store.read(key, now());
      return entry ? { status: 'ready' as const, city, ...entry, retryAt: store.retryAt(key) } : null;
    };
    const cooling = store.coolingUntil(key, now());
    if (cached) {
      setView({ status: 'ready', city, ...cached, retryAt: store.retryAt(key) });
      if (!online || !visible || cooling !== null || now() < store.refreshAt(key, cached.forecast, cached.fetchedAt) && !store.pendingFor(key)) return;
    } else {
      if (cooling !== null) { setView({ status: 'failed', retryAt: cooling }); return; }
      if (!online) { setView({ status: 'offline' }); return; }
      setView({ status: 'loading' });
      if (!visible) return;
    }
    let live = true;
    store.load(key, { city, latitude, longitude }, now).then(forecast => {
      if (!live) return;
      const fetchedAt = now();
      store.save(key, forecast, fetchedAt);
      setView({ status: 'ready', city, forecast, fetchedAt, retryAt: null });
    }, () => {
      if (!live) return;
      const at = now();
      store.fail(key, at);
      setView(ready() ?? { status: 'failed', retryAt: at + failureCooldownMs });
    });
    return () => { live = false; };
  }, [store, status, city, latitude, longitude, online, visible, attempt, now]);

  // Try again becomes available when the short pause after a failure ends.
  const retryAt = view.status === 'failed' || view.status === 'ready' ? view.retryAt : null;
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => wake(value => value + 1), Math.max(0, retryAt - now()) + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt, now]);
  const canRetry = retryAt !== null && online && retryAt <= now();
  const retry = useCallback(() => {
    if (canRetry && key) { store.allowRetry(key); setAttempt(value => value + 1); }
  }, [canRetry, key, store]);

  // A shown forecast stops counting at the end of its lifetime or at the city's midnight; the screen then asks again.
  const expiresAt = view.status === 'ready' ? forecastExpiresAt(view.forecast, view.fetchedAt) : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => setAttempt(value => value + 1), Math.max(0, expiresAt - now()) + 50);
    return () => window.clearTimeout(timer);
  }, [expiresAt, now]);

  const refreshAt = view.status === 'ready' && key && visible && online ? store.refreshAt(key, view.forecast, view.fetchedAt) : null;
  useEffect(() => {
    if (refreshAt === null) return;
    const timer = window.setTimeout(() => setAttempt(value => value + 1), Math.max(0, refreshAt - now()) + 50);
    return () => window.clearTimeout(timer);
  }, [refreshAt, now]);
  const readingExpiresAt = view.status === 'ready' ? currentExpiresAt(view.forecast, view.fetchedAt) : null;
  useEffect(() => {
    if (readingExpiresAt === null || readingExpiresAt <= now()) return;
    const timer = window.setTimeout(() => wake(value => value + 1), readingExpiresAt - now() + 50);
    return () => window.clearTimeout(timer);
  }, [readingExpiresAt, now]);

  const current = view.status !== 'ready' || forecastCurrent(view.forecast, view.fetchedAt, now());
  const forecast = view.status === 'ready' && current ? view.forecast : null;
  const reading = view.status === 'ready' && current ? currentTemperature(view.forecast, view.fetchedAt, now()) : null;
  return { view: current ? view : { status: online ? 'loading' : 'offline' } as WeatherView, forecast, currentTemperature: reading, override, setOverride, canRetry, retry };
}
