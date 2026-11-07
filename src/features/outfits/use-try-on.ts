// VTO-2 try-on run (plan rev4 §2.3-§2.4, §3.2): one chain for one saved outfit or one unsaved Today idea, held in memory only. The encoded body
// photo and the latest intermediate picture live here and are dropped on the result, Close, Stop, a chain end or
// disposal (navigation, UID change, logout), and at the latest when the chain's lifetime ends. A step is sent once:
// after a lost or ambiguous reply the run reconciles through tryon_chain_status and never sends it again by itself. Try
// again is always the owner's explicit choice.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CancelResult, ChainStatus, StepInput, StepResponse, TryOnClient, TryOnCode, TryOnResult, TryOnStatus } from '../../data/tryon';
import { sha256Hex, TryOnError } from '../../data/tryon';
import { selectTryOnSteps, TRYON_LIMITS, TRYON_MAX_STEPS, type TryOnCandidate, type TryOnSelection, type TryOnStep } from '../../domain/tryon';
import type { OutfitComponent, OutfitRecord } from '../../domain/outfits';
import { pictureKey } from '../../domain/outfitgen-pictures';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import { readTryOnStatus, type TryOnState, type TryOnStore } from '../settings/tryon-store';

export type TryOnApi = {
  current(): boolean;
  step(input: StepInput, signal: AbortSignal, gate?: () => boolean): Promise<StepResponse>;
  chainStatus(chainId: string, signal?: AbortSignal): Promise<ChainStatus>;
  cancel(chainId: string, signal?: AbortSignal): Promise<CancelResult>;
};
export type SessionStop = {
  stopped(): boolean; recordStep(outcome: 'ok' | 'failed' | 'other'): void;
  /** A foreground run (one the owner started) reports when it is, or is no longer, sending or checking. */
  foreground?(id: string, active: boolean): void;
};
/**
 * OUTFITGEN2: a background run (automatic pictures) asks before every send, including the first and every BUSY retry. `go` sends,
 * `hold` waits for a moment and asks again (a foreground try-on is running; not for the first send), `abort` ends the run without
 * sending (consent, photo or scope changed). A foreground run has no gate and reports itself to the session instead.
 */
export type RunGate = 'go' | 'hold' | 'abort';
export type RunOptions = { gate?: (index: number) => RunGate };
export const HOLD_EVERY_MS = 3_000;
export type RunEnvironment = {
  online(): boolean;
  /** Calls back once the device is online again; returns a remover. */
  whenOnline(callback: () => void): () => void;
  setTimer(callback: () => void, ms: number): () => void;
  /** Calls back whenever the page is shown or focused again (timers may not run while it is hidden); returns a remover. */
  onResume(callback: () => void): () => void;
  now(): number;
  uuid(): string;
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
};

