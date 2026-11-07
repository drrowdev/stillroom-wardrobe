// OUTFITGEN2: the automatic pictures of the owner wearing each suggested outfit. One queue per owner scope, in memory only, driven
// by the client: it makes one picture at a time through the same try-on chain the owner can start by hand, for a suggestion that has
// none, and nothing here is stored or cached beyond the scope. The saved reference photo is fetched for one chain and handed to the
// run, which drops it at the end; results are read with authentication and shown through Blob URLs the picture component revokes.
//
// Single flight, in three layers: one pass at a time in this window; a Web Lock per owner across windows, held for one chain; and the
// server's own count (more stored-or-reserved pictures than ready ones means a chain is running, for example one a reloaded page
// left behind: its paid steps cannot be resumed). Every send asks the gate first, including the first and every BUSY retry.
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { PublicConfig } from '../../data/config';
import { loadComponents } from '../../data/outfits';
import { tryOnReady, supportedTryOnPolicy, type TryOnResult } from '../../data/tryon';
import { AI_GUARD_RESUMED_EVENT } from '../../domain/ai-guard';
import type { TryOnStep } from '../../domain/tryon';
import type { OutfitComponent } from '../../domain/outfits';
import type { Suggestion } from '../../domain/outfitgen-app';
import {
  addStepSample, classifyFailure, estimateMinutesLeft, noReserved, PICTURE_LIMITS, pictureBlock, pictureIndex, pictureTargets, plannedKey, removableResults,
  reserveBlock, reservedGate, slowStepMs,
  type PictureBlock, type PictureResult, type ReservedMemory,
} from '../../domain/outfitgen-pictures';
import { TryOnRun, browserEnvironment, ideaSelection, type RunEnvironment, type RunGate, type RunPhase } from '../outfits/use-try-on';
import { loadPersonPhoto, readPersonPhoto } from '../settings/tryon-photo';
import { readTryOnStatus, tryOnStoreFor, type TryOnStore } from '../settings/tryon-store';
import { outfitGenStoreFor, readList, readStatus, viewOf, type OutfitGenStore } from './outfitgen-store';

/** The one line the Suggested outfits section shows when pictures are not being made, or `null`. */
export type PictureLine = 'tryOnOff' | 'tryOnPaused' | 'noPhoto' | 'full' | 'budget' | 'retryLater' | 'guard'
  | 'otherWindow' | 'otherPicture' | 'ownTryOn' | 'cleanup' | 'stopping' | 'unreadable' | 'noLocks' | 'missing' | 'offline';
/** Why the picture being made is not moving: the provider is busy, a try-on of the owner holds it, or an outcome is being checked. */
export type MakingReason = 'working' | 'busy' | 'holding' | 'checking';
export type Making = {
  id: string; ordinal: number; of: number;
  /** The step in progress (1-based) and the steps that finished before it. */
  step: number; steps: number; completedSteps: number;
  reason: MakingReason;
  /** The step has taken much longer than usual. Only a message: nothing is sent or cancelled because of it. */
  slow: boolean;
};
export type PictureState = {
  /** The newest idea picture of each planned garment set; `null` until the results have been read. */
  pictures: ReadonlyMap<string, PictureResult> | null;
  making: Making | null;
  /** Pictures finished since the queue started, and how many it has taken on; failures and skips are not counted. */
  done: number;
  total: number;
  /** Whole minutes still needed for the steps left (0: under a minute), or `null` when unknown or when nothing is being made. */
  minutesLeft: number | null;
  /** Suggestions the queue will make a picture for after the current one. */
  waiting: ReadonlySet<string>;
  line: PictureLine | null;
  /** When a timed line says it will look again; `null` for lines that wait for an event. */
  lineAtMs: number | null;
  /** Suggestions that have no picture and will not get one on their own (skipped or failed twice). */
  missing: number;
  /** Suggestions whose pictures are being deleted (Remove); Undo waits for them. */
  deleting: ReadonlySet<string>;
  /** A picture of a removed suggestion could not be deleted; it stays under Today's try-ons. */
  deleteFailed: boolean;
};
const initial: PictureState = { pictures: null, making: null, done: 0, total: 0, minutesLeft: null, waiting: new Set(), line: null, lineAtMs: null,
  missing: 0, deleting: new Set(), deleteFailed: false };

type Context = {
  id: string; key: string; steps: number; ordinal: number; of: number; run: TryOnRun | null; photoGeneration: number;
  cancelled: boolean; gated: boolean; settled: boolean; cancel: () => void;
};
type Stop = { reason: 'busy' | 'allowance' | 'consent' | 'full' | 'guard' | 'failed'; until: number; signature: string };
type Locks = { request: <T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T>) => Promise<T> };

