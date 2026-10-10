// BULK2b (plan rev3 §A–§C): the batch scheduler. Pure and in memory: it grants per-stage slots across photos (never
// within one photo, whose order stays prepare → clean-up → one analysis) and enforces the analysis reservation bound.
import type { StageResult } from '../enhancement-stage';

export const BATCH_LIMIT = 50;
export const SLOTS = { prepare: 1, cleanup: 1, analysis: 2 } as const;
/** A taken provider slot (`busy`) is retried with the same clean-up input after these waits, then falls back. */
export const BUSY_DELAYS_MS = [20_000, 40_000, 80_000] as const;
/** Monthly allowance a photo may use: analysis and clean-up actuals (plan rev3, cost). */
export const PHOTO_ESTIMATE_MICRO = 40_000n;
const notSent: StageResult = Object.freeze({ kind: 'skipped', line: 'none', requestId: null });

export type Halt = 'allowance';
export type Refusal = 'stopped' | 'paused' | Halt;
export type QueueSnapshot = Readonly<{
  stopped: boolean; paused: boolean; hidden: boolean;
  halted: Readonly<{ cleanup: Halt | null; analysis: Halt | null }>;
}>;
/**
 * One analysis request's hold on an A slot. `send` is called synchronously at the send boundary, right before the
 * POST: null means send now; otherwise nothing may be sent and the slot is freed (`hidden`: admit again once visible).
 * Only `resolved` (a proven accounting resolution) frees a sent request's slot; `abandon` frees a slot only when
 * nothing was sent, and makes a sent request uncertain, which keeps the slot for the rest of the batch.
 */
export type AnalysisTicket = Readonly<{ send(): Refusal | 'hidden' | null; resolved(code?: string): void; abandon(): void }>;
/** Clean-up's send boundary: null sends; `hidden` defers the run until visible; `refused` sends nothing. */
export type Dispatchable = () => 'hidden' | 'refused' | null;
export type AnalysisGate = Readonly<{
  /** A ticket, a refusal (nothing may be sent), or null when the signal aborted first. */
  admit(signal: AbortSignal, manual: boolean): Promise<AnalysisTicket | Refusal | null>;
}>;
type Ticket = { state: 'held' | 'dispatched' | 'uncertain' | 'done' };
type Kind = 'prepare' | 'cleanup' | 'analysis';
type Waiter = { kind: Kind; manual: boolean; grant: (value: unknown) => void; drop: () => void };

export function remainingMicro(monthly: string, accounted: string): bigint {
  const left = BigInt(monthly) - BigInt(accounted);
  return left > 0n ? left : 0n;
}
/** The pre-start estimate is shown only when the batch may use more than what is left this month. */
export function estimateMicro(photos: number, remaining: bigint): bigint | null {
  const estimate = BigInt(photos) * PHOTO_ESTIMATE_MICRO;
  return estimate > remaining ? estimate : null;
}

