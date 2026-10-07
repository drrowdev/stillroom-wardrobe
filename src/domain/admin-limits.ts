// AD1b: the admin spending and limits view (ADR27). Pure parsing, exact micro-USD arithmetic and form checks that
// mirror admin_set_ai_limits_v2 (VTO-2b adds try-on as a fourth feature). Amounts stay decimal strings or BigInt
// throughout; nothing here uses floating point.
import { locales, type Language } from '../i18n';

export const LIMIT_FEATURES = ['shared', 'stylist', 'enhancement', 'tryOn'] as const;
export type LimitFeature = (typeof LIMIT_FEATURES)[number];
export const LIMIT_KEYS = ['monthlyAllowanceMicro', 'maxRequestMicro', 'maxRequestsPerHour'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type FeatureLimits = { monthlyAllowanceMicro: string | null; maxRequestMicro: string | null; maxRequestsPerHour: number | null };
export type Limits = Record<LimitFeature, FeatureLimits>;
export type LimitField = `${LimitFeature}.${LimitKey}`;
export const SPEND_PURPOSES = ['analysis', 'stylist', 'enhancement', 'tryOn'] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];
export type MonthSpend = { confirmedMicro: string; estimatedMicro: string; reservedMicro: string; totalMicro: string; requests: number };
export type MonthHistory = { month: string } & Record<SpendPurpose, MonthSpend>;
export type CurrentUse = { usedMicro: string; lastHour: number };
export type AdminAccount = {
  admissionNo: 1 | 2; enabled: boolean; accountVersion: string;
  features: Record<SpendPurpose, { configured: boolean; activated: boolean }>;
  limits: Limits | null; history: MonthHistory[];
  current: { period: string } & Record<'shared' | SpendPurpose, CurrentUse>;
  probe: ProbeAllocation; tryOnProbe: ProbeAllocation;
};
export type ProbeAllocation = { count: number; allocationMicro: string; maxCalls: number };
export type AdminSpending = { asOf: number; months: string[]; accounts: AdminAccount[] };

/** USD 50 in micro-USD: the per-account app limit on the shared monthly allowance. */
export const APP_LIMIT_MICRO = 50_000_000n;
export const MAX_HOURLY = 1000;
const MICRO = /^(0|[1-9][0-9]{0,11})$/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const VERSION = /^[0-9a-f]{64}$/;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isMicroText = (value: unknown): value is string => typeof value === 'string' && MICRO.test(value);

