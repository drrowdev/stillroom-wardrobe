// OUTFITGEN2: the pure rules of the automatic pictures of the owner wearing each suggested outfit. No React, clock, network or
// storage: the queue (features/outfitgen/picture-queue.ts) feeds these functions what it read and does what they decide.
// A picture is found by the garments of its planned try-on steps, never by a stored link: a try-on result keeps the item ids of
// the steps that made it, so the key is the sorted ids of the selected steps.
import { TRYON_MAX_STEPS, TRYON_RESERVATION_MICRO } from './tryon';

export const PICTURE_LIMITS = Object.freeze({
  /** The queue stops here and leaves the last ten of the 200 saved pictures for the owner's own try-ons. */
  resultsStop: 190,
  /** A chain starts only if this share of the monthly allowance stays unreserved afterwards. Best effort, not an escrow. */
  reservePercent: 15,
  /** An outfit needs at least this many steps for the picture to show the outfit rather than one garment. */
  minSteps: 2,
  maxAttempts: 2,
  /** Two failed outfits in a row stop the queue. */
  failureStop: 2,
  busyStopMs: 5 * 60_000,
  stopMs: 30 * 60_000,
  /** A chain's server lifetime is 30 minutes; rows seen this long without change are not a running chain. */
  reservedWaitMs: 31 * 60_000,
  pollMs: 60_000,
  startDelayMs: 8_000,
});

export type PictureResult = Readonly<{ id: string; outfitId: string | null; itemIds: readonly string[]; completedAtMs: number }>;

/** The key of a set of garments, whatever their order. */
export const pictureKey = (ids: readonly string[]): string => [...ids].sort().join(',');

/** The key of the planned steps, or null when the plan is too short to show the outfit. */
export function plannedKey(steps: readonly { itemId: string }[]): string | null {
  if (steps.length < PICTURE_LIMITS.minSteps || steps.length > TRYON_MAX_STEPS) return null;
  return pictureKey(steps.map((step) => step.itemId));
}

/** The newest idea picture (a result without an outfit) of each garment set. */
export function pictureIndex(results: readonly PictureResult[]): ReadonlyMap<string, PictureResult> {
  const found = new Map<string, PictureResult>();
  for (const result of results) {
    if (result.outfitId !== null) continue;
    const key = pictureKey(result.itemIds);
    const known = found.get(key);
    if (!known || result.completedAtMs > known.completedAtMs) found.set(key, result);
  }
  return found;
}

/**
 * The pictures Remove deletes: idea pictures of exactly this set that finished after the suggestion was created, so they were made
 * while it existed. An older picture of the same set stays. A picture the owner made by hand of the same set inside that window
 * goes too: the two cannot be told apart.
 */
export function removableResults(results: readonly PictureResult[], key: string, createdAtMs: number): string[] {
  return results.filter((result) => result.outfitId === null && result.completedAtMs >= createdAtMs && pictureKey(result.itemIds) === key)
    .map((result) => result.id);
}

export type PictureBlock = 'consent' | 'guard' | 'tryOn' | 'photo' | 'offline' | 'hidden' | 'foreground' | 'cooldown' | 'unresolved';
export type PictureInputs = {
  consentOn: boolean; consentChanging: boolean; guardPaused: boolean; tryOnReady: boolean; sessionStopped: boolean;
  photo: 'unknown' | 'none' | 'saved'; online: boolean; visible: boolean; foreground: boolean; cooldownUntilMs: number | null; nowMs: number;
};
/** Why no new chain may start now, in the order a person would fix them. `null` means the local conditions allow it. */
export function pictureBlock(input: PictureInputs): PictureBlock | null {
  if (input.consentChanging) return 'unresolved';
  if (!input.consentOn) return 'consent';
  if (input.guardPaused) return 'guard';
  if (!input.tryOnReady || input.sessionStopped) return 'tryOn';
  if (input.photo === 'none') return 'photo';
  if (input.photo === 'unknown') return 'unresolved';
  if (!input.online) return 'offline';
  if (!input.visible) return 'hidden';
  if (input.foreground) return 'foreground';
  if (input.cooldownUntilMs !== null && input.nowMs < input.cooldownUntilMs) return 'cooldown';
  return null;
}

export type PictureCandidate = { id: string; key: string | null };
export type TargetState = {
  have: ReadonlyMap<string, unknown>; attempts: ReadonlyMap<string, number>; skipped: ReadonlySet<string>; excluded: ReadonlySet<string>;
};
/** The suggestions the queue would make a picture for, in list order, fewest attempts first (a retry comes after the others). */
export function pictureTargets<T extends PictureCandidate>(list: readonly T[], state: TargetState): T[] {
  const eligible = list.filter((entry) => entry.key !== null && !state.have.has(entry.key) && !state.skipped.has(entry.id)
    && !state.excluded.has(entry.id) && (state.attempts.get(entry.id) ?? 0) < PICTURE_LIMITS.maxAttempts);
  const seen = new Set<string>();
  // Two suggestions with the same planned set share one picture.
  const unique = eligible.filter((entry) => { if (seen.has(entry.key!)) return false; seen.add(entry.key!); return true; });
  return unique.map((entry, at) => ({ entry, at })).sort((a, b) => (state.attempts.get(a.entry.id) ?? 0) - (state.attempts.get(b.entry.id) ?? 0) || a.at - b.at)
    .map((item) => item.entry);
}

