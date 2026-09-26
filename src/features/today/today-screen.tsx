import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isOccasion, occasionKeys, occasions, type Occasion } from '../../domain/outfits';
import { seasonCodes, type Reason, type Season, type Suggestion } from '../../domain/recommendations';
import { weatherContext, type WeatherConfig } from '../../domain/weather';
import type { Category, WardrobeItem } from '../../domain/wardrobe';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { ComponentText, OutfitThumb } from '../outfits/outfits-screen';
import { pickerComponent } from '../outfits/use-outfits';
import { defaultSeason, useSuggestions, type Pending } from './use-suggestions';
import { useWeather, type WeatherStore } from './use-weather';
import { WeatherBar } from './weather-bar';

const seasonKeys: Record<Season, MessageKey> = { spring: 'season.spring', summer: 'season.summer', autumn: 'season.autumn', winter: 'season.winter' };
const categoryKeys: Record<Category, MessageKey> = {
  top: 'categoryOne.top', bottom: 'categoryOne.bottom', one_piece: 'categoryOne.one_piece', footwear: 'categoryOne.footwear',
  layer: 'categoryOne.layer', outerwear: 'categoryOne.outerwear', accessory: 'categoryOne.accessory',
};
const reasonKeys: Record<Reason['key'], MessageKey> = {
  warmth: 'today.reasonWarmth', rainReady: 'today.reasonRain', windReady: 'today.reasonWind', season: 'today.reasonSeason', occasion: 'today.reasonOccasion', colours: 'suggestion.colours', favourite: 'suggestion.favourite', liked: 'today.reasonLiked',
};
const isSeason = (value: string): value is Season => seasonCodes.some(code => code === value);

type Props = {
  client: AppClient; scope: OwnerScope; images: PrivateImages; online: boolean; language: Language; t: Translate;
  timeZone: string; invalidation: number; weather: WeatherConfig; weatherStore: WeatherStore;
  onSave: (itemIds: string[], occasion: Occasion) => void; onAddItem: () => void; onTurnOnWeather: () => void;
};
export function TodayScreen({ client, scope, images, online, language, t, timeZone, invalidation, weather, weatherStore, onSave, onAddItem, onTurnOnWeather }: Props) {
  const [occasion, setOccasion] = useState<Occasion>('everyday');
  const [season, setSeason] = useState<Season>(() => defaultSeason(timeZone));
  const forecast = useWeather(weatherStore, weather, online);
  const context = useMemo(() => weatherContext(forecast.forecast, forecast.override), [forecast.forecast, forecast.override]);
  const ideas = useSuggestions(client, scope, online, invalidation, occasion, season, context);
  const byId = useMemo(() => new Map((ideas.data?.items ?? []).map(item => [item.id, item])), [ideas.data]);
  const result = ideas.result;
  const list = (categories: readonly Category[]) => new Intl.ListFormat(locales[language], { type: 'conjunction' }).format(categories.map(category => t(categoryKeys[category])));
  return <section className="today-page" aria-labelledby="today-title">
    <div className="page-heading"><div><h1 id="today-title" tabIndex={-1}>{t('today.title')}</h1></div></div>
    <div className="today-context">
      <label className="field"><span>{t('outfits.occasion')}</span>
        <select value={occasion} disabled={ideas.settling} onChange={event => { if (!ideas.settling && isOccasion(event.target.value)) setOccasion(event.target.value); }}>
          {occasions.map(code => <option key={code} value={code}>{t(occasionKeys[code])}</option>)}
        </select></label>
      <label className="field"><span>{t('item.season')}</span>
        <select value={season} disabled={ideas.settling} onChange={event => { if (!ideas.settling && isSeason(event.target.value)) setSeason(event.target.value); }}>
          {seasonCodes.map(code => <option key={code} value={code}>{t(seasonKeys[code])}</option>)}
        </select></label>
    </div>
    <WeatherBar weather={forecast} language={language} timeZone={timeZone} online={online} locked={ideas.settling} t={t} onTurnOnWeather={onTurnOnWeather} />
    {ideas.error && <div className="notice notice-error" role="alert"><span>{t('today.loadFailed')}</span><button type="button" className="text-button" disabled={!online} onClick={ideas.reload}>{t('common.retry')}</button></div>}
    {!result ? !ideas.error && <div className="today-ideas" aria-busy="true"><p role="status" className="sr-only">{t('common.loading')}</p>
      {Array.from({ length: 3 }, (_, index) => <div key={index} className="loading-card"><div className="loading-photo skeleton" /><div className="loading-line skeleton" /></div>)}</div>
      : result.status === 'empty' ? <div className="today-empty">
        <p>{t(ideas.hasClothes ? 'today.none' : 'today.empty')}</p>
        <button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button>
      </div>
      : result.status === 'partial' ? <div className="today-ideas">
        {result.suggestions.map(suggestion => <article key={suggestion.key} className="today-card" aria-labelledby={`idea-${suggestion.key}`}>
          <h2 id={`idea-${suggestion.key}`} className="sr-only">{t('today.idea', { number: 1 })}</h2>
          <Pieces ids={suggestion.itemIds} byId={byId} images={images} t={t} />
          <p className="today-missing">{t('today.missing', { categories: list(suggestion.missingSlots) })}</p>
          {notes(suggestion).map(key => <p key={key} className="today-missing">{t(key)}</p>)}
          <div className="today-actions"><button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button></div>
        </article>)}
      </div>
      : result.status === 'none' ? <div className="today-empty">
        <p>{t(ideas.paged ? 'today.noMore' : 'today.none')}</p>
        {result.missingDetails.includes('formality') && <p className="muted">{t('today.missingFormality')}</p>}
        {ideas.paged && <button type="button" className="button button-secondary" disabled={ideas.settling} onClick={ideas.startOver}>{t('today.startOver')}</button>}
      </div>
      : <>
        {result.missingDetails.includes('formality') && <p className="muted today-hint">{t('today.missingFormality')}</p>}
        <div className="today-ideas">
          {ideas.ideas.map((suggestion, index) => <Idea key={suggestion.key} suggestion={suggestion} number={index + 1} byId={byId} images={images} t={t} list={list}
            online={online} vote={ideas.votes.get(suggestion.key) ?? null} pending={ideas.pending} failed={ideas.failed === suggestion.key} unresolved={ideas.unresolved === suggestion.key} locked={ideas.unresolved !== null} onRetry={ideas.retry}
            onSave={() => onSave(suggestion.itemIds, occasion)} onLike={() => ideas.like(suggestion.key)}
            onHide={() => ideas.hide(suggestion.key)} onUndo={() => ideas.undo(suggestion.key)}
            avoided={ideas.avoided(suggestion.key)} unsettled={ideas.unsettledPair(suggestion.key)} onAvoid={(first, second) => ideas.avoid(suggestion.key, first, second)} onAllow={() => ideas.allow(suggestion.key)} />)}
        </div>
        <div className="today-more"><button type="button" className="button button-secondary" disabled={ideas.settling} onClick={ideas.more}><Icon name="refresh" />{t('today.more')}</button></div>
      </>}
  </section>;
}