function parseFeatureLimits(value: unknown): FeatureLimits | null {
  if (!exact(value, LIMIT_KEYS)) return null;
  const { monthlyAllowanceMicro: monthly, maxRequestMicro: request, maxRequestsPerHour: hour } = value;
  if (monthly !== null && !isMicroText(monthly) || request !== null && !isMicroText(request)
    || hour !== null && !(count(hour) && hour <= 1_000_000_000)) return null;
  return { monthlyAllowanceMicro: monthly, maxRequestMicro: request, maxRequestsPerHour: hour };
}
export function parseLimits(value: unknown): Limits | null {
  if (!exact(value, LIMIT_FEATURES)) return null;
  const [shared, stylist, enhancement, tryOn] = LIMIT_FEATURES.map((feature) => parseFeatureLimits(value[feature]));
  if (!shared || !stylist || !enhancement || !tryOn) return null;
  return { shared, stylist, enhancement, tryOn };
}
function parseMonthSpend(value: unknown): MonthSpend | null {
  if (!exact(value, ['confirmedMicro', 'estimatedMicro', 'reservedMicro', 'totalMicro', 'requests'])) return null;
  const { confirmedMicro, estimatedMicro, reservedMicro, totalMicro, requests } = value;
  if (!isMicroText(confirmedMicro) || !isMicroText(estimatedMicro) || !isMicroText(reservedMicro) || !isMicroText(totalMicro)
    || !count(requests) || BigInt(confirmedMicro) + BigInt(estimatedMicro) + BigInt(reservedMicro) !== BigInt(totalMicro)) return null;
  return { confirmedMicro, estimatedMicro, reservedMicro, totalMicro, requests };
}
function parseCurrent(value: unknown): CurrentUse | null {
  return exact(value, ['usedMicro', 'lastHour']) && isMicroText(value.usedMicro) && count(value.lastHour)
    ? { usedMicro: value.usedMicro, lastHour: value.lastHour } : null;
}
function parseProbe(value: unknown): ProbeAllocation | null {
  return exact(value, ['count', 'allocationMicro', 'maxCalls']) && count(value.count) && isMicroText(value.allocationMicro) && count(value.maxCalls)
    ? { count: value.count, allocationMicro: value.allocationMicro, maxCalls: value.maxCalls } : null;
}
function parseAccount(value: unknown, months: readonly string[]): AdminAccount | null {
  if (!exact(value, ['admissionNo', 'enabled', 'accountVersion', 'features', 'limits', 'history', 'current', 'openAllocations'])) return null;
  const { admissionNo, enabled, accountVersion, features, limits, history, current, openAllocations } = value;
  if (admissionNo !== 1 && admissionNo !== 2 || typeof enabled !== 'boolean' || typeof accountVersion !== 'string'
    || !VERSION.test(accountVersion) || !exact(features, SPEND_PURPOSES) || !Array.isArray(history) || history.length !== months.length
    || !exact(current, ['period', 'shared', ...SPEND_PURPOSES]) || typeof current.period !== 'string' || current.period !== months[0]
    || !exact(openAllocations, ['enhancementProbe', 'tryOnProbe'])) return null;
  const flags = {} as AdminAccount['features'];
  for (const purpose of SPEND_PURPOSES) {
    const flag = features[purpose];
    if (!exact(flag, ['configured', 'activated']) || typeof flag.configured !== 'boolean' || typeof flag.activated !== 'boolean') return null;
    flags[purpose] = { configured: flag.configured, activated: flag.activated };
  }
  const parsedLimits = limits === null ? null : parseLimits(limits);
  if (limits !== null && !parsedLimits) return null;
  const rows: MonthHistory[] = [];
  for (const [index, entry] of history.entries()) {
    if (!exact(entry, ['month', ...SPEND_PURPOSES]) || entry.month !== months[index]) return null;
    const [analysis, stylist, enhancement, tryOn] = SPEND_PURPOSES.map((purpose) => parseMonthSpend(entry[purpose]));
    if (!analysis || !stylist || !enhancement || !tryOn) return null;
    rows.push({ month: months[index]!, analysis, stylist, enhancement, tryOn });
  }
  const shared = parseCurrent(current.shared);
  const [analysis, stylist, enhancement, tryOn] = SPEND_PURPOSES.map((purpose) => parseCurrent(current[purpose]));
  const probe = parseProbe(openAllocations.enhancementProbe), tryOnProbe = parseProbe(openAllocations.tryOnProbe);
  if (!shared || !analysis || !stylist || !enhancement || !tryOn || !probe || !tryOnProbe) return null;
  return { admissionNo, enabled, accountVersion, features: flags, limits: parsedLimits, history: rows,
    current: { period: current.period, shared, analysis, stylist, enhancement, tryOn }, probe, tryOnProbe };
}
/** The admin_ai_spending_v2 reply, with exactly the keys ADR27 allows; anything else is refused whole. */
export function parseSpending(value: unknown): AdminSpending | null {
  if (!exact(value, ['code', 'asOf', 'months', 'accounts']) || value.code !== 'OK' || !count(value.asOf)
    || !Array.isArray(value.months) || value.months.length < 1 || value.months.length > 12 || !Array.isArray(value.accounts)
    || value.accounts.length > 2) return null;
  const months: string[] = [];
  for (const month of value.months) {
    if (typeof month !== 'string' || !MONTH.test(month) || months.length && months.at(-1)! <= month) return null;
    months.push(month);
  }
  const accounts: AdminAccount[] = [];
  for (const entry of value.accounts) {
    const account = parseAccount(entry, months);
    if (!account || accounts.some((other) => other.admissionNo >= account.admissionNo)) return null;
    accounts.push(account);
  }
  return { asOf: value.asOf, months, accounts };
}

export type LimitReason = 'FORMAT' | 'REQUIRED' | 'NOT_POSITIVE' | 'RANGE' | 'APP_LIMIT' | 'ABOVE_MONTHLY' | 'ABOVE_SHARED' | 'BELOW_RESERVATION';
const serverReasons: readonly LimitReason[] = ['REQUIRED', 'NOT_POSITIVE', 'RANGE', 'APP_LIMIT', 'ABOVE_MONTHLY', 'ABOVE_SHARED', 'BELOW_RESERVATION'];
export type WriteResult = { code: 'OK'; limits: Limits; belowUse: boolean } | { code: 'UNCHANGED'; limits: Limits }
  | { code: 'CONFLICT'; limits: Limits | null } | { code: 'INVALID_LIMITS'; field: LimitField; reason: LimitReason }
  | { code: 'UNAVAILABLE' | 'UNCONFIGURED' | 'INVALID_INPUT' };
const isField = (value: unknown): value is LimitField => typeof value === 'string'
  && LIMIT_FEATURES.some((feature) => LIMIT_KEYS.some((key) => value === `${feature}.${key}`));
