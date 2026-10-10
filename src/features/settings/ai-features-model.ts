// UI1: pure helpers for the AI features card. The spending summary shows one response's figures, and only a response
// that arrived while this Settings page was open, so a figure cached earlier (the stores outlive Settings) is never shown.
import { isMicro, type AiStatus } from '../../domain/ai-controls';
import type { EnhanceStatus } from '../../domain/enhance-controls';
import type { StylistStatus } from '../../domain/stylist-controls';
import type { TryOnStatus } from '../../data/tryon';

export type SpendSource = 'analysis' | 'stylist' | 'enhance' | 'tryOn';
/** Tie order when two responses carry the same server time. */
export const SPEND_ORDER: readonly SpendSource[] = ['analysis', 'stylist', 'enhance', 'tryOn'];
/** The longest single wait before the snapshot is checked again; far below the 2,147,483,647 ms timer limit. */
export const MAX_CHECK_DELAY_MS = 86_400_000;

/** Figures copied from ONE parsed status response. `period` is kept only where the parser keeps it (analysis). */
export type SpendFigures = Readonly<{ usedMicro: string; limitMicro: string; serverTimeMs: number; period?: string }>;
export type SpendSnapshot = Readonly<{ source: SpendSource; usedMicro: string; limitMicro: string; period: string; warning: boolean }>;

function validFigures(figures: SpendFigures | null): figures is SpendFigures {
  return figures !== null && isMicro(figures.usedMicro) && isMicro(figures.limitMicro) && BigInt(figures.limitMicro) > 0n
    && Number.isSafeInteger(figures.serverTimeMs) && figures.serverTimeMs >= 0;
}
/** Analysis: the account's one budget, with the period its parser keeps. None without a budget. */
export function analysisFigures(status: AiStatus): SpendFigures | null {
  return status.budget ? { usedMicro: status.budget.usedMicro, limitMicro: status.budget.monthlyAllowanceMicro,
    serverTimeMs: status.serverTimeMs, period: status.period } : null;
}
/** Stylist, clean-up and try-on: the same one budget. None without a budget or server time. */
export function sharedFigures(status: EnhanceStatus | StylistStatus | TryOnStatus): SpendFigures | null {
  return status.budget && status.serverTimeMs !== null
    ? { usedMicro: status.budget.usedMicro, limitMicro: status.budget.monthlyAllowanceMicro, serverTimeMs: status.serverTimeMs } : null;
}
/** The UTC `YYYY-MM` of a time. */
export function utcPeriod(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
/** The start of the UTC month after `period`, in ms. */
export function nextPeriodStart(period: string): number {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return Date.UTC(year, month, 1);
}

type Candidate = Readonly<{ object: object; figures: SpendFigures; receivedAtMono: number }>;

/**
 * Tracks the latest response of each source during one Settings mount. Objects present at mount are never candidates,
 * even when observed again; the stores replace the status object on every applied read, so a new object is a new
 * response. A failed or missing read removes that source. Times are monotonic (`performance.now()`), so a wall-clock
 * change can't extend a snapshot's life; the wall clock is only used to hide a snapshot early.
 */
export class SpendTracker {
  private readonly initial: Map<SpendSource, object | null>;
  private readonly candidates = new Map<SpendSource, Candidate>();
  constructor(readonly epoch: number, initialObjects: Partial<Record<SpendSource, object | null>>) {
    this.initial = new Map(SPEND_ORDER.map((source) => [source, initialObjects[source] ?? null]));
  }
  /** Returns true when the candidates changed. `object` is null after a failed, missing or not-yet-read status. */
  observe(source: SpendSource, epoch: number, object: object | null, figures: SpendFigures | null, monoNow: number): boolean {
    if (epoch !== this.epoch) return false;
    const current = this.candidates.get(source);
    if (object === null || object === this.initial.get(source) || !validFigures(figures)) return this.candidates.delete(source);
    if (current?.object === object) return false;
    this.candidates.set(source, { object, figures, receivedAtMono: monoNow });
    return true;
  }
  private live(monoNow: number, wallNow: number) {
    const wallPeriod = utcPeriod(wallNow);
    return SPEND_ORDER.flatMap((source) => {
      const candidate = this.candidates.get(source);
      if (!candidate) return [];
      const { figures, receivedAtMono } = candidate;
      const period = utcPeriod(figures.serverTimeMs);
      if (figures.period !== undefined && figures.period !== period) return [];
      const boundary = nextPeriodStart(period);
      const estimated = figures.serverTimeMs + Math.max(0, monoNow - receivedAtMono);
      if (estimated >= boundary || wallPeriod > period) return [];
      return [{ source, figures, period, remaining: boundary - estimated, wallRemaining: boundary - wallNow }];
    });
  }
  /** The newest eligible response still in its month, or null. Amount, allowance and period all come from it. */
  snapshot(monoNow: number, wallNow: number): SpendSnapshot | null {
    let best: ReturnType<SpendTracker['live']>[number] | null = null;
    for (const entry of this.live(monoNow, wallNow)) {
      if (!best || entry.figures.serverTimeMs > best.figures.serverTimeMs) best = entry;
    }
    if (!best) return null;
    const used = BigInt(best.figures.usedMicro), limit = BigInt(best.figures.limitMicro);
    return { source: best.source, usedMicro: best.figures.usedMicro, limitMicro: best.figures.limitMicro, period: best.period,
      warning: used * 5n >= limit * 4n };
  }
  /** How long to wait before checking again, capped at one day; null when nothing is shown. */
  nextCheckDelay(monoNow: number, wallNow: number): number | null {
    const waits = this.live(monoNow, wallNow).flatMap((entry) => [entry.remaining, ...(entry.wallRemaining > 0 ? [entry.wallRemaining] : [])]);
    if (waits.length === 0) return null;
    return Math.min(MAX_CHECK_DELAY_MS, Math.max(0, Math.ceil(Math.min(...waits))));
  }
}

/** The bar's filled share, in percent with one decimal, capped at 100. */
export function spendPercent(usedMicro: string, limitMicro: string): number {
  const limit = BigInt(limitMicro);
  if (limit <= 0n) return 0;
  const tenths = BigInt(usedMicro) * 1000n / limit;
  return Math.min(100, Number(tenths) / 10);
}

/**
 * The row switch. It is shown when the state permits turning on or off, and it is checked only when consent is on for
 * the current notice (Turn off permitted and Turn on not). An unchecked switch opens the consent sheet; nothing is
 * written until its Turn on. It never changes before the server's reply.
 */
export type FeatureSwitch = Readonly<{ present: boolean; checked: boolean }>;
export function featureSwitch(turnOn: boolean, turnOff: boolean): FeatureSwitch {
  return { present: turnOn || turnOff, checked: turnOff && !turnOn };
}
