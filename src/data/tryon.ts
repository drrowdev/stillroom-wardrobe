// VTO-2: owner- and epoch-scoped calls for virtual try-on (plan rev4 §2-§3): status, consent, the try-on step POST,
// chain reconciliation, Stop and the owner's results. The same session, identity and bounded-response rules as
// src/data/enhancement.ts. The strict parsers below accept only the closed replies of 20261003090000_try_on.sql; the
// server's checks stay authoritative, and nothing here decides eligibility on its own.
import type { OwnerScope } from '../auth/session';
import { TRYON_LIMITS, TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION, TRYON_REVIEW_EXPIRES_AT, tryOnSlots, type TryOnSlot } from '../domain/tryon';
import { isUuid } from '../domain/wardrobe';
import type { AppClient } from './client';
import { readConfiguration, type PublicConfig } from './config';

export const tryOnCodes = ['OK', 'INVALID_INPUT', 'UNAUTHENTICATED', 'UNAVAILABLE', 'CONSENT_REQUIRED', 'NOT_FOUND', 'TERMINAL',
  'CONFLICT', 'CHAIN_MISMATCH', 'WITHDRAWN', 'CANCELLED', 'EXPIRED', 'RESULTS_FULL', 'TOO_LARGE', 'UNSUPPORTED_MEDIA',
  'NO_GARMENTS', 'FILTERED', 'OUTPUT_REJECTED', 'RATE_LIMIT', 'ALLOWANCE', 'FAILED', 'UNCONFIGURED', 'INACTIVE',
  'CONFIG_CHANGED', 'BUSY', 'TIMEOUT'] as const;
export type TryOnCode = (typeof tryOnCodes)[number];
export class TryOnError extends Error {
  constructor(readonly code: TryOnCode) { super(code); this.name = 'TryOnError'; }
}

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is JsonObject => record(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const micro = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && isUuid(value);

export const tryOnStatusCodes = ['OK', 'UNAVAILABLE', 'UNCONFIGURED', 'INACTIVE', 'CONSENT_REQUIRED'] as const;
export type TryOnStatusCode = (typeof tryOnStatusCodes)[number];
export type TryOnPolicy = {
  activated: boolean; noticeRevision: number | null; manifestId: string; modelId: string | null; maxRequestMicro: string | null;
  tryOnAllowanceMicro: string | null; totalAllowanceMicro: string; maxRequestsPerHour: number | null; maxSteps: number;
  maxResults: number; resultDays: number; providerAvailable: boolean;
};
export type TryOnStatus = {
  code: TryOnStatusCode; serverTimeMs: number | null;
  consent: { enabled: boolean; noticeRevision: number | null } | null;
  policy: TryOnPolicy | null; results: number;
  usage: { tryOnMicro: string; totalMicro: string; tryOnLastHour: number; warning: boolean } | null;
};

const nullableMicro = (value: unknown): value is string | null => value === null || micro(value);

/** Parses the closed `tryon_status` reply; null for anything else. UNAVAILABLE carries only its code. */
export function parseTryOnStatus(value: unknown): TryOnStatus | null {
  if (exactKeys(value, ['code'])) {
    return value.code === 'UNAVAILABLE'
      ? { code: 'UNAVAILABLE', serverTimeMs: null, consent: null, policy: null, results: 0, usage: null } : null;
  }
  if (!exactKeys(value, ['code', 'period', 'serverTimeMs', 'consent', 'policy', 'results', 'usage'])) return null;
  const code = tryOnStatusCodes.find((entry) => entry === value.code);
  if (!code || code === 'UNAVAILABLE' || typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)
    || !count(value.serverTimeMs) || !count(value.results)) return null;
  const c = value.consent, p = value.policy, u = value.usage;
  if (!exactKeys(c, ['enabled', 'noticeRevision', 'consentedAt']) || typeof c.enabled !== 'boolean'
    || !(c.noticeRevision === null || revision(c.noticeRevision)) || c.enabled !== (c.noticeRevision !== null)
    || !(c.consentedAt === null || typeof c.consentedAt === 'string') || (c.consentedAt === null) !== (c.noticeRevision === null)) return null;
  if (!exactKeys(u, ['tryOnMicro', 'totalMicro', 'tryOnLastHour', 'warning']) || !micro(u.tryOnMicro) || !micro(u.totalMicro)
    || !count(u.tryOnLastHour) || typeof u.warning !== 'boolean') return null;
  let policy: TryOnPolicy | null = null;
  if (p !== null) {
    if (!exactKeys(p, ['activated', 'noticeRevision', 'manifestId', 'modelId', 'maxRequestMicro', 'tryOnAllowanceMicro',
      'totalAllowanceMicro', 'maxRequestsPerHour', 'maxSteps', 'maxResults', 'resultDays', 'providerAvailable'])
      || typeof p.activated !== 'boolean' || !(p.noticeRevision === null || revision(p.noticeRevision))
      || typeof p.manifestId !== 'string' || !(p.modelId === null || typeof p.modelId === 'string')
      || !nullableMicro(p.maxRequestMicro) || !nullableMicro(p.tryOnAllowanceMicro) || !micro(p.totalAllowanceMicro)
      || !(p.maxRequestsPerHour === null || count(p.maxRequestsPerHour)) || p.maxSteps !== 3 || p.maxResults !== 20
      || p.resultDays !== TRYON_LIMITS.resultDays || typeof p.providerAvailable !== 'boolean') return null;
    policy = { activated: p.activated, noticeRevision: p.noticeRevision, manifestId: p.manifestId, modelId: p.modelId,
      maxRequestMicro: p.maxRequestMicro, tryOnAllowanceMicro: p.tryOnAllowanceMicro, totalAllowanceMicro: p.totalAllowanceMicro,
      maxRequestsPerHour: p.maxRequestsPerHour, maxSteps: p.maxSteps, maxResults: p.maxResults, resultDays: p.resultDays,
      providerAvailable: p.providerAvailable };
  }
  if ((code === 'OK' || code === 'INACTIVE' || code === 'CONSENT_REQUIRED') && policy === null) return null;
  return { code, serverTimeMs: value.serverTimeMs, consent: { enabled: c.enabled, noticeRevision: c.noticeRevision }, policy,
    results: value.results,
    usage: { tryOnMicro: u.tryOnMicro, totalMicro: u.totalMicro, tryOnLastHour: u.tryOnLastHour, warning: u.warning } };
}

