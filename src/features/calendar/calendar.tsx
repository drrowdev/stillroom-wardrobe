import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../app/icon';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadComponents, loadOutfits } from '../../data/outfits';
import { createLook, dropPendingCreate, loadLooks, pendingCreate, saveLook, setLookRemoved, type CreateReply } from '../../data/wear-events';
import {
  addDays, addMonths, dayParts, firstWeekday, formatMonth, monthGrid, monthOf, monthRange, todayIn, weekdayNames,
} from '../../domain/local-date';
import { canMarkWorn, stateAttempt, validateLook, wearProblems, type Look, type LookAttempt, type LookErrors, type WearProblem, type WearReply } from '../../domain/wear-events';
import type { WardrobeItem } from '../../domain/wardrobe';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';

type Props = {
  client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate; timeZone: string;
  invalidation: number; seed: { outfitId: string } | null; onSeedUsed: () => void; onChanged: () => void;
  onWriting: (busy: boolean) => void;
};
type View = 'month' | 'agenda';
type Problem = WearProblem;
type Notice = { key: MessageKey; undo?: () => Promise<WearReply> };
const dayHeading = (t: Translate, locale: string, iso: string) => t('calendar.dayHeading', dayParts(iso, locale));

function useLooks(client: AppClient, scope: OwnerScope, month: string, online: boolean, invalidation: number) {
  const [state, setState] = useState<{ month: string; looks: Look[] | null; error: boolean }>({ month, looks: null, error: false });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) reload();
    wasOnline.current = online;
  }, [online, reload]);
  useEffect(() => {
    const controller = new AbortController();
    const { first, last } = monthRange(month);
    setState(current => current.month === month ? { ...current, error: false } : { month, looks: null, error: false });
    loadLooks(client, scope, first, last, controller.signal).then(looks => {
      if (!controller.signal.aborted) setState({ month, looks, error: false });
    }, (problem: unknown) => {
      if (!controller.signal.aborted && !isAborted(problem)) setState(current => ({ ...current, month, error: true }));
    });
    return () => controller.abort();
  }, [client, scope, month, tick, invalidation]);
  return { looks: state.month === month ? state.looks : null, error: state.error, reload };
}

