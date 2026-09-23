import type { OwnerScope } from '../auth/session';
import type { ItemBaseline, ImageBaseline } from '../domain/item-details';
import { freezeValues } from '../domain/garment-fields';
import { isRecord } from '../domain/wardrobe';
import {
  canonicalId, confirmsTrash, itemDetailColumns, lifecycleBudgetMs, lifecycleImageColumns, lifecyclePageSize,
  matchesClaim, parseBeginReply, parseDeletionStatuses, parseFinishReply, parseLifecycleImages, parseLifecycleSnapshot,
  parseTrashReply, requireLifecycleIds, safeVersion, samePreview, sameSavedBaseline,
  type DeletionIntent, type DeletionStatus, type LifecycleSnapshot, type TrashIntent,
  parseDeletionOperation, parseDeletionTarget, parseTargetReconciliation, reversibleDeletion,
  type DeletionOperation, type PreparedDeletionIntent,
} from '../domain/item-lifecycle';
import type { AppClient } from './client';
import { readConfiguration, type PublicConfig } from './config';
import { AppError } from './errors';
import { deleteWardrobeObject, deleteWardrobeTarget, wardrobeTargetDeleteRoute, type DeleteRequest } from './storage-delete';

export type LifecycleStage = 'read' | 'change' | 'begin' | 'bytes' | 'finish';
export class LifecycleError extends AppError {
  constructor(readonly stage: LifecycleStage, readonly uncertain: boolean, key: 'error.unavailable' | 'error.conflict' = 'error.unavailable') {
    super(uncertain ? 'lifecycle.unconfirmed' : key);
  }
}
type Work = {
  signal: AbortSignal; stage: LifecycleStage; changed: boolean;
  dispatches?: number;
  check: () => void;
  wait: <T>(operation: () => PromiseLike<T>) => Promise<T>;
};
function failure(work: Work, problem?: unknown): LifecycleError {
  if (problem instanceof LifecycleError) return problem;
  if (problem instanceof AppError && problem.messageKey === 'error.conflict') return new LifecycleError(work.stage, false, 'error.conflict');
  if (problem instanceof Error && problem.message === 'error.notAvailable') return new LifecycleError(work.stage, false, 'error.unavailable');
  return new LifecycleError(work.stage, work.changed);
}
function rpcError(work: Work, error: unknown): void {
  if (!error) return;
  if (isRecord(error) && error.code === '22023' && error.message === 'Request conflict') throw new LifecycleError(work.stage, false, 'error.conflict');
  if (isRecord(error) && ['42501', 'PGRST301', 'PGRST302'].includes(String(error.code))) throw new LifecycleError(work.stage, false, 'error.unavailable');
  throw failure(work);
}
export class ItemLifecycleClient {
  private readonly owner: string;
  private readonly epoch: number;
  constructor(private client: AppClient, private config: PublicConfig, readonly scope: OwnerScope) {
    const checked = readConfiguration({ VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey });
    if (checked.status !== 'ready' || checked.value.url !== config.url || !canonicalId(scope.ownerId)) throw new AppError('error.unavailable');
    this.owner = scope.ownerId; this.epoch = scope.epoch;
  }
  private async bounded<T>(outer: AbortSignal | undefined, operation: (work: Work) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.scope.signal, controller.signal, ...(outer ? [outer] : [])]);
    const deadline = performance.now() + lifecycleBudgetMs;
    const work: Work = { signal, stage: 'read', changed: false, check: () => {
      if (signal.aborted || performance.now() >= deadline || this.scope.ownerId !== this.owner || this.scope.epoch !== this.epoch) throw failure(work);
    }, wait: async <R>(start: () => PromiseLike<R>) => {
      work.check();
      const result = await Promise.race([Promise.resolve(start()), stopped]);
      work.check();
      return result;
    } };
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(failure(work)); signal.addEventListener('abort', abort, { once: true }); });
    const timer = setTimeout(() => controller.abort(), lifecycleBudgetMs);
    try { return await work.wait(() => operation(work)); }
    catch (problem) { throw failure(work, problem); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
  private async statuses(work: Work, ids: string[]): Promise<DeletionStatus[]> {
    requireLifecycleIds(ids, this.owner);
    const result = await work.wait(() => this.client.rpc('item_deletion_status', { p_item_ids: ids }).abortSignal(work.signal));
    rpcError(work, result.error);
    return parseDeletionStatuses(result.data, this.owner, ids);
  }
  private async status(work: Work, id: string): Promise<DeletionStatus> {
    const rows = await this.statuses(work, [id]);
    if (rows.length !== 1) throw new LifecycleError(work.stage, work.changed, 'error.unavailable');
    return rows[0]!;
  }
  statusOf(id: string, signal?: AbortSignal) { return this.bounded(signal, work => this.status(work, id)); }
  list(after: string | null, signal?: AbortSignal): Promise<{ rows: DeletionStatus[]; next: string | null }> {
    return this.bounded(signal, async work => {
      if (after !== null && !canonicalId(after)) throw new AppError('error.unavailable');
      let query = this.client.from('items').select('id').eq('owner_id', this.owner).not('deleted_at', 'is', null).order('id').limit(lifecyclePageSize);
      if (after) query = query.gt('id', after);
      const result = await work.wait(() => query.abortSignal(work.signal));
      rpcError(work, result.error);
      if (!Array.isArray(result.data) || result.data.length > lifecyclePageSize) throw new AppError('error.unavailable');
      const ids: string[] = [];
      for (const row of result.data) {
        if (!isRecord(row) || !canonicalId(row.id) || row.id <= (ids.at(-1) ?? after ?? '')) throw new AppError('error.unavailable');
        ids.push(row.id);
      }
      const rows = ids.length ? await this.statuses(work, ids) : [];
      return { rows: rows.filter(row => row.deleted_at !== null), next: ids.length === lifecyclePageSize ? ids.at(-1)! : null };
    });
  }
  private async snapshot(work: Work, id: string): Promise<LifecycleSnapshot> {
    requireLifecycleIds([id], this.owner);
    const result = await work.wait(() => this.client.from('items').select(itemDetailColumns).eq('owner_id', this.owner).eq('id', id).abortSignal(work.signal).maybeSingle());
    rpcError(work, result.error);
    return parseLifecycleSnapshot(result.data, this.owner, id);
  }
  change(id: string, trashed: boolean, expectedVersion: number, prepared: (intent: TrashIntent) => void,
    signal?: AbortSignal, editor?: { item: ItemBaseline; image: ImageBaseline }): Promise<LifecycleSnapshot> {
    return this.bounded(signal, async work => {
      if (!safeVersion(expectedVersion, true)) throw new AppError('error.conflict');
      const baseline = await this.snapshot(work, id);
      const status = await this.status(work, id);
      if (baseline.version !== expectedVersion || status.version !== baseline.version || status.deleted_at !== baseline.deletedAt
        || status.title !== baseline.values.title || status.request_id || (trashed ? baseline.deletedAt !== null || !status.current_image_id : baseline.deletedAt === null)
        || editor && (!sameSavedBaseline(baseline, editor.item) || status.current_image_id !== editor.image.id
          || status.current_thumb_path !== editor.image.thumbPath)) throw new AppError('error.conflict');
      const intent = freezeValues({ baseline, trashed, epoch: this.epoch });
      work.check(); prepared(intent); work.check();
      work.stage = 'change'; work.changed = true;
      const result = await work.wait(() => this.client.rpc('set_item_trashed', { p_item_id: id, p_expected_version: expectedVersion, p_trashed: trashed }).abortSignal(work.signal));
      rpcError(work, result.error);
      return parseTrashReply(result.data, intent);
    });
  }
  checkChange(intent: TrashIntent, signal?: AbortSignal): Promise<LifecycleSnapshot> {
    return this.bounded(signal, async work => {
      if (intent.epoch !== this.epoch || intent.baseline.ownerId !== this.owner) throw new AppError('error.unavailable');
      const actual = await this.snapshot(work, intent.baseline.id);
      if (!confirmsTrash(actual, intent)) throw new LifecycleError('read', true);
      return actual;
    });
  }
  checkDeletion(intent: DeletionIntent, signal?: AbortSignal): Promise<DeletionStatus> {
    return this.bounded(signal, async work => {
      this.bindIntent(intent);
      const status = await this.status(work, intent.preview.id);
      if (!matchesClaim(status, intent)) throw new LifecycleError('read', true);
      return status;
    });
  }
  private bindIntent(intent: DeletionIntent): void {
    if (intent.epoch !== this.epoch || intent.preview.owner_id !== this.owner || !canonicalId(intent.requestId)
      || !safeVersion(intent.expectedVersion, true)) throw new AppError('error.unavailable');
  }
  private async remove(work: Work, path: string, itemId?: string): Promise<'removed' | 'missing'> {
    const remove = itemId === undefined ? deleteWardrobeObject
      : (request: DeleteRequest, owner: string, target: string) => deleteWardrobeTarget(request, owner, itemId, target);
    return remove(async (route, options) => {
      const auth = await work.wait(() => this.client.auth.getSession());
      const session = auth.data.session;
      if (auth.error || !session || session.user.id !== this.owner) throw new LifecycleError(work.stage, false, 'error.unavailable');
      work.check();
      work.stage = 'bytes'; work.changed = true;
      if (work.dispatches !== undefined) {
        if (work.dispatches >= lifecyclePageSize) throw failure(work);
        work.dispatches++;
      }
      const response = await work.wait(() => fetch(`${this.config.url}${route}`, {
        method: options.method, headers: { apikey: this.config.publishableKey, Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' },
        signal: work.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      }));
      if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        if (response.body) await work.wait(() => response.body!.cancel());
        throw failure(work);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '', bytes = 0, failed = false, primary: unknown, data: unknown;
      try {
        for (;;) {
          const part = await work.wait(() => reader.read());
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 4096) throw failure(work);
          text += decoder.decode(part.value, { stream: true });
        }
        data = JSON.parse(text + decoder.decode());
      } catch (problem) { failed = true; primary = problem; }
      finally {
        try { await work.wait(() => reader.cancel()); }
        catch (problem) { if (!failed) { failed = true; primary = problem; } }
        finally {
          try { reader.releaseLock(); }
          catch (problem) { if (!failed) { failed = true; primary = problem; } }
        }
      }
      if (failed) throw failure(work, primary);
      return { status: response.status, ok: response.ok, data };
    }, this.owner, path);
  }
  private async operation(work: Work, itemId: string, requestId: string): Promise<DeletionOperation | null> {
    requireLifecycleIds([itemId], this.owner);
    if (!canonicalId(requestId)) throw new AppError('error.conflict');
    const result = await work.wait(() => this.client.rpc('item_deletion_operation_status', { p_item_id: itemId, p_request_id: requestId }).abortSignal(work.signal));
    rpcError(work, result.error);
    return result.data === null ? null : parseDeletionOperation(result.data, itemId, requestId);
  }
  operationStatus(itemId: string, requestId: string, signal?: AbortSignal) {
    return this.bounded(signal, work => this.operation(work, itemId, requestId));
  }
  operations(ids: string[], signal?: AbortSignal): Promise<DeletionOperation[]> {
    return this.bounded(signal, async work => {
      requireLifecycleIds(ids, this.owner);
      const result = await work.wait(() => this.client.rpc('item_deletion_operations', { p_item_ids: ids }).abortSignal(work.signal));
      rpcError(work, result.error);
      if (!Array.isArray(result.data) || result.data.length > ids.length) throw new AppError('error.conflict');
      const seen = new Set<string>();
      return result.data.map(value => {
        if (!isRecord(value) || typeof value.itemId !== 'string' || !ids.includes(value.itemId) || seen.has(value.itemId)) throw new AppError('error.conflict');
        seen.add(value.itemId);
        const operation = parseDeletionOperation(value, value.itemId);
        if (operation.phase === 'cancelled') throw new AppError('error.conflict');
        return operation;
      });
    });
  }
  prepareDeletion(intent: PreparedDeletionIntent, signal?: AbortSignal): Promise<DeletionOperation> {
    return this.bounded(signal, async work => {
      if (intent.epoch !== this.epoch || intent.preview.owner_id !== this.owner) throw new AppError('error.conflict');
      requireLifecycleIds([intent.preview.id], this.owner);
      if (!canonicalId(intent.requestId)) throw new AppError('error.conflict');
      const known = await this.operation(work, intent.preview.id, intent.requestId);
      let operation = known;
      if (!operation) {
        const current = await this.status(work, intent.preview.id);
        if (!samePreview(current, intent.preview)) throw new AppError('error.conflict');
        work.changed = true; work.stage = 'begin';
        const result = await work.wait(() => this.client.rpc('prepare_item_deletion', {
          p_item_id: current.id, p_request_id: intent.requestId, p_expected_version: current.version,
          p_image_manifest_sha256: current.image_manifest_sha256,
        }).abortSignal(work.signal));
        rpcError(work, result.error);
        operation = parseDeletionOperation(result.data, current.id, intent.requestId);
      }
      for (let page = 0; operation.phase === 'preparing' && page < lifecyclePageSize; page++) {
        work.changed = true;
        const args = { p_item_id: operation.itemId, p_request_id: operation.requestId };
        const result = await work.wait(() => this.client.rpc('inventory_item_deletion', {
          ...args,
        }).abortSignal(work.signal));
        rpcError(work, result.error);
        operation = parseDeletionOperation(result.data, intent.preview.id, intent.requestId);
      }
      return operation;
    });
  }
  cancelPreparation(receipt: DeletionOperation, signal?: AbortSignal): Promise<DeletionOperation> {
    return this.bounded(signal, async work => {
      const current = await this.operation(work, receipt.itemId, receipt.requestId);
      if (!current || !reversibleDeletion(current)) throw new AppError('error.conflict');
      work.changed = true;
      const result = await work.wait(() => this.client.rpc('cancel_item_deletion_preparation', {
        p_item_id: current.itemId, p_request_id: current.requestId,
      }).abortSignal(work.signal));
      rpcError(work, result.error);
      const cancelled = parseDeletionOperation(result.data, current.itemId, current.requestId);
      if (cancelled.phase !== 'cancelled') throw failure(work);
      return cancelled;
    });
  }
  continueDeletion(receipt: DeletionOperation, authorize: boolean, invalidate: (paths: string[]) => void, signal?: AbortSignal): Promise<DeletionOperation> {
    return this.bounded(signal, async work => {
      work.dispatches = 0;
      let current = await this.operation(work, receipt.itemId, receipt.requestId);
      if (!current) throw failure(work);
      if (current.phase === 'completed') return current;
      if (current.inventoryHash !== receipt.inventoryHash || current.expectedVersion !== receipt.expectedVersion) throw new AppError('error.conflict');
      const args = { p_item_id: current.itemId, p_request_id: current.requestId };
      if (current.phase === 'prepared') {
        if (!authorize || !current.inventoryHash) throw new AppError('error.conflict');
        work.changed = true; work.stage = 'begin';
        const result = await work.wait(() => this.client.rpc('authorize_item_deletion', { ...args, p_inventory_hash: current!.inventoryHash! }).abortSignal(work.signal));
        rpcError(work, result.error);
        current = parseDeletionOperation(result.data, receipt.itemId, receipt.requestId);
      }
      if (current.phase !== 'authorized' && current.phase !== 'removing_registered') throw new AppError('error.conflict');
      work.changed = true;
      while (work.dispatches < lifecyclePageSize) {
        const next = await work.wait(() => this.client.rpc('item_deletion_next_target', args).abortSignal(work.signal));
        rpcError(work, next.error);
        const target = parseDeletionTarget(next.data);
        if (!target) {
          if (current.phase === 'authorized') {
            const result = await work.wait(() => this.client.rpc('begin_prepared_item_deletion', args).abortSignal(work.signal));
            rpcError(work, result.error);
            current = parseDeletionOperation(result.data, receipt.itemId, receipt.requestId);
            if (current.phase !== 'removing_registered') throw failure(work);
            continue;
          }
          work.stage = 'finish';
          const result = await work.wait(() => this.client.rpc('finish_item_deletion', args).abortSignal(work.signal));
          rpcError(work, result.error);
          if (parseFinishReply(result.data) !== 'completed') throw failure(work);
          const completed = await this.operation(work, receipt.itemId, receipt.requestId);
          if (!completed || completed.phase !== 'completed') throw failure(work);
          return completed;
        }
        wardrobeTargetDeleteRoute(this.owner, receipt.itemId, target.path);
        if (target.ordinal > current.targetCount) throw new AppError('error.conflict');
        const reconcile = async () => {
          const result = await work.wait(() => this.client.rpc('reconcile_item_deletion_target', { ...args, p_ordinal: target.ordinal }).abortSignal(work.signal));
          rpcError(work, result.error);
          return parseTargetReconciliation(result.data, target);
        };
        // A prior DELETE may have completed without its acknowledgement.
        if (await reconcile() === 'reconciled_absent') continue;
        work.check(); invalidate([target.path]); work.check();
        await this.remove(work, target.path, receipt.itemId);
        if (await reconcile() !== 'reconciled_absent') throw failure(work);
      }
      const paused = await this.operation(work, receipt.itemId, receipt.requestId);
      if (!paused || paused.phase !== 'authorized' && paused.phase !== 'removing_registered') throw failure(work);
      return paused;
    });
  }
  delete(intent: DeletionIntent, start: boolean, invalidate: (paths: string[]) => void, signal?: AbortSignal): Promise<{ removed: number; missing: number }> {
    return this.bounded(signal, async work => {
      this.bindIntent(intent);
      const id = intent.preview.id;
      const current = await this.status(work, id);
      if (start ? !samePreview(current, intent.preview) || current.request_id !== null : !matchesClaim(current, intent)) throw new AppError('error.conflict');
      work.stage = 'begin'; work.changed = true;
      const begin = await work.wait(() => this.client.rpc('begin_item_deletion', {
        p_item_id: id, p_expected_version: intent.expectedVersion, p_request_id: intent.requestId, p_image_manifest_sha256: intent.preview.image_manifest_sha256,
      }).abortSignal(work.signal));
      rpcError(work, begin.error);
      const startedAt = parseBeginReply(begin.data, intent);
      const claimed = await this.status(work, id);
      if (!matchesClaim(claimed, intent) || claimed.started_at !== startedAt) throw failure(work);
      let cursor: string | null = null, total = 0, ready: string | null = null, removed = 0, missing = 0;
      for (;;) {
        let query = this.client.from('item_images').select(lifecycleImageColumns).eq('owner_id', this.owner).eq('item_id', id).order('id').limit(lifecyclePageSize);
        if (cursor) query = query.gt('id', cursor);
        const result = await work.wait(() => query.abortSignal(work.signal));
        rpcError(work, result.error);
        const rows = parseLifecycleImages(result.data, this.owner, id, cursor);
        total += rows.length;
        if (total > claimed.photo_count) throw failure(work);
        for (const row of rows) {
          if (row.state === 'ready') { if (ready !== null || row.id !== claimed.current_image_id) throw failure(work); ready = row.id; }
        }
        const paths = rows.flatMap(row => [row.mainPath, row.thumbPath]);
        for (let offset = 0; offset < paths.length; offset += lifecyclePageSize) {
          const batch = paths.slice(offset, offset + lifecyclePageSize);
          work.check(); invalidate(batch);
          for (const path of batch) {
            work.check();
            const outcome = await this.remove(work, path);
            if (outcome === 'removed') removed++; else missing++;
          }
        }
        if (rows.length < lifecyclePageSize) break;
        cursor = rows.at(-1)!.id;
      }
      if (total !== claimed.photo_count || ready !== claimed.current_image_id) throw failure(work);
      const finalStatus = await this.status(work, id);
      if (!matchesClaim(finalStatus, intent) || finalStatus.started_at !== startedAt) throw failure(work);
      work.stage = 'finish';
      const result = await work.wait(() => this.client.rpc('finish_item_deletion', { p_item_id: id, p_request_id: intent.requestId }).abortSignal(work.signal));
      rpcError(work, result.error);
      if (parseFinishReply(result.data) !== 'completed') throw failure(work);
      return { removed, missing };
    });
  }
}
