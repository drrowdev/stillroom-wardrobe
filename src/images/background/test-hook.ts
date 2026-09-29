// Browser-test controls for background removal. Only the `browser-test` build reads them; in any other build
// `testHook()` is the constant `null` and the bundler drops every use.
export type BackgroundTestHook = {
  enabled?: boolean;
  limits?: Partial<{ stallMs: number; totalMs: number; waitMs: number; startMs: number; loadMs: number; runMs: number }>;
  /** Replaces the model's answer inside the worker; 'model' (the default) runs the real network. */
  /** 'two' is two separate regions of the same size, as for two garments side by side (BG2c ambiguous crop). */
  mask?: 'model' | 'left' | 'centre' | 'two' | 'constant' | 'nan' | 'shape' | 'empty';
  /** Makes one worker step fail or never answer. */
  fault?: 'load' | 'run' | 'hang-start' | 'hang-load' | 'hang-run';
  /** Extra delay before the worker answers `run`, in milliseconds. */
  runDelayMs?: number;
  log?: Array<Record<string, number | string>>;
};

declare global { interface Window { __stillroomBackground?: BackgroundTestHook } }

export function testHook(): BackgroundTestHook | null {
  if (import.meta.env.MODE !== 'browser-test') return null;
  return typeof window === 'undefined' ? null : window.__stillroomBackground ?? null;
}

/** Whether new photos get automatic background removal. Browser-test builds opt in per test. */
export function removalEnabled(): boolean {
  if (import.meta.env.MODE === 'browser-test') return testHook()?.enabled === true;
  return true;
}

/** Browser tests read what happened to each photo as numbers and outcomes, never as pixels. */
export function backgroundTestLog(entry: Record<string, number | string>): void {
  const hook = testHook();
  if (hook) (hook.log ??= []).push(entry);
}
