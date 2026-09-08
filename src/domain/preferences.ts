import { categories, isRecord } from './wardrobe';
import { AppError } from '../data/errors';
import type { PreferencesRow, ProfileRow } from '../data/rows';

export const colours = ['black', 'white', 'grey', 'navy', 'blue', 'green', 'olive', 'beige', 'brown', 'red', 'yellow', 'orange', 'pink', 'purple'] as const;
export const styleTagLimit = 40;
export type ProfileFields = Pick<ProfileRow, 'display_name' | 'timezone' | 'currency'>;
export type PreferenceFields = Omit<PreferencesRow, 'owner_id' | 'version'>;

export function profileFields(value: ProfileFields): ProfileFields {
  return { display_name: value.display_name, timezone: value.timezone, currency: value.currency };
}
export function sameProfileFields(a: ProfileFields, b: ProfileFields): boolean {
  return a.display_name === b.display_name && a.timezone === b.timezone && a.currency === b.currency;
}
export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100 || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}
export function validateProfile(value: ProfileFields): ProfileFields {
  if (typeof value.display_name !== 'string' || !value.display_name.trim() || [...value.display_name].length > 60) throw new AppError('settings.invalidName');
  if (!validTimezone(value.timezone)) throw new AppError('settings.invalidTimezone');
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw new AppError('settings.invalidCurrency');
  return profileFields(value);
}
export function preferenceFields(value: PreferenceFields): PreferenceFields {
  return {
    preferred_colours: [...value.preferred_colours], style_tags: [...value.style_tags],
    excluded_categories: [...value.excluded_categories],
    minimum_upper_coverage: value.minimum_upper_coverage, minimum_lower_coverage: value.minimum_lower_coverage,
    cold_sensitivity: value.cold_sensitivity, repeat_gap_days: value.repeat_gap_days,
  };
}
export function isPreferenceFields(value: unknown): value is PreferenceFields {
  return isRecord(value)
    && ['preferred_colours', 'style_tags', 'excluded_categories'].every((key) =>
      Array.isArray(value[key]) && value[key].every((entry: unknown) => typeof entry === 'string'))
    && [['minimum_upper_coverage', 0, 2], ['minimum_lower_coverage', 0, 2], ['cold_sensitivity', -2, 2], ['repeat_gap_days', 0, 14]].every(([key, min, max]) =>
      typeof value[key!] === 'number' && Number.isInteger(value[key!]) && Number(value[key!]) >= Number(min) && Number(value[key!]) <= Number(max))
    && value.preferred_colours instanceof Array && value.preferred_colours.length <= 8
    && value.style_tags instanceof Array && value.style_tags.length <= 8
    && value.excluded_categories instanceof Array && value.excluded_categories.length <= 7;
}
export function validatePreferences(value: PreferenceFields, baseline?: PreferenceFields): PreferenceFields {
  if (!isPreferenceFields(value)) throw new AppError('settings.invalidPreferences');
  for (const [key, allowed] of [['preferred_colours', colours], ['excluded_categories', categories]] as const) {
    if (value[key].some((entry) => !allowed.some((id) => id === entry) && !baseline?.[key].includes(entry))) throw new AppError('settings.invalidPreferences');
  }
  if (value.style_tags.some((tag) => (!tag.trim() || [...tag].length > styleTagLimit) && !baseline?.style_tags.includes(tag))) throw new AppError('settings.invalidTag');
  for (const key of ['preferred_colours', 'style_tags', 'excluded_categories'] as const) {
    if (value[key].some((entry) => value[key].filter((v) => v === entry).length > Math.max(1, baseline?.[key].filter((v) => v === entry).length ?? 0))) throw new AppError('settings.invalidPreferences');
  }
  return preferenceFields(value);
}