/** The admin_set_ai_limits_v2 reply; null for anything that isn't one of its documented shapes. */
export function parseWriteResult(value: unknown): WriteResult | null {
  if (!record(value)) return null;
  if (value.code === 'OK' && exact(value, ['code', 'limits', 'belowUse']) && typeof value.belowUse === 'boolean') {
    const limits = parseLimits(value.limits);
    return limits && { code: 'OK', limits, belowUse: value.belowUse };
  }
  if (value.code === 'UNCHANGED' && exact(value, ['code', 'limits'])) {
    const limits = parseLimits(value.limits);
    return limits && { code: 'UNCHANGED', limits };
  }
  if (value.code === 'CONFLICT' && (exact(value, ['code']) || exact(value, ['code', 'limits']))) {
    const limits = 'limits' in value ? parseLimits(value.limits) : null;
    return 'limits' in value && !limits ? null : { code: 'CONFLICT', limits };
  }
  if (value.code === 'INVALID_LIMITS' && exact(value, ['code', 'field', 'reason']) && isField(value.field)) {
    const reason = serverReasons.find((entry) => entry === value.reason);
    return reason ? { code: 'INVALID_LIMITS', field: value.field, reason } : null;
  }
  if ((value.code === 'UNAVAILABLE' || value.code === 'UNCONFIGURED' || value.code === 'INVALID_INPUT') && exact(value, ['code'])) {
    return { code: value.code };
  }
  return null;
}

const addMicro = (...values: string[]) => values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
/** Confirmed plus estimated plus reserved, per feature; the total the view shows, summed over the four features. */
export function monthTotals(month: MonthHistory): MonthSpend {
  const parts = SPEND_PURPOSES.map((purpose) => month[purpose]);
  return { confirmedMicro: addMicro(...parts.map((part) => part.confirmedMicro)), estimatedMicro: addMicro(...parts.map((part) => part.estimatedMicro)),
    reservedMicro: addMicro(...parts.map((part) => part.reservedMicro)), totalMicro: addMicro(...parts.map((part) => part.totalMicro)),
    requests: parts.reduce((sum, part) => sum + part.requests, 0) };
}

const decimalSeparator = (language: Language) => language === 'en' ? '.' : ',';
/** Micro-USD as a plain decimal with no trailing zeros, for an input: "4.097351", "50" or, in Finnish, "0,12936". */
export function microToInput(micro: string, language: Language): string {
  if (!isMicroText(micro)) throw new Error('Invalid amount.');
  const value = BigInt(micro), whole = value / 1_000_000n, fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}${decimalSeparator(language)}${fraction}` : String(whole);
}
/** A typed US-dollar amount (up to 6 decimals, "." or the language's "," separator) as micro-USD, or null. */
export function inputToMicro(text: string, language: Language): string | null {
  const value = text.trim();
  const pattern = language === 'en' ? /^([0-9]{1,6})(?:\.([0-9]{1,6}))?$/ : /^([0-9]{1,6})(?:[.,]([0-9]{1,6}))?$/;
  const match = pattern.exec(value);
  if (!match) return null;
  const micro = (BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))).toString();
  return isMicroText(micro) ? micro : null;
}
/** An exact micro-USD amount in US dollars: at least 2 and at most 6 decimals, never rounded. */
export function formatUsd(micro: string, language: Language): string {
  if (!isMicroText(micro)) throw new Error('Invalid amount.');
  const value = BigInt(micro);
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2, maximumFractionDigits: 6 })
    .format(`${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}` as `${number}`);
}

/** Display only: rounds an exact micro-dollar amount half-up to whole cents. The exact value stays with formatUsd. */
export function formatUsdCents(micro: string, language: Language): string {
  if (!isMicroText(micro)) throw new Error('Invalid amount.');
  const cents = (BigInt(micro) + 5_000n) / 10_000n;
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` as `${number}`);
}

export type FieldErrors = Partial<Record<LimitField, LimitReason>>;
export type LimitDraft = Record<LimitFeature, Record<LimitKey, string>>;
/** The form text for each configured value; unconfigured values stay empty and are never sent as anything but null. */
export function draftOf(limits: Limits, language: Language): LimitDraft {
  const draft = {} as LimitDraft;
  for (const feature of LIMIT_FEATURES) {
    const values = limits[feature];
    draft[feature] = {
      monthlyAllowanceMicro: values.monthlyAllowanceMicro === null ? '' : microToInput(values.monthlyAllowanceMicro, language),
      maxRequestMicro: values.maxRequestMicro === null ? '' : microToInput(values.maxRequestMicro, language),
      maxRequestsPerHour: values.maxRequestsPerHour === null ? '' : String(values.maxRequestsPerHour),
    };
  }
  return draft;
}
/**
 * The limits a draft asks for. A field left as it was read is sent exactly as read; a null value stays null. Every other
 * field is parsed exactly, and each failure is reported against its field.
 */
