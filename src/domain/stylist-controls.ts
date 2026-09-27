// ST1b stylist chat UI: pure status, limit, history and reply handling for the client. The request contract, limits and
// eligibility come from `stylist.ts`, which the Edge function shares; nothing here changes what the server accepts.
import {
  STYLIST_LIMITS, STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_NOTICE_REVISION, STYLIST_OCCASIONS, STYLIST_REVIEW_EXPIRES,
  conversationBytes, parseStylistBody, plainText, stylistEligible, utf8Bytes,
  type StylistInput, type StylistOccasion, type StylistSeason, type StylistTurn, type StylistWeather,
} from './stylist';
import type { WardrobeItem } from './wardrobe';
import type { MessageKey } from '../i18n';

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is JsonObject => record(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const micro = (value: unknown): value is string => typeof value === 'string' && MICRO.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const codePoints = (value: string) => [...value].length;

export const stylistStatusCodes = ['OK', 'UNAVAILABLE', 'UNCONFIGURED', 'INACTIVE', 'CONSENT_REQUIRED'] as const;
export type StylistStatusCode = (typeof stylistStatusCodes)[number];
export type StylistPolicy = {
  activated: boolean; noticeRevision: number | null; manifestId: string; modelId: string | null;
  maxRequestMicro: string; stylistAllowanceMicro: string; totalAllowanceMicro: string; maxRequestsPerHour: number;
};
export type StylistStatus = {
  code: StylistStatusCode; serverTimeMs: number | null;
  consent: { enabled: boolean; noticeRevision: number | null } | null;
  policy: StylistPolicy | null;
  usage: { stylistMicro: string; totalMicro: string; stylistLastHour: number } | null;
};

/** Parses the closed `stylist_status` reply; null for anything else. UNAVAILABLE carries only its code. */
export function parseStylistStatus(value: unknown): StylistStatus | null {
  if (exactKeys(value, ['code'])) {
    return value.code === 'UNAVAILABLE' ? { code: 'UNAVAILABLE', serverTimeMs: null, consent: null, policy: null, usage: null } : null;
  }
  if (!exactKeys(value, ['code', 'period', 'serverTimeMs', 'consent', 'policy', 'usage'])) return null;
  const code = stylistStatusCodes.find((entry) => entry === value.code);
  if (!code || code === 'UNAVAILABLE' || typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)
    || typeof value.serverTimeMs !== 'number' || !Number.isSafeInteger(value.serverTimeMs) || value.serverTimeMs < 0) return null;
  const c = value.consent, p = value.policy, u = value.usage;
  if (!exactKeys(c, ['enabled', 'noticeRevision', 'consentedAt']) || typeof c.enabled !== 'boolean'
    || !(c.noticeRevision === null || revision(c.noticeRevision)) || c.enabled !== (c.noticeRevision !== null)
    || !(c.consentedAt === null || typeof c.consentedAt === 'string') || (c.consentedAt === null) !== (c.noticeRevision === null)) return null;
  if (!exactKeys(u, ['stylistMicro', 'totalMicro', 'stylistLastHour', 'warning']) || !micro(u.stylistMicro) || !micro(u.totalMicro)
    || typeof u.stylistLastHour !== 'number' || !Number.isSafeInteger(u.stylistLastHour) || u.stylistLastHour < 0
    || typeof u.warning !== 'boolean') return null;
  let policy: StylistPolicy | null = null;
  if (p !== null) {
    if (!exactKeys(p, ['activated', 'noticeRevision', 'manifestId', 'modelId', 'maxRequestMicro', 'stylistAllowanceMicro',
      'totalAllowanceMicro', 'maxRequestsPerHour']) || typeof p.activated !== 'boolean'
      || !(p.noticeRevision === null || revision(p.noticeRevision)) || typeof p.manifestId !== 'string'
      || !(p.modelId === null || typeof p.modelId === 'string') || !micro(p.maxRequestMicro) || !micro(p.stylistAllowanceMicro)
      || !micro(p.totalAllowanceMicro) || typeof p.maxRequestsPerHour !== 'number' || !Number.isSafeInteger(p.maxRequestsPerHour)
      || p.maxRequestsPerHour < 1) return null;
    policy = { activated: p.activated, noticeRevision: p.noticeRevision, manifestId: p.manifestId, modelId: p.modelId,
      maxRequestMicro: p.maxRequestMicro, stylistAllowanceMicro: p.stylistAllowanceMicro, totalAllowanceMicro: p.totalAllowanceMicro,
      maxRequestsPerHour: p.maxRequestsPerHour };
  }
  if ((code === 'OK' || code === 'INACTIVE' || code === 'CONSENT_REQUIRED') !== (policy !== null)) return null;
  return { code, serverTimeMs: value.serverTimeMs, consent: { enabled: c.enabled, noticeRevision: c.noticeRevision }, policy,
    usage: { stylistMicro: u.stylistMicro, totalMicro: u.totalMicro, stylistLastHour: u.stylistLastHour } };
}

