import { useEffect, useRef, useState } from 'react';
import type { OwnerScope, SessionController } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import { errorKey, isAborted } from '../../data/errors';
import { weatherConfig } from '../../domain/weather';
import { searchCities, WeatherError, type CityResult } from '../../providers/weather';
import type { Language, MessageKey, Translate } from '../../i18n';

type Props = { controller: SessionController; scope: OwnerScope; profile: ProfileRow; busy: boolean; language: Language; online: boolean; t: Translate };

// Nothing is sent to the weather service until the owner presses Search; Use this city saves the choice and turns forecasts on.
export function WeatherSettings({ controller, scope, profile, busy, language, online, t }: Props) {
  const config = weatherConfig(profile);
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CityResult[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState<MessageKey | null>(null);
  const [savedCity, setSavedCity] = useState('');
  const search = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => search.current?.abort(), []);
  useEffect(() => { if (problem) alert.current?.focus(); }, [problem]);
  const searchOpen = config.status !== 'on' || changing;
  const disabled = busy || !online;

  async function find() {
    const name = query.trim();
    if (name.length < 2 || disabled) return;
    search.current?.abort();
    const request = new AbortController();
    search.current = request;
    setSearching(true); setProblem(null); setSaved(null); setResults(null); setSelected(null);
    try {
      const found = await searchCities(name, language, AbortSignal.any([request.signal, scope.signal]));
      if (request.signal.aborted || scope.signal.aborted) return;
      setResults(found);
      setSelected(found.length === 1 ? found[0]!.id : null);
    } catch (error) {
      if (request.signal.aborted || scope.signal.aborted) return;
      setProblem(error instanceof WeatherError && error.code === 'busy' ? 'weather.busy' : 'weather.searchFailed');
    } finally {
      if (search.current === request) { search.current = null; setSearching(false); }
    }
  }
  async function save(place: CityResult | null) {
    setProblem(null); setSaved(null);
    try {
      await controller.saveProfile(scope, profile, { kind: 'weather', place: place && { city: place.city, latitude: place.latitude, longitude: place.longitude } });
      if (scope.signal.aborted) return;
      setChanging(false); setResults(null); setSelected(null); setQuery('');
      setSavedCity(place?.city ?? ''); setSaved(place ? 'weather.savedOn' : 'weather.savedOff');
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      setProblem(errorKey(error));
    }
  }
  const choice = results?.find(result => result.id === selected) ?? null;

  return <section className="settings-card weather-card" aria-labelledby="weather-heading">
    <h2 id="weather-heading">{t('weather.title')}</h2>
    {config.status === 'on' && <p className="weather-city">{t('weather.onFor', { city: config.place.city })}</p>}
    {config.status === 'off' && !saved && <p className="muted fine">{t('weather.intro')}</p>}
    {config.status === 'incomplete' && <p className="notice">{t('weather.incomplete')}</p>}
    {searchOpen && <form className="stack" noValidate onSubmit={event => { event.preventDefault(); void find(); }}>
      <p className="privacy-note" id="weather-disclosure">{t('weather.consent')}</p>
      <div className="field">
        <label htmlFor="weather-city">{t('weather.city')}</label>
        <div className="weather-search">
          <input id="weather-city" type="search" autoComplete="off" maxLength={100} value={query} disabled={busy}
            aria-describedby="weather-disclosure" onChange={event => { setQuery(event.target.value); setSaved(null); }} />
          <button type="submit" className="button button-secondary" disabled={disabled || searching || query.trim().length < 2}
            aria-busy={searching || undefined}>{t('common.search')}</button>
        </div>
      </div>
      {results && (results.length ? <fieldset className="weather-results">
        <legend>{t('weather.results')}</legend>
        {results.map(result => <label key={result.id} className="choice">
          <input type="radio" name="weather-place" value={result.id} checked={selected === result.id} disabled={busy}
            onChange={() => setSelected(result.id)} /><span>{result.label}</span>
        </label>)}
      </fieldset> : <p role="status">{t('weather.noResults')}</p>)}
      <div className="settings-actions">
        {results && results.length > 0 && <button type="button" className="button button-primary" disabled={disabled || !choice}
          onClick={() => { void save(choice); }}>{t('weather.useCity')}</button>}
        {changing && <button type="button" className="text-button" disabled={busy}
          onClick={() => { search.current?.abort(); setChanging(false); setResults(null); setSelected(null); setQuery(''); setProblem(null); }}>{t('common.cancel')}</button>}
      </div>
    </form>}
    {!online && <p role="status">{t('common.offline')}</p>}
    {problem && <p ref={alert} tabIndex={-1} role="alert" className="notice notice-error">{t(problem)}</p>}
    {problem === 'error.conflict' && <button type="button" className="text-button" disabled={disabled} onClick={() => {
      void controller.reloadProfile(scope).then(() => { if (!scope.signal.aborted) setProblem(null); }).catch(() => {});
    }}>{t('settings.reload')}</button>}
    {(config.status !== 'off' && !changing || config.status === 'incomplete') && <div className="settings-actions">
      {config.status === 'on' && <button type="button" className="button button-secondary" disabled={busy}
        onClick={() => { setChanging(true); setSaved(null); setProblem(null); }}>{t('weather.changeCity')}</button>}
      <button type="button" className="text-button" disabled={disabled} onClick={() => { void save(null); }}>{t('weather.turnOff')}</button>
    </div>}
    {saved && <p className="settings-success" role="status">{t(saved, { city: savedCity })}</p>}
    <p className="muted fine weather-credit">{t('weather.credit')} <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('weather.creditLink')}</a></p>
  </section>;
}
