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
  /** One garment has at most this many candidate sets, so it needs at most this many calls. */
  callsPerGarment: 8,
  /** Successful calls in a row after which the unchecked count has not fallen: the pass stops at its safety limit. */
  stallStop: 8,
});

/** Calls one pass may make for a wardrobe with `unassessed` unchecked garments. With none unchecked, one call (the earlier manual run). */
export const passCeiling = (unassessed: number): number =>
  unassessed <= 0 ? 1 : Math.min(PASS_LIMITS.maxCalls, PASS_LIMITS.callsPerGarment * unassessed);

export type PassStop = 'done' | 'user' | 'away' | 'hidden' | 'consent' | 'unavailable' | 'offline' | 'paused' | 'limit' | 'reserve' | 'live'
  | 'busy' | 'rate' | 'full' | 'ceiling' | 'stalled' | 'failed' | 'notSent';

export type PassMemory = Readonly<{
  /** Unchecked garments when the pass began, and at the last fresh status read before a call. */
  start: number; unassessed: number;
  calls: number; found: number;
  /** Successful calls in a row after which a fresh status read showed no fewer unchecked garments. */
  stalls: number;
}>;
/** `stopped` is why the owner or the page ended the pass (Stop, leaving the screen, the page going away), or null. */
export type PassLocal = { online: boolean; visible: boolean; stopped: PassStop | null; settling: boolean; runnable: boolean };

function advance(mem: PassMemory | null, status: OutfitGenStatus): PassMemory {
  if (mem === null) return { start: status.unassessed, unassessed: status.unassessed, calls: 0, found: 0, stalls: 0 };
  if (mem.calls === 0) return { ...mem, unassessed: status.unassessed };
  return { ...mem, unassessed: status.unassessed, stalls: status.unassessed < mem.unassessed ? 0 : mem.stalls + 1 };
}

/**
 * Whether the next call may be sent, from a status read just before it. A pass that begins with every garment checked makes one
 * call (the earlier manual run over the least-covered garments) and ends. The reserve applies to calls after the first, like the
 * pictures' own best-effort gate. Consent is read again every time (fail closed). Progress is only a fresh fall of the unchecked count.
 */
export function passNext(mem: PassMemory | null, status: OutfitGenStatus | null, local: PassLocal): { stop: PassStop | null; mem: PassMemory | null } {
  if (local.stopped !== null) return { stop: local.stopped, mem };
  if (!status) return { stop: 'unavailable', mem };
  if (status.code !== 'OK' || !supportedOutfitGenPolicy(status)) return { stop: status.consent?.enabled ? 'unavailable' : 'consent', mem };
  if (status.consent?.enabled !== true || !local.runnable) return { stop: 'consent', mem };
  const next = advance(mem, status);
  const stop = ((): PassStop | null => {
    if (local.settling) return 'notSent';
    if (next.calls > 0 && status.unassessed === 0) return 'done';
    if (!local.online) return 'offline';
    if (!local.visible) return 'hidden';
    if (outfitGenLimits(status).reached) return 'limit';
    if (next.calls > 0 && reserveBlock(status.budget, status.policy?.maxRequestMicro ?? null, 1)) return 'reserve';
    if (status.live) return 'live';
    if (status.pending >= OUTFITGEN_LIMITS.pending) return 'full';
    if (next.stalls >= PASS_LIMITS.stallStop) return 'stalled';
    if (next.calls >= passCeiling(next.start)) return 'ceiling';
    return null;
  })();
  return { stop, mem: next };
}

/** The call about to be sent counts at once; a call that was never sent (NOT_SENT) takes it back. */
export const passSending = (mem: PassMemory): PassMemory => ({ ...mem, calls: mem.calls + 1 });

/**
 * What a call's reply means for the pass. An OK reply with garments left goes on; every other reply ends the pass, and
 * a failure or a lost reply is never followed by another call (the outcome on the server is unknown until it is read again).
 */
export function passReply(mem: PassMemory, reply: GenerateReply): { stop: PassStop | null; mem: PassMemory } {
  const ended = (stop: PassStop, patch: Partial<PassMemory> = {}) => ({ stop, mem: { ...mem, ...patch } });
  switch (reply.code) {
    case 'OK': return { stop: reply.remaining ? null : 'done', mem: { ...mem, found: mem.found + reply.suggested } };
    case 'NOT_SENT': return ended('notSent', { calls: Math.max(0, mem.calls - 1) });
    case 'PENDING_FULL': return ended('full');
    case 'BUSY': return ended('busy');
    case 'RATE_LIMIT': case 'COOLDOWN': return ended('rate');
    case 'ALLOWANCE': return ended('limit');
    case 'PAUSED': return ended('paused');
    case 'CONSENT_REQUIRED': return ended('consent');
    case 'INACTIVE': case 'UNCONFIGURED': case 'CONFIG_CHANGED': case 'UNAVAILABLE': case 'UNAUTHENTICATED': return ended('unavailable');
    default: return ended('failed');
  }
}

export type PassLine = { key: MessageKey; count?: number };
const reasons: Partial<Record<PassStop, MessageKey>> = {
  user: 'outfitgen.passContinue', away: 'outfitgen.passContinue', offline: 'outfitgen.passContinue', hidden: 'outfitgen.passContinue',
  ceiling: 'outfitgen.passSafety', stalled: 'outfitgen.passSafety', consent: 'outfitgen.off', unavailable: 'outfitgen.failed',
  failed: 'outfitgen.failed', paused: 'aiGuard.paused', limit: 'outfitgenC.limit', reserve: 'outfitgen.passReserve', live: 'outfitgen.busy',
  busy: 'outfitgen.busy', rate: 'outfitgen.rateLimit', full: 'outfitgen.full',
};

/**
 * The result lines of a finished pass. `left` is the unchecked count of a fresh status read made after the last call, or null when
 * that read failed. "All eligible garments checked" is said only when that read shows zero. When every garment was already
 * checked at the start, the one call it made reads like the earlier manual run.
 */
export function passLines(stop: PassStop, mem: PassMemory | null, left: number | null): PassLine[] {
  const lines: PassLine[] = [];
  const sent = mem !== null && mem.calls > 0 ? mem : null;
  const found = mem?.found ?? 0;
  const tally = (): PassLine => found > 0 ? { key: 'outfitgen.found_other', count: found } : { key: 'outfitgen.nothingNew' };
  if (sent && stop === 'done') {
    if (left === 0) {
      if (sent.start > 0) lines.push({ key: 'outfitgen.passAll' });
      lines.push(tally());
    } else if (left === null) {
      if (found > 0) lines.push(tally());
      lines.push({ key: 'outfitgen.passUnconfirmed' });
    } else {
      lines.push({ key: 'outfitgen.passStopped_other', count: left });
      if (found > 0) lines.push(tally());
      lines.push({ key: 'outfitgen.passContinue' });
    }
    return lines;
  }
  const remaining = left ?? sent?.unassessed ?? 0;
  if (sent && sent.start > 0 && remaining > 0) lines.push({ key: 'outfitgen.passStopped_other', count: remaining });
  if (found > 0) lines.push(tally());
  const reason = reasons[stop];
  if (reason) lines.push({ key: reason });
  return lines;
}