export class BulkQueue {
  private running = { prepare: 0, cleanup: 0 };
  private tickets = new Set<Ticket>();
  private waiters: Waiter[] = [];
  private listeners = new Set<() => void>();
  private stopController = new AbortController();
  private visibleWaiters = new Set<() => void>();
  // Aborted whenever the page is hidden: a waiting busy backoff is cancelled, not resumed by itself.
  private hideController = new AbortController();
  private state: QueueSnapshot;
  constructor(hidden = false, private readonly delays: readonly number[] = BUSY_DELAYS_MS,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = wait) {
    this.state = Object.freeze({ stopped: false, paused: false, hidden, halted: Object.freeze({ cleanup: null, analysis: null }) });
    if (hidden) this.hideController.abort();
  }
  snapshot = (): QueueSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Ends automatic clean-up and analysis for the batch. Requests already sent are never aborted. */
  stop() { if (this.state.stopped) return; this.stopController.abort(); this.update({ stopped: true }); }
  halt(kind: 'cleanup' | 'analysis', reason: Halt) {
    if (this.state.halted[kind]) return;
    this.update({ halted: Object.freeze({ ...this.state.halted, [kind]: reason }) });
  }
  setHidden(hidden: boolean) {
    if (this.state.hidden === hidden) return;
    if (hidden) this.hideController.abort(); else this.hideController = new AbortController();
    this.update({ hidden });
    if (!hidden) for (const resume of [...this.visibleWaiters]) resume();
  }
  /** A slots: occupied (held, sent or uncertain) and uncertain. */
  analysisSlots(): { occupied: number; uncertain: number } {
    let uncertain = 0;
    for (const ticket of this.tickets) if (ticket.state === 'uncertain') uncertain++;
    return { occupied: this.tickets.size, uncertain };
  }
  /** P and C slots: a release function, a refusal, or null when aborted while waiting. */
  acquire(kind: 'prepare' | 'cleanup', signal: AbortSignal, manual = false): Promise<(() => void) | Refusal | null> {
    return this.enqueue(kind, signal, manual) as Promise<(() => void) | Refusal | null>;
  }
  readonly analysis: AnalysisGate = {
    admit: (signal, manual) => this.enqueue('analysis', signal, manual) as Promise<AnalysisTicket | Refusal | null>,
  };
  /** The prepare slot around preparation and background removal. Aborting while waiting throws an AbortError. */
  async prepare<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const slot = await this.acquire('prepare', signal);
    if (typeof slot !== 'function') throw new DOMException('Aborted', 'AbortError');
    try { return await work(); } finally { slot(); }
  }
  /**
   * The clean-up slot around one stage run. A refused run sends nothing and keeps the cut-out. `busy` keeps the slot
   * and the same input through the bounded backoff, and only for a refusal before any claim; `allowance` stops automatic
   * clean-ups for the batch.
   * `run` checks `dispatchable` right before it sends. Hiding the page cancels a waiting backoff; once visible, the
   * same input is sent again only if the run is still eligible.
   */
  async cleanup(run: (dispatchable: Dispatchable) => Promise<StageResult>, signal: AbortSignal, manual: boolean): Promise<StageResult> {
    const slot = await this.acquire('cleanup', signal, manual);
    if (slot === null) return { kind: 'aborted' };
    if (typeof slot !== 'function') return notSent;
    const dispatchable: Dispatchable = () => this.state.hidden ? 'hidden' : this.refusal('cleanup', manual) ? 'refused' : null;
    const waited = manual ? signal : AbortSignal.any([signal, this.stopController.signal]);
    const resume = async (): Promise<boolean> => {
      await this.whenVisible(waited);
      return !this.refusal('cleanup', manual);
    };
    try {
      for (let attempt = 0; ;) {
        const result = await run(dispatchable);
        if (result.kind !== 'skipped' || !result.reason) return result;
        try {
          if (result.reason === 'deferred') { if (await resume()) continue; return notSent; }
          if (result.reason === 'allowance') { this.halt('cleanup', result.reason); return result; }
          const delay = this.delays[attempt++];
          if (result.reason !== 'busy' || delay === undefined) return result;
          try { await this.sleep(delay, AbortSignal.any([waited, this.hideController.signal])); }
          catch (error) { if (waited.aborted || !this.state.hidden) throw error; }
          if (!await resume()) return result;
        } catch { return signal.aborted ? { kind: 'aborted' } : result.reason === 'deferred' ? notSent : result; }
      }
    } finally { slot(); }
  }
  /** Drops every waiter: the owner scope ended or the screen closed. */
  dispose() {
    for (const waiter of this.waiters.splice(0)) { waiter.drop(); waiter.grant(null); }
    this.stopController.abort();
    this.listeners.clear();
  }

  private whenVisible(signal: AbortSignal): Promise<void> {
    if (!this.state.hidden) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { this.visibleWaiters.delete(done); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.visibleWaiters.delete(done); reject(new DOMException('Aborted', 'AbortError')); };
      if (signal.aborted) { abort(); return; }
      this.visibleWaiters.add(done);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  private refusal(kind: Kind, manual: boolean): Refusal | null {
    if (kind === 'prepare') return null;
    if (kind === 'analysis' && this.state.paused) return 'paused';
    if (manual) return null;
    if (this.state.stopped) return 'stopped';
    return this.state.halted[kind];
  }
  private free(kind: Kind): boolean {
    if (this.state.hidden) return false;
    return kind === 'analysis' ? this.tickets.size < SLOTS.analysis : this.running[kind] < SLOTS[kind];
  }
  private enqueue(kind: Kind, signal: AbortSignal, manual: boolean): Promise<unknown> {
    if (signal.aborted) return Promise.resolve(null);
    const refused = this.refusal(kind, manual);
    if (refused) return Promise.resolve(refused);
    return new Promise((grant) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) { this.waiters.splice(index, 1); grant(null); }
      };
      const waiter: Waiter = { kind, manual, grant, drop: () => signal.removeEventListener('abort', onAbort) };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }
  private pump() {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      const refused = this.refusal(waiter.kind, waiter.manual);
      if (refused) { this.waiters.splice(index, 1); waiter.drop(); waiter.grant(refused); continue; }
      if (!this.free(waiter.kind)) { index++; continue; }
      this.waiters.splice(index, 1);
      waiter.drop();
      waiter.grant(waiter.kind === 'analysis' ? this.ticket(waiter.manual) : this.slot(waiter.kind));
    }
  }
  private slot(kind: 'prepare' | 'cleanup'): () => void {
    this.running[kind]++;
    let released = false;
    return () => { if (released) return; released = true; this.running[kind]--; this.pump(); };
  }
  private ticket(manual: boolean): AnalysisTicket {
    const ticket: Ticket = { state: 'held' };
    this.tickets.add(ticket);
    const free = () => { ticket.state = 'done'; this.tickets.delete(ticket); this.recount(); };
    return Object.freeze({
      send: () => {
        if (ticket.state === 'dispatched') return null;
        if (ticket.state !== 'held') return 'stopped';
        const blocked = this.refusal('analysis', manual) ?? (this.state.hidden ? 'hidden' : null);
        if (blocked) free(); else ticket.state = 'dispatched';
        return blocked;
      },
      resolved: (code?: string) => {
        if (code === 'ALLOWANCE') this.halt('analysis', 'allowance');
        if (ticket.state !== 'done') free();
      },
      abandon: () => {
        if (ticket.state === 'held') free();
        else if (ticket.state === 'dispatched') { ticket.state = 'uncertain'; this.recount(); }
      },
    });
  }
  private recount() {
    const paused = this.analysisSlots().uncertain >= SLOTS.analysis;
    if (paused !== this.state.paused) this.update({ paused }); else this.pump();
  }
  private update(change: Partial<QueueSnapshot>) {
    this.state = Object.freeze({ ...this.state, ...change });
    this.pump();
    for (const listener of [...this.listeners]) listener();
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
