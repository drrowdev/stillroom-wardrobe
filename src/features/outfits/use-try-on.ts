// VTO-2 try-on run (plan rev4 §2.3-§2.4, §3.2): one chain for one saved outfit, held in memory only. The encoded body
// photo and the latest intermediate picture live here and are dropped on the result, Close, Stop, a chain end or
// disposal (navigation, UID change, logout). A step is sent once: after a lost reply the run reconciles through
// tryon_chain_status and never sends it again by itself. Try again is always the owner's explicit choice.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CancelResult, ChainStatus, StepInput, StepResponse, TryOnClient, TryOnCode, TryOnResult, TryOnStatus } from '../../data/tryon';
import { sha256Hex, TryOnError } from '../../data/tryon';
import { selectTryOnSteps, type TryOnCandidate, type TryOnSelection, type TryOnStep } from '../../domain/tryon';
import type { OutfitComponent, OutfitRecord } from '../../domain/outfits';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import { readTryOnStatus, type TryOnState, type TryOnStore } from '../settings/tryon-store';

export type TryOnApi = {
  current(): boolean;
  step(input: StepInput, signal: AbortSignal): Promise<StepResponse>;
  chainStatus(chainId: string, signal?: AbortSignal): Promise<ChainStatus>;
  cancel(chainId: string, signal?: AbortSignal): Promise<CancelResult>;
};
export type SessionStop = { stopped(): boolean; recordStep(outcome: 'ok' | 'failed' | 'other'): void };
export type RunEnvironment = {
  online(): boolean;
  /** Calls back once the device is online again; returns a remover. */
  whenOnline(callback: () => void): () => void;
  setTimer(callback: () => void, ms: number): () => void;
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
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    sha256: sha256Hex,
  };
}

export type FailureKind = 'filteredPhoto' | 'filteredGarment' | 'busy' | 'allowance' | 'failed' | 'lost' | 'mismatch'
  | 'turnedOff' | 'resultsFull' | 'unavailable';
/** What each failure offers first; Close is always offered as well. */
export const failureAction: Readonly<Record<FailureKind, 'retry' | 'photo' | 'restart' | null>> = Object.freeze({
  filteredPhoto: 'photo', filteredGarment: 'retry', busy: 'retry', allowance: null, failed: 'retry', lost: 'restart',
  mismatch: 'restart', turnedOff: null, resultsFull: null, unavailable: null,
});

export type RunPhase =
  | { kind: 'ready' }
  | { kind: 'running'; index: number }
  | { kind: 'checking'; index: number; offline: boolean }
  | { kind: 'stopping'; index: number }
  | { kind: 'failed'; index: number; failure: FailureKind }
  | { kind: 'result'; resultId: string; expiresAtMs: number | null; alreadyFinished: boolean }
  | { kind: 'stopped' };

export const RECONCILE_EVERY_MS = 10_000;
export const RECONCILE_FOR_MS = 240_000;

const failureOf = (code: Exclude<TryOnCode, 'OK'>, index: number): FailureKind => {
  switch (code) {
    case 'FILTERED': return index === 0 ? 'filteredPhoto' : 'filteredGarment';
    case 'RATE_LIMIT': case 'BUSY': return 'busy';
    case 'ALLOWANCE': return 'allowance';
    case 'FAILED': case 'TIMEOUT': case 'OUTPUT_REJECTED': return 'failed';
    case 'CHAIN_MISMATCH': return 'mismatch';
    case 'WITHDRAWN': case 'CONSENT_REQUIRED': return 'turnedOff';
    case 'RESULTS_FULL': return 'resultsFull';
    default: return 'unavailable';
  }
};
const counted = (code: Exclude<TryOnCode, 'OK'>): 'failed' | 'other' => code === 'FAILED' || code === 'TIMEOUT' ? 'failed' : 'other';

export class TryOnRun {
  private phase: RunPhase = { kind: 'ready' };
  private readonly listeners = new Set<() => void>();
  private readonly chainId: string;
  private started = false;
  private disposed = false;
  /** The picture the next attempt sends: the body photo for step 1, then the previous step's picture. */
  private person: Uint8Array<ArrayBuffer> | null;
  private inFlight: AbortController | null = null;
  private stopTimers: (() => void)[] = [];
  private generation = 0;

