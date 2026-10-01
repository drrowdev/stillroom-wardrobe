import { describe, expect, it } from 'vitest';
import { translate, type Language, type MessageKey } from '../../src/i18n';
import { temperature, weatherChips } from '../../src/features/today/weather-chips';

const createTranslator = (language: Language) => (key: MessageKey, parameters?: Record<string, string | number>) => translate(language, key, parameters);
const forecast = { minTemperature: -3, maxRain: 40, maxWind: 8 };

describe('weather chips', () => {
  it('formats low, rain and wind in each language', () => {
    expect(weatherChips(forecast, 'en', createTranslator('en')).map(normal)).toEqual(['Low -3°C', 'Rain 40%', 'Wind 8 m/s']);
    expect(weatherChips(forecast, 'fi', createTranslator('fi')).map(normal)).toEqual(['Alin -3 °C', 'Sade 40 %', 'Tuuli 8 m/s']);
    expect(weatherChips(forecast, 'sv', createTranslator('sv')).map(normal)).toEqual(['Lägst -3 °C', 'Regn 40 %', 'Vind 8 m/s']);
  });

  it('leaves out values the forecast does not have', () => {
    const t = createTranslator('en');
    expect(weatherChips({ minTemperature: null, maxRain: 0, maxWind: null }, 'en', t).map(normal)).toEqual(['Rain 0%']);
    expect(weatherChips({ minTemperature: null, maxRain: null, maxWind: null }, 'en', t)).toEqual([]);
  });

  it('writes a negative temperature with a minus sign where the language does', () => {
    expect(temperature(-3, 'fi')).toContain('−3');
    expect(temperature(-3, 'sv')).toContain('−3');
  });
});

// Intl uses no-break and narrow spaces, and some locales a true minus sign; compare their plain forms.
function normal(text: string) { return text.replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-'); }
