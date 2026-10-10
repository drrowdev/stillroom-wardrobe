import { describe, expect, it } from 'vitest';
import {
  belowUse, checkLimits, draftOf, formatUsd, formatUsdCents, inputToMicro, limitsFromDraft, microToInput, monthTotals, parseLimits, parseSpending,
  parseWriteResult, sameLimits, type Limits,
} from '../../src/domain/admin-limits';
import { readAdminSpending, readAdminStatus, writeAdminLimits } from '../../src/data/admin';
import type { AppClient } from '../../src/data/client';
import type { OwnerScope } from '../../src/auth/session';
import { parseSpending as parseSpendingV1 } from '../fixtures/admin-limits-v1';

const spend = (confirmed = '0', estimated = '0', reserved = '0', requests = 0) => ({ confirmedMicro: confirmed, estimatedMicro: estimated,
  reservedMicro: reserved, totalMicro: String(BigInt(confirmed) + BigInt(estimated) + BigInt(reserved)), requests });
const limits = (): Limits => ({ monthlyAllowanceMicro: '20000000' });
const monthsBack = (count: number) => Array.from({ length: count }, (_, index) => { const date = new Date(Date.UTC(2026, 8 - index, 15)); return date.toISOString().slice(0, 7); });
let months = monthsBack(2);
function account(admissionNo = 1) {
  return {
    admissionNo, enabled: true, accountVersion: 'a'.repeat(64),
    features: { analysis: { configured: true, activated: true }, stylist: { configured: true, activated: true }, enhancement: { configured: false, activated: false },
      tryOn: { configured: true, activated: false } },
    limits: limits(),
    history: months.map((month) => ({ month, analysis: spend('1200', '300', '4097351', 3), stylist: spend('0', '4840', '0', 1), enhancement: spend(),
      tryOn: spend('240000', '0', '360000', 2) })),
    current: { period: '2026-09', shared: { usedMicro: '4102191' }, analysis: { usedMicro: '4097351' },
      stylist: { usedMicro: '4840' }, enhancement: { usedMicro: '0' }, tryOn: { usedMicro: '600000' } },
    openAllocations: { enhancementProbe: { count: 0, allocationMicro: '0', maxCalls: 0 }, tryOnProbe: { count: 1, allocationMicro: '1800000', maxCalls: 5 } },
  };
}
const reply = (extra: (value: ReturnType<typeof base>) => void = () => undefined) => { const value = base(); extra(value); return value; };
function base() { return { code: 'OK', asOf: 1_790_000_000_000, months: [...months], accounts: [account(1), account(2)] }; }

