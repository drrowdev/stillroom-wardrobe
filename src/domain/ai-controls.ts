import { hasOnlyDataKeys, isAiCounter, isAiTimestamp, parseAiResult, type AiResult } from './ai-analysis';
import { freezeValues } from './garment-fields';

export const aiModel = 'gemini-3.8-flash';
export const aiReviewExpires = Date.parse('2027-01-01T00:00:00Z');
export const aiCodes = ['OK', 'UNAVAILABLE', 'UNAUTHENTICATED', 'INVALID_INPUT', 'CONSENT_REQUIRED',
  'UNCONFIGURED', 'INACTIVE', 'CONFIG_CHANGED', 'CONFLICT', 'ACTIVE_DRAFT', 'RATE_LIMIT',
  'ALLOWANCE', 'TERMINAL', 'TOO_LARGE', 'UNSUPPORTED_MEDIA', 'ANALYSIS_FAILED', 'TIMEOUT'] as const;
export type AiCode = typeof aiCodes[number];
export function isAiCode(value: unknown): value is AiCode { return aiCodes.some((code) => code === value); }
export function isMicro(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,63})$/.test(value);
}
export function isProfileVersion(value: unknown): value is string {
  return isMicro(value) && value !== '0' && BigInt(value) <= 9223372036854775807n;
}
export type AiPolicy = Readonly<{
  activated: boolean; noticeRevision: number; modelId: string; promptVersion: number;
  maxRequestMicro: string; monthlyAllowanceMicro: string; maxRequestsPerHour: number; resultTtlSeconds: number;
}>;
export type AiStatus = Readonly<{
  code: AiCode; period: string; serverTimeMs: number;
  consent: Readonly<{ enabled: boolean; noticeRevision: number | null; consentedAt: string | null; profileVersion: string }>;
  policy: AiPolicy | null;
  usage: Readonly<{ accountedMicro: string; requestsLastHour: number; warning: boolean }>;
}>;
export type AiAccounting = Readonly<{ basis: 'held' | 'estimated' | 'confirmed'; amountMicro: string; currency: 'USD' }>;
export type AiAnalysisReply =
  | Readonly<{ code: 'OK'; status: 'dispatched' | 'ready'; result: AiResult | null; accounting: AiAccounting }>
  | Readonly<{ code: Exclude<AiCode, 'OK'>; reason?: string }>;

export function parseAiStatus(value: unknown): AiStatus | null {
  if (!hasOnlyDataKeys(value, ['code', 'period', 'serverTimeMs', 'consent', 'policy', 'usage'])
    || !isAiCode(value.code) || typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)
    || !isAiTimestamp(value.serverTimeMs)) return null;
  const c = value.consent, p = value.policy, u = value.usage;
  if (!hasOnlyDataKeys(c, ['enabled', 'noticeRevision', 'consentedAt', 'profileVersion'])
    || typeof c.enabled !== 'boolean' || !(c.noticeRevision === null || isAiCounter(c.noticeRevision))
    || !(c.consentedAt === null || typeof c.consentedAt === 'string' && Number.isFinite(Date.parse(c.consentedAt)))
    || !isProfileVersion(c.profileVersion)
    || !hasOnlyDataKeys(u, ['accountedMicro', 'requestsLastHour', 'warning']) || !isMicro(u.accountedMicro)
    || !isAiTimestamp(u.requestsLastHour) || typeof u.warning !== 'boolean') return null;
  let policy: AiPolicy | null = null;
  if (p !== null) {
    if (!hasOnlyDataKeys(p, ['activated', 'noticeRevision', 'modelId', 'promptVersion', 'maxRequestMicro',
      'monthlyAllowanceMicro', 'maxRequestsPerHour', 'resultTtlSeconds']) || typeof p.activated !== 'boolean'
      || !isAiCounter(p.noticeRevision) || typeof p.modelId !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(p.modelId)
      || !isAiCounter(p.promptVersion) || !isMicro(p.maxRequestMicro) || !isMicro(p.monthlyAllowanceMicro)
      || !isAiCounter(p.maxRequestsPerHour) || !isAiCounter(p.resultTtlSeconds) || p.resultTtlSeconds > 86400) return null;
    policy = { activated: p.activated, noticeRevision: p.noticeRevision, modelId: p.modelId,
      promptVersion: p.promptVersion, maxRequestMicro: p.maxRequestMicro, monthlyAllowanceMicro: p.monthlyAllowanceMicro,
      maxRequestsPerHour: p.maxRequestsPerHour, resultTtlSeconds: p.resultTtlSeconds };
  }
  return freezeValues({ code: value.code, period: value.period, serverTimeMs: value.serverTimeMs,
    consent: { enabled: c.enabled, noticeRevision: c.noticeRevision, consentedAt: c.consentedAt, profileVersion: c.profileVersion },
    policy, usage: { accountedMicro: u.accountedMicro, requestsLastHour: u.requestsLastHour, warning: u.warning } });
}
export function supportedAiPolicy(status: AiStatus, now = Date.now()): boolean {
  const p = status.policy;
  return !!p && p.activated && p.modelId === aiModel && p.promptVersion === 1 && p.noticeRevision === 1
    && BigInt(p.maxRequestMicro) >= 2270823n && BigInt(p.monthlyAllowanceMicro) > 0n
    && now < aiReviewExpires && status.serverTimeMs < aiReviewExpires;
}
export function canAnalyze(status: AiStatus, now = Date.now()): boolean {
  return supportedAiPolicy(status, now) && status.code === 'OK' && status.consent.enabled
    && status.consent.noticeRevision === status.policy?.noticeRevision;
}
export function parseAnalysisReply(value: unknown): AiAnalysisReply | null {
  if (!hasOnlyDataKeys(value, ['code', 'status', 'result', 'accounting'], ['code']) || !isAiCode(value.code)) {
    if (hasOnlyDataKeys(value, ['code', 'reason']) && value.code === 'TERMINAL'
      && typeof value.reason === 'string' && ['DISCARDED', 'EXPIRED', 'FAILED', 'UNAVAILABLE', 'INVALID_FACTS'].includes(value.reason)) {
      return { code: 'TERMINAL', reason: value.reason };
    }
    return null;
  }
  if (value.code !== 'OK') return Object.keys(value).length === 1 ? { code: value.code } : null;
  if (Object.keys(value).length !== 4 || value.status !== 'dispatched' && value.status !== 'ready') return null;
  const a = value.accounting;
  if (!hasOnlyDataKeys(a, ['basis', 'amountMicro', 'currency'])
    || a.basis !== 'held' && a.basis !== 'estimated' && a.basis !== 'confirmed'
    || !isMicro(a.amountMicro) || a.currency !== 'USD') return null;
  const parsed = value.result === null ? null : parseAiResult(value.result);
  if (value.status === 'ready' ? !parsed?.ok : value.result !== null) return null;
  if (parsed?.ok && (parsed.value.modelId !== aiModel || parsed.value.promptVersion !== 1)) return null;
  return freezeValues({ code: 'OK', status: value.status, result: parsed?.ok ? parsed.value : null,
    accounting: { basis: a.basis, amountMicro: a.amountMicro, currency: 'USD' } });
}
