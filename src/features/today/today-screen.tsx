import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import '../../styles/today-flow.css';
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
import { featuredStart, next, reconcile, transitionToken, weatherRunId } from './featured';
import { MoreMenu } from './more-menu';
import { useWearToday, wearPanelId } from './use-wear-today';
import { WearPanel } from './wear-today';
import type { StylistStore } from '../stylist/stylist-store';
import { useStylist, useStylistStatus, viewOf } from '../stylist/use-stylist';

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
  stylist: StylistStore; onStylist: () => void; onWorn: () => void; onWriting: (busy: boolean) => void;
};
const titleId = 'today-featured-title';
const lostFocus = (element: Element | null) => element === null || element === document.body || !element.isConnected || element.matches('main');
// A move queued for the next frame only goes ahead if focus is still where it was when the move was decided, or still lost.
const focusById = (id: string, from: Element | null = document.activeElement) => requestAnimationFrame(() => {
  const active = document.activeElement;
  if (active === from || lostFocus(active)) document.getElementById(id)?.focus();
});

export function TodayScreen({ client, scope, images, online, language, t, timeZone, invalidation, weather, weatherStore, onSave, onAddItem, onTurnOnWeather, stylist, onStylist, onWorn, onWriting }: Props) {
  useStylistStatus(stylist);
  const stylistEntry = viewOf(useStylist(stylist)).entry;
  const [occasion, setOccasion] = useState<Occasion>('everyday');
  const [season, setSeason] = useState<Season>(() => defaultSeason(timeZone));
  const forecast = useWeather(weatherStore, weather, online);
  const context = useMemo(() => weatherContext(forecast.forecast, forecast.override), [forecast.forecast, forecast.override]);
  const ideas = useSuggestions(client, scope, online, invalidation, occasion, season, context);
  const wear = useWearToday({ client, scope, timeZone, t, onWorn, onWriting });
  const byId = useMemo(() => new Map((ideas.data?.items ?? []).map(item => [item.id, item])), [ideas.data]);
  const result = ideas.result;
  const list = (categories: readonly Category[]) => new Intl.ListFormat(locales[language], { type: 'conjunction' }).format(categories.map(category => t(categoryKeys[category])));
  // Weather counts as changed when useSuggestions applies it: not while a choice is unsettled.
  const weatherId = weatherRunId(context);
  const [appliedWeather, setAppliedWeather] = useState(weatherId);
  if (!ideas.settling && appliedWeather !== weatherId) setAppliedWeather(weatherId);
  const [page, setPage] = useState(0);
  const token = transitionToken(page, occasion, season, appliedWeather);
  const [stored, setFeatured] = useState(() => featuredStart(token));
  // A new occasion, season or weather reaches useSuggestions after this render, so the first idea is pinned only after it.
  if (stored.token !== token) setFeatured(featuredStart(token, 1, false));
  const featured = stored.token === token ? stored : featuredStart(token, 1, false);
  useEffect(() => { if (!featured.armed) setFeatured(value => value.armed ? value : { ...value, armed: true }); }, [featured.armed]);
  const keys = useMemo(() => result?.status === 'ideas' ? ideas.ideas.map(suggestion => suggestion.key) : [], [result, ideas.ideas]);
  const reconciled = reconcile(keys, featured);
  // The idea a pair was just avoided on gives way to the next one, which counts as another idea.
  const moved = featured.armed && featured.current !== null && reconciled.state.current !== featured.current && ideas.last?.key === featured.current;
  const settled = moved ? { ...reconciled.state, number: featured.number + 1 } : reconciled.state;
  if (settled !== featured && stored.token === token) setFeatured(settled);
  const shown = moved && reconciled.shown.kind === 'idea' ? { ...reconciled.shown, number: featured.number + 1 } : reconciled.shown;
  // Where keyboard focus goes after Show another or Start over has rendered.
  const focusAfter = useRef(false);
  // Set when a confirmed pair moves to the next page: focus goes once that page has rendered.
  const focusPage = useRef<number | null>(null);
  // Where focus was when a move to the title was decided; if it has gone elsewhere since, the move is dropped.
  const focusFrom = useRef<Element | null>(null);
  const busy = ideas.settling || wear.state.kind === 'inFlight';
  const browseLocked = ideas.settling || wear.state.kind === 'inFlight';
  function nextPage() {
    ideas.more([...settled.seen, settled.current]);
    setPage(page + 1);
    setFeatured(featuredStart(transitionToken(page + 1, occasion, season, appliedWeather), featured.number + 1));
  }
  function another() {
    if (browseLocked) return;
    focusAfter.current = true;
    focusFrom.current = document.activeElement;
    const following = next(keys, featured);
    if (following !== 'page') { setFeatured(following); return; }
    nextPage();
  }
  function startOver() {
    if (browseLocked) return;
    focusAfter.current = true;
    focusFrom.current = document.activeElement;
    ideas.startOver();
    setPage(page + 1);
    setFeatured(featuredStart(transitionToken(page + 1, occasion, season, appliedWeather)));
  }
  const status = result?.status;
  const shownKey = shown.kind === 'idea' ? shown.key : null;
  const handled = useRef({ avoids: ideas.avoids, restored: ideas.restored?.count ?? 0 });
  // Once a pair or its Undo is confirmed and nothing is unsettled, move on (or back) a single time. Focus follows only when it was lost
  // with the removed card or Undo button, never when it is somewhere else.
  useEffect(() => {
    if (browseLocked || !result) return;
    const avoidChanged = ideas.avoids !== handled.current.avoids;
    const restoreChanged = ideas.restored !== null && ideas.restored.count !== handled.current.restored;
    if (!avoidChanged && !restoreChanged) return;
    handled.current = { avoids: ideas.avoids, restored: ideas.restored?.count ?? 0 };
    // A confirmation from before the occasion, season or weather changed is consumed without moving this context's page.
    const avoided = avoidChanged && ideas.avoidContext === ideas.contextKey;
    const restored = restoreChanged && ideas.restored?.ctx === ideas.contextKey;
    if (!avoided && !restored) return;
    const active = document.activeElement;
    const lost = lostFocus(active);
    if (lost) focusFrom.current = active;
    if (restored && ideas.restored && keys.includes(ideas.restored.key)) {
      const back = ideas.restored.key;
      setFeatured(value => ({ ...value, current: back, seen: value.current !== null && !value.seen.includes(value.current) ? [...value.seen, value.current] : value.seen }));
      focusAfter.current = lost;
    } else if (restored && !avoided) {
      if (lost) focusById(document.getElementById(titleId) ? titleId : 'today-title');
    } else if (shown.kind === 'gone' && status === 'ideas') {
      focusPage.current = lost ? page + 1 : null;
      nextPage();
    } else if (lost) focusAfter.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- nextPage and the focus helpers only read this render's state
  }, [ideas.avoids, ideas.restored, browseLocked, result, shown.kind, shownKey, status]);
  useEffect(() => {
    if (!status || !focusAfter.current && focusPage.current !== page) return;
    focusAfter.current = false; focusPage.current = null;
    focusById(document.getElementById(titleId) ? titleId : status === 'none' ? 'today-no-more' : 'today-gone', focusFrom.current);
  }, [shownKey, shown.kind, status, page]);
  // An idea that disappears in a refresh takes focus with it only when focus was on it.
  useEffect(() => {
    if (shown.kind === 'gone' && status === 'ideas' && document.activeElement === document.body) focusById('today-gone');
  }, [shown.kind, status]);
  const suggestion = shownKey ? ideas.ideas.find(entry => entry.key === shownKey) ?? null : null;
  // Until the page moves on after a pair is avoided, nothing is shown in place of the idea.
  const advancing = shown.kind === 'gone' && ideas.avoids !== handled.current.avoids && ideas.avoidContext === ideas.contextKey;
  const moreButton = <button type="button" className="button button-secondary" disabled={browseLocked} onClick={another}><Icon name="refresh" />{t('today.more')}</button>;
  return <section className="today-page" aria-labelledby="today-title">
    <WeatherBar weather={forecast} language={language} timeZone={timeZone} online={online} locked={busy} t={t} onTurnOnWeather={onTurnOnWeather} />
    <div className="page-heading"><div><h1 id="today-title" tabIndex={-1}>{t('today.title')}</h1></div></div>
    <div className="today-context">
      <div className="today-selects">
        <label className="field"><span>{t('outfits.occasion')}</span>
          <select value={occasion} disabled={busy} onChange={event => { if (!busy && isOccasion(event.target.value)) setOccasion(event.target.value); }}>
            {occasions.map(code => <option key={code} value={code}>{t(occasionKeys[code])}</option>)}
          </select></label>
        <label className="field"><span>{t('item.season')}</span>
          <select value={season} disabled={busy} onChange={event => { if (!busy && isSeason(event.target.value)) setSeason(event.target.value); }}>
            {seasonCodes.map(code => <option key={code} value={code}>{t(seasonKeys[code])}</option>)}
          </select></label>
      </div>
    </div>
    <WearPanel wear={wear} byId={byId} language={language} online={online} t={t} />
    {ideas.error && <div className="notice notice-error" role="alert"><span>{t('today.loadFailed')}</span><button type="button" className="text-button" disabled={!online} onClick={ideas.reload}>{t('common.retry')}</button></div>}
    {!result ? !ideas.error && <div className="today-ideas" aria-busy="true"><p role="status" className="sr-only">{t('common.loading')}</p>
      <div className="loading-card"><div className="loading-photo skeleton" /><div className="loading-line skeleton" /></div></div>
      : result.status === 'empty' ? <div className="today-empty">
        <p>{t(ideas.hasClothes ? 'today.none' : 'today.empty')}</p>
        <button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button>
      </div>
      : result.status === 'partial' ? <div className="today-ideas">
        {result.suggestions.map(partial => <article key={partial.key} className="today-card today-featured" aria-labelledby={`idea-${partial.key}`}>
          <h2 id={`idea-${partial.key}`} className="sr-only">{t('today.idea', { number: 1 })}</h2>
          <Pieces ids={partial.itemIds} byId={byId} images={images} t={t} />
          <p className="today-missing">{t('today.missing', { categories: list(partial.missingSlots) })}</p>
          {notes(partial).map(key => <p key={key} className="today-missing">{t(key)}</p>)}
          <div className="today-actions"><button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button></div>
        </article>)}
      </div>
      : result.status === 'none' ? <div className="today-empty">
        <p id="today-no-more" tabIndex={-1}>{t(ideas.paged ? 'today.noMore' : 'today.none')}</p>
        {result.missingDetails.includes('formality') && <p className="muted">{t('today.missingFormality')}</p>}
        {ideas.paged && <button type="button" className="button button-secondary" disabled={browseLocked} onClick={startOver}>{t('today.startOver')}</button>}
      </div>
      : <>
        {result.missingDetails.includes('formality') && <p className="muted today-hint">{t('today.missingFormality')}</p>}
        <div className="today-ideas">
          {suggestion && shown.kind === 'idea' ? <Idea key={suggestion.key} suggestion={suggestion} number={shown.number} byId={byId} images={images} t={t} list={list}
            online={online} vote={ideas.votes.get(suggestion.key) ?? null} pending={ideas.pending} failed={ideas.failed === suggestion.key} unresolved={ideas.unresolved === suggestion.key} locked={ideas.unresolved !== null || wear.state.kind === 'inFlight'} onRetry={ideas.retry}
            onSave={() => onSave(suggestion.itemIds, occasion)} onLike={() => ideas.like(suggestion.key)}
            onHide={() => ideas.hide(suggestion.key)} onUndo={() => ideas.undo(suggestion.key)}
            unsettled={ideas.unsettledPair(suggestion.key)} onAvoid={(first, second) => ideas.avoid(suggestion.key, first, second)}
            wearBlocked={wear.blocked} pairBusy={ideas.pairBusy} onWear={() => wear.wear(suggestion.itemIds, byId)} more={moreButton} />
            : advancing ? null : <div className="today-empty">
              <p id="today-gone" tabIndex={-1} role="status">{t('today.ideaGone')}</p>
              {moreButton}
            </div>}
        </div>
      </>}
    {ideas.undoKey && <UndoPair t={t} online={online} locked={browseLocked} pending={ideas.pending?.key === ideas.undoKey}
      failed={ideas.failed === ideas.undoKey} unresolved={ideas.unresolved === ideas.undoKey} onUndo={ideas.allow} onRetry={ideas.retry} />}
    {stylistEntry && <div className="today-more"><button type="button" className="button button-secondary" onClick={onStylist}>{t('stylist.open')}</button></div>}
  </section>;
}