describe('admin spending reply (budget contract)', () => {
  it('accepts the documented shape', () => {
    const parsed = parseSpending(base());
    expect(parsed?.accounts.map((entry) => entry.admissionNo)).toEqual([1, 2]);
    expect(parsed?.accounts[0]?.history[0]?.analysis.reservedMicro).toBe('4097351');
    expect(parsed?.accounts[0]?.probe).toEqual({ count: 0, allocationMicro: '0', maxCalls: 0 });
    expect(parsed?.accounts[0]?.tryOnProbe).toEqual({ count: 1, allocationMicro: '1800000', maxCalls: 5 });
    expect(parsed?.accounts[0]?.history[0]?.tryOn).toEqual(spend('240000', '0', '360000', 2));
    expect(parsed?.accounts[0]?.current.tryOn).toEqual({ usedMicro: '600000' });
    expect(parsed?.accounts[0]?.limits).toEqual({ monthlyAllowanceMicro: '20000000' });
    expect(parsed?.accounts[0]?.features.tryOn).toEqual({ configured: true, activated: false });
  });
  it('is not the v1 reply: each parser refuses the other version', () => {
    const v1 = reply((value) => { for (const entry of value.accounts) {
      const shape = entry as Record<string, unknown> & typeof entry;
      delete (shape.features as Record<string, unknown>).tryOn;
      shape.limits = { shared: { monthlyAllowanceMicro: '20000000', maxRequestMicro: '4097351', maxRequestsPerHour: 30 },
        stylist: { monthlyAllowanceMicro: null, maxRequestMicro: null, maxRequestsPerHour: null },
        enhancement: { monthlyAllowanceMicro: null, maxRequestMicro: null, maxRequestsPerHour: null } } as never;
      shape.current = { period: '2026-09', shared: { usedMicro: '0', lastHour: 0 }, analysis: { usedMicro: '0', lastHour: 0 },
        stylist: { usedMicro: '0', lastHour: 0 }, enhancement: { usedMicro: '0', lastHour: 0 } } as never;
      delete (shape.openAllocations as Record<string, unknown>).tryOnProbe;
      for (const month of shape.history) Object.assign(month, { tryOn: { available: false } });
    } });
    expect(parseSpendingV1(v1)).not.toBeNull();
    expect(parseSpending(v1)).toBeNull();
    expect(parseSpendingV1(base())).toBeNull();
  });
  it('refuses the retired quota shape: hourly counts and per-feature limits', () => {
    expect(parseSpending(reply((value) => { Object.assign(value.accounts[0]!.current.shared, { lastHour: 2 }); }))).toBeNull();
    expect(parseSpending(reply((value) => { Object.assign(value.accounts[0]!, { limits: { shared: { monthlyAllowanceMicro: '1',
      maxRequestMicro: '1', maxRequestsPerHour: 1 }, stylist: {}, enhancement: {}, tryOn: {} } }); }))).toBeNull();
    expect(parseLimits({ monthlyAllowanceMicro: '0' })).toBeNull();
    expect(parseLimits({ monthlyAllowanceMicro: '5', maxRequestsPerHour: 3 })).toBeNull();
  });
  it('accepts an account without controls', () => {
    expect(parseSpending(reply((value) => { value.accounts[1]!.limits = null as never; }))?.accounts[1]?.limits).toBeNull();
  });
  it.each([
    ['an extra top-level key', (value: ReturnType<typeof base>) => { Object.assign(value, { email: 'someone@example.com' }); }],
    ['an email on an account', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!, { email: 'someone@example.com' }); }],
    ['an owner id on an account', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!, { ownerId: '10000000-0000-4000-8000-000000000001' }); }],
    ['an approval reference', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!.openAllocations.enhancementProbe, { approvalRef: 'x' }); }],
    ['a total that is not the sum', (value: ReturnType<typeof base>) => { value.accounts[0]!.history[0]!.analysis.totalMicro = '1'; }],
    ['a fractional amount', (value: ReturnType<typeof base>) => { value.accounts[0]!.history[0]!.stylist.confirmedMicro = '1.5'; }],
    ['an ascending month list', (value: ReturnType<typeof base>) => { value.months.reverse(); }],
    ['a history month out of step', (value: ReturnType<typeof base>) => { value.accounts[0]!.history[1]!.month = '2026-07'; }],
    ['a current period other than the first month', (value: ReturnType<typeof base>) => { value.accounts[0]!.current.period = '2026-08'; }],
    ['the v1 try-on placeholder', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!.history[0]!, { tryOn: { available: false } }); }],
    ['a try-on total that is not the sum', (value: ReturnType<typeof base>) => { value.accounts[0]!.history[1]!.tryOn.totalMicro = '1'; }],
    ['a missing try-on probe allocation', (value: ReturnType<typeof base>) => { delete (value.accounts[0]!.openAllocations as Partial<typeof value.accounts[0]['openAllocations']>).tryOnProbe; }],
    ['a try-on probe reference', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!.openAllocations.tryOnProbe, { requestId: 'x' }); }],
    ['an extra limit', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!.limits, { maxSteps: 3 }); }],
    ['a missing try-on flag', (value: ReturnType<typeof base>) => { delete (value.accounts[0]!.features as Partial<typeof value.accounts[0]['features']>).tryOn; }],
    ['a missing try-on current use', (value: ReturnType<typeof base>) => { delete (value.accounts[0]!.current as Partial<typeof value.accounts[0]['current']>).tryOn; }],
    ['accounts out of order', (value: ReturnType<typeof base>) => { value.accounts.reverse(); }],
    ['a third account', (value: ReturnType<typeof base>) => { value.accounts.push(account(2)); }],
    ['a short account version', (value: ReturnType<typeof base>) => { value.accounts[0]!.accountVersion = 'abc'; }],
  ])('refuses %s', (_, change) => {
    expect(parseSpending(reply(change))).toBeNull();
  });
  it('sums the four features for the total row', () => {
    const month = parseSpending(base())!.accounts[0]!.history[0]!;
    expect(monthTotals(month)).toEqual({ confirmedMicro: '241200', estimatedMicro: '5140', reservedMicro: '4457351', totalMicro: '4703691', requests: 6 });
  });
});

