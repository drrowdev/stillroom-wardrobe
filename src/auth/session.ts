import type { Session } from '@supabase/supabase-js';
import { authStorageKey, bindDataRequests, type AppClient, type RevokeResult } from '../data/client';
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
  phase: 'loading' | 'signed-out' | 'ready' | 'locked' | 'deleting';
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
export const logoutKey = 'stillroom.logout';
/** Creates, retires and revokes auth clients. Each sign-in generation gets its own client. */
export type SessionClients = {
  make(): AppClient;
  retire(client: AppClient): { token: string | null };
  revoke(token: string | null): Promise<RevokeResult>;
};

export class SessionController {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private request = new AbortController();
  private epoch = 0;
  private choice: Language | null = null;
  private allowSession = true;
  private channel: BroadcastChannel | null = null;
  private scheduled = new Set<ReturnType<typeof setTimeout>>();
  private aiAckFloor: bigint | null = null;
  private subscription: { unsubscribe(): void } | null = null;
  private started = false;

  constructor(private client: AppClient, private browserLanguages: readonly string[], private clients?: SessionClients) {
    this.state = { phase: 'loading', language: resolveLanguage(browserLanguages), profile: null, scope: null, languageUnsaved: false, client };
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(next: PublishedState): void {
    this.state = { ...next, client: this.client };
    for (const listener of this.listeners) listener();
  }
  private invalidate(): void {
    this.aiAckFloor = null;
    this.epoch++;
    this.request.abort();
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
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(logoutKey) : null;
    const receiveLogout = () => {
      void this.signOut(false).catch(() => this.publish({ ...this.state, notice: 'auth.localSignOut' }));
    };
    if (this.channel) this.channel.onmessage = receiveLogout;
    const onStorage = (event: StorageEvent) => {
      if (event.key === logoutKey && event.newValue) receiveLogout();
    };
    const onFocus = () => {
      if (this.state.phase === 'ready' && navigator.onLine) void this.checkMembership();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    this.started = true;
    this.watch(this.client);
    return () => {
      this.started = false;
      this.subscription?.unsubscribe();
      this.subscription = null;
      this.channel?.close();
      this.channel = null;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      this.invalidate();
    };
  }
  private watch(client: AppClient): void {
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // A retired client's late events belong to a finished generation.
      if (client !== this.client) return;
      if (event === 'SIGNED_OUT' || !session) { this.signedOut(); return; }
      if (!this.allowSession || !this.holdsSession(session)) return;
      if (this.state.scope?.ownerId === session.user.id && !this.state.scope.signal.aborted
        && (this.state.phase === 'ready' || this.state.phase === 'deleting')) return;
      // Supabase holds its auth lock during this callback; data requests must run after it returns.
      const epoch = this.epoch;
      const timer = setTimeout(() => {
        this.scheduled.delete(timer);
        if (epoch === this.epoch && this.allowSession && client === this.client) void this.open(session);
      }, 0);
      this.scheduled.add(timer);
    });
    this.subscription = data.subscription;
  }
  // Sessions live in this tab's sessionStorage. The SDK also broadcasts sign-ins
  // and refreshes between tabs; a tab must ignore any session it does not hold.
  private holdsSession(session: Session): boolean {
    return holdsStoredSession(window.sessionStorage.getItem(authStorageKey), session.access_token);
  }
  private async open(session: Session): Promise<void> {
    this.invalidate();
    this.request = new AbortController();
    const scope = { ownerId: session.user.id, epoch: this.epoch, signal: this.request.signal };
    bindDataRequests(this.client, scope.signal);
    this.publish({ phase: 'loading', language: resolveLanguage(this.browserLanguages, null, this.choice), profile: null, scope: null, languageUnsaved: false });
    try {
      if (!isUuid(scope.ownerId)) throw new AppError('account.locked');
      let profile = await fetchProfile(this.client, scope.ownerId, scope.signal);
      let language = resolveLanguage(this.browserLanguages, profile.ui_language, this.choice);
      let languageUnsaved = false;
      if (profile.ui_language === null) {
        try {
          profile = await saveInitialLanguage(this.client, profile, language, scope.signal);
          language = resolveLanguage(this.browserLanguages, profile.ui_language, this.choice);
          languageUnsaved = profile.ui_language === null;
        } catch (error) {
          if (scope.signal.aborted || isAborted(error)) return;
          languageUnsaved = true;
        }
      }
      if (scope.signal.aborted || scope.epoch !== this.epoch) return;
      this.publish({ phase: 'ready', language, profile, scope, languageUnsaved });
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      // A frozen account cannot read its profile. If its own deletion is unfinished, offer to finish it.
      const deletion = await deletionStatus(this.client, scope.signal).catch(() => null);
      if (scope.signal.aborted || scope.epoch !== this.epoch) return;
      if (deletion === 'complete') { await this.signOut(true, 'delete.done'); return; }
      if (deletion === 'in_progress' || deletion === 'retry' || deletion === 'contact') {
        this.publish({ phase: 'deleting', language: resolveLanguage(this.browserLanguages, null, this.choice), profile: null, scope,
          languageUnsaved: false, deletion });
        return;
      }
      this.request.abort();
      this.publish({ phase: 'locked', language: resolveLanguage(this.browserLanguages), profile: null, scope: null, languageUnsaved: false });
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
    try {
      const profile = await fetchProfile(this.client, scope.ownerId, scope.signal);
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      this.publishProfile(scope, profile, 'refresh');
    } catch (error) {
      if (scope.signal.aborted || isAborted(error)) return;
      this.invalidate();
      this.publish({ phase: 'locked', language: resolveLanguage(this.browserLanguages), profile: null, scope: null, languageUnsaved: false });
    }
  }
  private publishProfile(scope: OwnerScope, profile: ProfileRow, kind: 'profile' | 'language' | 'weather' | 'ai' | 'refresh'): void {
    const current = this.state;
    if (scope.signal.aborted || current.phase !== 'ready' || current.scope?.epoch !== scope.epoch
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
    if (this.state.phase !== 'signed-out' && this.state.phase !== 'locked' && this.state.phase !== 'deleting') return;
    this.choice = language;
    this.publish({ ...this.state, language });
  }
  async signIn(email: string, password: string): Promise<void> {
    const client = this.client;
    this.allowSession = true;
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    // Signed out while this was in flight: its result belongs to a retired client and is dropped.
    if (client !== this.client) return;
    if (error) throw new AppError('auth.failed');
  }
  async retry(): Promise<void> {
    const { data, error } = await this.client.auth.getSession();
    if (error || !data.session) { this.signedOut(); return; }
    await this.open(data.session);
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
   * is retired before anything shows signed out. The server revoke that follows is best effort.
   */
  async signOut(broadcast = true, notice?: MessageKey): Promise<void> {
    this.allowSession = false;
    this.subscription?.unsubscribe();
    this.subscription = null;
    let token: string | null = null;
    if (this.clients) {
      token = this.clients.retire(this.client).token;
      this.client = this.clients.make();
      if (this.started) this.watch(this.client);
    }
    this.signedOut(notice);
    try {
      if (broadcast) {
        if (this.channel) this.channel.postMessage('sign-out');
        else {
          window.localStorage.setItem(logoutKey, crypto.randomUUID());
          window.localStorage.removeItem(logoutKey);
        }
      }
    } catch { /* Other tabs notice on their next request. */ }
    const client = this.client;
    const result = this.clients ? await this.clients.revoke(token) : 'ok';
    if (result === 'failed' && client === this.client && this.state.phase === 'signed-out' && this.state.notice !== 'delete.done') {
      this.publish({ ...this.state, notice: 'auth.localSignOut' });
    }
  }
}
