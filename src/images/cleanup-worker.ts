/// <reference lib="webworker" />
import { cleanupCheck, type CleanupVerdict } from './fidelity';

// BG2c-3 (plan rev8b §2): runs the clean-up check off the main thread. It receives H0, R and H2 as transferred buffers,
// answers once and is terminated by the caller; Skip and the stage timeout terminate it mid-check.
export type CleanupWorkerRequest = { h0: ArrayBuffer; reference: ArrayBuffer; h2: ArrayBuffer };
export type CleanupWorkerReply = { type: 'verdict'; verdict: CleanupVerdict } | { type: 'error' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<CleanupWorkerRequest>) => {
  try {
    // Nothing else shares this thread, so the check never needs to give the event loop a turn.
    const verdict = await cleanupCheck(new Uint8ClampedArray(data.h0), new Uint8Array(data.reference), new Uint8ClampedArray(data.h2),
      { yieldNow: async () => undefined });
    scope.postMessage({ type: 'verdict', verdict } satisfies CleanupWorkerReply);
  } catch {
    scope.postMessage({ type: 'error' } satisfies CleanupWorkerReply);
  }
};
