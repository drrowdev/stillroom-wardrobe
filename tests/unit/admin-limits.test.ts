import { describe, expect, it } from 'vitest';
import {
  checkLimits, draftOf, formatUsd, inputToMicro, limitChanges, limitsFromDraft, microToInput, monthTotals, parseSpending, parseWriteResult,
  sameLimits, type Limits,
} from '../../src/domain/admin-limits';
import { readAdminSpending, readAdminStatus, writeAdminLimits } from '../../src/data/admin';
import type { AppClient } from '../../src/data/client';
import type { OwnerScope } from '../../src/auth/session';
import { parseSpending as parseSpendingV1 } from '../fixtures/admin-limits-v1';

const spend = (confirmed = '0', estimated = '0', reserved = '0', requests = 0) => ({ confirmedMicro: confirmed, estimatedMicro: estimated,
  reservedMicro: reserved, totalMicro: String(BigInt(confirmed) + BigInt(estimated) + BigInt(reserved)), requests });
const limits = (): Limits => ({
  shared: { monthlyAllowanceMicro: '20000000', maxRequestMicro: '4097351', maxRequestsPerHour: 30 },
  stylist: { monthlyAllowanceMicro: '5000000', maxRequestMicro: '129360', maxRequestsPerHour: 20 },
  enhancement: { monthlyAllowanceMicro: null, maxRequestMicro: null, maxRequestsPerHour: null },
  tryOn: { monthlyAllowanceMicro: '8000000', maxRequestMicro: '360000', maxRequestsPerHour: 6 },
});
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
    current: { period: '2026-09', shared: { usedMicro: '4102191', lastHour: 2 }, analysis: { usedMicro: '4097351', lastHour: 1 },
      stylist: { usedMicro: '4840', lastHour: 1 }, enhancement: { usedMicro: '0', lastHour: 0 }, tryOn: { usedMicro: '600000', lastHour: 1 } },
    openAllocations: { enhancementProbe: { count: 0, allocationMicro: '0', maxCalls: 0 }, tryOnProbe: { count: 1, allocationMicro: '1800000', maxCalls: 5 } },
  };
}
const reply = (extra: (value: ReturnType<typeof base>) => void = () => undefined) => { const value = base(); extra(value); return value; };
function base() { return { code: 'OK', asOf: 1_790_000_000_000, months: [...months], accounts: [account(1), account(2)] }; }

describe('admin spending reply', () => {
  it('accepts the documented shape', () => {
    const parsed = parseSpending(base());
    expect(parsed?.accounts.map((entry) => entry.admissionNo)).toEqual([1, 2]);
    expect(parsed?.accounts[0]?.history[0]?.analysis.reservedMicro).toBe('4097351');
    expect(parsed?.accounts[0]?.probe).toEqual({ count: 0, allocationMicro: '0', maxCalls: 0 });
    expect(parsed?.accounts[0]?.tryOnProbe).toEqual({ count: 1, allocationMicro: '1800000', maxCalls: 5 });
    expect(parsed?.accounts[0]?.history[0]?.tryOn).toEqual(spend('240000', '0', '360000', 2));
    expect(parsed?.accounts[0]?.current.tryOn).toEqual({ usedMicro: '600000', lastHour: 1 });
    expect(parsed?.accounts[0]?.limits?.tryOn).toEqual(limits().tryOn);
    expect(parsed?.accounts[0]?.features.tryOn).toEqual({ configured: true, activated: false });
  });
  it('is not the v1 reply: each parser refuses the other version', () => {
    const v1 = reply((value) => { for (const entry of value.accounts) {
      const shape = entry as Record<string, unknown> & typeof entry;
      delete (shape.features as Record<string, unknown>).tryOn;
      delete (shape.limits as Record<string, unknown>).tryOn;
      delete (shape.current as Record<string, unknown>).tryOn;
      delete (shape.openAllocations as Record<string, unknown>).tryOnProbe;
      for (const month of shape.history) Object.assign(month, { tryOn: { available: false } });
    } });
    expect(parseSpendingV1(v1)).not.toBeNull();
    expect(parseSpending(v1)).toBeNull();
    expect(parseSpendingV1(base())).toBeNull();
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
    ['an extra try-on limit', (value: ReturnType<typeof base>) => { Object.assign(value.accounts[0]!.limits.tryOn, { maxSteps: 3 }); }],
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
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'stylist.maxRequestMicro', reason: 'BELOW_RESERVATION' }))
      .toEqual({ code: 'INVALID_LIMITS', field: 'stylist.maxRequestMicro', reason: 'BELOW_RESERVATION' });
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'tryOn.maxRequestMicro', reason: 'BELOW_RESERVATION' }))
      .toEqual({ code: 'INVALID_LIMITS', field: 'tryOn.maxRequestMicro', reason: 'BELOW_RESERVATION' });
    for (const code of ['UNAVAILABLE', 'UNCONFIGURED', 'INVALID_INPUT']) expect(parseWriteResult({ code })).toEqual({ code });
  });
  it('refuses anything else', () => {
    expect(parseWriteResult({ code: 'OK', limits: limits() })).toBeNull();
    const v1Limits: Partial<Limits> = limits();
    delete v1Limits.tryOn;
    expect(parseWriteResult({ code: 'OK', limits: v1Limits, belowUse: false })).toBeNull();
    expect(parseWriteResult({ code: 'UNAVAILABLE', target: 2 })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'shared.email', reason: 'RANGE' })).toBeNull();
    expect(parseWriteResult({ code: 'INVALID_LIMITS', field: 'shared.maxRequestMicro', reason: 'FORMAT' })).toBeNull();
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
});

