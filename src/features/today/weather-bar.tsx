import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../app/icon';
import { validManualTemperature, type Forecast } from '../../domain/weather';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { useWeather } from './use-weather';
import { temperature, weatherChips } from './weather-chips';
import { forecastZoneSuffix } from './weather-zone';
import { WeatherHours } from './weather-hours';

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
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const [entering, setEntering] = useState(false);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const indoors = override?.kind === 'indoors';
  const manual = override?.kind === 'manual' ? override.temperatureC : null;
  const status: MessageKey | null = view.status === 'off' ? 'weather.noForecast' : view.status === 'offline' ? 'weather.offline'
    : view.status === 'incomplete' ? 'weather.incompleteToday' : view.status === 'failed' ? 'weather.failed' : null;
  useLayoutEffect(() => {
    const slot = document.getElementById('weather-header-slot');
    if (!slot) throw new Error('Weather header slot unavailable.');
    setHost(slot);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!region.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    const previous = focused.current;
    if (open && previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement?.matches('main'))) trigger.current?.focus();
  });
  function dismiss() { setOpen(false); trigger.current?.focus(); }
  function close() { setEntering(false); setValue(''); setInvalid(false); }
  function submit() {
    const text = value.trim().replace('−', '-');
    const number = /^-?\d{1,2}$/.test(text) ? Number(text) : Number.NaN;
    if (!validManualTemperature(number)) { setInvalid(true); return; }
    setOverride({ kind: 'manual', temperatureC: number });
    close();
  }
  const ready = view.status === 'ready' ? forecastParts(view.forecast, view.fetchedAt, view.city, timeZone, language, t) : null;
  const summary = indoors ? t('setting.indoors')
    : manual !== null ? t('weather.manualSummary', { temperature: temperature(manual, language) })
      : view.status === 'ready' ? weather.currentTemperature !== null
        ? t('weather.current', { temperature: temperature(weather.currentTemperature.temperatureC, language) }) : t('weather.currentUnavailable')
        : view.status === 'loading' ? t('weather.loadingSummary')
          : view.status === 'off' ? t('weather.noForecast') : t('weather.unavailableSummary');
  const info = indoors ? null
    : manual !== null ? <div className="weather-line weather-row">
      <p id="weather-manual" className="weather-chip weather-manual">{t('weather.manualLine', { temperature: temperature(manual, language) })}</p>
      <button type="button" className="text-button" aria-describedby="weather-manual" disabled={locked} onClick={() => setOverride(null)}>{t('weather.clearManual')}</button>
    </div>
      : ready ? <div className="weather-line">
        <p className="weather-heading">{ready.heading}</p>
        {weather.currentTemperature && <p className="muted weather-current-time">{t('weather.currentEstimate', {
          time: zoned(view.status === 'ready' ? view.forecast.timeZone : timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locales[language]).format(weather.currentTemperature.validAt),
        })}</p>}
        {ready.details.length > 0 && <ul className="weather-chips">{ready.details.map(chip => <li key={chip} className="weather-chip">{chip}</li>)}</ul>}
        {view.status === 'ready' && <WeatherHours hours={view.forecast.hourlyTemperatures} language={language} t={t} />}
        {view.status === 'ready' && view.retryAt !== null && <div className="weather-row">
          <p role="status">{t('weather.refreshFailed')}</p>
          <button type="button" className="text-button" disabled={!weather.canRetry || !online} onClick={weather.retry}>{t('common.retry')}</button>
        </div>}
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
  return host && createPortal(<div ref={region} className="weather-widget"
    onFocusCapture={event => { if (event.target instanceof HTMLElement) focused.current = event.target; }}
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } }}
    onBlur={event => {
      if (!open) return;
      if (event.relatedTarget instanceof Node) { if (!region.current?.contains(event.relatedTarget)) setOpen(false); return; }
      setTimeout(() => { if (!document.hasFocus()) setOpen(false); }, 0);
    }}>
    <button ref={trigger} id="weather-trigger" type="button" className="weather-trigger" aria-expanded={open} aria-controls="weather-details"
      aria-label={t('weather.summaryLabel', { summary })} onClick={() => setOpen(!open)}>
      <Icon name="thermometer" /><span>{summary}</span><Icon name="chevron" />
    </button>
    <section id="weather-details" className="weather-bar" hidden={!open} aria-labelledby="weather-bar-title">
      <div className="weather-details-heading"><h2 id="weather-bar-title">{t('weather.title')}</h2>
        <button type="button" className="text-button" onClick={dismiss}>{t('common.close')}</button></div>
      <div className="weather-place" role="group" aria-label={t('weather.place')}>
        <button type="button" aria-pressed={!indoors} disabled={locked} onClick={() => { if (indoors) setOverride(null); }}>{t('setting.outdoors')}</button>
        <button type="button" aria-pressed={indoors} disabled={locked} onClick={() => { close(); setOverride({ kind: 'indoors' }); }}>{t('setting.indoors')}</button>
      </div>
      {info}
    </section>
  </div>, host);
}