function Pieces({ ids, byId, images, t }: { ids: readonly string[]; byId: ReadonlyMap<string, WardrobeItem>; images: PrivateImages; t: Translate }) {
  return <ul className="today-pieces">
    {ids.map(id => {
      const item = byId.get(id);
      if (!item) return null;
      const component = pickerComponent(item);
      return <li key={id} className="outfit-component"><OutfitThumb component={component} images={images} t={t} /><ComponentText component={component} t={t} /></li>;
    })}
  </ul>;
}

type IdeaProps = {
  suggestion: Suggestion; number: number; byId: ReadonlyMap<string, WardrobeItem>; images: PrivateImages; t: Translate; online: boolean;
  list: (categories: readonly Category[]) => string;
  vote: 1 | -1 | null; pending: Pending | null; failed: boolean; unresolved: boolean; locked: boolean;
  onSave: () => void; onLike: () => void; onHide: () => void; onUndo: () => void; onRetry: () => void;
  avoided: string | null; unsettled: string | null; onAvoid: (first: string, second: string) => void; onAllow: () => void;
};
function Idea({ suggestion, number, byId, images, t, list, online, vote, pending, failed, unresolved, locked, onSave, onLike, onHide, onUndo, onRetry,
  avoided, unsettled, onAvoid, onAllow }: IdeaProps) {
  const title = `idea-${number}-title`;
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const legend = useRef<HTMLLegendElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const undoPair = useRef<HTMLButtonElement>(null);
  const wasChoosing = useRef(false);
  const wasAvoided = useRef(avoided);
  const retry = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const wasUnsettled = useRef(unsettled);
  useEffect(() => {
    if (choosing) legend.current?.focus();
    else if (wasChoosing.current) opener.current?.focus();
    wasChoosing.current = choosing;
  }, [choosing]);
  // Keyboard focus follows the card as it collapses to its Undo and back.
  useEffect(() => {
    if (avoided && !wasAvoided.current) undoPair.current?.focus();
    else if (!avoided && wasAvoided.current) opener.current?.focus();
    wasAvoided.current = avoided;
  }, [avoided]);
  // An uncertain pair choice turns the card into its Try again, and back once it is settled, without taking focus from elsewhere.
  useEffect(() => {
    const here = document.activeElement === document.body || card.current?.contains(document.activeElement) === true;
    if (here && unsettled && !wasUnsettled.current && !avoided) retry.current?.focus();
    else if (here && !unsettled && wasUnsettled.current && !avoided) opener.current?.focus();
    wasUnsettled.current = unsettled;
  }, [unsettled, avoided]);
  const pieces = suggestion.itemIds.filter(id => byId.has(id));
  // Until an uncertain choice is settled, only its Try again is offered on the page.
  const busy = pending !== null || locked;
  const problem = unresolved
    ? <div className="notice notice-error" role="alert"><span>{t('today.voteFailed')}</span><button ref={retry} type="button" className="text-button" disabled={!online || pending !== null} onClick={onRetry}>{t('common.retry')}</button></div>
    : failed && <p className="notice notice-error" role="alert">{t('today.voteFailed')}</p>;
  const mine = pending?.key === suggestion.key;
  if (avoided) return <article ref={card} className="today-card today-card-hidden" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <Pieces ids={suggestion.itemIds.filter(id => avoided.split('|').includes(id))} byId={byId} images={images} t={t} />
    <p role="status">{t('today.pairHidden')}</p>
    {problem}
    <button ref={undoPair} type="button" className="text-button" disabled={!online || busy} aria-busy={mine || undefined} onClick={onAllow}>{t('common.undo')}</button>
  </article>;
  // Until it is settled the pair may already be avoided, so the card offers nothing but its Try again.
  if (unsettled) return <article ref={card} className="today-card today-card-hidden" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <Pieces ids={suggestion.itemIds.filter(id => unsettled.split('|').includes(id))} byId={byId} images={images} t={t} />
    {problem}
  </article>;
  if (vote === -1) return <article className="today-card today-card-hidden" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <p role="status">{t('today.hidden')}</p>
    {problem}
    <button type="button" className="text-button" disabled={!online || busy} aria-busy={mine || undefined} onClick={onUndo}>{t('common.undo')}</button>
  </article>;
  // Saving waits while a pair on this card is being written.
  const pairing = mine && (pending.kind === 'avoid' || pending.kind === 'allow');
  return <article ref={card} className="today-card" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <Pieces ids={suggestion.itemIds} byId={byId} images={images} t={t} />
    {suggestion.reasons.length > 0 && <ul className="today-reasons">{suggestion.reasons.map(reason => <li key={reason.key}><Icon name="check" />{t(reasonKeys[reason.key])}</li>)}</ul>}
    {notes(suggestion).map(key => <p key={key} className="today-missing">{t(key)}</p>)}
    {!suggestion.weatherNeeds && suggestion.missingSlots.length > 0 && <p className="today-missing">{t('today.missing', { categories: list(suggestion.missingSlots) })}</p>}
    {problem}
    <div className="today-actions">
      <button type="button" className="button button-primary" disabled={!online || pairing} onClick={onSave}>{t('today.save')}</button>
      <button type="button" className="button button-secondary" aria-pressed={vote === 1} disabled={!online || busy} aria-busy={mine && pending.kind === 'like' || undefined} onClick={onLike}>{t('today.like')}</button>
      <button type="button" className="button button-quiet" disabled={!online || busy} aria-busy={mine && pending.kind === 'hide' || undefined} onClick={onHide}>{t('today.notForMe')}</button>
      {pieces.length >= 2 && !choosing && <button ref={opener} type="button" className="button button-quiet" disabled={!online || busy}
        aria-busy={mine && pending.kind === 'avoid' || undefined}
        onClick={() => { if (pieces.length === 2) onAvoid(pieces[0]!, pieces[1]!); else { setPicked([]); setChoosing(true); } }}>{t('today.dontPair')}</button>}
    </div>
    {choosing && <fieldset className="today-pair">
      <legend ref={legend} tabIndex={-1}>{t('today.pickPair')}</legend>
      {pieces.map(id => {
        const component = pickerComponent(byId.get(id)!);
        return <label key={id} className="today-pair-option">
          <input type="checkbox" checked={picked.includes(id)}
            onChange={event => setPicked(current => event.target.checked ? [...current, id] : current.filter(entry => entry !== id))} />
          <OutfitThumb component={component} images={images} t={t} decorative /><ComponentText component={component} t={t} />
        </label>;
      })}
      <div className="today-actions">
        <button type="button" className="button button-primary" disabled={!online || busy || picked.length !== 2}
          onClick={() => { const [first, second] = picked; setChoosing(false); onAvoid(first!, second!); }}>{t('today.pairConfirm')}</button>
        <button type="button" className="button button-quiet" onClick={() => setChoosing(false)}>{t('common.cancel')}</button>
      </div>
    </fieldset>}
  </article>;
}

// Weather gaps on one idea: what is missing, unknown or unsuitable. Unknown protection is never treated as enough or as lacking.
function notes(suggestion: Suggestion): MessageKey[] {
  const needs = suggestion.weatherNeeds ?? [];
  const found: MessageKey[] = [];
  const add = (key: MessageKey) => { if (!found.includes(key)) found.push(key); };
  const cold = needs.some(entry => entry.need === 'cold');
  for (const { need, status } of needs) {
    if (status === 'none') add(cold ? 'today.addCoat' : 'today.addCover');
    else if (status === 'unknown') add(need === 'rain' ? 'today.checkRain' : 'today.checkWind');
    else if (status === 'lacking' && need !== 'cold') add(need === 'rain' ? 'today.noRain' : 'today.noWind');
  }
  if (needs.some(entry => entry.status === 'apart' || entry.status === 'lacking') && !found.length) add('today.noCover');
  if (suggestion.missingDetails.includes('coverage')) add('today.checkLength');
  return found;
}