/** The policy this app version has a notice for: the reviewed manifest, model and notice revision, before review expiry. */
export function supportedTryOnPolicy(status: TryOnStatus): boolean {
  const p = status.policy;
  return p !== null && p.noticeRevision === TRYON_NOTICE_REVISION && p.manifestId === TRYON_MANIFEST && p.modelId === TRYON_MODEL
    && status.serverTimeMs !== null && status.serverTimeMs < Date.parse(TRYON_REVIEW_EXPIRES_AT);
}
const consented = (status: TryOnStatus) => status.consent?.enabled === true && status.policy !== null
  && status.consent.noticeRevision === status.policy.noticeRevision;
/** Try on is offered only while the status says a step may be tried: activated, consented, supported and available. */
export function tryOnReady(status: TryOnStatus | null): boolean {
  return status !== null && status.code === 'OK' && status.policy?.activated === true && consented(status)
    && status.policy.providerAvailable && supportedTryOnPolicy(status);
}

/** The Settings card: separate use, enable and withdraw, as for enhancement (M1). */
export type TryOnRead = { kind: 'unknown' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; status: TryOnStatus };
export type TryOnViewKind = 'hidden' | 'loadFailed' | 'unresolved' | 'off' | 'renew' | 'on' | 'paused';
export type TryOnView = { kind: TryOnViewKind; turnOn: boolean; turnOff: boolean };
export function tryOnView(read: TryOnRead, unresolved: boolean, shownBefore: boolean, consentKnownOn: boolean): TryOnView {
  const hidden: TryOnView = { kind: 'hidden', turnOn: false, turnOff: false };
  if (unresolved) return { kind: 'unresolved', turnOn: false, turnOff: consentKnownOn };
  if (read.kind === 'unknown' || read.kind === 'missing') return hidden;
  if (read.kind === 'failed') return shownBefore ? { kind: 'loadFailed', turnOn: false, turnOff: consentKnownOn } : hidden;
  const status = read.status;
  const on = status.consent?.enabled === true;
  const paused: TryOnView = { kind: 'paused', turnOn: false, turnOff: true };
  // Not activated or unavailable: nothing to turn on, but consent given earlier can always be withdrawn.
  if (!status.policy || status.code === 'UNAVAILABLE' || !status.policy.activated) return on ? paused : hidden;
  if (on && consented(status)) return tryOnReady(status) ? { kind: 'on', turnOn: false, turnOff: true } : paused;
  if (!supportedTryOnPolicy(status)) return on ? paused : hidden;
  return { kind: on ? 'renew' : 'off', turnOn: true, turnOff: on };
}

