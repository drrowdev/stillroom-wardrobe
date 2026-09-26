import { describe, expect, it } from 'vitest';
import { forecastZoneSuffix } from '../../src/features/today/weather-zone';

const at = Date.UTC(2026, 8, 26, 6, 0);

describe('forecast zone suffix', () => {
  it('adds nothing for the same zone or an alias of it', () => {
    expect(forecastZoneSuffix('Europe/Helsinki', 'Europe/Helsinki', at, 'en-GB')).toBeNull();
    expect(forecastZoneSuffix('Asia/Kolkata', 'Asia/Calcutta', at, 'en-GB')).toBeNull();
    expect(forecastZoneSuffix('Asia/Calcutta', 'Asia/Kolkata', at, 'fi')).toBeNull();
  });

  it('names a genuinely different zone in the current language, never by its ID', () => {
    for (const locale of ['en-GB', 'fi', 'sv']) {
      const name = forecastZoneSuffix('Europe/Helsinki', 'Europe/Stockholm', at, locale);
      expect(name).toBeTruthy();
      expect(name).not.toContain('Europe/');
    }
    expect(forecastZoneSuffix('America/New_York', 'Europe/Helsinki', at, 'en-GB')).not.toBeNull();
  });

  it('shows the suffix when the profile zone cannot be resolved, and never throws for an unknown forecast zone', () => {
    const name = forecastZoneSuffix('Europe/Helsinki', 'Not/AZone', at, 'en-GB');
    expect(name).toBeTruthy();
    expect(name).not.toContain('Europe/');
    // Nothing trustworthy can name an unknown forecast zone, so the heading keeps city and date only.
    expect(forecastZoneSuffix('Not/AZone', 'Europe/Helsinki', at, 'en-GB')).toBeNull();
  });
});
