import { makeRecoveryClient } from '../data/client';
import type { PublicConfig } from '../data/config';
import { fetchProfile } from '../data/profile';
import { AppError } from '../data/errors';
import { isRecord } from '../domain/wardrobe';
import type { MessageKey } from '../i18n';
import { freshRecoveryLink, registerRecoveryCancellation, type RecoveryLink } from './recovery-callback';
import { logoutKey } from './session';

export const recoveryPasswordMinimum: number = 24;
export const recoveryPasswordMaximumBytes: number = 72;
export function passwordProblem(password: string, confirmation: string): MessageKey | null {
  if ([...password].length < recoveryPasswordMinimum) return 'recovery.short';
  if (new TextEncoder().encode(password).length > recoveryPasswordMaximumBytes) return 'recovery.long';
  if (password !== confirmation) return 'recovery.mismatch';
  return null;
}
export function recoveryError(error: unknown): MessageKey {
  if (error instanceof AppError) return error.messageKey;
  if (isRecord(error)) {
    if (error.status === 429 || error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') return 'recovery.throttled';
    if (error.code === 'same_password') return 'recovery.same';
    if (error.code === 'weak_password') return 'recovery.policy';
    if (['reauthentication_needed', 'reauthentication_not_valid', 'insufficient_aal'].includes(String(error.code))) return 'recovery.reauthentication';
  }
  return 'recovery.unavailable';
}
let resendAfter = 0;
let requestActive = false;
export function recoveryRequestWait(now = Date.now()): number { return Math.max(0, Math.ceil((resendAfter - now) / 1000)); }
export async function requestRecovery(config: PublicConfig, email: string, signal: AbortSignal): Promise<void> {
  if (requestActive || recoveryRequestWait() || signal.aborted) throw new AppError('recovery.throttled');
  requestActive = true;
  resendAfter = Date.now() + 60_000;
  const transport = makeRecoveryClient(config, null, `${location.origin}/`);
  const cancel = () => transport.dispose();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const { error } = await transport.client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/` });
    resendAfter = Math.max(resendAfter, Date.now() + transport.retrySeconds * 1000);
    if (error) {
      // Eligibility-dependent failures receive the same acknowledgement as success.
      if (['user_not_found', 'email_not_confirmed', 'user_banned', 'signup_disabled', 'email_address_not_authorized'].includes(transport.errorDetails?.code ?? error.code ?? '')) return;
      throw new AppError(recoveryError(transport.errorDetails ?? error));
    }
  } catch (error) { throw new AppError(recoveryError(error)); }
  finally {
    signal.removeEventListener('abort', cancel);
    transport.dispose();
    requestActive = false;
  }
}
export type RecoveryState = {
  phase: 'verifying' | 'confirm' | 'password' | 'updating' | 'revoking' | 'success' | 'failed';
  email?: string;
  notice?: MessageKey;
  minimum?: number;
};
export class RecoveryAttempt {
  private state: RecoveryState = { phase: 'verifying' };
  private listeners = new Set<() => void>();
  private transport: ReturnType<typeof makeRecoveryClient> | null;
  private link: RecoveryLink | null;
  private started = false;
  private disposed = false;
  private passwordChanged = false;
  private consumers = 0;
  private channel: BroadcastChannel | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private verification: Promise<string> | undefined;
  constructor(config: PublicConfig, link: RecoveryLink) {
    this.link = link;
    this.transport = makeRecoveryClient(config, link, `${location.origin}/`);
    registerRecoveryCancellation(() => {
      const notice = this.passwordChanged ? 'recovery.revocationUncertain' : this.transport?.updateSent ? 'recovery.uncertain' : undefined;
      this.dispose();
      return notice;
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: RecoveryState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private requireActive(): { link: RecoveryLink; transport: NonNullable<RecoveryAttempt['transport']> } {
    if (this.disposed || !this.link || !this.transport || !freshRecoveryLink(this.link)) throw new AppError('recovery.invalid');
    return { link: this.link, transport: this.transport };
  }
  private verify(): Promise<string> {
    this.verification ??= this.verifyTarget().finally(() => { this.verification = undefined; });
    return this.verification;
  }
  private async verifyTarget(): Promise<string> {
    const { link, transport } = this.requireActive();
    const { data, error } = await transport.client.auth.getUser(link.accessToken);
    this.requireActive();
    if (error || !data.user || data.user.id !== link.subject || data.user.is_anonymous || data.user.role !== 'authenticated'
      || data.user.aud !== 'authenticated' || !data.user.email || data.user.email.length > 320) throw new AppError('recovery.invalid');
    transport.bindOwner(data.user.id);
    await fetchProfile(transport.client, data.user.id, transport.signal);
    this.requireActive();
    return data.user.email;
  }
  retain(): () => void {
    this.consumers++;
    if (!this.started) {
      this.started = true;
      this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(logoutKey) : null;
      if (this.channel) this.channel.onmessage = this.cancel;
      window.addEventListener('storage', this.onStorage);
      window.addEventListener('focus', this.onFocus);
      this.expiry = setTimeout(this.cancel, Math.max(0, this.link!.expiresAt * 1000 - Date.now() - 150_000));
      void this.begin();
    }
    return () => {
      this.consumers--;
      // StrictMode's immediate remount retains this same capability.
      queueMicrotask(() => { if (!this.consumers) this.dispose(); });
    };
  }
  private onStorage = (event: StorageEvent) => { if (event.key === logoutKey && event.newValue) this.cancel(); };
  private onFocus = () => {
    if (this.state.phase === 'confirm' || this.state.phase === 'password') {
      const stillIdle = () => this.state.phase === 'confirm' || this.state.phase === 'password';
      void this.verify().then(email => { if (stillIdle() && email !== this.state.email) this.cancel(); })
        .catch(() => { if (stillIdle()) this.cancel(); });
    }
  };
  private cancel = () => {
    this.publish({ phase: 'failed', notice: this.passwordChanged ? 'recovery.revocationUncertain' : this.transport?.updateSent ? 'recovery.uncertain' : 'recovery.invalid' });
    this.dispose();
  };
  private async begin(): Promise<void> {
    try {
      const { link, transport } = this.requireActive();
      const { data, error } = await transport.client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
      this.requireActive();
      if (error || data.user?.id !== link.subject) throw new AppError('recovery.invalid');
      const email = await this.verify();
      this.publish({ phase: 'confirm', email });
    } catch {
      this.publish({ phase: 'failed', notice: 'recovery.invalid' });
      this.dispose();
    }
  }
  confirm(): void {
    if (this.state.phase !== 'confirm') return;
    try { this.requireActive(); this.publish({ ...this.state, phase: 'password' }); } catch { this.cancel(); }
  }
  async update(password: string, confirmation: string, onConfirmed: () => void): Promise<void> {
    if (this.state.phase !== 'password') return;
    const problem = passwordProblem(password, confirmation);
    if (problem) { this.publish({ ...this.state, notice: problem }); return; }
    const email = this.state.email;
    this.publish({ ...this.state, phase: 'updating', notice: undefined });
    try {
      const { transport, link } = this.requireActive();
      if (await this.verify() !== email) throw new AppError('recovery.invalid');
      this.requireActive();
      transport.allowUpdate();
      const { data, error } = await transport.client.auth.updateUser({ password });
      this.requireActive();
      if (error || data.user?.id !== link.subject) {
        const mapped = recoveryError(transport.errorDetails ?? error);
        throw new AppError(mapped === 'recovery.unavailable' && transport.updateSent ? 'recovery.uncertain' : mapped);
      }
      transport.confirmSuccess();
      this.passwordChanged = true;
      onConfirmed();
      this.publish({ phase: 'revoking' });
      let affirmed = false;
      try {
        const result = await transport.client.auth.signOut({ scope: 'global' });
        affirmed = !result.error && transport.logoutAffirmed;
      } catch { /* Password success and revocation uncertainty are separate outcomes. */ }
      this.publish({ phase: 'success', notice: affirmed ? 'recovery.success' : 'recovery.revocationUncertain' });
    } catch (error) {
      const mapped = recoveryError(error);
      const notice = this.transport?.updateSent && (!(error instanceof AppError) || mapped === 'recovery.invalid') ? 'recovery.uncertain' : mapped;
      const minimum = notice === 'recovery.policy' ? this.transport?.errorDetails?.minimum : undefined;
      this.publish({ phase: 'failed', notice: minimum ? 'recovery.policyMinimum' : notice, minimum });
    } finally { this.dispose(); }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.expiry);
    this.channel?.close();
    window.removeEventListener('storage', this.onStorage);
    window.removeEventListener('focus', this.onFocus);
    this.transport?.dispose();
    this.transport = null;
    if (this.link) {
      this.link.accessToken = '';
      this.link.refreshToken = '';
    }
    this.link = null;
  }
}
const attempts = new WeakMap<RecoveryLink, RecoveryAttempt>();
export function recoveryAttempt(config: PublicConfig, link: RecoveryLink): RecoveryAttempt {
  const existing = attempts.get(link);
  if (existing) return existing;
  const attempt = new RecoveryAttempt(config, link);
  attempts.set(link, attempt);
  return attempt;
}
