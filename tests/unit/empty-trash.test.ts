import { describe, expect, it, vi } from 'vitest';
import { EmptyTrashController, type EmptyTrashDependencies } from '../../src/features/settings/empty-trash';
import { AppError } from '../../src/data/errors';
import { LifecycleError } from '../../src/data/item-lifecycle';
import type { DeletionOperation, DeletionStatus, PreparedDeletionIntent } from '../../src/domain/item-lifecycle';
import type { OutfitRecord } from '../../src/domain/outfits';

const owner = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const status = (n = 1): DeletionStatus => ({
  id: id(n), owner_id: owner, title: `Shirt ${n}`, version: 2, deleted_at: '2026-10-08T00:00:00Z',
  photo_count: 0, current_image_id: null, current_thumb_path: null, image_manifest_sha256: 'a'.repeat(64),
  cleanup_blocked: false, unmanifested_count: 0, request_id: null, expected_version: null, started_at: null,
});
const outfit = (n = 1): OutfitRecord => ({
  id: id(1000 + n), ownerId: owner, title: `Outfit ${n}`, occasion: 'everyday', notes: '', favourite: false,
  version: 1, deletedAt: '2026-10-08T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', links: [],
});
function receipt(itemId: string, requestId: string, phase: DeletionOperation['phase'] = 'prepared'): DeletionOperation {
  return { itemId, requestId, phase, expectedVersion: phase === 'completed' ? null : 2,
    inventoryHash: phase === 'completed' ? null : 'b'.repeat(64), targetCount: 0, reason: null,
    pendingTargets: 0, registeredTargets: 0, unmanifestedTargets: 0, begin: null };
}
function setup(clothes = [status()], outfits: OutfitRecord[] = []) {
  const ownerAbort = new AbortController(), scope = { ownerId: owner, epoch: 1, signal: ownerAbort.signal };
  const operations = new Map<string, DeletionOperation>();
  let isTrash = true;
  const items = {
    list: vi.fn(async (after: string | null) => {
      const rows = clothes.filter(row => after === null || row.id > after).slice(0, 40);
      return { rows, next: rows.length === 40 ? rows.at(-1)!.id : null };
    }),
    operations: vi.fn(async (): Promise<DeletionOperation[]> => []),
    findStatus: vi.fn(async (itemId: string) => clothes.find(row => row.id === itemId) ?? null),
    statusOf: vi.fn(async (itemId: string) => { const row = clothes.find(value => value.id === itemId); if (!row) throw new AppError('error.unavailable'); return row; }),
    operationStatus: vi.fn(async (itemId: string) => operations.get(itemId) ?? null),
    prepareDeletion: vi.fn(async (intent: PreparedDeletionIntent) => {
      const value = receipt(intent.preview.id, intent.requestId); operations.set(value.itemId, value); return value;
    }),
    continueDeletion: vi.fn(async (value: DeletionOperation) => {
      const complete = receipt(value.itemId, value.requestId, 'completed'); operations.set(value.itemId, complete); return complete;
    }),
    cancelPreparation: vi.fn(async (value: DeletionOperation) => receipt(value.itemId, value.requestId, 'cancelled')),
  };
  const lifecycle: EmptyTrashDependencies['outfits'] = {
    execute: vi.fn(async (records: readonly OutfitRecord[]) => ({ done: records.map(record => record.id), failed: [],
      outcomes: records.map(record => ({ id: record.id, outcome: { kind: 'saved' as const, record: null } })) })),
    check: vi.fn(async () => ({ done: [], failed: [], outcomes: [] })), pendingWear: vi.fn(() => null), unknown: [], busy: false, locked: false,
  };
  const dependencies: EmptyTrashDependencies = {
    items, outfits: lifecycle, listOutfits: vi.fn(async () => outfits),
    readOutfit: vi.fn(async itemId => outfits.find(row => row.id === itemId) ?? null),
    checkOutfit: vi.fn(async () => ({ kind: 'notSaved' as const })),
    invalidate: vi.fn(), onDeleting: vi.fn(), onSettled: vi.fn(), online: true,
  };
  const controller = new EmptyTrashController(scope);
  const detach = controller.attach(dependencies, () => isTrash);
  return { controller, dependencies, items, lifecycle, operations, ownerAbort, scope, detach, leave: () => { isTrash = false; } };
}
describe('Empty Trash', () => {
  it('orders clothes canonically even when the status RPC returns a different row order', async () => {
    const h = setup([status(2), status(1)]);
    await h.controller.discover(); await h.controller.confirm();
    expect(vi.mocked(h.items.prepareDeletion).mock.calls.map(call => call[0].preview.id)).toEqual([id(1), id(2)]);
  });
  it.each(['attached', 'owner-changed', 'epoch-changed'])('settles a stopped batch only in its own attached scope: %s', async change => {
    const h = setup([status(1), status(2)]);
    h.items.findStatus.mockImplementation(async itemId => {
      if (itemId === id(2)) h.controller.pause();
      return itemId === id(2) ? status(2) : status(1);
    });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.dependencies.onSettled).not.toHaveBeenCalled();
    if (change === 'owner-changed') h.scope.ownerId = id(999);
    if (change === 'epoch-changed') h.scope.epoch++;
    h.controller.clear();
    if (change === 'attached') expect(h.dependencies.onSettled).toHaveBeenCalledWith([id(1)]);
    else expect(h.dependencies.onSettled).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().targets).toEqual([]);
  });
  it('discovers all pages and cancels without preparation or authorization', async () => {
    const h = setup(Array.from({ length: 80 }, (_, n) => status(n + 1)), Array.from({ length: 501 }, (_, n) => outfit(n + 1)));
    await h.controller.discover();
    expect(h.controller.getSnapshot().targets).toHaveLength(581);
    expect(h.items.list).toHaveBeenCalledTimes(3);
    h.controller.clear();
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });
  it('deletes outfits first, then all frozen clothes, not later additions', async () => {
    const clothes = [status(), status(2)], h = setup(clothes, [outfit()]);
    const order: string[] = [];
    vi.mocked(h.lifecycle.execute).mockImplementation(async records => {
      order.push('outfit'); return { done: [records[0]!.id], failed: [], outcomes: [{ id: records[0]!.id, outcome: { kind: 'saved', record: null } }] };
    });
    const finish = h.items.continueDeletion.getMockImplementation()!;
    h.items.continueDeletion.mockImplementation(async value => { order.push(value.itemId); return finish(value); });
    await h.controller.discover(); clothes.push(status(3)); await h.controller.confirm();
    expect(order).toEqual(['outfit', id(1), id(2)]);
    expect(h.controller.getSnapshot().phase).toBe('finished');
    expect(h.items.findStatus).not.toHaveBeenCalledWith(id(3), expect.anything());
  });
  it('known cleanup or pending Wear blockers prevent confirmation without dropping entries', async () => {
    const h = setup([{ ...status(), cleanup_blocked: true, unmanifested_count: 1 }], [outfit()]);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets).toHaveLength(2);
    expect(h.controller.getSnapshot().blockers).toContain('deletion.blocked');
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });
  it('pre-existing receipts never use absence as proof or call findStatus', async () => {
    const h = setup();
    const existing = receipt(id(1), id(99), 'authorized');
    h.items.operations.mockResolvedValue([existing]); h.operations.set(id(1), existing);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.findStatus).not.toHaveBeenCalled();
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).toHaveBeenCalledWith(existing, false, expect.any(Function), expect.any(AbortSignal));
    expect(h.controller.getSnapshot().targets[0]?.result).toBe('deleted');
  });
  it('a missing previously known receipt stops before any destructive continuation', async () => {
    const h = setup();
    h.items.operations.mockResolvedValue([receipt(id(1), id(99), 'authorized')]);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().phase).toBe('paused');
    expect(h.items.findStatus).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
  });
  it.each([false, true])('continues an exact legacy claim with an existing prepared operation: %s', async existing => {
    const baseline = { ...status(), version: 3, request_id: id(99), expected_version: 2, started_at: '2026-10-08T00:00:01Z' };
    const prepared = { ...receipt(id(1), id(99)), expectedVersion: 3,
      begin: { request_id: id(99), expected_version: 2, version: 3, started_at: baseline.started_at,
        image_manifest_sha256: baseline.image_manifest_sha256 } };
    const h = setup([baseline]);
    if (existing) { h.items.operations.mockResolvedValue([prepared]); h.operations.set(id(1), prepared); }
    else h.items.prepareDeletion.mockImplementation(async intent => {
      expect(intent.requestId).toBe(baseline.request_id); h.operations.set(id(1), prepared); return prepared;
    });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.prepareDeletion).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(h.items.findStatus).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).toHaveBeenCalledWith(prepared, true, expect.any(Function), expect.any(AbortSignal));
    expect(h.controller.getSnapshot().phase).toBe('finished');
  });
  it('preserves the original operation version when a normal operation already began', async () => {
    const baseline = { ...status(), version: 3, request_id: id(99), expected_version: 2, started_at: '2026-10-08T00:00:01Z' };
    const operation = { ...receipt(id(1), id(99), 'removing_registered'),
      begin: { request_id: id(99), expected_version: 2, version: 3, started_at: baseline.started_at,
        image_manifest_sha256: baseline.image_manifest_sha256 } };
    const h = setup([baseline]); h.items.operations.mockResolvedValue([operation]); h.operations.set(id(1), operation);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.continueDeletion).toHaveBeenCalledWith(operation, false, expect.any(Function), expect.any(AbortSignal));
    expect(h.controller.getSnapshot().phase).toBe('finished');
  });
  it.each(['version', 'request', 'begin', 'timestamp', 'manifest'] as const)('rejects a legacy receipt with a mismatched %s binding', async field => {
    const baseline = { ...status(), version: 3, request_id: id(99), expected_version: 2, started_at: '2026-10-08T00:00:01Z' };
    const begin = { request_id: id(99), expected_version: 2, version: 3, started_at: baseline.started_at,
      image_manifest_sha256: baseline.image_manifest_sha256 };
    const operation = { ...receipt(id(1), id(99)), expectedVersion: field === 'version' ? 4 : 3,
      begin: field === 'begin' ? null : { ...begin,
        request_id: field === 'request' ? id(98) : begin.request_id,
        started_at: field === 'timestamp' ? '2026-10-08T00:00:02Z' : begin.started_at,
        image_manifest_sha256: field === 'manifest' ? 'c'.repeat(64) : begin.image_manifest_sha256 } };
    const h = setup([baseline]); h.items.operations.mockResolvedValue([operation]); h.operations.set(id(1), operation);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().phase).toBe('paused');
  });
  it.each([false, true])('retains a newly reconciled reversible fence for Cancel even when the baseline changed: %s', async changed => {
    const h = setup();
    h.items.prepareDeletion.mockImplementation(async intent => {
      h.operations.set(id(1), receipt(id(1), intent.requestId));
      throw new AppError('error.conflict');
    });
    if (changed) h.items.statusOf.mockResolvedValue({ ...status(), version: 3 });
    await h.controller.discover(); await h.controller.confirm();
    const prepared = h.operations.get(id(1))!;
    expect(h.controller.getSnapshot().targets[0]).toMatchObject({ result: changed ? 'changed' : 'resumable', receipt: prepared });
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    await h.controller.cancelPreparation();
    expect(h.items.cancelPreparation).toHaveBeenCalledWith(prepared, expect.any(AbortSignal));
    expect(h.controller.getSnapshot().targets[0]).toMatchObject({ kind: 'clothes', receipt: { phase: 'cancelled' } });
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
  });
  it.each(['item', 'request', 'version'] as const)('never adopts a newly discovered foreign or invalid %s receipt', async field => {
    const h = setup();
    h.items.prepareDeletion.mockImplementation(async intent => {
      const operation = receipt(field === 'item' ? id(2) : id(1), field === 'request' ? id(99) : intent.requestId);
      h.operations.set(id(1), field === 'version' ? { ...operation, expectedVersion: 3 } : operation);
      throw new AppError('error.conflict');
    });
    await h.controller.discover(); await h.controller.confirm(); await h.controller.cancelPreparation();
    expect(h.controller.getSnapshot().targets[0]).toMatchObject({ kind: 'clothes', receipt: null });
    expect(h.items.cancelPreparation).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
  });
  it('retains a recovered fence when the status read fails, then permits Cancel only after Check', async () => {
    const h = setup();
    h.items.prepareDeletion.mockImplementation(async intent => {
      h.operations.set(id(1), receipt(id(1), intent.requestId)); throw new AppError('error.conflict');
    });
    h.items.statusOf.mockRejectedValueOnce(new AppError('error.unavailable'));
    await h.controller.discover(); await h.controller.confirm(); await h.controller.cancelPreparation();
    expect(h.controller.getSnapshot().targets[0]).toMatchObject({ result: 'unknown', receipt: h.operations.get(id(1)) });
    expect(h.items.cancelPreparation).not.toHaveBeenCalled();
    await h.controller.check(); await h.controller.cancelPreparation();
    expect(h.items.cancelPreparation).toHaveBeenCalledTimes(1);
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
  });
  it('cannot replace a known inventory binding during conflict reconciliation', async () => {
    const h = setup(), prepared = receipt(id(1), id(99));
    h.items.operations.mockResolvedValue([prepared]);
    h.operations.set(id(1), { ...prepared, inventoryHash: 'c'.repeat(64) });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets[0]).toMatchObject({ receipt: prepared });
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
  });
  it('pending Wear and preflight receipt blockers keep ALL targets in review', async () => {
    const h = setup([status()], [outfit()]);
    const blocked = { ...receipt(id(1), id(99)), phase: 'blocked_preflight' as const, inventoryHash: null, reason: 'INVARIANT' as const };
    h.items.operations.mockResolvedValue([blocked]);
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets).toHaveLength(2);
    expect(h.controller.getSnapshot().blockers).toEqual(['deletion.blocked']);
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });
  it('garment transient conflict retains UUID and original consent after read-only unchanged reconciliation', async () => {
    const h = setup();
    vi.mocked(h.items.prepareDeletion).mockRejectedValueOnce(new AppError('error.conflict'));
    await h.controller.discover(); await h.controller.confirm();
    const intent = vi.mocked(h.items.prepareDeletion).mock.calls[0]![0];
    expect(h.controller.getSnapshot().targets[0]?.result).toBe('resumable');
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    await h.controller.resume();
    expect(vi.mocked(h.items.prepareDeletion).mock.calls[1]![0]).toBe(intent);
    expect(h.controller.getSnapshot().phase).toBe('finished');
  });
  it('a failed pre-read cannot turn into a skipped or deleted target', async () => {
    const h = setup(); h.items.findStatus.mockRejectedValue(new AppError('error.unavailable'));
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets[0]?.result).toBe('waiting');
    expect(h.controller.getSnapshot().error).toBe('error.unavailable');
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
  });
  it('a not-started or empty hook result never counts as deletion', async () => {
    const h = setup([], [outfit()]);
    vi.mocked(h.lifecycle.execute).mockResolvedValue({ done: [], failed: [], outcomes: [] });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets[0]?.result).toBe('unknown');
    expect(h.controller.getSnapshot().phase).toBe('paused');
  });
  it('proven absent/restored before dispatch skips, while changed/retrashed stops', async () => {
    const clothes = [status(), status(2)], h = setup(clothes);
    await h.controller.discover(); clothes.splice(0, 1); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets.map(target => target.result)).toEqual(['skipped', 'deleted']);
    const changed = setup([status()]);
    await changed.controller.discover();
    changed.items.findStatus.mockResolvedValue({ ...status(), version: 4, deleted_at: '2026-10-08T01:00:00Z' });
    await changed.controller.confirm();
    expect(changed.controller.getSnapshot().targets[0]?.result).toBe('changed');
    expect(changed.items.prepareDeletion).not.toHaveBeenCalled();
  });
  it('uncertainty requires read-only Check and retains original identity', async () => {
    const h = setup([status(), status(2)]);
    h.items.continueDeletion.mockRejectedValueOnce(new LifecycleError('begin', true));
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.continueDeletion).toHaveBeenCalledTimes(1);
    await h.controller.resume(); expect(h.items.continueDeletion).toHaveBeenCalledTimes(1);
    await h.controller.check(); expect(h.items.continueDeletion).toHaveBeenCalledTimes(1);
    await h.controller.resume();
    expect(h.controller.getSnapshot().phase).toBe('finished');
    expect(h.items.prepareDeletion).toHaveBeenCalledTimes(2);
    expect(h.items.findStatus).toHaveBeenCalledTimes(2);
  });
  it('bounded receipt pauses until a deliberate Resume without new confirmation', async () => {
    const h = setup([status(), status(2)]);
    h.items.continueDeletion.mockImplementationOnce(async value => {
      const paused = receipt(value.itemId, value.requestId, 'authorized'); h.operations.set(value.itemId, paused); return paused;
    });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().phase).toBe('paused');
    expect(h.items.prepareDeletion).toHaveBeenCalledTimes(1);
    await h.controller.resume(); expect(h.controller.getSnapshot().phase).toBe('finished');
    expect(h.items.continueDeletion).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'authorized' }), false, expect.any(Function), expect.any(AbortSignal));
  });
  it('transient unchanged conflict permits same-consent Resume, never auto-retry', async () => {
    const h = setup([status()], [outfit()]);
    vi.mocked(h.lifecycle.execute).mockResolvedValueOnce({ done: [], failed: [outfit().id],
      outcomes: [{ id: outfit().id, outcome: { kind: 'conflict' } }] });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.controller.getSnapshot().targets[0]?.result).toBe('resumable');
    expect(h.lifecycle.execute).toHaveBeenCalledTimes(1);
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    await h.controller.resume(); expect(h.controller.getSnapshot().phase).toBe('finished');
  });
  it('global Check resolution uses the batch own intent and current mount dependencies', async () => {
    const h = setup([status()], [outfit()]);
    vi.mocked(h.lifecycle.execute).mockResolvedValueOnce({ done: [], failed: [outfit().id],
      outcomes: [{ id: outfit().id, outcome: { kind: 'unknown' } }] });
    await h.controller.discover(); await h.controller.confirm(); h.detach();
    const next = { ...h.dependencies, checkOutfit: vi.fn(async () => ({ kind: 'saved' as const, record: null })) };
    h.controller.attach(next, () => true);
    await h.controller.check();
    expect(next.checkOutfit).toHaveBeenCalledWith(expect.objectContaining({ baseline: outfit(), action: 'delete' }));
    expect(h.dependencies.checkOutfit).not.toHaveBeenCalled();
    expect(h.items.continueDeletion).not.toHaveBeenCalled();
    await h.controller.resume(); expect(h.controller.getSnapshot().phase).toBe('finished');
  });
  it('hash departure after an await prevents the next target before detach', async () => {
    const h = setup([status(), status(2)]);
    h.items.findStatus.mockImplementationOnce(async () => { h.leave(); return status(); });
    await h.controller.discover(); await h.controller.confirm();
    expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().phase).toBe('paused');
  });
  it('owner abort clears consent and private snapshot; offline and duplicate clicks dispatch no more work', async () => {
    const h = setup();
    await Promise.all([h.controller.discover(), h.controller.discover()]);
    expect(h.items.list).toHaveBeenCalledTimes(1);
    h.controller.updateDependencies({ ...h.dependencies, online: false });
    await h.controller.confirm(); expect(h.items.prepareDeletion).not.toHaveBeenCalled();
    h.ownerAbort.abort();
    expect(h.controller.getSnapshot().targets).toEqual([]);
    await h.controller.resume(); expect(h.items.prepareDeletion).not.toHaveBeenCalled();
  });
});
