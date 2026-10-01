import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { createLook, pendingCreate, setLookRemoved, type CreateReply } from '../../data/wear-events';
import { todayIn } from '../../domain/local-date';
import { validateLook, wearProblems, type LookAttempt, type WearProblem } from '../../domain/wear-events';
import type { WardrobeItem } from '../../domain/wardrobe';
import type { MessageKey, Translate } from '../../i18n';

// One Wear today per owner session on Today, whichever idea is showing. A kept attempt always wins in createLook, so the
// operation is bound to the attempt it started with, never to the card on screen.
export const wearTodayKey = 'wear-today:today';
export const wearPanelId = 'today-wear-panel';

type Snapshot = { localDate: string; label: string; itemIds: readonly string[]; titles: readonly string[] | null };
type Look = { id: string; ownerId: string; version: number };
export type WearState =
  | { kind: 'idle' }
  | { kind: 'inFlight'; snapshot: Snapshot }
  // The create may have been stored: only its own Try again can write until it is settled.
  | { kind: 'unresolved'; snapshot: Snapshot; problem: MessageKey }
  | { kind: 'settled'; snapshot: Snapshot; message: MessageKey; look?: Look }
  | { kind: 'failed'; snapshot: Snapshot; problem: WearProblem; retry?: () => void };

const snapshotOf = (attempt: LookAttempt, titles: readonly string[] | null): Snapshot =>
  ({ localDate: attempt.localDate, label: attempt.label, itemIds: attempt.itemIds, titles });

type Options = {
  client: AppClient; scope: OwnerScope; timeZone: string; t: Translate;
  onWorn: () => void; onWriting: (busy: boolean) => void;
};
export function useWearToday({ client, scope, timeZone, t, onWorn, onWriting }: Options) {
  const [state, setState] = useState<WearState>({ kind: 'idle' });
  const lifetime = useRef(new AbortController());
  const undoButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const worn = useRef(onWorn);
  useEffect(() => { worn.current = onWorn; }, [onWorn]);
  const inFlight = state.kind === 'inFlight';
  useEffect(() => { onWriting(inFlight); }, [inFlight, onWriting]);
  useEffect(() => () => onWriting(false), [onWriting]);
  // Focus follows the operation only when it has not been moved elsewhere on the page. It moves once the new state has
  // rendered its button.
  const focusRequest = useRef<{ target: { current: HTMLElement | null }; from: Element | null } | null>(null);
  const focusHere = (target: { current: HTMLElement | null }, from?: Element | null) => { focusRequest.current = { target, from: from ?? null }; };
  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected || active.matches('main') || active === request.from
      || panel.current?.contains(active) || active.closest('.today-featured')) request.target.current?.focus();
  }, [state]);

  const settle = useCallback((attempt: LookAttempt, reply: CreateReply, snapshot: Snapshot, from: Element | null) => {
    if (reply.kind === 'saved' || reply.kind === 'exists') {
      worn.current();
      // A look that has changed since it was stored (for example on another device) is left as it is, without Undo.
      setState(reply.kind === 'saved'
        ? { kind: 'settled', snapshot, message: 'calendar.markedWornDone', look: { id: attempt.id, ownerId: attempt.ownerId, version: reply.version } }
        : { kind: 'settled', snapshot, message: 'calendar.alreadySaved' });
      if (reply.kind === 'saved') focusHere(undoButton, from);
      return;
    }
    if (reply.kind === 'notSaved' || reply.kind === 'unknown') {
      setState({ kind: 'unresolved', snapshot, problem: wearProblems[reply.kind].key });
      focusHere(retryButton, from);
      return;
    }
    setState({ kind: 'failed', snapshot, problem: wearProblems[reply.kind] });
  }, []);

  // Every create goes through the shared store: a kept attempt is read back by its ID before anything is sent again.
  const run = useCallback((fresh: LookAttempt | null, resend: boolean, snapshot: Snapshot) => {
    const signal = lifetime.current.signal;
    const from = document.activeElement;
    setState({ kind: 'inFlight', snapshot });
    createLook(client, scope, wearTodayKey, fresh, resend, signal).then(result => {
      if (signal.aborted) return;
      if (result) settle(result.attempt, result.reply, snapshot, from); else setState({ kind: 'idle' });
    }, (error: unknown) => {
      if (signal.aborted || isAborted(error)) return;
      setState(pendingCreate(scope, wearTodayKey) ? { kind: 'unresolved', snapshot, problem: wearProblems.unknown.key }
        : { kind: 'failed', snapshot, problem: wearProblems.unknown });
    });
  }, [client, scope, settle]);

  // Coming back to Today with an unconfirmed Wear today reads that look back before anything else is offered.
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setState({ kind: 'idle' });
    const kept = pendingCreate(scope, wearTodayKey);
    if (kept) run(null, false, snapshotOf(kept, null));
    return () => controller.abort();
  }, [client, scope, run]);

  const blocked = state.kind === 'inFlight' || state.kind === 'unresolved';
  const wear = (itemIds: readonly string[], byId: ReadonlyMap<string, WardrobeItem>) => {
    if (blocked) return;
    // A kept attempt from earlier is read back, never replaced by this idea.
    const kept = pendingCreate(scope, wearTodayKey);
    if (kept) { run(null, false, snapshotOf(kept, null)); return; }
    const label = t('calendar.defaultLook');
    const checked = validateLook({ localDate: todayIn(timeZone), label, outfitId: null, itemIds: [...itemIds] });
    if (!('value' in checked)) return;
    const attempt: LookAttempt = { id: crypto.randomUUID(), localDate: checked.value.localDate, timezone: timeZone, state: 'worn', label: checked.value.label,
      outfitId: null, itemIds: checked.value.itemIds, baselineVersion: null, ownerId: scope.ownerId, epoch: scope.epoch };
    run(attempt, true, snapshotOf(attempt, itemIds.map(id => byId.get(id)?.title ?? '').filter(Boolean)));
  };
  const retry = () => { if (state.kind === 'unresolved') run(null, true, state.snapshot); else if (state.kind === 'failed') state.retry?.(); };
  const undo = () => {
    if (state.kind !== 'settled' || !state.look) return;
    const { snapshot, look } = state;
    const signal = lifetime.current.signal;
    const again = () => {
      setState({ kind: 'inFlight', snapshot });
      setLookRemoved(client, scope, look, true, scope.epoch, signal).then(reply => {
        if (signal.aborted) return;
        if (reply.kind === 'saved') { worn.current(); setState({ kind: 'settled', snapshot, message: 'calendar.undone' }); return; }
        setState({ kind: 'failed', snapshot, problem: wearProblems[reply.kind], retry: reply.kind === 'notSaved' ? again : undefined });
      }, (error: unknown) => {
        if (!signal.aborted && !isAborted(error)) setState({ kind: 'failed', snapshot, problem: wearProblems.unknown });
      });
    };
    again();
  };
  const close = () => { if (state.kind === 'settled' || state.kind === 'failed') setState({ kind: 'idle' }); };
  return { state, blocked, wear, retry, undo, close, refs: { panel, undoButton, retryButton } };
}

export type WearToday = ReturnType<typeof useWearToday>;
