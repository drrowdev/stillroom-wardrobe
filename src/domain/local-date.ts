import { validDateOnly } from '../i18n/format';

// Calendar days are plain YYYY-MM-DD strings. Arithmetic runs on UTC midnights, which have no daylight-saving gaps,
// so a stored local date never moves when the device or profile time zone changes.
const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const parts = (iso: string): [number, number, number] => {
  if (!validDateOnly(iso)) throw new Error('Invalid date');
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return [year, month, day];
};
const utc = (year: number, month: number, day: number) => { const value = new Date(0); value.setUTCFullYear(year, month, day); return value; };
const fromUtc = (value: Date) => `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;

export function todayIn(timeZone: string, now = new Date()): string {
  const read = (zone?: string) => {
    const values = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => values.find(value => value.type === type)?.value ?? '';
    const iso = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
    if (!validDateOnly(iso)) throw new Error('Invalid date');
    return iso;
  };
  try { return read(timeZone); } catch { return read(); }
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = parts(iso);
  return fromUtc(utc(year, month - 1, day + days));
}

export function monthOf(iso: string): string {
  parts(iso);
  return iso.slice(0, 7);
}
export function validMonth(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && validDateOnly(`${month}-01`);
}
export function addMonths(month: string, count: number): string {
  if (!validMonth(month)) throw new Error('Invalid month');
  const [year, value] = month.split('-').map(Number) as [number, number];
  return fromUtc(utc(year, value - 1 + count, 1)).slice(0, 7);
}
export function monthRange(month: string): { first: string; last: string } {
  const first = `${month}-01`;
  if (!validMonth(month)) throw new Error('Invalid month');
  return { first, last: addDays(`${addMonths(month, 1)}-01`, -1) };
}

// ISO weekday: 1 is Monday and 7 is Sunday.
export function weekday(iso: string): number {
  const [year, month, day] = parts(iso);
  return utc(year, month - 1, day).getUTCDay() || 7;
}

type WeekInfo = { firstDay?: number };
export function firstWeekday(locale: string): number {
  try {
    const value = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
    const day = (typeof value.getWeekInfo === 'function' ? value.getWeekInfo() : value.weekInfo)?.firstDay;
    return typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7 ? day : 1;
  } catch { return 1; }
}

// Whole weeks covering the month, starting on the locale's first weekday.
export function monthGrid(month: string, firstDay: number): string[][] {
  const { first, last } = monthRange(month);
  let cursor = addDays(first, -((weekday(first) - firstDay + 7) % 7));
  const weeks: string[][] = [];
  while (cursor <= last) {
    const week: string[] = [];
    for (let index = 0; index < 7; index++) { week.push(cursor); cursor = addDays(cursor, 1); }
    weeks.push(week);
  }
  return weeks;
}

const noon = (iso: string) => { parts(iso); return new Date(`${iso}T12:00:00.000Z`); };
// Formatting reads the date at UTC noon, so the shown day is the stored day in every time zone.
export function formatDay(iso: string, locale: string, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale, style === 'long'
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(noon(iso));
}
export function formatMonth(month: string, locale: string): string {
  if (!validMonth(month)) throw new Error('Invalid month');
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(noon(`${month}-01`));
}
export function weekdayNames(locale: string, firstDay: number): { short: string; long: string }[] {
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, index) => {
    const date = noon(addDays('2024-01-01', (firstDay - 1 + index) % 7));
    return {
      short: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(date),
      long: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date),
    };
  });
}
