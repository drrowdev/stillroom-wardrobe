import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { AppClient } from '../../../data/client';
import type { AiClient } from '../../../data/ai';
import type { OwnerScope } from '../../../auth/session';
import type { BeforeDiscard } from '../../../app/dialog';
import { pluralText, type Language, type Translate } from '../../../i18n';
import { Icon } from '../../../app/icon';
import { formatUsdCents } from '../../../domain/admin-limits';
import { loadImaging, type BulkPipeline } from '../use-photo-draft';
import { BATCH_LIMIT, BulkQueue, estimateMicro, remainingMicro } from './bulk-queue';
import { BulkDraft, type DraftHandle, type DraftLink } from './bulk-draft';
import '../../../styles/bulk-add.css';

type Props = {
  client: AppClient; scope: OwnerScope; ai: AiClient; currency: string; language: Language; t: Translate; online: boolean;
  onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => void;
  onBeforeDiscard: (handler: BeforeDiscard | null) => void;
  onSaved: () => void; onBack: () => void;
};
type Flags = { dirty: boolean; incomplete: boolean; busy: boolean };
const ACCEPT = 'image/jpeg,image/png,image/webp';
const working = new Set(['preparing', 'removing', 'cleaning', 'filling']);
let nextId = 0;

/**
 * BULK2b: many photos, each through the single-Add draft pipeline, reviewed in a list and saved explicitly. Drafts
 * live only in memory; one batch per visit, so the queue's two-request analysis bound holds for the whole batch.
 */
