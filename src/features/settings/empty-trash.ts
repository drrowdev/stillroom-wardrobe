import type { OwnerScope } from '../../auth/session';
import { AppError, errorKey } from '../../data/errors';
import type { ItemLifecycleClient } from '../../data/item-lifecycle';
import {
  preparedDeletionIntent, reversibleDeletion, samePreview,
  type DeletionOperation, type DeletionStatus, type PreparedDeletionIntent,
} from '../../domain/item-lifecycle';
import { outfitProblems, reconcileOutfit, type OutfitIntent, type OutfitOutcome } from '../../domain/outfit-lifecycle';
import type { OutfitRecord } from '../../domain/outfits';
import type { MessageKey } from '../../i18n';
import type { OutfitLifecycle } from '../outfits/use-outfit-lifecycle';

type Phase = 'idle' | 'discovering' | 'reviewing' | 'running' | 'checking' | 'paused' | 'finished';
type Result = 'waiting' | 'deleted' | 'skipped' | 'unknown' | 'resumable' | 'changed' | 'blocked';
type Base = { id: string; title: string; result: Result; sent: boolean; problem: MessageKey | null };
type Clothes = Base & {
  kind: 'clothes'; baseline: DeletionStatus; receipt: DeletionOperation | null;
  intent: PreparedDeletionIntent | null; existing: boolean;
};
type Outfit = Base & { kind: 'outfit'; intent: OutfitIntent };
export type EmptyTrashTarget = Clothes | Outfit;
export type EmptyTrashState = {
  phase: Phase; working: boolean; targets: readonly EmptyTrashTarget[]; error: MessageKey | null; blockers: readonly MessageKey[];
};
export type EmptyTrashDependencies = {
  items: Pick<ItemLifecycleClient, 'list' | 'operations' | 'findStatus' | 'statusOf' | 'operationStatus' | 'prepareDeletion' | 'continueDeletion' | 'cancelPreparation'>;
  outfits: Pick<OutfitLifecycle, 'execute' | 'check' | 'pendingWear' | 'unknown' | 'locked' | 'busy'>;
  listOutfits: (signal: AbortSignal) => Promise<OutfitRecord[]>;
  readOutfit: (id: string, signal: AbortSignal) => Promise<OutfitRecord | null>;
  checkOutfit: (intent: OutfitIntent) => Promise<OutfitOutcome>;
  invalidate: (paths: string[]) => void;
  onDeleting: (id: string) => void;
  onSettled: (deletedIds: string[]) => void;
  online: boolean;
};
class Paused extends Error {}
const fresh = (): EmptyTrashState => ({ phase: 'idle', working: false, targets: [], error: null, blockers: [] });
const terminal = (target: EmptyTrashTarget) => target.result === 'deleted' || target.result === 'skipped';

export class EmptyTrashController {
  private state = fresh();
  private targets: EmptyTrashTarget[] = [];
  private listeners = new Set<() => void>();
  private attachment: { dependencies: EmptyTrashDependencies; generation: number; isTrash: () => boolean } | null = null;
  private generation = 0;
  private paused = false;
  private executing = false;
  private consent = false;
  private lifetime = new AbortController();
  private changed = new Set<string>();
  private readonly owner: string;
  private readonly epoch: number;

