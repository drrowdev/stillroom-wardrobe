import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { loadComponents } from '../../data/outfits';
import { plannedKey } from '../../domain/outfitgen-pictures';
import { outfitGenLimits, type Suggestion } from '../../domain/outfitgen-app';
import type { OutfitComponent } from '../../domain/outfits';
import { locales, pluralText, type Language, type MessageKey, type Translate } from '../../i18n';
import '../../i18n/outfitgen';
import '../../i18n/tryon';
import type { PrivateImages } from '../../images/private-images';
import { usePrivateImage } from '../../images/use-private-image';
import {
  keepSuggestion, outfitGenStoreFor, pausePass, readList, removeSuggestion, runPass, statusOf, stopPass, undoRemoval, viewOf, type OutfitGenStore,
} from '../outfitgen/outfitgen-store';
import { pictureQueueFor, type PictureLine, type PictureQueue, type PictureState } from '../outfitgen/picture-queue';
import { useOutfitGen, useOutfitGenStatus } from '../outfitgen/use-outfitgen';
import { usePictureQueue } from '../outfitgen/use-pictures';
import { TryOnPicture } from './try-on/try-on-parts';
import { ideaSelection, itemName, slotKey } from './use-try-on';

function Thumb({ component, images, t }: { component: OutfitComponent | undefined; images: PrivateImages; t: Translate }) {
  if (!component?.thumbPath) return <div className="outfit-thumb"><span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span></div>;
  return <LoadedThumb path={component.thumbPath} alt={component.altText} images={images} t={t} />;
}
function LoadedThumb({ path, alt, images, t }: { path: string; alt: string; images: PrivateImages; t: Translate }) {
  const { ref, url, failed } = usePrivateImage(images, path);
  return <div ref={ref} className={`outfit-thumb ${!url && !failed ? 'skeleton' : ''}`}>
    {url ? <img src={url} alt={alt} width="160" height="200" /> : failed ? <span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span>
      : <span className="sr-only">{t('common.loading')}</span>}
  </div>;
}

type Props = { client: AppClient; scope: OwnerScope; images: PrivateImages; online: boolean; language: Language; t: Translate; onKept: () => void };
/**
 * The Suggested outfits section of the Outfits tab. It shows nothing until the backend has the feature (the app stays
 * inert), and only prompts for consent where consent is what's missing. Keep saves a normal outfit; Remove hides the
 * suggestion for good and can be undone right after.
 */
export function SuggestedOutfits({ client, scope, images, online, language, t, onKept }: Props) {
  const store = outfitGenStoreFor(client, scope);
  return store ? <Section store={store} client={client} scope={scope} images={images} online={online} language={language} t={t} onKept={onKept} /> : null;
}

