// AD1b/BUDGET1: the admin spending and budget view (ADR27). Pure parsing, exact micro-USD arithmetic and form checks that
// mirror admin_set_ai_limits_v2 under the budget contract: one monthly budget per account. Amounts stay decimal strings
// or BigInt throughout; nothing here uses floating point.
import { locales, type Language } from '../i18n';

/** The account's one editable value. The retired hourly and per-feature limits are no longer read or written. */
export type Limits = { monthlyAllowanceMicro: string };
export type LimitField = 'monthlyAllowanceMicro';
export const SPEND_PURPOSES = ['analysis', 'stylist', 'enhancement', 'tryOn'] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];
export type MonthSpend = { confirmedMicro: string; estimatedMicro: string; reservedMicro: string; totalMicro: string; requests: number };
export type MonthHistory = { month: string } & Record<SpendPurpose, MonthSpend>;
export type CurrentUse = { usedMicro: string };
export type AdminAccount = {
  admissionNo: 1 | 2; enabled: boolean; accountVersion: string;
  features: Record<SpendPurpose, { configured: boolean; activated: boolean }>;
  limits: Limits | null; history: MonthHistory[];
  current: { period: string } & Record<'shared' | SpendPurpose, CurrentUse>;
  probe: ProbeAllocation; tryOnProbe: ProbeAllocation;
};
export type ProbeAllocation = { count: number; allocationMicro: string; maxCalls: number };
export type AdminSpending = { asOf: number; months: string[]; accounts: AdminAccount[] };

/** USD 50 in micro-USD: the per-account app limit on the monthly budget. */
export const APP_LIMIT_MICRO = 50_000_000n;
const MICRO = /^(0|[1-9][0-9]{0,11})$/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const VERSION = /^[0-9a-f]{64}$/;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isMicroText = (value: unknown): value is string => typeof value === 'string' && MICRO.test(value);

export function parseLimits(value: unknown): Limits | null {
  return exact(value, ['monthlyAllowanceMicro']) && isMicroText(value.monthlyAllowanceMicro) && value.monthlyAllowanceMicro !== '0'
    ? { monthlyAllowanceMicro: value.monthlyAllowanceMicro } : null;
}
function parseMonthSpend(value: unknown): MonthSpend | null {
  if (!exact(value, ['confirmedMicro', 'estimatedMicro', 'reservedMicro', 'totalMicro', 'requests'])) return null;
  const { confirmedMicro, estimatedMicro, reservedMicro, totalMicro, requests } = value;
  if (!isMicroText(confirmedMicro) || !isMicroText(estimatedMicro) || !isMicroText(reservedMicro) || !isMicroText(totalMicro)
    || !count(requests) || BigInt(confirmedMicro) + BigInt(estimatedMicro) + BigInt(reservedMicro) !== BigInt(totalMicro)) return null;
  return { confirmedMicro, estimatedMicro, reservedMicro, totalMicro, requests };
}
function parseCurrent(value: unknown): CurrentUse | null {
  return exact(value, ['usedMicro']) && isMicroText(value.usedMicro) ? { usedMicro: value.usedMicro } : null;
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
/** The admin_ai_spending_v2 reply under the budget contract, with exactly the keys ADR27 allows; anything else is refused whole. */
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

export type LimitReason = 'FORMAT' | 'NOT_POSITIVE' | 'APP_LIMIT';
const serverReasons: readonly LimitReason[] = ['NOT_POSITIVE', 'APP_LIMIT'];
export type WriteResult = { code: 'OK'; limits: Limits; belowUse: boolean } | { code: 'UNCHANGED'; limits: Limits }
  | { code: 'CONFLICT'; limits: Limits | null } | { code: 'INVALID_LIMITS'; field: LimitField; reason: LimitReason }
  | { code: 'UNAVAILABLE' | 'UNCONFIGURED' | 'INVALID_INPUT' };
/** The admin_set_ai_limits_v2 reply under the budget contract; null for anything that isn't one of its documented shapes. */
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
  if (value.code === 'INVALID_LIMITS' && exact(value, ['code', 'field', 'reason']) && value.field === 'monthlyAllowanceMicro') {
    const reason = serverReasons.find((entry) => entry === value.reason);
    return reason ? { code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason } : null;
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
/** The form text for the budget: a plain decimal in the language's separator. */
export function draftOf(limits: Limits, language: Language): string {
  return microToInput(limits.monthlyAllowanceMicro, language);
}
/** The budget a draft asks for, or the field's problem. A positive amount up to the app limit is accepted, even one below current use. */
export function limitsFromDraft(draft: string, language: Language): { limits: Limits | null; errors: FieldErrors } {
  const micro = inputToMicro(draft, language);
  if (micro === null) return { limits: null, errors: { monthlyAllowanceMicro: 'FORMAT' } };
  const limits = { monthlyAllowanceMicro: micro };
  const errors = checkLimits(limits);
  return Object.keys(errors).length ? { limits: null, errors } : { limits, errors: {} };
}
/** The server's constraints that the app can know about. */
export function checkLimits(limits: Limits): FieldErrors {
  const monthly = BigInt(limits.monthlyAllowanceMicro);
  if (monthly <= 0n) return { monthlyAllowanceMicro: 'NOT_POSITIVE' };
  if (monthly > APP_LIMIT_MICRO) return { monthlyAllowanceMicro: 'APP_LIMIT' };
  return {};
}
export const sameLimits = (left: Limits, right: Limits) => left.monthlyAllowanceMicro === right.monthlyAllowanceMicro;
/** Whether current use already passes the budget: new requests are refused until the amount is raised or the month turns. */
export const belowUse = (limits: Limits, usedMicro: string) => BigInt(usedMicro) > BigInt(limits.monthlyAllowanceMicro);
