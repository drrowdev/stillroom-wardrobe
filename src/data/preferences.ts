import type { AppClient } from './client';
import type { OwnerScope } from '../auth/session';
import type { PreferencesRow } from './rows';
import { isRecord, isUuid } from '../domain/wardrobe';
import { isPreferenceFields, preferenceFields, validatePreferences, type PreferenceFields } from '../domain/preferences';
import { AppError, requireSuccess, throwIfAborted } from './errors';

const columns = 'owner_id,version,preferred_colours,style_tags,excluded_categories,minimum_upper_coverage,minimum_lower_coverage,cold_sensitivity,repeat_gap_days';
export function parsePreferences(value: unknown, ownerId: string): PreferencesRow {
  if (!isRecord(value) || !isUuid(ownerId) || value.owner_id !== ownerId
    || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) throw new AppError('settings.preferencesUnavailable');
  const version = value.version;
  if (!isPreferenceFields(value)) throw new AppError('settings.preferencesUnavailable');
  return { owner_id: ownerId, version, ...preferenceFields(value) };
}
export async function fetchPreferences(client: AppClient, scope: OwnerScope): Promise<PreferencesRow> {
  throwIfAborted(scope.signal);
  const { data, error } = await client.from('style_preferences').select(columns).eq('owner_id', scope.ownerId).abortSignal(scope.signal).maybeSingle();
  throwIfAborted(scope.signal);
  requireSuccess(error);
  return parsePreferences(data, scope.ownerId);
}
export async function savePreferences(client: AppClient, scope: OwnerScope, baseline: PreferencesRow, fields: PreferenceFields): Promise<PreferencesRow> {
  throwIfAborted(scope.signal);
  if (baseline.owner_id !== scope.ownerId || !Number.isSafeInteger(baseline.version) || baseline.version < 1) throw new AppError('settings.preferencesUnavailable');
  const { data, error } = await client.from('style_preferences').update(validatePreferences(fields, baseline))
    .eq('owner_id', scope.ownerId).eq('version', baseline.version).select(columns).abortSignal(scope.signal).maybeSingle();
  throwIfAborted(scope.signal);
  requireSuccess(error);
  if (data) return parsePreferences(data, scope.ownerId);
  const current = await fetchPreferences(client, scope);
  throw new AppError(current.version !== baseline.version ? 'error.conflict' : 'error.unavailable');
}
