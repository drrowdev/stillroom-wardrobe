import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { hasGap, isEmpty, occasionLabel, type OutfitComponent, type OutfitRecord } from '../../domain/outfits';
import type { Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { OutfitEditor } from './editor';
import { ComponentText, OutfitThumb } from './outfits-screen';
import { useOutfit, usePickerItems, type OutfitView } from './use-outfits';

type Shared = {
  client: AppClient; scope: OwnerScope; images: PrivateImages; online: boolean; t: Translate; invalidation: number; paused: boolean;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onOutfitUnresolved: (unresolved: boolean) => void;
  onSaved: (id: string) => void;
  onOpen: (id: string) => void;
  onBack: () => void;
};

const noComponents = new Map<string, OutfitComponent>();

export function NewOutfit(props: Shared) {
  const picker = usePickerItems(props.client, props.scope, props.online, props.invalidation);
  const { t } = props;
  return <section className="detail-page outfit-page" aria-labelledby="outfit-editor-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); props.onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="outfit-editor-title" tabIndex={-1}>{t('outfits.newTitle')}</h1></header>
    <OutfitEditor {...props} record={null} components={noComponents} picker={picker} removed={false} onReload={() => undefined} onGone={props.onBack} />
  </section>;
}

type EditView = OutfitView & { record: OutfitRecord };
function EditPane(props: Shared & { view: EditView; removed: boolean; onReload: () => void; onSavedHere: (id: string) => void }) {
  const picker = usePickerItems(props.client, props.scope, props.online, props.invalidation);
  useEffect(() => { requestAnimationFrame(() => document.getElementById('outfit-name')?.focus()); }, []);
  return <OutfitEditor {...props} record={props.view.record} components={props.view.components} picker={picker}
    onSaved={props.onSavedHere} onReload={props.onReload} onGone={props.onBack} />;
}

export function OutfitDetail(props: Shared & { id: string | null }) {
  const { client, scope, id, online, invalidation, t, images } = props;
  const view = useOutfit(client, scope, id, online, invalidation);
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const [snapshot, setSnapshot] = useState<EditView | null>(null);
  const { onSaved } = props;
  const savedHere = useCallback((saved: string) => {
    setEditing(false); setSnapshot(null);
    onSaved(saved);
    requestAnimationFrame(() => document.getElementById('outfit-detail-title')?.focus());
  }, [onSaved]);
  const record = view.data?.record ?? null;
  const live = useMemo(() => view.data && record ? { ...view.data, record } : null, [view.data, record]);
  // An open editor keeps its last loaded outfit if a refresh finds it removed, so the draft and any pending save stay put.
  useEffect(() => { if (editing && live) setSnapshot(live); }, [editing, live]);
  const editView = editing ? live ?? snapshot : null;
  const unavailable = id === null || view.data !== null && record === null;
  return <section className="detail-page outfit-page" aria-labelledby="outfit-detail-title">
    <button type="button" className="text-button" onClick={(event) => { event.currentTarget.focus(); props.onBack(); }}>{t('outfits.back')}</button>
    <header className="settings-heading"><h1 id="outfit-detail-title" tabIndex={-1}>{(editView?.record ?? record)?.title ?? t('nav.outfits')}</h1></header>
    {editView ? <EditPane key={editKey} {...props} view={editView} removed={unavailable} onSavedHere={savedHere}
        onReload={() => { setEditKey(value => value + 1); view.reload(); }} />
      : unavailable ? <div className="notice notice-error" role="alert"><span>{t('outfits.unavailable')}</span></div>
      : !record || !view.data ? view.error
        ? <div className="notice notice-error" role="alert"><span>{t(view.error)}</span><button type="button" className="text-button" disabled={!online} onClick={view.reload}>{t('common.retry')}</button></div>
        : <p role="status">{t('common.loading')}</p>
      : <OutfitSummary record={record} view={view.data} images={images} t={t} onEdit={() => setEditing(true)} />}
  </section>;
}

function OutfitSummary({ record, view, images, t, onEdit }: { record: OutfitRecord; view: OutfitView; images: PrivateImages; t: Translate; onEdit: () => void }) {
  const occasion = occasionLabel(record);
  const notes = record.notes.trim();
  return <div className="outfit-view stack">
    {hasGap(record) && <p className="notice">{t('outfits.itemsDeleted')}</p>}
    {isEmpty(record) ? <p>{t('outfits.noItemsLeft')}</p>
      : <ul className="outfit-composition" aria-label={t('outfits.composition', { name: record.title })}>
        {record.links.map(link => {
          const component = view.components.get(link.itemId);
          return component ? <li key={link.itemId} className="outfit-component">
            <OutfitThumb component={component} images={images} t={t} /><ComponentText component={component} t={t} />
          </li> : null;
        })}
      </ul>}
    {(occasion || record.occasion || notes || record.favourite) && <dl className="outfit-facts">
      {(occasion || record.occasion) && <><dt>{t('outfits.occasion')}</dt><dd>{occasion ? t(occasion) : record.occasion}</dd></>}
      {notes && <><dt>{t('item.notes')}</dt><dd className="outfit-notes">{record.notes}</dd></>}
      {record.favourite && <><dt className="sr-only">{t('item.favourite')}</dt><dd><Icon name="check" />{t('item.favourite')}</dd></>}
    </dl>}
    <div className="outfit-actions"><button type="button" className="button button-secondary" onClick={onEdit}>{t('outfits.edit')}</button></div>
  </div>;
}
