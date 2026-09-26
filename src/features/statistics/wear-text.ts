import { validDateOnly } from '../../i18n/format';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';

// Shared by the statistics screen and the item page, so both word the same counts the same way.
export const number = (value: number, language: Language) => new Intl.NumberFormat(locales[language]).format(value);
export const pluralKey = <K extends MessageKey>(count: number, language: Language, one: K, other: K): K =>
  new Intl.PluralRules(locales[language]).select(count) === 'one' ? one : other;

export function wearCountText(count: number, language: Language, t: Translate): string {
  if (count === 0) return t('stats.neverWorn');
  return t(pluralKey(count, language, 'stats.wears_one', 'stats.wears_other'), { count: number(count, language) });
}
export function lastWornText(lastWorn: string, language: Language, t: Translate): string {
  if (!validDateOnly(lastWorn)) throw new Error('Invalid date');
  // A stored local date is shown as that same calendar day in every time zone.
  const date = new Intl.DateTimeFormat(locales[language], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${lastWorn}T12:00:00.000Z`));
  return t('stats.lastWornOn', { date });
}
// Cost per wear, formatted from the exact quotient so each currency's own minor units do the rounding.
export function costPerWearText(price: string, count: number, currency: string, language: Language): string {
  if (!/^\d{1,10}\.\d{2}$/.test(price) || !Number.isSafeInteger(count) || count <= 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid cost');
  // Truncated to eight places, which never changes rounding to a currency's two or three minor units.
  const digits = (BigInt(price.replace('.', '')) * 1_000_000n / BigInt(count)).toString().padStart(9, '0');
  const exact = `${digits.slice(0, -8)}.${digits.slice(-8)}` as `${number}`;
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency }).format(exact);
}
export function wearLineText(count: number, lastWorn: string | null, language: Language, t: Translate): string {
  const wears = wearCountText(count, language, t);
  return lastWorn ? t('stats.wearLine', { wears, lastWorn: lastWornText(lastWorn, language, t) }) : wears;
}
