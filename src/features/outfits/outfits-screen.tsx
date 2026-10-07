import '../../styles/outfit-flow.css';
import { useState } from 'react';
import { Icon } from '../../app/icon';
import { componentLabel, componentMeta, occasionLabel, type OutfitComponent } from '../../domain/outfits';
import { itemCount, pluralText, type Language, type Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { usePrivateImage } from '../../images/use-private-image';
import { useOutfitList } from './use-outfits';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { OutfitRecord } from '../../domain/outfits';
import type { OutfitLifecycle } from './use-outfit-lifecycle';
import { OutfitLifecycleDialog } from './lifecycle-controls';

function LoadedThumb({ path, alt, images, t }: { path: string; alt: string; images: PrivateImages; t: Translate }) {
  const { ref, url, failed } = usePrivateImage(images, path);
  return <div ref={ref} className={`outfit-thumb ${!url && !failed ? 'skeleton' : ''}`}>
    {url ? <img src={url} alt={alt} width="160" height="200" /> : failed ? <span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span> : <span className="sr-only">{t('common.loading')}</span>}
  </div>;
}
export function OutfitThumb({ component, images, t, decorative = false }: { component: OutfitComponent; images: PrivateImages; t: Translate; decorative?: boolean }) {
  if (!component.thumbPath) return <div className="outfit-thumb"><span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span></div>;
  return <LoadedThumb path={component.thumbPath} alt={decorative ? '' : component.altText} images={images} t={t} />;
}
function metaText(component: OutfitComponent, t: Translate): string | null {
  if (!component.category) return null;
  const meta = componentMeta(component.category, component.colour);
  return meta.colour ? t('outfits.meta', { category: t(meta.category), colour: t(meta.colour) }) : t(meta.category);
}
export function ComponentText({ component, t }: { component: OutfitComponent; t: Translate }) {
  const label = componentLabel(component);
  const meta = metaText(component, t);
  if (component.state === 'missing') return <span className="outfit-component-text"><span className="outfit-component-state">{t('outfits.unavailableItem')}</span></span>;
  return <span className="outfit-component-text">
    <span className="outfit-component-name">{component.title}</span>
    {meta && <span className="outfit-component-meta">{meta}</span>}
    {label && <span className="outfit-component-state">{t(label)}</span>}
  </span>;
}

type Props = {
  client: AppClient; scope: OwnerScope; invalidation: number;
  images: PrivateImages; online: boolean; language: Language; t: Translate;
  onCreate: () => void; onAddItem: () => void;
  lifecycle: OutfitLifecycle;
};
export function OutfitsScreen({ client, scope, invalidation, images, online, language, t, onCreate, onAddItem, lifecycle }: Props) {
  const list = useOutfitList(client, scope, online, invalidation);
  const data = list.data;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<OutfitRecord[] | null>(null);
  const visible = data?.outfits ?? [];
  if (!lifecycle.locked && data && [...selected].some(id => !visible.some(record => record.id === id)))
    setSelected(new Set([...selected].filter(id => visible.some(record => record.id === id))));
  function cancel() { if (!lifecycle.busy) { setSelecting(false); setSelected(new Set()); document.getElementById('outfits-title')?.focus(); } }
  return <section className="outfits-page" aria-labelledby="outfits-title" onKeyDown={event => {
    if (event.key === 'Escape' && !confirmation && selecting) { event.preventDefault(); cancel(); }
  }}>
    <div className="page-heading">
      <div><h1 id="outfits-title" tabIndex={-1}>{t('nav.outfits')}</h1></div>
      {data && data.outfits.length > 0 && <div className="outfit-actions">
        {!selecting && <button type="button" className="button button-secondary" disabled={lifecycle.locked}
          onClick={() => setSelecting(true)}>{t('wardrobe.select')}</button>}
        <button type="button" className="button button-primary" disabled={!online || lifecycle.locked || selecting} onClick={onCreate}><Icon name="plus" />{t('outfits.create')}</button>
      </div>}
    </div>
    {selecting && <div className="outfit-selection">
      <p role="status">{pluralText(language, 'wardrobe.selected', selected.size)}</p>
      <div className="outfit-actions">
        <button type="button" className="text-button" disabled={lifecycle.locked || !visible.length}
          onClick={() => setSelected(new Set(visible.map(record => record.id)))}>{t('outfitTrash.selectAll')}</button>
        <button type="button" className="button button-danger" disabled={!online || lifecycle.locked || !selected.size || list.loading || !!list.error}
          onClick={event => { event.currentTarget.focus(); setConfirmation(visible.filter(record => selected.has(record.id)).map(record => structuredClone(record))); }}>{t('wardrobe.moveSelected')}</button>
        <button type="button" className="button button-secondary" disabled={lifecycle.busy} onClick={cancel}>{t('common.cancel')}</button>
      </div>
    </div>}
    {list.error && <div className="notice notice-error" role="alert"><span>{t('outfits.loadFailed')}</span><button type="button" className="text-button" disabled={!online} onClick={list.reload}>{t('common.retry')}</button></div>}
    {!data ? !list.error && <div className="outfit-grid" aria-busy="true"><p role="status" className="sr-only">{t('common.loading')}</p>
      {Array.from({ length: 3 }, (_, index) => <div key={index} className="loading-card"><div className="loading-photo skeleton" /><div className="loading-line skeleton" /></div>)}</div>
      : data.outfits.length ? <ul className="outfit-grid">
        {data.outfits.map(outfit => {
          const occasion = occasionLabel(outfit);
          const shown = outfit.links.flatMap(link => { const component = data.components.get(link.itemId); return component ? [{ id: link.itemId, component }] : []; }).slice(0, 4);
          const content = <>
            <div className={`outfit-card-thumbs outfit-card-thumbs-${Math.max(shown.length, 1)}`} aria-hidden="true">
              {shown.map(({ id, component }) => <OutfitThumb key={id} component={component} images={images} t={t} decorative />)}
              {shown.length === 3 && <div className="outfit-thumb-fill" />}
            </div>
            <div className="item-caption"><h2>{outfit.title}</h2>
              <span>{outfit.links.length ? itemCount(language, outfit.links.length) : t('outfits.noItems')}</span>
              {occasion && <span className="outfit-card-occasion">{t(occasion)}</span>}
            </div>
          </>;
          return <li key={outfit.id} className="outfit-card">{selecting
            ? <button type="button" className="outfit-card-link outfit-select" disabled={lifecycle.locked} aria-pressed={selected.has(outfit.id)}
              aria-label={t('wardrobe.selectItem', { title: outfit.title })} onClick={() => setSelected(current => {
                const next = new Set(current); if (next.has(outfit.id)) next.delete(outfit.id); else next.add(outfit.id); return next;
              })}>{content}</button>
            : <a className="outfit-card-link" href={`#/outfits/${outfit.id}`}>{content}</a>}</li>;
        })}
      </ul>
      : !list.error && <div className="outfits-empty">
        <p>{t(data.hasClothes ? 'outfits.empty' : 'outfits.noClothes')}</p>
        {data.hasClothes
          ? <button type="button" className="button button-primary" disabled={!online} onClick={onCreate}><Icon name="plus" />{t('outfits.create')}</button>
          : <button type="button" className="button button-primary" onClick={onAddItem}><Icon name="plus" />{t('wardrobe.add')}</button>}
      </div>}
    {confirmation && <OutfitLifecycleDialog title={pluralText(language, 'outfitTrash.confirm', confirmation.length)}
      body={t('outfitTrash.preserve')} action={t('wardrobe.moveSelected')} lifecycle={lifecycle} online={online} t={t}
      onCancel={() => setConfirmation(null)} onConfirm={() => { void lifecycle.execute(confirmation, 'trash').then(result => {
        if (scope.signal.aborted || !result.done.length && !result.failed.length) return;
        setConfirmation(null); setSelected(new Set(result.failed));
        if (!result.failed.length) setSelecting(false);
        document.getElementById('outfits-title')?.focus();
      }); }} />}
  </section>;
}
