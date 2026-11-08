// OUTFITGEN3: the rules of one "Find new outfits" press that works through the garments not yet checked, one call at a time.
// Pure: no clock, network or storage. The store feeds these functions what it read and does what they decide. Every bound
// comes from the wardrobe and the closed server codes, never from the content of a reply, so a pass always ends.
import type { MessageKey } from '../i18n';
import { OUTFITGEN_LIMITS } from './outfitgen';
import { outfitGenLimits, supportedOutfitGenPolicy, type GenerateReply, type OutfitGenStatus } from './outfitgen-app';
import { reserveBlock } from './outfitgen-pictures';

export const PASS_LIMITS = Object.freeze({
  /** The server's own daily cap of outfit calls: no pass can usefully make more. */
  maxCalls: 40,
  /** Consecutive failed calls that end a pass. */
  failureStop: 2,
  /** Consecutive calls that neither judged a set nor assessed a garment. */
  stallStop: 2,
});

/** Calls one pass may make for a wardrobe with `unassessed` unchecked garments. About 1.8 calls per garment were measured on synthetic wardrobes. */
export const passCeiling = (unassessed: number): number => Math.min(PASS_LIMITS.maxCalls, 2 * Math.max(0, unassessed) + 2);

export type PassStop = 'done' | 'user' | 'consent' | 'unavailable' | 'offline' | 'hidden' | 'paused' | 'limit' | 'reserve' | 'live' | 'busy'
  | 'rate' | 'full' | 'ceiling' | 'stalled' | 'failed' | 'notSent';

export type PassMemory = Readonly<{
  /** Unchecked garments when the pass began, and how many have been checked since (never decreases). */
  start: number; done: number;
  /** Unchecked garments at the last status read, and sets judged by the last call. */
  unassessed: number; judged: number;
  calls: number; found: number; failures: number; stalls: number;
}>;
export type PassLocal = { online: boolean; visible: boolean; stopped: boolean; settling: boolean; runnable: boolean };

export const passTotal = (mem: PassMemory): number => mem.done + mem.unassessed;

function advance(mem: PassMemory | null, status: OutfitGenStatus): PassMemory {
  if (mem === null) {
    return { start: status.unassessed, done: 0, unassessed: status.unassessed, judged: 0, calls: 0, found: 0, failures: 0, stalls: 0 };
  }
  if (mem.calls === 0) return { ...mem, unassessed: status.unassessed };
  const progressed = status.unassessed < mem.unassessed || mem.judged > 0;
  return { ...mem, unassessed: status.unassessed, judged: 0, done: Math.max(mem.done, mem.start - status.unassessed),
    stalls: progressed ? 0 : mem.stalls + 1 };
}

/**
 * Whether the next call may be sent, from a status read just before it. The first call of a press is allowed even when
 * every garment is checked (it is the earlier manual run: the least-covered garments again); later calls need garments left.
 * The reserve applies to calls after the first, like the pictures' own gate. Consent is read again every time (fail closed).
 */
export function passNext(mem: PassMemory | null, status: OutfitGenStatus | null, local: PassLocal): { stop: PassStop | null; mem: PassMemory | null } {
  if (local.stopped) return { stop: 'user', mem };
  if (!status) return { stop: 'unavailable', mem };
  if (status.code !== 'OK' || !supportedOutfitGenPolicy(status)) return { stop: status.consent?.enabled ? 'unavailable' : 'consent', mem };
  if (status.consent?.enabled !== true || !local.runnable) return { stop: 'consent', mem };
  const next = advance(mem, status);
  const stop = ((): PassStop | null => {
    if (local.settling) return 'notSent';
    if (next.calls > 0 && status.unassessed === 0 && (next.start > 0 || next.failures === 0)) return 'done';
    if (!local.online) return 'offline';
    if (!local.visible) return 'hidden';
    if (outfitGenLimits(status).reached) return 'limit';
    if (next.calls > 0 && reserveBlock(status.budget, status.policy?.maxRequestMicro ?? null, 1)) return 'reserve';
    if (status.live) return 'live';
    if (status.pending >= OUTFITGEN_LIMITS.pending) return 'full';
    if (next.stalls >= PASS_LIMITS.stallStop) return 'stalled';
    if (next.calls >= passCeiling(passTotal(next))) return 'ceiling';
    return null;
  })();
  return { stop, mem: next };
}

/** The call about to be sent counts at once; a call that was never sent (NOT_SENT) takes it back. */
export const passSending = (mem: PassMemory): PassMemory => ({ ...mem, calls: mem.calls + 1 });

/** What a call's reply means for the pass. An OK reply with garments left goes on; every other code ends the pass or is a failure. */
export function passReply(mem: PassMemory, reply: GenerateReply): { stop: PassStop | null; mem: PassMemory } {
  const ended = (stop: PassStop, patch: Partial<PassMemory> = {}) => ({ stop, mem: { ...mem, ...patch } });
  switch (reply.code) {
    case 'OK': {
      const next = { ...mem, found: mem.found + reply.suggested, judged: reply.judged, failures: 0 };
      return { stop: reply.remaining ? null : 'done', mem: next };
    }
    case 'NOT_SENT': return ended('notSent', { calls: Math.max(0, mem.calls - 1) });
    case 'PENDING_FULL': return ended('full');
    case 'BUSY': return ended('busy');
    case 'RATE_LIMIT': case 'COOLDOWN': return ended('rate');
    case 'ALLOWANCE': return ended('limit');
    case 'PAUSED': return ended('paused');
    case 'CONSENT_REQUIRED': return ended('consent');
    case 'INACTIVE': case 'UNCONFIGURED': case 'CONFIG_CHANGED': case 'UNAVAILABLE': case 'UNAUTHENTICATED': return ended('unavailable');
    default: {
      const failures = mem.failures + 1;
      return { stop: failures >= PASS_LIMITS.failureStop ? 'failed' : null, mem: { ...mem, failures, judged: 0 } };
    }
  }
}

export type PassLine = { key: MessageKey; count?: number; done?: number };
const reasons: Partial<Record<PassStop, MessageKey>> = {
  user: 'outfitgen.passContinue', offline: 'outfitgen.passContinue', hidden: 'outfitgen.passContinue', stalled: 'outfitgen.passContinue',
  ceiling: 'outfitgen.passContinue', consent: 'outfitgen.off', unavailable: 'outfitgen.failed', failed: 'outfitgen.failed',
  paused: 'aiGuard.paused', limit: 'outfitgenC.limit', reserve: 'outfitgen.passReserve', live: 'outfitgen.busy', busy: 'outfitgen.busy',
  rate: 'outfitgen.rateLimit', full: 'outfitgen.full',
};

/**
 * The result lines of a finished pass: how far it got, what it found, and one reason when it did not reach the end. When every
 * garment was already checked, the one call it made reads like the earlier manual run.
 */
export function passLines(stop: PassStop, mem: PassMemory | null): PassLine[] {
  const lines: PassLine[] = [];
  const sent = mem !== null && mem.calls > 0 ? mem : null;
  const found = mem?.found ?? 0;
  const tally = (): PassLine => found > 0 ? { key: 'outfitgen.found_other', count: found } : { key: 'outfitgen.nothingNew' };
  if (sent && stop === 'done') {
    if (sent.start > 0) lines.push({ key: 'outfitgen.passAll' });
    lines.push(tally());
    return lines;
  }
  if (sent && sent.start > 0) lines.push({ key: 'outfitgen.passSummary_other', count: passTotal(sent), done: sent.done });
  if (found > 0) lines.push(tally());
  const reason = reasons[stop];
  if (reason) lines.push({ key: reason });
  return lines;
}
