// OUTFITGEN1b: the app side of AI-judged outfit suggestions as pure functions: the closed replies of the status, list and
// decision RPCs and of the outfit-generate route, the view each state shows, and the rule that decides whether an
// automatic run may start. The contract and limits come from `outfitgen.ts`, which the Edge function shares.
import {
  OUTFITGEN_LIMITS, OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_NOTICE_REVISION, OUTFITGEN_OCCASIONS,
  OUTFITGEN_RESERVATION_MICRO, type OutfitGenOccasion,
} from './outfitgen';
import { budgetExhausted, parseOptionalAiBudget, type AiBudget } from './ai-budget';

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: unknown, keys: readonly string[]): value is JsonObject => record(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const micro = (value: unknown): value is string => typeof value === 'string' && MICRO.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

export const AUTO_COOLDOWN_MS = 15 * 60_000;
/** Automatic calls one owner scope may make (one catch-up chain); the server's own limit is the same number per 6 hours. */
export const AUTO_SCOPE_CALLS = 3;
export const GENERATE_TIMEOUT_MS = 90_000;

export const outfitGenStatusCodes = ['OK', 'UNAVAILABLE', 'UNCONFIGURED', 'INACTIVE', 'CONSENT_REQUIRED'] as const;
export type OutfitGenStatusCode = (typeof outfitGenStatusCodes)[number];
export type OutfitGenPolicy = { activated: boolean; noticeRevision: number | null; manifestId: string; modelId: string | null; maxRequestMicro: string };
export type OutfitGenStatus = {
  code: OutfitGenStatusCode; serverTimeMs: number | null;
  consent: { enabled: boolean; noticeRevision: number | null } | null;
  policy: OutfitGenPolicy | null; budget: AiBudget | null;
  pending: number; unassessed: number; autoUnassessed: number; autoCallsLeft: number; live: boolean; cooldownUntilMs: number | null;
};
const emptyCounts = { pending: 0, unassessed: 0, autoUnassessed: 0, autoCallsLeft: 0, live: false, cooldownUntilMs: null } as const;

/** Parses the closed `outfitgen_status` reply; null for anything else. UNAVAILABLE carries only its code. */
export function parseOutfitGenStatus(value: unknown): OutfitGenStatus | null {
  if (hasKeys(value, ['code'])) {
    return value.code === 'UNAVAILABLE' ? { code: 'UNAVAILABLE', serverTimeMs: null, consent: null, policy: null, budget: null, ...emptyCounts } : null;
  }
  if (!hasKeys(value, ['code', 'period', 'serverTimeMs', 'consent', 'policy', 'budget', 'pending', 'unassessed', 'autoUnassessed',
    'autoCallsLeft', 'live', 'cooldownUntilMs'])) return null;
  const code = outfitGenStatusCodes.find((entry) => entry === value.code);
  if (!code || code === 'UNAVAILABLE' || typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)
    || !count(value.serverTimeMs, 2 ** 53 - 1)) return null;
  const c = value.consent, p = value.policy;
  if (!hasKeys(c, ['enabled', 'noticeRevision', 'consentedAt']) || typeof c.enabled !== 'boolean'
    || !(c.noticeRevision === null || revision(c.noticeRevision)) || c.enabled !== (c.noticeRevision !== null)
    || !(c.consentedAt === null || typeof c.consentedAt === 'string') || (c.consentedAt === null) !== (c.noticeRevision === null)) return null;
  const budget = parseOptionalAiBudget(value.budget);
  if (!budget.ok) return null;
  // A count above the server's cap of 100 is read as it is, never refused: an over-cap number must not hide Settings or Turn off.
  if (!count(value.pending, 1_000_000) || !count(value.unassessed, 1_000_000) || !count(value.autoUnassessed, 1_000_000)
    || !count(value.autoCallsLeft, 3) || typeof value.live !== 'boolean'
    || !(value.cooldownUntilMs === null || count(value.cooldownUntilMs, 2 ** 53 - 1))) return null;
  let policy: OutfitGenPolicy | null = null;
  if (p !== null) {
    if (!hasKeys(p, ['activated', 'noticeRevision', 'manifestId', 'modelId', 'maxRequestMicro']) || typeof p.activated !== 'boolean'
      || !(p.noticeRevision === null || revision(p.noticeRevision)) || typeof p.manifestId !== 'string'
      || !(p.modelId === null || typeof p.modelId === 'string') || !micro(p.maxRequestMicro)) return null;
    policy = { activated: p.activated, noticeRevision: p.noticeRevision, manifestId: p.manifestId, modelId: p.modelId, maxRequestMicro: p.maxRequestMicro };
  }
  if ((code === 'OK' || code === 'INACTIVE' || code === 'CONSENT_REQUIRED') !== (policy !== null)) return null;
  if (budget.budget === null && code !== 'UNCONFIGURED') return null;
  return { code, serverTimeMs: value.serverTimeMs, consent: { enabled: c.enabled, noticeRevision: c.noticeRevision }, policy,
    budget: budget.budget, pending: value.pending, unassessed: value.unassessed, autoUnassessed: value.autoUnassessed,
    autoCallsLeft: value.autoCallsLeft, live: value.live, cooldownUntilMs: value.cooldownUntilMs };
}

