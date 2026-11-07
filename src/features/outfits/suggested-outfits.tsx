import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { loadComponents } from '../../data/outfits';
import { outfitGenLimits, type Suggestion } from '../../domain/outfitgen-app';
import type { OutfitComponent } from '../../domain/outfits';
import { pluralText, type Language, type MessageKey, type Translate } from '../../i18n';
import '../../i18n/outfitgen';
import type { PrivateImages } from '../../images/private-images';
import { usePrivateImage } from '../../images/use-private-image';
import {
  keepSuggestion, outfitGenStoreFor, readList, removeSuggestion, runManual, statusOf, undoRemoval, viewOf, type OutfitGenStore,
} from '../outfitgen/outfitgen-store';
import { useOutfitGen, useOutfitGenStatus } from '../outfitgen/use-outfitgen';

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
  useEffect(() => { if (on && state.list.kind === 'unknown') void readList(store); }, [on, state.list.kind, store]);
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
  const keep = (id: string) => { void keepSuggestion(store, id).then((result) => { if (result.code === 'OK') onKept(); settle(); }); };
  const remove = (id: string) => { void removeSuggestion(store, id).then(settle); };
  const line = (key: MessageKey, count?: number) => key === 'outfitgen.found_other' && count !== undefined
    ? pluralText(language, 'outfitgen.found', count) : t(key);
  return <section className="suggested" aria-labelledby="suggested-title">
    <div className="suggested-head">
      <h2 id="suggested-title" ref={heading} tabIndex={-1}>{suggestions.length ? t('outfitgen.titleCount', { count: suggestions.length }) : t('outfitgen.title')}</h2>
      {view.run && <button type="button" className="button button-secondary" disabled={!online || running || limits?.reached === true}
        onClick={() => { void runManual(store, language); }}>{t(state.running === 'manual' ? 'outfitgen.finding' : 'outfitgen.find')}</button>}
    </div>
    <div role="status" className="suggested-notices">
      {state.running === 'auto' && <p>{t('outfitgen.finding')}</p>}
      {state.notices.map((notice) => notice.key === 'outfitgen.removed' && state.removed
        ? <p key={notice.at}>{t(notice.key)}{' '}<button type="button" className="text-button" disabled={state.deciding.has(state.removed.id) || !online}
          onClick={() => { void undoRemoval(store); }}>{t('common.undo')}</button></p>
        : <p key={notice.at}>{line(notice.key, notice.count)}</p>)}
    </div>
    {(view.kind === 'off' || view.kind === 'renew') && <p><span>{t('outfitgen.off')}</span>{' '}<a className="text-button" href="#/settings">{t('aiC.turnOn')}</a></p>}
    {on && limits?.reached && <p className="notice">{t('outfitgenC.limit')}</p>}
    {view.kind === 'loadFailed' && <p className="notice notice-error">{t('outfitgen.loadFailed')}</p>}
    {on && state.list.kind === 'failed' && <div className="notice notice-error" role="alert"><span>{t('outfitgen.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={() => { void readList(store); }}>{t('common.retry')}</button></div>}
    {on && state.list.kind === 'ready' && suggestions.length === 0 && !running && state.notices.length === 0 && <p>{t('outfitgen.none')}</p>}
    {on && suggestions.length > 0 && <ul className="suggested-list">
      {suggestions.map((suggestion) => <Card key={suggestion.id} suggestion={suggestion} components={components} images={images} t={t}
        busy={state.deciding.has(suggestion.id)} online={online} onKeep={() => keep(suggestion.id)} onRemove={() => remove(suggestion.id)} />)}
    </ul>}
  </section>;
}

function Card({ suggestion, components, images, t, busy, online, onKeep, onRemove }: {
  suggestion: Suggestion; components: ReadonlyMap<string, OutfitComponent>; images: PrivateImages; t: Translate; busy: boolean; online: boolean;
  onKeep: () => void; onRemove: () => void;
}) {
  return <li className="suggested-card">
    <div className="suggested-thumbs">
      {suggestion.itemIds.map((id) => <Thumb key={id} component={components.get(id)} images={images} t={t} />)}
    </div>
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
