-- Apply ONCE only if the original revision 1.0 migration is already installed.
-- Fresh projects use the updated 07-DATABASE-AND-RLS.sql instead of this upgrade.
-- No existing owner data, language choice, timezone or currency is rewritten.
begin;
alter table public.profiles
  add column ui_language text check (ui_language in ('en','fi','sv'));
comment on column public.profiles.ui_language is
  'Independent owner UI preference: en, fi or sv; NULL until first choice. Existing owner RLS applies.';
commit;