describe('limits form', () => {
  it('sends untouched fields exactly as read and keeps nulls', () => {
    const current = limits();
    const initial = draftOf(current, 'en');
    expect(initial.enhancement).toEqual({ monthlyAllowanceMicro: '', maxRequestMicro: '', maxRequestsPerHour: '' });
    expect(limitsFromDraft(initial, initial, current, 'en')).toEqual({ limits: current, errors: {} });
    const draft = { ...initial, stylist: { ...initial.stylist, maxRequestsPerHour: '25' } };
    const result = limitsFromDraft(draft, initial, current, 'en');
    expect(result.limits).toEqual({ ...current, stylist: { ...current.stylist, maxRequestsPerHour: 25 } });
    expect(limitChanges(current, result.limits!)).toEqual([{ feature: 'stylist', key: 'maxRequestsPerHour', from: 20, to: 25 }]);
  });
  it('treats a retyped equal value as no change', () => {
    const current = limits();
    const initial = draftOf(current, 'en');
    const draft = { ...initial, shared: { ...initial.shared, monthlyAllowanceMicro: '20.000000' } };
    const result = limitsFromDraft(draft, initial, current, 'en');
    expect(sameLimits(result.limits!, current)).toBe(true);
  });
  it('reports each field problem against its field', () => {
    const current = limits();
    const initial = draftOf(current, 'en');
    const draft = { ...initial, shared: { ...initial.shared, monthlyAllowanceMicro: 'lots', maxRequestsPerHour: '1.5' } };
    expect(limitsFromDraft(draft, initial, current, 'en').errors).toEqual({ 'shared.monthlyAllowanceMicro': 'FORMAT', 'shared.maxRequestsPerHour': 'RANGE' });
    const typed = { ...initial, enhancement: { monthlyAllowanceMicro: '5', maxRequestMicro: '', maxRequestsPerHour: '' } };
    expect(limitsFromDraft(typed, initial, current, 'en').limits?.enhancement).toEqual(current.enhancement);
  });
  it('checks the app limit at exactly USD 50', () => {
    const at = limits(); at.shared.monthlyAllowanceMicro = '50000000';
    const over = limits(); over.shared.monthlyAllowanceMicro = '50000001';
    expect(checkLimits(at)).toEqual({});
    expect(checkLimits(over)).toEqual({ 'shared.monthlyAllowanceMicro': 'APP_LIMIT' });
  });
  it('checks the clamps and hourly bounds', () => {
    const value = limits();
    value.stylist.monthlyAllowanceMicro = '20000001';
    value.stylist.maxRequestMicro = '20000002';
    value.shared.maxRequestMicro = '20000001';
    value.shared.maxRequestsPerHour = 1001;
    value.stylist.maxRequestsPerHour = 0;
    expect(checkLimits(value)).toEqual({ 'stylist.monthlyAllowanceMicro': 'ABOVE_SHARED', 'stylist.maxRequestMicro': 'ABOVE_MONTHLY',
      'shared.maxRequestMicro': 'ABOVE_MONTHLY', 'shared.maxRequestsPerHour': 'RANGE', 'stylist.maxRequestsPerHour': 'RANGE' });
    const edges = limits(); edges.shared.maxRequestsPerHour = 1000; edges.stylist.maxRequestsPerHour = 1;
    edges.stylist.monthlyAllowanceMicro = '20000000'; edges.stylist.maxRequestMicro = '20000000';
    expect(checkLimits(edges)).toEqual({});
    const zero = limits(); zero.stylist.maxRequestMicro = '0';
    expect(checkLimits(zero)).toEqual({ 'stylist.maxRequestMicro': 'NOT_POSITIVE' });
  });
  it('checks try-on like the other features', () => {
    const value = limits();
    value.tryOn.monthlyAllowanceMicro = '20000001';
    value.tryOn.maxRequestsPerHour = 1001;
    expect(checkLimits(value)).toEqual({ 'tryOn.monthlyAllowanceMicro': 'ABOVE_SHARED', 'tryOn.maxRequestsPerHour': 'RANGE' });
    const current = limits();
    const initial = draftOf(current, 'fi');
    expect(initial.tryOn).toEqual({ monthlyAllowanceMicro: '8', maxRequestMicro: '0,36', maxRequestsPerHour: '6' });
    const result = limitsFromDraft({ ...initial, tryOn: { ...initial.tryOn, monthlyAllowanceMicro: '6,5' } }, initial, current, 'fi');
    expect(limitChanges(current, result.limits!)).toEqual([{ feature: 'tryOn', key: 'monthlyAllowanceMicro', from: '8000000', to: '6500000' }]);
  });
});

