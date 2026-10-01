import type { Forecast } from '../../domain/weather';
import { locales, type Language, type Translate } from '../../i18n';

export const temperature = (value: number, language: Language) =>
  new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'celsius', maximumFractionDigits: 0 }).format(value);

// The forecast as short chips, in a fixed order; a value the forecast does not have is left out.
export function weatherChips(forecast: Pick<Forecast, 'minTemperature' | 'maxRain' | 'maxWind'>, language: Language, t: Translate): string[] {
  const locale = locales[language];
  const chips: string[] = [];
  if (forecast.minTemperature !== null) chips.push(t('weather.low', { temperature: temperature(forecast.minTemperature, language) }));
  if (forecast.maxRain !== null) chips.push(t('weather.rain', { chance: new Intl.NumberFormat(locale, { style: 'percent' }).format(forecast.maxRain / 100) }));
  if (forecast.maxWind !== null) chips.push(t('weather.wind', { speed: new Intl.NumberFormat(locale, { style: 'unit', unit: 'meter-per-second', maximumFractionDigits: 0 }).format(forecast.maxWind) }));
  return chips;
}
