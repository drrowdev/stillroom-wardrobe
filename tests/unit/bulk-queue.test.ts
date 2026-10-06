import { describe, expect, it } from 'vitest';
import { BATCH_LIMIT, BulkQueue, estimateMicro, remainingMicro, type AnalysisTicket } from '../../src/features/wardrobe/bulk-add/bulk-queue';
import type { StageResult } from '../../src/features/wardrobe/enhancement-stage';

const signal = () => new AbortController().signal;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const ticketOf = (value: unknown) => {
  if (!value || typeof value !== 'object') throw new Error(`expected a ticket, got ${String(value)}`);
  return value as AnalysisTicket;
};
const busy: StageResult = { kind: 'skipped', line: 'none', requestId: null, reason: 'busy' } as StageResult;
const done = { kind: 'done' } as unknown as StageResult;

describe('BulkQueue analysis bound', () => {
  it('admits at most two unresolved analysis requests and frees a slot only on proven resolution', async () => {
    const queue = new BulkQueue();
    const a = ticketOf(await queue.analysis.admit(signal(), false));
    const b = ticketOf(await queue.analysis.admit(signal(), false));
    let third: unknown = 'waiting';
    void queue.analysis.admit(signal(), false).then(value => { third = value; });
    await flush();
    expect(third).toBe('waiting');
    expect(a.send()).toBeNull(); expect(b.send()).toBeNull();
    a.resolved();
    await flush();
    expect(third).not.toBe('waiting');
    expect(typeof third).toBe('object');
    b.resolved(); b.resolved();
    expect(queue.analysisSlots().occupied).toBe(1);
  });

  it('keeps an abandoned sent request as uncertain and never admits a third while two are uncertain', async () => {
    const queue = new BulkQueue();
    const a = ticketOf(await queue.analysis.admit(signal(), false));
    const b = ticketOf(await queue.analysis.admit(signal(), false));
    expect(a.send()).toBeNull(); expect(b.send()).toBeNull();
    a.abandon();
    expect(queue.analysisSlots()).toEqual({ occupied: 2, uncertain: 1 });
    expect(queue.snapshot().paused).toBe(false);
    b.abandon();
    expect(queue.analysisSlots()).toEqual({ occupied: 2, uncertain: 2 });
    expect(queue.snapshot().paused).toBe(true);
    // Paused refuses automatic and manual ("Fill in again") analysis alike: nothing bypasses the bound.
    expect(await queue.analysis.admit(signal(), false)).toBe('paused');
    expect(await queue.analysis.admit(signal(), true)).toBe('paused');
  });

  it('refuses waiting requests when the bound becomes paused', async () => {
    const queue = new BulkQueue();
    const a = ticketOf(await queue.analysis.admit(signal(), false));
    const b = ticketOf(await queue.analysis.admit(signal(), false));
    const waiting = queue.analysis.admit(signal(), false);
    expect(a.send()).toBeNull(); expect(b.send()).toBeNull(); a.abandon(); b.abandon();
    expect(await waiting).toBe('paused');
  });

  it('frees an unsent held ticket on abandon', async () => {
    const queue = new BulkQueue();
    const a = ticketOf(await queue.analysis.admit(signal(), false));
    a.abandon();
    expect(queue.analysisSlots().occupied).toBe(0);
  });

  it('halts automatic analysis on rate or allowance outcomes but still admits a manual retry', async () => {
    const queue = new BulkQueue();
    const a = ticketOf(await queue.analysis.admit(signal(), false));
    expect(a.send()).toBeNull(); a.resolved('RATE_LIMIT');
    expect(queue.snapshot().halted.analysis).toBe('rate');
    expect(await queue.analysis.admit(signal(), false)).toBe('rate');
    expect(typeof await queue.analysis.admit(signal(), true)).toBe('object');
    const other = new BulkQueue();
    ticketOf(await other.analysis.admit(signal(), false)).resolved('ALLOWANCE');
    expect(await other.analysis.admit(signal(), false)).toBe('allowance');
  });

  it('checks the send boundary: a ticket admitted before Stop or a halt sends nothing and frees its slot', async () => {
    for (const end of ['stop', 'halt'] as const) {
      const queue = new BulkQueue();
      const a = ticketOf(await queue.analysis.admit(signal(), false));
      if (end === 'stop') queue.stop(); else queue.halt('analysis', 'rate');
      expect(a.send()).toBe(end === 'stop' ? 'stopped' : 'rate');
      expect(queue.analysisSlots().occupied).toBe(0);
      a.abandon();
      expect(queue.analysisSlots()).toEqual({ occupied: 0, uncertain: 0 });
    }
  });

  it('a manual ticket still sends after Stop, but not while hidden or paused', async () => {
    const queue = new BulkQueue();
    const manual = ticketOf(await queue.analysis.admit(signal(), true));
    queue.stop();
    expect(manual.send()).toBeNull();
    expect(manual.send()).toBeNull();
    const hidden = new BulkQueue();
    const held = ticketOf(await hidden.analysis.admit(signal(), true));
    hidden.setHidden(true);
    expect(held.send()).toBe('hidden');
    expect(hidden.analysisSlots().occupied).toBe(0);
  });

  it('returns null for an aborted waiter and leaves the slot to the next', async () => {
    const queue = new BulkQueue();
    ticketOf(await queue.analysis.admit(signal(), false));
    ticketOf(await queue.analysis.admit(signal(), false));
    const controller = new AbortController();
    const waiting = queue.analysis.admit(controller.signal, false);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(queue.analysisSlots().occupied).toBe(2);
  });
});

