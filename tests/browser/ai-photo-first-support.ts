import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { AiResult } from '../../src/domain/ai-analysis';
import { messages, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

export async function manualEntry(page: Page) {
  const language = await page.locator('html').getAttribute('lang') as Language;
  await expect(page.getByText(messages['aiC.checking'][language], { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: messages['aiC.continueManual'][language], exact: true }).click();
}
export async function aiFixture(page: Page, language: Language = 'en', enabled = true, lost?: 'reservation' | 'finalizer') {
  const results = new Map<string, AiResult>();
  const consent = new Map<string, boolean>([[owners.a, enabled], [owners.b, false]]);
  const calls: Array<{ route: string; body: unknown }> = [];
  const inputs: Array<{ owner: string; requestId: string; bytes: number; sha256: string }> = [];
  const failed = new Set<string>();
  let analysisMode: 'ready' | 'pending' | 'timeout' | 'unclear' | 'failed' = 'ready';
  let ttl = 3600000;
  const accounting = { basis: 'estimated', amountMicro: '413', currency: 'USD' };
  const api = await mockBackend(page, { initialLanguage: language, aiResults: results,
    loseAnalyzedReserveReplyOnce: lost === 'reservation', loseFinalizeReplyOnce: lost === 'finalizer',
    analysis: ({ owner, requestId, draftId, generation, bytes }) => {
      if (!consent.get(owner)) return { body: { code: 'CONSENT_REQUIRED' }, status: 403 };
      const imageSha256 = createHash('sha256').update(bytes).digest('hex');
      inputs.push({ owner, requestId, bytes: bytes.length, sha256: imageSha256 });
      calls.push({ route: '/functions/v1/analyze-clothing', body: { requestId } });
      if (analysisMode === 'failed') {
        failed.add(requestId);
        return { body: { code: 'ANALYSIS_FAILED' }, status: 502 };
      }
      const result: AiResult = { schemaVersion: 1, requestId, draftId, generation, imageSha256,
        modelId: 'gemini-3.8-flash', promptVersion: 1, createdAtMs: Date.now() - 1, expiresAtMs: Date.now() + ttl,
        facts: analysisMode === 'unclear' ? { outcome: 'unclear', fields: {} }
          : { outcome: 'ready', fields: { category: 'top', colours: ['green'], formality: 0, material: 'Cotton' } } };
      results.set(requestId, result);
      if (analysisMode === 'timeout') return { body: { code: 'TIMEOUT' }, status: 504 };
      return { body: { code: 'OK', status: analysisMode === 'pending' ? 'dispatched' : 'ready',
        result: analysisMode === 'pending' ? null : result, accounting }, status: analysisMode === 'pending' ? 202 : 200 };
    } });
  await page.addInitScript(() => {
    const native = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = () => {
      const id = native();
      return `c329a000-${id.slice(9, 13)}-${id.slice(14, 18)}-${id.slice(19, 23)}-${id.slice(24)}`;
    };
  });
  await page.route(/\/rest\/v1\/rpc\/ai_(?:status|set_consent|analysis_status|request_control)$/, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') { await route.fallback(); return; }
    const bearer = request.headers().authorization;
    const payload = bearer?.split(' ')[1]?.split('.')[1];
    const sub: unknown = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown }).sub : null;
    const owner = sub === owners.a || sub === owners.b ? sub : null;
    if (owner && bearer !== api.issuedWireAuthorization(owner === owners.a ? 'a' : 'b')) throw new Error('Unexpected fixture identity');
    if (!owner) { await route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } }); return; }
    const profile = api.profiles[owner]!;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path.endsWith('/ai_status')) {
      if (!api.admitAiStatus(request)) { await json({ code: 'UNAUTHENTICATED' }, 401); return; }
      calls.push({ route: path, body: {} });
      await json({ code: consent.get(owner) ? 'OK' : 'CONSENT_REQUIRED', period: new Date().toISOString().slice(0, 7),
        serverTimeMs: Date.now(), consent: { enabled: consent.get(owner), noticeRevision: consent.get(owner) ? 1 : null,
          consentedAt: consent.get(owner) ? '2026-09-12T00:00:00Z' : null, profileVersion: String(profile.version) },
        policy: { activated: true, noticeRevision: 1, modelId: 'gemini-3.8-flash', promptVersion: 1,
          maxRequestMicro: '2270823', monthlyAllowanceMicro: '100000000', maxRequestsPerHour: 200, resultTtlSeconds: 3600 },
        usage: { accountedMicro: String(results.size * 413), requestsLastHour: results.size, warning: false } }); return;
    }
    if (path.endsWith('/ai_set_consent')) {
      const body = request.postDataJSON() as { p_enabled: boolean; p_notice_revision: number | null; p_expected_version: number };
      calls.push({ route: path, body });
      if (body.p_expected_version !== profile.version || body.p_notice_revision !== (body.p_enabled ? 1 : null)) {
        await json({ code: 'CONFLICT' }); return;
      }
      consent.set(owner, body.p_enabled); profile.version = Number(profile.version) + 1;
      await json({ code: 'OK', profileVersion: String(profile.version) }); return;
    }
    const body = request.postDataJSON() as { p_request_id: string; p_action?: string };
    calls.push({ route: path, body });
    if (path.endsWith('/ai_request_control') && body.p_action !== 'discard') {
      await json({ code: 'INVALID_INPUT' }, 400); return;
    }
    const result = results.get(body.p_request_id);
    if (failed.has(body.p_request_id)) {
      await json({ code: 'TERMINAL', reason: 'FAILED' }); return;
    }
    if (path.endsWith('/ai_request_control')) {
      results.delete(body.p_request_id);
      await json({ code: 'TERMINAL', reason: 'DISCARDED' }); return;
    }
    await json(result ? { code: 'OK', status: 'ready', result, accounting } : { code: 'UNAVAILABLE' });
  });
  await page.goto('/'); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  return { ...api, results, calls, inputs, consent, mode: (mode: typeof analysisMode) => { analysisMode = mode; },
    ttl: (milliseconds: number) => { if (milliseconds < 1 || milliseconds > 3600000) throw new Error('Invalid fixture TTL'); ttl = milliseconds; } };
}
export async function addAiPhoto(page: Page, fixture: Awaited<ReturnType<typeof aiFixture>>, language: Language = 'en') {
  await page.getByRole('button', { name: messages['wardrobe.add'][language], exact: true }).first().click();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: fixture.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
}
