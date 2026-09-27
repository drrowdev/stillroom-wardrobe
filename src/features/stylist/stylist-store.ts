// The stylist conversation and status for one owner scope, kept in memory only. This file sits in the initial chunk,
// so it holds state and nothing else; reading, writing and sending live in the lazily loaded `use-stylist.ts`.
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { PublicConfig } from '../../data/config';
import type { StylistClient } from '../../data/stylist';
import type { StylistOccasion, StylistSeason, StylistWeather } from '../../domain/stylist';
import type { StylistIdea, StylistRead, StylistStatus } from '../../domain/stylist-controls';
import type { MessageKey } from '../../i18n';

export type StylistEntry = { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string; outfits: StylistIdea[]; occasion: StylistOccasion; season: StylistSeason | null;
    weather: StylistWeather | null };
export type StylistNotice = { key: MessageKey; retry: boolean; count?: number };
export type StylistState = {
  read: StylistRead;
  /** A shown state has been read in this scope, so a later failure offers Try again rather than hiding. */ known: boolean;
  /** A consent change whose outcome is unknown; only a later successful read settles it. */ unresolved: boolean;
  reading: boolean; writing: boolean; settingsError: MessageKey | null;
  turns: readonly StylistEntry[]; pending: string | null; draft: string; occasion: StylistOccasion;
  error: StylistNotice | null; announce: { key: MessageKey; at: number } | null; generation: number;
};
const initial: StylistState = {
  read: { kind: 'unknown' }, known: false, unresolved: false, reading: false, writing: false, settingsError: null,
  turns: [], pending: null, draft: '', occasion: 'everyday', error: null, announce: null, generation: 0,
};

export class StylistStore {
  private state: StylistState = initial;
  private readonly listeners = new Set<() => void>();
  // Ordering, used by use-stylist.ts. Reads and consent writes share one sequence, apart from the conversation generation.
  seq = 0;
  applied = 0;
  lastWrite = 0;
  readPromise: Promise<StylistStatus | null> | null = null;
  /** Set while a consent write runs; reads wait for it. */
  writePromise: Promise<void> | null = null;
  inflight: { token: number; controller: AbortController } | null = null;
  token = 0;
  nextId = 0;
  busy = false;
  deferred = false;
  disposed = false;
  api: StylistClient | null = null;
  onIdle: (() => void) | null = null;
  constructor(readonly client: AppClient, readonly config: PublicConfig, readonly scope: OwnerScope) {
    scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
    if (scope.signal.aborted) this.dispose();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;
  update(patch: Partial<StylistState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Profile, language, weather and photo-analysis writes hold the profile row, so status reads wait until they finish. */
  setBusy(busy: boolean) {
    this.busy = busy;
    if (!busy && this.deferred && !this.disposed) { this.deferred = false; this.onIdle?.(); }
  }
  /** Ends the scope: the conversation and status are wiped and everything outstanding is invalidated. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.inflight?.controller.abort();
    this.inflight = null;
    this.readPromise = null;
    this.deferred = false;
    this.onIdle = null;
    this.lastWrite = ++this.seq;
    this.token++;
    this.state = { ...initial, generation: this.state.generation + 1 };
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
