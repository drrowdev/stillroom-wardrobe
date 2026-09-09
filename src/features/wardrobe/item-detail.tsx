import { useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { loadItemDetail, saveImageDescription, saveItemFields } from '../../data/item-details';
import { errorKey, isAborted } from '../../data/errors';
import {
  confirmsDescription, confirmsItem, prepareDescriptionAttempt, prepareGarmentAttempt, validDescription,
  type DescriptionAttempt, type ImageBaseline, type ItemAttempt, type ItemBaseline, type ItemDetail as Detail,
} from '../../domain/item-details';
import { garmentDraftDirty, newGarmentDraft } from '../../domain/garment-fields';
import { ItemForm } from './item-form';
import type { Language, MessageKey, Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { DiscardDialog } from '../../app/dialog';
import { Icon } from '../../app/icon';

type Dirty = { dirty: boolean; busy: boolean };
type Shared = {
  client: AppClient; scope: OwnerScope; online: boolean; t: Translate; language: Language; currency: string; onSaved: () => void;
};
function useSection<Base, Draft, Attempt>(initial: Base, initialDraft: (base: Base) => Draft,
  prepare: (base: Base, draft: Draft, epoch: number) => Attempt,
  save: (client: AppClient, scope: OwnerScope, attempt: Attempt) => Promise<Base>,
  read: (detail: Detail) => Base, confirms: (row: Base, attempt: Attempt) => boolean,
  itemId: string, props: Shared, onState: (state: Dirty) => void, isDirty?: (base: Base, draft: Draft) => boolean) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() => initialDraft(initial));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const latch = useRef(false);
  const lifetime = useRef(new AbortController());
  const summary = useRef<HTMLDivElement>(null);
  const discardFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const dirty = isDirty ? isDirty(base, draft) : JSON.stringify(draft) !== JSON.stringify(initialDraft(base));
  let valid = true;
  try { prepare(base, draft, props.scope.epoch); } catch { valid = false; }
  useEffect(() => {
    onState({ dirty: dirty || attempt !== null, busy });
    return () => onState({ dirty: false, busy: false });
  }, [dirty, attempt, busy, onState]);
  useEffect(() => { if (error) summary.current?.focus(); }, [error, busy]);
  async function run(action: 'save' | 'check' | 'reload') {
    if (latch.current || !props.online || props.scope.signal.aborted
      || action === 'save' && (!valid || attempt !== null) || action === 'check' && !attempt) return;
    const scope = { ...props.scope, signal: AbortSignal.any([props.scope.signal, lifetime.current.signal]) };
    latch.current = true;
    setBusy(true); setSaved(false); setError(null);
    let frozenAttempt = attempt;
    try {
      let row: Base;
      if (action === 'save') {
        frozenAttempt = prepare(base, draft, scope.epoch);
        setAttempt(frozenAttempt);
        row = await save(props.client, scope, frozenAttempt);
      } else {
        row = read(await loadItemDetail(props.client, scope, itemId));
        if (action === 'check' && frozenAttempt && !confirms(row, frozenAttempt)) {
          if (!scope.signal.aborted) setError('detail.conflicting');
          return;
        }
      }
      if (scope.signal.aborted) return;
      setBase(row); setDraft(initialDraft(row)); setAttempt(null); setError(null);
      setSaved(action !== 'reload');
      props.onSaved();
    } catch (problem) {
      if (!scope.signal.aborted && !isAborted(problem)) setError(errorKey(problem));
    } finally {
      if (!scope.signal.aborted) { latch.current = false; setBusy(false); }
    }
  }
  return {
    base, draft, setDraft: (next: Draft) => { setDraft(next); setSaved(false); }, saved, busy, error, summary,
    locked: busy || attempt !== null, canSave: props.online && valid && !busy && attempt === null,
    save: () => { void run('save'); },
    controls: <>
      {error && <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error">
        <p>{props.t(error)}</p>
        {attempt !== null && <div className="settings-actions">
          {(error === 'detail.unconfirmed' || error === 'detail.conflicting' || error === 'error.unavailable') &&
            <button type="button" className="text-button" disabled={!props.online || busy} onClick={() => { void run('check'); }}>{props.t('detail.check')}</button>}
          <button type="button" className="text-button" disabled={!props.online || busy} onClick={(event) => { discardFocus.current = event.currentTarget; setDiscard(true); }}>{props.t('detail.reload')}</button>
        </div>}
      </div>}
      {discard && <DiscardDialog title={props.t('common.unsaved')} t={props.t} onCancel={() => {
        setDiscard(false);
        requestAnimationFrame(() => { if (discardFocus.current?.isConnected) discardFocus.current.focus(); });
      }}
        onConfirm={() => { setDiscard(false); void run('reload'); }}><p>{props.t('detail.discardSection')}</p></DiscardDialog>}
    </>,
  };
}
const itemDraft = (base: ItemBaseline) => newGarmentDraft(base.values.currency, 'en', base.values);
const descriptionDraft = (base: ImageBaseline) => base.altText;
const prepareFields = (base: ItemBaseline, draft: ReturnType<typeof itemDraft>, epoch: number) => prepareGarmentAttempt(base, draft, epoch);
const dirtyFields = (base: ItemBaseline, draft: ReturnType<typeof itemDraft>) => garmentDraftDirty(draft, base.values, base.provenance);
const readItem = (detail: Detail) => detail.item;
const readImage = (detail: Detail) => detail.image;

