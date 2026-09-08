import type { Session } from '@supabase/supabase-js';
import { authStorageKey, bindDataRequests, type AppClient } from '../data/client';
import { fetchProfile, saveInitialLanguage, updateProfile, type ProfileUpdate } from '../data/profile';
import type { ProfileRow } from '../data/rows';
import { isUuid } from '../domain/wardrobe';
import { resolveLanguage, type Language, type MessageKey } from '../i18n';
import { AppError, isAborted } from '../data/errors';
import { holdsStoredSession } from './stored-session';

export type OwnerScope = { ownerId: string; epoch: number; signal: AbortSignal };
export type SessionState = {
  phase: 'loading' | 'signed-out' | 'ready' | 'locked';
  language: Language;
  profile: ProfileRow | null;
  scope: OwnerScope | null;
  languageUnsaved: boolean;
  notice?: MessageKey;
  profileSaving?: boolean;
  profileChange?: { kind: 'profile' | 'language' | 'refresh'; previous: ProfileRow };
};
export const logoutKey = 'stillroom.logout';

export class SessionController {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private request = new AbortController();
  private epoch = 0;
  private choice: Language | null = null;
  private allowSession = true;
  private signingOut: Promise<void> | null = null;
  private channel: BroadcastChannel | null = null;
  private scheduled = new Set<ReturnType<typeof setTimeout>>();

  constructor(private client: AppClient, private browserLanguages: readonly string[]) {
    this.state = { phase: 'loading', language: resolveLanguage(browserLanguages), profile: null, scope: null, languageUnsaved: false };
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(next: SessionState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private invalidate(): void {
    this.epoch++;
    this.request.abort();
    for (const timer of this.scheduled) clearTimeout(timer);
    this.scheduled.clear();
  }
  private signedOut(): void {
    this.invalidate();
    this.choice = null;
    this.publish({
      phase: 'signed-out', language: resolveLanguage(this.browserLanguages),
      profile: null, scope: null, languageUnsaved: false,
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
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) { this.signedOut(); return; }
      if (!this.allowSession || !this.holdsSession(session)) return;
      if (this.state.scope?.ownerId === session.user.id && !this.state.scope.signal.aborted && this.state.phase === 'ready') return;
      // Supabase holds its auth lock during this callback; data requests must run after it returns.
      const epoch = this.epoch;
      const timer = setTimeout(() => {
        this.scheduled.delete(timer);
        if (epoch === this.epoch && this.allowSession) void this.open(session);
      }, 0);
      this.scheduled.add(timer);
    });
    return () => {
      data.subscription.unsubscribe();
      this.channel?.close();
      this.channel = null;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      this.invalidate();
    };
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
      this.request.abort();
      this.publish({ phase: 'locked', language: resolveLanguage(this.browserLanguages), profile: null, scope: null, languageUnsaved: false });
    }
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
  private publishProfile(scope: OwnerScope, profile: ProfileRow, kind: 'profile' | 'language' | 'refresh'): void {
    const current = this.state;
    if (scope.signal.aborted || current.phase !== 'ready' || current.scope?.epoch !== scope.epoch
      || current.scope.ownerId !== scope.ownerId || profile.owner_id !== scope.ownerId || !current.profile
      || profile.version < current.profile.version) return;
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
  chooseLanguage(language: Language): void {
    if (this.state.phase !== 'signed-out') return;
    this.choice = language;
    this.publish({ ...this.state, language });
  }
  async signIn(email: string, password: string): Promise<void> {
    if (this.signingOut) await this.signingOut;
    this.allowSession = true;
    await this.client.auth.startAutoRefresh();
    const { error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
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
  async signOut(broadcast = true): Promise<void> {
    if (this.signingOut) return this.signingOut;
    this.allowSession = false;
    this.signedOut();
    const operation = this.finishSignOut(broadcast);
    this.signingOut = operation;
    try { await operation; } finally { this.signingOut = null; }
  }
  private async finishSignOut(broadcast: boolean): Promise<void> {
    try {
      await this.client.auth.stopAutoRefresh();
      if (broadcast) {
        if (this.channel) this.channel.postMessage('sign-out');
        else {
          window.localStorage.setItem(logoutKey, crypto.randomUUID());
          window.localStorage.removeItem(logoutKey);
        }
      }
      const { error } = await this.client.auth.signOut({ scope: 'local' });
      if (error) throw new AppError('auth.expired');
    } catch {
      this.publish({ ...this.state, notice: 'auth.localSignOut' });
    } finally {
      for (const store of [window.sessionStorage, window.localStorage]) {
        store.removeItem(authStorageKey);
        store.removeItem(`${authStorageKey}-code-verifier`);
      }
    }
  }
}
