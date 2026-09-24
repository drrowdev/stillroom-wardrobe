import type { AppClient } from './client';
import type { Database } from './database.types';
import { isLanguage, type Language } from '../i18n';
import { isRecord, isUuid } from '../domain/wardrobe';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import { profileColumns as columns, type ProfileRow } from './rows';
import type { OwnerScope } from '../auth/session';
import { validateProfile, type ProfileFields } from '../domain/preferences';
import { weatherPlace, type WeatherPlace } from '../domain/weather';

export type ProfileUpdate = { kind: 'profile'; fields: ProfileFields } | { kind: 'language'; language: Language }
  | { kind: 'weather'; place: WeatherPlace | null };

// Weather is an optional part of the profile: a missing or damaged setting reads as incomplete, never as a locked account.
const coordinate = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

export function parseProfile(value: unknown, ownerId: string): ProfileRow {
  if (!isRecord(value) || value.owner_id !== ownerId || !isUuid(ownerId)
    || typeof value.display_name !== 'string' || !value.display_name
    || !(value.ui_language === null || isLanguage(value.ui_language))
    || typeof value.timezone !== 'string' || typeof value.currency !== 'string'
    || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new AppError('account.locked');
  }
  return {
    owner_id: ownerId, display_name: value.display_name, ui_language: value.ui_language,
    timezone: value.timezone, currency: value.currency, version: value.version,
    weather_enabled: value.weather_enabled === true,
    weather_city: typeof value.weather_city === 'string' && value.weather_city.length <= 100 ? value.weather_city : null,
    latitude: coordinate(value.latitude, 90), longitude: coordinate(value.longitude, 180),
  };
}
export async function fetchProfile(client: AppClient, ownerId: string, signal: AbortSignal): Promise<ProfileRow> {
  throwIfAborted(signal);
  const { data, error } = await client.from('profiles')
    .select(columns).eq('owner_id', ownerId)
    .abortSignal(signal).maybeSingle();
  throwIfAborted(signal);
  requireSuccess(error);
  return parseProfile(data, ownerId);
}
export async function saveInitialLanguage(
  client: AppClient, profile: ProfileRow, language: Language, signal: AbortSignal,
): Promise<ProfileRow> {
  const { data, error } = await client.from('profiles').update({ ui_language: language })
    .eq('owner_id', profile.owner_id).eq('version', profile.version).is('ui_language', null)
    .select(columns).abortSignal(signal).maybeSingle();
  throwIfAborted(signal);
  requireSuccess(error);
  return data ? parseProfile(data, profile.owner_id) : fetchProfile(client, profile.owner_id, signal);
}
export async function updateProfile(client: AppClient, scope: OwnerScope, baseline: ProfileRow, update: ProfileUpdate): Promise<ProfileRow> {
  throwIfAborted(scope.signal);
  if (baseline.owner_id !== scope.ownerId || !Number.isSafeInteger(baseline.version) || baseline.version < 1) throw new AppError('account.locked');
  if (update.kind === 'language' && !isLanguage(update.language)) throw new AppError('error.unavailable');
  let body: Database['public']['Tables']['profiles']['Update'];
  if (update.kind === 'profile') body = validateProfile(update.fields);
  else if (update.kind === 'language') body = { ui_language: update.language };
  else if (update.place === null) body = { weather_enabled: false, weather_city: null, latitude: null, longitude: null };
  else {
    const place = weatherPlace(update.place);
    if (!place) throw new AppError('error.unavailable');
    body = { weather_enabled: true, weather_city: place.city, latitude: place.latitude, longitude: place.longitude };
  }
  const { data, error } = await client.from('profiles').update(body)
    .eq('owner_id', scope.ownerId).eq('version', baseline.version).select(columns).abortSignal(scope.signal).maybeSingle();
  throwIfAborted(scope.signal);
  if (isRecord(error) && error.code === 'P0001' && error.message === 'Invalid timezone') throw new AppError('settings.serverTimezone');
  requireSuccess(error);
  if (data) return parseProfile(data, scope.ownerId);
  const current = await fetchProfile(client, scope.ownerId, scope.signal);
  throw new AppError(current.version !== baseline.version ? 'error.conflict' : 'error.unavailable');
}
