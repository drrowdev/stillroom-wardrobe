import { describe, expect, it } from 'vitest';
import { limiter } from '../../src/features/outfits/card-pictures';

const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; };

describe('the card picture limiter (OUTFITS-PICTURES)', () => {
  it('runs at most the allowed number at once and the rest in the order asked', async () => {
    const run = limiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    let active = 0, peak = 0;
    const jobs = gates.map((g, at) => run(new AbortController().signal, async () => {
      started.push(at); active += 1; peak = Math.max(peak, active);
      await g.wait; active -= 1; return at;
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[0]!.open(); await jobs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.open(); gates[2]!.open(); gates[3]!.open();
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });
  it('never starts a job that was aborted while it waited, and frees its place', async () => {
    const run = limiter(1);
    const first = gate();
    const job = run(new AbortController().signal, async () => { await first.wait; return 'first'; });
    const controller = new AbortController();
    let ran = false;
    const waiting = run(controller.signal, async () => { ran = true; return 'second'; });
    controller.abort();
    expect(await waiting).toBeNull();
    first.open();
    expect(await job).toBe('first');
    expect(await run(new AbortController().signal, async () => 'third')).toBe('third');
    expect(ran).toBe(false);
  });
  it('releases its place when a job throws', async () => {
    const run = limiter(1);
    await expect(run(new AbortController().signal, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await run(new AbortController().signal, async () => 'next')).toBe('next');
  });
});
