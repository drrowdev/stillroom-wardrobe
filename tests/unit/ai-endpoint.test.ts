import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../../supabase/functions/analyze-clothing/handler';
import { analyzeGoogle, estimatedMicro, googleToken, normalizeUsage, TOKEN_URL } from '../../supabase/functions/analyze-clothing/google-cloud';
import {
  GENERATION_CONFIG, MANIFEST_ID, MODEL_ID, PROMPT, RESPONSE_SCHEMA, SAFETY_SETTINGS, readBounded, validFacts,
} from '../../supabase/functions/analyze-clothing/protocol';
import { exifSegment, insertSegments, jpegHeaderFixture, joinBytes } from '../fixtures/jpeg-helpers';
// @ts-expect-error Existing executable fixture vectors have no declaration.
import { AI_FACT_VECTORS } from '../integration/ai-controls.sessions.mjs';
const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service', google: {} };
const id = 'b1290000-0000-4000-8000-000000000001';
function request(changes: RequestInit = {}, suffix = '') {
  return new Request(`http://127.0.0.1:54321/functions/v1/analyze-clothing${suffix}`, {
    method: 'POST', body: jpegHeaderFixture(), headers: {
      Authorization: 'Bearer '.concat('fictional-user'), 'Content-Type': 'image/jpeg',
      'X-Stillroom-Request-Id': id, 'X-Stillroom-Draft-Id': id, 'X-Stillroom-Generation': '1',
    }, ...changes,
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('B1 source runtime and fixed protocol', () => {
  it.each(AI_FACT_VECTORS as [unknown, boolean][])('matches the complete shared SQL/browser fact vector %#', (facts, expected) => {
    expect(validFacts(facts)).toBe(expected);
  });
  it('pins source digests to the immutable manifest', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20260911040000_ai_analysis_backend.sql', import.meta.url), 'utf8');
    for (const value of [PROMPT, JSON.stringify(RESPONSE_SCHEMA), JSON.stringify({
      generationConfig: GENERATION_CONFIG, safetySettings: SAFETY_SETTINGS,
    })]) expect(sql).toContain(createHash('sha256').update(value).digest('hex'));
    expect(sql).toContain(MANIFEST_ID);
    expect(sql).toContain('drop constraint ai_usage_charge_state_check');
    expect(sql).not.toMatch(/drop constraint ai_usage_check/);
  });
  it('returns handler-owned exact-origin preflight without any upstream access', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const handler = createHandler(config, fetcher);
    const response = await handler(request({ method: 'OPTIONS', body: null, headers: {
      Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, x-stillroom-request-id',
    } }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5173');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetcher).not.toHaveBeenCalled();
    for (const origin of ['null', 'https://foreign.example', 'http://localhost:9999']) {
      expect((await handler(request({ headers: { Origin: origin } }))).status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('distinguishes absent Origin from literal null without Auth, RPC or Google access', async () => {
    const upstream = vi.fn(), google = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const handler = createHandler(config, google);
    const response = await handler(request({ method: 'OPTIONS', body: null,
      headers: { 'Access-Control-Request-Method': 'POST' } }));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const denied = await handler(request({ method: 'OPTIONS', body: null,
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'UNAVAILABLE' });
    expect(upstream).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
  it('rejects unsupported methods, routes, queries and absent auth without upstream calls', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const handler = createHandler(config, fetcher);
    for (const req of [request({ method: 'GET', body: null }), request({}, '?owner=x'), request({}, '/extra'),
      request({ headers: {} })]) expect((await handler(req)).status).toBeLessThan(500);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([jpegHeaderFixture(1601), insertSegments(jpegHeaderFixture(), exifSegment(1)),
    joinBytes(jpegHeaderFixture(), new Uint8Array([1])), new Uint8Array(512001), new Uint8Array()])(
    'rejects malformed or oversized bytes before DB/provider allocation %#', async (image) => {
      const fetcher = vi.fn(async () => Response.json({ id, role: 'authenticated', is_anonymous: false }));
      vi.stubGlobal('fetch', fetcher);
      const google = vi.fn();
      const response = await createHandler(config, google)(request({ body: image }));
      expect([400, 413]).toContain(response.status);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(google).not.toHaveBeenCalled();
    },
  );
  it('requires actual ordinary server Auth identity, not claims or service identity', async () => {
    for (const user of [{ id, role: 'service_role', is_anonymous: false }, { id, role: 'authenticated', is_anonymous: true },
      { id, role: 'authenticated' }, { id: 'wrong', role: 'authenticated', is_anonymous: false }]) {
      const fetcher = vi.fn(async () => Response.json(user)); vi.stubGlobal('fetch', fetcher);
      expect((await createHandler(config)(request())).status).toBe(401);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('leaves the DB untouched when Google configuration is missing', async () => {
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/user')
      ? { id, role: 'authenticated', is_anonymous: false }
      : { code: 'OK', consent: { enabled: true, noticeRevision: 1 },
        policy: { activated: true, noticeRevision: 1, modelId: MODEL_ID, promptVersion: 1, maxRequestMicro: '2270823' } }));
    vi.stubGlobal('fetch', fetcher);
    const google = vi.fn();
    expect(await (await createHandler(config, google)(request())).json()).toEqual({ code: 'UNCONFIGURED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(google).not.toHaveBeenCalled();
  });
  it.each([
    [{ activated: false, noticeRevision: 1 }, { enabled: true, noticeRevision: 1 }, 'INACTIVE'],
    [{ activated: true, noticeRevision: 1 }, { enabled: false, noticeRevision: 1 }, 'CONSENT_REQUIRED'],
    [{ activated: true, noticeRevision: 2 }, { enabled: true, noticeRevision: 1 }, 'CONSENT_REQUIRED'],
    [{ activated: true, noticeRevision: 0 }, { enabled: true, noticeRevision: 0 }, 'CONSENT_REQUIRED'],
    [{ activated: true, noticeRevision: 1 }, null, 'CONSENT_REQUIRED'],
  ])('rejects ineligible preflight before any Google access %#', async (policy, consent, code) => {
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/user')
      ? { id, role: 'authenticated', is_anonymous: false }
      : { code: 'OK', policy, consent }));
    vi.stubGlobal('fetch', fetcher);
    const google = vi.fn();
    expect(await (await createHandler(config, google)(request())).json()).toEqual({ code });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(google).not.toHaveBeenCalled();
  });
  it('bounds streamed bytes even without Content-Length', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); } });
    await expect(readBounded(stream, 4, AbortSignal.timeout(1000))).rejects.toThrow('TOO_LARGE');
  });
  it('cancels a stalled body on abort without accepting a truncated image', async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const result = readBounded(stream, 512000, controller.signal);
    const assertion = expect(result).rejects.toThrow('aborted');
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });
  it.each(['lost-ack', 'expired-claim', 'config-changed', 'provider-timeout'])(
    'never retries or dispatches without a valid acknowledgement: %s (unit transport)', async (failure) => {
      const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url.split('/').at(-1)!);
        if (url.endsWith('/user')) return Response.json({ id, role: 'authenticated', is_anonymous: false });
        if (url.endsWith('/ai_status')) return Response.json({ code: 'OK', consent: { enabled: true, noticeRevision: 1 },
          policy: { activated: true, noticeRevision: 1, modelId: MODEL_ID, promptVersion: 1, maxRequestMicro: '2270823' } });
        expect(url.endsWith('/ai_claim_analysis')).toBe(true);
        if (failure === 'lost-ack') throw new Error('private transport failure');
        if (failure === 'config-changed') return Response.json({ code: 'CONFIG_CHANGED', claimed: false });
        return Response.json({ code: 'OK', claimed: true, manifestId: MANIFEST_ID,
          resultExpiresAtMs: Date.now() + 10000, dispatchBeforeMs: Date.now() + (failure === 'expired-claim' ? -1 : 1000) });
      }));
      const google = vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return Response.json({ access_token: 'fictional-only', token_type: 'Bearer', expires_in: 300 });
        throw new DOMException('fixture timeout', 'TimeoutError');
      });
      const response = await createHandler({ ...config,
        google: { projectId: 'fictional-project', clientEmail: 'fixture@fictional-project.iam.gserviceaccount.com', privateKey } }, google)(request());
      expect(await response.json()).toEqual({ code: failure === 'lost-ack' ? 'ANALYSIS_FAILED'
        : failure === 'config-changed' ? 'CONFIG_CHANGED' : 'TIMEOUT' });
      expect(calls).toEqual(['user', 'ai_status', 'ai_claim_analysis']);
      expect(google).toHaveBeenCalledTimes(failure === 'provider-timeout' ? 2 : 1);
    },
  );
});
describe('Google usage estimates are not confirmed billing', () => {
  const full = { promptTokenCount: 100, totalTokenCount: 125, candidatesTokenCount: 10, thoughtsTokenCount: 15, trafficType: 'ON_DEMAND' };
  it('charges prompt once and all generated output including thoughts once, rounded up', () => {
    const usage = normalizeUsage(full, MODEL_ID)!;
    expect(estimatedMicro(usage)).toBe('372');
    expect(estimatedMicro({ ...usage, promptTokenCount: 1048576, totalTokenCount: 1048576 + 65536 })).toBe('2270823');
    expect(estimatedMicro({ ...usage, promptTokenCount: 0, totalTokenCount: 0 })).toBe('0');
  });
  it.each([
    {}, { ...full, totalTokenCount: undefined }, { ...full, totalTokenCount: 99 },
    { ...full, totalTokenCount: 110 }, { ...full, promptTokenCount: -1 }, { ...full, promptTokenCount: 0.1 },
    { ...full, trafficType: 'PROVISIONED_THROUGHPUT' }, { ...full, cachedContentTokenCount: 101 },
    { ...full, thoughtsTokenCount: null }, { ...full, totalTokenCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...full, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 99 }] },
    { ...full, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 10 }] },
  ])('retains unknown/inconsistent usage as held %#', (usage) => expect(normalizeUsage(usage, MODEL_ID)).toBeNull());
  it('rejects a different returned version and strips extra provider fields', () => {
    expect(normalizeUsage(full, 'another-model')).toBeNull();
    expect(normalizeUsage({ ...full, privateExtra: 'not persisted' }, MODEL_ID)).toEqual({ ...full, modelVersion: MODEL_ID });
  });
  it('uses fixed OAuth RS256 exchange with an ephemeral generated key', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const keyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const boundary = (kind: 'BEGIN' | 'END') => `${'-'.repeat(5)}${kind} PRIVATE KEY${'-'.repeat(5)}`;
    const privateKey = [boundary('BEGIN'), Buffer.from(keyBytes).toString('base64'), boundary('END')].join('\n');
    const google = { projectId: 'fictional-project', clientEmail: 'fixture@fictional-project.iam.gserviceaccount.com', privateKey };
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(TOKEN_URL); expect(init.redirect).toBe('error');
      const params = new URLSearchParams(init.body as URLSearchParams);
      const assertion = params.get('assertion')!.split('.');
      const payload = JSON.parse(Buffer.from(assertion[1]!, 'base64url').toString());
      expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'scope']);
      expect(payload.aud).toBe(TOKEN_URL); expect(payload.exp - payload.iat).toBe(300);
      expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(assertion[2]!, 'base64url'),
        new TextEncoder().encode(assertion.slice(0, 2).join('.')))).toBe(true);
      return Response.json({ access_token: 'fictional-opaque', token_type: 'Bearer', expires_in: 3600 });
    });
    expect(await googleToken(google, AbortSignal.timeout(5000), transport)).toBe('fictional-opaque');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['STOP', 'MAX_TOKENS', 'SAFETY'])('accounts independently of %s content rejection', async (finishReason) => {
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://aiplatform.eu.rep.googleapis.com/v1/projects/fictional-project/locations/eu/publishers/google/models/${MODEL_ID}:generateContent`);
      const body = JSON.parse(String(init.body));
      expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'safetySettings', 'systemInstruction']);
      expect(body.generationConfig).toEqual(GENERATION_CONFIG);
      return Response.json({ modelVersion: MODEL_ID, usageMetadata: full,
        candidates: [{ finishReason, content: { role: 'model', parts: [{ text: JSON.stringify({ outcome: 'ready', fields: {} }) }] } }] });
    });
    const result = await analyzeGoogle({ projectId: 'fictional-project' }, 'fictional-opaque', jpegHeaderFixture(), AbortSignal.timeout(5000), transport);
    expect(result.usage).not.toBeNull();
    expect(result.facts !== null).toBe(finishReason === 'STOP');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(AI_FACT_VECTORS as [unknown, boolean][])('filters the shared facts at the provider boundary %#', async (facts, expected) => {
    const result = await analyzeGoogle({ projectId: 'fictional-project' }, 'fictional-only', jpegHeaderFixture(),
      AbortSignal.timeout(1000), async () => Response.json({ modelVersion: MODEL_ID, usageMetadata: full,
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(facts) }] } }] }));
    expect(result.facts !== null).toBe(expected);
    expect(result.usage).toEqual({ ...full, modelVersion: MODEL_ID });
  });
  it('bounds and cancels a provider response before parsing, without retry', async () => {
    const cancel = vi.fn();
    const transport = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel,
    })));
    await expect(analyzeGoogle({ projectId: 'fictional-project' }, 'fictional-only', jpegHeaderFixture(),
      AbortSignal.timeout(1000), transport)).rejects.toThrow('TOO_LARGE');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