export const chainStates = ['running', 'complete', 'cancelled', 'withdrawn', 'expired', 'stale'] as const;
export type ChainState = (typeof chainStates)[number];
export type ChainStatus = { kind: 'chain'; state: ChainState; nextStep: number; steps: { slot: TryOnSlot; itemId: string }[];
  activeAttempt: boolean; resultId: string | null; expiresAtMs: number } | { kind: 'code'; code: 'NOT_FOUND' | 'UNAVAILABLE' };

export function parseChainStatus(value: unknown): ChainStatus | null {
  if (exactKeys(value, ['code'])) {
    return value.code === 'NOT_FOUND' || value.code === 'UNAVAILABLE' ? { kind: 'code', code: value.code } : null;
  }
  if (!exactKeys(value, ['code', 'state', 'nextStep', 'steps', 'activeAttempt', 'resultId', 'expiresAtMs']) || value.code !== 'OK') return null;
  const state = chainStates.find((entry) => entry === value.state);
  if (!state || !count(value.nextStep) || value.nextStep < 1 || value.nextStep > 4 || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > 3 || typeof value.activeAttempt !== 'boolean'
    || !(value.resultId === null || uuid(value.resultId)) || !count(value.expiresAtMs)) return null;
  const steps: { slot: TryOnSlot; itemId: string }[] = [];
  for (const step of value.steps as unknown[]) {
    const slot = exactKeys(step, ['slot', 'itemId']) ? tryOnSlots.find((entry) => entry === step.slot) : undefined;
    if (!slot || !uuid((step as JsonObject).itemId)) return null;
    steps.push({ slot, itemId: (step as JsonObject).itemId as string });
  }
  return { kind: 'chain', state, nextStep: value.nextStep, steps, activeAttempt: value.activeAttempt,
    resultId: value.resultId as string | null, expiresAtMs: value.expiresAtMs };
}

export type CancelResult = { code: 'CANCELLED' } | { code: 'COMPLETED'; resultId: string | null }
  | { code: 'NOT_FOUND' | 'UNAVAILABLE' | 'WITHDRAWN' | 'EXPIRED' | 'STALE' };
export function parseCancel(value: unknown): CancelResult | null {
  if (exactKeys(value, ['code', 'resultId'])) {
    return value.code === 'COMPLETED' && (value.resultId === null || uuid(value.resultId))
      ? { code: 'COMPLETED', resultId: value.resultId as string | null } : null;
  }
  if (!exactKeys(value, ['code'])) return null;
  const code = (['CANCELLED', 'NOT_FOUND', 'UNAVAILABLE', 'WITHDRAWN', 'EXPIRED', 'STALE'] as const).find((entry) => entry === value.code);
  return code ? { code } as CancelResult : null;
}

