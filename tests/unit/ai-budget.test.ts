import { describe, expect, it } from 'vitest';
import {
  AI_BUDGET_CONTRACT, AI_BUDGET_CONTRACT_HEADER, aiBudgetHeaders, budgetExhausted, budgetOver, parseAiBudget, parseOptionalAiBudget,
} from '../../src/domain/ai-budget';

const budget = (allowance: string, used: string, warning = false) => ({
  monthlyAllowanceMicro: allowance, usedMicro: used,
  remainingMicro: String(BigInt(allowance) > BigInt(used) ? BigInt(allowance) - BigInt(used) : 0n), warning,
});

describe('BUDGET1 one account budget', () => {
  it('names the contract header exactly', () => {
    expect(AI_BUDGET_CONTRACT_HEADER).toBe('X-Stillroom-AI-Budget-Contract');
    expect(AI_BUDGET_CONTRACT).toBe('2');
    expect(aiBudgetHeaders).toEqual({ 'X-Stillroom-AI-Budget-Contract': '2' });
  });

  it('reads the closed budget object with canonical integer strings', () => {
    expect(parseAiBudget(budget('20000000', '4102191'))).toEqual(budget('20000000', '4102191'));
    expect(parseAiBudget(budget('1', '0'))?.remainingMicro).toBe('1');
    expect(parseAiBudget(Object.freeze(budget('5', '9')))?.remainingMicro).toBe('0');
  });

  it.each([
    ['a missing key', () => Object.fromEntries(Object.entries(budget('5', '1')).filter(([key]) => key !== 'warning'))],
    ['an extra key', () => ({ ...budget('5', '1'), hourly: 3 })],
    ['a zero budget', () => budget('0', '0')],
    ['a leading zero', () => ({ ...budget('5', '1'), usedMicro: '01' })],
    ['a number instead of text', () => ({ ...budget('5', '1'), usedMicro: 1 })],
    ['a fractional amount', () => ({ ...budget('5', '1'), usedMicro: '1.5' })],
    ['a negative amount', () => ({ ...budget('5', '1'), usedMicro: '-1' })],
    ['a remaining amount that is not the difference', () => ({ ...budget('5', '1'), remainingMicro: '3' })],
    ['a remaining amount below zero shown as the difference', () => ({ ...budget('5', '9'), remainingMicro: '-4' })],
    ['a non-boolean warning', () => ({ ...budget('5', '1'), warning: 'yes' })],
    ['an array', () => []],
    ['null', () => null],
  ])('refuses %s', (_name, build) => {
    expect(parseAiBudget(build())).toBeNull();
  });

  it('allows a missing budget only as an explicit null', () => {
    expect(parseOptionalAiBudget(null)).toEqual({ ok: true, budget: null });
    expect(parseOptionalAiBudget(undefined)).toEqual({ ok: false });
    expect(parseOptionalAiBudget({})).toEqual({ ok: false });
    expect(parseOptionalAiBudget(budget('5', '1'))).toMatchObject({ ok: true });
  });

  it('judges one more request against the one sum, exactly as the claim does', () => {
    const b = parseAiBudget(budget('1000', '600'));
    expect(budgetExhausted(b, '400')).toBe(false);
    expect(budgetExhausted(b, '401')).toBe(true);
    expect(budgetExhausted(null, '999999999')).toBe(false);
    expect(budgetOver(parseAiBudget(budget('1000', '1000')))).toBe(false);
    expect(budgetOver(parseAiBudget(budget('1000', '1001')))).toBe(true);
    expect(budgetOver(null)).toBe(false);
  });
});