const lineOf: Record<Stop['reason'], PictureLine | null> = {
  busy: 'retryLater', allowance: 'budget', consent: null, full: 'full', guard: 'guard', failed: 'retryLater',
};
const blockLine: Partial<Record<PictureBlock, PictureLine>> = { tryOn: 'tryOnOff', photo: 'noPhoto', guard: 'guard', offline: 'offline', foreground: 'ownTryOn' };

export class PictureQueue {
  private state: PictureState = initial;
  private readonly listeners = new Set<() => void>();
  private readonly outfit: OutfitGenStore;
  private readonly tryOn: TryOnStore;
  private readonly components = new Map<string, OutfitComponent>();
  private readonly attempts = new Map<string, number>();
  private readonly skipped = new Set<string>();
  private readonly intents = new Map<string, 'keep' | 'remove'>();
  private readonly deleting = new Set<string>();
  /** Removed suggestions whose cleanup is not done: a chain not shown to be over, or a picture not deleted. Kept until it succeeds. */
  private readonly pending = new Map<string, Suggestion>();
  private lastCleanupMs = 0;
  private readonly openChains = new Map<string, string>();
  /** Chains of this queue's own runs that were given up without a confirmed end. Nothing new starts until each is shown to be over. */
  private readonly abandoned = new Set<string>();
  private resultsSeq = 0;
  private reserved: ReservedMemory = noReserved;
  private stepSamples: number[] = [];
  /** The suggestions waiting behind the picture being made, with their step counts, so the time left follows a skip or a Remove. */
  private readonly queued = new Map<string, number>();
  private stop: Stop | null = null;
  private failures = 0;
  private deferrals = 0;
  private finished = 0;
  private guardPaused = false;
  private passing = false;
  private scheduled = false;
  private again = false;
  private started = false;
  private disposed = false;
  private current: Context | null = null;
  private signature = '';
  private timer: (() => void) | null = null;
  private teardown: (() => void)[] = [];