  constructor(private readonly api: TryOnApi, private readonly session: SessionStop, private readonly env: RunEnvironment,
    readonly outfitId: string, readonly steps: readonly TryOnStep[], photo: Uint8Array<ArrayBuffer>) {
    if (steps.length < 1 || steps.length > 3) throw new TryOnError('INVALID_INPUT');
    this.chainId = env.uuid();
    this.person = photo;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.phase;
  /** Whether a chain may exist on the server for this run (a step was sent at least once). */
  get chainStarted() { return this.started; }
  get id() { return this.chainId; }
  private set(phase: RunPhase) {
    if (this.disposed) return;
    this.phase = phase;
    for (const listener of this.listeners) listener();
  }
  private clearTimers() { for (const stop of this.stopTimers.splice(0)) stop(); }
  private drop() { this.person = null; }
  private live(generation: number) { return !this.disposed && generation === this.generation && this.api.current(); }

  /** Starts the chain, or sends the failed step again after Try again. Nothing is sent while the session stop holds. */
  start(): void {
    const phase = this.phase;
    if (this.disposed || !this.person) return;
    if (phase.kind === 'ready') void this.send(0);
    else if (phase.kind === 'failed' && failureAction[phase.failure] === 'retry') void this.send(phase.index);
  }

  private async send(index: number): Promise<void> {
    const person = this.person;
    if (!person) return;
    if (this.session.stopped()) { this.fail(index, 'unavailable'); return; }
    const generation = ++this.generation;
    this.clearTimers();
    this.set({ kind: 'running', index });
    const controller = new AbortController();
    this.inFlight = controller;
    this.started = true;
    let reply: StepResponse;
    try {
      reply = await this.api.step({ chainId: this.chainId, step: index + 1, requestId: this.env.uuid(), person,
        ...(index === 0 ? { outfitId: this.outfitId } : {}) }, controller.signal);
    } catch (error) {
      if (!this.live(generation)) return;
      this.inFlight = null;
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

  private async handle(index: number, reply: StepResponse, generation: number): Promise<void> {
    const last = index === this.steps.length - 1;
    if (reply.kind === 'result') {
      if (!last) { this.session.recordStep('failed'); this.fail(index, 'failed'); return; }
      this.session.recordStep('ok');
      this.finish(reply.resultId, reply.expiresAtMs, false);
      return;
    }
    if (reply.kind === 'intermediate') {
      const hash = await this.env.sha256(reply.body).catch(() => '');
      if (!this.live(generation)) return;
      if (last || hash !== reply.sha256) { this.session.recordStep('failed'); this.fail(index, 'failed'); return; }
      this.session.recordStep('ok');
      this.person = reply.body;
      void this.send(index + 1);
      return;
    }
    this.session.recordStep(counted(reply.code));
    this.fail(index, failureOf(reply.code, index));
  }

  private fail(index: number, failure: FailureKind) {
    // Only a step that can be sent again keeps its picture in memory.
    if (failureAction[failure] !== 'retry') this.drop();
    this.set({ kind: 'failed', index, failure });
  }
  private finish(resultId: string | null, expiresAtMs: number | null, alreadyFinished: boolean) {
    this.drop();
    this.clearTimers();
    if (resultId === null) { this.set({ kind: 'failed', index: this.steps.length - 1, failure: 'unavailable' }); return; }
    this.set({ kind: 'result', resultId, expiresAtMs, alreadyFinished });
  }

  /** §3.2: the outcome of a sent step is unknown. Check every 10 s while online, for up to 4 minutes. */
  private reconcile(index: number, generation: number) {
    const deadline = this.env.now() + RECONCILE_FOR_MS;
    const tick = async () => {
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
  /** True once the chain status decides the step. */
  private settle(index: number, status: ChainStatus): boolean {
    if (status.kind === 'code') {
      if (status.code === 'UNAVAILABLE') return false;
      // No chain: step 1 was never claimed, so nothing was charged and the same photo can be sent again.
      if (index === 0) { this.fail(index, 'failed'); return true; }
      this.fail(index, 'unavailable');
      return true;
    }
    switch (status.state) {
      case 'complete': this.session.recordStep('ok'); this.finish(status.resultId, null, false); return true;
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
    if (reply?.code === 'COMPLETED') { this.finish(reply.resultId, null, true); return; }
    if (reply?.code === 'CANCELLED' || reply?.code === 'NOT_FOUND' || reply?.code === 'EXPIRED') { this.set({ kind: 'stopped' }); return; }
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
    this.generation += 1;
    this.clearTimers();
    this.inFlight?.abort();
    this.inFlight = null;
    this.drop();
    this.disposed = true;
    this.listeners.clear();
  }
  /** For tests: whether picture bytes are still held. */
  holdsPicture(): boolean { return this.person !== null; }
}

/** The outfit's garments in saved order, as the step selection sees them. Removed or unknown items are skipped. */
export function tryOnCandidates(record: OutfitRecord, components: ReadonlyMap<string, OutfitComponent>): TryOnCandidate[] {
  return record.links.flatMap(({ itemId }) => {
    const component = components.get(itemId);
    if (!component || component.category === null || component.lifecycle === null) return [];
    return [{ itemId, category: component.category, lifecycle: component.lifecycle,
      deleted: component.state === 'trashed' || component.state === 'missing', readyImage: component.thumbPath !== null }];
  });
}
export function tryOnSelection(record: OutfitRecord, components: ReadonlyMap<string, OutfitComponent>): TryOnSelection {
  return selectTryOnSteps(tryOnCandidates(record, components));
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

/** Saved try-ons of one outfit, newest first; each stays until it expires or is deleted. */
export function useOutfitTryOns(api: TryOnClient | null, outfitId: string, enabled: boolean): TryOnResult[] {
  const [results, setResults] = useState<TryOnResult[]>([]);
  useEffect(() => {
    if (!api || !enabled) { setResults([]); return; }
    const controller = new AbortController();
    api.results(controller.signal).then(list => {
      if (controller.signal.aborted || list === 'missing') return;
      const now = Date.now();
      setResults(list.filter(entry => entry.outfitId === outfitId && entry.expiresAtMs > now)
        .sort((a, b) => b.completedAtMs - a.completedAtMs));
    }, () => undefined);
    return () => controller.abort();
  }, [api, outfitId, enabled]);
  return results;
}
