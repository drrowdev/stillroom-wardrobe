import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/icon';
import { loadWardrobe } from '../../data/items';
import { occasionKeys, occasions, type Occasion } from '../../domain/outfits';
import { checkIdea, isStylistOccasion, stylistLimits, stylistWeather, type IdeaCheck, type StylistIdea } from '../../domain/stylist-controls';
import { weatherContext, type WeatherConfig } from '../../domain/weather';
import type { WardrobeItem } from '../../domain/wardrobe';
import type { Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { ComponentText, OutfitThumb } from '../outfits/outfits-screen';
import { pickerComponent } from '../outfits/use-outfits';
import { defaultSeason } from '../today/use-suggestions';
import { useWeather, type WeatherStore } from '../today/use-weather';
import type { StylistEntry, StylistStore } from './stylist-store';
import { canSend, clear, readStatus, send, statusOf, useStylist, useStylistStatus, viewOf } from './use-stylist';

type Wardrobe = { items: ReadonlyMap<string, WardrobeItem> | null; loading: boolean; failed: boolean };
/**
 * The owner's saved clothes, loaded when the screen opens (including on return from the outfit editor) and again for
 * each new reply, within 15 seconds. A failed load keeps the last list but stops Save until a load succeeds.
 */
function useWardrobe(store: StylistStore, replies: number): Wardrobe & { retry: () => void } {
  const [state, setState] = useState<Wardrobe>({ items: null, loading: true, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    setState((current) => ({ ...current, loading: true }));
    loadWardrobe(store.client, store.scope, signal).then((items) => {
      if (!controller.signal.aborted && !store.scope.signal.aborted) setState({ items: new Map(items.map((item) => [item.id, item])), loading: false, failed: false });
    }, () => {
      if (!controller.signal.aborted && !store.scope.signal.aborted) setState((current) => ({ ...current, loading: false, failed: true }));
    });
    return () => controller.abort();
  }, [store, replies, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

type Props = {
  store: StylistStore; images: PrivateImages; online: boolean; t: Translate; timeZone: string;
  weather: WeatherConfig; weatherStore: WeatherStore;
  onSave: (itemIds: string[], occasion: Occasion) => void; onAddItem: () => void; onSettings: () => void;
};
export function StylistScreen({ store, images, online, t, timeZone, weather, weatherStore, onSave, onAddItem, onSettings }: Props) {
  useStylistStatus(store);
  const state = useStylist(store);
  const view = viewOf(state);
  const status = statusOf(state);
  const forecast = useWeather(weatherStore, weather, online);
  // Weather that is turned off is not sent, even if an override is still set for Today.
  const weatherOn = weather.status === 'on';
  const context = useMemo(() => weatherOn ? stylistWeather(weatherContext(forecast.forecast, forecast.override)) : null,
    [weatherOn, forecast.forecast, forecast.override]);
  const replies = state.turns.filter((turn) => turn.role === 'assistant').length;
  const wardrobe = useWardrobe(store, replies);
  const field = useRef<HTMLTextAreaElement>(null);
  const ownerId = store.scope.ownerId;
  const usable = useMemo(() => wardrobe.items ? [...wardrobe.items.keys()].some((id) => checkIdea([id], wardrobe.items!, ownerId, null) === 'ok') : true,
    [wardrobe.items, ownerId]);
  const limits = status ? stylistLimits(status) : null;
  const limitLine = limits?.own ? 'stylist.limitOwn' : limits?.shared ? 'stylist.limitShared' : limits?.ownWarning ? 'stylist.warning'
    : limits?.sharedWarning ? 'stylist.sharedWarning' : null;
  // A refusal that the limit line already explains isn't repeated.
  const error = state.error && state.error.key !== limitLine ? state.error : null;
  const pending = state.pending !== null;
  // Anything the conversation holds, including an unsent draft, can be cleared in every state.
  const clearable = state.turns.length > 0 || pending || state.draft !== '';
  const submit = () => {
    field.current?.focus();
    void send(store, { online, season: defaultSeason(timeZone), weather: context });
  };
  const line = view.kind === 'loadFailed' ? 'stylistC.loadFailed' : view.kind === 'unresolved' ? 'stylist.unresolved'
    : view.kind === 'paused' ? 'stylist.paused' : view.kind === 'off' ? 'stylist.off' : view.kind === 'renew' ? 'stylist.renew'
      : view.kind === 'on' ? null : 'stylist.unavailable';
  return <section className="stylist-page" aria-labelledby="stylist-title">
    <div className="page-heading"><div><h1 id="stylist-title" tabIndex={-1}>{t('stylist.title')}</h1></div></div>
    <p role="status" className="sr-only">{state.announce ? t(state.announce.key) : ''}</p>
    {state.read.kind === 'unknown' ? <p className="muted" aria-busy="true">{t('common.loading')}</p>
      : line && <div className="notice stylist-state"><span>{t(line)}</span>
        {(view.kind === 'loadFailed' || view.kind === 'unresolved') && <button type="button" className="text-button" disabled={!online || state.reading}
          onClick={() => { void readStatus(store, 'active'); }}>{t('common.retry')}</button>}
        {(view.kind === 'off' || view.kind === 'renew') && <button type="button" className="text-button" onClick={onSettings}>{t('aiC.turnOn')}</button>}
      </div>}
    {state.turns.length > 0 || pending ? <ol className="stylist-turns" aria-label={t('stylist.conversation')}>
      {state.turns.map((turn) => <Turn key={turn.id} turn={turn} wardrobe={wardrobe} ownerId={ownerId} images={images} t={t} onSave={onSave} />)}
      {pending && <li className="stylist-turn stylist-user" aria-busy="true"><span className="sr-only">{t('stylist.you')}</span><p className="stylist-text">{state.pending}</p></li>}
    </ol> : null}
    {wardrobe.failed && state.turns.length > 0 && <div className="notice notice-error" role="alert"><span>{t('stylist.wardrobeFailed')}</span>
      <button type="button" className="text-button" disabled={!online || wardrobe.loading} onClick={wardrobe.retry}>{t('common.retry')}</button></div>}
    {(view.kind !== 'on' || !usable) && clearable && <div className="stylist-actions">
      <button type="button" className="text-button" onClick={() => { clear(store); document.getElementById('stylist-title')?.focus(); }}>
        {t('stylist.clear')}</button></div>}
    {view.kind === 'on' && <>
      {limitLine && <p className="notice">{t(limitLine)}</p>}
      {!usable ? <div className="today-empty"><p>{t('stylist.empty')}</p>
        <button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button></div>
        : <form className="stylist-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label className="field"><span>{t('outfits.occasion')}</span>
            <select value={state.occasion} disabled={pending}
              onChange={(event) => { if (isStylistOccasion(event.target.value)) store.update({ occasion: event.target.value }); }}>
              {occasions.map((code) => <option key={code} value={code}>{t(occasionKeys[code])}</option>)}
            </select></label>
          <label className="field"><span>{t('stylist.message')}</span>
            <textarea id="stylist-message" ref={field} rows={3} value={state.draft} readOnly={pending} placeholder={t('stylist.placeholder')}
              onChange={(event) => store.update({ draft: event.target.value, error: state.error?.key === 'stylist.tooLong' ? null : state.error })} /></label>
          {!online && <p className="notice notice-offline" role="status">{t('stylist.offline')}</p>}
          {error && <div className="notice notice-error" role="alert"><span>{t(error.key, error.count === undefined ? undefined : { count: error.count })}</span>
            {error.retry && <button type="button" className="text-button" disabled={!online || pending || !canSend(state)} onClick={submit}>{t('common.retry')}</button>}</div>}
          <div className="stylist-actions">
            <button type="submit" className="button button-primary" disabled={!online || pending || !canSend(state) || state.draft.trim() === ''}>
              {t(pending ? 'stylist.sending' : 'stylist.send')}</button>
            {clearable && <button type="button" className="text-button"
              onClick={() => { clear(store); field.current?.focus(); }}>{t('stylist.clear')}</button>}
          </div>
          <p className="muted fine">{t('stylist.notKept')}</p>
        </form>}
    </>}
  </section>;
}

type TurnProps = { turn: StylistEntry; wardrobe: Wardrobe; ownerId: string; images: PrivateImages; t: Translate;
  onSave: (itemIds: string[], occasion: Occasion) => void };
function Turn({ turn, wardrobe, ownerId, images, t, onSave }: TurnProps) {
  return <li className={`stylist-turn stylist-${turn.role}`}>
    <span className="sr-only">{t(turn.role === 'user' ? 'stylist.you' : 'stylist.me')}</span>
    <p className="stylist-text">{turn.text}</p>
    {turn.role === 'assistant' && turn.outfits.length > 0 && <div className="today-ideas stylist-ideas">
      {turn.outfits.map((idea, index) => <Idea key={index} id={`stylist-idea-${turn.id}-${index}`} idea={idea} number={index + 1}
        wardrobe={wardrobe} images={images} t={t}
        check={wardrobe.items ? checkIdea(idea.itemIds, wardrobe.items, ownerId, turn.weather) : null}
        onSave={() => {
          // Checked again against the latest load at the moment of saving; the editor's own checks still apply.
          if (wardrobe.items && !wardrobe.loading && !wardrobe.failed && checkIdea(idea.itemIds, wardrobe.items, ownerId, turn.weather) === 'ok') {
            onSave([...idea.itemIds], turn.occasion);
          }
        }} />)}
    </div>}
  </li>;
}

type IdeaProps = { id: string; idea: StylistIdea; number: number; wardrobe: Wardrobe; images: PrivateImages; t: Translate;
  check: IdeaCheck | null; onSave: () => void };
function Idea({ id, idea, number, wardrobe, images, t, check, onSave }: IdeaProps) {
  const items = wardrobe.items;
  return <article className="today-card" aria-labelledby={id}>
    <h2 id={id} className="stylist-idea-title">{t('today.idea', { number })}</h2>
    {items && <ul className="today-pieces">
      {idea.itemIds.map((itemId) => {
        const item = items.get(itemId);
        if (!item) return null;
        const component = pickerComponent(item);
        return <li key={itemId} className="outfit-component"><OutfitThumb component={component} images={images} t={t} decorative /><ComponentText component={component} t={t} /></li>;
      })}
    </ul>}
    {idea.note && <p className="stylist-text">{idea.note}</p>}
    {check === 'gone' && <p className="today-missing">{t('stylist.itemGone')}</p>}
    {check === 'unavailable' && <p className="today-missing">{t('stylist.itemUnavailable')}</p>}
    <div className="today-actions">
      <button type="button" className="button button-primary" disabled={check !== 'ok' || wardrobe.loading || wardrobe.failed} onClick={onSave}>{t('today.save')}</button>
    </div>
  </article>;
}