/** The policy this app version has a notice for: the reviewed manifest, model and notice revision, before review expiry. */
export function supportedStylistPolicy(status: StylistStatus): boolean {
  const p = status.policy;
  return p !== null && p.noticeRevision === STYLIST_NOTICE_REVISION && p.manifestId === STYLIST_MANIFEST && p.modelId === STYLIST_MODEL
    && status.serverTimeMs !== null && status.serverTimeMs < STYLIST_REVIEW_EXPIRES;
}

/** Latest status read in this owner scope. `missing` is only the expected PGRST202 reply when the RPC isn't installed. */
export type StylistRead = { kind: 'unknown' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; status: StylistStatus };
export type StylistViewKind = 'hidden' | 'loadFailed' | 'unresolved' | 'unavailable' | 'paused' | 'off' | 'renew' | 'on';
export type StylistView = {
  kind: StylistViewKind;
  /** Today's entry and the screen's chat. */ entry: boolean;
  /** The Settings card. */ card: boolean;
  turnOn: boolean; turnOff: boolean; send: boolean;
};

/**
 * Three separate questions: whether the entry shows, whether sending or turning on is allowed, and whether existing
 * consent can be withdrawn. Only a missing RPC, an unconfigured account without consent, or a state never seen as
 * usable in this scope is hidden. `known` is true once this scope has seen a shown state; a later failed read then
 * offers Try again instead of the old status.
 */
export function stylistView(read: StylistRead, known: boolean, unresolved: boolean): StylistView {
  const view = (kind: StylistViewKind, extra: Partial<StylistView> = {}): StylistView =>
    ({ kind, entry: false, card: true, turnOn: false, turnOff: false, send: false, ...extra });
  if (unresolved) return view('unresolved', { entry: known, card: true });
  if (read.kind === 'unknown' || read.kind === 'missing') return view('hidden', { card: false });
  if (read.kind === 'failed') return known ? view('loadFailed', { entry: true }) : view('hidden', { card: false });
  const { status } = read;
  const consented = status.consent?.enabled === true;
  if (status.code === 'UNAVAILABLE') return known ? view('unavailable') : view('hidden', { card: false });
  if (status.code === 'UNCONFIGURED') return consented ? view('unavailable', { turnOff: true }) : view('hidden', { card: false });
  if (!supportedStylistPolicy(status)) return view('unavailable', { turnOff: consented });
  if (status.code === 'INACTIVE') return view('paused', { entry: true, turnOff: consented });
  if (status.code === 'CONSENT_REQUIRED') {
    return consented ? view('renew', { entry: true, turnOn: true, turnOff: true }) : view('off', { entry: true, turnOn: true });
  }
  return view('on', { entry: true, turnOff: true, send: true });
}
export const shownStylistView = (view: StylistView) => view.kind !== 'hidden' && view.kind !== 'loadFailed' && view.kind !== 'unresolved';

export type StylistLimits = { own: boolean; shared: boolean; ownWarning: boolean; sharedWarning: boolean };
/**
 * Each limit from its own counters, as the claim checks them: a message is refused when its reservation would pass the
 * stylist limit or the shared monthly limit. A warning is shown from 80%, for the limit it concerns.
 */
export function stylistLimits(status: StylistStatus): StylistLimits {
  const p = status.policy, u = status.usage;
  if (!p || !u) return { own: false, shared: false, ownWarning: false, sharedWarning: false };
  const request = BigInt(p.maxRequestMicro), own = BigInt(u.stylistMicro), total = BigInt(u.totalMicro);
  const ownLimit = BigInt(p.stylistAllowanceMicro), totalLimit = BigInt(p.totalAllowanceMicro);
  const ownReached = own + request > ownLimit, sharedReached = total + request > totalLimit;
  return { own: ownReached, shared: sharedReached, ownWarning: !ownReached && own * 10n >= ownLimit * 8n,
    sharedWarning: !sharedReached && total * 10n >= totalLimit * 8n };
}
/** What a refused message says after status is read again. Only a limit the counters show as reached is named. */
export function allowanceKey(status: StylistStatus | null): MessageKey {
  if (!status) return 'stylist.limitReached';
  const limits = stylistLimits(status);
  return limits.own ? 'stylist.limitOwn' : limits.shared ? 'stylist.limitShared' : 'stylist.failed';
}