/** The policy this app version has a notice for: the reviewed manifest, model and notice revision. */
export function supportedOutfitGenPolicy(status: OutfitGenStatus): boolean {
  const p = status.policy;
  return p !== null && p.noticeRevision === OUTFITGEN_NOTICE_REVISION && p.manifestId === OUTFITGEN_MANIFEST && p.modelId === OUTFITGEN_MODEL;
}

export type OutfitGenRead = { kind: 'unknown' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; status: OutfitGenStatus };
export type OutfitGenViewKind = 'hidden' | 'loadFailed' | 'unresolved' | 'unavailable' | 'paused' | 'off' | 'renew' | 'on';
export type OutfitGenView = { kind: OutfitGenViewKind; card: boolean; section: boolean; turnOn: boolean; turnOff: boolean; run: boolean };

/**
 * What each state shows. Nothing shows while the backend has no outfit generation, or is not set up for an account that
 * never consented (the app stays inert). Turn off stays available whenever consent is on.
 */
export function outfitGenView(read: OutfitGenRead, known: boolean, unresolved: boolean): OutfitGenView {
  const view = (kind: OutfitGenViewKind, extra: Partial<OutfitGenView> = {}): OutfitGenView =>
    ({ kind, card: true, section: false, turnOn: false, turnOff: false, run: false, ...extra });
  const hidden = () => view('hidden', { card: false });
  if (unresolved) return view('unresolved', { section: known });
  if (read.kind === 'unknown' || read.kind === 'missing') return hidden();
  if (read.kind === 'failed') return known ? view('loadFailed', { section: true }) : hidden();
  const { status } = read;
  const consented = status.consent?.enabled === true;
  if (status.code === 'UNAVAILABLE') return known ? view('unavailable') : hidden();
  if (status.code === 'UNCONFIGURED') return consented ? view('unavailable', { turnOff: true }) : hidden();
  if (!supportedOutfitGenPolicy(status)) return view('unavailable', { turnOff: consented });
  if (status.code === 'INACTIVE') return view('paused', { turnOff: consented });
  if (status.code === 'CONSENT_REQUIRED') {
    return consented ? view('renew', { section: true, turnOn: true, turnOff: true }) : view('off', { section: true, turnOn: true });
  }
  return view('on', { section: true, turnOff: true, run: true });
}
export const shownOutfitGenView = (view: OutfitGenView) => view.kind !== 'hidden' && view.kind !== 'loadFailed' && view.kind !== 'unresolved';

export type OutfitGenLimits = { reached: boolean; warning: boolean };
/** The one monthly AI budget as the claim checks it: a run is refused when its reservation would pass the budget. */
export function outfitGenLimits(status: OutfitGenStatus): OutfitGenLimits {
  const b = status.budget;
  if (!b) return { reached: false, warning: false };
  const reached = budgetExhausted(b, status.policy?.maxRequestMicro ?? OUTFITGEN_RESERVATION_MICRO);
  return { reached, warning: !reached && b.warning };
}

/** createdAtMs is the server's clock, the same one that stamps a try-on result's completion. */
export type Suggestion = Readonly<{ id: string; itemIds: readonly string[]; title: string; reason: string; occasion: OutfitGenOccasion; score: number; createdAtMs: number }>;
export type SuggestionList = { kind: 'ok'; suggestions: Suggestion[] } | { kind: 'unavailable' };

/** Parses the closed `outfitgen_list` reply. Text is shown as plain text only. */
export function parseSuggestionList(value: unknown): SuggestionList | null {
  if (hasKeys(value, ['code'])) return value.code === 'UNAVAILABLE' ? { kind: 'unavailable' } : null;
  if (!hasKeys(value, ['code', 'suggestions']) || value.code !== 'OK' || !Array.isArray(value.suggestions)
    || value.suggestions.length > 1000) return null;
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  for (const entry of value.suggestions) {
    if (!hasKeys(entry, ['id', 'itemIds', 'title', 'reason', 'occasion', 'score', 'createdAt'])) return null;
    const { id, itemIds, title, reason, occasion, score } = entry;
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id) || !Array.isArray(itemIds) || itemIds.length < 2 || itemIds.length > 6
      || !itemIds.every((item) => typeof item === 'string' && UUID.test(item)) || new Set(itemIds).size !== itemIds.length
      || typeof title !== 'string' || title.length < 1 || title.length > 40 || typeof reason !== 'string' || reason.length < 1 || reason.length > 160
      || typeof occasion !== 'string' || !OUTFITGEN_OCCASIONS.includes(occasion as OutfitGenOccasion)
      || typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10 || typeof entry.createdAt !== 'string'
      || !Number.isFinite(Date.parse(entry.createdAt))) return null;
    seen.add(id);
    suggestions.push({ id, itemIds: itemIds as string[], title, reason, occasion: occasion as OutfitGenOccasion, score, createdAtMs: Date.parse(entry.createdAt) });
  }
  return { kind: 'ok', suggestions };
}

