import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, dayParts, firstWeekday, formatDay, formatMonth, monthGrid, monthOf, monthRange, todayIn, validMonth, weekday, weekdayNames,
} from '../../src/domain/local-date';
import { languages, locales, translate } from '../../src/i18n';

describe('local calendar dates', () => {
  it('builds day headings with a standalone weekday, leaving English and Swedish as the full Intl date', () => {
    const heading = (language: (typeof languages)[number], iso: string) => translate(language, 'calendar.dayHeading', dayParts(iso, locales[language]));
    for (const iso of ['2026-09-14', '2026-09-16', '2026-01-01', '2026-12-27']) {
      expect(heading('en', iso)).toBe(formatDay(iso, locales.en));
      expect(heading('sv', iso)).toBe(formatDay(iso, locales.sv));
      const { weekday } = dayParts(iso, locales.fi);
      expect(heading('fi', iso).startsWith(`${weekday} `)).toBe(true);
    }
    expect(heading('fi', '2026-09-16')).toBe('keskiviikko 16. syyskuuta 2026');
    expect(formatDay('2026-09-16', locales.fi)).toBe('keskiviikkona 16. syyskuuta 2026');
  });

  it('reads today in the profile time zone, not the device zone', () => {
    const now = new Date('2026-09-16T22:30:00Z');
    expect(todayIn('Europe/Helsinki', now)).toBe('2026-09-17');
    expect(todayIn('America/New_York', now)).toBe('2026-09-16');
    expect(todayIn('Pacific/Kiritimati', new Date('2026-12-31T10:30:00Z'))).toBe('2027-01-01');
  });

  it('falls back to the device zone for an unknown profile zone', () => {
    expect(todayIn('Not/AZone', new Date('2026-09-16T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('adds days across months, years, leap days and daylight-saving changes', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(() => addDays('2026-02-30', 1)).toThrow();
  });

  it('works with months', () => {
    expect(monthOf('2026-09-16')).toBe('2026-09');
    expect(validMonth('2026-09')).toBe(true);
    expect(validMonth('2026-13')).toBe(false);
    expect(validMonth('2026-9')).toBe(false);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthRange('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(monthRange('2026-09')).toEqual({ first: '2026-09-01', last: '2026-09-30' });
    expect(() => addMonths('2026-00', 1)).toThrow();
  });

  it('numbers weekdays from Monday', () => {
    expect(weekday('2026-09-14')).toBe(1);
    expect(weekday('2026-09-20')).toBe(7);
  });

  it('starts weeks on the locale’s first day, with Monday as the fallback', () => {
    expect(firstWeekday('fi-FI')).toBe(1);
    expect(firstWeekday('sv-SE')).toBe(1);
    expect([1, 7]).toContain(firstWeekday('en-US'));
    expect(firstWeekday('not a locale')).toBe(1);
  });

  it('builds whole weeks that cover the month', () => {
    const monday = monthGrid('2026-09', 1);
    expect(monday[0]![0]).toBe('2026-08-31');
    expect(monday.at(-1)!.at(-1)).toBe('2026-10-04');
    expect(monday.every(week => week.length === 7 && weekday(week[0]!) === 1)).toBe(true);
    const sunday = monthGrid('2026-09', 7);
    expect(sunday[0]![0]).toBe('2026-08-30');
    expect(sunday.flat()).toContain('2026-09-30');
    expect(monthGrid('2027-02', 1)).toHaveLength(4);
    expect(monthGrid('2026-02', 1)).toHaveLength(5);
  });

  it('formats the stored day, never a neighbouring one', () => {
    expect(formatDay('2026-09-16', 'en-GB')).toContain('16');
    expect(formatDay('2026-09-16', 'fi-FI')).toContain('16');
    expect(formatDay('2026-01-01', 'en-GB', 'short')).toContain('1');
    expect(formatMonth('2026-09', 'sv-SE').toLowerCase()).toContain('september');
    const fi = weekdayNames('fi-FI', 1);
    expect(fi).toHaveLength(7);
    expect(fi[0]!.long.toLowerCase()).toBe('maanantai');
    expect(weekdayNames('en-US', 7)[0]!.long).toBe('Sunday');
  });
});