describe('admin write reply', () => {
  it('reads each documented result', () => {
    expect(parseWriteResult({ code: 'OK', limits: limits(), belowUse: true })).toEqual({ code: 'OK', limits: limits(), belowUse: true });
    expect(parseWriteResult({ code: 'UNCHANGED', limits: limits() })?.code).toBe('UNCHANGED');
    expect(parseWriteResult({ code: 'CONFLICT' })).toEqual({ code: 'CONFLICT', limits: null });
    expect(parseWriteResult({ code: 'CONFLICT', limits: limits() })).toEqual({ code: 'CONFLICT', limits: limits() });
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'APP_LIMIT' }))
      .toEqual({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'APP_LIMIT' });
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'NOT_POSITIVE' }))
      .toEqual({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'NOT_POSITIVE' });
    for (const code of ['UNAVAILABLE', 'UNCONFIGURED', 'INVALID_INPUT']) expect(parseWriteResult({ code })).toEqual({ code });
  });
  it('refuses anything else, including the retired per-feature shape and reasons', () => {
    expect(parseWriteResult({ code: 'OK', limits: limits() })).toBeNull();
    const retired = { shared: { monthlyAllowanceMicro: '1', maxRequestMicro: '1', maxRequestsPerHour: 1 } };
    expect(parseWriteResult({ code: 'OK', limits: retired, belowUse: false })).toBeNull();
    expect(parseWriteResult({ code: 'UNAVAILABLE', target: 2 })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'shared.email', reason: 'APP_LIMIT' })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'stylist.maxRequestMicro', reason: 'NOT_POSITIVE' })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'RANGE' })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'FORMAT' })).toBeNull();
    expect(parseWriteResult({ code: 'CONFLICT', limits: { shared: {} } })).toBeNull();
    expect(parseWriteResult(null)).toBeNull();
  });
});

