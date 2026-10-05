import { describe, expect, it } from 'vitest';
import { runBatch, type BatchSteps, type BatchTarget } from '../../src/domain/bulk-trash';
import type { LifecycleSnapshot, TrashIntent } from '../../src/domain/item-lifecycle';

const snapshot = (id: string, version: number) => ({ id, version }) as unknown as LifecycleSnapshot;
const intentFor = (target: BatchTarget) => ({ baseline: snapshot(target.id, target.version), trashed: true, epoch: 1 }) as unknown as TrashIntent;
class Uncertain extends Error {}
const targets: BatchTarget[] = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, version: index + 1 }));

function steps(outcomes: Record<string, 'ok' | 'fail' | 'early' | 'lost' | 'lostUnconfirmed'>, log: string[], hooks: { afterChange?: (id: string) => void } = {}): BatchSteps {
  let active = 0;
  return {
    async change(target, prepared) {
      active++;
      expect(active).toBe(1);
      log.push(`change:${target.id}:${target.version}`);
      await Promise.resolve();
      active--;
      hooks.afterChange?.(target.id);
      const outcome = outcomes[target.id] ?? 'ok';
      if (outcome === 'early') throw new Uncertain();
      prepared(intentFor(target));
      if (outcome === 'fail') throw new Error('conflict');
      if (outcome === 'lost' || outcome === 'lostUnconfirmed') throw new Uncertain();
      return snapshot(target.id, target.version + 1);
    },
    async check(intent) {
      log.push(`check:${intent.baseline.id}`);
      if (outcomes[intent.baseline.id] === 'lostUnconfirmed') throw new Uncertain();
      return snapshot(intent.baseline.id, intent.baseline.version + 1);
    },
    uncertain: problem => problem instanceof Uncertain,
  };
}

describe('bulk move to Trash', () => {
  it('runs one item at a time, in order, and returns each new version', async () => {
    const log: string[] = [];
    const result = await runBatch(targets, steps({}, log), new AbortController().signal);
    expect(log).toEqual(['change:a:1', 'change:b:2', 'change:c:3', 'change:d:4']);
    expect(result).toEqual({ done: targets.map(target => snapshot(target.id, target.version + 1)), failed: [], unconfirmed: [], stopped: false });
  });
  it('keeps going after a failure and never rolls back finished items', async () => {
    const log: string[] = [];
    const result = await runBatch(targets, steps({ b: 'fail', c: 'early' }, log), new AbortController().signal);
    expect(result.done.map(row => row.id)).toEqual(['a', 'd']);
    expect(result.failed).toEqual(['b', 'c']);
    expect(log).not.toContain('check:c');
    expect(result.unconfirmed).toEqual([]);
  });
  it('checks a lost reply once: confirmed counts as done, otherwise the item is left for the next read', async () => {
    const log: string[] = [];
    const result = await runBatch(targets, steps({ a: 'lost', b: 'lostUnconfirmed' }, log), new AbortController().signal);
    expect(log.filter(entry => entry.startsWith('check'))).toEqual(['check:a', 'check:b']);
    expect(result.done.map(row => row.id)).toEqual(['a', 'c', 'd']);
    expect(result.failed).toEqual([]);
    expect(result.unconfirmed).toEqual(['b']);
  });
  it('stops on an owner change without starting another item', async () => {
    const log: string[] = [];
    const owner = new AbortController();
    const result = await runBatch(targets, steps({}, log, { afterChange: id => { if (id === 'b') owner.abort(); } }), owner.signal);
    expect(log).toEqual(['change:a:1', 'change:b:2']);
    expect(result.stopped).toBe(true);
    expect(result.done.map(row => row.id)).toEqual(['a', 'b']);
  });
  it('treats an item interrupted by an owner change as unconfirmed, not failed', async () => {
    const owner = new AbortController();
    const interrupted: BatchSteps = {
      ...steps({}, []),
      async change(target) { if (target.id === 'b') { owner.abort(); throw new Uncertain(); } return snapshot(target.id, 9); },
    };
    const result = await runBatch(targets, interrupted, owner.signal);
    expect(result).toEqual({ done: [snapshot('a', 9)], failed: [], unconfirmed: ['b'], stopped: true });
  });
  it('does nothing when the owner is already gone', async () => {
    const owner = new AbortController(); owner.abort();
    const log: string[] = [];
    expect(await runBatch(targets, steps({}, log), owner.signal)).toEqual({ done: [], failed: [], unconfirmed: [], stopped: true });
    expect(log).toEqual([]);
  });
});
