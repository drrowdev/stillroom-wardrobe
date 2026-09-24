import { useMemo, useState } from 'react';
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
  onSave: (itemIds: string[], occasion: Occasion) => void; onAddItem: () => void;
};
export function TodayScreen({ client, scope, images, online, language, t, timeZone, invalidation, weather, weatherStore, onSave, onAddItem }: Props) {
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
    <WeatherBar weather={forecast} language={language} online={online} locked={ideas.settling} t={t} />
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
          <Pieces suggestion={suggestion} byId={byId} images={images} t={t} />
          <p className="today-missing">{t('today.missing', { categories: list(suggestion.missingSlots) })}</p>
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
          {result.suggestions.map((suggestion, index) => <Idea key={suggestion.key} suggestion={suggestion} number={index + 1} byId={byId} images={images} t={t} list={list}
            online={online} vote={ideas.votes.get(suggestion.key) ?? null} pending={ideas.pending} failed={ideas.failed === suggestion.key} unresolved={ideas.unresolved === suggestion.key} locked={ideas.unresolved !== null} onRetry={ideas.retry}
            onSave={() => onSave(suggestion.itemIds, occasion)} onLike={() => ideas.like(suggestion.key)}
            onHide={() => ideas.hide(suggestion.key)} onUndo={() => ideas.undo(suggestion.key)} />)}
        </div>
        <div className="today-more"><button type="button" className="button button-secondary" disabled={ideas.settling} onClick={ideas.more}><Icon name="refresh" />{t('today.more')}</button></div>
      </>}
  </section>;
}

function Pieces({ suggestion, byId, images, t }: { suggestion: Suggestion; byId: ReadonlyMap<string, WardrobeItem>; images: PrivateImages; t: Translate }) {
  return <ul className="today-pieces">
    {suggestion.itemIds.map(id => {
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
};
function Idea({ suggestion, number, byId, images, t, list, online, vote, pending, failed, unresolved, locked, onSave, onLike, onHide, onUndo, onRetry }: IdeaProps) {
  const title = `idea-${number}-title`;
  // Until an uncertain choice is settled, only its Try again is offered on the page.
  const busy = pending !== null || locked;
  const problem = unresolved
    ? <div className="notice notice-error" role="alert"><span>{t('today.voteFailed')}</span><button type="button" className="text-button" disabled={!online || pending !== null} onClick={onRetry}>{t('common.retry')}</button></div>
    : failed && <p className="notice notice-error" role="alert">{t('today.voteFailed')}</p>;
  const mine = pending?.key === suggestion.key;
  if (vote === -1) return <article className="today-card today-card-hidden" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <p role="status">{t('today.hidden')}</p>
    {problem}
    <button type="button" className="text-button" disabled={!online || busy} aria-busy={mine || undefined} onClick={onUndo}>{t('common.undo')}</button>
  </article>;
  return <article className="today-card" aria-labelledby={title}>
    <h2 id={title} className="sr-only">{t('today.idea', { number })}</h2>
    <Pieces suggestion={suggestion} byId={byId} images={images} t={t} />
    {suggestion.reasons.length > 0 && <ul className="today-reasons">{suggestion.reasons.map(reason => <li key={reason.key}><Icon name="check" />{t(reasonKeys[reason.key])}</li>)}</ul>}
    {notes(suggestion).map(key => <p key={key} className="today-missing">{t(key)}</p>)}
    {!suggestion.weatherNeeds && suggestion.missingSlots.length > 0 && <p className="today-missing">{t('today.missing', { categories: list(suggestion.missingSlots) })}</p>}
    {problem}
    <div className="today-actions">
      <button type="button" className="button button-primary" disabled={!online} onClick={onSave}>{t('today.save')}</button>
      <button type="button" className="button button-secondary" aria-pressed={vote === 1} disabled={!online || busy} aria-busy={mine && pending.kind === 'like' || undefined} onClick={onLike}>{t('today.like')}</button>
      <button type="button" className="button button-quiet" disabled={!online || busy} aria-busy={mine && pending.kind === 'hide' || undefined} onClick={onHide}>{t('today.notForMe')}</button>
    </div>
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