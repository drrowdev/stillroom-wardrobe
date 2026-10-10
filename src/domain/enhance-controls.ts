// BG2b-2: the owner's photo-enhancement status as the client sees it. Pure parsing and typing only: nothing here
// authorises a request, and the server's enhance_status/enhance_claim checks stay authoritative.
import { CLEANUP_MANIFEST, CLEANUP_NOTICE_REVISION, ENHANCE_MODEL, ENHANCE_REVIEW_EXPIRES } from './enhancement';
import { parseOptionalAiBudget, type AiBudget } from './ai-budget';

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is JsonObject => record(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const micro = (value: unknown): value is string => typeof value === 'string' && MICRO.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const enhanceStatusCodes = ['OK', 'UNAVAILABLE', 'UNCONFIGURED', 'INACTIVE', 'CONSENT_REQUIRED'] as const;
export type EnhanceStatusCode = (typeof enhanceStatusCodes)[number];
export type EnhancePolicy = {
  activated: boolean; noticeRevision: number | null; manifestId: string; modelId: string | null; maxRequestMicro: string;
  providerAvailable: boolean;
};
export type EnhanceStatus = {
  code: EnhanceStatusCode; serverTimeMs: number | null;
  consent: { enabled: boolean; noticeRevision: number | null } | null;
  policy: EnhancePolicy | null;
  budget: AiBudget | null;
};

/** Parses the closed `enhance_status` reply; null for anything else. UNAVAILABLE carries only its code. */
export function parseEnhanceStatus(value: unknown): EnhanceStatus | null {
  if (exactKeys(value, ['code'])) {
    return value.code === 'UNAVAILABLE' ? { code: 'UNAVAILABLE', serverTimeMs: null, consent: null, policy: null, budget: null } : null;
  }
  if (!exactKeys(value, ['code', 'period', 'serverTimeMs', 'consent', 'policy', 'budget'])) return null;
  const code = enhanceStatusCodes.find((entry) => entry === value.code);
  if (!code || code === 'UNAVAILABLE' || typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)
    || !count(value.serverTimeMs)) return null;
  const c = value.consent, p = value.policy;
  const budget = parseOptionalAiBudget(value.budget);
  if (!exactKeys(c, ['enabled', 'noticeRevision', 'consentedAt']) || typeof c.enabled !== 'boolean'
    || !(c.noticeRevision === null || revision(c.noticeRevision)) || c.enabled !== (c.noticeRevision !== null)
    || !(c.consentedAt === null || typeof c.consentedAt === 'string') || (c.consentedAt === null) !== (c.noticeRevision === null)) return null;
  if (!budget.ok) return null;
  let policy: EnhancePolicy | null = null;
  if (p !== null) {
    if (!exactKeys(p, ['activated', 'noticeRevision', 'manifestId', 'modelId', 'maxRequestMicro', 'providerAvailable'])
      || typeof p.activated !== 'boolean'
      || !(p.noticeRevision === null || revision(p.noticeRevision)) || typeof p.manifestId !== 'string'
      || !(p.modelId === null || typeof p.modelId === 'string') || !micro(p.maxRequestMicro)
      || typeof p.providerAvailable !== 'boolean') return null;
    policy = { activated: p.activated, noticeRevision: p.noticeRevision, manifestId: p.manifestId, modelId: p.modelId,
      maxRequestMicro: p.maxRequestMicro, providerAvailable: p.providerAvailable };
  }
  if ((code === 'OK' || code === 'INACTIVE' || code === 'CONSENT_REQUIRED') && policy === null) return null;
  if (budget.budget === null && code !== 'UNCONFIGURED') return null;
  return { code, serverTimeMs: value.serverTimeMs, consent: { enabled: c.enabled, noticeRevision: c.noticeRevision }, policy,
    budget: budget.budget };
}

/**
 * The policy this app version has a notice for: the photo clean-up manifest (BG2c), its model and notice revision 2, before
 * review expiry. A policy still on enhance-v1 is unsupported, so nothing is offered or sent under it.
 */
export function supportedEnhancePolicy(status: EnhanceStatus): boolean {
  const p = status.policy;
  return p !== null && p.noticeRevision === CLEANUP_NOTICE_REVISION && p.manifestId === CLEANUP_MANIFEST && p.modelId === ENHANCE_MODEL
    && status.serverTimeMs !== null && status.serverTimeMs < ENHANCE_REVIEW_EXPIRES;
}
const consented = (status: EnhanceStatus) => status.consent?.enabled === true && status.policy !== null
  && status.consent.noticeRevision === status.policy.noticeRevision;

/**
 * M1 typed availability. `off`: never enabled, not consented or not activated, shown as BG2a with no line. `ready`: a
 * request may be tried. `paused`: enhancement is on for this owner but can't be used now. `unknown`: the read failed.
 */