/** The browser's clock, timers, connectivity and hashing. */
export function browserEnvironment(): RunEnvironment {
  return {
    online: () => navigator.onLine,
    whenOnline(callback) {
      const listener = () => { window.removeEventListener('online', listener); callback(); };
      window.addEventListener('online', listener);
      return () => window.removeEventListener('online', listener);
    },
    setTimer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    onResume(callback) {
      const visible = () => { if (document.visibilityState === 'visible') callback(); };
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('pageshow', callback);
      window.addEventListener('focus', callback);
      return () => {
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('pageshow', callback);
        window.removeEventListener('focus', callback);
      };
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    sha256: sha256Hex,
  };
}

export type FailureKind = 'filtered' | 'busy' | 'allowance' | 'failed' | 'lost' | 'mismatch'
  | 'turnedOff' | 'resultsFull' | 'unavailable' | 'paused';
/**
 * What each failure offers first; Close is always offered as well. A block can't be attributed to the photo, a garment
 * or the output, and resending the same step would likely be blocked again, so a block offers another photo, not a retry.
 */
export const failureAction: Readonly<Record<FailureKind, 'retry' | 'photo' | 'restart' | null>> = Object.freeze({
  filtered: 'photo', busy: 'retry', allowance: null, failed: 'retry', lost: 'restart',
  mismatch: 'restart', turnedOff: null, resultsFull: null, unavailable: null, paused: null,
});

export type RunPhase =
  | { kind: 'ready' }
  | { kind: 'running'; index: number; waiting?: true }
  | { kind: 'checking'; index: number; offline: boolean }
  | { kind: 'stopping'; index: number }
  | { kind: 'failed'; index: number; failure: FailureKind }
  | { kind: 'result'; resultId: string; alreadyFinished: boolean }
  | { kind: 'stopped' };

export const RECONCILE_EVERY_MS = 10_000;
export const RECONCILE_FOR_MS = 240_000;
/**
 * A refused claim (BUSY) charges nothing, and the provider slots held by the chain's earlier steps free up within about 80 s:
 * the same step is claimed again every 8 s for up to 100 s before the owner is asked.
 */
export const BUSY_RETRY_EVERY_MS = 8_000;
export const BUSY_RETRY_FOR_MS = 100_000;
/** How long a run may hold picture bytes: the chain's lifetime, counted from the first send (the server's starts later). */
export const RUN_LIFETIME_MS = TRYON_LIMITS.chainMinutes * 60_000;

const failureOf = (code: Exclude<TryOnCode, 'OK'>): FailureKind => {
  switch (code) {
    case 'FILTERED': return 'filtered';
    case 'BUSY': return 'busy';
    case 'ALLOWANCE': return 'allowance';
    case 'FAILED': case 'TIMEOUT': case 'OUTPUT_REJECTED': return 'failed';
    case 'CHAIN_MISMATCH': return 'mismatch';
    case 'WITHDRAWN': case 'CONSENT_REQUIRED': return 'turnedOff';
    case 'RESULTS_FULL': return 'resultsFull';
    case 'PAUSED': return 'paused';
    default: return 'unavailable';
  }
};
/** Codes that may come after the server claimed the step: its outcome is decided by the chain status, not the reply. */
const ambiguous = (code: Exclude<TryOnCode, 'OK'>) => code === 'FAILED' || code === 'TIMEOUT' || code === 'OUTPUT_REJECTED';

export type TryOnIdea = { itemIds: readonly string[] };

export class TryOnRun {
  private phase: RunPhase = { kind: 'ready' };
  private readonly listeners = new Set<() => void>();
  private readonly chainId: string;
  private started = false;
  private disposed = false;
  /** The picture the next attempt sends: the body photo for step 1, then the previous step's picture. */
  private person: Uint8Array<ArrayBuffer> | null;
  /** The body photo the run started from, shown dimmed while the picture is made; released with `person`. */
  private photo: Uint8Array<ArrayBuffer> | null;
  private inFlight: AbortController | null = null;
  private stopTimers: (() => void)[] = [];
  /** The run-lifetime timer and resume listener; unlike `stopTimers` they stay across sends. */
  private lifetime: (() => void)[] = [];
  private expiresAt: number | null = null;
  private generation = 0;
  /** When the current step's automatic BUSY retries end; `null` until the step is first refused. */
  private busyUntil: number | null = null;
  /** What step 1 names: a saved outfit's id, or an unsaved idea's garments (the planned steps' items, in order). */
  private readonly named: { outfitId: string } | { itemIds: readonly string[] };

  constructor(private readonly api: TryOnApi, private readonly session: SessionStop, private readonly env: RunEnvironment,
    subject: string | TryOnIdea, readonly steps: readonly TryOnStep[], photo: Uint8Array<ArrayBuffer>, private readonly options: RunOptions = {}) {
    if (steps.length < 1 || steps.length > TRYON_MAX_STEPS) throw new TryOnError('INVALID_INPUT');
    this.named = typeof subject === 'string' ? { outfitId: subject } : { itemIds: [...subject.itemIds] };
    this.chainId = env.uuid();
    this.person = photo;
    this.photo = photo;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.phase;
  /** Whether a chain may exist on the server for this run (a step was sent at least once). */
  get chainStarted() { return this.started; }
  get id() { return this.chainId; }
  private set(phase: RunPhase) {
    if (this.disposed) return;
    this.phase = phase;
    this.report(phase.kind === 'running' || phase.kind === 'checking' || phase.kind === 'stopping');
    for (const listener of this.listeners) listener();
  }
  private reported = false;
  /** A foreground run tells the session while it is busy, so background pictures wait; a background run never does. */
  private report(active: boolean) {
    if (this.options.gate || this.reported === active) return;
    this.reported = active;
    this.session.foreground?.(this.chainId, active);
  }
  private clearTimers() { for (const stop of this.stopTimers.splice(0)) stop(); }
  private drop() { this.person = null; this.photo = null; }
  /** The body photo while the run still holds it; `null` once released. */
  get referencePhoto() { return this.photo; }
  private endLifetime() { for (const stop of this.lifetime.splice(0)) stop(); }
  /** Starts the lifetime at the first send: however the run is left, no picture is held past it. */
  private armLifetime() {
    if (this.expiresAt !== null) return;
    this.expiresAt = this.env.now() + RUN_LIFETIME_MS;
    this.lifetime.push(this.env.setTimer(() => this.checkLifetime(), RUN_LIFETIME_MS), this.env.onResume(() => this.checkLifetime()));
  }
  /** At the end of the lifetime: stops pending work and checks, releases the pictures and sends nothing. */
  private checkLifetime() {
    if (this.disposed || this.expiresAt === null || this.env.now() < this.expiresAt) return;
    this.endLifetime();
    const phase = this.phase;
    if (phase.kind !== 'running' && phase.kind !== 'checking' && phase.kind !== 'stopping') {
      this.drop();
      // The step can't be sent again once its chain is gone.
      if (phase.kind === 'failed' && failureAction[phase.failure] === 'retry') this.set({ ...phase, failure: 'unavailable' });
      return;
    }
    this.generation += 1;
    this.clearTimers();
    this.inFlight?.abort();
    this.inFlight = null;
    this.drop();
    this.set({ kind: 'failed', index: 'index' in phase ? phase.index : 0, failure: 'unavailable' });
  }
  private live(generation: number) { return !this.disposed && generation === this.generation && this.api.current(); }

  /** Starts the chain, or sends the failed step again after Try again. Nothing is sent while the session stop holds. */
  start(): void {
    const phase = this.phase;
    this.checkLifetime();
    if (this.disposed || !this.person) return;
    if (phase.kind === 'ready') void this.send(0);
    else if (phase.kind === 'failed' && failureAction[phase.failure] === 'retry') { this.busyUntil = null; void this.send(phase.index); }
  }

  private async send(index: number, waiting = false): Promise<void> {
    const person = this.person;
    if (!person) return;
    if (this.session.stopped()) { this.fail(index, 'unavailable'); return; }
    const generation = ++this.generation;
    this.clearTimers();
    const verdict = this.options.gate?.(index) ?? 'go';
    if (verdict === 'abort' || (verdict === 'hold' && index === 0)) { this.fail(index, 'unavailable'); return; }
    if (verdict === 'hold') { this.hold(index, generation); return; }
    this.set(waiting ? { kind: 'running', index, waiting: true } : { kind: 'running', index });
    const controller = new AbortController();
    this.inFlight = controller;
    // A gated run counts as started only once its last check has passed (see the gate below).
    if (!this.options.gate) this.started = true;
    this.armLifetime();
    let reply: StepResponse;
    const refusal: { value: RunGate | null } = { value: null };
    try {
      const gate = this.options.gate ? () => {
        const last = this.options.gate!(index);
        if (last === 'go') this.started = true; else refusal.value = last;
        return last === 'go';
      } : undefined;
      reply = await this.api.step({ chainId: this.chainId, step: index + 1, requestId: this.env.uuid(), person,
        ...(index === 0 ? this.named : {}) }, controller.signal, gate);
    } catch (error) {
      if (!this.live(generation)) return;
      this.inFlight = null;
      // The last check held the step back (a foreground try-on began meanwhile): nothing was sent, so wait and ask again.
      if (refusal.value === 'hold' && index > 0) { this.hold(index, generation); return; }
      if (refusal.value !== null) { this.fail(index, 'unavailable'); return; }
      const code = error instanceof TryOnError ? error.code : 'UNAVAILABLE';
      // Refused before sending: nothing was charged and nothing can be pending.
      if (code === 'UNAUTHENTICATED' || code === 'INVALID_INPUT') { this.fail(index, 'unavailable'); return; }
      this.reconcile(index, generation);
      return;
    }
    if (!this.live(generation)) return;
    this.inFlight = null;
    await this.handle(index, reply, generation);
  }

  /**
   * A reply that doesn't prove its outcome (an unusable picture, the wrong kind for this step, or a failure that may
   * come after the server claimed the step) is settled from the chain status, never from the reply.
   */
  private async handle(index: number, reply: StepResponse, generation: number): Promise<void> {
    const last = index === this.steps.length - 1;
    if (reply.kind === 'result') {
      if (!last) { this.reconcile(index, generation); return; }
      this.session.recordStep('ok');
      this.finish(reply.resultId, false);
      return;
    }
    if (reply.kind === 'intermediate') {
      const hash = await this.env.sha256(reply.body).catch(() => '');
      if (!this.live(generation)) return;
      if (last || hash !== reply.sha256) { this.reconcile(index, generation); return; }
      this.session.recordStep('ok');
      this.person = reply.body;
      this.busyUntil = null;
      void this.send(index + 1);
      return;
    }
    if (reply.code === 'BUSY' && this.waitForSlot(index, generation)) return;
    if (ambiguous(reply.code)) { this.reconcile(index, generation); return; }
    this.session.recordStep('other');
    this.fail(index, failureOf(reply.code));
  }

  /** Waits for the gate to allow the step again; nothing is sent meanwhile. The chain's lifetime still ends the wait. */
  private hold(index: number, generation: number) {
    this.set({ kind: 'running', index, waiting: true });
    this.stopTimers.push(this.env.setTimer(() => { if (this.live(generation)) void this.send(index, true); }, HOLD_EVERY_MS));
  }

  /** A BUSY claim was refused and charged nothing: claim the same step again shortly, within the budget. False once it is spent. */
  private waitForSlot(index: number, generation: number): boolean {
    const now = this.env.now();
    this.busyUntil ??= now + BUSY_RETRY_FOR_MS;
    if (now + BUSY_RETRY_EVERY_MS > this.busyUntil) return false;
    this.set({ kind: 'running', index, waiting: true });
    this.stopTimers.push(this.env.setTimer(() => { if (this.live(generation)) void this.send(index, true); }, BUSY_RETRY_EVERY_MS));
    return true;
  }

  private fail(index: number, failure: FailureKind) {
    // Only a step that can be sent again keeps its picture in memory.
    if (failureAction[failure] !== 'retry') this.drop();
    this.set({ kind: 'failed', index, failure });
  }
  private finish(resultId: string | null, alreadyFinished: boolean) {
    this.drop();
    this.clearTimers();
    this.endLifetime();
    if (resultId === null) { this.set({ kind: 'failed', index: this.steps.length - 1, failure: 'unavailable' }); return; }
    this.set({ kind: 'result', resultId, alreadyFinished });
  }

  /** §3.2: the outcome of a sent step is unknown. Check every 10 s while online, for up to 4 minutes. */
  private reconcile(index: number, generation: number) {
    const deadline = this.env.now() + RECONCILE_FOR_MS;
    const tick = async () => {
      if (!this.live(generation)) return;
      this.checkLifetime();
      if (!this.live(generation)) return;
      if (!this.env.online()) {
        this.set({ kind: 'checking', index, offline: true });
        this.stopTimers.push(this.env.whenOnline(() => { void tick(); }));
        return;
      }
      this.set({ kind: 'checking', index, offline: false });
      const status: ChainStatus | null = await this.api.chainStatus(this.chainId).catch(() => null);
      if (!this.live(generation)) return;
      const settled = status ? this.settle(index, status) : false;
      if (settled) return;
      if (this.env.now() >= deadline) { this.fail(index, 'unavailable'); return; }
      this.stopTimers.push(this.env.setTimer(() => { void tick(); }, RECONCILE_EVERY_MS));
    };
    void tick();
  }
  /** True once the chain status decides the step. The server's plan is authoritative: a different plan can't go on. */
  private settle(index: number, status: ChainStatus): boolean {
    if (status.kind === 'code') {
      if (status.code === 'UNAVAILABLE') return false;
      // No chain: step 1 was never claimed, so nothing was charged and the same photo can be sent again.
      if (index === 0) { this.fail(index, 'failed'); return true; }
      this.fail(index, 'unavailable');
      return true;
    }
    const samePlan = status.steps.length === this.steps.length
      && status.steps.every((step, at) => step.slot === this.steps[at]!.slot && step.itemId === this.steps[at]!.itemId);
    if (!samePlan && (status.state === 'running' || status.state === 'complete')) { this.fail(index, 'mismatch'); return true; }
    switch (status.state) {
      case 'complete': this.session.recordStep('ok'); this.finish(status.resultId, false); return true;
      case 'withdrawn': this.fail(index, 'turnedOff'); return true;
      case 'stale': this.fail(index, 'mismatch'); return true;
      case 'cancelled': case 'expired': this.fail(index, 'unavailable'); return true;
      case 'running':
        if (status.activeAttempt) return false;
        // The step went through but its picture never arrived: it can't be sent on.
        if (status.nextStep > index + 1) { this.fail(index, 'lost'); return true; }
        this.session.recordStep('failed');
        this.fail(index, 'failed');
        return true;
    }
  }

  /** Stop (after the owner's confirmation). A last step that already finished shows its result instead. */
  async stop(): Promise<void> {
    const phase = this.phase;
    if (this.disposed || phase.kind === 'result' || phase.kind === 'stopped' || phase.kind === 'stopping') return;
    const index = 'index' in phase ? phase.index : 0;
    const generation = ++this.generation;
    this.clearTimers();
    this.inFlight?.abort();
    this.inFlight = null;
    this.drop();
    if (!this.started) { this.set({ kind: 'stopped' }); return; }
    this.set({ kind: 'stopping', index });
    const reply: CancelResult | null = await this.api.cancel(this.chainId).catch(() => null);
    if (!this.live(generation)) return;
    if (reply?.code === 'COMPLETED') { this.finish(reply.resultId, true); return; }
    // NOT_FOUND is not a stop: without the server's marker, a step already on its way could still finish.
    if (reply?.code === 'CANCELLED' || reply?.code === 'EXPIRED') { this.set({ kind: 'stopped' }); return; }
    this.set({ kind: 'failed', index, failure: reply?.code === 'WITHDRAWN' ? 'turnedOff' : 'unavailable' });
  }

  /** Close, Start again or another photo: drops everything and, if a chain is still open, ends it without waiting. */
  abandon(): void {
    if (this.disposed) return;
    const phase = this.phase;
    const open = this.started && phase.kind !== 'result' && phase.kind !== 'stopped';
    this.dispose();
    if (open) void this.api.cancel(this.chainId).catch(() => undefined);
  }
  dispose(): void {
    if (this.disposed) return;
    this.report(false);
    this.generation += 1;
    this.clearTimers();
    this.endLifetime();
    this.inFlight?.abort();
    this.inFlight = null;
    this.drop();
    this.disposed = true;
    this.listeners.clear();
  }
  /** For tests: whether picture bytes are still held. */
  holdsPicture(): boolean { return this.person !== null; }
}

/** The garments in the given order, as the step selection sees them. Removed or unknown items are skipped. */
export function tryOnCandidatesOf(itemIds: readonly string[], components: ReadonlyMap<string, OutfitComponent>): TryOnCandidate[] {
  return itemIds.flatMap((itemId) => {
    const component = components.get(itemId);
    if (!component || component.category === null || component.lifecycle === null) return [];
    return [{ itemId, category: component.category, lifecycle: component.lifecycle,
      deleted: component.state === 'trashed' || component.state === 'missing', readyImage: component.thumbPath !== null }];
  });
}
/** The outfit's garments in saved order. */
export function tryOnCandidates(record: OutfitRecord, components: ReadonlyMap<string, OutfitComponent>): TryOnCandidate[] {
  return tryOnCandidatesOf(record.links.map(({ itemId }) => itemId), components);
}
export function tryOnSelection(record: OutfitRecord, components: ReadonlyMap<string, OutfitComponent>): TryOnSelection {
  return selectTryOnSteps(tryOnCandidates(record, components));
}
/** An unsaved idea's garments, in the idea's order. */
export function ideaSelection(itemIds: readonly string[], components: ReadonlyMap<string, OutfitComponent>): TryOnSelection {
  return selectTryOnSteps(tryOnCandidatesOf(itemIds, components));
}
export const slotKey = (slot: string): MessageKey => `tryon.slot.${slot}` as MessageKey;
export const itemName = (components: ReadonlyMap<string, OutfitComponent>, id: string, t: Translate) =>
  components.get(id)?.title?.trim() || t('outfits.unavailableItem');

export function deletionDate(ms: number, language: Language): string {
  return new Intl.DateTimeFormat(locales[language], { day: 'numeric', month: 'short' }).format(new Date(ms));
}

const noStore = { subscribe: () => () => undefined, get: (): TryOnState | null => null };
/** Try-on status of this owner scope, read when a screen opens. `null` until a status has been read. */
export function useTryOnStatus(store: TryOnStore | null): TryOnStatus | null {
  const state = useSyncExternalStore<TryOnState | null>(store?.subscribe ?? noStore.subscribe, store?.get ?? noStore.get);
  useEffect(() => { if (store) void readTryOnStatus(store, 'active'); }, [store]);
  return state?.read.kind === 'ready' ? state.read.status : null;
}

/** Saved try-ons of one outfit. `missing`: this backend has no try-on; `failed`: the list couldn't be read. */
export type SavedTryOnsState = { kind: 'idle' | 'loading' | 'missing' | 'failed' } | { kind: 'ready'; results: TryOnResult[] };
/** Saved try-ons of one outfit, or (`null`) of unsaved ideas, newest first; each stays until it is deleted. `retry` reads the list again. */
export function useOutfitTryOns(api: TryOnClient | null, outfitId: string | null, enabled: boolean, sameSet: string | null = null, stamp = ''): { state: SavedTryOnsState; retry: () => void } {
  const [state, setState] = useState<SavedTryOnsState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!api || !enabled) { setState({ kind: 'idle' }); return; }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    api.results(controller.signal).then(list => {
      if (controller.signal.aborted) return;
      if (list === 'missing') { setState({ kind: 'missing' }); return; }
      setState({ kind: 'ready', results: list.filter(entry => entry.outfitId === outfitId || (outfitId !== null && sameSet !== null && entry.outfitId === null && pictureKey(entry.itemIds) === sameSet))
        .sort((a, b) => b.completedAtMs - a.completedAtMs) });
    }, () => { if (!controller.signal.aborted) setState({ kind: 'failed' }); });
    return () => controller.abort();
  }, [api, outfitId, enabled, sameSet, stamp, attempt]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return { state, retry };
}