  constructor(private scope: OwnerScope) {
    this.owner = scope.ownerId; this.epoch = scope.epoch;
    scope.signal.addEventListener('abort', () => {
      this.lifetime.abort(); this.attachment = null; this.targets = []; this.consent = false; this.changed.clear();
      this.publish(fresh());
    }, { once: true });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: EmptyTrashState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private update(phase: Phase, error: MessageKey | null = null, blockers: readonly MessageKey[] = this.state.blockers) {
    this.publish({ phase, working: this.executing, error, blockers, targets: this.targets.map(target => ({ ...target })) });
  }
  attach(dependencies: EmptyTrashDependencies, isTrash = () => location.hash === '#/trash') {
    const generation = ++this.generation;
    this.attachment = { dependencies, isTrash, generation };
    return () => {
      if (this.attachment?.generation !== generation) return;
      this.pause(); this.attachment = null;
    };
  }
  updateDependencies(dependencies: EmptyTrashDependencies) {
    if (this.attachment) this.attachment.dependencies = dependencies;
  }
  private guard(generation: number): EmptyTrashDependencies {
    const current = this.attachment;
    if (this.scope.signal.aborted || this.scope.ownerId !== this.owner || this.scope.epoch !== this.epoch
      || !current || current.generation !== generation || !current.isTrash() || this.paused || !current.dependencies.online) throw new Paused();
    return current.dependencies;
  }
  private signal() { return AbortSignal.any([this.scope.signal, this.lifetime.signal]); }
  pause = () => {
    this.paused = true; this.lifetime.abort();
    if (this.consent) this.update('paused', 'emptyTrash.paused');
    else if (!this.executing) { this.targets = []; this.update('idle'); }
  };
  private start(): number | null {
    if (this.executing || !this.attachment || this.scope.signal.aborted || !this.attachment.dependencies.online || !this.attachment.isTrash()) return null;
    this.paused = false; this.lifetime = new AbortController(); this.executing = true;
    return this.attachment.generation;
  }
  private settled() {
    if (this.scope.signal.aborted || this.scope.ownerId !== this.owner || this.scope.epoch !== this.epoch
      || !this.attachment || !this.attachment.isTrash() || this.paused || !this.attachment.dependencies.online) return;
    this.attachment.dependencies.onSettled([...this.changed]); this.changed.clear();
  }
  private failure(problem: unknown, target?: EmptyTrashTarget) {
    if (this.scope.signal.aborted) return;
    if (target && !terminal(target) && target.result !== 'changed' && target.result !== 'blocked') {
      target.result = target.sent ? 'unknown' : 'waiting';
      target.problem = target.sent ? 'emptyTrash.checkFirst' : errorKey(problem);
    }
    if (problem instanceof Paused) this.update(this.consent ? 'paused' : 'idle', this.consent ? 'emptyTrash.paused' : null);
    else this.update(this.consent ? 'paused' : 'idle', errorKey(problem));
  }
  discover = async () => {
    if (this.consent) return;
    const generation = this.start(); if (generation === null) return;
    this.targets = []; this.update('discovering', null, []);
    try {
      const found: Clothes[] = [];
      let after: string | null = null;
      const ids = new Set<string>();
      for (;;) {
        const page = await this.guard(generation).items.list(after, this.signal()); this.guard(generation);
        if (page.next !== null && (after !== null && page.next <= after)) throw new AppError('error.unavailable');
        const receipts = page.rows.length
          ? await this.guard(generation).items.operations(page.rows.map(row => row.id), this.signal()) : [];
        this.guard(generation);
        for (const baseline of page.rows) {
          if (ids.has(baseline.id) || baseline.owner_id !== this.owner || !baseline.deleted_at) throw new AppError('error.unavailable');
          ids.add(baseline.id);
          const receipt = receipts.find(value => value.itemId === baseline.id) ?? null;
          if (receipt?.phase === 'completed' || receipt?.phase === 'cancelled') throw new AppError('error.conflict');
          found.push({ kind: 'clothes', id: baseline.id, title: baseline.title, baseline, receipt,
            intent: receipt ? { preview: baseline, requestId: receipt.requestId, epoch: this.epoch } : null,
            existing: receipt !== null || baseline.request_id !== null, sent: false, result: 'waiting', problem: null });
        }
        if (page.next === null) break;
        after = page.next;
      }
      const outfits = await this.guard(generation).listOutfits(this.signal()); this.guard(generation);
      const outfitIds = new Set<string>();
      const targets: Outfit[] = outfits.map(baseline => {
        if (baseline.ownerId !== this.owner || !baseline.deletedAt || outfitIds.has(baseline.id)) throw new AppError('error.unavailable');
        outfitIds.add(baseline.id);
        return { kind: 'outfit', id: baseline.id, title: baseline.title, intent: { baseline: structuredClone(baseline), epoch: this.epoch, action: 'delete' },
          sent: false, result: 'waiting', problem: null };
      });
      this.targets = [...targets, ...found.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)];
      const blockers = this.knownBlockers(this.guard(generation));
      this.update(this.targets.length ? 'reviewing' : 'idle', null, blockers);
    } catch (problem) { this.targets = []; this.failure(problem); }
    finally { this.executing = false; if (!this.scope.signal.aborted) this.update(this.state.phase, this.state.error); }
  };
  private knownBlockers(dependencies: EmptyTrashDependencies): MessageKey[] {
    const blockers = new Set<MessageKey>();
    for (const target of this.targets) {
      if (target.kind === 'outfit' && dependencies.outfits.pendingWear(target.id)) blockers.add('calendar.unknown');
      if (target.kind === 'clothes' && (target.baseline.cleanup_blocked || target.receipt?.phase === 'blocked_preflight')) blockers.add('deletion.blocked');
    }
    return [...blockers];
  }
  clear = () => {
    if (this.executing) return;
    this.paused = false;
    if (this.consent) this.settled();
    this.targets = []; this.changed.clear(); this.consent = false; this.update('idle', null, []);
  };
  confirm = async () => {
    if (this.state.phase !== 'reviewing' || this.state.blockers.length) return;
    const dependencies = this.attachment?.dependencies;
    if (!dependencies || !dependencies.online || dependencies.outfits.locked || !this.attachment?.isTrash() || this.paused) return;
    const blockers = this.knownBlockers(dependencies);
    if (blockers.length) { this.update('reviewing', null, blockers); return; }
    this.consent = true;
    await this.run();
  };
  resume = async () => {
    if (!this.consent || this.targets.some(target => target.result === 'unknown' || target.result === 'changed')) return;
    await this.run();
  };
  private async run() {
    const generation = this.start(); if (generation === null) return;
    let current: EmptyTrashTarget | undefined;
    this.update('running');
    try {
      for (const target of this.targets) {
        current = target; this.guard(generation);
        if (terminal(target)) continue;
        if (target.kind === 'outfit') await this.deleteOutfit(target, generation);
        else await this.deleteClothes(target, generation);
        this.guard(generation);
        if (!terminal(target)) { this.update('paused', target.problem); return; }
        this.update('running');
      }
      this.update('finished');
    } catch (problem) { this.failure(problem, current); }
    finally { this.executing = false; this.settled(); if (!this.scope.signal.aborted) this.update(this.state.phase, this.state.error); }
  }
  private outfitResult(target: Outfit, outcome: OutfitOutcome | { kind: 'not-started' }) {
    target.problem = null;
    if (outcome.kind === 'saved') target.result = 'deleted';
    else if (outcome.kind === 'notSaved') { target.result = 'resumable'; target.problem = 'outfitTrash.notSaved'; }
    else if (outcome.kind === 'conflict') { target.result = 'changed'; target.problem = 'error.conflict'; }
    else if (outcome.kind === 'unknown') { target.result = 'unknown'; target.problem = 'emptyTrash.checkFirst'; }
    else { target.result = 'blocked'; target.problem = outcome.kind === 'not-started' ? 'error.unavailable' : outfitProblems[outcome.kind]; }
  }
  private async deleteOutfit(target: Outfit, generation: number) {
    if (this.guard(generation).outfits.locked) { target.result = 'blocked'; target.problem = 'emptyTrash.checkFirst'; return; }
    const row = await this.guard(generation).readOutfit(target.id, this.signal()); this.guard(generation);
    if (!target.sent && (!row || row.deletedAt === null)) { target.result = 'skipped'; return; }
    if (reconcileOutfit(target.intent, row).kind !== 'notSaved') { target.result = 'changed'; target.problem = 'error.conflict'; return; }
    if (this.guard(generation).outfits.pendingWear(target.id)) { target.result = 'blocked'; target.problem = 'calendar.unknown'; return; }
    target.sent = true; target.result = 'unknown';
    const result = await this.guard(generation).outfits.execute([target.intent.baseline], 'delete');
    const reply = result.outcomes.find(value => value.id === target.id)?.outcome;
    // Preserve this run's reply in owner memory, even when queued navigation has now detached the view.
    if (!this.scope.signal.aborted) {
      if (reply) { this.outfitResult(target, reply); if (reply.kind === 'not-started') target.sent = false; }
    }
    this.guard(generation);
    if (reply?.kind === 'conflict') {
      const outcome = await this.guard(generation).checkOutfit(target.intent); this.guard(generation);
      this.outfitResult(target, outcome);
    }
  }
  private receipt(target: Clothes, receipt: DeletionOperation) {
    if (receipt.itemId !== target.id || receipt.requestId !== target.intent?.requestId) throw new AppError('error.conflict');
    const baseline = target.baseline, begin = receipt.begin;
    const matchesVersion = baseline.request_id === null ? receipt.expectedVersion === baseline.version
      : baseline.request_id === receipt.requestId && baseline.expected_version !== null && baseline.started_at !== null
        && baseline.version === baseline.expected_version + 1 && begin !== null
        && begin.request_id === baseline.request_id && begin.expected_version === baseline.expected_version
        && begin.version === baseline.version && begin.started_at === baseline.started_at
        && begin.image_manifest_sha256 === baseline.image_manifest_sha256
        && (receipt.expectedVersion === baseline.expected_version || receipt.expectedVersion === baseline.version);
    if (receipt.phase !== 'completed' && (!matchesVersion
      || target.receipt?.inventoryHash && target.receipt.inventoryHash !== receipt.inventoryHash && receipt.phase !== 'cancelled')) throw new AppError('error.conflict');
    target.receipt = receipt; target.problem = null;
    if (receipt.phase === 'completed') { target.result = 'deleted'; this.changed.add(target.id); }
    else if (receipt.phase === 'blocked_preflight') { target.result = 'blocked'; target.problem = 'deletion.blocked'; }
    else if (receipt.phase === 'cancelled') { target.result = 'changed'; target.problem = 'error.conflict'; }
    else { target.result = 'resumable'; target.problem = 'lifecycle.paused'; }
  }
  private async deleteClothes(target: Clothes, generation: number) {
    try {
      if (!target.sent && !target.existing) {
        const current = await this.guard(generation).items.findStatus(target.id, this.signal()); this.guard(generation);
        if (!current || current.deleted_at === null) { target.result = 'skipped'; return; }
        if (!samePreview(current, target.baseline)) { target.result = 'changed'; target.problem = 'error.conflict'; return; }
      }
      if (!target.intent) target.intent = preparedDeletionIntent(target.baseline, this.epoch);
      if (target.sent || target.existing) {
        const receipt = await this.guard(generation).items.operationStatus(target.id, target.intent.requestId, this.signal()); this.guard(generation);
        if (receipt) this.receipt(target, receipt);
        else if (!(target.result === 'resumable' && !target.receipt && !target.existing)
          && !(target.existing && !target.receipt && !target.sent)) throw new AppError('lifecycle.unconfirmed');
        if (terminal(target) || target.result === 'blocked' || target.result === 'changed') return;
      }
      if (!target.receipt || target.receipt.phase === 'preparing') {
        target.sent = true; target.result = 'unknown';
        const receipt = await this.guard(generation).items.prepareDeletion(target.intent, this.signal()); this.guard(generation);
        this.receipt(target, receipt);
        if (receipt.phase !== 'prepared') return;
      }
      if (!target.receipt || !['prepared', 'authorized', 'removing_registered'].includes(target.receipt.phase)) return;
      const receipt = target.receipt;
      this.guard(generation).onDeleting(target.id);
      target.sent = true; target.result = 'unknown';
      const result = await this.guard(generation).items.continueDeletion(receipt, receipt.phase === 'prepared',
        paths => this.guard(generation).invalidate(paths), this.signal()); this.guard(generation);
      this.receipt(target, result);
    } catch (problem) {
      if (errorKey(problem) !== 'error.conflict') throw problem;
      const before = target.receipt;
      const receipt = target.intent ? await this.guard(generation).items.operationStatus(target.id, target.intent.requestId, this.signal()) : null;
      this.guard(generation);
      if (receipt) {
        this.receipt(target, receipt);
        if (terminal(target) || target.result === 'blocked') return;
      }
      const current = await this.guard(generation).items.statusOf(target.id, this.signal()); this.guard(generation);
      const recoveredPreparation = before === null && receipt !== null && reversibleDeletion(receipt);
      target.result = samePreview(current, target.baseline) && (JSON.stringify(before) === JSON.stringify(receipt) || recoveredPreparation) ? 'resumable' : 'changed';
      target.problem = target.result === 'resumable' ? 'outfitTrash.notSaved' : 'error.conflict';
    }
  }
  check = async () => {
    if (!this.consent) return;
    const generation = this.start(); if (generation === null) return;
    const target = this.targets.find(value => !terminal(value));
    if (!target) { this.executing = false; return; }
    this.update('checking');
    try {
      if (target.kind === 'outfit') {
        const dependencies = this.guard(generation);
        if (dependencies.outfits.busy) throw new AppError('emptyTrash.checkFirst');
        if (!target.sent) {
          const row = await this.guard(generation).readOutfit(target.id, this.signal()); this.guard(generation);
          if (!row || row.deletedAt === null) { target.result = 'skipped'; target.problem = null; }
          else this.outfitResult(target, reconcileOutfit(target.intent, row));
        } else if (dependencies.outfits.unknown.some(intent => intent.baseline.id === target.id)) {
          const reply = await this.guard(generation).outfits.check(); this.guard(generation);
          const outcome = reply.outcomes.find(value => value.id === target.id)?.outcome;
          if (outcome && outcome.kind !== 'not-started') this.outfitResult(target, outcome);
          else {
            const result = await this.guard(generation).checkOutfit(target.intent); this.guard(generation);
            this.outfitResult(target, result);
          }
        } else {
          const result = await this.guard(generation).checkOutfit(target.intent); this.guard(generation);
          this.outfitResult(target, result);
        }
      } else {
        if (!target.intent) throw new AppError('lifecycle.unconfirmed');
        const receipt = await this.guard(generation).items.operationStatus(target.id, target.intent.requestId, this.signal()); this.guard(generation);
        if (!receipt) throw new AppError('lifecycle.unconfirmed');
        this.receipt(target, receipt);
      }
      this.update(this.targets.every(terminal) ? 'finished' : 'paused', target.problem);
    } catch (problem) { this.failure(problem, target); }
    finally { this.executing = false; this.settled(); if (!this.scope.signal.aborted) this.update(this.state.phase, this.state.error); }
  };
  cancelPreparation = async () => {
    const target = this.targets.find(value => !terminal(value));
    if (target?.kind !== 'clothes' || target.existing || !target.receipt || target.result === 'unknown' || !reversibleDeletion(target.receipt)) return;
    const generation = this.start(); if (generation === null) return;
    this.update('checking');
    try {
      const receipt = await this.guard(generation).items.cancelPreparation(target.receipt, this.signal()); this.guard(generation);
      this.receipt(target, receipt); this.update('paused', 'error.conflict');
    } catch (problem) { this.failure(problem, target); }
    finally { this.executing = false; this.settled(); if (!this.scope.signal.aborted) this.update(this.state.phase, this.state.error); }
  };
}

const controllers = new WeakMap<OwnerScope, EmptyTrashController>();
export function emptyTrashFor(scope: OwnerScope) {
  let controller = controllers.get(scope);
  if (!controller) { controller = new EmptyTrashController(scope); controllers.set(scope, controller); }
  return controller;
}

export function observeTrashNavigation(pause: () => void) {
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null;
    if (href?.startsWith('#/') && href !== '#/trash') pause();
  };
  const departure = () => { if (location.hash !== '#/trash') pause(); };
  window.addEventListener('click', click, true);
  window.addEventListener('popstate', departure, true);
  window.addEventListener('hashchange', departure, true);
  window.addEventListener('pagehide', pause);
  return () => {
    window.removeEventListener('click', click, true); window.removeEventListener('popstate', departure, true);
    window.removeEventListener('hashchange', departure, true); window.removeEventListener('pagehide', pause);
  };
}