function NameSection(props: Shared & { base: ItemBaseline; onState: (state: Dirty) => void }) {
  const section = useSection<ItemBaseline, ReturnType<typeof itemDraft>, ItemAttempt>(
    props.base, itemDraft, prepareFields, saveItemFields, readItem, confirmsItem, props.base.id, props, props.onState, dirtyFields);
  const { t } = props;
  return <section className="settings-card detail-name" aria-labelledby="detail-name-heading">
    <h2 id="detail-name-heading">{t('detail.nameSection')}</h2>
    <p className="muted fine">{t('detail.provenance')}</p>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); section.save(); }}>
      <ItemForm draft={section.draft} onChange={section.setDraft} baseline={section.base.values} provenance={section.base.provenance}
        language={props.language} t={t} prefix="detail" locked={section.locked} currency={props.currency} />
      {section.controls}
      <button className="button button-primary" disabled={!section.canSave}>{t(section.busy ? 'common.saving' : 'detail.saveName')}</button>
      {section.saved && <p role="status" className="settings-success">{t('detail.nameSaved')}</p>}
    </form>
  </section>;
}
function DescriptionSection(props: Shared & { base: ImageBaseline; onState: (state: Dirty) => void; onImage: (image: ImageBaseline) => void }) {
  const section = useSection<ImageBaseline, string, DescriptionAttempt>(
    props.base, descriptionDraft, prepareDescriptionAttempt, saveImageDescription, readImage, confirmsDescription, props.base.itemId, props, props.onState);
  const invalid = validDescription(section.draft) === null;
  const { onImage } = props;
  useEffect(() => { onImage(section.base); }, [section.base, onImage]);
  const { t } = props;
  return <section className="settings-card detail-description" aria-labelledby="detail-description-heading">
    <h2 id="detail-description-heading">{t('detail.descriptionSection')}</h2>
    <p className="muted fine">{t('detail.descriptionHint')}</p>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); section.save(); }}>
      <div className="field"><label htmlFor="detail-description">{t('item.altText')}</label>
        <textarea id="detail-description" value={section.draft} rows={4} disabled={section.locked}
          aria-invalid={invalid} aria-describedby={invalid ? 'detail-description-error' : undefined}
          onChange={(event) => section.setDraft(event.target.value)} />
        {invalid && <p id="detail-description-error" role="alert" className="notice notice-error">{t('detail.invalidDescription')}</p>}
        <button className="text-button" type="button" disabled={section.locked || !section.draft} onClick={() => section.setDraft('')}>{t('detail.clearDescription')}</button>
      </div>
      {section.controls}
      <button className="button button-primary" disabled={!section.canSave}>{t(section.busy ? 'common.saving' : 'detail.saveDescription')}</button>
      {section.saved && <p role="status" className="settings-success">{t('detail.descriptionSaved')}</p>}
    </form>
  </section>;
}
function SavedPhoto({ image, images, t }: { image: ImageBaseline; images: PrivateImages; t: Translate }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(null); setFailed(false);
    void images.get(image.mainPath).then((value) => { if (active) setUrl(value); },
      (problem: unknown) => { if (active && !isAborted(problem)) setFailed(true); });
    return () => { active = false; };
  }, [image.mainPath, images]);
  return <div className="detail-photo">{url ? <img src={url} alt={image.altText} /> :
    <p role="status">{failed ? <><Icon name="photo" />{t('photo.missing')}</> : t('common.loading')}</p>}</div>;
}
function Editor(props: Shared & { detail: Detail; images: PrivateImages; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void }) {
  const [nameState, setNameState] = useState<Dirty>({ dirty: false, busy: false });
  const [descriptionState, setDescriptionState] = useState<Dirty>({ dirty: false, busy: false });
  const [image, setImage] = useState(props.detail.image);
  const { onDirty } = props;
  useEffect(() => {
    onDirty(nameState.dirty || descriptionState.dirty, false, nameState.busy || descriptionState.busy);
    return () => onDirty(false, false, false);
  }, [nameState, descriptionState, onDirty]);
  return <div className="detail-layout">
    <SavedPhoto image={image} images={props.images} t={props.t} />
    <div className="detail-sections">
      <NameSection {...props} base={props.detail.item} onState={setNameState} />
      <DescriptionSection {...props} base={props.detail.image} onState={setDescriptionState} onImage={setImage} />
    </div>
  </div>;
}
export function ItemDetail(props: Shared & {
  itemId: string | null; images: PrivateImages; onBack: () => void;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [reload, setReload] = useState(0);
  const { client, scope, itemId, t } = props;
  useEffect(() => {
    const controller = new AbortController();
    const current = { ...scope, signal: AbortSignal.any([scope.signal, controller.signal]) };
    setDetail(null); setError(null);
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
    <header className="settings-heading"><p className="eyebrow">{t('common.private')}</p><h1 id="item-detail-title" tabIndex={-1}>{t('detail.title')}</h1><p className="muted">{t('settings.intro')}</p></header>
    {error ? <div className="notice notice-error" role="alert"><p>{t(error)}</p>
      <button className="text-button" disabled={!props.online} onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button></div>
      : detail ? <Editor {...props} detail={detail} /> : <p role="status">{t('common.loading')}</p>}
  </section>;
}
