import type { Session } from '@supabase/supabase-js';
import { authStorageKey, bindDataRequests, heldRecord, unbindDataRequests, type AppClient, type AuthMode, type RevokeResult } from '../data/client';
import { sessionOwner, tokenClaims, type AuthRecord } from './auth-storage';
import type { HeldLock } from './device-lock';
import { openAuthChannels } from './auth-channel';
import { fetchProfile, saveInitialLanguage, updateProfile, type ProfileUpdate } from '../data/profile';
import type { ProfileRow } from '../data/rows';
import { isUuid } from '../domain/wardrobe';
import { resolveLanguage, type Language, type MessageKey } from '../i18n';
import { AppError, isAborted } from '../data/errors';
import { holdsStoredSession } from './stored-session';
import { AiError, type AiClient } from '../data/ai';
import { aiPolicyBinding, supportedAiPolicy, type AiStatus } from '../domain/ai-controls';
import { sameProfileFields } from '../domain/preferences';
import { deletionStatus } from '../data/delete-account';

export type OwnerScope = { ownerId: string; epoch: number; signal: AbortSignal };
export type SessionState = {
  // `deleting`: an unfinished account deletion. The owner scope stays open only for finishing it.
  // `waiting`: credentials are kept but the wardrobe cannot open until the connection returns.
  // `elsewhere`: another window holds the remembered session; this one waits for it to close.
  phase: 'loading' | 'signed-out' | 'ready' | 'locked' | 'deleting' | 'waiting' | 'elsewhere';
  deletion?: 'in_progress' | 'retry' | 'contact';
  language: Language;
  profile: ProfileRow | null;
  scope: OwnerScope | null;
  languageUnsaved: boolean;
  notice?: MessageKey;
  profileSaving?: boolean;
  profileChange?: { kind: 'profile' | 'language' | 'weather' | 'ai' | 'refresh'; previous: ProfileRow };
  aiConsentUnresolved?: boolean;
  // The auth client of the current sign-in generation. Signing out replaces it.
  client: AppClient;
};
type PublishedState = Omit<SessionState, 'client'> & { client?: AppClient };
export { legacyChannelName as logoutKey } from './auth-channel';
/** Creates, retires and revokes auth clients. Each sign-in generation gets its own client. */
export type SessionClients = {
  make(mode?: AuthMode, user?: unknown): AppClient;
  retire(client: AppClient): { record: AuthRecord | null };
  revoke(record: AuthRecord | null): Promise<RevokeResult>;
  /** Closes a client without touching any stored credential. */
  release?(client: AppClient): void;
  /** The lazily loaded staged sign-in and slot cleanup of remembered mode. */
  remembered?(): Promise<Remembered>;
};
/** Remembered mode, loaded only when it is used: `src/auth/remembered.ts`. */
export type Remembered = {
  claim(controller: SessionController): Promise<void>;
  signIn(controller: SessionController, email: string, password: string, remember: boolean): Promise<void>;
  signOutDevice(controller: SessionController): Promise<void>;
  sweepSlot(revoke: (record: AuthRecord) => Promise<unknown>): Promise<void>;
};
/** What this tab can do with the remembered slot. `rejected`: the browser refused a lock request. */
export type LockState = 'available' | 'absent' | 'rejected';
type Recovery = 'open' | 'waiting' | 'locked' | 'expired';

export class SessionController {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private request = new AbortController();
  private epoch = 0;
  private choice: Language | null = null;
  // Members marked internal are also driven by remembered.ts; nothing else uses them.
  /** @internal */ allowSession = true;
  /** @internal */ channels: ReturnType<typeof openAuthChannels> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private expiresAt = 0;
  // Set while a lapsed scope recovers, so an SDK sign-out on a refused refresh shows why.
  private lapsing = false;
  /** The owner whose scope is opening or open, until the next invalidation. */
  private opening: string | null = null;
  private scheduled = new Set<ReturnType<typeof setTimeout>>();
  private aiAckFloor: bigint | null = null;
  private subscription: { unsubscribe(): void } | null = null;
  /** @internal */ started = false;
  private mode: AuthMode = 'tab';
  /** @internal The remembered slot's lock, held only while this tab's session is the remembered one. */
  held: HeldLock | null = null;
  /** @internal */ lock: LockState;
  /** @internal Bumped by every sign-in and sign-out, so a staged sign-in that finishes late is discarded. */
  generation = 0;
  /** @internal Aborts a queued wait for the lock when this controller stops. */
  queue = new AbortController();