describe('exact micro-USD', () => {
  it.each([['4097351', '4.097351', '4,097351'], ['129360', '0.12936', '0,12936'], ['50000000', '50', '50'], ['1', '0.000001', '0,000001'], ['0', '0', '0']])(
    'round-trips %s', (micro, en, fi) => {
      expect(microToInput(micro, 'en')).toBe(en);
      expect(microToInput(micro, 'fi')).toBe(fi);
      expect(inputToMicro(en, 'en')).toBe(micro);
      expect(inputToMicro(fi, 'fi')).toBe(micro);
      expect(inputToMicro(fi, 'sv')).toBe(micro);
    });
  it('parses typed amounts without floating point', () => {
    expect(inputToMicro(' 20.5 ', 'en')).toBe('20500000');
    expect(inputToMicro('0.1', 'en')).toBe('100000');
    expect(inputToMicro('0.3', 'fi')).toBe('300000');
    expect(inputToMicro('999999.999999', 'en')).toBe('999999999999');
  });
  it.each(['', '1,5', '1.1234567', '-1', '1e3', '1 000', '.5', '5.', '1234567', 'NaN', '0x10'])('refuses %j in English', (text) => {
    expect(inputToMicro(text, 'en')).toBeNull();
  });
  it('shows exact amounts with 2 to 6 decimals', () => {
    expect(formatUsd('4097351', 'en')).toBe('$4.097351');
    expect(formatUsd('129360', 'en')).toBe('$0.12936');
    expect(formatUsd('50000000', 'en')).toBe('$50.00');
    expect(formatUsd('999999999999', 'en')).toBe('$999,999.999999');
    expect(formatUsd('4097351', 'fi').replace(/\s/g, ' ')).toBe('4,097351 $');
    expect(() => formatUsd('1.5', 'en')).toThrow();
  });

  it('rounds to cents half-up for display only, from the exact micro amount', () => {
    expect(formatUsdCents('1779407', 'en')).toBe('$1.78');
    expect(formatUsdCents('1785000', 'en')).toBe('$1.79');
    expect(formatUsdCents('1784999', 'en')).toBe('$1.78');
    expect(formatUsdCents('5000', 'en')).toBe('$0.01');
    expect(formatUsdCents('4999', 'en')).toBe('$0.00');
    expect(formatUsdCents('0', 'en')).toBe('$0.00');
    expect(formatUsdCents('20000000', 'en')).toBe('$20.00');
    expect(formatUsdCents('999999995000', 'en')).toBe('$1,000,000.00');
    expect(formatUsdCents('1785000', 'fi').replace(/\s/g, ' ')).toBe('1,79 $');
    expect(formatUsdCents('1785000', 'sv').replace(/\s/g, ' ')).toBe('1,79 $');
    // The exact value is untouched.
    expect(formatUsd('1785000', 'en')).toBe('$1.785');
    expect(() => formatUsdCents('1.5', 'en')).toThrow();
  });
});

describe('budget form', () => {
  it('starts from the exact amount and reads it back unchanged', () => {
    expect(draftOf(limits(), 'en')).toBe('20');
    expect(draftOf({ monthlyAllowanceMicro: '4097351' }, 'fi')).toBe('4,097351');
    expect(limitsFromDraft(draftOf(limits(), 'en'), 'en')).toEqual({ limits: limits(), errors: {} });
  });
  it('treats a retyped equal value as no change', () => {
    const result = limitsFromDraft('20.000000', 'en');
    expect(sameLimits(result.limits!, limits())).toBe(true);
  });
  it('reports a format problem on the one field', () => {
    for (const text of ['lots', '', '1.5.5', '-3']) {
      expect(limitsFromDraft(text, 'en')).toEqual({ limits: null, errors: { monthlyAllowanceMicro: 'FORMAT' } });
    }
  });
  it('accepts any positive amount up to exactly USD 50, including one below current use', () => {
    expect(limitsFromDraft('50', 'en').limits).toEqual({ monthlyAllowanceMicro: '50000000' });
    expect(limitsFromDraft('0.000001', 'en').limits).toEqual({ monthlyAllowanceMicro: '1' });
    expect(limitsFromDraft('50.000001', 'en')).toEqual({ limits: null, errors: { monthlyAllowanceMicro: 'APP_LIMIT' } });
    expect(limitsFromDraft('0', 'en')).toEqual({ limits: null, errors: { monthlyAllowanceMicro: 'NOT_POSITIVE' } });
    expect(checkLimits({ monthlyAllowanceMicro: '50000000' })).toEqual({});
    expect(checkLimits({ monthlyAllowanceMicro: '50000001' })).toEqual({ monthlyAllowanceMicro: 'APP_LIMIT' });
    expect(checkLimits({ monthlyAllowanceMicro: '0' })).toEqual({ monthlyAllowanceMicro: 'NOT_POSITIVE' });
  });
  it('says when the use already passes the budget', () => {
    expect(belowUse({ monthlyAllowanceMicro: '1000000' }, '1000001')).toBe(true);
    expect(belowUse({ monthlyAllowanceMicro: '1000000' }, '1000000')).toBe(false);
    expect(belowUse({ monthlyAllowanceMicro: '20000000' }, '4102191')).toBe(false);
  });
});

