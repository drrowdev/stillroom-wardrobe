// Row shapes the Phase 0 screens use, narrowed from the generated schema types.
import type { Database } from './database.types';
import type { Language } from '../i18n';

type Tables = Database['public']['Tables'];
type Columns<Table extends keyof Tables, Names extends keyof Tables[Table]['Row']> =
  Pick<Tables[Table]['Row'], Names>;

export type ProfileRow =
  Omit<Columns<'profiles', 'owner_id' | 'display_name' | 'ui_language' | 'timezone' | 'currency' | 'version'>, 'ui_language'>
  & { ui_language: Language | null };
