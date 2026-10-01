import { useEffect, useState } from 'react';
import { loadItemDetail } from '../../data/item-details';
import { errorKey, isAborted } from '../../data/errors';
import type { ItemDetail as Detail } from '../../domain/item-details';
import type { MessageKey } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import type { BeforeDiscard } from '../../app/dialog';
import type { ItemLifecycleClient } from '../../data/item-lifecycle';
import type { LifecycleSnapshot } from '../../domain/item-lifecycle';
import type { AiClient } from '../../data/ai';
import { LazyBoundary } from '../../app/lazy';
import { lazyNamed } from '../../app/lazy-load';
import type { Shared } from './item-editor';

const Editor = lazyNamed(() => import('./item-editor'), 'Editor');

export function ItemDetail(props: Shared & {
  itemId: string | null; images: PrivateImages; lifecycle: ItemLifecycleClient; onTrashed: (item: LifecycleSnapshot) => void; onBack: () => void;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  ai: AiClient; onBeforeDiscard: (handler: BeforeDiscard | null) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [reload, setReload] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  const { client, scope, itemId, t } = props;
  // The editor's code downloads alongside the item, so it is usually ready when the item is; a failed download shows Reload.
  useEffect(() => { Editor.preload().catch(() => {}); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const current = { ...scope, signal: AbortSignal.any([scope.signal, controller.signal]) };
    setDetail(null); setError(null); setTitle(null);
    if (!itemId) setError('detail.unavailable');
    else void loadItemDetail(client, current, itemId).then((row) => {
      if (!current.signal.aborted) setDetail(row);
    }, (problem: unknown) => {
      if (!current.signal.aborted && !isAborted(problem)) setError(errorKey(problem));
    });
    return () => controller.abort();
  }, [client, scope, itemId, reload]);
  return <section className="detail-page" aria-labelledby="item-detail-title">
    <button className="text-button" onClick={(event) => { event.currentTarget.focus(); props.onBack(); }}>{t('common.back')}</button>
    <header className="settings-heading"><h1 id="item-detail-title" tabIndex={-1}>{title || t('detail.title')}</h1></header>
    {error ? <div className="notice notice-error" role="alert"><p>{t(error)}</p>
      <button className="text-button" disabled={!props.online} onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button></div>
      : detail ? <LazyBoundary t={t}><Editor {...props} detail={detail} onTitle={setTitle} onReload={() => { setDetail(null); setReload(value => value + 1); }} /></LazyBoundary>
        : <p role="status">{t('common.loading')}</p>}
  </section>;
}
