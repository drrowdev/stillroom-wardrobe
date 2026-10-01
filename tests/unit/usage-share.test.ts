import { describe, expect, it } from 'vitest';
import { monthSplit, usageShare } from '../../src/features/admin/usage-share';
import { monthTotals, type MonthHistory, type MonthSpend } from '../../src/domain/admin-limits';

const spend = (confirmedMicro: string, estimatedMicro: string, reservedMicro: string, requests = 0): MonthSpend => ({
  confirmedMicro, estimatedMicro, reservedMicro, requests,
  totalMicro: (BigInt(confirmedMicro) + BigInt(estimatedMicro) + BigInt(reservedMicro)).toString(),
});

describe('usageShare', () => {
  it('has no bar without a limit, with a zero limit or with invalid amounts', () => {
    expect(usageShare('100', null)).toBeNull();
    expect(usageShare('100', '0')).toBeNull();
    expect(usageShare('abc', '100')).toBeNull();
    expect(usageShare('1.5', '100')).toBeNull();
    expect(usageShare('-1', '100')).toBeNull();
    expect(usageShare('100', '01')).toBeNull();
  });
  it('is the used share, clamped to 1 when over the limit', () => {
    expect(usageShare('0', '5000000')).toBe(0);
    expect(usageShare('1250000', '5000000')).toBe(0.25);
    expect(usageShare('5000000', '5000000')).toBe(1);
    expect(usageShare('7000000', '5000000')).toBe(1);
  });
  it('stays exact for large micro values', () => {
    expect(usageShare('999999999998', '999999999999')).toBe(0.9999);
    expect(usageShare('333333333333', '999999999999')).toBe(0.3333);
  });
});

describe('monthSplit', () => {
  it('is Used = confirmed + estimated and Pending = reserved, adding up to the total', () => {
    const value = spend('1200000', '340000', '56000', 7);
    const split = monthSplit(value);
    expect(split).toEqual({ usedMicro: '1540000', pendingMicro: '56000', requests: 7 });
    expect(BigInt(split.usedMicro) + BigInt(split.pendingMicro)).toBe(BigInt(value.totalMicro));
  });
  it('is exact beyond 2^53', () => {
    const value = spend('499999999999', '499999999999', '1');
    expect(monthSplit(value).usedMicro).toBe('999999999998');
    const big = { ...value, confirmedMicro: '9007199254740993', estimatedMicro: '1', totalMicro: '9007199254740995' };
    expect(monthSplit(big).usedMicro).toBe('9007199254740994');
  });
  it('uses the month totals the exact table shows; setup holds are not part of them', () => {
    const month: MonthHistory = { month: '2026-09', analysis: spend('100', '20', '3', 1), stylist: spend('400', '0', '50', 2),
      enhancement: spend('0', '0', '0'), tryOn: spend('7', '0', '0', 1) };
    const totals = monthTotals(month);
    expect(monthSplit(totals)).toEqual({ usedMicro: '527', pendingMicro: '53', requests: 4 });
    expect(BigInt(monthSplit(totals).usedMicro) + BigInt(monthSplit(totals).pendingMicro)).toBe(BigInt(totals.totalMicro));
  });
});