export function BulkAdd({ client, scope, ai, currency, language, t, online, onDirty, onBeforeDiscard, onSaved, onBack }: Props) {
  const [queue] = useState(() => new BulkQueue(typeof document !== 'undefined' && document.hidden));
  const snap = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const pipeline = useMemo<BulkPipeline>(() => ({
    prepare: (work, signal) => queue.prepare(work, signal),
    cleanup: (run, signal, manual) => queue.cleanup(run, signal, manual),
    analysis: queue.analysis,
  }), [queue]);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const end = () => queue.dispose();
    scope.signal.addEventListener('abort', end, { once: true });
    return () => {
      alive.current = false;
      scope.signal.removeEventListener('abort', end);
      // A real unmount ends the batch; StrictMode's immediate remount keeps it.
      queueMicrotask(() => { if (!alive.current) queue.dispose(); });
    };
  }, [queue, scope]);
  useEffect(() => {
    const sync = () => queue.setHidden(document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [queue]);
  useEffect(() => { loadImaging().catch(() => undefined); }, []);

  const [ids, setIds] = useState<string[]>([]);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState<{ files: File[]; amount: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [handles, setHandles] = useState<ReadonlyMap<string, DraftHandle>>(new Map());
  const [summary, setSummary] = useState<{ saved: number; left: number } | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const files = useRef(new Map<string, File>());
  const flags = useRef(new Map<string, Flags>());
  const discards = useRef(new Map<string, BeforeDiscard>());
  const links = useRef(new Map<string, DraftLink>());
  const idsNow = useRef<string[]>([]);
  const handlesNow = useRef(new Map<string, DraftHandle>());
  const savedCount = useRef(0);
  const lastCard = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const publish = useCallback(() => {
    let dirty = idsNow.current.length > 0, incomplete = false, busy = false;
    for (const value of flags.current.values()) { dirty ||= value.dirty; incomplete ||= value.incomplete; busy ||= value.busy; }
    onDirty(dirty, incomplete, busy);
  }, [onDirty]);
  const drop = useCallback((id: string) => {
    idsNow.current = idsNow.current.filter(value => value !== id);
    flags.current.delete(id); discards.current.delete(id); handlesNow.current.delete(id); links.current.delete(id); files.current.delete(id);
    setIds(idsNow.current);
    setHandles(current => { const next = new Map(current); next.delete(id); return next; });
    setOpen(current => current === id ? null : current);
    publish();
  }, [publish]);
  // The app holds one discard handler: it resolves every draft's own cancellation and keeps the batch if any is unresolved.
  useEffect(() => {
    onBeforeDiscard(async () => {
      const outcomes = await Promise.all([...discards.current.values()].map(handler => handler()));
      return outcomes.includes('unresolved') ? 'unresolved' : 'cancelled';
    });
    return () => onBeforeDiscard(null);
  }, [onBeforeDiscard]);
  function linkFor(id: string): DraftLink {
    let link = links.current.get(id);
    if (!link) {
      link = Object.freeze({
        report: (handle: DraftHandle) => setHandles(current => {
          if (!idsNow.current.includes(id)) return current;
          handlesNow.current.set(id, handle);
          const next = new Map(current); next.set(id, handle); return next;
        }),
        onDirty: (dirty: boolean, incomplete: boolean, busy: boolean) => {
          if (!idsNow.current.includes(id)) return;
          flags.current.set(id, { dirty, incomplete, busy }); publish();
        },
        onBeforeDiscard: (handler: BeforeDiscard | null) => {
          if (handler) discards.current.set(id, handler); else discards.current.delete(id);
        },
        onSaved: () => {
          savedCount.current++; drop(id); onSaved();
          requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) document.getElementById('bulk-title')?.focus(); });
        },
      });
      links.current.set(id, link);
    }
    return link;
  }

  function begin(chosen: File[]) {
    const added = chosen.map((file) => { const id = `b${++nextId}`; files.current.set(id, file); return id; });
    idsNow.current = added;
    setIds(added);
    publish();
  }
  async function pick(list: FileList | File[] | null) {
    if (!list || idsNow.current.length > 0 || pending || checking) return;
    const all = [...list];
    if (all.length === 0) return;
    const chosen = all.slice(0, BATCH_LIMIT);
    setLimited(all.length > BATCH_LIMIT);
    setChecking(true);
    let amount: string | null = null;
    try {
      const status = await ai.status(scope.signal);
      if (status.policy?.activated && status.consent.enabled) {
        const estimate = estimateMicro(chosen.length, remainingMicro(status.policy.monthlyAllowanceMicro, status.usage.accountedMicro));
        if (estimate !== null) amount = formatUsdCents(estimate.toString(), language);
      }
    } catch { /* Unknown usage: start without an estimate; the server still enforces the allowance. */ }
    if (scope.signal.aborted) return;
    setChecking(false);
    if (amount) setPending({ files: chosen, amount }); else begin(chosen);
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    void pick(event.dataTransfer.files);
  }
  async function remove(id: string) {
    const handler = discards.current.get(id);
    const outcome = handler ? await handler() : 'cancelled';
    if (outcome !== 'unresolved' && idsNow.current.includes(id)) {
      const index = idsNow.current.indexOf(id);
      drop(id);
      const neighbour = idsNow.current[index] ?? idsNow.current[index - 1];
      requestAnimationFrame(() => document.getElementById(neighbour ? `bulk-card-${neighbour}` : 'bulk-title')?.focus());
    }
  }
  async function saveAll() {
    if (savingAll) return;
    setSavingAll(true); setSummary(null);
    const before = savedCount.current;
    for (const id of [...idsNow.current]) {
      if (scope.signal.aborted) return;
      const handle = handlesNow.current.get(id);
      if (handle?.saveable) await handle.save().catch(() => undefined);
    }
    if (scope.signal.aborted) return;
    setSavingAll(false);
    setSummary({ saved: savedCount.current - before, left: idsNow.current.length });
  }
  function openDraft(id: string) { lastCard.current = id; setOpen(id); requestAnimationFrame(() => document.getElementById('bulk-edit-title')?.focus()); }
  function closeDraft() {
    setOpen(null);
    const card = lastCard.current;
    requestAnimationFrame(() => document.getElementById(card && idsNow.current.includes(card) ? `bulk-card-${card}` : 'bulk-title')?.focus());
  }

  const statuses = ids.map(id => handles.get(id)?.status);
  const ready = statuses.filter(status => status === 'ready').length;
  const processing = statuses.some(status => !status || working.has(status));
  const anySaveable = ids.some(id => handles.get(id)?.saveable);
  const halt = snap.halted.analysis ?? snap.halted.cleanup;
  return (
    <section className="capture-page bulk-page" aria-labelledby={open ? undefined : 'bulk-title'}>
      <div hidden={open !== null}>
        <button className="text-button back-button" type="button" onClick={onBack}><Icon name="arrow" />{t('wardrobe.back')}</button>
        <div className="page-heading"><div><h1 id="bulk-title" tabIndex={-1}>{t('bulk.title')}</h1></div></div>
        {ids.length === 0 && !pending && <div className="bulk-pick" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <input ref={picker} className="sr-only" type="file" accept={ACCEPT} multiple tabIndex={-1} aria-label={t('bulk.pick')}
            onChange={(event) => { void pick(event.target.files); event.target.value = ''; }} />
          <button id="bulk-pick" type="button" className="button button-primary" disabled={checking} onClick={() => picker.current?.click()}>
            {checking ? <span className="spinner" /> : <Icon name="photo" />}{t('bulk.pick')}</button>
          <p className="muted bulk-drop">{t('bulk.drop')}</p>
        </div>}
        {pending && <div className="notice bulk-estimate" role="status">
          <p>{t('bulk.estimate', { amount: pending.amount })}</p>
          <div className="bulk-actions">
            <button type="button" className="button button-primary" onClick={() => { const chosen = pending.files; setPending(null); begin(chosen); }}>{t('bulk.start')}</button>
            <button type="button" className="button button-secondary" onClick={() => { setPending(null); setLimited(false); }}>{t('common.cancel')}</button>
          </div>
        </div>}
        {limited && <p className="notice" role="status">{t('bulk.limit')}</p>}
        {ids.length > 0 && <div className="bulk-header">
          <p className="bulk-progress" role="status">{t('bulk.progress', { ready, total: ids.length })}</p>
          <div className="bulk-actions">
            {processing && !snap.stopped && <button type="button" className="button button-secondary" onClick={() => queue.stop()}>{t('bulk.stop')}</button>}
            <button type="button" className="button button-primary" disabled={!online || savingAll || !anySaveable}
              onClick={() => { void saveAll(); }}>{savingAll ? <span className="spinner" /> : <Icon name="check" />}{t('bulk.saveAll')}</button>
          </div>
        </div>}
        {(ids.length > 0 || summary) && <div className="bulk-lines" role="status">
          {!online && <p className="notice notice-offline">{t('common.offline')}</p>}
          {halt === 'rate' && <p className="notice">{t('bulk.hourly')}</p>}
          {halt === 'allowance' && <p className="notice">{t('aiC.limit')}</p>}
          {snap.paused && <p className="notice">{t('bulk.paused')}</p>}
          {processing && !snap.stopped && <p className="fine muted">{t('bulk.keepOpen')}</p>}
          {summary && <p>{summary.saved > 0 && pluralText(language, 'bulk.saved', summary.saved)}{summary.saved > 0 && summary.left > 0 && ' '}
            {summary.left > 0 && pluralText(language, 'bulk.needsAttention', summary.left)}</p>}
        </div>}
      </div>
      <ul className="bulk-list" hidden={open !== null}>
        {ids.map(id => <BulkDraft key={id} take={() => { const file = files.current.get(id); files.current.delete(id); return file; }}
          client={client} scope={scope} ai={ai} currency={currency} language={language} t={t} online={online}
          pipeline={pipeline} paused={snap.paused} view={open === null ? 'card' : open === id ? 'editor' : 'hidden'} host={host}
          link={linkFor(id)} cardId={`bulk-card-${id}`}
          onOpen={() => openDraft(id)} onClose={closeDraft} onRemove={() => { void remove(id); }} />)}
      </ul>
      <div ref={setHost} />
    </section>
  );
}