export type FailureKind = 'filtered' | 'busy' | 'allowance' | 'failed' | 'lost' | 'mismatch' | 'turnedOff' | 'resultsFull' | 'unavailable' | 'paused';
export type FailureAction =
  | { kind: 'skip' }
  | { kind: 'retry' }
  | { kind: 'defer' }
  | { kind: 'stop'; reason: 'busy' | 'allowance' | 'consent' | 'full' | 'guard' | 'failed'; forMs: number | null };
/**
 * What a failed chain means for the queue. Nothing here sends again: a failure either skips the outfit, counts one attempt
 * against it (two at most), or stops the whole queue. A failure caused by the queue's own gate (`gated`) counts for nothing. claimed is true
 * only once step 1 went through: a refusal before that (unavailable, inactive, unconfigured) stops the queue for the cooldown and is not retried.
 */
export function classifyFailure(kind: FailureKind, claimed: boolean, gated: boolean): FailureAction {
  if (gated) return { kind: 'defer' };
  switch (kind) {
    case 'filtered': return { kind: 'skip' };
    case 'busy': return { kind: 'stop', reason: 'busy', forMs: PICTURE_LIMITS.busyStopMs };
    case 'allowance': return { kind: 'stop', reason: 'allowance', forMs: PICTURE_LIMITS.stopMs };
    case 'turnedOff': return { kind: 'stop', reason: 'consent', forMs: null };
    case 'resultsFull': return { kind: 'stop', reason: 'full', forMs: PICTURE_LIMITS.stopMs };
    case 'paused': return { kind: 'stop', reason: 'guard', forMs: null };
    case 'unavailable': return claimed ? { kind: 'retry' } : { kind: 'stop', reason: 'failed', forMs: PICTURE_LIMITS.stopMs };
    default: return { kind: 'retry' };
  }
}

/**
 * The server-side gate's memory. `baseline` is the gap between the stored rows and the ready pictures this page first saw (stored pictures
 * of deleted outfits are in it); `lastStatus` is the last stored-row count; `sinceMs` is when a latched wait began.
 */
export type ReservedMemory = { baseline: number | null; lastStatus: number | null; sinceMs: number | null };
export const noReserved: ReservedMemory = { baseline: null, lastStatus: null, sinceMs: null };
/**
 * `status.results` counts every stored or reserved picture, also those of deleted outfits; the list holds the ready pictures of live
 * outfits. The first gap seen is therefore ordinary and becomes the baseline. After that the queue waits only once the stored count
 * has risen while the gap is above the baseline: a chain started elsewhere (another window or device, or a page reloaded mid-chain, whose
 * paid steps cannot be resumed) holds a reserved row. The wait lasts until the gap is back at the baseline or longer than a chain can
 * live, then that gap is adopted. Any other change of the gap (an outfit trashed or restored, a picture deleted) is adopted at once.
 * Best effort, not a lock: a deleted ready picture together with another device's new row at an unchanged total looks like a trash change.
 */
export function reservedGate(memory: ReservedMemory, statusResults: number, readyPictures: number, nowMs: number): { wait: boolean; memory: ReservedMemory } {
  const gap = Math.max(0, statusResults - readyPictures);
  const adopt = { wait: false, memory: { baseline: gap, lastStatus: statusResults, sinceMs: null } };
  if (memory.baseline === null || memory.lastStatus === null) return adopt;
  if (memory.sinceMs !== null) {
    if (gap <= memory.baseline || nowMs - memory.sinceMs >= PICTURE_LIMITS.reservedWaitMs) return adopt;
    return { wait: true, memory: { ...memory, lastStatus: statusResults } };
  }
  if (gap > memory.baseline && statusResults > memory.lastStatus) return { wait: true, memory: { baseline: memory.baseline, lastStatus: statusResults, sinceMs: nowMs } };
  return adopt;
}

const STEP_SAMPLES = 10;
/** Without a measured step: the provider takes two requests a minute. */
const DEFAULT_STEP_MS = 30_000;
const meanStepMs = (samples: readonly number[]): number => {
  const recent = samples.filter((value) => Number.isFinite(value) && value > 0).slice(-STEP_SAMPLES);
  return recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : DEFAULT_STEP_MS;
};
/** The rolling window of measured step durations (send to done, a BUSY wait included), newest last. */
export const addStepSample = (samples: readonly number[], ms: number): number[] => (Number.isFinite(ms) && ms > 0 ? [...samples, ms] : [...samples]).slice(-STEP_SAMPLES);
/** Time left for `stepsLeft` more steps, or null when that is not known. Whole minutes: 0 means under one minute. */
export function estimateMinutesLeft(samples: readonly number[], stepsLeft: number | null): number | null {
  if (stepsLeft === null || !Number.isFinite(stepsLeft) || stepsLeft <= 0) return null;
  return Math.floor(meanStepMs(samples) * stepsLeft / 60_000 + 0.5);
}
/** A step that takes this long is said to take longer than usual: three times the average, and never under the server's own 90 s limit. */
export const slowStepMs = (samples: readonly number[]): number => Math.max(90_000, 3 * meanStepMs(samples));

/** Whether `steps` more reservations would leave less than the reserve share of the monthly allowance. */
export function reserveBlock(budget: { monthlyAllowanceMicro: string; remainingMicro: string } | null, maxRequestMicro: string | null, steps: number): boolean {
  if (budget === null) return false;
  const perStep = BigInt(maxRequestMicro ?? TRYON_RESERVATION_MICRO);
  const reserve = BigInt(budget.monthlyAllowanceMicro) * BigInt(PICTURE_LIMITS.reservePercent) / 100n;
  return BigInt(budget.remainingMicro) - perStep * BigInt(steps) < reserve;
}