export function CalendarScreen({ client, scope, online, language, t, timeZone, invalidation, seed, onSeedUsed, onChanged, onWriting }: Props) {
  const locale = locales[language];
  const today = todayIn(timeZone);
  const [view, setView] = useState<View>('month');
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => monthOf(today));
  const data = useLooks(client, scope, month, online, invalidation);
  const reload = data.reload;
  const [planning, setPlanning] = useState<{ date: string; outfitId: string | null } | null>(() => seed ? { date: today, outfitId: seed.outfitId } : null);
  const [pending, setPending] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  // A write in flight holds navigation, so leaving cannot cut off a change whose reply is still on its way.
  useEffect(() => { onWriting(pending || planSaving); }, [pending, planSaving, onWriting]);
  useEffect(() => () => onWriting(false), [onWriting]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const retry = useRef<(() => void) | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const noticeElement = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const alive = useRef(new AbortController());
  useEffect(() => { if (seed) onSeedUsed(); }, [seed, onSeedUsed]);
  useEffect(() => { const controller = new AbortController(); alive.current = controller; return () => controller.abort(); }, []);
  const firstDay = firstWeekday(locale);
  const weeks = useMemo(() => monthGrid(month, firstDay), [month, firstDay]);
  const names = useMemo(() => weekdayNames(locale, firstDay), [locale, firstDay]);
  const byDay = useMemo(() => {
    const result = new Map<string, Look[]>();
    for (const look of data.looks ?? []) result.set(look.localDate, [...(result.get(look.localDate) ?? []), look]);
    return result;
  }, [data.looks]);

  const choose = useCallback((date: string, focus = false) => {
    setSelected(date);
    setMonth(monthOf(date));
    focusDay.current = focus;
  }, []);
  // Arrow keys can move into another month, whose grid appears once its looks have loaded.
  useEffect(() => {
    if (!focusDay.current) return;
    const button = document.querySelector<HTMLButtonElement>(`.calendar-day[data-date="${selected}"]`);
    if (button) { focusDay.current = false; button.focus(); }
  }, [selected, weeks, data.looks]);

  const run = useCallback((work: () => Promise<WearReply>, success: (version: number) => Notice) => {
    const attempt = () => {
      setPending(true); setProblem(null);
      work().then(reply => {
        setPending(false);
        if (reply.kind === 'saved') {
          const next = success(reply.version);
          onChanged(); reload(); retry.current = null; setNotice(next);
          requestAnimationFrame(() => (next.undo ? undoButton.current : noticeElement.current)?.focus());
          return;
        }
        setNotice(null);
        retry.current = reply.kind === 'notSaved' ? attempt : null;
        setProblem(wearProblems[reply.kind]);
        if (reply.kind === 'conflict' || reply.kind === 'unknown') reload();
      }, (error: unknown) => {
        setPending(false);
        if (!isAborted(error)) setProblem(wearProblems.unknown);
      });
    };
    attempt();
  }, [onChanged, reload]);

  function markWorn(look: Look) {
    const signal = alive.current.signal;
    run(() => saveLook(client, scope, stateAttempt(look, 'worn', scope.epoch), signal), version => ({
      key: 'calendar.markedWornDone',
      undo: () => saveLook(client, scope, stateAttempt({ ...look, state: 'worn', version }, 'planned', scope.epoch), signal),
    }));
  }
  function remove(look: Look) {
    const signal = alive.current.signal;
    run(() => setLookRemoved(client, scope, look, true, scope.epoch, signal), version => ({
      key: 'calendar.removed',
      undo: () => setLookRemoved(client, scope, { ...look, version }, false, scope.epoch, signal),
    }));
  }
  function onGridKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    if (step === undefined) return;
    event.preventDefault();
    choose(addDays(date, step), true);
  }
  function openPlan(date: string, element: HTMLElement) {
    opener.current = element;
    setPlanning({ date, outfitId: null });
  }
  const closePlan = useCallback(() => {
    setPlanning(null);
    requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); else document.getElementById('calendar-title')?.focus(); });
  }, []);
  const dayLabel = (date: string, count: number) => {
    const day = dayHeading(t, locale, date);
    if (!count) return day;
    const key = new Intl.PluralRules(locale).select(count) === 'one' ? 'calendar.dayLooks_one' : 'calendar.dayLooks_other';
    return t(key, { date: day, count: new Intl.NumberFormat(locale).format(count) });
  };

  const lookList = (looks: readonly Look[]) => <ul className="look-list">
    {looks.map(look => <LookCard key={look.id} look={look} today={today} online={online} pending={pending} t={t}
      onWorn={() => markWorn(look)} onRemove={() => remove(look)} />)}
  </ul>;
  const selectedLooks = byDay.get(selected) ?? [];
  const agendaDays = [...byDay.keys()].sort();
  const focusable = monthOf(selected) === month ? selected : `${month}-01`;
  return <section className="calendar-page" aria-labelledby="calendar-title">
    <div className="page-heading">
      <div><h1 id="calendar-title" tabIndex={-1}>{t('nav.calendar')}</h1></div>
      <button type="button" className="button button-primary" disabled={!online} onClick={(event) => openPlan(monthOf(selected) === month ? selected : today, event.currentTarget)}>
        <Icon name="plus" />{t('calendar.planLook')}</button>
    </div>
    <div className="calendar-toolbar">
      <div className="weather-place calendar-views" role="group" aria-label={t('calendar.view')}>
        {(['month', 'agenda'] as const).map(value => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}>
          {t(value === 'month' ? 'calendar.month' : 'calendar.agenda')}</button>)}
      </div>
      <div className="calendar-months">
        <button type="button" className="icon-button" aria-label={t('calendar.previousMonth')} onClick={() => setMonth(addMonths(month, -1))}><Icon name="chevron" className="icon-left" /></button>
        <h2 id="calendar-month" aria-live="polite">{formatMonth(month, locale)}</h2>
        <button type="button" className="icon-button" aria-label={t('calendar.nextMonth')} onClick={() => setMonth(addMonths(month, 1))}><Icon name="chevron" className="icon-right" /></button>
        <button type="button" className="text-button" onClick={() => choose(today)}>{t('nav.today')}</button>
      </div>
    </div>
    {notice && <div ref={noticeElement} tabIndex={-1} className="notice notice-success calendar-notice" role="status"><Icon name="check" /><span>{t(notice.key)}</span>
      {notice.undo && <button ref={undoButton} type="button" className="text-button" disabled={!online || pending}
        onClick={() => { const work = notice.undo!; run(work, () => ({ key: 'calendar.undone' })); }}>{t('common.undo')}</button>}
      <button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setNotice(null)}><Icon name="close" /></button></div>}
    {problem && <div className="notice notice-error" role="alert"><span>{t(problem.key)}</span>
      {problem.action === 'retry' && <button type="button" className="text-button" disabled={!online || pending} onClick={() => retry.current?.()}>{t('common.retry')}</button>}
      {problem.action === 'reload' && <button type="button" className="text-button" disabled={!online} onClick={() => { setProblem(null); reload(); }}>{t('outfits.reload')}</button>}</div>}
    {data.error && <div className="notice notice-error" role="alert"><span>{t('calendar.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={reload}>{t('common.retry')}</button></div>}
    {!data.looks ? !data.error && <p role="status">{t('common.loading')}</p>
      : view === 'month' ? <div className="calendar-month-view">
        <table className="calendar-grid" aria-labelledby="calendar-month">
          <thead><tr>{names.map(name => <th key={name.long} scope="col"><abbr title={name.long}>{name.short}</abbr></th>)}</tr></thead>
          <tbody>{weeks.map(week => <tr key={week[0]}>{week.map(date => {
            if (monthOf(date) !== month) return <td key={date} className="calendar-outside" />;
            const looks = byDay.get(date) ?? [];
            return <td key={date}><button type="button" data-date={date} aria-label={dayLabel(date, looks.length)} aria-pressed={date === selected}
              aria-current={date === today ? 'date' : undefined} tabIndex={date === focusable ? 0 : -1}
              className={`calendar-day${date === today ? ' calendar-today' : ''}`} onClick={() => choose(date)} onKeyDown={(event) => onGridKey(event, date)}>
              <span className="calendar-day-number" aria-hidden="true">{Number(date.slice(8))}</span>
              <span className="calendar-marks" aria-hidden="true">
                {looks.slice(0, 3).map(look => <span key={look.id} className={`calendar-mark calendar-mark-${look.state}`} />)}</span>
            </button></td>;
          })}</tr>)}</tbody>
        </table>
        {monthOf(selected) === month && <section className="calendar-day-panel" aria-labelledby="calendar-day-title">
          <h3 id="calendar-day-title">{dayHeading(t, locale, selected)}</h3>
          {selectedLooks.length ? lookList(selectedLooks) : <p className="muted">{t('calendar.empty')}</p>}
        </section>}
      </div>
      : agendaDays.length ? <ol className="calendar-agenda">
        {agendaDays.map(date => <li key={date}><h3>{dayHeading(t, locale, date)}</h3>{lookList(byDay.get(date)!)}</li>)}
      </ol> : <p className="muted">{t('calendar.agendaEmpty')}</p>}
    {planning && <PlanDialog client={client} scope={scope} t={t} locale={locale} online={online} timeZone={timeZone} today={today} initial={planning}
      invalidation={invalidation} onBusy={setPlanSaving} onClose={closePlan} onSaved={(date, key) => {
        setPlanSaving(false); setPlanning(null); onChanged(); choose(date); reload(); setProblem(null);
        setNotice({ key });
        requestAnimationFrame(() => noticeElement.current?.focus());
      }} />}
  </section>;
}

function LookCard({ look, today, online, pending, t, onWorn, onRemove }: {
  look: Look; today: string; online: boolean; pending: boolean; t: Translate; onWorn: () => void; onRemove: () => void;
}) {
  const heading = `look-${look.id}`;
  const future = look.localDate > today;
  return <li className="look-card">
    <div className="look-head"><h4 id={heading}>{look.label}</h4>
      <span className={`look-state look-state-${look.state}`}>{t(look.state === 'worn' ? 'calendar.worn' : 'calendar.planned')}</span></div>
    <ul className="look-pieces">{look.pieces.map(piece => <li key={piece.id}>
      {piece.itemId ? <a href={`#/items/${piece.itemId}`}>{piece.title}</a> : <span>{piece.title}</span>}</li>)}</ul>
    <div className="look-actions">
      {look.state === 'planned' && <button type="button" className="button button-secondary" aria-describedby={heading}
        disabled={!online || pending || !canMarkWorn(look, today)} onClick={onWorn}>{t('calendar.markWorn')}</button>}
      <button type="button" className="text-button" aria-describedby={heading} disabled={!online || pending} onClick={onRemove}>{t('calendar.remove')}</button>
    </div>
    {look.state === 'planned' && future && <p className="muted look-hint">{t('calendar.futureWorn')}</p>}
    {look.state === 'planned' && !future && look.pieces.every(piece => !piece.itemId) && <p className="muted look-hint">{t('calendar.itemsGone')}</p>}
  </li>;
}

type Sources = { outfits: { id: string; title: string; itemIds: string[] }[]; items: WardrobeItem[] };
function useSources(client: AppClient, scope: OwnerScope, invalidation: number) {
  const [state, setState] = useState<{ data: Sources | null; error: boolean }>({ data: null, error: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(current => ({ ...current, error: false }));
    (async () => {
      const [outfits, wardrobe] = await Promise.all([loadOutfits(client, scope, controller.signal), loadWardrobe(client, scope, controller.signal)]);
      const components = await loadComponents(client, scope, outfits.flatMap(outfit => outfit.links.map(link => link.itemId)), controller.signal);
      // Clothes in the trash cannot be worn, so saved outfits offer only their remaining pieces.
      const usable = (id: string) => { const state = components.get(id)?.state; return state === 'current' || state === 'archived'; };
      return {
        outfits: outfits.map(outfit => ({ id: outfit.id, title: outfit.title, itemIds: outfit.links.map(link => link.itemId).filter(usable) }))
          .filter(outfit => outfit.itemIds.length > 0),
        items: wardrobe.filter(item => item.lifecycle === 'active'),
      };
    })().then(data => { if (!controller.signal.aborted) setState({ data, error: false }); },
      (problem: unknown) => { if (!controller.signal.aborted && !isAborted(problem)) setState(current => ({ ...current, error: true })); });
    return () => controller.abort();
  }, [client, scope, invalidation, tick]);
  return { ...state, reload: () => setTick(value => value + 1) };
}

// The plan dialog's creates share one key per owner session: reopening it after an unconfirmed plan shows that plan,
// read back by its ID, instead of a blank form that could record it twice.
const planKey = 'plan';
function PlanDialog({ client, scope, t, locale, online, timeZone, today, initial, invalidation, onBusy, onClose, onSaved }: {
  client: AppClient; scope: OwnerScope; t: Translate; locale: string; online: boolean; timeZone: string; today: string;
  initial: { date: string; outfitId: string | null }; invalidation: number; onBusy: (busy: boolean) => void; onClose: () => void; onSaved: (date: string, key: MessageKey) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sources = useSources(client, scope, invalidation);
  const [kept, setKept] = useState<LookAttempt | null>(() => pendingCreate(scope, planKey));
  const [checking, setChecking] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const [date, setDate] = useState(initial.date);
  const [source, setSource] = useState<'outfit' | 'items'>('outfit');
  const [outfitId, setOutfitId] = useState<string | null>(initial.outfitId);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  const [worn, setWorn] = useState(false);
  const [errors, setErrors] = useState<LookErrors>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const element = dialog.current, controller = new AbortController();
    lifetime.current = controller;
    element?.showModal();
    if (pendingCreate(scope, planKey)) run(null, false);
    return () => { controller.abort(); element?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per opened dialog
  }, []);
  const data = sources.data;
  const outfits = data?.outfits ?? [];
  const mode = outfits.length ? source : 'items';
  const outfit = mode === 'outfit' ? outfits.find(value => value.id === outfitId) ?? outfits[0] ?? null : null;
  const shownLabel = label ?? (outfit ? outfit.title : t('calendar.defaultLook'));
  const future = date > today;
  function save() {
    if (busy) return;
    const checked = validateLook({ localDate: date, label: shownLabel, outfitId: outfit?.id ?? null, itemIds: outfit ? outfit.itemIds : itemIds });
    if ('errors' in checked) {
      setErrors(checked.errors);
      requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors({});
    const state = worn && !future ? 'worn' : 'planned';
    run({ id: crypto.randomUUID(), localDate: checked.value.localDate, timezone: timeZone, state, label: checked.value.label,
      outfitId: checked.value.outfitId, itemIds: checked.value.itemIds, baselineVersion: null, ownerId: scope.ownerId, epoch: scope.epoch }, true);
  }
  function settle(attempt: LookAttempt, reply: CreateReply) {
    if (reply.kind === 'saved') { onSaved(attempt.localDate, attempt.state === 'worn' ? 'calendar.markedWornDone' : 'calendar.added'); return; }
    if (reply.kind === 'exists') { onSaved(attempt.localDate, 'calendar.alreadySaved'); return; }
    const open = reply.kind === 'notSaved' || reply.kind === 'unknown';
    // An unconfirmed plan stays on screen with Retry; a refused one returns to the form.
    setKept(open ? attempt : null);
    setProblem(reply.kind === 'conflict' ? 'calendar.notSaved' : wearProblems[reply.kind].key);
    if (open) requestAnimationFrame(() => retryButton.current?.focus());
  }
  function run(fresh: LookAttempt | null, resend: boolean) {
    const signal = lifetime.current.signal;
    setBusy(true); setChecking(!fresh && !resend); setProblem(null);
    // A request cut off by closing the dialog leaves its attempt kept and must not touch a newer request's state.
    createLook(client, scope, planKey, fresh, resend, signal).then(result => {
      if (signal.aborted) return;
      setBusy(false); setChecking(false);
      if (result) settle(result.attempt, result.reply); else setKept(null);
    }, (error: unknown) => { if (signal.aborted) return; setBusy(false); setChecking(false); if (!isAborted(error)) setProblem('calendar.unknown'); });
  }
  function startOver() {
    dropPendingCreate(scope, planKey);
    setKept(null); setProblem(null);
  }
  const toggle = (id: string) => setItemIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const itemsInvalid = errors.items ? true : undefined;
  return <dialog ref={dialog} className="dialog plan-dialog" aria-labelledby="plan-title" aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="plan-title">{t('calendar.planLook')}</h2>
    {kept ? <div className="stack">
      <p><strong>{kept.label}</strong><br />{dayHeading(t, locale, kept.localDate)}</p>
      {checking ? <p role="status">{t('calendar.checkingPlan')}</p> : busy ? <p role="status">{t('common.saving')}</p>
        : problem && <p className="notice notice-error" role="alert">{t(problem)}</p>}
      <div className="dialog-actions">
        <button ref={retryButton} type="button" className="button button-primary" disabled={!online || busy} onClick={() => run(null, true)}>{t('common.retry')}</button>
        {problem === 'calendar.notSaved' && !busy && <button type="button" className="button button-secondary" onClick={startOver}>{t('calendar.startOver')}</button>}
        <button className="button button-quiet" type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div> : <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); save(); }}>
      <fieldset className="plan-fields" disabled={busy}>
        <div className="field"><label htmlFor="plan-date">{t('calendar.date')}</label>
          <input id="plan-date" type="date" required value={date} aria-invalid={errors.date ? true : undefined}
            aria-describedby={errors.date ? 'plan-date-error' : undefined} onChange={(event) => { setDate(event.target.value); if (event.target.value > today) setWorn(false); }} />
          {errors.date && <p id="plan-date-error" className="field-error" role="alert">{t(errors.date)}</p>}
        </div>
        {sources.error && <div className="notice notice-error" role="alert"><span>{t('calendar.loadFailed')}</span>
          <button type="button" className="text-button" disabled={!online} onClick={sources.reload}>{t('common.retry')}</button></div>}
        {!data ? !sources.error && <p role="status">{t('common.loading')}</p> : !outfits.length && !data.items.length
          ? <p>{t('outfits.noClothes')}</p> : <>
          {outfits.length > 0 && <fieldset className="plan-source"><legend>{t('calendar.source')}</legend>
            <label className="check"><input type="radio" name="plan-source" checked={mode === 'outfit'} onChange={() => setSource('outfit')} />{t('calendar.fromOutfit')}</label>
            <label className="check"><input type="radio" name="plan-source" checked={mode === 'items'} onChange={() => setSource('items')} />{t('outfits.selectItems')}</label>
          </fieldset>}
          {outfit ? <div className="field"><label htmlFor="plan-outfit">{t('calendar.outfit')}</label>
            <select id="plan-outfit" value={outfit.id} onChange={(event) => setOutfitId(event.target.value)}>
              {outfits.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
            </select></div>
            : <fieldset className="plan-items" aria-describedby={itemsInvalid && 'plan-items-error'}>
              <legend>{t('outfits.selectItems')}</legend>
              <ul>{data.items.map(item => <li key={item.id}><label className="check"><input type="checkbox" checked={itemIds.includes(item.id)}
                aria-invalid={itemsInvalid} onChange={() => toggle(item.id)} />{item.title}</label></li>)}</ul>
            </fieldset>}
          {errors.items && <p id="plan-items-error" className="field-error" role="alert">{t(errors.items)}</p>}
          <div className="field"><label htmlFor="plan-label">{t('calendar.label')}</label>
            <input id="plan-label" maxLength={100} value={shownLabel} aria-invalid={errors.label ? true : undefined}
              aria-describedby={errors.label ? 'plan-label-error' : undefined} onChange={(event) => setLabel(event.target.value)} />
            {errors.label && <p id="plan-label-error" className="field-error" role="alert">{t(errors.label)}</p>}
          </div>
          <div className="field"><label className="check"><input type="checkbox" id="plan-worn" checked={worn && !future} disabled={future}
            aria-describedby={future ? 'plan-worn-hint' : undefined} onChange={(event) => setWorn(event.target.checked)} />{t('calendar.markWorn')}</label>
            {future && <p id="plan-worn-hint" className="muted">{t('calendar.futureWorn')}</p>}
          </div>
        </>}
      </fieldset>
      {problem && <p className="notice notice-error" role="alert">{t(problem)}</p>}
      <div className="dialog-actions">
        <button className="button button-primary" disabled={!online || busy || !data}>{t(busy ? 'common.saving' : 'calendar.add')}</button>
        <button className="button button-quiet" type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </form>}
  </dialog>;
}
