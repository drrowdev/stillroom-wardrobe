import { useEffect, useState } from 'react';
import { categoryKeys, type WardrobeItem } from '../../domain/wardrobe';
import { itemCount, type Language, type MessageKey, type Translate } from '../../i18n';
import { Icon, WardrobeIllustration } from '../../app/icon';
import type { PrivateImages } from '../../images/private-images';
import { isAborted } from '../../data/errors';

function ItemPhoto({ item, images, t }: { item: WardrobeItem; images: PrivateImages; t: Translate }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(null);
    setFailed(false);
    void images.get(item.thumbPath).then((source) => { if (active) setUrl(source); }, (error: unknown) => {
      if (active && !isAborted(error)) setFailed(true);
    });
    return () => { active = false; };
  }, [images, item.thumbPath]);
  return (
    <div className={`item-photo ${!url && !failed ? 'skeleton' : ''}`}>
      {url ? <img src={url} alt={item.altText} width="320" height="400" /> : failed ? <span className="photo-unavailable"><Icon name="photo" />{t('photo.missing')}</span> : <span className="sr-only">{t('common.loading')}</span>}
    </div>
  );
}
type Props = {
  items: WardrobeItem[]; images: PrivateImages; loading: boolean; error: MessageKey | null;
  onAdd: () => void; onRefresh: () => void; online: boolean; language: Language; t: Translate;
};
export function WardrobeScreen({ items, images, loading, error, onAdd, onRefresh, online, language, t }: Props) {
  const [visible, setVisible] = useState(40);
  return (
    <section className="wardrobe-page" aria-labelledby="wardrobe-title">
      <div className="page-heading">
        <div><p className="eyebrow">{t('wardrobe.eyebrow')}</p><h1 id="wardrobe-title" tabIndex={-1}>{t('wardrobe.title')}</h1><p className="muted">{t('wardrobe.description')}</p></div>
        <button type="button" className="button button-primary" onClick={onAdd}><Icon name="plus" />{t('wardrobe.add')}</button>
      </div>
      {error && <div className="notice notice-error" role="alert"><span>{t(error)}</span><button className="text-button" onClick={onRefresh} disabled={!online}>{t('common.retry')}</button></div>}
      {loading ? (
        <section className="item-grid" aria-busy="true" aria-label={t('common.loading')}>
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="loading-card"><div className="loading-photo skeleton" /><div className="loading-line skeleton" /></div>)}
        </section>
      ) : items.length ? (
        <>
          <div className="collection-bar"><span>{itemCount(language, items.length)}</span><button type="button" className="text-button" onClick={onRefresh} disabled={!online} aria-label={t('wardrobe.refresh')}><Icon name="refresh" />{t('common.refresh')}</button></div>
          <ul className="item-grid">
            {items.slice(0, visible).map((item) => <li className="item-card" key={item.id}><ItemPhoto item={item} images={images} t={t} /><div className="item-caption"><h2>{item.title}</h2><span>{t(categoryKeys[item.category])}</span></div></li>)}
          </ul>
          {items.length > visible && <div className="load-more"><button type="button" className="button button-secondary" onClick={() => setVisible(visible + 40)}>{t('wardrobe.more')}</button></div>}
        </>
      ) : !error ? (
        <div className="empty-wardrobe">
          <div className="empty-art"><WardrobeIllustration /></div>
          <div className="empty-copy"><p className="eyebrow">{t('wardrobe.everyday')}</p><h2>{t('wardrobe.empty')}</h2><p>{t('wardrobe.emptyBody')}</p><button type="button" className="button button-primary" onClick={onAdd}><Icon name="plus" />{t('wardrobe.firstItem')}</button><p className="privacy-note"><Icon name="lock" />{t('wardrobe.privateNote')}</p></div>
        </div>
      ) : null}
    </section>
  );
}
