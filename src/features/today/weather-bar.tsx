import { useState } from 'react';
import { validManualTemperature, type Forecast } from '../../domain/weather';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { useWeather } from './use-weather';
import { temperature, weatherChips } from './weather-chips';
import { forecastZoneSuffix } from './weather-zone';

type Weather = ReturnType<typeof useWeather>;
type Props = { weather: Weather; language: Language; timeZone: string; online: boolean; locked: boolean; t: Translate; onTurnOnWeather: () => void };

const zoned = (timeZone: string, options: Intl.DateTimeFormatOptions, locale: string) => {
  try { return new Intl.DateTimeFormat(locale, { ...options, timeZone }); } catch { return new Intl.DateTimeFormat(locale, options); }
};
function forecastParts(forecast: Forecast, fetchedAt: number, city: string, profileZone: string, language: Language, t: Translate): { heading: string; details: string[]; updated: string } {
  const locale = locales[language];
  const [year, month, day] = forecast.date.split('-').map(Number) as [number, number, number];
  const date = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, day));
  const updated = t('weather.updated', { time: zoned(forecast.timeZone, { hour: '2-digit', minute: '2-digit' }, locale).format(fetchedAt) });
  // The saved city is "place, country"; Today names the place only.
  const place = city.split(', ')[0] || city;
  const zone = forecastZoneSuffix(forecast.timeZone, profileZone, fetchedAt, locale);
  return { heading: zone ? t('weather.forecastForZone', { city: place, date, zone }) : t('weather.forecastFor', { city: place, date }), details: weatherChips(forecast, language, t), updated };
}

// Outdoors uses the forecast, or a temperature the owner enters when there is none. Indoors turns weather off for today.
export function WeatherBar({ weather, language, timeZone, online, locked, t, onTurnOnWeather }: Props) {
  const { view, override, setOverride } = weather;
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const indoors = override?.kind === 'indoors';
  const manual = override?.kind === 'manual' ? override.temperatureC : null;
  const status: MessageKey | null = view.status === 'off' ? 'weather.noForecast' : view.status === 'offline' ? 'weather.offline'
    : view.status === 'incomplete' ? 'weather.incompleteToday' : view.status === 'failed' ? 'weather.failed' : null;
  function close() { setEntering(false); setValue(''); setInvalid(false); }
  function submit() {
    const text = value.trim().replace('−', '-');
    const number = /^-?\d{1,2}$/.test(text) ? Number(text) : Number.NaN;
    if (!validManualTemperature(number)) { setInvalid(true); return; }
    setOverride({ kind: 'manual', temperatureC: number });
    close();
  }
  const ready = view.status === 'ready' ? forecastParts(view.forecast, view.fetchedAt, view.city, timeZone, language, t) : null;
  const info = indoors ? null
    : manual !== null ? <div className="weather-line weather-row">
      <p id="weather-manual" className="weather-chip weather-manual">{t('weather.manualLine', { temperature: temperature(manual, language) })}</p>
      <button type="button" className="text-button" aria-describedby="weather-manual" disabled={locked} onClick={() => setOverride(null)}>{t('weather.clearManual')}</button>
    </div>
      : ready ? <div className="weather-line">
        <p className="weather-heading">{ready.heading}</p>
        {ready.details.length > 0 && <ul className="weather-chips">{ready.details.map(chip => <li key={chip} className="weather-chip">{chip}</li>)}</ul>}
        <p className="muted fine weather-footer"><span>{ready.updated}</span><span className="weather-credit">{t('weather.credit')} <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('weather.creditLink')}</a></span></p>
      </div>
        : !status ? <p className="weather-line" role="status">{t('weather.loading')}</p>
          : <div className="weather-line">
            <div className="weather-row"><p role="status" className="weather-chip">{t(status)}</p>
              {view.status === 'failed' && <button type="button" className="text-button" disabled={!weather.canRetry || !online} onClick={weather.retry}>{t('common.retry')}</button>}
              {!entering && view.status === 'off' && <a href="#/settings" className="text-button" onClick={onTurnOnWeather}>{t('weather.turnOn')}</a>}
              {!entering && <button type="button" className="text-button" disabled={locked} onClick={() => setEntering(true)}>{t('weather.enterTemperature')}</button>}
            </div>
            {entering && <form className="weather-manual-form" noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
              <div className="field"><label htmlFor="weather-temperature">{t('weather.temperatureLabel')}</label>
                <input id="weather-temperature" type="text" inputMode="text" autoComplete="off" maxLength={4} value={value} disabled={locked} autoFocus
                  aria-invalid={invalid || undefined} aria-describedby={invalid ? 'weather-temperature-error' : undefined}
                  onChange={event => { setValue(event.target.value); setInvalid(false); }} /></div>
              {invalid && <p id="weather-temperature-error" className="field-error" role="alert">{t('weather.invalidTemperature')}</p>}
              <div className="weather-actions">
                <button type="submit" className="button button-secondary" disabled={locked}>{t('weather.useTemperature')}</button>
                <button type="button" className="text-button" onClick={close}>{t('common.cancel')}</button>
              </div>
            </form>}
          </div>;
  return <section className="weather-bar" aria-labelledby="weather-bar-title">
    <h2 id="weather-bar-title" className="sr-only">{t('weather.title')}</h2>
    {/* First in reading order: it decides whether the weather matters at all. Wide screens show it on the right. */}
    <div className="weather-place" role="group" aria-label={t('weather.place')}>
      <button type="button" aria-pressed={!indoors} disabled={locked} onClick={() => { if (indoors) setOverride(null); }}>{t('setting.outdoors')}</button>
      <button type="button" aria-pressed={indoors} disabled={locked} onClick={() => { close(); setOverride({ kind: 'indoors' }); }}>{t('setting.indoors')}</button>
    </div>
    {info}
  </section>;
}
