import { describe, expect, it } from 'vitest';
import { SessionController, type OwnerScope, type SessionState } from '../../src/auth/session';
import type { AiClient } from '../../src/data/ai';
import type { AppClient } from '../../src/data/client';
import type { ProfileRow } from '../../src/data/rows';
import { aiCardState, aiPolicyBinding, azureAiManifest, azureAiModel, type AiStatus } from '../../src/domain/ai-controls';

const ownerId = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-09-24T12:00:00Z');
const policy = { activated: true, noticeRevision: 2, modelId: azureAiModel, promptVersion: 2, maxRequestMicro: '4097351',
  monthlyAllowanceMicro: '20000000', maxRequestsPerHour: 30, resultTtlSeconds: 3600, executionManifestId: azureAiManifest };
const profile: ProfileRow = { owner_id: ownerId, display_name: 'Alex', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR', version: 3 };
function status(allowance = '20000000', enabled = false): AiStatus {
  return { code: enabled ? 'OK' : 'CONSENT_REQUIRED', period: '2026-09', serverTimeMs: now,
    consent: { enabled, noticeRevision: enabled ? 2 : null, consentedAt: enabled ? '2026-09-01T00:00:00Z' : null, profileVersion: '3' },
    policy: { ...policy, monthlyAllowanceMicro: allowance }, usage: { accountedMicro: '0', requestsLastHour: 0, warning: false } };
}
function setup(current: AiStatus) {
  const controller = new SessionController({} as AppClient, ['en']);
  const scope: OwnerScope = { ownerId, epoch: 1, signal: new AbortController().signal };
  const state: SessionState = { phase: 'ready', language: 'en', profile, scope, languageUnsaved: false };
  (controller as unknown as { state: SessionState }).state = state;
  const writes: unknown[] = [];
  let reads = 0;
  const ai = {
    scope,
    async status() {
      reads++;
      if (writes.length) throw new Error('reply lost');
      return current;
    },
    async consent(write: unknown) { writes.push(write); return '4'; },
  } as unknown as AiClient;
  return { controller, scope, ai, writes, reads: () => reads };
}

describe('saveAiConsent binding', () => {
  it('rejects a changed policy before any consent write', async () => {
    const { controller, scope, ai, writes } = setup(status('30000000'));
    const shown = aiPolicyBinding(scope, status());
    await expect(controller.saveAiConsent(scope, profile, ai, true, 2, shown)).rejects.toMatchObject({ code: 'CONFIG_CHANGED' });
    expect(writes).toHaveLength(0);
    expect(controller.getSnapshot().aiConsentUnresolved).toBeFalsy();
    expect(controller.getSnapshot().profileSaving).toBe(false);
  });
  it('rejects Turn on without a shown policy', async () => {
    const { controller, scope, ai, writes } = setup(status());
    await expect(controller.saveAiConsent(scope, profile, ai, true, 2, null)).rejects.toMatchObject({ code: 'CONFIG_CHANGED' });
    expect(writes).toHaveLength(0);
  });
  it('sends exactly one consent write when the shown policy still matches', async () => {
    const { controller, scope, ai, writes } = setup(status());
    await expect(controller.saveAiConsent(scope, profile, ai, true, 2, aiPolicyBinding(scope, status()))).rejects.toBeTruthy();
    expect(writes).toEqual([{ enabled: true, noticeRevision: 2, expectedVersion: 3 }]);
    expect(controller.getSnapshot().aiConsentUnresolved).toBe(true);
  });
  it('rejects Turn off carrying a policy binding before any read or write', async () => {
    const { controller, scope, ai, writes, reads } = setup(status('20000000', true));
    await expect(controller.saveAiConsent(scope, profile, ai, false, null, aiPolicyBinding(scope, status())))
      .rejects.toMatchObject({ code: 'CONFIG_CHANGED' });
    expect(writes).toHaveLength(0);
    expect(reads()).toBe(0);
    expect(controller.getSnapshot().profileSaving).toBeFalsy();
  });
  it('needs no renewal when only the allowance changes while consent is on', () => {
    expect(aiCardState({ status: status('30000000', true), loadFailed: false, unresolved: false, now }).state).toBe('on');
  });
});