export type EnhanceAvailability = 'off' | 'ready' | 'paused' | 'unknown';
export type EnhanceObserved = Exclude<EnhanceAvailability, 'unknown'>;

/**
 * Types one verified read. A bare UNAVAILABLE or UNCONFIGURED carries no policy, so it counts as `paused` only when the
 * latest earlier observation in this scope showed the feature switched on for this owner.
 */
export function observeEnhanceStatus(status: EnhanceStatus, knownEnabled: boolean): EnhanceObserved {
  if (status.code === 'OK' && status.policy?.activated === true && consented(status)) {
    return status.policy.providerAvailable && supportedEnhancePolicy(status) ? 'ready' : 'paused';
  }
  if ((status.code === 'UNAVAILABLE' || status.code === 'UNCONFIGURED') && (knownEnabled
    || status.policy?.activated === true && consented(status))) return 'paused';
  return 'off';
}

/**
 * A5: the in-memory record of the latest authoritative observation, per owner scope. The 10-minute rule only
 * suppresses the fallback line after a failed read; it never authorises a request.
 */
export const OFF_MEMORY_MS = 600_000;
export type EnhanceMemory = Readonly<{ last: EnhanceObserved | null; at: number | null }>;
export const emptyEnhanceMemory: EnhanceMemory = Object.freeze({ last: null, at: null });
export const rememberEnhance = (observed: EnhanceObserved, now: number): EnhanceMemory => Object.freeze({ last: observed, at: now });
/** A consent change attempt, an uncertain write, logout or an epoch change: a verified `off` no longer holds. */
export const forgetEnhanceOff = (memory: EnhanceMemory): EnhanceMemory => memory.last === 'off' ? emptyEnhanceMemory : memory;
export const knownEnabled = (memory: EnhanceMemory): boolean => memory.last === 'ready' || memory.last === 'paused';
/** A failed read is `unknown`; the line is silent only when a verified `off` is the latest observation and under 10 minutes old. */
export function silentUnknown(memory: EnhanceMemory, now: number): boolean {
  return memory.last === 'off' && memory.at !== null && now - memory.at >= 0 && now - memory.at < OFF_MEMORY_MS;
}

/**
 * What a new photo gets when it isn't sent: nothing, the generic line, the allowance line, or (BG2c) the line asking for a
 * crop to one garment when clean-up was ready but the crop held separate items of comparable size.
 */
export type EnhanceLine = 'none' | 'generic' | 'allowance' | 'ambiguous';
export function lineWhenNotSent(availability: EnhanceAvailability, memory: EnhanceMemory, now: number): EnhanceLine {
  if (availability === 'off') return 'none';
  if (availability === 'unknown') return silentUnknown(memory, now) ? 'none' : 'generic';
  return 'generic';
}

/** The Settings card for enhancement: separate use, enable and withdraw (M1). */
export type EnhanceRead = { kind: 'unknown' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; status: EnhanceStatus };
export type EnhanceViewKind = 'hidden' | 'loadFailed' | 'unresolved' | 'off' | 'renew' | 'on' | 'paused';
export type EnhanceView = { kind: EnhanceViewKind; turnOn: boolean; turnOff: boolean };
export function enhanceView(read: EnhanceRead, unresolved: boolean, shownBefore: boolean, consentKnownOn: boolean): EnhanceView {
  if (unresolved) return { kind: 'unresolved', turnOn: false, turnOff: consentKnownOn };
  if (read.kind === 'unknown' || read.kind === 'missing') return { kind: 'hidden', turnOn: false, turnOff: false };
  if (read.kind === 'failed') return shownBefore ? { kind: 'loadFailed', turnOn: false, turnOff: consentKnownOn }
    : { kind: 'hidden', turnOn: false, turnOff: false };
  const status = read.status;
  const on = status.consent?.enabled === true;
  if (!status.policy || status.code === 'UNAVAILABLE') {
    return on ? { kind: 'paused', turnOn: false, turnOff: true } : { kind: 'hidden', turnOn: false, turnOff: false };
  }
  const supported = supportedEnhancePolicy(status);
  // Not activated: nothing to turn on, but consent given earlier can always be withdrawn.
  if (!status.policy.activated) return on ? { kind: 'paused', turnOn: false, turnOff: true } : { kind: 'hidden', turnOn: false, turnOff: false };
  if (on && consented(status)) {
    return { kind: status.policy.providerAvailable && supported && status.code === 'OK' ? 'on' : 'paused', turnOn: false, turnOff: true };
  }
  if (!supported) return on ? { kind: 'paused', turnOn: false, turnOff: true } : { kind: 'hidden', turnOn: false, turnOff: false };
  return { kind: on ? 'renew' : 'off', turnOn: true, turnOff: on };
}