function Section({ store, client, scope, images, online, language, t, onKept }: Props & { store: OutfitGenStore }) {
  useOutfitGenStatus(store);
  const state = useOutfitGen(store);
  const view = viewOf(state);
  const status = statusOf(state);
  const heading = useRef<HTMLHeadingElement>(null);
  const [components, setComponents] = useState<ReadonlyMap<string, OutfitComponent>>(() => new Map());
  const on = view.kind === 'on';
  const queue = pictureQueueFor(client, scope);
  const pics = usePictureQueue(queue);
  // The queue also starts a few seconds after the app opens; here it only reads the saved pictures for the cards on screen.
  useEffect(() => { if (on && queue) { queue.start(); void queue.refreshPictures(); } }, [on, queue]);
  useEffect(() => { if (on && state.list.kind === 'unknown') void readList(store); }, [on, state.list.kind, store]);
  // Leaving the screen pauses a running pass; coming back does not restart it.
  useEffect(() => () => pausePass(store), [store]);
  const wanted = state.list.suggestions.flatMap((suggestion) => suggestion.itemIds).filter((id) => !components.has(id));
  const wantedKey = [...new Set(wanted)].sort().join(',');
  useEffect(() => {
    if (!wantedKey) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    loadComponents(client, scope, wantedKey.split(','), signal).then((loaded) => {
      if (signal.aborted) return;
      setComponents((current) => new Map([...current, ...loaded]));
    }, () => undefined);
    return () => controller.abort();
  }, [wantedKey, client, scope]);
  if (!view.section) return null;
  const limits = status ? outfitGenLimits(status) : null;
  const suggestions = state.list.suggestions;
  const running = state.running !== null;
  const settle = () => setTimeout(() => {
    if (document.activeElement === null || document.activeElement === document.body) heading.current?.focus();
  }, 0);
  // The decision is marked first, so the queue never mistakes a decided card for one that went away; Remove then deletes the pictures it made.
  const keep = (id: string) => {
    const release = queue?.intend(id, 'keep');
    void keepSuggestion(store, id).then((result) => { if (result.code === 'OK') onKept(); settle(); }).finally(() => release?.());
  };
  const remove = (id: string) => {
    const card = suggestions.find((entry) => entry.id === id);
    const release = queue?.intend(id, 'remove');
    void removeSuggestion(store, id).then(async () => {
      if (queue && card && store.get().removed?.id === id) await queue.discard(card);
    }).finally(() => { release?.(); settle(); });
  };
  const pass = state.pass;
  const plural = (base: 'outfitgen.found' | 'outfitgen.passFound' | 'outfitgen.passLeft' | 'outfitgen.passStopped', count: number) =>
    t(`${base}_${new Intl.PluralRules(locales[language]).select(count) === 'one' ? 'one' : 'other'}` as MessageKey,
      { count: new Intl.NumberFormat(locales[language]).format(count) });
  const line = (key: MessageKey, count?: number) => count === undefined ? t(key)
    : key === 'outfitgen.passStopped_other' ? plural('outfitgen.passStopped', count) : plural('outfitgen.found', count);
  // One button for Find, Stop and the moments between. It is never natively disabled, so it keeps focus when a pass ends: it is only
  // marked aria-disabled, and activation is ignored while it is waiting, offline or over the limit.
  const waiting = running && (pass === null || pass.stopping);
  const blocked = waiting || (!running && (!online || limits?.reached === true));
  return <section className="suggested" aria-labelledby="suggested-title">
    <div className="suggested-head">
      <h2 id="suggested-title" ref={heading} tabIndex={-1}>{suggestions.length ? t('outfitgen.titleCount', { count: suggestions.length }) : t('outfitgen.title')}</h2>
      {view.run && <button type="button" className="button button-secondary" id="suggested-find" aria-disabled={blocked || undefined}
        onClick={() => { if (blocked) return; if (pass) stopPass(store); else if (!running) void runPass(store, language); }}>
        {t(pass ? (pass.stopping ? 'outfitgen.passStopping' : 'outfitgen.passStop') : state.running === 'manual' ? 'outfitgen.finding' : 'outfitgen.find')}</button>}
    </div>
    <div role="status" className="suggested-notices">
      {state.running !== null && <p>{t('outfitgen.finding')}</p>}
      {state.notices.map((notice) => notice.key === 'outfitgen.removed' && state.removed
        ? <p key={notice.at}>{t(notice.key)}{' '}<button type="button" className="text-button"
          disabled={state.deciding.has(state.removed.id) || pics?.deleting.has(state.removed.id) === true || !online}
          onClick={() => { void undoRemoval(store); }}>{t('common.undo')}</button></p>
        : notice.key === 'aiGuard.paused'
          ? <p key={notice.at}>{t(notice.key)}{' '}<a className="text-button" href="#/settings">{t('aiGuard.settingsLink')}</a></p>
          : <p key={notice.at}>{line(notice.key, notice.count)}</p>)}
    </div>
    {pass && <p className="suggested-pass">{t('outfitgen.passProgress', { left: plural('outfitgen.passLeft', pass.left), found: plural('outfitgen.passFound', pass.found) })}</p>}
    {(view.kind === 'off' || view.kind === 'renew') && <p><span>{t('outfitgen.off')}</span>{' '}<a className="text-button" href="#/settings">{t('aiC.turnOn')}</a></p>}
    {on && limits?.reached && <p className="notice">{t('outfitgenC.limit')}</p>}
    {on && suggestions.length > 0 && <div aria-live="polite" className="suggested-picture-status">
      {pics?.making ? <p className="suggested-picture-line">{progressText(pics, language, t)}</p>
        : pics?.line ? <PictureLineText pics={pics} line={pics.line} language={language} t={t} /> : null}
    </div>}
    {on && pics?.deleteFailed && <p className="notice" role="status">{t('outfitgen.pictureDeleteFailed')}{' '}<button type="button" className="text-button" disabled={!online}
      onClick={() => { void queue?.retryCleanup(); }}>{t('common.retry')}</button></p>}
    {view.kind === 'loadFailed' && <p className="notice notice-error">{t('outfitgen.loadFailed')}</p>}
    {on && state.list.kind === 'failed' && <div className="notice notice-error" role="alert"><span>{t('outfitgen.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={() => { void readList(store); }}>{t('common.retry')}</button></div>}
    {on && state.list.kind === 'ready' && suggestions.length === 0 && !running && state.notices.length === 0 && <p>{t('outfitgen.none')}</p>}
    {on && suggestions.length > 0 && <ul className="suggested-list">
      {suggestions.map((suggestion) => <Card key={suggestion.id} suggestion={suggestion} components={components} images={images} t={t}
        queue={queue} pics={pics} busy={state.deciding.has(suggestion.id)} online={online}
        onKeep={() => keep(suggestion.id)} onRemove={() => remove(suggestion.id)} />)}
    </ul>}
  </section>;
}

type LineKey = Exclude<PictureLine, 'guard' | 'missing'>;
const pictureLines: Record<LineKey, MessageKey> = {
  tryOnOff: 'outfitgen.pictureTryOnOff', noPhoto: 'outfitgen.pictureNoPhoto', full: 'outfitgen.pictureFull',
  budget: 'outfitgen.pictureBudget', retryLater: 'outfitgen.pictureRetry', otherWindow: 'outfitgen.pictureOtherWindow',
  otherPicture: 'outfitgen.pictureOtherPicture', ownTryOn: 'outfitgen.pictureOwnTryOn', cleanup: 'outfitgen.pictureCleanup',
  stopping: 'outfitgen.pictureStopping', tryOnPaused: 'outfitgen.pictureTryOnPaused',
  unreadable: 'outfitgen.pictureUnreadable', noLocks: 'outfitgen.pictureNoLocks', offline: 'outfitgen.pictureOffline',
};
/** The overall count of the pictures being made, with the time left when it is known. */
function progressText(pics: PictureState, language: Language, t: Translate): string {
  const counts = { done: pics.done, total: Math.max(pics.total, pics.done + 1) };
  const minutes = pics.minutesLeft;
  if (minutes === null) return t('outfitgen.pictureProgress', counts);
  const left = minutes < 1 ? t('outfitgen.pictureLeftShort')
    : t('outfitgen.pictureLeft', { duration: new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(minutes) });
  return t('outfitgen.pictureProgressLeft', { ...counts, left });
}
/** The one plain line shown when pictures are not being made; the cards still list their garments. */
function PictureLineText({ pics, line, language, t }: { pics: PictureState; line: PictureLine; language: Language; t: Translate }) {
  const time = pics.lineAtMs === null ? '' : new Intl.DateTimeFormat(locales[language], { hour: '2-digit', minute: '2-digit' }).format(pics.lineAtMs);
  const text = line === 'guard' ? t('aiGuard.paused') : line === 'missing' ? pluralText(language, 'outfitgen.pictureMissing', pics.missing) : t(pictureLines[line], { time });
  return <p className="suggested-picture-line">{text}{(line === 'tryOnOff' || line === 'noPhoto') && <>{' '}<a className="text-button" href="#/settings">{t('nav.settings')}</a></>}</p>;
}

/** Mounts the picture only when its card is near the screen, so many cards never fetch their pictures at once. */
function LazyPicture({ queue, id, title, online, t }: { queue: PictureQueue; id: string; title: string; online: boolean; t: Translate }) {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: '300px 0px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return <div ref={ref} className="suggested-picture">
    {near ? <TryOnPicture api={queue.api} result={{ id }} t={t} online={online} idPrefix={`suggested-${id}`} readOnly
      alt={t('outfitgen.pictureAlt', { title })} /> : <div className="tryon-frame" aria-hidden="true" />}
  </div>;
}

function Card({ suggestion, components, images, t, queue, pics, busy, online, onKeep, onRemove }: {
  suggestion: Suggestion; components: ReadonlyMap<string, OutfitComponent>; images: PrivateImages; t: Translate;
  queue: PictureQueue | null; pics: PictureState | null; busy: boolean; online: boolean; onKeep: () => void; onRemove: () => void;
}) {
  const key = plannedKey(ideaSelection(suggestion.itemIds, components).steps);
  const picture = key !== null ? pics?.pictures?.get(key) : undefined;
  const making = pics?.making?.id === suggestion.id ? pics.making : null;
  const queued = key !== null && pics?.waiting.has(suggestion.id) === true;
  return <li className="suggested-card">
    {picture && queue ? <LazyPicture key={picture.id} queue={queue} id={picture.id} title={suggestion.title} online={online} t={t} />
      : making ? <div className="tryon-frame suggested-wait">
        <div className="suggested-progress" role="progressbar" aria-valuemin={0} aria-valuemax={making.steps} aria-valuenow={making.completedSteps}
          aria-valuetext={t('outfitgen.pictureStep', { step: making.step, steps: making.steps })}           aria-label={suggestion.title}>
          {Array.from({ length: making.steps }, (_, at) => <span key={at} data-state={at < making.completedSteps ? 'done' : at === making.completedSteps ? 'now' : 'waiting'} />)}
        </div>
        <p>{making.slow ? t('outfitgen.pictureSlow') : t('outfitgen.pictureStep', { step: making.step, steps: making.steps })}</p>
                  {!making.slow && (making.reason === 'busy' || making.reason === 'holding') && <p>{t('tryon.waiting')}</p>}
      </div>
      : queued ? <div className="tryon-frame suggested-wait"><p>{t('outfitgen.pictureQueued')}</p></div> : null}
    <ul className="suggested-garments" aria-label={t('outfitgen.garments', { title: suggestion.title })}>
      {suggestion.itemIds.map((id) => {
        const component = components.get(id);
        return <li key={id}>
          <Thumb component={component} images={images} t={t} />
          <span className="suggested-garment-text">
            <span>{itemName(components, id, t)}</span>
            {component?.category && <span className="muted">{t(slotKey(component.category))}</span>}
          </span>
        </li>;
      })}
    </ul>
    <div className="suggested-text">
      <h3>{suggestion.title}</h3>
      <p className="suggested-occasion">{t(`occasion.${suggestion.occasion}`)}</p>
      <p>{suggestion.reason}</p>
    </div>
    <div className="suggested-actions">
      <button type="button" className="button button-primary" disabled={busy || !online} aria-label={t('outfitgen.keepLabel', { title: suggestion.title })}
        onClick={onKeep}>{t('outfitgen.keep')}</button>
      <button type="button" className="button button-secondary" disabled={busy || !online} aria-label={t('outfitgen.removeLabel', { title: suggestion.title })}
        onClick={onRemove}>{t('outfitgen.remove')}</button>
    </div>
  </li>;
}