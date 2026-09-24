import { afterEach, describe, expect, it, vi } from 'vitest';
import { currencyOptions, timeZoneOptions } from '../../src/features/profile/profile-options';
import { validTimezone } from '../../src/domain/preferences';
import type { Language } from '../../src/i18n';

const zoneName = (locale: string, zone: string) => new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' })
  .formatToParts(0).find((part) => part.type === 'timeZoneName')!.value;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('profile time zone and currency options', () => {
  it('adds a kept value missing from the list exactly once, labelled and sorted', () => {
    const zones = timeZoneOptions('en', ['Etc/Test-Kept', 'Europe/Helsinki', ''], ['Europe/Helsinki', 'America/New_York'])!;
    expect(zones.map((option) => option.value).sort()).toEqual(['America/New_York', 'Etc/Test-Kept', 'Europe/Helsinki']);
    expect(zones.find((option) => option.value === 'Etc/Test-Kept')!.label).toBe('Etc/Test-Kept');
    expect(zones.find((option) => option.value === 'America/New_York')!.label).toBe(`New York (${zoneName('en-GB', 'America/New_York')})`);
    const collator = new Intl.Collator('en-GB');
    expect(zones.map((option) => option.label)).toEqual(zones.map((option) => option.label).sort(collator.compare));
    const currencies = currencyOptions('en', ['SEK', 'EUR'], ['EUR'])!;
    expect(currencies.map((option) => option.value).sort()).toEqual(['EUR', 'SEK']);
    expect(currencies.find((option) => option.value === 'SEK')!.label).toBe(`${new Intl.DisplayNames('en-GB', { type: 'currency' }).of('SEK')} (SEK)`);
  });

  it.each(['en', 'fi', 'sv'] satisfies Language[])('labels from Intl names in %s', (language) => {
    const locale = { en: 'en-GB', fi: 'fi-FI', sv: 'sv-FI' }[language];
    expect(timeZoneOptions(language, [], ['Europe/Helsinki'])).toEqual([{ value: 'Europe/Helsinki', label: `Helsinki (${zoneName(locale, 'Europe/Helsinki')})` }]);
    expect(currencyOptions(language, [], ['EUR'])).toEqual([{ value: 'EUR', label: `${new Intl.DisplayNames(locale, { type: 'currency' }).of('EUR')} (EUR)` }]);
  });

  it('falls back to the raw value when Intl formatting fails', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => { throw new RangeError('synthetic'); });
    vi.spyOn(Intl.DisplayNames.prototype, 'of').mockImplementation(() => { throw new RangeError('synthetic'); });
    expect(timeZoneOptions('fi', [], ['Europe/Helsinki'])).toEqual([{ value: 'Europe/Helsinki', label: 'Europe/Helsinki' }]);
    expect(currencyOptions('fi', [], ['EUR'])).toEqual([{ value: 'EUR', label: 'EUR' }]);
  });

  it('breaks label ties by value', () => {
    vi.spyOn(Intl.DisplayNames.prototype, 'of').mockReturnValue('Same');
    expect(currencyOptions('en', [], ['XBB', 'XAA'])!.map((option) => option.value)).toEqual(['XAA', 'XBB']);
  });

  it('returns null when the browser cannot list values', () => {
    vi.stubGlobal('Intl', { ...Intl, supportedValuesOf: undefined });
    expect(timeZoneOptions('en', ['Europe/Helsinki'])).toBeNull();
    expect(currencyOptions('en', ['EUR'])).toBeNull();
    vi.stubGlobal('Intl', { ...Intl, supportedValuesOf: () => { throw new RangeError('synthetic'); } });
    expect(timeZoneOptions('en', ['Europe/Helsinki'])).toBeNull();
    expect(currencyOptions('en', ['EUR'])).toBeNull();
  });

  it('uses the platform list by default with valid codes and zones', () => {
    const currencies = currencyOptions('en', ['EUR'])!;
    expect(currencies.every((option) => /^[A-Z]{3}$/.test(option.value))).toBe(true);
    expect(new Set(currencies.map((option) => option.value)).size).toBe(currencies.length);
    const zones = timeZoneOptions('sv', ['Europe/Helsinki'])!;
    expect(zones.filter((option) => option.value === 'Europe/Helsinki')).toHaveLength(1);
    expect(validTimezone('Europe/Helsinki')).toBe(true);
  });
});
