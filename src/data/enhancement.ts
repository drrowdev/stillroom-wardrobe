// BG2b-2: owner- and epoch-scoped calls for photo enhancement: status, consent and the enhance-photo POST. The same
// session, identity and bounded-response rules as src/data/ai.ts. Nothing here decides eligibility; that is the stage's
// job, and the server's checks stay authoritative.
import type { OwnerScope } from '../auth/session';
import { parseEnhanceStatus, type EnhanceStatus } from '../domain/enhance-controls';
import { aiBudgetHeaders } from '../domain/ai-budget';
import { CLEANUP_NOTICE_REVISION, ENHANCE_LIMITS } from '../domain/enhancement';
import { isUuid } from '../domain/wardrobe';
import type { CleanupSource } from '../images/process-jpeg';
import type { AppClient } from './client';
import { readConfiguration, type PublicConfig } from './config';
import { sessionOwner } from '../auth/auth-storage';

export const enhanceCodes = ['OK', 'INVALID_INPUT', 'UNAUTHENTICATED', 'UNAVAILABLE', 'CONSENT_REQUIRED', 'TERMINAL', 'TOO_LARGE',
  'UNSUPPORTED_MEDIA', 'FILTERED', 'OUTPUT_REJECTED', 'ALLOWANCE', 'FAILED', 'UNCONFIGURED', 'INACTIVE',
  'CONFIG_CHANGED', 'BUSY', 'TIMEOUT'] as const;
export type EnhanceCode = (typeof enhanceCodes)[number];
export class EnhanceError extends Error {
  constructor(readonly code: EnhanceCode) { super(code); this.name = 'EnhanceError'; }
}
/** BULK2b: the caller's send check refused the POST after auth; nothing was sent. */
export class EnhanceNotSentError extends EnhanceError {
  constructor(readonly blocked: string) { super('UNAVAILABLE'); }
}
/** One status read with its timing: `t0`/`t1` are performance.now() just before the request and just after the reply. */
export type EnhanceSample = { serverTimeMs: number; t0: number; t1: number };
export type EnhanceStatusRead = { kind: 'missing' } | { kind: 'ready'; status: EnhanceStatus; sample: EnhanceSample | null };
export type EnhanceConsentResult = { kind: 'applied'; status: EnhanceStatus }
  | { kind: 'refused'; code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'UNCONFIGURED' | 'CONFIG_CHANGED' };
/** The enhanced photo exactly as received, with the evidence headers; nothing here has been admitted yet. */
export type EnhanceResponse = { kind: 'image'; body: Uint8Array<ArrayBuffer>; sha256: string; length: number; usableUntilMs: number }
  | { kind: 'code'; code: Exclude<EnhanceCode, 'OK'> };
const refusals = ['UNAVAILABLE', 'INVALID_INPUT', 'UNCONFIGURED', 'CONFIG_CHANGED'] as const;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const closed = (value: unknown): Exclude<EnhanceCode, 'OK'> => {
  const code = enhanceCodes.find((entry) => entry === value);
  return code && code !== 'OK' ? code : 'FAILED';
};