/** Typed text as it is sent: newlines kept, other control characters and lone surrogates replaced, then trimmed. */
export function normaliseMessage(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\p{Cs}/gu, '\uFFFD')
    // eslint-disable-next-line no-control-regex -- the server refuses these, so they are replaced before sending.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').trim();
}
/** Code points over the message limit, or 0. */
export const messageOver = (message: string) => Math.max(0, codePoints(message) - STYLIST_LIMITS.message);

export type ChatTurn = { role: 'user'; text: string } | { role: 'assistant'; text: string; outfits: readonly { readonly itemIds: readonly string[] }[] };
const clip = (text: string, limit: number) => codePoints(text) <= limit ? text : [...text].slice(0, limit).join('');
export type StylistRequestInput = {
  requestId: string; message: string; occasion: StylistOccasion; season: StylistSeason | null; weather: StylistWeather | null;
};

/**
 * The request body for one message. History keeps the newest turns: at most six, with earlier outfits' item IDs counted
 * by occurrence (the same item in two outfits counts twice) up to the server's 36, newest first; older outfits are left
 * out whole. The oldest turns are then dropped until the assembled body passes the server's own parser, the conversation
 * byte limit and the body size limit. Null only when the message itself can't be sent.
 */
export function stylistRequest(turns: readonly ChatTurn[], input: StylistRequestInput): StylistInput | null {
  if (!plainText(input.message, STYLIST_LIMITS.message) || !UUID.test(input.requestId)) return null;
  const recent = turns.slice(-STYLIST_LIMITS.historyTurns);
  let budget: number = STYLIST_LIMITS.historyOutfitRefs;
  const history: StylistTurn[] = [];
  for (let index = recent.length - 1; index >= 0; index--) {
    const turn = recent[index]!;
    const text = clip(turn.text, STYLIST_LIMITS.historyText);
    if (turn.role === 'user') { history.unshift({ role: 'user', text }); continue; }
    const outfits: string[][] = [];
    for (const { itemIds: ids } of turn.outfits.slice(0, STYLIST_LIMITS.outfits)) {
      const valid = ids.length > 0 && ids.length <= STYLIST_LIMITS.outfitItems && new Set(ids).size === ids.length
        && ids.every((id) => UUID.test(id));
      if (!valid || ids.length > budget) continue;
      budget -= ids.length;
      outfits.push([...ids]);
    }
    history.unshift({ role: 'assistant', text, outfits });
  }
  for (;;) {
    const body = { requestId: input.requestId, message: input.message, history, occasion: input.occasion, season: input.season,
      weather: input.weather };
    const parsed = parseStylistBody(body);
    if (parsed && conversationBytes(parsed) <= STYLIST_LIMITS.conversationBytes
      && utf8Bytes(JSON.stringify(body)) <= STYLIST_LIMITS.bodyBytes) return parsed;
    if (history.length === 0) return null;
    history.shift();
  }
}

