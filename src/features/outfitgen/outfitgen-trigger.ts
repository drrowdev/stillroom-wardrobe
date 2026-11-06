// OUTFITGEN1b: the automatic triggers. This file sits in the initial chunk and holds timers only; the store and the
// runner load lazily when a trigger fires. A Save never waits for it, and a trigger that finds no consent does nothing.
import type { OwnerScope } from '../../auth/session';
import type { OutfitGenLanguage } from '../../domain/outfitgen';

/** A save waits this long for more saves before one run starts; the app-open run waits for the first screen to settle. */
export const SAVE_DELAY_MS = 90_000;
export const OPEN_DELAY_MS = 4_000;

export type OutfitGenRunner = { run: (language: OutfitGenLanguage) => Promise<void> };
type Load = () => Promise<OutfitGenRunner | null>;

export class OutfitGenTrigger {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private disposed = false;
  constructor(scope: OwnerScope, private readonly load: Load, private readonly language: () => OutfitGenLanguage,
    private readonly delays: { save: number; open: number } = { save: SAVE_DELAY_MS, open: OPEN_DELAY_MS }) {
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.disposed = true;
  }
  /** A garment was saved. Further saves restart the wait, so several saves in a row make one run. */
  noteSaved() {
    if (this.disposed) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.fire(); }, this.delays.save);
  }
  /** Once per owner scope, a few seconds after the app opens. Coming back to the app later does not start another. */
  appOpen() {
    if (this.disposed || this.opened) return;
    this.opened = true;
    this.openTimer = setTimeout(() => { this.openTimer = null; void this.fire(); }, this.delays.open);
  }
  dispose() {
    this.disposed = true;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.saveTimer = this.openTimer = null;
  }
  private async fire() {
    if (this.disposed) return;
    try {
      const runner = await this.load();
      if (runner && !this.disposed) await runner.run(this.language());
    } catch { /* a trigger never surfaces an error */ }
  }
}
