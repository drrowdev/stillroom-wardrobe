import type { OwnerScope } from '../auth/session';
import type { AiContext } from '../domain/ai-draft';
import { hasOnlyDataKeys, isAiCounter, isImageSha256 } from '../domain/ai-analysis';
import { canAnalyze, isAiCode, isProfileVersion, parseAiStatus, parseAnalysisReply, type AiCode } from '../domain/ai-controls';
import { isUuid } from '../domain/wardrobe';
import type { AnalyzedSaveAttempt } from '../domain/analyzed-save';
import type { PreparedPhoto } from '../images/process-jpeg';
import type { AppClient } from './client';
import { readConfiguration, type PublicConfig } from './config';
import { AppError } from './errors';

export class AiError extends AppError {
  constructor(readonly code: AiCode) { super(code === 'TIMEOUT' ? 'aiC.uncertain' : 'aiC.unavailable'); }
}
export type AiConsentWrite = Readonly<{ enabled: boolean; noticeRevision: number | null; expectedVersion: number }>;
export class AiClient {
  private readonly identity: { ownerId: string; epoch: number };
  constructor(private client: AppClient, private config: PublicConfig, readonly scope: OwnerScope) {
    this.identity = { ownerId: scope.ownerId, epoch: scope.epoch };
    const checked = readConfiguration({ VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey });
    if (checked.status !== 'ready' || checked.value.url !== config.url || !isUuid(scope.ownerId)) throw new AiError('UNAVAILABLE');
  }
  private checkIdentity() {
    if (this.scope.signal.aborted || this.scope.ownerId !== this.identity.ownerId || this.scope.epoch !== this.identity.epoch) throw new AiError('UNAVAILABLE');
  }
  private async bounded<T>(ms: number, operation: (signal: AbortSignal, wait: <R>(work: PromiseLike<R>) => Promise<R>) => Promise<T>,
    outer?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    this.checkIdentity();
    const timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([this.scope.signal, controller.signal, ...(outer ? [outer] : [])]);
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new AiError(this.scope.signal.aborted ? 'UNAVAILABLE' : 'TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const wait = async <R>(work: PromiseLike<R>): Promise<R> => {
      const result = await Promise.race([Promise.resolve(work), stopped]);
      this.checkIdentity();
      if (signal.aborted) throw new AiError('TIMEOUT');
      return result;
    };
    try { return await wait(operation(signal, wait)); }
    catch (error) { throw error instanceof AiError ? error : new AiError(signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async request(path: '/rest/v1/rpc/ai_status' | '/rest/v1/rpc/ai_set_consent'
    | '/rest/v1/rpc/ai_analysis_status' | '/rest/v1/rpc/ai_request_control' | '/functions/v1/analyze-clothing',
    body: object | Blob, ms: number, extra: Record<string, string> = {}, outer?: AbortSignal) {
    return this.bounded(ms, async (signal, wait) => {
      if (signal.aborted) throw new AiError('TIMEOUT');
      let auth = await wait(this.client.auth.getSession());
      if (auth.error || !auth.data.session || auth.data.session.user.id !== this.scope.ownerId) throw new AiError('UNAUTHENTICATED');
      if ((auth.data.session.expires_at ?? 0) * 1000 <= Date.now() + ms) {
        auth = await wait(this.client.auth.refreshSession());
      }
      const session = auth.data.session;
      if (auth.error || !session || session.user.id !== this.scope.ownerId || signal.aborted) throw new AiError('UNAUTHENTICATED');
      const response = await wait(fetch(`${this.config.url}${path}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal,
        headers: { apikey: this.config.publishableKey, Authorization: `Bearer ${session.access_token}`,
          Accept: 'application/json', 'Content-Type': body instanceof Blob ? 'image/jpeg' : 'application/json', ...extra },
        body: body instanceof Blob ? body : JSON.stringify(body),
      }));
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
        if (response.body) await wait(response.body.cancel());
        throw new AiError('UNAVAILABLE');
      }
      const reader = response.body.getReader();
      let failed = false, text = '', bytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for (;;) {
          const part = await wait(reader.read());
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 32768) throw new AiError('UNAVAILABLE');
          text += decoder.decode(part.value, { stream: true });
        }
        const value: unknown = JSON.parse(text + decoder.decode());
        return { status: response.status, value };
      } catch (error) { failed = true; throw error; }
      finally {
        try { await wait(reader.cancel()); }
        catch (error) { if (!failed) throw error; }
        finally { reader.releaseLock(); }
      }
    }, outer);
  }
  async status(signal?: AbortSignal) {
    const reply = await this.request('/rest/v1/rpc/ai_status', {}, 5000, {}, signal);
    const value = parseAiStatus(reply.value);
    if (reply.status !== 200 || !value) throw new AiError('UNAVAILABLE');
    return value;
  }
  async consent(write: AiConsentWrite, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(write.expectedVersion) || write.expectedVersion < 1
      || (write.enabled ? !isAiCounter(write.noticeRevision) : write.noticeRevision !== null)) throw new AiError('INVALID_INPUT');
    const reply = await this.request('/rest/v1/rpc/ai_set_consent', {
      p_enabled: write.enabled, p_notice_revision: write.noticeRevision, p_expected_version: write.expectedVersion,
    }, 5000, {}, signal);
    if (reply.status !== 200 || !hasOnlyDataKeys(reply.value, ['code', 'profileVersion'])
      || reply.value.code !== 'OK' || !isProfileVersion(reply.value.profileVersion)) {
      throw new AiError(hasOnlyDataKeys(reply.value, ['code']) && isAiCode(reply.value.code) ? reply.value.code : 'UNAVAILABLE');
    }
    return reply.value.profileVersion;
  }
  async analyze(context: AiContext, photo: PreparedPhoto, signal?: AbortSignal) {
    if (context.ownerId !== this.scope.ownerId || context.epoch !== this.scope.epoch || !isUuid(context.requestId)
      || !isUuid(context.draftId) || !isAiCounter(context.generation) || !isImageSha256(context.imageSha256)
      || context.imageSha256 !== photo.mainSha256 || photo.main.type !== 'image/jpeg'
      || photo.main.size < 1 || photo.main.size > 512000) throw new AiError('INVALID_INPUT');
    return this.bounded(25000, async (budget) => {
      const status = await this.status(budget);
      if (!canAnalyze(status)) throw new AiError(status.code === 'OK' ? 'CONFIG_CHANGED' : status.code);
      const reply = await this.request('/functions/v1/analyze-clothing', photo.main, 25000, {
        'X-Stillroom-Request-Id': context.requestId, 'X-Stillroom-Draft-Id': context.draftId,
        'X-Stillroom-Generation': String(context.generation),
      }, budget);
      const value = parseAnalysisReply(reply.value);
      if (!value) throw new AiError('UNAVAILABLE');
      if (value.code !== 'OK') throw new AiError(value.code);
      if (reply.status !== (value.status === 'ready' ? 200 : 202)) throw new AiError('UNAVAILABLE');
      this.bindReply(context, value.result);
      return value;
    }, signal);
  }
  private bindReply(context: AiContext, result: { requestId: string; draftId: string; generation: number; imageSha256: string } | null) {
    if (context.ownerId !== this.scope.ownerId || context.epoch !== this.scope.epoch
      || result && (result.requestId !== context.requestId || result.draftId !== context.draftId
        || result.generation !== context.generation || result.imageSha256 !== context.imageSha256)) throw new AiError('CONFLICT');
  }
  async analysisStatus(context: AiContext, signal?: AbortSignal) {
    this.bindReply(context, null);
    if (!isUuid(context.requestId)) throw new AiError('INVALID_INPUT');
    const reply = await this.request('/rest/v1/rpc/ai_analysis_status', { p_request_id: context.requestId }, 5000, {}, signal);
    const value = parseAnalysisReply(reply.value);
    if (reply.status !== 200 || !value) throw new AiError('UNAVAILABLE');
    if (value.code === 'OK') this.bindReply(context, value.result);
    return value;
  }
  async discard(context: AiContext, signal?: AbortSignal): Promise<void> {
    this.bindReply(context, null);
    if (!isUuid(context.requestId)) throw new AiError('INVALID_INPUT');
    const reply = await this.request('/rest/v1/rpc/ai_request_control', {
      p_request_id: context.requestId, p_action: 'discard',
    }, 5000, {}, signal);
    const value = parseAnalysisReply(reply.value);
    if (reply.status !== 200 || value?.code !== 'TERMINAL' || value.reason === undefined) {
      throw new AiError('UNAVAILABLE');
    }
  }
  async cancel(attempt: AnalyzedSaveAttempt, fingerprint: string): Promise<void> {
    if (attempt.ownerId !== this.scope.ownerId || attempt.epoch !== this.scope.epoch || !isImageSha256(fingerprint)) throw new AiError('CONFLICT');
    await this.bounded(5000, async (signal, wait) => {
      const reply = await wait(this.client.rpc('cancel_analyzed_item_save', {
        p_item_id: attempt.itemId, p_image_id: attempt.imageId, p_fingerprint: fingerprint,
      }).abortSignal(signal));
      if (reply.error || reply.data !== null) throw new AiError('CONFLICT');
    });
  }
}
