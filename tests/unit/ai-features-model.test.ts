import { describe, expect, it } from 'vitest';
import type { AiStatus } from '../../src/domain/ai-controls';
import { enhanceView } from '../../src/domain/enhance-controls';
import { stylistView } from '../../src/domain/stylist-controls';
import { tryOnView } from '../../src/data/tryon';
import {
  analysisFigures, featureSwitch, MAX_CHECK_DELAY_MS, nextPeriodStart, sharedFigures, spendPercent, SpendTracker, utcPeriod,
  type SpendFigures,
} from '../../src/features/settings/ai-features-model';

const MAR_1 = Date.UTC(2026, 2, 1);
const MAR_10 = Date.UTC(2026, 2, 10, 12);
const APR_1 = Date.UTC(2026, 3, 1);
const JAN_END = Date.UTC(2026, 1, 1) - 1;
const DEC_END = Date.UTC(2027, 0, 1) - 1;
const figures = (usedMicro: string, limitMicro: string, serverTimeMs: number, period?: string): SpendFigures =>
  period === undefined ? { usedMicro, limitMicro, serverTimeMs } : { usedMicro, limitMicro, serverTimeMs, period };
const response = () => ({});

describe('UI1 feature switch', () => {
  it('is present when either action is permitted and checked only when consent is on for the current notice', () => {
    expect(featureSwitch(false, false)).toEqual({ present: false, checked: false });
    expect(featureSwitch(true, false)).toEqual({ present: true, checked: false });
    expect(featureSwitch(false, true)).toEqual({ present: true, checked: true });
    expect(featureSwitch(true, true)).toEqual({ present: true, checked: false });
  });
  it('maps the domain views: on, paused, unavailable and known-on failures are checked; off and renew are not', () => {
    const shared = (view: { turnOn: boolean; turnOff: boolean }) => featureSwitch(view.turnOn, view.turnOff);
    expect(shared(enhanceView({ kind: 'unknown' }, false, false, false))).toEqual({ present: false, checked: false });
    expect(shared(enhanceView({ kind: 'failed' }, false, true, true))).toEqual({ present: true, checked: true });
    expect(shared(enhanceView({ kind: 'failed' }, false, true, false))).toEqual({ present: false, checked: false });
    expect(shared(enhanceView({ kind: 'failed' }, true, true, true))).toEqual({ present: true, checked: true });
    expect(shared(tryOnView({ kind: 'failed' }, true, true, false))).toEqual({ present: false, checked: false });
    expect(shared(tryOnView({ kind: 'missing' }, false, true, true))).toEqual({ present: false, checked: false });
    expect(shared(stylistView({ kind: 'failed' }, true, false))).toEqual({ present: false, checked: false });
    expect(shared(stylistView({ kind: 'unknown' }, true, true))).toEqual({ present: false, checked: false });
    // The state table each view produces.
    for (const [turnOn, turnOff, checked] of [[true, false, false], [true, true, false], [false, true, true]] as const) {
      expect(shared({ turnOn, turnOff })).toEqual({ present: true, checked });
    }
  });
});

describe('UI1 spending figures', () => {
  it('copies the analysis figures with the period its parser keeps, and none without a policy', () => {
    const status = { policy: { monthlyAllowanceMicro: '5000000' }, usage: { accountedMicro: '1200000' }, serverTimeMs: MAR_10,
      period: '2026-03' } as unknown as AiStatus;
    expect(analysisFigures(status)).toEqual({ usedMicro: '1200000', limitMicro: '5000000', serverTimeMs: MAR_10, period: '2026-03' });
    expect(analysisFigures({ ...status, policy: null } as unknown as AiStatus)).toBeNull();
  });
  it('copies the shared total from the other statuses, and none without policy, usage or server time', () => {
    const status = { policy: { totalAllowanceMicro: '5000000' }, usage: { totalMicro: '2500000' }, serverTimeMs: MAR_10 };
    expect(sharedFigures(status as never)).toEqual({ usedMicro: '2500000', limitMicro: '5000000', serverTimeMs: MAR_10 });
    expect(sharedFigures({ ...status, usage: null } as never)).toBeNull();
    expect(sharedFigures({ ...status, policy: null } as never)).toBeNull();
    expect(sharedFigures({ ...status, serverTimeMs: null } as never)).toBeNull();
  });
  it('derives UTC periods and boundaries, including December', () => {
    expect(utcPeriod(JAN_END)).toBe('2026-01');
    expect(utcPeriod(JAN_END + 1)).toBe('2026-02');
    expect(nextPeriodStart('2026-01')).toBe(JAN_END + 1);
    expect(nextPeriodStart('2026-12')).toBe(DEC_END + 1);
  });
  it('fills the bar by share, capped at 100', () => {
    expect(spendPercent('0', '5000000')).toBe(0);
    expect(spendPercent('1234567', '5000000')).toBe(24.6);
    expect(spendPercent('9000000', '5000000')).toBe(100);
  });
});

