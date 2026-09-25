// Row shapes the Phase 0 screens use, narrowed from the generated schema types.
import type { Database } from './database.types';
import type { Language } from '../i18n';

type Tables = Database['public']['Tables'];
type Columns<Table extends keyof Tables, Names extends keyof Tables[Table]['Row']> =
  Pick<Tables[Table]['Row'], Names>;

// Every profile read and write returns these columns, so a later save never drops the weather settings.
export const profileColumns = 'owner_id,display_name,ui_language,timezone,currency,weather_enabled,weather_city,latitude,longitude,version';
export type ProfileRow =
  Omit<Columns<'profiles', 'owner_id' | 'display_name' | 'ui_language' | 'timezone' | 'currency' | 'version'>, 'ui_language'>
  & { ui_language: Language | null }
  & Columns<'profiles', 'weather_enabled' | 'weather_city' | 'latitude' | 'longitude'>;

export type PreferencesRow = Columns<'style_preferences',
  'owner_id' | 'version' | 'preferred_colours' | 'style_tags' | 'excluded_categories' |
  'minimum_upper_coverage' | 'minimum_lower_coverage' | 'cold_sensitivity' | 'repeat_gap_days'>;
