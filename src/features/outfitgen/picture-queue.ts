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
import { tryOnReady, type TryOnResult } from '../../data/tryon';
import { AI_GUARD_RESUMED_EVENT } from '../../domain/ai-guard';
import type { TryOnStep } from '../../domain/tryon';
import type { OutfitComponent } from '../../domain/outfits';
import type { Suggestion } from '../../domain/outfitgen-app';
import {
  classifyFailure, noReserved, PICTURE_LIMITS, pictureBlock, pictureIndex, pictureTargets, plannedKey, removableResults, reserveBlock, reservedGate,
  type PictureBlock, type PictureResult, type ReservedMemory,
} from '../../domain/outfitgen-pictures';
import { TryOnRun, browserEnvironment, ideaSelection, type RunEnvironment, type RunGate, type RunPhase } from '../outfits/use-try-on';
import { loadPersonPhoto, readPersonPhoto } from '../settings/tryon-photo';
import { readTryOnStatus, tryOnStoreFor, type TryOnStore } from '../settings/tryon-store';
import { outfitGenStoreFor, readList, readStatus, viewOf, type OutfitGenStore } from './outfitgen-store';

/** The one line the Suggested outfits section shows when pictures are not being made, or `null`. */
export type PictureLine = 'tryOnOff' | 'noPhoto' | 'full' | 'budget' | 'retryLater' | 'guard';
export type Making = { id: string; ordinal: number; of: number; step: number; steps: number; waiting: boolean };
export type PictureState = {
  /** The newest idea picture of each planned garment set; `null` until the results have been read. */
  pictures: ReadonlyMap<string, PictureResult> | null;
  making: Making | null;
  /** Suggestions the queue will make a picture for after the current one. */
  waiting: ReadonlySet<string>;
  line: PictureLine | null;
  /** Suggestions whose pictures are being deleted (Remove); Undo waits for them. */
  deleting: ReadonlySet<string>;
  /** A picture of a removed suggestion could not be deleted; it stays under Today's try-ons. */
  deleteFailed: boolean;
};
const initial: PictureState = { pictures: null, making: null, waiting: new Set(), line: null, deleting: new Set(), deleteFailed: false };

type Context = {
  id: string; key: string; steps: number; ordinal: number; of: number; run: TryOnRun | null; photoGeneration: number;
  cancelled: boolean; gated: boolean; settled: boolean; cancel: () => void;
};
type Stop = { reason: 'busy' | 'allowance' | 'consent' | 'full' | 'guard' | 'failed'; until: number; signature: string };
type Locks = { request: <T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T>) => Promise<T> };