export type TryOnResult = { id: string; outfitId: string; itemIds: string[]; bytes: number; completedAtMs: number; expiresAtMs: number };
export function parseResults(value: unknown): TryOnResult[] | null {
  if (!exactKeys(value, ['code', 'results']) || value.code !== 'OK' || !Array.isArray(value.results) || value.results.length > 20) return null;
  const results: TryOnResult[] = [];
  for (const entry of value.results as unknown[]) {
    if (!exactKeys(entry, ['id', 'outfitId', 'itemIds', 'bytes', 'completedAtMs', 'expiresAtMs']) || !uuid(entry.id)
      || !uuid(entry.outfitId) || !Array.isArray(entry.itemIds) || entry.itemIds.length < 1 || entry.itemIds.length > 3
      || !entry.itemIds.every(uuid) || !count(entry.bytes) || entry.bytes < 1 || entry.bytes > TRYON_LIMITS.outputBytes
      || !count(entry.completedAtMs) || !count(entry.expiresAtMs)) return null;
    results.push({ id: entry.id, outfitId: entry.outfitId, itemIds: [...entry.itemIds as string[]], bytes: entry.bytes,
      completedAtMs: entry.completedAtMs, expiresAtMs: entry.expiresAtMs });
  }
  return results;
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}
export type ResultImage = { kind: 'image'; bytes: Uint8Array<ArrayBuffer> } | { kind: 'code'; code: 'NOT_FOUND' | 'UNAVAILABLE' };
export function parseResultImage(value: unknown): ResultImage | null {
  if (exactKeys(value, ['code'])) {
    return value.code === 'NOT_FOUND' || value.code === 'UNAVAILABLE' ? { kind: 'code', code: value.code } : null;
  }
  if (!exactKeys(value, ['code', 'jpegBase64', 'bytes']) || value.code !== 'OK' || typeof value.jpegBase64 !== 'string'
    || !count(value.bytes) || value.bytes < 1 || value.bytes > TRYON_LIMITS.outputBytes) return null;
  const bytes = base64Bytes(value.jpegBase64);
  if (!bytes || bytes.length !== value.bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return { kind: 'image', bytes };
}

/** One step's reply: the intermediate picture for the next step, the final result, or a closed code. */
export type StepResponse = { kind: 'intermediate'; body: Uint8Array<ArrayBuffer>; sha256: string }
  | { kind: 'result'; resultId: string; expiresAtMs: number } | { kind: 'code'; code: Exclude<TryOnCode, 'OK'> };
export type StepInput = { chainId: string; step: number; requestId: string; person: Uint8Array<ArrayBuffer>; outfitId?: string };
export type TryOnStatusRead = { kind: 'missing' } | { kind: 'ready'; status: TryOnStatus };
export type TryOnConsentResult = { kind: 'applied'; status: TryOnStatus }
  | { kind: 'refused'; code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'UNCONFIGURED' | 'CONFIG_CHANGED' };
const refusals = ['UNAVAILABLE', 'INVALID_INPUT', 'UNCONFIGURED', 'CONFIG_CHANGED'] as const;
const closed = (value: unknown): Exclude<TryOnCode, 'OK'> => {
  const code = tryOnCodes.find((entry) => entry === value);
  return code && code !== 'OK' ? code : 'FAILED';
};
type RpcName = 'tryon_status' | 'tryon_set_consent' | 'tryon_chain_status' | 'tryon_cancel' | 'tryon_results_v1'
  | 'tryon_result_image_v1' | 'tryon_delete_result';
// A result image is at most 512,000 bytes, so its base64 JSON stays under 700,000.
const RESULT_JSON_BYTES = 700_000;

type Wait = <R>(work: PromiseLike<R>) => Promise<R>;
export class TryOnClient {
  private readonly identity: { ownerId: string; epoch: number };
  constructor(private readonly client: AppClient, private readonly config: PublicConfig, readonly scope: OwnerScope) {
    this.identity = { ownerId: scope.ownerId, epoch: scope.epoch };
    const checked = readConfiguration({ VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey });
    if (checked.status !== 'ready' || checked.value.url !== config.url || !isUuid(scope.ownerId)) throw new TryOnError('UNAVAILABLE');
  }
  /** False once the owner or session epoch changed: late replies are then dropped unread. */
  current(): boolean {
    return !this.scope.signal.aborted && this.scope.ownerId === this.identity.ownerId && this.scope.epoch === this.identity.epoch;
  }
  private checkIdentity() {
    if (!this.current()) throw new TryOnError('UNAVAILABLE');
  }
  private async bounded<T>(ms: number, outer: AbortSignal | undefined, operation: (signal: AbortSignal, wait: Wait) => Promise<T>): Promise<T> {
    this.checkIdentity();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([this.scope.signal, controller.signal, ...(outer ? [outer] : [])]);
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new TryOnError(this.scope.signal.aborted || outer?.aborted ? 'UNAVAILABLE' : 'TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    stopped.catch(() => undefined);
    const wait: Wait = async (work) => {
      const result = await Promise.race([Promise.resolve(work), stopped]);
      this.checkIdentity();
      if (signal.aborted) throw new TryOnError(outer?.aborted ? 'UNAVAILABLE' : 'TIMEOUT');
      return result;
    };
    try { return await wait(operation(signal, wait)); }
    catch (error) {
      if (error instanceof TryOnError) throw error;
      throw new TryOnError(signal.aborted && !outer?.aborted && !this.scope.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
  private async bearer(ms: number, wait: Wait): Promise<string> {
    const cached = await wait(this.client.auth.getSession());
    if (cached.error || !cached.data.session || cached.data.session.user.id !== this.scope.ownerId) throw new TryOnError('UNAUTHENTICATED');
    let session = cached.data.session;
    if ((session.expires_at ?? 0) * 1000 <= Date.now() + ms) {
      const refreshed = await wait(this.client.auth.refreshSession());
      if (refreshed.error || !refreshed.data.session) throw new TryOnError('UNAUTHENTICATED');
      session = refreshed.data.session;
    }
    if (session.user.id !== this.scope.ownerId) throw new TryOnError('UNAUTHENTICATED');
    return session.access_token;
  }
  private headers(token: string, extra: Record<string, string>) {
    return { apikey: this.config.publishableKey, Authorization: `Bearer ${token}`, ...extra };
  }
  private async readBody(response: Response, limit: number, wait: Wait): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.body) throw new TryOnError('FAILED');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        // Content-Length isn't trusted: the cap is applied while reading and the reader is cancelled at once.
        if (bytes > limit) throw new TryOnError('OUTPUT_REJECTED');
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
  private async json(response: Response, wait: Wait, limit = 32768): Promise<unknown> {
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      if (response.body) await wait(response.body.cancel());
      throw new TryOnError('UNAVAILABLE');
    }
    const body = await this.readBody(response, limit, wait).catch((error: unknown) => {
      throw error instanceof TryOnError && error.code === 'OUTPUT_REJECTED' ? new TryOnError('UNAVAILABLE') : error;
    });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new TryOnError('UNAVAILABLE'); }
  }
  private rpc(path: RpcName, body: object, outer?: AbortSignal, limit = 32768) {
    return this.bounded(path === 'tryon_result_image_v1' ? 15000 : 5000, outer, async (signal, wait) => {
      const token = await this.bearer(5000, wait);
      const response = await wait(fetch(`${this.config.url}/rest/v1/rpc/${path}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal,
        headers: this.headers(token, { Accept: 'application/json', 'Content-Type': 'application/json' }), body: JSON.stringify(body),
      }));
      return { status: response.status, value: await this.json(response, wait, limit) };
    });
  }
  /** `missing` is only PostgREST's "function not found": this backend has no try-on. Other failures throw. */
  async status(signal?: AbortSignal): Promise<TryOnStatusRead> {
    const reply = await this.rpc('tryon_status', {}, signal);
    if (reply.status === 404 && record(reply.value) && reply.value.code === 'PGRST202') return { kind: 'missing' };
    const status = reply.status === 200 ? parseTryOnStatus(reply.value) : null;
    if (!status) throw new TryOnError('UNAVAILABLE');
    return { kind: 'ready', status };
  }
  /** Turns try-on on for the current notice, or off. A thrown error means the outcome is unknown. */
  async consent(enabled: boolean, signal?: AbortSignal): Promise<TryOnConsentResult> {
    const reply = await this.rpc('tryon_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? TRYON_NOTICE_REVISION : null }, signal);
    if (reply.status === 200 && exactKeys(reply.value, ['code'])) {
      const code = refusals.find((entry) => entry === (reply.value as JsonObject).code);
      if (code) return { kind: 'refused', code };
    }
    const status = reply.status === 200 ? parseTryOnStatus(reply.value) : null;
    if (!status || status.code === 'UNAVAILABLE') throw new TryOnError('UNAVAILABLE');
    return { kind: 'applied', status };
  }
  async chainStatus(chainId: string, signal?: AbortSignal): Promise<ChainStatus> {
    if (!isUuid(chainId)) throw new TryOnError('INVALID_INPUT');
    const reply = await this.rpc('tryon_chain_status', { p_chain_id: chainId }, signal);
    const parsed = reply.status === 200 ? parseChainStatus(reply.value) : null;
    if (!parsed) throw new TryOnError('UNAVAILABLE');
    return parsed;
  }
  async cancel(chainId: string, signal?: AbortSignal): Promise<CancelResult> {
    if (!isUuid(chainId)) throw new TryOnError('INVALID_INPUT');
    const reply = await this.rpc('tryon_cancel', { p_chain_id: chainId }, signal);
    const parsed = reply.status === 200 ? parseCancel(reply.value) : null;
    if (!parsed) throw new TryOnError('UNAVAILABLE');
    return parsed;
  }
  /** The owner's unexpired results; `missing` when this backend has no try-on. */
  async results(signal?: AbortSignal): Promise<TryOnResult[] | 'missing'> {
    const reply = await this.rpc('tryon_results_v1', {}, signal);
    if (reply.status === 404 && record(reply.value) && reply.value.code === 'PGRST202') return 'missing';
    const parsed = reply.status === 200 ? parseResults(reply.value) : null;
    if (!parsed) throw new TryOnError('UNAVAILABLE');
    return parsed;
  }
  async resultImage(resultId: string, signal?: AbortSignal): Promise<ResultImage> {
    if (!isUuid(resultId)) throw new TryOnError('INVALID_INPUT');
    const reply = await this.rpc('tryon_result_image_v1', { p_result_id: resultId }, signal, RESULT_JSON_BYTES);
    const parsed = reply.status === 200 ? parseResultImage(reply.value) : null;
    if (!parsed) throw new TryOnError('UNAVAILABLE');
    return parsed;
  }
  async deleteResult(resultId: string, signal?: AbortSignal): Promise<'OK' | 'NOT_FOUND'> {
    if (!isUuid(resultId)) throw new TryOnError('INVALID_INPUT');
    const reply = await this.rpc('tryon_delete_result', { p_result_id: resultId }, signal);
    if (reply.status === 200 && exactKeys(reply.value, ['code']) && (reply.value.code === 'OK' || reply.value.code === 'NOT_FOUND')) {
      return reply.value.code;
    }
    throw new TryOnError('UNAVAILABLE');
  }
  /**
   * Sends one step once under `requestId`, with the 100-second client deadline. Step 1 carries the outfit; a later step
   * sends the previous step's picture unchanged. A thrown TIMEOUT or UNAVAILABLE means the outcome is unknown: the
   * caller reconciles through `chainStatus` and never sends the step again by itself.
   */
  async step(input: StepInput, signal: AbortSignal): Promise<StepResponse> {
    const { chainId, step, requestId, person, outfitId } = input;
    if (!isUuid(chainId) || !isUuid(requestId) || !Number.isInteger(step) || step < 1 || step > 3
      || (step === 1) !== (outfitId !== undefined) || (outfitId !== undefined && !isUuid(outfitId))
      || person.length < 4 || person.length > TRYON_LIMITS.personBytes) throw new TryOnError('INVALID_INPUT');
    return this.bounded(TRYON_LIMITS.clientStepMs, signal, async (inner, wait) => {
      const token = await this.bearer(TRYON_LIMITS.serverMs, wait);
      const form = new FormData();
      form.append('chainId', chainId);
      form.append('step', String(step));
      form.append('requestId', requestId);
      form.append('manifestId', TRYON_MANIFEST);
      if (outfitId !== undefined) form.append('outfitId', outfitId);
      form.append('person', new Blob([person], { type: 'image/jpeg' }), 'person.jpg');
      const response = await wait(fetch(`${this.config.url}/functions/v1/try-on`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: inner,
        headers: this.headers(token, { Accept: 'image/jpeg, application/json' }), body: form,
      }));
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.status === 200 && type === 'image/jpeg') {
        const sha256 = response.headers.get('X-Stillroom-TryOn-Sha256') ?? '';
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          await wait(response.body?.cancel() ?? Promise.resolve());
          return { kind: 'code', code: 'OUTPUT_REJECTED' };
        }
        try {
          const body = await this.readBody(response, TRYON_LIMITS.outputBytes, wait);
          return { kind: 'intermediate', body, sha256 };
        } catch (error) {
          if (error instanceof TryOnError && error.code === 'OUTPUT_REJECTED') return { kind: 'code', code: 'OUTPUT_REJECTED' };
          throw error;
        }
      }
      const value = await this.json(response, wait).catch(() => null);
      if (response.status === 200 && exactKeys(value, ['code', 'resultId', 'expiresAtMs']) && value.code === 'OK'
        && uuid(value.resultId) && count(value.expiresAtMs)) {
        return { kind: 'result', resultId: value.resultId, expiresAtMs: value.expiresAtMs };
      }
      return { kind: 'code', code: exactKeys(value, ['code']) ? closed(value.code) : 'FAILED' };
    });
  }
}

/** SHA-256 of bytes in memory, lower-case hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}