export type DecisionCode = 'OK' | 'UNAVAILABLE' | 'NOT_FOUND' | 'CONFLICT' | 'STALE' | 'IN_TRASH' | 'BUSY' | 'INVALID_INPUT' | 'PENDING_FULL';
export type KeepReply = { code: DecisionCode; outfitId: string | null };
const decisionCodes: readonly DecisionCode[] = ['OK', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT', 'STALE', 'IN_TRASH', 'BUSY', 'INVALID_INPUT', 'PENDING_FULL'];
/** Keep, Remove and Undo answer a small closed object; anything else is unknown, and null here means treat as failed. */
export function parseDecision(value: unknown, kind: 'keep' | 'remove' | 'undo'): KeepReply | null {
  if (!record(value) || typeof value.code !== 'string') return null;
  const code = decisionCodes.find((entry) => entry === value.code);
  if (!code) return null;
  const allowed = kind === 'keep' ? ['code', 'outfitId', 'replayed', 'duplicate'] : ['code', 'replayed'];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return null;
  if (kind === 'keep' && code === 'OK') return typeof value.outfitId === 'string' && UUID.test(value.outfitId) ? { code, outfitId: value.outfitId } : null;
  if (Object.keys(value).length !== 1 && !(code === 'OK' && Object.keys(value).length === 2)) return null;
  return { code, outfitId: null };
}

export const generateCodes = ['UNAUTHENTICATED', 'UNAVAILABLE', 'CONSENT_REQUIRED', 'INACTIVE', 'UNCONFIGURED', 'CONFIG_CHANGED', 'BUSY',
  'COOLDOWN', 'PENDING_FULL', 'ALLOWANCE', 'RATE_LIMIT', 'TERMINAL', 'CONFLICT', 'FILTERED', 'FAILED', 'TIMEOUT', 'INVALID_INPUT',
  'TOO_LARGE', 'UNSUPPORTED_MEDIA', 'PAUSED'] as const;
export type GenerateCode = (typeof generateCodes)[number];
/** NOT_SENT: the last check before the request found it no longer allowed, so nothing was sent. */
export type GenerateReply = { code: 'OK'; suggested: number; judged: number; remaining: boolean } | { code: GenerateCode | 'NOT_SENT' };
/** The outfit-generate reply: the OK counts, or one closed code. Anything unreadable is FAILED. */
export function parseGenerateReply(status: number, value: unknown): GenerateReply {
  if (status === 200 && hasKeys(value, ['code', 'suggested', 'judged', 'remaining']) && value.code === 'OK'
    && count(value.suggested, OUTFITGEN_LIMITS.pending) && count(value.judged, 1000) && typeof value.remaining === 'boolean') {
    return { code: 'OK', suggested: value.suggested, judged: value.judged, remaining: value.remaining };
  }
  if (status !== 200 && hasKeys(value, ['code'])) {
    const code = generateCodes.find((entry) => entry === value.code);
    if (code) return { code };
  }
  return { code: 'FAILED' };
}

/** Why an automatic run may not start now, or null when it may. The status must be one read just before the decision. */
export type AutoBlock = 'unavailable' | 'consent' | 'offline' | 'hidden' | 'running' | 'limit' | 'live' | 'full' | 'nothing-new' | 'calls' | 'cooldown';
export type AutoLocal = { online: boolean; visible: boolean; running: boolean; autoCalls: number; failedAtMs: number | null; nowMs: number };
export function autoBlock(status: OutfitGenStatus | null, local: AutoLocal): AutoBlock | null {
  if (!status || status.code !== 'OK' || !supportedOutfitGenPolicy(status)) return status?.consent?.enabled ? 'unavailable' : 'consent';
  if (status.consent?.enabled !== true) return 'consent';
  if (!local.online) return 'offline';
  if (!local.visible) return 'hidden';
  if (local.running) return 'running';
  if (outfitGenLimits(status).reached) return 'limit';
  if (status.live) return 'live';
  if (status.pending >= OUTFITGEN_LIMITS.pending) return 'full';
  if (status.autoUnassessed === 0) return 'nothing-new';
  if (local.autoCalls >= AUTO_SCOPE_CALLS || status.autoCallsLeft === 0) return 'calls';
  const serverCooldown = status.cooldownUntilMs !== null && status.serverTimeMs !== null && status.cooldownUntilMs > status.serverTimeMs;
  if (serverCooldown || (local.failedAtMs !== null && local.nowMs - local.failedAtMs < AUTO_COOLDOWN_MS)) return 'cooldown';
  return null;
}