  constructor(private client: AppClient, private browserLanguages: readonly string[], /** @internal */ readonly clients?: SessionClients) {
    this.lock = clients?.remembered && typeof navigator.locks?.request === 'function' ? 'available' : 'absent';
    this.state = { phase: 'loading', language: resolveLanguage(browserLanguages), profile: null, scope: null, languageUnsaved: false, client };
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** @internal */
  publish(next: PublishedState): void {
    this.state = { ...next, client: this.client };
    for (const listener of this.listeners) listener();
  }
  private invalidate(): void {
    this.aiAckFloor = null;
    this.epoch++;
    this.request.abort();
    this.opening = null;
    unbindDataRequests(this.client);
    this.disarm();
    for (const timer of this.scheduled) clearTimeout(timer);
    this.scheduled.clear();
  }
  private signedOut(notice?: MessageKey): void {
    // A later signed-out event (such as the next client's empty start) must not hide the sign-out's notice.
    const kept = notice ?? (this.state.phase === 'signed-out' ? this.state.notice : undefined);
    this.invalidate();
    this.choice = null;
    this.publish({
      phase: 'signed-out', language: resolveLanguage(this.browserLanguages),
      profile: null, scope: null, languageUnsaved: false, ...(kept ? { notice: kept } : {}),
    });
  }
  start(): () => void {
    // A received command only ends this tab's own session; it never sends anything on.
    this.channels = openAuthChannels((command) => { void this.endOnCommand(command); });
    // An older release's sign-out clears the whole auth namespace; the holder then ends too, and never writes it back.
    const onStorage = (event: StorageEvent) => {
      if (this.mode === 'device' && event.storageArea === window.localStorage && (event.key === null || event.key === authStorageKey) && !event.newValue) {
        void this.endOnCommand('sign-out');
      }
    };
    window.addEventListener('storage', onStorage);
    const onFocus = () => {
      if (this.checkExpiry()) return;
      if (this.state.phase === 'ready' && isOnline()) void this.checkMembership();
    };
    const onResume = () => { this.checkExpiry(); };
    const onOnline = () => {
      if (this.checkExpiry()) return;
      if (this.state.phase === 'waiting') void this.retry();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onResume);
    document.addEventListener('resume', onResume);
    this.started = true;
    this.queue = new AbortController();
    // Only a slot can have a holder: without one, nothing waits for the lock at start-up.
    if (this.clients?.remembered && this.lock === 'available' && !heldRecord(this.client) && window.localStorage.getItem(authStorageKey) !== null) {
      void this.clients.remembered().then((remembered) => remembered.claim(this), () => this.settle());
    } else this.watch(this.client);
    return () => {
      this.started = false;
      this.queue.abort();
      this.held?.release();
      this.held = null;
      window.removeEventListener('storage', onStorage);
      this.subscription?.unsubscribe();
      this.subscription = null;
      this.channels?.close();
      this.channels = null;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onResume);
      document.removeEventListener('resume', onResume);
      this.invalidate();
    };
  }
  private watch(client: AppClient): void {
    // A credential that was already past its expiry when this client started, which the SDK then could not renew.
    const initial = heldRecord(client);
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // A retired client's late events belong to a finished generation.
      if (client !== this.client) return;
      if (event === 'SIGNED_OUT' || !session) {
        // The SDK relays other tabs' sign-outs; this tab ends only when its own store no longer holds a session.
        if (heldRecord(client)) {
          if (event === 'INITIAL_SESSION' && this.allowSession) this.unavailable(isOnline() ? 'locked' : 'waiting');
          return;
        }
        // The SDK may drop a refused credential before this tab's own deadline fires.
        const lapsed = this.lapsing || (this.expiresAt > 0 && Date.now() >= this.expiresAt) || (initial !== null && initial.expires_at * 1000 <= Date.now());
        this.signedOut(lapsed ? 'auth.expired' : undefined);
        return;
      }
      if (!this.allowSession || !this.holdsSession(session)) return;
      const owner = sessionOwner(session);
      if (owner === null) { void this.end(false); return; }
      const scope = this.state.scope;
      if (scope && scope.ownerId !== owner) {
        // Another owner's credential: nothing of the old scope may run or show while the new one opens.
        this.invalidate();
        this.publish({ phase: 'loading', language: resolveLanguage(this.browserLanguages, null, this.choice), profile: null, scope: null, languageUnsaved: false });
      } else if ((scope?.ownerId === owner && !scope.signal.aborted && (this.state.phase === 'ready' || this.state.phase === 'deleting'))
        || (this.opening === owner && !this.request.signal.aborted)) {
        // The same owner's renewed credential carries an open or loading scope on, but only if it came before the old
        // deadline. A renewal that arrives late (the page's timer was throttled) ends the old scope first; recovery
        // then reopens with the renewed session under a new epoch.
        if (this.checkExpiry()) return;
        this.arm(session);
        return;
      }
      // Supabase holds its auth lock during this callback; data requests must run after it returns.
      const epoch = this.epoch;
      const timer = setTimeout(() => {
        this.scheduled.delete(timer);
        // By now the store may hold another session; only the one still held may open.
        if (epoch === this.epoch && this.allowSession && client === this.client && this.holdsSession(session)
          && this.heldOwner() === owner) void this.open(session);
      }, 0);
      this.scheduled.add(timer);
    });
    this.subscription = data.subscription;
  }
  /** @internal Shows this tab's own state: its client's first event, or signed out if that client is already watched. */
  settle(): void {
    if (!this.started) return;
    if (this.subscription) this.signedOut();
    else this.watch(this.client);
  }
  /** @internal Replaces the live client without touching any stored credential; the new one reads its store afresh. */
  switchClient(mode: AuthMode, user?: unknown): void {
    const clients = this.clients!;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.invalidate();
    (clients.release ?? clients.retire)(this.client);
    this.mode = mode;
    this.client = clients.make(mode, user);
    if (this.started) this.watch(this.client);
  }
  /** Shown on the sign-in screen: remember is offered only once this tab can take the slot's lock. */
  get canRemember(): boolean { return this.lock === 'available'; }
  /** A slot this tab cannot adopt, which only a sign-out of the device removes. */
  get deviceSlot(): boolean {
    return Boolean(this.clients?.remembered) && this.lock !== 'available' && window.localStorage.getItem(authStorageKey) !== null;
  }
  // Each client holds its session in its own store. The SDK also broadcasts sign-ins
  // and refreshes between tabs; a tab must ignore any session it does not hold.
  private holdsSession(session: Session): boolean {
    return holdsStoredSession((this.mode === 'device' ? window.localStorage : window.sessionStorage).getItem(authStorageKey), session.access_token);
  }
  /** The owner of the credential this tab's client holds right now. */
  private heldOwner(): string | null {
    return sessionOwner(heldRecord(this.client));
  }
  /** Lapses the open scope when the held access token's real expiry passes. */
  private arm(session: Session): void {
    this.disarm();
    const expiry = expiryOf(session);
    if (expiry === null) return;
    this.expiresAt = expiry;
    // Long delays are clamped by browsers; the resume checks cover a suspended page.
    this.deadline = setTimeout(() => { this.deadline = null; this.checkExpiry(); }, Math.min(Math.max(0, this.expiresAt - Date.now()), 2_147_000_000));
  }
  private disarm(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.expiresAt = 0;
  }
  /**
   * True when the scope lapsed. The scope counts from the moment open() binds it, through loading, ready and an
   * unfinished deletion. At the held access token's expiry its requests, private state and images end at once; only
   * a renewal that arrived before the deadline (which re-arms it) keeps the scope.
   */
  private checkExpiry(): boolean {
    if (!this.expiresAt || Date.now() < this.expiresAt || this.opening === null) return false;
    this.lapse();
    return true;
  }
  /** Ends the scope's requests, private state and images before anything else shows, then tries to recover. */
  private lapse(): void {
    this.invalidate();
    this.publish({ phase: 'loading', language: this.state.language, profile: null, scope: null, languageUnsaved: false });
    this.lapsing = true;
    void this.recover().finally(() => { this.lapsing = false; });
  }
  private async recover(): Promise<void> {
    const client = this.client, epoch = this.epoch;
    let outcome: Recovery;
    let session: Session | null = null;
    try {
      const { data, error } = await client.auth.getSession();
      if (!this.current(client, epoch)) return;
      session = data.session;
      // A returned session that is already past its expiry would lapse again at once; it waits for a retry instead.
      outcome = session && !error ? (expiryOf(session) ?? Infinity) > Date.now() ? 'open' : 'locked' : classify(error, heldRecord(client));
    } catch (error) {
      if (!this.current(client, epoch)) return;
      outcome = classify(error, heldRecord(client));
    }
    if (outcome === 'open' && session) { await this.open(session); return; }
    if (outcome === 'expired') { await this.end(false, 'auth.expired', false); return; }
    this.unavailable(outcome === 'locked' ? 'locked' : 'waiting');
  }
  /** Credentials are kept for a retry; nothing private is shown. */
  private unavailable(phase: 'locked' | 'waiting'): void {
    this.invalidate();
    this.publish({ phase: isOnline() ? phase : 'waiting', language: resolveLanguage(this.browserLanguages, null, this.choice),
      profile: null, scope: null, languageUnsaved: false });
  }
  private async open(session: Session): Promise<void> {
    this.invalidate();
    this.request = new AbortController();
    const ownerId = sessionOwner(session);
    if (ownerId === null) { await this.end(false); return; }
    const scope = { ownerId, epoch: this.epoch, signal: this.request.signal };
    const client = this.client;
    // Every resume below drops its result once a sign-out, a newer sign-in or another owner's credential has taken over,
    // or once the access token has expired: a late answer never shows private state past the deadline.
    const stale = () => scope.signal.aborted || !this.current(client, scope.epoch) || this.heldOwner() !== scope.ownerId || this.checkExpiry();
    bindDataRequests(client, scope.signal, scope.ownerId);
    this.opening = scope.ownerId;
    this.arm(session);
    // Offline, the profile request would only retry; wait for the connection instead.
    if (!isOnline()) { this.unavailable('waiting'); return; }
    this.publish({ phase: 'loading', language: resolveLanguage(this.browserLanguages, null, this.choice), profile: null, scope: null, languageUnsaved: false });
    try {
      if (!isUuid(scope.ownerId)) throw new AppError('account.locked');
      let profile = await fetchProfile(client, scope.ownerId, scope.signal);
      if (stale()) return;
      let language = resolveLanguage(this.browserLanguages, profile.ui_language, this.choice);
      let languageUnsaved = false;
      if (profile.ui_language === null) {
        try {
          profile = await saveInitialLanguage(client, profile, language, scope.signal);
          language = resolveLanguage(this.browserLanguages, profile.ui_language, this.choice);
          languageUnsaved = profile.ui_language === null;
        } catch (error) {
          if (stale() || isAborted(error)) return;
          languageUnsaved = true;
        }
      }
      if (stale()) return;
      this.publish({ phase: 'ready', language, profile, scope, languageUnsaved });
    } catch (error) {
      if (stale() || isAborted(error)) return;
      // A frozen account cannot read its profile. If its own deletion is unfinished, offer to finish it.
      const deletion = await deletionStatus(client, scope.signal).catch(() => null);
      if (stale()) return;
      if (deletion === 'complete') { await this.signOut('delete.done'); return; }
      if (deletion === 'in_progress' || deletion === 'retry' || deletion === 'contact') {
        this.publish({ phase: 'deleting', language: resolveLanguage(this.browserLanguages, null, this.choice), profile: null, scope,
          languageUnsaved: false, deletion });
        return;
      }
      this.unavailable('locked');
    }
  }
  /** Records the latest answer from a recovery attempt; ignored once the scope has changed. */
  deletionState(scope: OwnerScope, deletion: 'in_progress' | 'retry' | 'contact'): void {
    if (scope.signal.aborted || this.state.phase !== 'deleting' || this.state.scope?.epoch !== scope.epoch) return;
    this.publish({ ...this.state, deletion });
  }
  private async checkMembership(): Promise<void> {
    const { scope } = this.state;
    if (!scope) return;
    const client = this.client;
    const stale = () => scope.signal.aborted || !this.current(client, scope.epoch);
    try {
      const profile = await fetchProfile(client, scope.ownerId, scope.signal);
      if (stale()) return;
      this.publishProfile(scope, profile, 'refresh');
    } catch (error) {
      if (stale() || isAborted(error)) return;
      this.invalidate();
      this.publish({ phase: 'locked', language: resolveLanguage(this.browserLanguages), profile: null, scope: null, languageUnsaved: false });
    }
  }
  private publishProfile(scope: OwnerScope, profile: ProfileRow, kind: 'profile' | 'language' | 'weather' | 'ai' | 'refresh'): void {
    const current = this.state;
    if (scope.signal.aborted || this.checkExpiry() || current.phase !== 'ready' || current.scope?.epoch !== scope.epoch
      || current.scope.ownerId !== scope.ownerId || profile.owner_id !== scope.ownerId || !current.profile
      || profile.version < current.profile.version || this.aiAckFloor !== null && BigInt(profile.version) < this.aiAckFloor) return;
    this.publish({ ...current, profile, language: profile.ui_language ?? current.language,
      languageUnsaved: profile.ui_language === null, profileChange: { kind, previous: current.profile } });
  }
  async saveProfile(scope: OwnerScope, baseline: ProfileRow, update: ProfileUpdate): Promise<ProfileRow> {
    if (scope.signal.aborted || this.state.scope?.epoch !== scope.epoch || this.state.scope.ownerId !== scope.ownerId) throw new AppError('account.locked');
    if (this.state.profileSaving) throw new AppError('error.unavailable');
    this.publish({ ...this.state, profileSaving: true });
    try {
      const profile = await updateProfile(this.client, scope, baseline, update);
      this.publishProfile(scope, profile, update.kind);
      return profile;
    } finally {
      if (!scope.signal.aborted && this.state.scope?.epoch === scope.epoch && this.state.scope.ownerId === scope.ownerId) this.publish({ ...this.state, profileSaving: false });
    }
  }
  async reloadProfile(scope: OwnerScope): Promise<ProfileRow> {
    const profile = await fetchProfile(this.client, scope.ownerId, scope.signal);
    this.publishProfile(scope, profile, 'refresh');
    return this.state.scope?.epoch === scope.epoch && this.state.profile ? this.state.profile : profile;
  }
  async saveAiConsent(scope: OwnerScope, baseline: ProfileRow, ai: AiClient, enabled: boolean, noticeRevision: number | null,
    expectedBinding: string | null): Promise<AiStatus> {
    this.checkAiScope(scope, ai);
    if (this.state.profileSaving || this.state.aiConsentUnresolved) throw new AppError('aiC.reconcile');
    if (baseline.owner_id !== scope.ownerId || !Number.isSafeInteger(baseline.version) || baseline.version < 1) throw new AiError('CONFLICT');
    if (!enabled && expectedBinding !== null) throw new AiError('CONFIG_CHANGED');
    this.publish({ ...this.state, profileSaving: true });
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(20000)]);
    let sent = false;
    try {
      const current = await ai.status(signal);
      this.checkAiScope(scope, ai);
      if (current.consent.profileVersion !== String(baseline.version)) throw new AppError('error.conflict');
      if (enabled && (!supportedAiPolicy(current) || noticeRevision !== current.policy?.noticeRevision
        || expectedBinding === null || expectedBinding !== aiPolicyBinding(scope, current))
        || !enabled && noticeRevision !== null) throw new AiError('CONFIG_CHANGED');
      sent = true;
      const version = await ai.consent({ enabled, noticeRevision, expectedVersion: baseline.version }, signal);
      this.checkAiScope(scope, ai);
      this.aiAckFloor = BigInt(version);
      const status = await ai.status(signal);
      const profile = await this.fetchAiProfile(scope, signal);
      this.checkAiScope(scope, ai);
      if (signal.aborted) throw new AppError('aiC.reconcile');
      if (BigInt(profile.version) < this.aiAckFloor || profile.version < (this.state.profile?.version ?? 0)
        || status.consent.profileVersion !== String(profile.version)) throw new AppError('aiC.reconcile');
      const own = BigInt(version) === BigInt(baseline.version) + 1n && String(profile.version) === version
        && sameProfileFields(profile, baseline) && profile.ui_language === baseline.ui_language
        && this.state.profile?.version === baseline.version;
      this.publishProfile(scope, profile, own ? 'ai' : 'refresh');
      this.aiAckFloor = null;
      this.publish({ ...this.state, aiConsentUnresolved: false });
      return status;
    } catch (error) {
      if (!scope.signal.aborted && sent) this.publish({ ...this.state, aiConsentUnresolved: true });
      throw sent ? new AppError('aiC.reconcile') : error;
    } finally {
      if (!scope.signal.aborted && this.state.scope?.epoch === scope.epoch) this.publish({ ...this.state, profileSaving: false });
    }
  }
  private checkAiScope(scope: OwnerScope, ai: AiClient) {
    if (scope.signal.aborted || this.state.phase !== 'ready' || this.state.scope?.epoch !== scope.epoch
      || this.state.scope.ownerId !== scope.ownerId || ai.scope !== scope) throw new AiError('UNAVAILABLE');
  }
  private async fetchAiProfile(scope: OwnerScope, outer: AbortSignal): Promise<ProfileRow> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const signal = AbortSignal.any([scope.signal, outer, controller.signal]);
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new AppError('aiC.reconcile'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const profile = await Promise.race([stopped, fetchProfile(this.client, scope.ownerId, signal)]);
      if (signal.aborted) throw new AppError('aiC.reconcile');
      return profile;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  async reconcileAiConsent(scope: OwnerScope, ai: AiClient): Promise<AiStatus> {
    this.checkAiScope(scope, ai);
    if (this.state.profileSaving) throw new AppError('aiC.reconcile');
    this.publish({ ...this.state, profileSaving: true });
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(20000)]);
    try {
      const status = await ai.status(signal);
      const profile = await this.fetchAiProfile(scope, signal);
      this.checkAiScope(scope, ai);
      if (signal.aborted) throw new AppError('aiC.reconcile');
      if (status.consent.profileVersion !== String(profile.version) || BigInt(profile.version) < (this.aiAckFloor ?? 0n)
        || profile.version < (this.state.profile?.version ?? 0)) throw new AppError('aiC.reconcile');
      this.publishProfile(scope, profile, 'refresh');
      this.aiAckFloor = null;
      this.publish({ ...this.state, aiConsentUnresolved: false });
      return status;
    } finally {
      if (!scope.signal.aborted && this.state.scope?.epoch === scope.epoch) this.publish({ ...this.state, profileSaving: false });
    }
  }
  chooseLanguage(language: Language): void {
    if (this.state.phase !== 'signed-out' && this.state.phase !== 'locked' && this.state.phase !== 'deleting' && this.state.phase !== 'waiting'
      && this.state.phase !== 'elsewhere') return;
    this.choice = language;
    this.publish({ ...this.state, language });
  }
  async signIn(email: string, password: string, remember = false): Promise<void> {
    const clients = this.clients;
    if (!clients?.remembered) {
      const client = this.client;
      this.allowSession = true;
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      // Signed out while this was in flight: its result belongs to a retired client and is dropped.
      if (client !== this.client) return;
      if (error) throw new AppError('auth.failed');
      return;
    }
    await (await clients.remembered()).signIn(this, email, password, remember);
  }
  /** Signs a remembered session this tab cannot adopt out of the device, from the sign-in screen. */
  async signOutDevice(): Promise<void> {
    if (this.clients?.remembered) await (await this.clients.remembered()).signOutDevice(this);
  }
  /** True while a continuation started for `client` at `epoch` still belongs to the current generation. */
  private current(client: AppClient, epoch: number): boolean {
    return client === this.client && epoch === this.epoch;
  }
  async retry(): Promise<void> {
    const client = this.client, epoch = this.epoch;
    const { data, error } = await client.auth.getSession();
    // A sign-out or another sign-in while this was waiting: the answer belongs to an older generation.
    if (!this.current(client, epoch)) return;
    if (!error && data.session) { await this.open(data.session); return; }
    const outcome = classify(error, heldRecord(client));
    // A refused refresh token: nothing left to revoke, and nothing kept for a reload to find.
    if (outcome === 'expired' || outcome === 'open') { await this.end(false, 'auth.expired', false); return; }
    this.unavailable(outcome);
  }
  async retryLanguage(): Promise<void> {
    const { scope, profile, language } = this.state;
    if (!scope || !profile || this.state.profileSaving) return;
    this.publish({ ...this.state, profileSaving: true });
    try {
      const updated = await saveInitialLanguage(this.client, profile, language, scope.signal);
      if (scope.signal.aborted || scope.epoch !== this.epoch) return;
      this.publishProfile(scope, updated, 'language');
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      this.publish({ ...this.state, languageUnsaved: true });
    } finally {
      if (!scope.signal.aborted && this.state.scope?.epoch === scope.epoch) this.publish({ ...this.state, profileSaving: false });
    }
  }
  /**
   * Signs out on this device without waiting for the network: the stored credentials are gone and the old client
   * is retired before anything shows signed out. The server revoke that follows is best effort. This is the only
   * path that tells other tabs.
   */
  async signOut(notice?: MessageKey): Promise<void> {
    return this.end(true, notice);
  }
  /** Ends this tab's own session for a command received from another tab, and sends nothing on. */
  async endOnCommand(command: 'sign-out' | 'end-remembered'): Promise<void> {
    // `end-remembered` is for the remembered session only; a tab's own session keeps going.
    if (command === 'end-remembered' && this.mode !== 'device') return;
    try { await this.end(false); } catch { this.publish({ ...this.state, notice: 'auth.localSignOut' }); }
  }
  private async end(broadcast: boolean, notice?: MessageKey, revoke = true): Promise<void> {
    this.allowSession = false;
    this.generation++;
    this.subscription?.unsubscribe();
    this.subscription = null;
    let record: AuthRecord | null = null;
    const wasHolder = this.mode === 'device';
    if (this.clients) {
      record = this.clients.retire(this.client).record;
      this.mode = 'tab';
      this.client = this.clients.make();
      if (this.started) this.watch(this.client);
    }
    // The slot is gone, so a window waiting for the lock finds nothing to adopt.
    this.held?.release();
    this.held = null;
    this.signedOut(notice);
    if (broadcast) this.channels?.send('sign-out');
    // A remembered session whose window has closed is signed out of this device too.
    const clients = this.clients;
    if (broadcast && !wasHolder && this.lock === 'available' && clients?.remembered) {
      void clients.remembered().then((remembered) => remembered.sweepSlot(clients.revoke)).catch(() => undefined);
    }
    if (!revoke) return;
    const client = this.client;
    const result = this.clients ? await this.clients.revoke(record) : 'ok';
    if (result === 'failed' && client === this.client && this.state.phase === 'signed-out' && this.state.notice !== 'delete.done') {
      this.publish({ ...this.state, notice: 'auth.localSignOut' });
    }
  }
}

/**
 * When the held access token stops working, in this device's time: the SDK's own `expires_at`, which it renews by, so
 * the two never disagree about a skewed clock. A token without valid claims has none, and its owner check fails closed.
 */
function expiryOf(session: Session): number | null {
  const claims = tokenClaims(session.access_token);
  if (!claims) return null;
  const at = session.expires_at;
  return (typeof at === 'number' && Number.isSafeInteger(at) && at > 0 ? at : claims.exp) * 1000;
}
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
/** Sorts a failed session recovery: kept credentials can retry; a refused refresh token means signing in again. */
function classify(error: unknown, held: AuthRecord | null): Recovery {
  if (!held) return 'expired';
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 0;
  const retryable = typeof error === 'object' && error !== null && 'name' in error && error.name === 'AuthRetryableFetchError';
  if (!isOnline() || retryable && status === 0) return 'waiting';
  if (retryable || status >= 500) return 'locked';
  return held.expires_at * 1000 > Date.now() ? 'locked' : 'expired';
}
