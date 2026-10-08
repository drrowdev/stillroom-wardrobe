import type { HourlyTemperature } from '../../domain/weather';
import { locales, type Language, type Translate } from '../../i18n';
import { temperature } from './weather-chips';

export function WeatherHours({ hours, language, t }: { hours: readonly HourlyTemperature[]; language: Language; t: Translate }) {
  const time = new Intl.DateTimeFormat(locales[language], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  return <div className="weather-hours">
    <h3 id="weather-hours-title">{t('weather.hourly')}</h3>
    {hours.some(hour => hour.temperatureC !== null)
      ? <ul aria-labelledby="weather-hours-title">{hours.map(hour => <li key={hour.time}>
        <time className="muted" dateTime={hour.time}>{time.format(new Date(`${hour.time}:00Z`))}</time>
        <span>{hour.temperatureC === null ? t('weather.hourUnknown') : temperature(hour.temperatureC, language)}</span>
      </li>)}</ul>
      : <p>{t('weather.hourlyUnavailable')}</p>}
  </div>;
}
