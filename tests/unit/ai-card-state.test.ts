import { describe, expect, it } from 'vitest';
import { aiCardState, aiPolicyBinding, azureAiManifest, azureAiModel, azureAiReviewExpires, type AiStatus } from '../../src/domain/ai-controls';

const now = Date.parse('2026-09-24T12:00:00Z');
const policy = { activated: true, noticeRevision: 2, modelId: azureAiModel, promptVersion: 2, maxRequestMicro: '4097351',
  monthlyAllowanceMicro: '20000000', maxRequestsPerHour: 30, resultTtlSeconds: 3600, executionManifestId: azureAiManifest };
function status(overrides: { code?: AiStatus['code']; enabled?: boolean; revision?: number | null; policy?: Partial<typeof policy> | null;
  serverTimeMs?: number } = {}): AiStatus {
  const enabled = overrides.enabled ?? false;
  return {
    code: overrides.code ?? (enabled ? 'OK' : 'CONSENT_REQUIRED'), period: '2026-09', serverTimeMs: overrides.serverTimeMs ?? now,
    consent: { enabled, noticeRevision: overrides.revision !== undefined ? overrides.revision : enabled ? 2 : null,
      consentedAt: enabled ? '2026-09-01T00:00:00Z' : null, profileVersion: '3' },
    policy: overrides.policy === null ? null : { ...policy, ...overrides.policy },
    usage: { accountedMicro: '0', requestsLastHour: 0, warning: false },
  };
}
const card = (value: AiStatus | null, extra: { loadFailed?: boolean; unresolved?: boolean; now?: number } = {}) =>
  aiCardState({ status: value, loadFailed: extra.loadFailed ?? false, unresolved: extra.unresolved ?? false, now: extra.now ?? now });

describe('photo analysis card state', () => {
  it('shows each state with only its own actions', () => {
    expect(card(status({ enabled: true }))).toEqual({ state: 'on', turnOn: false, turnOff: true, retry: false, details: true });
    expect(card(status())).toEqual({ state: 'off', turnOn: true, turnOff: false, retry: false, details: true });
    expect(card(status({ enabled: true, revision: 1, code: 'CONSENT_REQUIRED' })))
      .toEqual({ state: 'renew', turnOn: true, turnOff: true, retry: false, details: true });
    expect(card(null)).toEqual({ state: 'loading', turnOn: false, turnOff: false, retry: false, details: false });
    expect(card(null, { loadFailed: true })).toEqual({ state: 'loadFailed', turnOn: false, turnOff: false, retry: true, details: false });
    expect(card(status({ code: 'UNCONFIGURED' }))).toEqual({ state: 'unavailable', turnOn: false, turnOff: false, retry: false, details: false });
    expect(card(status({ enabled: true }), { unresolved: true }))
      .toEqual({ state: 'unconfirmed', turnOn: false, turnOff: false, retry: true, details: false });
  });
  it('applies precedence: unconfirmed, loading, load failure, unavailable, on, renew, off', () => {
    expect(card(null, { unresolved: true, loadFailed: true }).state).toBe('unconfirmed');
    expect(card(status({ code: 'UNAVAILABLE' }), { unresolved: true }).state).toBe('unconfirmed');
    expect(card(null, { loadFailed: false }).state).toBe('loading');
    expect(card(status({ enabled: true, code: 'INACTIVE' })).state).toBe('unavailable');
    expect(card(status({ enabled: true, revision: 1, code: 'CONSENT_REQUIRED' })).state).toBe('renew');
    expect(card(status({ enabled: false, revision: null })).state).toBe('off');
  });
  it('offers only Turn off while unavailable when consent is still stored', () => {
    for (const code of ['UNCONFIGURED', 'INACTIVE', 'UNAVAILABLE'] as const) {
      expect(card(status({ code, enabled: true }))).toEqual({ state: 'unavailable', turnOn: false, turnOff: true, retry: false, details: false });
      expect(card(status({ code })).turnOff).toBe(false);
    }
  });
  it('treats unsupported, Google, expired and missing policies as unavailable, never renew', () => {
    expect(card(status({ policy: null, code: 'UNCONFIGURED' })).state).toBe('unavailable');
    expect(card(status({ policy: { modelId: 'unrecognized-model' } })).state).toBe('unavailable');
    expect(card(status({ policy: { noticeRevision: 1, modelId: 'gemini-3.8-flash', executionManifestId: 'google-eu-3.8-v1' } })).state)
      .toBe('unavailable');
    expect(card(status({ enabled: true, revision: 1, code: 'CONSENT_REQUIRED', policy: { modelId: 'unrecognized-model' } })).state)
      .toBe('unavailable');
    expect(card(status(), { now: azureAiReviewExpires }).state).toBe('unavailable');
    expect(card(status({ serverTimeMs: azureAiReviewExpires })).state).toBe('unavailable');
    expect(card(status({ policy: { monthlyAllowanceMicro: '0' } })).state).toBe('unavailable');
    expect(card(status({ policy: { activated: false } })).state).toBe('unavailable');
  });
  it('keeps consent on when only the monthly allowance changes', () => {
    expect(card(status({ enabled: true, policy: { monthlyAllowanceMicro: '30000000' } })).state).toBe('on');
  });
});

describe('policy binding', () => {
  const scope = { ownerId: '00000000-0000-4000-8000-000000000001', epoch: 4 };
  const base = aiPolicyBinding(scope, status());
  it('is stable for the same owner, epoch and policy', () => {
    expect(base).not.toBeNull();
    expect(aiPolicyBinding({ ...scope }, status({ enabled: true, code: 'OK' }))).toBe(base);
    expect(aiPolicyBinding(scope, { ...status(), usage: { accountedMicro: '5', requestsLastHour: 2, warning: true } })).toBe(base);
    expect(aiPolicyBinding(scope, status({ policy: { maxRequestsPerHour: 5, resultTtlSeconds: 60 } }))).toBe(base);
  });
  it.each([
    ['monthly allowance', { monthlyAllowanceMicro: '30000000' }], ['maximum request', { maxRequestMicro: '4097352' }],
    ['revision', { noticeRevision: 3 }], ['model', { modelId: 'other-model' }], ['manifest', { executionManifestId: 'other-manifest' }],
    ['prompt version', { promptVersion: 1 }],
  ] as const)('changes with the %s', (_, change) => {
    expect(aiPolicyBinding(scope, status({ policy: change }))).not.toBe(base);
  });
  it('changes with the owner or epoch and is null without a policy', () => {
    expect(aiPolicyBinding({ ...scope, epoch: 5 }, status())).not.toBe(base);
    expect(aiPolicyBinding({ ...scope, ownerId: '00000000-0000-4000-8000-000000000002' }, status())).not.toBe(base);
    expect(aiPolicyBinding(scope, status({ policy: null }))).toBeNull();
  });
});