export function limitsFromDraft(draft: LimitDraft, initial: LimitDraft, current: Limits, language: Language): { limits: Limits | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const limits = {} as Limits;
  for (const feature of LIMIT_FEATURES) {
    const read = current[feature], next: FeatureLimits = { ...read };
    for (const key of ['monthlyAllowanceMicro', 'maxRequestMicro'] as const) {
      if (read[key] === null || draft[feature][key] === initial[feature][key]) continue;
      const micro = inputToMicro(draft[feature][key], language);
      if (micro === null) errors[`${feature}.${key}`] = 'FORMAT'; else next[key] = micro;
    }
    const hourText = draft[feature].maxRequestsPerHour.trim();
    if (read.maxRequestsPerHour !== null && draft[feature].maxRequestsPerHour !== initial[feature].maxRequestsPerHour) {
      if (!/^[0-9]{1,4}$/.test(hourText)) errors[`${feature}.maxRequestsPerHour`] = 'RANGE';
      else next.maxRequestsPerHour = Number(hourText);
    }
    limits[feature] = next;
  }
  if (Object.keys(errors).length) return { limits: null, errors };
  const checked = checkLimits(limits);
  return Object.keys(checked).length ? { limits: null, errors: checked } : { limits, errors: {} };
}
/** The server's constraints that the app can know about; the manifest reservation floor is checked only by the server. */
export function checkLimits(limits: Limits): FieldErrors {
  const errors: FieldErrors = {};
  const set = (field: LimitField, reason: LimitReason) => { errors[field] ??= reason; };
  const shared = limits.shared.monthlyAllowanceMicro === null ? null : BigInt(limits.shared.monthlyAllowanceMicro);
  for (const feature of LIMIT_FEATURES) {
    const { monthlyAllowanceMicro: monthlyText, maxRequestMicro: requestText, maxRequestsPerHour: hour } = limits[feature];
    const monthly = monthlyText === null ? null : BigInt(monthlyText), request = requestText === null ? null : BigInt(requestText);
    if (monthly !== null && monthly <= 0n) set(`${feature}.monthlyAllowanceMicro`, 'NOT_POSITIVE');
    if (request !== null && request <= 0n) set(`${feature}.maxRequestMicro`, 'NOT_POSITIVE');
    if (hour !== null && (hour < 1 || hour > MAX_HOURLY)) set(`${feature}.maxRequestsPerHour`, 'RANGE');
    if (feature === 'shared' && monthly !== null && monthly > APP_LIMIT_MICRO) set('shared.monthlyAllowanceMicro', 'APP_LIMIT');
    if (monthly !== null && request !== null && request > monthly) set(`${feature}.maxRequestMicro`, 'ABOVE_MONTHLY');
    if (feature !== 'shared' && monthly !== null && shared !== null && monthly > shared) set(`${feature}.monthlyAllowanceMicro`, 'ABOVE_SHARED');
  }
  return errors;
}
/** The values the admin edits; the per-request value is never shown and is always sent exactly as read. */
export const EDITABLE_KEYS = ['monthlyAllowanceMicro', 'maxRequestsPerHour'] as const;
/**
 * Errors as the form shows them. A monthly limit below the hidden per-request value is a problem with the monthly limit.
 * Any other problem with the hidden value cannot be fixed on this screen, so it is reported as `setup` instead of on a field.
 */
export function visibleErrors(errors: FieldErrors): { errors: FieldErrors; setup: boolean } {
  const shown: FieldErrors = {};
  let setup = false;
  for (const feature of LIMIT_FEATURES) for (const key of LIMIT_KEYS) {
    const reason = errors[`${feature}.${key}`];
    if (!reason) continue;
    if (key !== 'maxRequestMicro') shown[`${feature}.${key}`] ??= reason;
    else if (reason === 'ABOVE_MONTHLY') shown[`${feature}.monthlyAllowanceMicro`] ??= 'BELOW_RESERVATION';
    else setup = true;
  }
  return { errors: shown, setup };
}
export const sameLimits = (left: Limits, right: Limits) => LIMIT_FEATURES.every((feature) => LIMIT_KEYS.every((key) => left[feature][key] === right[feature][key]));
export type LimitChange = { feature: LimitFeature; key: LimitKey; from: string | number; to: string | number };
/** The changed fields, in form order, for the confirmation. */
export function limitChanges(from: Limits, to: Limits): LimitChange[] {
  const changes: LimitChange[] = [];
  for (const feature of LIMIT_FEATURES) for (const key of LIMIT_KEYS) {
    const before = from[feature][key], after = to[feature][key];
    if (before !== after && before !== null && after !== null) changes.push({ feature, key, from: before, to: after });
  }
  return changes;
}