/** Today's weather context as the stylist sends it: whole numbers inside the accepted ranges, otherwise left out. */
export function stylistWeather(context: { setting?: 'indoors' | 'outdoors'; temperatureC?: number; rainProbability?: number;
  windMetresPerSecond?: number }): StylistWeather | null {
  if (context.setting === 'indoors') return { setting: 'indoors', temperatureC: null, rainProbability: null, windMetresPerSecond: null };
  if (context.setting !== 'outdoors') return null;
  const whole = (value: number | undefined, min: number, max: number) => {
    if (value === undefined || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return rounded >= min && rounded <= max ? rounded : null;
  };
  return { setting: 'outdoors', temperatureC: whole(context.temperatureC, -60, 60), rainProbability: whole(context.rainProbability, 0, 100),
    windMetresPerSecond: whole(context.windMetresPerSecond, 0, 80) };
}

export const stylistReplyCodes = ['INVALID_INPUT', 'UNAUTHENTICATED', 'UNAVAILABLE', 'CONSENT_REQUIRED', 'TERMINAL', 'TOO_LARGE',
  'UNSUPPORTED_MEDIA', 'FILTERED', 'RATE_LIMIT', 'ALLOWANCE', 'FAILED', 'UNCONFIGURED', 'INACTIVE', 'CONFIG_CHANGED', 'BUSY', 'TIMEOUT'] as const;
export type StylistReplyCode = (typeof stylistReplyCodes)[number];
export type StylistIdea = { itemIds: string[]; note: string };
export type StylistAnswer = { code: 'OK'; reply: string; outfits: StylistIdea[] } | { code: StylistReplyCode };

/** The closed reply of the stylist-chat function. Anything outside it is FAILED; reply text is never read as an action. */
export function parseStylistAnswer(status: number, value: unknown): StylistAnswer {
  if (exactKeys(value, ['code', 'reply', 'outfits'])) {
    if (status !== 200 || value.code !== 'OK' || !plainText(value.reply, STYLIST_LIMITS.reply) || !Array.isArray(value.outfits)
      || value.outfits.length > STYLIST_LIMITS.outfits) return { code: 'FAILED' };
    const outfits: StylistIdea[] = [];
    for (const outfit of value.outfits) {
      if (!exactKeys(outfit, ['itemIds', 'note']) || !Array.isArray(outfit.itemIds) || outfit.itemIds.length < 1
        || outfit.itemIds.length > STYLIST_LIMITS.outfitItems || new Set(outfit.itemIds).size !== outfit.itemIds.length
        || !outfit.itemIds.every((id) => typeof id === 'string' && UUID.test(id)) || !plainText(outfit.note, STYLIST_LIMITS.note, true)) {
        return { code: 'FAILED' };
      }
      outfits.push({ itemIds: [...outfit.itemIds as string[]], note: outfit.note });
    }
    return { code: 'OK', reply: value.reply, outfits };
  }
  if (!exactKeys(value, ['code']) || status === 200) return { code: 'FAILED' };
  const code = stylistReplyCodes.find((entry) => entry === value.code);
  return code ? { code } : { code: 'FAILED' };
}

export type SendFailure = { key: MessageKey; retry: boolean };
/** Fixed words for each refused or failed message. ALLOWANCE is worded after status is read again (`allowanceKey`). */
export function sendFailure(code: StylistReplyCode | 'OFFLINE'): SendFailure {
  switch (code) {
    case 'RATE_LIMIT': return { key: 'stylist.rate', retry: false };
    case 'TIMEOUT': return { key: 'stylist.timeout', retry: true };
    case 'FILTERED': return { key: 'stylist.filtered', retry: false };
    case 'BUSY': return { key: 'stylist.busy', retry: true };
    case 'TOO_LARGE': case 'INVALID_INPUT': case 'UNSUPPORTED_MEDIA': return { key: 'stylist.notSent', retry: false };
    case 'UNAUTHENTICATED': return { key: 'auth.expired', retry: false };
    case 'ALLOWANCE': return { key: 'stylist.limitReached', retry: false };
    case 'OFFLINE': return { key: 'stylist.offline', retry: false };
    default: return { key: 'stylist.failed', retry: true };
  }
}

export type IdeaCheck = 'ok' | 'gone' | 'unavailable';
/**
 * Rechecks an idea against the wardrobe as last loaded, with the weather sent for it: every item must still be there
 * and pass the stylist eligibility contract. Missing means gone (deleted or in Trash); present but not eligible (in
 * the laundry, left out of suggestions, outside its temperature range) means it can't be used right now.
 */
export function checkIdea(itemIds: readonly string[], items: ReadonlyMap<string, WardrobeItem>, ownerId: string,
  weather: StylistWeather | null): IdeaCheck {
  if (itemIds.some((id) => !items.has(id))) return 'gone';
  return itemIds.every((id) => {
    const item = items.get(id)!;
    return stylistEligible({ ownerId: item.ownerId, deleted: false, lifecycle: item.lifecycle, availability: item.availability,
      excludeSuggestions: item.excludeSuggestions, readyImage: item.imageId !== '', minTemp: item.weather.minTemp,
      maxTemp: item.weather.maxTemp }, { ownerId, weather });
  }) ? 'ok' : 'unavailable';
}
export const isStylistOccasion = (value: unknown): value is StylistOccasion => STYLIST_OCCASIONS.some((entry) => entry === value);
