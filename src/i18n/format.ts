import { locales, type Language } from './index';

export function parsePrice(text: string, language: Language): string {
  const value = text.trim();
  const separator = language !== 'en' && value.includes(',') ? ',' : '.';
  const parts = value.split(separator);
  let integer = parts[0] ?? '';
  const fraction = parts[1];
  const grouping = language === 'en' ? /^(?:\d+|\d{1,3}(?:,\d{3})+)$/ : /^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/;
  if (parts.length > 2 || !grouping.test(integer) || fraction !== undefined && !/^\d{1,2}$/.test(fraction)) throw new Error('Invalid price');
  integer = integer.replace(/[, \u00a0\u202f]/g, '').replace(/^0+(?=\d)/, '');
  if (integer.length > 10) throw new Error('Invalid price');
  return `${integer}.${(fraction ?? '').padEnd(2, '0')}`;
}

export function canonicalPrice(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid price');
  const text = String(value);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new Error('Invalid price');
  return parsePrice(text, 'en');
}

// The SDK expects a number; require a bounded decimal round trip, not exact binary representation.
export function priceForDatabase(decimal: string): number {
  const canonical = canonicalPrice(decimal);
  const value = Number(canonical);
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99 || value.toFixed(2) !== canonical) throw new Error('Invalid price');
  return value;
}

export function formatMoney(decimal: string, currency: string, language: Language): string {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid money');
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency }).format(Number(canonicalPrice(decimal)));
}

export function validDateOnly(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso.startsWith('0000')) return false;
  const date = new Date(`${iso}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

export function formatDateOnly(iso: string, language: Language): string {
  if (!validDateOnly(iso)) throw new Error('Invalid date');
  return new Intl.DateTimeFormat(locales[language], { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00.000Z`));
}
