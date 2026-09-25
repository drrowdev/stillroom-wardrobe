import { locales, translate, type Language } from '../../i18n';

export type ProfileOption = { value: string; label: string };
type Kind = 'timeZone' | 'currency';

function supported(kind: Kind): readonly string[] | null {
  try { return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf(kind) : null; } catch { return null; }
}
// A short current offset keeps the closed select readable at 320px. Locales disagree on "GMT" and "UTC",
// so the offset is read in a fixed form and written as UTC in every language.
export function utcOffset(value: string, now: Date): string | null {
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: value, timeZoneName: 'longOffset' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value;
  const match = offset?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
  if (!match) return null;
  // ICU versions differ: UTC can come back as "GMT", "GMT+00:00" or "GMT-00:00".
  if (!match[1] || Number(match[2]) === 0 && match[3] === '00') return 'UTC';
  const hours = String(Number(match[2]));
  return `UTC${match[1] === '-' ? '\u2212' : '+'}${match[3] === '00' ? hours : `${hours}:${match[3]}`}`;
}
function timeZoneLabel(language: Language, value: string, now: Date): string {
  const city = (value.split('/').pop() ?? value).replaceAll('_', ' ');
  try {
    const name = utcOffset(value, now);
    return name ? translate(language, 'settings.timeZoneOption', { city, name }) : value;
  } catch { return value; }
}
function currencyLabel(language: Language, names: Intl.DisplayNames | null, value: string): string {
  try {
    const name = names?.of(value);
    return name && name !== value ? translate(language, 'settings.currencyOption', { name, code: value }) : value;
  } catch { return value; }
}
function build(language: Language, kind: Kind, keep: readonly string[], values: readonly string[] | null | undefined): ProfileOption[] | null {
  const list = values === undefined ? supported(kind) : values;
  if (!list) return null;
  let names: Intl.DisplayNames | null = null;
  if (kind === 'currency') try { names = new Intl.DisplayNames(locales[language], { type: 'currency' }); } catch { names = null; }
  const unique = [...new Set([...list, ...keep.filter((value) => value !== '')])];
  const now = new Date();
  const options = unique.map((value) => ({ value, label: kind === 'timeZone' ? timeZoneLabel(language, value, now) : currencyLabel(language, names, value) }));
  const collator = new Intl.Collator(locales[language]);
  return options.sort((a, b) => collator.compare(a.label, b.label) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}
/** Returns null when the browser cannot list values; callers then show a text field. Kept values are always included. */
export function timeZoneOptions(language: Language, keep: readonly string[], values?: readonly string[] | null): ProfileOption[] | null {
  return build(language, 'timeZone', keep, values);
}
export function currencyOptions(language: Language, keep: readonly string[], values?: readonly string[] | null): ProfileOption[] | null {
  return build(language, 'currency', keep, values);
}
