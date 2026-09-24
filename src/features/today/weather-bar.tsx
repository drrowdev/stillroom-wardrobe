import { useState } from 'react';
import { validManualTemperature, type Forecast } from '../../domain/weather';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { useWeather } from './use-weather';

type Weather = ReturnType<typeof useWeather>;
type Props = { weather: Weather; language: Language; online: boolean; locked: boolean; t: Translate };

const zoned = (timeZone: string, options: Intl.DateTimeFormatOptions, locale: string) => {
  try { return new Intl.DateTimeFormat(locale, { ...options, timeZone }); } catch { return new Intl.DateTimeFormat(locale, options); }
};

function forecastParts(forecast: Forecast, fetchedAt: number, city: string, language: Language, t: Translate): { heading: string; details: string[]; updated: string } {
  const locale = locales[language];
  const [year, month, day] = forecast.date.split('-').map(Number) as [number, number, number];
  const date = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, day));
  const details: string[] = [];
  if (forecast.minTemperature !== null) details.push(t('weather.low', { temperature: temperature(forecast.minTemperature, language) }));
  if (forecast.maxRain !== null) details.push(t('weather.rain', { chance: new Intl.NumberFormat(locale, { style: 'percent' }).format(forecast.maxRain / 100) }));
  if (forecast.maxWind !== null) details.push(t('weather.wind', { speed: new Intl.NumberFormat(locale, { style: 'unit', unit: 'meter-per-second', maximumFractionDigits: 0 }).format(forecast.maxWind) }));
  const updated = t('weather.updated', { time: zoned(forecast.timeZone, { hour: '2-digit', minute: '2-digit' }, locale).format(fetchedAt) });
  return { heading: t('weather.forecastFor', { city, date, timeZone: forecast.timeZone }), details, updated };
}
const temperature = (value: number, language: Language) =>
  new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'celsius', maximumFractionDigits: 0 }).format(value);

// The forecast is optional: manual temperature and Staying in work with weather off, offline or after a failure.
export function WeatherBar({ weather, language, online, locked, t }: Props) {
  const { view, override, setOverride } = weather;
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const status: MessageKey | null = view.status === 'loading' ? 'weather.loading' : view.status === 'offline' ? 'weather.offline'
    : view.status === 'incomplete' ? 'weather.incompleteToday' : view.status === 'failed' ? 'weather.failed' : null;
  function submit() {
    const text = value.trim().replace('−', '-');
    const number = /^-?\d{1,2}$/.test(text) ? Number(text) : Number.NaN;
    if (!validManualTemperature(number)) { setInvalid(true); return; }
    setOverride({ kind: 'manual', temperatureC: number });
    setEntering(false); setValue(''); setInvalid(false);
  }
  const ready = view.status === 'ready' ? forecastParts(view.forecast, view.fetchedAt, view.city, language, t) : null;
  return <section className="weather-bar" aria-labelledby="weather-bar-title">
    <h2 id="weather-bar-title" className="sr-only">{t('weather.title')}</h2>
    {override?.kind === 'indoors' ? <p className="weather-line">{t('weather.indoorsLine')}</p>
      : override?.kind === 'manual' ? <p className="weather-line weather-manual">{t('weather.manualLine', { temperature: temperature(override.temperatureC, language) })}</p>
      : ready ? <div className="weather-line">
        <p className="weather-heading">{ready.heading}</p>
        {ready.details.length > 0 && <p>{ready.details.join(' · ')}</p>}
        <p className="muted fine"><span>{ready.updated}</span> <span className="weather-credit">{t('weather.credit')} <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('weather.creditLink')}</a></span></p>
      </div>
      : status && <div className="weather-line" role="status"><span>{t(status)}</span>
        {view.status === 'failed' && <button type="button" className="text-button" disabled={!weather.canRetry || !online} onClick={weather.retry}>{t('common.retry')}</button>}
      </div>}
    {entering ? <form className="weather-manual-form" noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="field"><label htmlFor="weather-temperature">{t('weather.temperatureLabel')}</label>
        <input id="weather-temperature" type="text" inputMode="text" autoComplete="off" maxLength={4} value={value} disabled={locked}
          aria-invalid={invalid || undefined} aria-describedby={invalid ? 'weather-temperature-error' : undefined}
          onChange={event => { setValue(event.target.value); setInvalid(false); }} /></div>
      {invalid && <p id="weather-temperature-error" className="field-error" role="alert">{t('weather.invalidTemperature')}</p>}
      <div className="weather-actions">
        <button type="submit" className="button button-secondary" disabled={locked}>{t('weather.useTemperature')}</button>
        <button type="button" className="text-button" onClick={() => { setEntering(false); setValue(''); setInvalid(false); }}>{t('common.cancel')}</button>
      </div>
    </form>
      : <div className="weather-actions">
        {override ? <button type="button" className="text-button" disabled={locked} onClick={() => setOverride(null)}>
          {t(override.kind === 'manual' ? 'weather.clearManual' : 'weather.goingOut')}</button>
          : <>
            <button type="button" className="text-button" disabled={locked} onClick={() => setEntering(true)}>{t('weather.enterTemperature')}</button>
            <button type="button" className="text-button" disabled={locked} onClick={() => setOverride({ kind: 'indoors' })}>{t('weather.stayingIn')}</button>
          </>}
      </div>}
  </section>;
}