const lineOf: Record<Stop['reason'], PictureLine | null> = {
  busy: 'retryLater', allowance: 'budget', consent: null, full: 'full', guard: 'guard', failed: 'retryLater',
};
const blockLine: Partial<Record<PictureBlock, PictureLine>> = { tryOn: 'tryOnOff', photo: 'noPhoto', guard: 'guard' };

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
  private readonly failedDeletes = new Set<string>();
  private resultsSeq = 0;
  private reserved: ReservedMemory = noReserved;
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
    return () => { if (this.intents.get(id) === kind) this.intents.delete(id); this.watchCurrent(); this.kick(); };
  }

  /**
   * After Remove: stops this suggestion's chain (reconciling its final outcome with the server), then deletes the pictures of its planned
   * set that finished after the suggestion was created. Everything older stays. A failure is shown, never retried by itself.
   */
  async discard(suggestion: Suggestion): Promise<void> {
    if (this.disposed) return;
    this.deleting.add(suggestion.id);
    this.emit({ deleting: new Set(this.deleting) });
    try {
      const active = this.current;
      if (active && active.id === suggestion.id) {
        active.cancelled = true;
        await active.run?.stop();
        active.cancel();
      }
      const key = await this.keyOf(suggestion);
      if (key === null) return;
      const fresh = await this.tryOn.api.results().catch(() => null);
      if (this.disposed) return;
      if (fresh === null || fresh === 'missing') { this.failedDeletes.add(suggestion.id); return; }
      for (const id of removableResults(fresh, key, suggestion.createdAtMs)) {
        const outcome = await this.tryOn.api.deleteResult(id).catch(() => null);
        if (this.disposed) return;
        if (outcome === null) this.failedDeletes.add(id);
      }
    } finally {
      this.deleting.delete(suggestion.id);
      if (!this.disposed) {
        await this.readResults();
        this.emit({ deleting: new Set(this.deleting) });
        this.kick();
      }
    }
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
      p.read, p.saved?.savedAtMs ?? '', this.tryOn.foregroundActive(), this.guardPaused || this.outfit.guardPaused].join('|');
  }
  private changed() {
    if (this.disposed) return;
    this.watchCurrent();
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
      consentOn: view.kind === 'on', consentChanging: o.writing || o.unresolved || this.outfit.writePromise !== null,
      guardPaused: this.guardPaused || this.outfit.guardPaused, tryOnReady: tryOnReady(status), sessionStopped: this.tryOn.stopped(),
      photo: p.read === 'unknown' || (p.read === 'failed' && p.saved === null) ? 'unknown' as const : p.saved ? 'saved' as const : 'none' as const,
      online: navigator.onLine, visible: document.visibilityState === 'visible', foreground: this.tryOn.foregroundActive(),
      cooldownUntilMs: this.stop?.until ?? null, nowMs: Date.now(),
    };
  }
  private stopSignature() {
    const t = this.tryOn.get(), p = this.tryOn.getPhoto();
    return [viewOf(this.outfit.get()).kind, t.read.kind === 'ready' ? t.read.status.consent?.enabled : '', p.saved?.savedAtMs ?? ''].join('|');
  }
  private setStop(reason: Stop['reason'], forMs: number | null) {
    this.stop = { reason, until: forMs === null ? Number.POSITIVE_INFINITY : Date.now() + forMs, signature: this.stopSignature() };
    if (reason === 'guard') this.guardPaused = true;
    if (forMs !== null) this.poll(forMs);
    this.emit({ line: lineOf[reason], waiting: new Set() });
  }
  private blocked(block: PictureBlock) {
    const t = this.tryOn.get();
    const known = t.read.kind === 'ready';
    const line = block === 'cooldown' ? lineOf[this.stop?.reason ?? 'failed'] : block === 'tryOn' && !known ? null : blockLine[block] ?? null;
    this.emit({ line, waiting: new Set() });
    if (block === 'cooldown' && this.stop && Number.isFinite(this.stop.until)) this.poll(Math.max(1_000, this.stop.until - Date.now()));
  }

  /** One evaluation: reads what is stale, checks the gates, makes at most one picture. `ran` means a chain ended and another may follow. */
  private async once(): Promise<'ran' | 'idle'> {
    if (this.disposed) return 'idle';
    if (this.stop && (this.stop.signature !== this.stopSignature() || Date.now() >= this.stop.until)) this.stop = null;
    await this.refresh();
    if (this.disposed) return 'idle';
    this.signature = this.sign();
    const block = pictureBlock(this.inputs());
    if (block !== null) { this.blocked(block); return 'idle'; }
    const locks = (navigator as unknown as { locks?: Locks }).locks;
    // Without Web Locks there is no way to keep two windows apart, so nothing is made automatically.
    if (!locks) return 'idle';
    return locks.request(`stillroom-pictures-${this.scope.ownerId}`, { ifAvailable: true }, async (held) => {
      if (!held) { this.poll(); return 'idle'; }
      return this.underLock();
    });
  }

  private async refresh() {
    const o = this.outfit;
    if (o.get().read.kind === 'unknown') await readStatus(o);
    if (this.disposed || viewOf(o.get()).kind !== 'on') return;
    if (o.get().list.kind === 'unknown') await readList(o);
    if (this.disposed || !navigator.onLine) return;
    const t = this.tryOn;
    if (t.get().read.kind === 'unknown') await readTryOnStatus(t, 'active');
    if (t.getPhoto().read === 'unknown') await readPersonPhoto(t);
    if (!this.disposed && o.get().list.suggestions.length > 0 && this.state.pictures === null) await this.readResults();
  }

  private async readResults(): Promise<readonly TryOnResult[] | null> {
    const at = ++this.resultsSeq;
    const list = await this.tryOn.api.results().catch(() => null);
    if (this.disposed || list === null) return null;
    const results = list === 'missing' ? [] : list;
    if (at === this.resultsSeq) {
      for (const id of [...this.failedDeletes]) if (!results.some((entry) => entry.id === id) && !this.deleting.has(id)) this.failedDeletes.delete(id);
      this.emit({ pictures: pictureIndex(results), deleteFailed: this.failedDeletes.size > 0 });
    }
    return results;
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
  private async keyOf(suggestion: Suggestion): Promise<string | null> {
    if (!await this.ensureComponents([suggestion])) return null;
    return plannedKey(ideaSelection(suggestion.itemIds, this.components).steps);
  }

  private async underLock(): Promise<'ran' | 'idle'> {
    const t = this.tryOn, o = this.outfit;
    const status = await readTryOnStatus(t, 'fresh');
    if (this.disposed || !status) return 'idle';
    const ready = await this.readResults();
    if (this.disposed || !ready) { this.poll(); return 'idle'; }
    if (pictureBlock(this.inputs()) !== null) return 'idle';
    if (status.results >= PICTURE_LIMITS.resultsStop) { this.emit({ line: 'full', waiting: new Set() }); return 'idle'; }
    const gate = reservedGate(this.reserved, status.results, ready.length, Date.now());
    this.reserved = gate.memory;
    if (gate.wait) { this.poll(); return 'idle'; }
    const list = o.get().list.suggestions;
    if (!await this.ensureComponents(list)) { this.poll(); return 'idle'; }
    const candidates = list.map((entry) => {
      const steps = ideaSelection(entry.itemIds, this.components).steps;
      return { id: entry.id, key: plannedKey(steps), steps };
    });
    const targets = pictureTargets(candidates, { have: pictureIndex(ready), attempts: this.attempts, skipped: this.skipped,
      excluded: new Set([...this.intents.keys(), ...this.deleting]) });
    if (!targets.length) { this.finished = 0; this.emit({ line: null, waiting: new Set() }); return 'idle'; }
    const target = targets[0]!;
    if (reserveBlock(status.budget, status.policy?.maxRequestMicro ?? null, target.steps.length)) {
      this.emit({ line: 'budget', waiting: new Set() });
      this.poll(PICTURE_LIMITS.stopMs / 6);
      return 'idle';
    }
    this.emit({ line: null, waiting: new Set(targets.slice(1).map((entry) => entry.id)) });
    return this.make(target, targets.length);
  }

  private async make(target: { id: string; key: string | null; steps: TryOnStep[] }, left: number): Promise<'ran' | 'idle'> {
    const t = this.tryOn;
    const photoGeneration = t.photoGeneration;
    const ctx: Context = { id: target.id, key: target.key!, steps: target.steps.length, ordinal: this.finished + 1, of: this.finished + left, run: null,
      photoGeneration, cancelled: false, gated: false, settled: false, cancel: () => undefined };
    this.current = ctx;
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
        const look = () => {
          const now = run.get();
          this.emit({ making: { id: ctx.id, ordinal: ctx.ordinal, of: ctx.of, steps: ctx.steps, waiting: now.kind === 'running' && now.waiting === true,
            step: 'index' in now ? now.index + 1 : 1 } });
          if (now.kind === 'result' || now.kind === 'failed' || now.kind === 'stopped') resolve(now);
        };
        unsubscribe = run.subscribe(look);
        look();
        run.start();
      });
      unsubscribe();
      return await this.settle(ctx, phase);
    } finally {
      ctx.run?.abandon();
      this.current = null;
      this.emit({ making: null });
    }
  }

  private async settle(ctx: Context, phase: RunPhase | 'cancelled' | null): Promise<'ran' | 'idle'> {
    const run = ctx.run;
    if (phase === null) { this.deferrals++; return this.deferrals >= 3 ? this.parkDeferred() : 'ran'; }
    if (phase === 'cancelled' || ctx.cancelled) { run?.abandon(); await this.readResults(); return 'ran'; }
    if (phase.kind === 'result') {
      run?.dispose();
      this.attempts.delete(ctx.id);
      this.finished += 1;
      this.failures = 0;
      this.deferrals = 0;
      await this.readResults();
      return 'ran';
    }
    if (phase.kind !== 'failed') { run?.dispose(); return 'ran'; }
    const chainStarted = run?.chainStarted ?? false;
    run?.abandon();
    const action = classifyFailure(phase.failure, chainStarted, ctx.gated);
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
    if (s.writing || s.unresolved || o.writePromise !== null || viewOf(s).kind !== 'on' || this.guardPaused || o.guardPaused) return deny('abort');
    const read = t.get().read;
    if (t.stopped() || read.kind !== 'ready' || !tryOnReady(read.status)) return deny('abort');
    const intent = this.intents.get(ctx.id);
    if (intent === 'remove' || this.deleting.has(ctx.id) || (index === 0 && intent !== undefined)) return deny('abort');
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