  constructor(private readonly client: AppClient, private readonly scope: OwnerScope, outfit: OutfitGenStore, tryOn: TryOnStore,
    private readonly env: RunEnvironment = browserEnvironment()) {
    this.outfit = outfit;
    this.tryOn = tryOn;
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.disposed = true;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;
  /** The try-on client the pictures are read with. */
  get api() { return this.tryOn.api; }
  private emit(patch: Partial<PictureState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Begins watching. Idempotent, so a remount (StrictMode) or a second caller changes nothing. */
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const changed = () => this.changed();
    const online = () => this.kick();
    this.teardown.push(this.outfit.subscribe(changed), this.tryOn.subscribe(changed), this.tryOn.subscribePhoto(changed),
      this.tryOn.subscribeForeground(changed));
    window.addEventListener('online', online);
    window.addEventListener('focus', online);
    document.addEventListener('visibilitychange', online);
    const resumed = () => { this.guardPaused = false; if (this.stop?.reason === 'guard') this.stop = null; this.kick(); };
    window.addEventListener(AI_GUARD_RESUMED_EVENT, resumed);
    this.teardown.push(() => {
      window.removeEventListener('online', online);
      window.removeEventListener('focus', online);
      document.removeEventListener('visibilitychange', online);
      window.removeEventListener(AI_GUARD_RESUMED_EVENT, resumed);
    });
    this.kick();
  }
  /** For the section on screen: reads the saved pictures without starting a chain. */
  async refreshPictures(): Promise<void> {
    if (this.disposed || !navigator.onLine) return;
    await this.readResults();
  }

  /** Marks that the owner is deciding this suggestion (Keep or Remove); the returned function ends the mark. */
  intend(id: string, kind: 'keep' | 'remove'): () => void {
    this.intents.set(id, kind);
    this.refreshEstimate();
    return () => { if (this.intents.get(id) === kind) this.intents.delete(id); this.watchCurrent(); this.refreshEstimate(); this.kick(); };
  }

  /**
   * After Remove: stops this suggestion's chain and makes sure the server shows it ended, then deletes the pictures of its planned set
   * that finished after the suggestion was created. Everything older stays. Anything that cannot be established or done leaves the
   * cleanup pending: the warning stays, Undo stays off, and a later pass (or Retry) runs it again, so a result that completes late is
   * still deleted. Nothing here retries on its own more often than every few seconds.
   */
  async discard(suggestion: Suggestion): Promise<void> {
    if (this.disposed || this.deleting.has(suggestion.id)) return;
    this.deleting.add(suggestion.id);
    this.emitBusy();
    let done = false;
    try { done = await this.cleanup(suggestion); } catch { done = false; }
    finally {
      this.deleting.delete(suggestion.id);
      if (done) this.pending.delete(suggestion.id); else this.pending.set(suggestion.id, suggestion);
      if (!this.disposed) {
        this.emitBusy();
        await this.readResults();
        this.kick();
      }
    }
  }
  /** Runs every pending cleanup again (the Retry button, and a later pass). */
  async retryCleanup(): Promise<void> {
    for (const suggestion of [...this.pending.values()]) {
      if (this.disposed || !navigator.onLine) return;
      await this.discard(suggestion);
    }
  }
  private emitBusy() {
    this.emit({ deleting: new Set([...this.deleting, ...this.pending.keys()]), deleteFailed: this.pending.size > 0 });
  }

  private async cleanup(suggestion: Suggestion): Promise<boolean> {
    const active = this.current;
    if (active && active.id === suggestion.id) {
      active.cancelled = true;
      const run = active.run;
      await run?.stop().catch(() => undefined);
      active.cancel();
      if (run && run.chainStarted) {
        const phase = run.get();
        if (phase.kind !== 'stopped' && phase.kind !== 'result') this.openChains.set(suggestion.id, run.id);
      }
    }
    // A chain that was not shown to be over stays open until a later attempt does show it, so a late result is deleted too.
    const open = this.openChains.get(suggestion.id);
    if (open !== undefined) {
      if (!await this.chainEnded(open)) return false;
      this.openChains.delete(suggestion.id);
    }
    const resolved = await this.keyOf(suggestion);
    if (resolved === 'unresolved') return false;
    // A plan too short for a picture never had one made: there is nothing to delete.
    if (resolved === null) return true;
    const key = resolved;
    const fresh = await this.tryOn.api.results().catch(() => null);
    if (this.disposed) return true;
    if (fresh === null || fresh === 'missing') return false;
    let ok = true;
    for (const id of removableResults(fresh, key, suggestion.createdAtMs)) {
      const outcome = await this.tryOn.api.deleteResult(id).catch(() => null);
      if (this.disposed) return true;
      if (outcome === null) ok = false;
    }
    return ok;
  }
  /**
   * Whether the chain is over: it shows a terminal state, or a cancel is confirmed (the cancel is sent again here, so a failed one is retried).
   * An unknown chain (NOT_FOUND) is not over: a step already sent can still claim, and only a successful cancel leaves the durable stop marker.
   */
  private async chainEnded(chainId: string): Promise<boolean> {
    const status = await this.tryOn.api.chainStatus(chainId).catch(() => null);
    if (status?.kind === 'chain' && status.state !== 'running') return true;
    const reply = await this.tryOn.api.cancel(chainId).catch(() => null);
    return reply !== null && ['CANCELLED', 'COMPLETED', 'EXPIRED', 'WITHDRAWN', 'STALE'].includes(reply.code);
  }
  dispose() {
    if (this.disposed) return;
    this.cancelCurrent();
    this.disposed = true;
    this.timer?.();
    this.timer = null;
    for (const undo of this.teardown.splice(0)) undo();
    this.listeners.clear();
    this.components.clear();
    this.state = initial;
  }

  // Triggers -----------------------------------------------------------------------------------------------------------------------

  private sign(): string {
    const o = this.outfit.get(), t = this.tryOn.get(), p = this.tryOn.getPhoto();
    const status = t.read.kind === 'ready' ? t.read.status : null;
    return [viewOf(o).kind, o.writing, o.unresolved, o.list.suggestions.map((entry) => entry.id).join(','), tryOnReady(status), this.tryOn.stopped(),
      p.read, p.saved?.savedAtMs ?? '', this.tryOn.foregroundActive(), this.guardPaused || this.outfit.guardPaused, this.changing()].join('|');
  }
  private changed() {
    if (this.disposed) return;
    this.watchCurrent();
    this.refreshEstimate();
    if (this.sign() !== this.signature) this.kick();
  }
  private kick() {
    if (this.disposed || !this.started) return;
    if (this.passing) { this.again = true; return; }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.pass(); });
  }
  private poll(ms: number = PICTURE_LIMITS.pollMs) {
    this.timer?.();
    this.timer = this.env.setTimer(() => { this.timer = null; this.kick(); }, ms);
  }

  /** The chain being made loses its suggestion other than through a decision: it is abandoned. Keep lets it finish; Remove stops it in `discard`. */
  private watchCurrent() {
    const ctx = this.current;
    if (!ctx || ctx.cancelled || ctx.settled) return;
    const list = this.outfit.get().list;
    if (list.kind === 'unknown' || list.suggestions.some((entry) => entry.id === ctx.id)) return;
    const intent = this.intents.get(ctx.id);
    if (intent === 'keep') { ctx.settled = true; return; }
    // A Remove in progress ends in discard; if it ends without one (the server refused), the check runs again when the mark is released.
    if (intent === 'remove') return;
    this.cancelCurrent();
  }
  private cancelCurrent() {
    const ctx = this.current;
    if (!ctx || ctx.cancelled) return;
    ctx.cancelled = true;
    ctx.cancel();
  }

  // The pass -----------------------------------------------------------------------------------------------------------------------

  private async pass() {
    if (this.passing || this.disposed) { if (this.passing) this.again = true; return; }
    this.passing = true;
    try {
      let chains = 0;
      do {
        this.again = false;
        while (!this.disposed && chains < 80 && await this.once() === 'ran') chains++;
      } while (this.again && !this.disposed);
    } finally {
      this.passing = false;
      if (!this.disposed) this.emit({ making: null });
    }
  }

  private inputs() {
    const o = this.outfit.get(), p = this.tryOn.getPhoto(), t = this.tryOn.get();
    const view = viewOf(o);
    const status = t.read.kind === 'ready' ? t.read.status : null;
    return {
      consentOn: view.kind === 'on', consentChanging: this.changing(),
      guardPaused: this.guardPaused || this.outfit.guardPaused, tryOnReady: tryOnReady(status), sessionStopped: this.tryOn.stopped(),
      photo: p.read === 'unknown' || (p.read === 'failed' && p.saved === null) ? 'unknown' as const : p.saved ? 'saved' as const : 'none' as const,
      online: navigator.onLine, visible: document.visibilityState === 'visible', foreground: this.tryOn.foregroundActive(),
      cooldownUntilMs: this.stop?.until ?? null, nowMs: Date.now(),
    };
  }
  /** A consent or photo change is pending in either store: nothing is admitted or sent until it settles. */
  private changing(): boolean {
    const o = this.outfit, t = this.tryOn, tryOnState = t.get();
    return o.get().writing || o.get().unresolved || o.writePromise !== null
      || tryOnState.writing || tryOnState.unresolved || t.writePromise !== null || t.getPhoto().busy !== null;
  }
  private stopSignature() {
    const t = this.tryOn.get(), p = this.tryOn.getPhoto();
    return [viewOf(this.outfit.get()).kind, t.read.kind === 'ready' ? t.read.status.consent?.enabled : '', p.saved?.savedAtMs ?? ''].join('|');
  }
  private setStop(reason: Stop['reason'], forMs: number | null) {
    this.stop = { reason, until: forMs === null ? Number.POSITIVE_INFINITY : Date.now() + forMs, signature: this.stopSignature() };
    if (reason === 'guard') this.guardPaused = true;
    if (forMs !== null) this.poll(forMs);
    this.emit({ line: lineOf[reason], lineAtMs: forMs === null ? null : this.stop.until, waiting: new Set(), minutesLeft: null });
  }
  /** Shows one line (or none) and says when the queue looks again: after `wakeMs` (the line then names the time) or, with `null`, on an event. */
  private idle(line: PictureLine | null, wakeMs: number | null = null, patch: Partial<PictureState> = {}): 'idle' {
    this.emit({ line, lineAtMs: wakeMs === null ? null : Date.now() + wakeMs, waiting: new Set(), minutesLeft: null, ...patch });
    if (wakeMs !== null) this.poll(wakeMs);
    return 'idle';
  }
  /** Try-on is on for this owner but the service is unavailable for now (provider paused, or the status itself unavailable). */
  private tryOnPaused(): boolean {
    const read = this.tryOn.get().read;
    if (read.kind !== 'ready') return false;
    const status = read.status;
    if (status.code === 'UNAVAILABLE') return true;
    return status.code === 'OK' && status.consent?.enabled === true && status.policy?.activated === true && supportedTryOnPolicy(status)
      && !status.policy.providerAvailable;
  }
  private blocked(block: PictureBlock): 'idle' {
    const known = this.tryOn.get().read.kind === 'ready';
    const cooldown = block === 'cooldown';
    // A read that failed is tried again by the poll, and said so; waiting for a read that is merely not done yet is not worth a line.
    const unknown = block === 'unresolved' || (block === 'tryOn' && !known);
    const retrying = unknown && this.readFailed() && navigator.onLine;
    const paused = block === 'tryOn' && known && this.tryOnPaused();
    const line = cooldown ? lineOf[this.stop?.reason ?? 'failed'] : unknown ? (retrying ? 'unreadable' : null) : paused ? 'tryOnPaused' : blockLine[block] ?? null;
    const until = cooldown && this.stop && Number.isFinite(this.stop.until) ? this.stop.until : null;
    this.emit({ line, lineAtMs: retrying || paused ? Date.now() + PICTURE_LIMITS.pollMs : until, waiting: new Set(), minutesLeft: null });
    if ((this.readFailed() || paused) && navigator.onLine) this.poll();
    if (until !== null) this.poll(Math.max(1_000, until - Date.now()));
    return 'idle';
  }

  /** One evaluation: reads what is stale, checks the gates, makes at most one picture. `ran` means a chain ended and another may follow. */
  private async once(): Promise<'ran' | 'idle'> {
    if (this.disposed) return 'idle';
    if (this.stop && (this.stop.signature !== this.stopSignature() || Date.now() >= this.stop.until)) this.stop = null;
    if (this.pending.size > 0 && Date.now() - this.lastCleanupMs > 15_000) { this.lastCleanupMs = Date.now(); await this.retryCleanup(); this.poll(); }
    await this.refresh();
    if (this.disposed) return 'idle';
    this.signature = this.sign();
    const block = pictureBlock(this.inputs());
    if (block !== null) return this.blocked(block);
    const locks = (navigator as unknown as { locks?: Locks }).locks;
    // Without Web Locks there is no way to keep two windows apart, so nothing is made automatically.
    if (!locks) return this.idle('noLocks');
    try {
      return await locks.request(`stillroom-pictures-${this.scope.ownerId}`, { ifAvailable: true }, async (held) => {
        if (!held) return this.idle('otherWindow', PICTURE_LIMITS.pollMs);
        return this.underLock();
      });
    } catch {
      return this.disposed ? 'idle' : this.idle('unreadable', PICTURE_LIMITS.pollMs);
    }
  }

  private unread(kind: string) { return kind === 'unknown' || kind === 'failed'; }
  /** A status or photo read that failed: the poll tries again while online, so the queue does not wait for an unrelated trigger. */
  private readFailed(): boolean {
    return [this.outfit.get().read.kind, this.tryOn.get().read.kind, this.tryOn.getPhoto().read].includes('failed');
  }

  private async refresh() {
    const o = this.outfit;
    // A failed read is tried again on every pass (and by the poll in locked), but nothing is admitted until a fresh read succeeds.
    if (this.unread(o.get().read.kind)) await readStatus(o);
    if (this.disposed || viewOf(o.get()).kind !== 'on') return;
    if (o.get().list.kind === 'unknown') await readList(o);
    if (this.disposed || !navigator.onLine) return;
    const t = this.tryOn;
    if (this.unread(t.get().read.kind)) await readTryOnStatus(t, 'active');
    // A try-on that is on but paused by the service is read again on every look, before its cached state blocks anything.
    else if (this.tryOnPaused()) await readTryOnStatus(t, 'fresh');
    if (this.unread(t.getPhoto().read)) await readPersonPhoto(t);
    if (!this.disposed && o.get().list.suggestions.length > 0 && this.state.pictures === null) await this.readResults();
  }

  private async readResults(): Promise<readonly TryOnResult[] | null> {
    const at = ++this.resultsSeq;
    const list = await this.tryOn.api.results().catch(() => null);
    if (this.disposed || list === null) return null;
    const results = list === 'missing' ? [] : list;
    if (at === this.resultsSeq) {
      this.emit({ pictures: pictureIndex(results), deleteFailed: this.pending.size > 0 });
    }
    // A missing list is shown as empty but never counts as a usable one: nothing is made without knowing what already exists.
    return list === 'missing' ? null : results;
  }

  private async ensureComponents(list: readonly Suggestion[]): Promise<boolean> {
    const missing = [...new Set(list.flatMap((entry) => entry.itemIds))].filter((id) => !this.components.has(id));
    if (!missing.length) return true;
    try {
      const loaded = await loadComponents(this.client, this.scope, missing, this.scope.signal);
      if (this.disposed) return false;
      for (const [id, component] of loaded) this.components.set(id, component);
      return true;
    } catch { return false; }
  }
  /** The planned set's key, 
ull for a plan too short to get a picture, or 'unresolved' when the garments could not be read. */
  private async keyOf(suggestion: Suggestion): Promise<string | null | 'unresolved'> {
    if (!await this.ensureComponents([suggestion])) return 'unresolved';
    return plannedKey(ideaSelection(suggestion.itemIds, this.components).steps);
  }

  private async underLock(): Promise<'ran' | 'idle'> {
    const t = this.tryOn, o = this.outfit;
    // First, this queue's own given-up chains must be shown to be over (their cancel was only sent). One of them may finish its picture
    // meanwhile, so everything below is read and decided after this, never before. Kept apart from the best-effort foreign-count gate.
    if (this.abandoned.size > 0 && !await this.settleAbandoned()) return this.disposed ? 'idle' : this.idle('stopping', PICTURE_LIMITS.pollMs);
    if (this.disposed) return 'idle';
    // Consent is read again before every chain, so a withdrawal in another window is seen; unknown or failed means nothing is made.
    const consent = await readStatus(o, 'fresh');
    if (this.disposed) return 'idle';
    if (!consent) return this.idle('unreadable', PICTURE_LIMITS.pollMs);
    // Consent is off: the section says so itself, and turning it on starts the queue again.
    if (viewOf(o.get()).kind !== 'on') return this.idle(null);
    const status = await readTryOnStatus(t, 'fresh');
    if (this.disposed) return 'idle';
    if (!status) return t.get().read.kind === 'failed' ? this.idle('unreadable', PICTURE_LIMITS.pollMs) : this.idle(null, PICTURE_LIMITS.pollMs);
    const ready = await this.readResults();
    if (this.disposed) return 'idle';
    if (!ready) return this.idle('unreadable', PICTURE_LIMITS.pollMs);
    const block = pictureBlock(this.inputs());
    if (block !== null) return this.blocked(block);
    if (status.results >= PICTURE_LIMITS.resultsStop) return this.idle('full', PICTURE_LIMITS.stopMs / 6);
    // A removed suggestion's chain that is not shown to be over may still claim: nothing new starts until it is.
    if (this.openChains.size > 0) return this.idle('cleanup', PICTURE_LIMITS.pollMs);
    const gate = reservedGate(this.reserved, status.results, ready.length, Date.now());
    this.reserved = gate.memory;
    if (gate.wait) return this.idle('otherPicture', PICTURE_LIMITS.pollMs);
    const list = o.get().list.suggestions;
    if (!await this.ensureComponents(list)) return this.idle('unreadable', PICTURE_LIMITS.pollMs);
    const candidates = list.map((entry) => {
      const steps = ideaSelection(entry.itemIds, this.components).steps;
      return { id: entry.id, key: plannedKey(steps), steps };
    });
    const have = pictureIndex(ready);
    const excluded = new Set([...this.intents.keys(), ...this.deleting, ...this.pending.keys()]);
    const targets = pictureTargets(candidates, { have, attempts: this.attempts, skipped: this.skipped, excluded });
    if (!targets.length) {
      const done = this.finished;
      this.finished = 0;
      this.queued.clear();
      // Outfits that have no picture and will not get one on their own (skipped, failed twice, or a plan too short for a picture) are said,
      // not left unexplained. A too-short plan counts by suggestion; suggestions sharing a planned set share one picture.
      const open = candidates.filter((entry) => !excluded.has(entry.id));
      const missing = open.filter((entry) => entry.key === null).length
        + new Set(open.filter((entry) => entry.key !== null && !have.has(entry.key)).map((entry) => entry.key)).size;
      return this.idle(missing > 0 ? 'missing' : null, null, { done, total: done, missing });
    }
    const target = targets[0]!;
    if (reserveBlock(status.budget, status.policy?.maxRequestMicro ?? null, target.steps.length)) return this.idle('budget', PICTURE_LIMITS.stopMs / 6);
    this.queued.clear();
    for (const entry of targets.slice(1)) this.queued.set(entry.id, entry.steps.length);
    this.emit({ line: null, lineAtMs: null, missing: 0, done: this.finished, total: this.finished + targets.length,
      waiting: new Set(targets.slice(1).map((entry) => entry.id)) });
    return this.make(target, targets.length);
  }

  /** Steps still to do: those of the picture in progress and of every suggestion still waiting for its turn. */
  private minutesLeft(steps: number, completed: number): number | null {
    let left = Math.max(0, steps - completed);
    const live = new Set(this.outfit.get().list.suggestions.map((entry) => entry.id));
    for (const [id, count] of this.queued) {
      if (live.has(id) && !this.skipped.has(id) && !this.intents.has(id) && !this.deleting.has(id) && !this.pending.has(id)) left += count;
    }
    return estimateMinutesLeft(this.stepSamples, left);
  }
  /** A card was skipped, decided or removed while a picture is made: the time left follows. */
  private refreshEstimate() {
    const making = this.state.making;
    if (!making) return;
    const minutes = this.minutesLeft(making.steps, making.completedSteps);
    if (minutes !== this.state.minutesLeft) this.emit({ minutesLeft: minutes });
  }

  private async make(target: { id: string; key: string | null; steps: TryOnStep[] }, left: number): Promise<'ran' | 'idle'> {
    const t = this.tryOn;
    const photoGeneration = t.photoGeneration;
    const ctx: Context = { id: target.id, key: target.key!, steps: target.steps.length, ordinal: this.finished + 1, of: this.finished + left, run: null,
      photoGeneration, cancelled: false, gated: false, settled: false, cancel: () => undefined };
    this.current = ctx;
    let cancelSlow = () => {};
    try {
      const loaded = await loadPersonPhoto(t, this.scope.signal);
      if (this.disposed || ctx.cancelled) return 'idle';
      if (loaded.kind !== 'ready') {
        if (loaded.kind === 'none') void readPersonPhoto(t);
        else if (loaded.kind !== 'stale') this.setStop('failed', PICTURE_LIMITS.stopMs);
        return 'idle';
      }
      // The checks that matter run again right here: consent, scope and the photo's generation may have moved during the awaits above.
      if (this.gate(ctx, 0) !== 'go') return this.settle(ctx, null);
      const run = new TryOnRun(t.api, t, this.env, { itemIds: target.steps.map((step) => step.itemId) },
        target.steps, loaded.bytes, { gate: (index) => this.gate(ctx, index) });
      ctx.run = run;
      let unsubscribe = () => {};
      const phase = await new Promise<RunPhase | 'cancelled'>((resolve) => {
        ctx.cancel = () => resolve('cancelled');
        // The step in progress and when it was sent. The slow-step timer belongs to the step: only a new step starts it again, never
        // a repeated report of the same one (checks, BUSY waits), and it only changes the words shown.
        let stepIndex = -1, stepAt = this.env.now(), slow = false;
        const look = () => {
          const now = run.get();
          if ((now.kind === 'running' || now.kind === 'checking' || now.kind === 'stopping') && now.index !== stepIndex) {
            if (stepIndex >= 0 && now.index > stepIndex) this.stepSamples = addStepSample(this.stepSamples, this.env.now() - stepAt);
            stepIndex = now.index; stepAt = this.env.now(); slow = false;
            cancelSlow();
            cancelSlow = this.env.setTimer(() => { slow = true; look(); }, slowStepMs(this.stepSamples));
          }
          if (now.kind === 'result' || now.kind === 'failed' || now.kind === 'stopped') cancelSlow();
          if (now.kind === 'result' && stepIndex >= 0) { this.stepSamples = addStepSample(this.stepSamples, this.env.now() - stepAt); stepIndex = -1; }
          const completed = now.kind === 'result' ? ctx.steps : Math.max(0, stepIndex);
          const reason: Making['reason'] = now.kind === 'checking' ? 'checking'
            : now.kind === 'running' && now.waiting === true ? (this.tryOn.foregroundActive() ? 'holding' : 'busy') : 'working';
          this.emit({ making: { id: ctx.id, ordinal: ctx.ordinal, of: ctx.of, steps: ctx.steps, completedSteps: completed,
            step: Math.min(ctx.steps, completed + 1), reason, slow: slow && now.kind !== 'result' },
          minutesLeft: this.minutesLeft(ctx.steps, completed) });
          if (now.kind === 'result' || now.kind === 'failed' || now.kind === 'stopped') resolve(now);
        };
        unsubscribe = run.subscribe(look);
        look();
        run.start();
      });
      unsubscribe();
      return await this.settle(ctx, phase);
    } finally {
      cancelSlow();
      this.release(ctx.run);
      this.emit({ making: null, minutesLeft: null });
    }
  }

  /**
   * Gives a run up. Its cancel is only sent, not confirmed, so a chain that may still be open on the server is remembered here and nothing new
   * starts until it is shown to be over (see `settleAbandoned`). Remove tracks its own chain in `openChains`.
   */
  private release(run: TryOnRun | null) {
    if (!run) return;
    const kind = run.get().kind;
    if (run.chainStarted && kind !== 'result' && kind !== 'stopped' && ![...this.openChains.values()].includes(run.id)) this.abandoned.add(run.id);
    run.abandon();
  }
  /** Confirms every given-up chain of this queue is over (terminal status, or a confirmed cancel); the cancel is sent again each time. */
  private async settleAbandoned(): Promise<boolean> {
    for (const id of [...this.abandoned]) {
      if (this.disposed) return false;
      if (await this.chainEnded(id)) this.abandoned.delete(id);
    }
    return this.abandoned.size === 0;
  }

  private async settle(ctx: Context, phase: RunPhase | 'cancelled' | null): Promise<'ran' | 'idle'> {
    const run = ctx.run;
    if (phase === null) { this.deferrals++; return this.deferrals >= 3 ? this.parkDeferred() : 'ran'; }
    if (phase === 'cancelled' || ctx.cancelled) { this.release(run); await this.readResults(); return 'ran'; }
    if (phase.kind === 'result') {
      run?.dispose();
      this.attempts.delete(ctx.id);
      this.finished += 1;
      // The queue's own picture adds one stored row; it is not another chain's, so the next look does not take it for a rise.
      if (this.reserved.lastStatus !== null) this.reserved = { ...this.reserved, lastStatus: this.reserved.lastStatus + 1 };
      this.emit({ done: this.finished });
      this.failures = 0;
      this.deferrals = 0;
      await this.readResults();
      return 'ran';
    }
    if (phase.kind !== 'failed') { run?.dispose(); return 'ran'; }
    // Only a failure after step 1 proves the claim went through; before that a refusal may be any of UNAVAILABLE, INACTIVE or UNCONFIGURED.
    const claimed = (run?.chainStarted ?? false) && phase.index > 0;
    this.release(run);
    const action = classifyFailure(phase.failure, claimed, ctx.gated);
    switch (action.kind) {
      case 'skip': this.skipped.add(ctx.id); return 'ran';
      case 'defer': this.deferrals++; return this.deferrals >= 3 ? this.parkDeferred() : 'ran';
      case 'retry': {
        this.attempts.set(ctx.id, (this.attempts.get(ctx.id) ?? 0) + 1);
        this.failures += 1;
        if (this.failures >= PICTURE_LIMITS.failureStop) { this.failures = 0; this.setStop('failed', PICTURE_LIMITS.stopMs); return 'idle'; }
        return 'ran';
      }
      case 'stop':
        if (action.reason === 'guard') this.outfit.guardPaused = true;
        this.setStop(action.reason, action.forMs);
        return 'idle';
    }
  }
  private parkDeferred(): 'idle' {
    this.deferrals = 0;
    this.setStop('failed', PICTURE_LIMITS.busyStopMs);
    return 'idle';
  }

  /**
   * Asked before every send of a chain (and once more by the client right before the POST). A foreground try-on holds the chain, except
   * before the first send, where the chain simply does not start; anything else that changed ends it without sending.
   */
  private gate(ctx: Context, index: number): RunGate {
    const t = this.tryOn, o = this.outfit;
    const deny = (verdict: RunGate): RunGate => { ctx.gated = true; return verdict; };
    if (this.disposed || ctx.cancelled || !t.api.current() || t.disposed) return deny('abort');
    if (t.photoGeneration !== ctx.photoGeneration) return deny('abort');
    const s = o.get();
    if (this.changing() || viewOf(s).kind !== 'on' || this.guardPaused || o.guardPaused) return deny('abort');
    const read = t.get().read;
    if (t.stopped() || read.kind !== 'ready' || !tryOnReady(read.status)) return deny('abort');
    const intent = this.intents.get(ctx.id);
    if (intent === 'remove' || this.deleting.has(ctx.id) || this.pending.has(ctx.id) || (index === 0 && intent !== undefined)) return deny('abort');
    if (index === 0 && (!navigator.onLine || document.visibilityState !== 'visible')) return deny('abort');
    if (t.foregroundActive()) return deny('hold');
    ctx.gated = false;
    return 'go';
  }
}

const queues = new WeakMap<OwnerScope, PictureQueue>();
/** The picture queue of this owner scope; a new scope (logout, UID or epoch change) gets a new one and the old one is disposed. */
export function pictureQueueFor(client: AppClient, scope: OwnerScope, config?: PublicConfig): PictureQueue | null {
  const existing = queues.get(scope);
  if (existing) return existing;
  if (scope.signal.aborted) return null;
  const outfit = outfitGenStoreFor(client, scope, config);
  const tryOn = tryOnStoreFor(client, scope, config);
  if (!outfit || !tryOn) return null;
  const queue = new PictureQueue(client, scope, outfit, tryOn);
  queues.set(scope, queue);
  return queue;
}
