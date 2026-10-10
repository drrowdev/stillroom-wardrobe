// BUDGET1: one monthly AI budget per account across every AI purpose. The server enforces the money; this module only
// reads its closed reply and does the arithmetic the screens show.

/** Selects the budget contract on every status, consent and admin read or write, and on the four Edge routes. */
export const AI_BUDGET_CONTRACT_HEADER = 'X-Stillroom-AI-Budget-Contract';
export const AI_BUDGET_CONTRACT = '2';
export const aiBudgetHeaders = { [AI_BUDGET_CONTRACT_HEADER]: AI_BUDGET_CONTRACT } as const;

export type AiBudget = Readonly<{ monthlyAllowanceMicro: string; usedMicro: string; remainingMicro: string; warning: boolean }>;

const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses the closed `budget` object. Amounts are canonical integer strings; the remaining amount never goes below zero. */
export function parseAiBudget(value: unknown): AiBudget | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['monthlyAllowanceMicro', 'usedMicro', 'remainingMicro', 'warning'].every((key) => keys.includes(key))) return null;
  const { monthlyAllowanceMicro: allowance, usedMicro: used, remainingMicro: remaining, warning } = value;
  if (typeof allowance !== 'string' || typeof used !== 'string' || typeof remaining !== 'string' || typeof warning !== 'boolean'
    || !MICRO.test(allowance) || !MICRO.test(used) || !MICRO.test(remaining) || allowance === '0') return null;
  const left = BigInt(allowance) - BigInt(used);
  if (BigInt(remaining) !== (left > 0n ? left : 0n)) return null;
  return Object.freeze({ monthlyAllowanceMicro: allowance, usedMicro: used, remainingMicro: remaining, warning });
}

/** A budget is shown only when the account has controls: the reply carries `budget: null` otherwise. */
export function parseOptionalAiBudget(value: unknown): { ok: true; budget: AiBudget | null } | { ok: false } {
  if (value === null) return { ok: true, budget: null };
  const budget = parseAiBudget(value);
  return budget ? { ok: true, budget } : { ok: false };
}

/** Whether one more request reserving `reservationMicro` no longer fits, as the server's claim decides it. */
export function budgetExhausted(budget: AiBudget | null, reservationMicro: string): boolean {
  return budget !== null && BigInt(budget.usedMicro) + BigInt(reservationMicro) > BigInt(budget.monthlyAllowanceMicro);
}
/** Used above the budget itself (an edit below current use): everything new is refused until money permits it. */
export function budgetOver(budget: AiBudget | null): boolean {
  return budget !== null && BigInt(budget.usedMicro) > BigInt(budget.monthlyAllowanceMicro);
}
