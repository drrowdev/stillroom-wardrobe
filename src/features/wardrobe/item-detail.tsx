import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { loadItemDetail, saveImageDescription, saveItemFields } from '../../data/item-details';
import { errorKey, isAborted } from '../../data/errors';
import {
  confirmsDescription, confirmsItem, prepareDescriptionAttempt, prepareGarmentAttempt, validDescription,
  type DescriptionAttempt, type ImageBaseline, type ItemAttempt, type ItemBaseline, type ItemDetail as Detail,
} from '../../domain/item-details';
import { editGarmentField, garmentDraftDirty, newGarmentDraft, sameValue } from '../../domain/garment-fields';
import { ItemForm } from './item-form';
import type { Language, MessageKey, Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { DiscardDialog, type BeforeDiscard } from '../../app/dialog';
import { Icon } from '../../app/icon';
import type { ItemLifecycleClient } from '../../data/item-lifecycle';
import type { LifecycleSnapshot } from '../../domain/item-lifecycle';
import { TrashAction } from '../settings/trash';
import type { AiClient } from '../../data/ai';
import { ReplacePhoto } from './replace-photo';

type Outcome = 'confirmed' | 'rejected' | 'unknown' | 'skipped';
type Shared = {
  client: AppClient; scope: OwnerScope; online: boolean; t: Translate; language: Language; currency: string; onSaved: () => void;
};
function useSection<Base, Draft, Attempt>(initial: Base, initialDraft: (base: Base) => Draft,
  prepare: (base: Base, draft: Draft, epoch: number) => Attempt,
  save: (client: AppClient, scope: OwnerScope, attempt: Attempt) => Promise<Base>,
  read: (detail: Detail) => Base, confirms: (row: Base, attempt: Attempt) => boolean,
  itemId: string, props: Shared, onChecked: () => void, isDirty?: (base: Base, draft: Draft) => boolean) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() => initialDraft(initial));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
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
  useEffect(() => { if (error) summary.current?.focus(); }, [error, busy]);
  // 'unknown' keeps the attempt frozen: only a read-only check or discard follows, never a resend.
  async function run(action: 'save' | 'check' | 'reload', nextDraft?: Draft): Promise<Outcome> {
    if (latch.current || !props.online || props.scope.signal.aborted
      || action === 'save' && attempt !== null || action === 'check' && !attempt) return 'skipped';
    const sending = nextDraft ?? draft;
    let frozenAttempt = attempt;
    if (action === 'save') {
      try { frozenAttempt = prepare(base, sending, props.scope.epoch); } catch { return 'skipped'; }
    }
    const scope = { ...props.scope, signal: AbortSignal.any([props.scope.signal, lifetime.current.signal]) };
    latch.current = true;
    setBusy(true); setError(null);
    try {
      let row: Base;
      if (action === 'save' && frozenAttempt) {
        if (nextDraft !== undefined) setDraft(nextDraft);
        setAttempt(frozenAttempt);
        row = await save(props.client, scope, frozenAttempt);
      } else {
        row = read(await loadItemDetail(props.client, scope, itemId));
        if (action === 'check' && frozenAttempt && !confirms(row, frozenAttempt)) {
          if (!scope.signal.aborted) setError('detail.conflicting');
          return 'rejected';
        }
      }
      if (scope.signal.aborted) return 'skipped';
      setBase(row); setDraft(initialDraft(row)); setAttempt(null); setError(null);
      if (action !== 'reload') props.onSaved();
      return action === 'reload' ? 'skipped' : 'confirmed';
    } catch (problem) {
      if (scope.signal.aborted || isAborted(problem)) return 'skipped';
      const key = errorKey(problem);
      setError(key);
      return key === 'detail.unconfirmed' || key === 'error.unavailable' ? 'unknown' : 'rejected';
    } finally {
      if (!scope.signal.aborted) { latch.current = false; setBusy(false); }
    }
  }
  return {
    base, draft, setDraft, dirty, busy, error, valid, attempt, run,
    locked: busy || attempt !== null,
    controls: <>
      {error && <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error">
        <p>{props.t(error)}</p>
        {attempt !== null && <div className="settings-actions">
          {(error === 'detail.unconfirmed' || error === 'detail.conflicting' || error === 'error.unavailable') &&
            <button type="button" className="text-button" disabled={!props.online || busy} onClick={() => { void run('check').then((outcome) => { if (outcome === 'confirmed') onChecked(); }); }}>{props.t('detail.check')}</button>}
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
const lifecycleLabels: Record<string, MessageKey> = { donated: 'lifecycle.donated', sold: 'lifecycle.sold' };
function focusFirstInvalid(form: HTMLFormElement | null) {
  const input = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  for (let ancestor = input?.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  }
  requestAnimationFrame(() => input?.focus());
}
function SavedPhoto({ image, images, t }: { image: ImageBaseline; images: PrivateImages; t: Translate }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(null); setFailed(false);
    const unsubscribe = images.subscribe(paths => { if (paths.includes(image.mainPath)) { active = false; setUrl(null); setFailed(true); } });
    void images.get(image.mainPath).then((value) => { if (active) setUrl(value); },
      (problem: unknown) => { if (active && !isAborted(problem)) setFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, [image.mainPath, images]);
  return <div className="detail-photo">{url ? <img src={url} alt={image.altText} /> :
    <p role="status">{failed ? <><Icon name="photo" />{t('photo.missing')}</> : t('common.loading')}</p>}</div>;
}
function Editor(props: Shared & { detail: Detail; images: PrivateImages; lifecycle: ItemLifecycleClient; onTrashed: (item: LifecycleSnapshot) => void; onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  ai: AiClient; onBeforeDiscard: (handler: BeforeDiscard | null) => void; onReload: () => void; onTitle: (title: string) => void }) {
  const [outcome, setOutcome] = useState<'saved' | 'partial' | null>(null);
  // A confirmed read-only check reports "Saved" only when the other section has nothing unsaved or outstanding.
  const outstanding = useRef({ item: false, description: false });
  const itemChecked = useCallback(() => { if (!outstanding.current.description) setOutcome('saved'); }, []);
  const descriptionChecked = useCallback(() => { if (!outstanding.current.item) setOutcome('saved'); }, []);
  const item = useSection<ItemBaseline, ReturnType<typeof itemDraft>, ItemAttempt>(
    props.detail.item, itemDraft, prepareFields, saveItemFields, readItem, confirmsItem, props.detail.item.id, props, itemChecked, dirtyFields);
  const description = useSection<ImageBaseline, string, DescriptionAttempt>(
    props.detail.image, descriptionDraft, prepareDescriptionAttempt, saveImageDescription, readImage, confirmsDescription, props.detail.item.id, props, descriptionChecked);
  const [lifecycleState, setLifecycleState] = useState({ busy: false, pending: false });
  const [mode, setMode] = useState<'replacement' | 'recovery' | null>(null);
  const [photoState, setPhotoState] = useState({ dirty: false, incomplete: false, busy: false });
  const [saving, setSaving] = useState(false);
  const saveLatch = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const onPhotoState = useCallback((dirty: boolean, incomplete: boolean, busy: boolean) => setPhotoState({ dirty, incomplete, busy }), []);
  const onLifecycleState = useCallback((busy: boolean, pending: boolean) => setLifecycleState({ busy, pending }), []);
  const { onDirty, onTitle, t } = props;
  const sectionsDirty = item.dirty || description.dirty || item.attempt !== null || description.attempt !== null;
  const sectionsBusy = item.busy || description.busy || saving;
  const itemOutstanding = item.dirty || item.attempt !== null, descriptionOutstanding = description.dirty || description.attempt !== null;
  useEffect(() => { outstanding.current = { item: itemOutstanding, description: descriptionOutstanding }; }, [itemOutstanding, descriptionOutstanding]);
  useEffect(() => {
    onDirty(sectionsDirty || lifecycleState.pending || photoState.dirty,
      photoState.incomplete, sectionsBusy || lifecycleState.busy || photoState.busy);
    return () => onDirty(false, false, false);
  }, [sectionsDirty, sectionsBusy, lifecycleState, photoState, onDirty]);
  useEffect(() => { onTitle(item.base.title); }, [item.base.title, onTitle]);
  const blocked = sectionsDirty || sectionsBusy || lifecycleState.busy || lifecycleState.pending;
  const quickReady = props.online && !blocked;
  const formattingOnly = !item.dirty && !item.locked && !item.error
    && !sameValue(item.draft.raw, itemDraft(item.base).raw);
  const invalidDescription = validDescription(description.draft) === null;
  const canSave = props.online && !sectionsBusy && item.attempt === null && description.attempt === null && (item.dirty || description.dirty);
  // One Save: the item goes first; the description is sent only after the item is confirmed. Nothing is ever resent.
  async function saveAll() {
    if (saveLatch.current || !canSave) return;
    const itemDirty = item.dirty, descriptionDirty = description.dirty;
    if (itemDirty && !item.valid || descriptionDirty && !description.valid) { focusFirstInvalid(form.current); return; }
    const text = description.draft;
    saveLatch.current = true; setSaving(true); setOutcome(null);
    try {
      if (itemDirty && await item.run('save') !== 'confirmed') return;
      if (descriptionDirty && await description.run('save', text) !== 'confirmed') {
        if (itemDirty) setOutcome('partial');
        return;
      }
      setOutcome('saved');
    } finally { saveLatch.current = false; setSaving(false); }
  }
  async function quick(field: 'lifecycle', value: string) {
    if (!quickReady || saveLatch.current) return;
    saveLatch.current = true; setOutcome(null);
    try { if (await item.run('save', editGarmentField(item.draft, field, value, props.language)) === 'confirmed') setOutcome('saved'); }
    finally { saveLatch.current = false; }
  }
  if (mode) return <ReplacePhoto {...props} item={item.base} image={description.base} mode={mode} onDirty={onPhotoState}
    onClose={() => { setMode(null); props.onReload(); }} />;
  const lifecycle = item.draft.raw.lifecycle;
  return <div className="detail-layout">
    <div className="detail-media">
      <SavedPhoto image={description.base} images={props.images} t={t} />
      <div className="photo-actions">
        <button className="button button-secondary" disabled={blocked || !props.online} onClick={() => { if (!blocked) setMode('replacement'); }}>{t('imageChange.replace')}</button>
        <button className="text-button" disabled={blocked || !props.online} onClick={() => { if (!blocked) setMode('recovery'); }}>{t('imageChange.recover')}</button>
      </div>
    </div>
    <div className="detail-sections">
      <fieldset className="lifecycle-edit-lock" disabled={lifecycleState.busy || lifecycleState.pending}>
        <section className="settings-card detail-name" aria-label={t('capture.detailsTitle')}>
          <form ref={form} className="stack" onSubmit={(event) => { event.preventDefault(); void saveAll(); }}>
            <ItemForm draft={item.draft} onChange={(next) => { item.setDraft(next); setOutcome(null); }} baseline={item.base.values} provenance={item.base.provenance}
              language={props.language} t={t} prefix="detail" locked={item.locked || saving} currency={props.currency}>
              <div className="field"><label htmlFor="detail-description">{t('item.altText')}</label>
                <textarea id="detail-description" value={description.draft} rows={3} disabled={description.locked || saving}
                  aria-invalid={invalidDescription} aria-describedby={invalidDescription ? 'detail-description-error' : undefined}
                  onChange={(event) => { description.setDraft(event.target.value); setOutcome(null); }} />
                {invalidDescription && <p id="detail-description-error" role="alert" className="notice notice-error">{t('detail.invalidDescription')}</p>}
              </div>
            </ItemForm>
            {item.controls}
            {outcome === 'partial' && <p role="alert" className="notice notice-error">{t('detail.descriptionFailed')}</p>}
            {description.controls}
            <button className="button button-primary" disabled={!canSave}>{t(sectionsBusy ? 'common.saving' : 'detail.saveChanges')}</button>
            {formattingOnly && <p role="status" className="notice">{t('detail.noChanges')}</p>}
            {outcome === 'saved' && !sectionsDirty && <p role="status" className="settings-success">{t('detail.saved')}</p>}
          </form>
        </section>
      </fieldset>
      <div className="detail-item-actions">
        <div className="detail-archive">
          {lifecycle === 'active'
            ? <button type="button" className="button button-secondary" disabled={!quickReady} onClick={() => { void quick('lifecycle', 'archived'); }}>{t('detail.archive')}</button>
            : <><p>{t(lifecycleLabels[lifecycle] ?? 'detail.archived')}</p>
              <button type="button" className="button button-secondary" disabled={!quickReady} onClick={() => { void quick('lifecycle', 'active'); }}>{t('detail.unarchive')}</button></>}
        </div>
        <TrashAction {...props} item={item.base} image={description.base} onState={onLifecycleState} blocked={sectionsDirty || sectionsBusy} />
      </div>
    </div>
  </div>;
}
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
      : detail ? <Editor {...props} detail={detail} onTitle={setTitle} onReload={() => { setDetail(null); setReload(value => value + 1); }} /> : <p role="status">{t('common.loading')}</p>}
  </section>;
}
