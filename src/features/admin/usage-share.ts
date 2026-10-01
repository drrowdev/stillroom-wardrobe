import { isMicroText, type MonthSpend } from '../../domain/admin-limits';

/** How much of a limit is used, from 0 to 1, for a bar. Null when there is no limit or an amount is not valid micro-USD. */
export function usageShare(usedMicro: string, limitMicro: string | null): number | null {
  if (limitMicro === null || !isMicroText(usedMicro) || !isMicroText(limitMicro)) return null;
  const used = BigInt(usedMicro), limit = BigInt(limitMicro);
  if (limit === 0n) return null;
  if (used >= limit) return 1;
  return Number(used * 10_000n / limit) / 10_000;
}

/**
 * A month's spending as the admin summary shows it, from the same totals as the exact table: Used is confirmed plus
 * estimated, Pending is still reserved. Exact BigInt arithmetic; Used plus Pending is the month's total.
 */
export function monthSplit(spend: MonthSpend): { usedMicro: string; pendingMicro: string; requests: number } {
  return { usedMicro: (BigInt(spend.confirmedMicro) + BigInt(spend.estimatedMicro)).toString(), pendingMicro: spend.reservedMicro, requests: spend.requests };
}
