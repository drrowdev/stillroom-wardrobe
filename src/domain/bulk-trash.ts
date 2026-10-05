import type { LifecycleSnapshot, TrashIntent } from './item-lifecycle';

export type BatchTarget = Readonly<{ id: string; version: number }>;
export type BatchResult = { done: LifecycleSnapshot[]; failed: string[]; unconfirmed: string[]; stopped: boolean };
export type BatchSteps = {
  change: (target: BatchTarget, prepared: (intent: TrashIntent) => void) => Promise<LifecycleSnapshot>;
  check: (intent: TrashIntent) => Promise<LifecycleSnapshot>;
  uncertain: (problem: unknown) => boolean;
};

// One item at a time, in the given order. Only the owner signal stops it; finished items are never rolled back.
// An item whose outcome can't be confirmed is neither done nor failed: the next wardrobe read shows where it is.
export async function runBatch(targets: readonly BatchTarget[], steps: BatchSteps, signal: AbortSignal): Promise<BatchResult> {
  const result: BatchResult = { done: [], failed: [], unconfirmed: [], stopped: false };
  for (const target of targets) {
    if (signal.aborted) { result.stopped = true; break; }
    const prepared: { intent: TrashIntent | null } = { intent: null };
    try {
      result.done.push(await steps.change(target, intent => { prepared.intent = intent; }));
      continue;
    } catch (problem) {
      if (signal.aborted) { result.stopped = true; result.unconfirmed.push(target.id); break; }
      if (!steps.uncertain(problem) || !prepared.intent) { result.failed.push(target.id); continue; }
    }
    try { result.done.push(await steps.check(prepared.intent)); }
    catch {
      result.unconfirmed.push(target.id);
      if (signal.aborted) { result.stopped = true; break; }
    }
  }
  return result;
}
