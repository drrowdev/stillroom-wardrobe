import type { AppClient } from './client';
import { isLanguage, type Language } from '../i18n';
import { isRecord, isUuid } from '../domain/wardrobe';
import { AppError, requireSuccess, throwIfAborted } from './errors';
import type { ProfileRow } from './rows';
import type { OwnerScope } from '../auth/session';
import { validateProfile, type ProfileFields } from '../domain/preferences';

const columns = 'owner_id,display_name,ui_language,timezone,currency,version';
export type ProfileUpdate = { kind: 'profile'; fields: ProfileFields } | { kind: 'language'; language: Language };

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
  };
}
export async function fetchProfile(client: AppClient, ownerId: string, signal: AbortSignal): Promise<ProfileRow> {
  throwIfAborted(signal);
  const { data, error } = await client.from('profiles')
    .select('owner_id,display_name,ui_language,timezone,currency,version').eq('owner_id', ownerId)
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
    .select('owner_id,display_name,ui_language,timezone,currency,version').abortSignal(signal).maybeSingle();
  throwIfAborted(signal);
  requireSuccess(error);
  return data ? parseProfile(data, profile.owner_id) : fetchProfile(client, profile.owner_id, signal);
}
export async function updateProfile(client: AppClient, scope: OwnerScope, baseline: ProfileRow, update: ProfileUpdate): Promise<ProfileRow> {
  throwIfAborted(scope.signal);
  if (baseline.owner_id !== scope.ownerId || !Number.isSafeInteger(baseline.version) || baseline.version < 1) throw new AppError('account.locked');
  if (update.kind === 'language' && !isLanguage(update.language)) throw new AppError('error.unavailable');
  const body = update.kind === 'profile' ? validateProfile(update.fields) : { ui_language: update.language };
  const { data, error } = await client.from('profiles').update(body)
    .eq('owner_id', scope.ownerId).eq('version', baseline.version).select(columns).abortSignal(scope.signal).maybeSingle();
  throwIfAborted(scope.signal);
  if (isRecord(error) && error.code === 'P0001' && error.message === 'Invalid timezone') throw new AppError('settings.serverTimezone');
  requireSuccess(error);
  if (data) return parseProfile(data, scope.ownerId);
  const current = await fetchProfile(client, scope.ownerId, scope.signal);
  throw new AppError(current.version !== baseline.version ? 'error.conflict' : 'error.unavailable');
}