describe('UI1 spending snapshot', () => {
  it('takes amount, allowance and period from one response, never mixing sources', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('analysis', 1, response(), figures('1000000', '5000000', MAR_10, '2026-03'), 0);
    tracker.observe('stylist', 1, response(), figures('2000000', '6000000', MAR_10 + 5, undefined), 0);
    expect(tracker.snapshot(0, MAR_10 + 5)).toEqual({ source: 'stylist', usedMicro: '2000000', limitMicro: '6000000', period: '2026-03',
      warning: false });
  });
  it('shows nothing without an eligible response, and rejects invalid figures', () => {
    const tracker = new SpendTracker(1, {});
    expect(tracker.snapshot(0, MAR_10)).toBeNull();
    expect(tracker.nextCheckDelay(0, MAR_10)).toBeNull();
    expect(tracker.observe('enhance', 1, response(), figures('1', '0', MAR_10), 0)).toBe(false);
    expect(tracker.observe('enhance', 1, response(), figures('x', '5', MAR_10), 0)).toBe(false);
    expect(tracker.observe('enhance', 1, response(), null, 0)).toBe(false);
    expect(tracker.snapshot(0, MAR_10)).toBeNull();
  });
  it('warns from 80 % of the allowance', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('tryOn', 1, response(), figures('3999999', '5000000', MAR_10), 0);
    expect(tracker.snapshot(0, MAR_10)?.warning).toBe(false);
    tracker.observe('tryOn', 1, response(), figures('4000000', '5000000', MAR_10), 0);
    expect(tracker.snapshot(0, MAR_10)?.warning).toBe(true);
  });
  it('prefers the newer server time whichever reply arrives first, with a fixed tie order', () => {
    const late = new SpendTracker(1, {});
    late.observe('stylist', 1, response(), figures('2', '10', MAR_10 + 1000), 0);
    late.observe('analysis', 1, response(), figures('1', '10', MAR_10, '2026-03'), 10);
    expect(late.snapshot(10, MAR_10 + 1000)?.source).toBe('stylist');
    const early = new SpendTracker(1, {});
    early.observe('analysis', 1, response(), figures('1', '10', MAR_10 + 1000, '2026-03'), 0);
    early.observe('stylist', 1, response(), figures('2', '10', MAR_10), 10);
    expect(early.snapshot(10, MAR_10 + 1000)?.source).toBe('analysis');
    const tie = new SpendTracker(1, {});
    tie.observe('tryOn', 1, response(), figures('4', '10', MAR_10), 0);
    tie.observe('enhance', 1, response(), figures('3', '10', MAR_10), 0);
    tie.observe('stylist', 1, response(), figures('2', '10', MAR_10), 0);
    expect(tie.snapshot(0, MAR_10)?.source).toBe('stylist');
    tie.observe('analysis', 1, response(), figures('1', '10', MAR_10, '2026-03'), 0);
    expect(tie.snapshot(0, MAR_10)?.source).toBe('analysis');
  });
  it('drops a source after a failed refresh and falls back to another, or to nothing', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('analysis', 1, response(), figures('1', '10', MAR_10 + 5, '2026-03'), 0);
    tracker.observe('enhance', 1, response(), figures('3', '10', MAR_10), 0);
    expect(tracker.snapshot(0, MAR_10 + 5)?.source).toBe('analysis');
    expect(tracker.observe('analysis', 1, null, null, 1)).toBe(true);
    expect(tracker.snapshot(1, MAR_10 + 5)?.source).toBe('enhance');
    tracker.observe('enhance', 1, null, null, 2);
    expect(tracker.snapshot(2, MAR_10 + 5)).toBeNull();
  });
  it('never shows a response cached before Settings opened, even when observed again or after a remount', () => {
    const cached = response();
    const tracker = new SpendTracker(1, { stylist: cached });
    expect(tracker.observe('stylist', 1, cached, figures('2', '10', MAR_10), 0)).toBe(false);
    expect(tracker.snapshot(0, MAR_10)).toBeNull();
    // A delayed reply keeps the summary empty until it arrives.
    const fresh = response();
    expect(tracker.observe('stylist', 1, fresh, figures('3', '10', MAR_10 + 60_000), 500)).toBe(true);
    expect(tracker.snapshot(500, MAR_10 + 60_000)?.usedMicro).toBe('3');
    expect(tracker.observe('stylist', 1, fresh, figures('3', '10', MAR_10 + 60_000), 600)).toBe(false);
    // Leaving and returning: the new mount starts from the stores' current objects.
    const remount = new SpendTracker(1, { stylist: fresh });
    remount.observe('stylist', 1, fresh, figures('3', '10', MAR_10 + 60_000), 0);
    expect(remount.snapshot(0, MAR_10 + 60_000)).toBeNull();
  });
  it('drops a response from another owner epoch', () => {
    const tracker = new SpendTracker(2, {});
    expect(tracker.observe('enhance', 1, response(), figures('3', '10', MAR_10), 0)).toBe(false);
    expect(tracker.snapshot(0, MAR_10)).toBeNull();
    expect(tracker.observe('enhance', 2, response(), figures('3', '10', MAR_10), 0)).toBe(true);
  });
  it('rolls over at the last millisecond of the month by monotonic time, including December', () => {
    for (const end of [JAN_END, DEC_END]) {
      const tracker = new SpendTracker(1, {});
      tracker.observe('stylist', 1, response(), figures('2', '10', end), 1000);
      expect(tracker.snapshot(1000, end)?.period).toBe(utcPeriod(end));
      expect(tracker.nextCheckDelay(1000, end)).toBe(1);
      expect(tracker.snapshot(1001, end)).toBeNull();
      // A newer reply from the new month is then chosen.
      tracker.observe('enhance', 1, response(), figures('0', '10', end + 5), 1005);
      expect(tracker.snapshot(1005, end + 5)).toMatchObject({ source: 'enhance', period: utcPeriod(end + 1) });
    }
  });
  it('drops an analysis response whose stated period differs from its server time', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('analysis', 1, response(), figures('1', '10', MAR_10, '2026-02'), 0);
    expect(tracker.snapshot(0, MAR_10)).toBeNull();
  });
  it('re-checks at most daily from early in the month, never past the timer limit, and drops at the boundary', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('stylist', 1, response(), figures('2', '10', MAR_1), 0);
    let mono = 0;
    let previous = Number.POSITIVE_INFINITY;
    const remaining = () => APR_1 - (MAR_1 + mono);
    while (tracker.snapshot(mono, MAR_1 + mono) !== null) {
      const delay = tracker.nextCheckDelay(mono, MAR_1 + mono);
      expect(delay).not.toBeNull();
      expect(delay).toBe(Math.min(remaining(), MAX_CHECK_DELAY_MS));
      expect(delay!).toBeLessThanOrEqual(2_147_483_647);
      expect(remaining()).toBeLessThan(previous);
      previous = remaining();
      mono += delay!;
    }
    expect(MAR_1 + mono).toBe(APR_1);
    expect(tracker.nextCheckDelay(mono, APR_1)).toBeNull();
  });
  it('keeps a wall-clock change from reviving an expired snapshot, and hides early when the clock moves ahead', () => {
    const tracker = new SpendTracker(1, {});
    tracker.observe('stylist', 1, response(), figures('2', '10', MAR_10), 0);
    const pastBoundary = APR_1 - MAR_10;
    expect(tracker.snapshot(pastBoundary, APR_1)).toBeNull();
    expect(tracker.snapshot(pastBoundary, APR_1 - 40 * 86_400_000)).toBeNull();
    const ahead = new SpendTracker(1, {});
    ahead.observe('stylist', 1, response(), figures('2', '10', MAR_10), 0);
    expect(ahead.snapshot(1000, APR_1 + 1)).toBeNull();
    expect(ahead.snapshot(1000, MAR_10 + 1000)).not.toBeNull();
    // The wall clock can also bring the next check forward.
    expect(ahead.nextCheckDelay(0, APR_1 - 10)).toBe(10);
  });
});