function UndoPair({ t, online, locked, pending, failed, unresolved, onUndo, onRetry }: {
  t: Translate; online: boolean; locked: boolean; pending: boolean; failed: boolean; unresolved: boolean; onUndo: () => void; onRetry: () => void;
}) {
  const undo = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const was = useRef(pending);
  // When a write from here ends without removing this row, focus returns to its Undo, or to Try again when the result is uncertain.
  useEffect(() => {
    if (was.current && !pending) {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected || active.matches('main') || active.closest('.today-undo')) {
        (unresolved ? retry : undo).current?.focus();
      }
    }
    was.current = pending;
  }, [pending, unresolved]);
  return <div className="today-undo">
    {unresolved
      ? <div className="notice notice-error" role="alert"><span>{t('today.voteFailed')}</span><button ref={retry} type="button" className="text-button" disabled={!online || pending} onClick={onRetry}>{t('common.retry')}</button></div>
      : <>
        <button ref={undo} type="button" className="text-button" aria-label={t('today.undoPair')} disabled={!online || locked} aria-busy={pending || undefined} onClick={onUndo}>{t('common.undo')}</button>
        {failed && <p className="notice notice-error" role="alert">{t('today.voteFailed')}</p>}
      </>}
  </div>;
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
  unsettled: string | null; onAvoid: (first: string, second: string) => void;
  wearBlocked: boolean; pairBusy: boolean; onWear: () => void; more: ReactNode;
};
function Idea({ suggestion, number, byId, images, t, list, online, vote, pending, failed, unresolved, locked, onSave, onLike, onHide, onUndo, onRetry,
  unsettled, onAvoid, wearBlocked, pairBusy, onWear, more }: IdeaProps) {
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const legend = useRef<HTMLLegendElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const undoHide = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const wasUnsettled = useRef(unsettled);
  const wasHidden = useRef(vote === -1);
  // Focus moves with the card only when it is on the card, or was lost when a button on it went away.
  // Some browsers leave focus on a removed button, or on <main> after a click on a button.
  const here = () => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected || active.matches('main') || card.current?.contains(active) === true;
  };
  // The More options toggle is the card's resting place once a choice made from its menu is undone or settled.
  const returnFocus = () => requestAnimationFrame(() => { if (here()) toggle.current?.focus(); });
  useEffect(() => { if (choosing) legend.current?.focus(); }, [choosing]);
  // An uncertain pair choice turns the card into its Try again, and back once it is settled, without taking focus from elsewhere.
  useEffect(() => {
    if (unsettled && !wasUnsettled.current) { if (here()) retry.current?.focus(); }
    else if (!unsettled && wasUnsettled.current) returnFocus();
    wasUnsettled.current = unsettled;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- here and returnFocus only read refs
  }, [unsettled]);
  const hidden = vote === -1;
  useEffect(() => {
    if (hidden && !wasHidden.current) { if (here()) undoHide.current?.focus(); }
    else if (!hidden && wasHidden.current) returnFocus();
    wasHidden.current = hidden;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- here and returnFocus only read refs
  }, [hidden]);
  const pieces = suggestion.itemIds.filter(id => byId.has(id));
  // Until an uncertain choice is settled, only its Try again is offered on the page.
  const busy = pending !== null || locked;
  const problem = unresolved
    ? <div className="notice notice-error" role="alert"><span>{t('today.voteFailed')}</span><button ref={retry} type="button" className="text-button" disabled={!online || pending !== null} onClick={onRetry}>{t('common.retry')}</button></div>
    : failed && <p className="notice notice-error" role="alert">{t('today.voteFailed')}</p>;
  const mine = pending?.key === suggestion.key;
  const heading = <h2 id={titleId} className="today-idea-title" tabIndex={-1}>{t('today.idea', { number })}</h2>;
  // Until it is settled the pair may already be avoided, so the card offers nothing but its Try again.
  if (unsettled) return <article ref={card} className="today-card today-featured today-card-hidden" aria-labelledby={titleId}>
    {heading}
    <Pieces ids={suggestion.itemIds.filter(id => unsettled.split('|').includes(id))} byId={byId} images={images} t={t} />
    {problem}
    <div className="today-actions">{more}</div>
  </article>;
  if (hidden) return <article ref={card} className="today-card today-featured today-card-hidden" aria-labelledby={titleId}>
    {heading}
    <p role="status">{t('today.hidden')}</p>
    {problem}
    <div className="today-actions">
      <button ref={undoHide} type="button" className="text-button" disabled={!online || busy} aria-busy={mine || undefined} onClick={onUndo}>{t('common.undo')}</button>
      {more}
    </div>
  </article>;
  // Saving and wearing wait while any pair choice (on this card, or the Undo below) is being written or is unsettled.
  const pairing = pairBusy;
  const wearDisabled = !online || pairing || wearBlocked || locked;
  return <article ref={card} className="today-card today-featured" aria-labelledby={titleId}>
    {heading}
    <Pieces ids={suggestion.itemIds} byId={byId} images={images} t={t} />
    {suggestion.reasons.length > 0 && <ul className="today-reasons">{suggestion.reasons.map(reason => <li key={reason.key}><Icon name="check" />{t(reasonKeys[reason.key])}</li>)}</ul>}
    {notes(suggestion).map(key => <p key={key} className="today-missing">{t(key)}</p>)}
    {!suggestion.weatherNeeds && suggestion.missingSlots.length > 0 && <p className="today-missing">{t('today.missing', { categories: list(suggestion.missingSlots) })}</p>}
    {problem}
    <div className="today-actions">
      <button type="button" className="button button-primary" disabled={wearDisabled} aria-describedby={wearBlocked ? wearPanelId : undefined} onClick={onWear}>{t('calendar.wearToday')}</button>
      {more}
    </div>
    <div className="today-quiet">
      <button type="button" className="text-button" disabled={!online || pairing} onClick={onSave}>{t('today.save')}</button>
      <button type="button" className="text-button today-like" aria-pressed={vote === 1} disabled={!online || busy} aria-busy={mine && pending.kind === 'like' || undefined} onClick={onLike}>{t('today.like')}</button>
      <MoreMenu label={t('common.moreOptions')} open={menu && !choosing} disabled={!online || busy} toggle={toggle} onOpen={setMenu}>
        <button type="button" className="text-button" disabled={!online || busy} aria-busy={mine && pending.kind === 'hide' || undefined}
          onClick={() => { setMenu(false); onHide(); }}>{t('today.notForMe')}</button>
        {pieces.length >= 2 && <button type="button" className="text-button" disabled={!online || busy || choosing}
          aria-busy={mine && pending.kind === 'avoid' || undefined}
          onClick={() => { setMenu(false); if (pieces.length === 2) onAvoid(pieces[0]!, pieces[1]!); else { setPicked([]); setChoosing(true); } }}>{t('today.dontPair')}</button>}
      </MoreMenu>
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
        <button type="button" className="button button-quiet" onClick={() => { setChoosing(false); returnFocus(); }}>{t('common.cancel')}</button>
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
    else if (status === 'unknown') { if (need !== 'rain') add('today.checkWind'); }
    else if (status === 'lacking' && need !== 'cold') add(need === 'rain' ? 'today.noRain' : 'today.noWind');
  }
  // An unknown need stays unsaid for rain, so it must not turn into a claim that nothing suits the weather.
  if (needs.some(entry => entry.status === 'apart' || entry.status === 'lacking') && !needs.some(entry => entry.status === 'unknown') && !found.length) add('today.noCover');
  if (suggestion.missingDetails.includes('coverage')) add('today.checkLength');
  return found;
}