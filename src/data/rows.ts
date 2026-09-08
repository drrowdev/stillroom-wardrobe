// Row shapes the Phase 0 screens use, narrowed from the generated schema types.
import type { Database } from './database.types';
import type { Language } from '../i18n';

type Tables = Database['public']['Tables'];
type Columns<Table extends keyof Tables, Names extends keyof Tables[Table]['Row']> =
  Pick<Tables[Table]['Row'], Names>;

export type ProfileRow =
  Omit<Columns<'profiles', 'owner_id' | 'display_name' | 'ui_language' | 'timezone' | 'currency' | 'version'>, 'ui_language'>
  & { ui_language: Language | null };

export type PreferencesRow = Columns<'style_preferences',
  'owner_id' | 'version' | 'preferred_colours' | 'style_tags' | 'excluded_categories' |
  'minimum_upper_coverage' | 'minimum_lower_coverage' | 'cold_sensitivity' | 'repeat_gap_days'>;
