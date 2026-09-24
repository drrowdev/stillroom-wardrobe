import { locales, translate, type Language } from '../../i18n';

export type ProfileOption = { value: string; label: string };
type Kind = 'timeZone' | 'currency';

function supported(kind: Kind): readonly string[] | null {
  try { return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf(kind) : null; } catch { return null; }
}
function timeZoneLabel(language: Language, value: string): string {
  const city = (value.split('/').pop() ?? value).replaceAll('_', ' ');
  try {
    const name = new Intl.DateTimeFormat(locales[language], { timeZone: value, timeZoneName: 'longGeneric' })
      .formatToParts(0).find((part) => part.type === 'timeZoneName')?.value;
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
  const options = unique.map((value) => ({ value, label: kind === 'timeZone' ? timeZoneLabel(language, value) : currencyLabel(language, names, value) }));
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
