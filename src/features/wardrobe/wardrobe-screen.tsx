import { categoryKeys, type WardrobeItem } from '../../domain/wardrobe';
import { itemCount, type Language, type MessageKey, type Translate } from '../../i18n';
import { Icon, WardrobeIllustration } from '../../app/icon';
import type { PrivateImages } from '../../images/private-images';
import { usePrivateImage } from '../../images/use-private-image';
import { WardrobeFilters } from './filters';
import type { WardrobeBrowse } from './use-wardrobe-browse';
import { sorts, type WardrobeSort } from './search';
import { formatMoney } from '../../i18n/format';

const sortKeys: Record<WardrobeSort, MessageKey> = {
  newest: 'wardrobe.newest', name: 'wardrobe.nameOrder', leastWorn: 'wardrobe.leastWorn',
  lastWorn: 'wardrobe.lastWornOrder', price: 'wardrobe.priceOrder',
};

function ItemPhoto({ item, images, t }: { item: WardrobeItem; images: PrivateImages; t: Translate }) {
  const { ref, url, failed } = usePrivateImage(images, item.thumbPath);
  return (
    <div ref={ref} className={`item-photo ${!url && !failed ? 'skeleton' : ''}`}>
      {url ? <img src={url} alt={item.altText} width="320" height="400" /> : failed ? <span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span> : <span className="sr-only">{t('common.loading')}</span>}
    </div>
  );
}
type Props = {
  browse: WardrobeBrowse; images: PrivateImages;
  onAdd: () => void; onRefresh: () => void; online: boolean; language: Language; t: Translate;
};
export function WardrobeScreen({ browse, images, onAdd, onRefresh, online, language, t }: Props) {
  const { items, loading, error } = browse;
  const groups: { key: string; items: WardrobeItem[] }[] = [];
  for (const item of browse.visible) {
    const key = browse.sort === 'price' ? item.purchasePrice === null ? 'no-price' : item.currency : 'all';
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return (
    <section className="wardrobe-page" aria-labelledby="wardrobe-title">
      <div className="page-heading">
        <div><h1 id="wardrobe-title" tabIndex={-1}>{t('wardrobe.title')}</h1></div>
        <button type="button" className="button button-primary" onClick={onAdd}><Icon name="plus" />{t('wardrobe.add')}</button>
      </div>
      {error && <div className="notice notice-error" role="alert"><span>{t(error)}</span><button className="text-button" onClick={onRefresh} disabled={!online}>{t('common.retry')}</button></div>}
      {browse.historyError && <div role="alert" className="notice notice-error"><span>{t('wardrobe.historyUnavailable')}</span><button className="text-button" type="button" disabled={!online} onClick={browse.retryHistory}>{t('common.retry')}</button></div>}
      {browse.initialized && (loading || error || browse.historyError) && <p role="status">{t('common.stale')}</p>}
      {browse.historyLoading && <p role="status">{t('wardrobe.historyLoading')}</p>}
      {!browse.initialized && !error ? (
        <section className="item-grid" aria-busy="true" aria-label={t('common.loading')}>
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="loading-card"><div className="loading-photo skeleton" /><div className="loading-line skeleton" /></div>)}
        </section>
      ) : items.length ? (
        <>
          <div className="collection-bar"><span className="wardrobe-result-count" role="status">{itemCount(language, browse.results.length)}</span><button type="button" className="text-button" onClick={onRefresh} disabled={!online} aria-label={t('wardrobe.refresh')}><Icon name="refresh" />{t('common.refresh')}</button></div>
          <div className="wardrobe-tools">
            <label htmlFor="wardrobe-search">{t('common.search')}<input id="wardrobe-search" type="search" maxLength={512} placeholder={t('wardrobe.searchPlaceholder')} value={browse.query} onChange={event => browse.setQuery(event.target.value)} /></label>
            <label htmlFor="wardrobe-sort">{t('common.sort')}<select id="wardrobe-sort" value={browse.requestedSort} onChange={event => {
              const next = sorts.find(sort => sort === event.target.value);
              if (next) browse.chooseSort(next);
            }}>{sorts.map(sort => <option key={sort} value={sort}>{t(sortKeys[sort])}</option>)}</select></label>
          </div>
          <WardrobeFilters items={items} value={browse.facets} onChange={browse.setFacets} language={language} t={t} />
          {!browse.results.length && <div className="wardrobe-no-matches"><p>{t('wardrobe.noMatches')}</p><button className="button button-secondary" type="button" onClick={browse.clear}>{t('wardrobe.clearSearchFilters')}</button></div>}
          {groups.map(group => <div key={group.key} className="wardrobe-group" role={browse.sort === 'price' ? 'group' : undefined}
            aria-labelledby={browse.sort === 'price' ? `wardrobe-price-${group.key}` : undefined}>
          {browse.sort === 'price' && <p id={`wardrobe-price-${group.key}`} className="wardrobe-price-heading">{group.key === 'no-price' ? t('wardrobe.noPrice') : group.key}</p>}
          <ul className="item-grid">
            {group.items.map((item) => <li className="item-card" key={item.id}><a className="item-detail-link" href={`#/items/${item.id}`}><ItemPhoto item={item} images={images} t={t} /><div className="item-caption"><h2>{item.title}</h2><span>{t(categoryKeys[item.category])}</span>
              {browse.sort === 'price' && item.purchasePrice !== null && <p className="wardrobe-price">{formatMoney(item.purchasePrice, item.currency, language)}</p>}
              <div className="item-status">{item.favourite && <span>{t('item.favourite')}</span>}
                {item.availability !== 'ready' && <span>{t(`availability.${item.availability}`)}</span>}
                {item.lifecycle !== 'active' && <span>{t(`lifecycle.${item.lifecycle}`)}</span>}
                {item.excludeSuggestions && <span>{t('lifecycle.excluded')}</span>}</div>
            </div></a></li>)}
          </ul>
          </div>)}
          {browse.results.length > browse.visible.length && <div className="load-more"><button type="button" className="button button-secondary" onClick={browse.showMore}>{t('wardrobe.more')}</button></div>}
        </>
      ) : !error ? (
        <div className="empty-wardrobe">
          <div className="empty-art"><WardrobeIllustration /></div>
          <div className="empty-copy"><h2>{t('wardrobe.empty')}</h2><button type="button" className="button button-primary" onClick={onAdd}><Icon name="plus" />{t('wardrobe.add')}</button><p className="privacy-note"><Icon name="lock" />{t('wardrobe.privateNote')}</p></div>
        </div>
      ) : null}
    </section>
  );
}
