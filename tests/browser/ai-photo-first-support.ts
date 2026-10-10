import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { AiResult } from '../../src/domain/ai-analysis';
import { messages, type Language } from '../../src/i18n/all';
import { budgetReply, mockBackend, owners, signIn, type MockOptions } from './mock-backend';

export async function manualEntry(page: Page) {
  const language = await page.locator('html').getAttribute('lang') as Language;
  // Manual entry is implicit: once the AI check settles without filling anything, Save is available directly.
  await expect(page.getByText(messages['aiC.filling'][language], { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: messages['capture.save'][language], exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: messages['aiC.keep'][language], exact: true })).toHaveCount(0);
}
export async function aiFixture(page: Page, language: Language = 'en', enabled = true, lost?: 'reservation' | 'finalizer',
  observeRawAnalysis = false, imageChangeLoss?: MockOptions['imageChangeLoss'], start = '/',
  /** Synthetic rows to have in place before the app's first navigation, sign-in and wardrobe read. */
  prepare?: (backend: Awaited<ReturnType<typeof mockBackend>>) => void) {
  const results = new Map<string, AiResult>();
  const consent = new Map<string, boolean>([[owners.a, enabled], [owners.b, false]]);
  const calls: Array<{ route: string; body: unknown }> = [];
  const inputs: Array<{ owner: string; requestId: string; bytes: number; sha256: string }> = [];
  const failed = new Set<string>();
  let analysisMode: 'ready' | 'pending' | 'timeout' | 'unclear' | 'failed' = 'ready';
  let ttl = 3600000;
  let failNext = 0;
  let policy = { activated: true, noticeRevision: 2, modelId: 'gpt-5.6-terra-2026-07-09', promptVersion: 2,
    executionManifestId: 'azure-eu-terra-devtest-v2',
    maxRequestMicro: '4097351', resultTtlSeconds: 3600 };
  let allowanceMicro = '100000000';
  const accounting = { basis: 'estimated', amountMicro: '1034', currency: 'USD' };
  const unknown = { category: null, subcategory: null, colours: [], pattern: null, sleeve_length: null,
    garment_length: null, brand: null, size_label: null, upper_coverage: null, lower_coverage: null,
    material: null, seasons: [], formality: null, style_tags: [] };
  const api = await mockBackend(page, { initialLanguage: language, aiResults: results, observeRawAnalysis, imageChangeLoss,
    loseAnalyzedReserveReplyOnce: lost === 'reservation', loseFinalizeReplyOnce: lost === 'finalizer',
    analysis: ({ owner, requestId, draftId, generation, bytes }) => {
      if (!consent.get(owner)) return { body: { code: 'CONSENT_REQUIRED' }, status: 403 };
      const imageSha256 = createHash('sha256').update(bytes).digest('hex');
      inputs.push({ owner, requestId, bytes: bytes.length, sha256: imageSha256 });
      calls.push({ route: '/functions/v1/analyze-clothing', body: { requestId } });
      if (analysisMode === 'failed' || failNext > 0) {
        if (analysisMode !== 'failed') failNext -= 1;
        failed.add(requestId);
        return { body: { code: 'ANALYSIS_FAILED' }, status: 502 };
      }
      const result: AiResult = { schemaVersion: 1, requestId, draftId, generation, imageSha256,
        modelId: 'gpt-5.6-terra-2026-07-09', promptVersion: 2, createdAtMs: Date.now() - 1, expiresAtMs: Date.now() + ttl,
        facts: analysisMode === 'unclear' ? { outcome: 'unclear', fields: unknown }
          : { outcome: 'ready', fields: { ...unknown, category: 'top', colours: ['green'], formality: 0, material: 'Cotton', sleeve_length: 'long', style_tags: ['relaxed'] } } };
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
      if (request.headers()['x-stillroom-ai-budget-contract'] !== '2') { await json({ code: 'UNAVAILABLE', policy: null }); return; }
      calls.push({ route: path, body: {} });
      await json(api.negotiatedStatus(request, { code: consent.get(owner) ? 'OK' : 'CONSENT_REQUIRED', period: new Date().toISOString().slice(0, 7),
        serverTimeMs: Date.now(), consent: { enabled: consent.get(owner), noticeRevision: consent.get(owner) ? 2 : null,
          consentedAt: consent.get(owner) ? '2026-09-12T00:00:00Z' : null, profileVersion: String(profile.version) },
        policy,
        budget: budgetReply(allowanceMicro, String(results.size * 1034)) })); return;
    }
    if (path.endsWith('/ai_set_consent')) {
      const body = request.postDataJSON() as { p_enabled: boolean; p_notice_revision: number | null; p_expected_version: number };
      calls.push({ route: path, body });
      if (body.p_enabled && request.headers()['x-stillroom-ai-budget-contract'] !== '2') { await json({ code: 'UNAVAILABLE' }); return; }
      if (body.p_expected_version !== profile.version || body.p_notice_revision !== (body.p_enabled ? 2 : null)) {
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
  prepare?.(api);
  await page.goto(start); await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  return { ...api, results, calls, inputs, consent, mode: (mode: typeof analysisMode) => { analysisMode = mode; },
    /** The next `count` analyses fail, as a reply with a missing or unexpected model name does; the rest are unaffected. */
    failNext: (count: number) => { failNext = count; },
    // The one monthly amount belongs to the budget, not the policy; a test may still set it here.
    policy: (next: Partial<typeof policy> & { monthlyAllowanceMicro?: string }) => {
      const { monthlyAllowanceMicro, ...rest } = next;
      if (monthlyAllowanceMicro !== undefined) allowanceMicro = monthlyAllowanceMicro;
      policy = { ...policy, ...rest };
    },
    ttl: (milliseconds: number) => { if (milliseconds < 1 || milliseconds > 3600000) throw new Error('Invalid fixture TTL'); ttl = milliseconds; } };
}
export async function addAiPhoto(page: Page, fixture: Awaited<ReturnType<typeof aiFixture>>, language: Language = 'en') {
  await page.getByRole('button', { name: messages['wardrobe.add'][language], exact: true }).first().click();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: fixture.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
}
/** UX2: change, crop and background actions sit behind the Photo options toggle once a photo is chosen. */
export async function openPhotoMenu(page: Page) {
  const toggle = page.locator('#photo-menu');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('#photo-menu-panel')).toBeVisible();
}
/** UX2: a saved item opens as a view card; the form appears after Edit. */
export async function editItem(page: Page) {
  await page.locator('#detail-edit').click();
  await expect(page.locator('#detail-title')).toBeFocused();
}