import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { createLook, pendingCreate, setLookRemoved, type CreateReply } from '../../data/wear-events';
import { todayIn } from '../../domain/local-date';
import { hasGap, isEmpty, occasionLabel, type OutfitComponent, type OutfitRecord } from '../../domain/outfits';
import { lookLimits, wearProblems, type LookAttempt, type WearProblem } from '../../domain/wear-events';
import type { MessageKey, Translate } from '../../i18n';
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

export function NewOutfit(props: Shared & { initial?: { itemIds: string[]; occasion: string } }) {
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

export function OutfitDetail(props: Shared & { id: string | null; timeZone: string; onPlan: (id: string) => void; onWorn: () => void; onWriting: (busy: boolean) => void }) {
  const { client, scope, id, online, invalidation, t, images } = props;
  const view = useOutfit(client, scope, id, online, invalidation);
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const [snapshot, setSnapshot] = useState<EditView | null>(null);
  const [wearing, setWearing] = useState(false);
  const { onSaved, onWriting } = props;
  const onWearPending = useCallback((busy: boolean) => { setWearing(busy); onWriting(busy); }, [onWriting]);
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
      : <OutfitSummary record={record} view={view.data} images={images} t={t} editDisabled={wearing} onEdit={() => setEditing(true)}>
        <WearActions client={client} scope={scope} record={record} view={view.data} online={online} t={t} timeZone={props.timeZone}
          onPlan={() => props.onPlan(record.id)} onChanged={props.onWorn} onPending={onWearPending} />
      </OutfitSummary>}
  </section>;
}

// "Wear today" records a worn look straight away; Undo removes that look again. While either is being written the page
// holds navigation, and a create whose reply was lost stays with this owner session until a reread or replay settles it.
function WearActions({ client, scope, record, view, online, t, timeZone, onPlan, onChanged, onPending }: {
  client: AppClient; scope: OwnerScope; record: OutfitRecord; view: OutfitView; online: boolean; t: Translate; timeZone: string;
  onPlan: () => void; onChanged: () => void; onPending: (pending: boolean) => void;
}) {
  const key = `wear-today:${record.id}`;
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ key: MessageKey; look?: { id: string; ownerId: string; version: number } } | null>(null);
  const [problem, setProblem] = useState<WearProblem | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const lifetime = useRef(new AbortController());
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => { onPending(pending); }, [pending, onPending]);
  useEffect(() => () => onPending(false), [onPending]);
  const itemIds = record.links.map(link => link.itemId).filter(id => {
    const state = view.components.get(id)?.state;
    return state === 'current' || state === 'archived';
  });
  function fail(error: unknown) { setPending(false); retry.current = null; if (!isAborted(error)) setProblem(wearProblems.unknown); }
  function settle(attempt: LookAttempt, reply: CreateReply) {
    setPending(false);
    if (reply.kind === 'saved' || reply.kind === 'exists') {
      setProblem(null); retry.current = null; onChanged();
      // A look that has changed since it was stored (for example on another device) is left as it is, without Undo.
      setDone(reply.kind === 'saved' ? { key: 'calendar.markedWornDone', look: { id: attempt.id, ownerId: attempt.ownerId, version: reply.version } }
        : { key: 'calendar.alreadySaved' });
      if (reply.kind === 'saved') requestAnimationFrame(() => undoButton.current?.focus());
      return;
    }
    const open = reply.kind === 'notSaved' || reply.kind === 'unknown';
    retry.current = open ? () => run(null, true, lifetime.current.signal) : null;
    setProblem(open ? { key: wearProblems[reply.kind].key, action: 'retry' } : wearProblems[reply.kind]);
  }
  // Wear today, Retry and coming back all go through the shared create store: a kept attempt is read back by its ID first.
  function run(fresh: LookAttempt | null, resend: boolean, signal: AbortSignal) {
    setPending(true); setProblem(null); if (fresh) setDone(null);
    createLook(client, scope, key, fresh, resend, signal).then(result => {
      if (signal.aborted) return;
      if (result) settle(result.attempt, result.reply); else setPending(false);
    }, (error: unknown) => { if (!signal.aborted) fail(error); });
  }
  function wear() {
    run({ id: crypto.randomUUID(), localDate: todayIn(timeZone), timezone: timeZone, state: 'worn', label: [...record.title].slice(0, lookLimits.label).join(''),
      outfitId: record.id, itemIds, baselineVersion: null, ownerId: scope.ownerId, epoch: scope.epoch }, true, lifetime.current.signal);
  }
  // Coming back to an outfit whose last Wear today was never confirmed reads that look before offering anything else.
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (pendingCreate(scope, key)) run(null, false, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mounted outfit and owner session
  }, [client, scope, key]);  function undo(look: { id: string; ownerId: string; version: number }) {
    setPending(true); setProblem(null);
    setLookRemoved(client, scope, look, true, scope.epoch, lifetime.current.signal).then(reply => {
      setPending(false);
      if (reply.kind === 'saved') { setProblem(null); retry.current = null; onChanged(); setDone({ key: 'calendar.undone' }); return; }
      retry.current = reply.kind === 'notSaved' ? () => undo(look) : null;
      setProblem(wearProblems[reply.kind]);
    }, fail);
  }
  return <>
    <button type="button" className="button button-primary" disabled={!online || pending || !itemIds.length} aria-describedby={itemIds.length ? undefined : 'wear-unavailable'} onClick={wear}>{t('calendar.wearToday')}</button>
    <button type="button" className="button button-secondary" disabled={pending || !itemIds.length} onClick={onPlan}>{t('calendar.plan')}</button>
    {!itemIds.length && <p id="wear-unavailable" className="muted">{t('calendar.noUsableItems')}</p>}
    {pending && <p className="muted" role="status">{t('common.saving')}</p>}
    {done && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t(done.key)}</span>
      {done.look && <button ref={undoButton} type="button" className="text-button" disabled={!online || pending} onClick={() => undo(done.look!)}>{t('common.undo')}</button>}
      <button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setDone(null)}><Icon name="close" /></button></div>}
    {problem && <div className="notice notice-error" role="alert"><span>{t(problem.key)}</span>
      {problem.action === 'retry' && <button type="button" className="text-button" disabled={!online || pending} onClick={() => retry.current?.()}>{t('common.retry')}</button>}</div>}
  </>;
}
function OutfitSummary({ record, view, images, t, editDisabled, onEdit, children }: { record: OutfitRecord; view: OutfitView; images: PrivateImages; t: Translate; editDisabled: boolean; onEdit: () => void; children: ReactNode }) {
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
    <div className="outfit-actions"><button type="button" className="button button-secondary" disabled={editDisabled} onClick={onEdit}>{t('outfits.edit')}</button>{children}</div>
  </div>;
}