type Call = { name: string; args: unknown; headers: Record<string, string> };
function fakeClient(result: { data?: unknown; error?: unknown }, calls: Call[] = []) {
  return {
    rpc: (name: string, args?: unknown) => {
      const call: Call = { name, args, headers: {} };
      calls.push(call);
      const builder = {
        setHeader(key: string, value: string) { call.headers[key] = value; return builder; },
        abortSignal: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
      };
      return builder;
    },
  } as unknown as AppClient;
}
const scope = (): OwnerScope => ({ ownerId: '10000000-0000-4000-8000-000000000001', epoch: 1, signal: new AbortController().signal });

describe('admin data', () => {
  it('reads admin status', async () => {
    const signal = new AbortController().signal;
    await expect(readAdminStatus(fakeClient({ data: { code: 'OK' } }), scope(), signal)).resolves.toBe(true);
    await expect(readAdminStatus(fakeClient({ data: { code: 'UNAVAILABLE' } }), scope(), signal)).resolves.toBe(false);
    await expect(readAdminStatus(fakeClient({ error: { code: 'PGRST202' } }), scope(), signal)).resolves.toBe(false);
    await expect(readAdminStatus(fakeClient({ data: { code: 'OK', admin: true } }), scope(), signal)).rejects.toThrow();
    await expect(readAdminStatus(fakeClient({ error: { code: '57014' } }), scope(), signal)).rejects.toThrow();
  });
  it('asks for the chosen number of months under the budget contract', async () => {
    const calls: Call[] = [];
    months = monthsBack(6);
    const six = base();
    months = monthsBack(2);
    const read = await readAdminSpending(fakeClient({ data: six }, calls), scope(), 6, new AbortController().signal);
    expect(read.kind).toBe('ok');
    expect(calls).toEqual([{ name: 'admin_ai_spending_v2', args: { p_months: 6 }, headers: { 'X-Stillroom-AI-Budget-Contract': '2' } }]);
    await expect(readAdminSpending(fakeClient({ data: { code: 'UNAVAILABLE' } }), scope(), 6, new AbortController().signal)).resolves.toEqual({ kind: 'unavailable' });
  });
  it('refuses a reply with a different number of months', async () => {
    await expect(readAdminSpending(fakeClient({ data: base() }), scope(), 12, new AbortController().signal)).rejects.toThrow();
  });
  it('sends a reason only when chosen, always under the budget contract and with the one amount', async () => {
    const calls: Call[] = [];
    const client = fakeClient({ data: { code: 'OK', limits: limits(), belowUse: false } }, calls);
    const write = { admissionNo: 2 as const, accountVersion: 'b'.repeat(64), expected: limits(), limits: { monthlyAllowanceMicro: '25000000' } };
    await writeAdminLimits(client, scope(), { ...write, reason: null }, new AbortController().signal);
    await writeAdminLimits(client, scope(), { ...write, reason: 'PAUSE' }, new AbortController().signal);
    expect(calls.map((call) => call.name)).toEqual(['admin_set_ai_limits_v2', 'admin_set_ai_limits_v2']);
    expect(calls.map((call) => call.headers)).toEqual([{ 'X-Stillroom-AI-Budget-Contract': '2' }, { 'X-Stillroom-AI-Budget-Contract': '2' }]);
    expect(calls.map((call) => Object.keys(call.args as object))).toEqual([
      ['p_admission_no', 'p_account_version', 'p_expected', 'p_limits'], ['p_admission_no', 'p_account_version', 'p_expected', 'p_limits', 'p_reason_code']]);
    expect((calls[0]!.args as { p_limits: unknown }).p_limits).toEqual({ monthlyAllowanceMicro: '25000000' });
  });
  it('stops when the owner scope ends', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readAdminStatus(fakeClient({ data: { code: 'OK' } }), { ...scope(), signal: controller.signal }, new AbortController().signal)).rejects.toThrow();
  });
});