type Call = { name: string; args: unknown };
function fakeClient(result: { data?: unknown; error?: unknown }, calls: Call[] = []) {
  return { rpc: (name: string, args?: unknown) => { calls.push({ name, args }); return { abortSignal: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }) }; } } as unknown as AppClient;
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
  it('asks for the chosen number of months', async () => {
    const calls: Call[] = [];
    months = monthsBack(6);
    const six = base();
    months = monthsBack(2);
    const read = await readAdminSpending(fakeClient({ data: six }, calls), scope(), 6, new AbortController().signal);
    expect(read.kind).toBe('ok');
    expect(calls).toEqual([{ name: 'admin_ai_spending_v2', args: { p_months: 6 } }]);
    await expect(readAdminSpending(fakeClient({ data: { code: 'UNAVAILABLE' } }), scope(), 6, new AbortController().signal)).resolves.toEqual({ kind: 'unavailable' });
  });
  it('refuses a reply with a different number of months', async () => {
    await expect(readAdminSpending(fakeClient({ data: base() }), scope(), 12, new AbortController().signal)).rejects.toThrow();
  });
  it('sends a reason only when chosen', async () => {
    const calls: Call[] = [];
    const client = fakeClient({ data: { code: 'OK', limits: limits(), belowUse: false } }, calls);
    const write = { admissionNo: 2 as const, accountVersion: 'b'.repeat(64), expected: limits(), limits: limits() };
    await writeAdminLimits(client, scope(), { ...write, reason: null }, new AbortController().signal);
    await writeAdminLimits(client, scope(), { ...write, reason: 'PAUSE' }, new AbortController().signal);
    expect(calls.map((call) => call.name)).toEqual(['admin_set_ai_limits_v2', 'admin_set_ai_limits_v2']);
    expect(calls.map((call) => Object.keys(call.args as object))).toEqual([
      ['p_admission_no', 'p_account_version', 'p_expected', 'p_limits'], ['p_admission_no', 'p_account_version', 'p_expected', 'p_limits', 'p_reason_code']]);
  });
  it('stops when the owner scope ends', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readAdminStatus(fakeClient({ data: { code: 'OK' } }), { ...scope(), signal: controller.signal }, new AbortController().signal)).rejects.toThrow();
  });
});
