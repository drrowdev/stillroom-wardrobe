// The VTO-2b admin_ai_spending_v2 parser exactly as it stood before BUDGET1 (src/domain/admin-limits.ts at 96af72c9, the
// lines up to parseSpending, unchanged). The frozen compatibility check in tests/integration/tryon.sessions.mjs runs at the
// exact prior inventory (20261009090000), whose v2 reply still has per-feature limits, so it parses with this copy rather than
// the app's current budget-contract parser.

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