type Wait = <R>(work: PromiseLike<R>) => Promise<R>;
export class EnhancementClient {
  private readonly identity: { ownerId: string; epoch: number };
  constructor(private readonly client: AppClient, private readonly config: PublicConfig, readonly scope: OwnerScope,
    private readonly clock: () => number = () => performance.now()) {
    this.identity = { ownerId: scope.ownerId, epoch: scope.epoch };
    const checked = readConfiguration({ VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey });
    if (checked.status !== 'ready' || checked.value.url !== config.url || !isUuid(scope.ownerId)) throw new EnhanceError('UNAVAILABLE');
  }
  private checkIdentity() {
    if (this.scope.signal.aborted || this.scope.ownerId !== this.identity.ownerId || this.scope.epoch !== this.identity.epoch) {
      throw new EnhanceError('UNAVAILABLE');
    }
  }
  private async bounded<T>(ms: number, outer: AbortSignal | undefined, operation: (signal: AbortSignal, wait: Wait) => Promise<T>): Promise<T> {
    this.checkIdentity();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([this.scope.signal, controller.signal, ...(outer ? [outer] : [])]);
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new EnhanceError(this.scope.signal.aborted ? 'UNAVAILABLE' : 'TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    stopped.catch(() => undefined);
    const wait: Wait = async (work) => {
      const result = await Promise.race([Promise.resolve(work), stopped]);
      this.checkIdentity();
      if (signal.aborted) throw new EnhanceError('TIMEOUT');
      return result;
    };
    try { return await wait(operation(signal, wait)); }
    catch (error) { throw error instanceof EnhanceError ? error : new EnhanceError(signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
  private async bearer(ms: number, wait: Wait): Promise<string> {
    const cached = await wait(this.client.auth.getSession());
    if (cached.error || !cached.data.session || sessionOwner(cached.data.session) !== this.scope.ownerId) throw new EnhanceError('UNAUTHENTICATED');
    let session = cached.data.session;
    if ((session.expires_at ?? 0) * 1000 <= Date.now() + ms) {
      const refreshed = await wait(this.client.auth.refreshSession());
      if (refreshed.error || !refreshed.data.session) throw new EnhanceError('UNAUTHENTICATED');
      session = refreshed.data.session;
    }
    if (sessionOwner(session) !== this.scope.ownerId) throw new EnhanceError('UNAUTHENTICATED');
    return session.access_token;
  }
  private headers(token: string, extra: Record<string, string>) {
    return { apikey: this.config.publishableKey, Authorization: `Bearer ${token}`, ...    aiBudgetHeaders, ...extra };
  }
  private async readBody(response: Response, limit: number, wait: Wait): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.body) throw new EnhanceError('FAILED');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        // Content-Length isn't trusted: the cap is applied while reading and the reader is cancelled at once.
        if (bytes > limit) throw new EnhanceError('OUTPUT_REJECTED');
        parts.push(part.value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
      reader.releaseLock();
    }
    const body = new Uint8Array(new ArrayBuffer(bytes));
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
    parts.length = 0;
    return body;
  }
  private async json(response: Response, wait: Wait): Promise<unknown> {
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      if (response.body) await wait(response.body.cancel());
      throw new EnhanceError('UNAVAILABLE');
    }
    const body = await this.readBody(response, 32768, wait).catch((error: unknown) => {
      throw error instanceof EnhanceError && error.code === 'OUTPUT_REJECTED' ? new EnhanceError('UNAVAILABLE') : error;
    });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new EnhanceError('UNAVAILABLE'); }
  }
  private rpc(path: 'enhance_status' | 'enhance_set_consent', body: object, outer?: AbortSignal) {
    return this.bounded(5000, outer, async (signal, wait) => {
      const token = await this.bearer(5000, wait);
      const t0 = this.clock();
      const response = await wait(fetch(`${this.config.url}/rest/v1/rpc/${path}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal,
        headers: this.headers(token, { Accept: 'application/json', 'Content-Type': 'application/json' }), body: JSON.stringify(body),
      }));
      const t1 = this.clock();
      return { status: response.status, value: await this.json(response, wait), t0, t1 };
    });
  }
  /** `missing` is only PostgREST's "function not found": this backend has no enhancement. Other failures throw. */
  async status(signal?: AbortSignal): Promise<EnhanceStatusRead> {
    const reply = await this.rpc('enhance_status', {}, signal);
    if (reply.status === 404 && record(reply.value) && reply.value.code === 'PGRST202') return { kind: 'missing' };
    const status = reply.status === 200 ? parseEnhanceStatus(reply.value) : null;
    if (!status) throw new EnhanceError('UNAVAILABLE');
    return { kind: 'ready', status, sample: status.serverTimeMs === null ? null : { serverTimeMs: status.serverTimeMs, t0: reply.t0, t1: reply.t1 } };
  }
  /** Turns enhancement on for the current notice, or off. A thrown error means the outcome is unknown. */
  async consent(enabled: boolean, signal?: AbortSignal): Promise<EnhanceConsentResult> {
    const reply = await this.rpc('enhance_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? CLEANUP_NOTICE_REVISION : null }, signal);
    if (reply.status === 200 && record(reply.value) && Object.keys(reply.value).length === 1) {
      const code = refusals.find((entry) => entry === (reply.value as Record<string, unknown>).code);
      if (code) return { kind: 'refused', code };
    }
    const status = reply.status === 200 ? parseEnhanceStatus(reply.value) : null;
    if (!status || status.code === 'UNAVAILABLE') throw new EnhanceError('UNAVAILABLE');
    return { kind: 'applied', status };
  }
  /**
   * Sends the prepared photo once under `requestId`. The body is read with the 512,000-byte cap; the evidence headers
   * are returned for the caller's admission. A closed JSON code is returned as `code`; anything else is FAILED.
   */
  /**
   * Sends the clean-up input (H0, BG2c): the app-prepared JPEG of the accepted crop, never H1 or the raw file.
   * `beforeSend` runs after auth, immediately before the POST; a non-null value sends nothing (EnhanceNotSentError).
   */
  async enhance(photo: Pick<CleanupSource, 'main'>, requestId: string, signal: AbortSignal,
    beforeSend?: () => string | null): Promise<EnhanceResponse> {
    if (!isUuid(requestId) || photo.main.type !== 'image/jpeg' || photo.main.size < 1 || photo.main.size > ENHANCE_LIMITS.imageBytes) {
      throw new EnhanceError('INVALID_INPUT');
    }
    return this.bounded(ENHANCE_LIMITS.clientStageMs, signal, async (inner, wait) => {
      const token = await this.bearer(ENHANCE_LIMITS.requestMs, wait);
      const blocked = beforeSend?.() ?? null;
      if (blocked !== null) throw new EnhanceNotSentError(blocked);
      const response = await wait(fetch(`${this.config.url}/functions/v1/enhance-photo`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: inner,
        headers: this.headers(token, { Accept: 'image/jpeg, application/json', 'Content-Type': 'image/jpeg', 'X-Stillroom-Request-Id': requestId }),
        body: photo.main,
      }));
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.status !== 200 || type !== 'image/jpeg') {
        const value = await this.json(response, wait).catch(() => null);
        return { kind: 'code', code: record(value) && Object.keys(value).length === 1 ? closed(value.code) : 'FAILED' };
      }
      const sha256 = response.headers.get('X-Stillroom-Enhancement-Sha256') ?? '';
      const usable = response.headers.get('X-Stillroom-Enhancement-Usable-Until') ?? '';
      const length = response.headers.get('Content-Length') ?? '';
      if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[1-9][0-9]{0,15}$/.test(usable) || !/^[1-9][0-9]{0,6}$/.test(length)) {
        await wait(response.body?.cancel() ?? Promise.resolve());
        return { kind: 'code', code: 'OUTPUT_REJECTED' };
      }
      try {
        const body = await this.readBody(response, ENHANCE_LIMITS.outputBytes, wait);
        return { kind: 'image', body, sha256, length: Number(length), usableUntilMs: Number(usable) };
      } catch (error) {
        if (error instanceof EnhanceError && error.code === 'OUTPUT_REJECTED') return { kind: 'code', code: 'OUTPUT_REJECTED' };
        throw error;
      }
    });
  }
}