describe('BulkQueue stages', () => {
  it('runs one preparation at a time, in order', async () => {
    const queue = new BulkQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = queue.prepare(() => new Promise<void>(resolve => { log.push('a'); release = resolve; }), signal());
    const second = queue.prepare(async () => { log.push('b'); }, signal());
    await flush();
    expect(log).toEqual(['a']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['a', 'b']);
  });

  it('holds every slot while the page is hidden', async () => {
    const queue = new BulkQueue(true);
    let ran = false;
    const work = queue.prepare(async () => { ran = true; }, signal());
    await flush();
    expect(ran).toBe(false);
    queue.setHidden(false);
    await work;
    expect(ran).toBe(true);
  });

  it('Stop ends automatic clean-up and analysis but not manual actions or preparation', async () => {
    const queue = new BulkQueue();
    queue.stop();
    expect(queue.snapshot().stopped).toBe(true);
    expect(await queue.analysis.admit(signal(), false)).toBe('stopped');
    expect(await queue.cleanup(async () => done, signal(), false)).toEqual({ kind: 'skipped', line: 'none', requestId: null });
    expect(await queue.cleanup(async () => done, signal(), true)).toBe(done);
    let prepared = false;
    await queue.prepare(async () => { prepared = true; }, signal());
    expect(prepared).toBe(true);
  });

  it('retries a busy clean-up with the same input on the bounded backoff, then falls back', async () => {
    const waits: number[] = [];
    const queue = new BulkQueue(false, [1, 2], async (ms) => { waits.push(ms); });
    let runs = 0;
    const result = await queue.cleanup(async () => { runs++; return busy; }, signal(), false);
    expect(runs).toBe(3);
    expect(waits).toEqual([1, 2]);
    expect(result).toBe(busy);
    let after = 0;
    const success = await queue.cleanup(async () => (++after === 2 ? done : busy), signal(), false);
    expect(success).toBe(done);
  });

  it('Stop cancels a queued busy backoff without another send', async () => {
    const queue = new BulkQueue(false, [60_000]);
    let runs = 0;
    const pending = queue.cleanup(async () => { runs++; return busy; }, signal(), false);
    await flush();
    queue.stop();
    expect(await pending).toBe(busy);
    expect(runs).toBe(1);
  });

  it('hiding the page cancels a waiting busy backoff; once visible it sends again only if still eligible', async () => {
    let sleeping!: AbortSignal;
    const queue = new BulkQueue(false, [60_000], (_ms, sleep) => new Promise((_resolve, reject) => {
      sleeping = sleep;
      sleep.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    let runs = 0;
    const pending = queue.cleanup(async () => (++runs === 1 ? busy : done), signal(), false);
    await flush();
    queue.setHidden(true);
    expect(sleeping.aborted).toBe(true);
    await flush();
    expect(runs).toBe(1);
    queue.setHidden(false);
    expect(await pending).toBe(done);
    expect(runs).toBe(2);

    const stopped = new BulkQueue(false, [60_000], (_ms, sleep) => new Promise((_resolve, reject) => {
      sleep.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    let again = 0;
    const halted = stopped.cleanup(async () => { again++; return busy; }, signal(), false);
    await flush();
    stopped.setHidden(true);
    await flush();
    stopped.stop();
    expect(await halted).toBe(busy);
    expect(again).toBe(1);
  });

  it('a clean-up deferred at the send boundary runs once visible, and never after Stop while hidden', async () => {
    const deferred = { kind: 'skipped', line: 'none', requestId: null, reason: 'deferred' } as StageResult;
    const queue = new BulkQueue();
    const seen: (string | null)[] = [];
    queue.setHidden(true);
    queue.setHidden(false);
    const pending = queue.cleanup(async (dispatchable) => {
      seen.push(dispatchable());
      if (seen.length === 1) { queue.setHidden(true); return dispatchable() === 'hidden' ? deferred : done; }
      return done;
    }, signal(), false);
    await flush();
    expect(seen).toEqual([null]);
    queue.setHidden(false);
    expect(await pending).toBe(done);
    expect(seen).toEqual([null, null]);

    const other = new BulkQueue();
    let runs = 0;
    const dropped = other.cleanup(async (dispatchable) => {
      runs++; other.setHidden(true);
      return dispatchable() === 'hidden' ? deferred : done;
    }, signal(), false);
    await flush();
    other.stop();
    expect(await dropped).toEqual({ kind: 'skipped', line: 'none', requestId: null });
    expect(runs).toBe(1);
    expect(other.snapshot().stopped).toBe(true);
  });

  it('the clean-up send boundary refuses after Stop', async () => {
    const queue = new BulkQueue();
    const result = await queue.cleanup(async (dispatchable) => { queue.stop(); return dispatchable() === 'refused' ? busy : done; }, signal(), false);
    expect(result).toBe(busy);
  });

  it('halts automatic clean-up on rate and allowance, without retrying', async () => {
    for (const reason of ['rate', 'allowance'] as const) {
      const queue = new BulkQueue(false, [1], async () => undefined);
      let runs = 0;
      const result = { kind: 'skipped', line: 'generic', requestId: null, reason } as StageResult;
      await queue.cleanup(async () => { runs++; return result; }, signal(), false);
      expect(runs).toBe(1);
      expect(queue.snapshot().halted.cleanup).toBe(reason);
      expect(await queue.cleanup(async () => done, signal(), false)).toMatchObject({ kind: 'skipped' });
    }
  });

  it('never retries an ambiguous clean-up', async () => {
    const queue = new BulkQueue(false, [1], async () => undefined);
    let runs = 0;
    const ambiguous = { kind: 'skipped', line: 'none', requestId: 'r', reason: 'ambiguous' } as StageResult;
    expect(await queue.cleanup(async () => { runs++; return ambiguous; }, signal(), false)).toBe(ambiguous);
    expect(runs).toBe(1);
  });

  it('dispose drops every waiter', async () => {
    const queue = new BulkQueue();
    ticketOf(await queue.analysis.admit(signal(), false));
    ticketOf(await queue.analysis.admit(signal(), false));
    const waiting = queue.analysis.admit(signal(), false);
    queue.dispose();
    expect(await waiting).toBeNull();
  });
});

describe('bulk estimate', () => {
  it('limits a batch to 50 photos', () => expect(BATCH_LIMIT).toBe(50));
  it('shows an estimate only when the batch may use more than what is left', () => {
    expect(remainingMicro('20000000', '19990000')).toBe(10_000n);
    expect(remainingMicro('20000000', '25000000')).toBe(0n);
    expect(estimateMicro(3, 10_000_000n)).toBeNull();
    expect(estimateMicro(50, 1_000_000n)).toBe(2_000_000n);
  });
});
