import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { rereadSave, saveOutfit } from '../../data/outfits';
import {
  draftFromRecord, emptyDraft, isOccasion, moveDown, moveUp, occasionKeys, occasions, remove, sameDraft, toggle, validateDraft,
  type OutfitComponent, type OutfitDraft, type OutfitRecord, type SaveAttempt,
} from '../../domain/outfits';
import type { WardrobeItem } from '../../domain/wardrobe';
import type { MessageKey, Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { ComponentText, OutfitThumb } from './outfits-screen';
import { pickerComponent, useDraftComponents } from './use-outfits';

export function OutfitLeaveDialog({ unresolved, onStay, onLeave, t }: { unresolved: boolean; onStay: () => void; onLeave: () => void; t: Translate }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog outfit-leave" aria-labelledby="outfit-leave-title" onCancel={(event) => { event.preventDefault(); onStay(); }}>
    <h2 id="outfit-leave-title">{t('outfits.leaveTitle')}</h2>
    <div className="muted"><p>{t(unresolved ? 'outfits.leaveUnresolved' : 'outfits.discardBody')}</p></div>
    <div className="dialog-actions">
      <button className="button button-primary" type="button" autoFocus onClick={onStay}>{t('common.continueEditing')}</button>
      <button className="button button-danger" type="button" onClick={onLeave}>{t('outfits.leave')}</button>
    </div>
  </dialog>;
}

type Phase = 'idle' | 'saving' | 'waiting' | 'rereading' | 'stillSaving' | 'notSaved' | 'rejected' | 'changed' | 'gone' | 'invalidSelection';
const locked: readonly Phase[] = ['saving', 'waiting', 'rereading', 'stillSaving', 'changed', 'gone'];
const unresolvedPhases: readonly Phase[] = ['waiting', 'rereading', 'stillSaving'];
const outcomeKeys: Partial<Record<Phase, MessageKey>> = {
  stillSaving: 'outfits.stillSaving', notSaved: 'outfits.notSaved', rejected: 'outfits.notSavedError',
  changed: 'outfits.changed', gone: 'outfits.unavailable', invalidSelection: 'outfits.invalidSelection',
};

function focusFirstInvalid(form: HTMLFormElement | null) {
  const input = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  for (let ancestor = input?.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  }
  requestAnimationFrame(() => input?.focus());
}

export type EditorProps = {
  client: AppClient; scope: OwnerScope; images: PrivateImages; online: boolean; t: Translate;
  record: OutfitRecord | null; components: ReadonlyMap<string, OutfitComponent>;
  picker: { data: WardrobeItem[] | null; error: MessageKey | null; reload: () => void };
  invalidation: number;
  removed: boolean;
  paused: boolean;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onOutfitUnresolved: (unresolved: boolean) => void;
  onSaved: (id: string) => void;
  onOpen: (id: string) => void;
  onReload: () => void;
  onGone: () => void;
};

export function OutfitEditor(props: EditorProps) {
  const { client, scope, images, online, t, record, paused, removed, onDirty, onOutfitUnresolved } = props;
  const [createId] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => {
    const baseline = record ? draftFromRecord(record) : emptyDraft();
    return { baseline, version: record?.version ?? null, draft: baseline };
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [submitted, setSubmitted] = useState(false);
  const [limited, setLimited] = useState(false);
  const [moved, setMoved] = useState('');
  const [query, setQuery] = useState('');
  const attempt = useRef<SaveAttempt | null>(null);
  const latch = useRef(false);
  const formElement = useRef<HTMLFormElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const signal = () => lifetime.current?.signal ?? AbortSignal.abort();
  const draft = form.draft;
  const unresolved = unresolvedPhases.includes(phase);
  const dirty = !sameDraft(draft, form.baseline) || unresolved;
  const busy = phase === 'saving' || phase === 'rereading';
  const isLocked = locked.includes(phase);

  // A clean, idle editor follows the saved composition, including same-version link removals after a permanent
  // garment delete; a dirty or pending draft keeps its baseline.
  useEffect(() => {
    if (!record || phase !== 'idle' || attempt.current) return;
    setForm(current => {
      if (current.version === null || record.version < current.version || !sameDraft(current.draft, current.baseline)) return current;
      const next = draftFromRecord(record);
      if (record.version === current.version && sameDraft(next, current.baseline)) return current;
      return { baseline: next, version: record.version, draft: next };
    });
  }, [record, phase]);
  useEffect(() => { onDirty(dirty, false, busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => { onDirty(false, false, false); onOutfitUnresolved(false); }, [onDirty, onOutfitUnresolved]);
  // A removed outfit locks the kept draft; an in-flight or unresolved save settles through its own reread first.
  useEffect(() => { if (removed && !locked.includes(phase)) setPhase('gone'); }, [removed, phase]);

  const selected = useDraftComponents(client, scope, draft.itemIds, online, props.invalidation);
  // Selected garments keep current labels even after they leave the active-only picker.
  const components = useMemo(() => {
    const map = new Map(props.components);
    for (const item of props.picker.data ?? []) map.set(item.id, pickerComponent(item));
    for (const [id, component] of selected.data ?? []) map.set(id, component);
    return map;
  }, [props.components, props.picker.data, selected.data]);
  const errors = submitted ? (() => { const result = validateDraft(draft, components); return 'errors' in result ? result.errors : {}; })() : {};

  function change(next: Partial<OutfitDraft>) {
    if (isLocked) return;
    setForm(current => ({ ...current, draft: { ...current.draft, ...next } }));
    if (phase !== 'idle') setPhase('idle');
  }
  function finish(id: string) {
    onOutfitUnresolved(false);
    setPhase('idle');
    props.onSaved(id);
  }
  async function send(frozen: SaveAttempt) {
    if (latch.current || !online) return;
    latch.current = true; setPhase('saving');
    try {
      const reply = await saveOutfit(client, scope, frozen, signal());
      if (reply.kind === 'saved') finish(frozen.id);
      else if (reply.kind === 'unknown') { onOutfitUnresolved(true); setPhase('waiting'); }
      else setPhase(reply.kind);
    } catch (problem) {
      if (!isAborted(problem)) { onOutfitUnresolved(true); setPhase('waiting'); }
    } finally { latch.current = false; }
  }
  async function reread() {
    const frozen = attempt.current;
    if (!frozen || latch.current || !online) return;
    latch.current = true; setPhase('rereading');
    try {
      const { outcome } = await rereadSave(client, scope, frozen, signal());
      if (outcome === 'saved') { finish(frozen.id); return; }
      onOutfitUnresolved(false);
      setPhase(outcome);
    } catch (problem) {
      if (!isAborted(problem)) setPhase('stillSaving');
    } finally { latch.current = false; }
  }
  const rereadLater = useRef(reread);
  useEffect(() => { rereadLater.current = reread; });
  // One read-only reread about a second after an unknown result, once online and not behind the leave dialog.
  useEffect(() => {
    if (phase !== 'waiting' || !online || paused) return;
    const timer = setTimeout(() => { void rereadLater.current(); }, 1000);
    return () => clearTimeout(timer);
  }, [phase, online, paused]);

  function save() {
    if (latch.current || !online || isLocked) return;
    setSubmitted(true);
    const result = validateDraft(draft, components);
    if ('errors' in result) {
      if (result.errors.title || result.errors.notes) requestAnimationFrame(() => focusFirstInvalid(formElement.current));
      else requestAnimationFrame(() => document.getElementById('outfit-slots-title')?.focus());
      return;
    }
    const frozen: SaveAttempt = {
      kind: record ? 'edit' : 'create', id: record?.id ?? createId, payload: result.payload,
      baselineVersion: record ? form.version : null, ownerId: scope.ownerId, epoch: scope.epoch,
    };
    attempt.current = frozen;
    void send(frozen);
  }
  function retry() {
    if (phase === 'stillSaving') void reread();
    else if (attempt.current) void send(attempt.current);
  }
  function reload() {
    const frozen = attempt.current;
    if (frozen?.kind === 'create') props.onOpen(frozen.id);
    else props.onReload();
  }

  function pick(id: string) {
    if (isLocked) return;
    const next = toggle(draft.itemIds, id);
    setLimited(next.limited);
    if (!next.limited) change({ itemIds: next.ids });
  }
  function move(index: number, direction: 'up' | 'down') {
    const id = draft.itemIds[index];
    if (!id || isLocked) return;
    const ids = direction === 'up' ? moveUp(draft.itemIds, index) : moveDown(draft.itemIds, index);
    change({ itemIds: ids });
    const component = components.get(id);
    setMoved(t('outfits.moved', { name: component?.title ?? t('outfits.unavailableItem'), position: ids.indexOf(id) + 1 }));
    requestAnimationFrame(() => {
      const button = document.getElementById(`outfit-${direction}-${id}`);
      if (button instanceof HTMLButtonElement && button.disabled) document.getElementById(`outfit-${direction === 'up' ? 'down' : 'up'}-${id}`)?.focus();
    });
  }
  function drop(index: number) {
    const id = draft.itemIds[index];
    if (!id || isLocked) return;
    const ids = remove(draft.itemIds, id);
    change({ itemIds: ids });
    setLimited(false);
    const neighbour = ids[index] ?? ids[index - 1];
    requestAnimationFrame(() => (neighbour ? document.getElementById(`outfit-remove-${neighbour}`) : document.getElementById('outfit-slots-title'))?.focus());
  }

  const needle = query.trim().toLocaleLowerCase();
  const choices = (props.picker.data ?? []).filter(item => !needle || item.title.toLocaleLowerCase().includes(needle));
  const outcome = outcomeKeys[phase];
  const nameLabel = (component: OutfitComponent | undefined) => component?.title ?? t('outfits.unavailableItem');
  return <form ref={formElement} className="outfit-editor stack" aria-busy={busy} noValidate onSubmit={(event) => { event.preventDefault(); save(); }}>
    <fieldset className="outfit-editor-fields" disabled={isLocked}>
      <div className="field"><label htmlFor="outfit-name">{t('outfits.name')}</label>
        <input id="outfit-name" value={draft.title} autoComplete="off" onChange={(event) => change({ title: event.target.value })}
          aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'outfit-name-error' : undefined} />
        {errors.title && <p id="outfit-name-error" className="field-error" role="alert">{t(errors.title)}</p>}
      </div>
      <section className="outfit-slots" aria-labelledby="outfit-slots-title">
        <h2 id="outfit-slots-title" tabIndex={-1}>{t('outfits.inOutfit')}</h2>
        {draft.itemIds.length > 0 && <ol className="outfit-slot-list">
          {draft.itemIds.map((id, index) => {
            const component = components.get(id);
            const name = nameLabel(component);
            return <li key={id} className="outfit-slot">
              {component ? <OutfitThumb component={component} images={images} t={t} decorative /> : <div className="outfit-thumb" />}
              {component ? <ComponentText component={component} t={t} /> : <span className="outfit-component-text"><span className="outfit-component-state">{t('outfits.unavailableItem')}</span></span>}
              <div className="outfit-slot-actions">
                <button type="button" id={`outfit-up-${id}`} className="icon-button" aria-label={t('a11y.moveUp', { name })} disabled={index === 0} onClick={() => move(index, 'up')}><Icon name="chevron" className="icon-up" /></button>
                <button type="button" id={`outfit-down-${id}`} className="icon-button" aria-label={t('a11y.moveDown', { name })} disabled={index === draft.itemIds.length - 1} onClick={() => move(index, 'down')}><Icon name="chevron" /></button>
                <button type="button" id={`outfit-remove-${id}`} className="icon-button" aria-label={t('a11y.removeItem', { name })} onClick={() => drop(index)}><Icon name="close" /></button>
              </div>
            </li>;
          })}
        </ol>}
        <p className="sr-only" role="status">{moved}</p>
        {limited && <p className="notice notice-error" role="alert">{t('outfits.limit')}</p>}
        {errors.items && <p id="outfit-items-error" className="field-error" role="alert">{t(errors.items)}</p>}
      </section>
      <section className="outfit-picker" aria-labelledby="outfit-picker-title">
        <h2 id="outfit-picker-title">{t('outfits.selectItems')}</h2>
        {props.picker.error && <div className="notice notice-error" role="alert"><span>{t(props.picker.error)}</span>
          <button type="button" className="text-button" disabled={!online} onClick={props.picker.reload}>{t('common.retry')}</button></div>}
        {!props.picker.data ? !props.picker.error && <p role="status">{t('common.loading')}</p> : <>
          <div className="wardrobe-tools"><label htmlFor="outfit-search">{t('common.search')}<input id="outfit-search" type="search" maxLength={512}
            placeholder={t('wardrobe.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
          {choices.length ? <ul className="outfit-choices">
            {choices.map(item => {
              const selected = draft.itemIds.includes(item.id);
              return <li key={item.id}><button type="button" className={`outfit-choice${selected ? ' selected' : ''}`} aria-pressed={selected}
                aria-label={t('a11y.selectItem', { name: item.title })} onClick={() => pick(item.id)}>
                <OutfitThumb component={pickerComponent(item)} images={images} t={t} decorative />
                <span className="outfit-choice-name">{item.title}</span>
                {selected && <Icon name="check" className="outfit-choice-check" />}
              </button></li>;
            })}
          </ul> : <p>{t('wardrobe.noMatches')}</p>}
        </>}
      </section>
      <details className="optional-details">
        <summary>{t('item.moreDetails')}</summary>
        <div className="stack">
          <div className="field"><label htmlFor="outfit-occasion">{t('outfits.occasion')}</label>
            <select id="outfit-occasion" value={draft.occasion} onChange={(event) => change({ occasion: event.target.value })}>
              {occasions.map(code => <option key={code} value={code}>{t(occasionKeys[code])}</option>)}
              {!isOccasion(draft.occasion) && <option value={draft.occasion}>{draft.occasion}</option>}
            </select></div>
          <div className="field"><label htmlFor="outfit-notes">{t('item.notes')}</label>
            <textarea id="outfit-notes" rows={3} value={draft.notes} onChange={(event) => change({ notes: event.target.value })}
              aria-invalid={Boolean(errors.notes)} aria-describedby={errors.notes ? 'outfit-notes-error' : undefined} />
            {errors.notes && <p id="outfit-notes-error" className="field-error" role="alert">{t(errors.notes)}</p>}
          </div>
          <div className="field"><label className="check"><input type="checkbox" id="outfit-favourite" checked={draft.favourite}
            onChange={(event) => change({ favourite: event.target.checked })} />{t('item.favourite')}</label></div>
        </div>
      </details>
    </fieldset>
    {outcome && <div className={`notice ${phase === 'stillSaving' ? '' : 'notice-error'}`} role="alert"><span>{t(outcome)}</span>
      {(phase === 'stillSaving' || phase === 'notSaved' || phase === 'rejected') && <button type="button" className="text-button" disabled={!online} onClick={retry}>{t('common.retry')}</button>}
      {phase === 'changed' && <button type="button" className="text-button" onClick={reload}>{t('outfits.reload')}</button>}
      {phase === 'gone' && <button type="button" className="text-button" onClick={props.onGone}>{t('outfits.back')}</button>}
    </div>}
    <button className="button button-primary" disabled={!online || isLocked}>{t(busy || phase === 'waiting' ? 'common.saving' : 'outfits.saveOutfit')}</button>
  </form>;
}
