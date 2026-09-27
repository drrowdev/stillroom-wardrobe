// BG2b-1: the inactive enhance-photo endpoint with mocked Auth, RPCs and an image-provider double.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENHANCE_DEPLOYMENT, ENHANCE_MANIFEST, ENHANCE_MODEL, ENHANCE_PARAMETERS, ENHANCE_PROMPT, ENHANCE_RESERVATION_MICRO,
  ENHANCE_SETTINGS, enhanceEstimateMicro, observeEnhanceUsage,
} from '../../src/domain/enhancement';
import { PROVIDER_JPEG } from '../../src/images/provider-jpeg';
import { classifyEnhanceResponse, enhanceForm, enhanceUsagePayload } from '../../supabase/functions/enhance-photo/azure';
import { createEnhanceHandler, ENHANCE_RPCS } from '../../supabase/functions/enhance-photo/handler';
import { exifSegment, jpegSegment } from '../fixtures/jpeg-helpers';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const INPUT = flatJpeg({ width: 800, height: 1000 });
const OUTPUT = flatJpeg({ width: PROVIDER_JPEG.width, height: PROVIDER_JPEG.height });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const usage = { input_tokens: 1400, output_tokens: 2000, total_tokens: 3400, input_tokens_details: { text_tokens: 150, image_tokens: 1250 } };
const imageBody = (bytes: Uint8Array = OUTPUT, extra: Record<string, unknown> = {}) => ({ created: 1, data: [{ b64_json: base64(bytes) }], usage, ...extra });

describe('enhancement request contract', () => {
  it('pins the prompt, parameters and settings hashes and the manifest envelope', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20260929090000_photo_enhancement.sql', import.meta.url), 'utf8');
    for (const hash of [sha(ENHANCE_PROMPT), sha(JSON.stringify(ENHANCE_PARAMETERS)), sha(JSON.stringify(ENHANCE_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${ENHANCE_MANIFEST}','${ENHANCE_MODEL}',1,`);
    expect(sql).toContain(`'USD',800,3000,7500,8000,${ENHANCE_RESERVATION_MICRO},512000,1600,4194304,512000,85,'2027-01-01T00:00:00Z'`);
    expect(BigInt(ENHANCE_RESERVATION_MICRO)).toBe((7500n * 800n + 8000n * 3000n + 99n) / 100n);
    expect(ENHANCE_PARAMETERS).toEqual({ model: ENHANCE_DEPLOYMENT, n: 1, size: '1024x1280', quality: 'medium',
      output_format: 'jpeg', output_compression: 85, background: 'opaque' });
    expect(Object.keys(ENHANCE_PARAMETERS)).not.toContain('input_fidelity');
  });

  it('sends only the image, the fixed prompt and the frozen parameters', async () => {
    const form = enhanceForm(INPUT);
    const keys = [...form.keys()];
    expect(keys).toEqual([...Object.keys(ENHANCE_PARAMETERS), 'prompt', 'image']);
    expect(form.get('prompt')).toBe(ENHANCE_PROMPT);
    const file = form.get('image') as File;
    expect(file.type).toBe('image/jpeg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(INPUT);
  });

  it('observes usage and uses the same estimate arithmetic as the migration', () => {
    const observed = observeEnhanceUsage({ usage });
    expect(observed).toEqual({ input: 1400, output: 2000, total: 3400, inputText: 150, inputImage: 1250 });
    expect(enhanceEstimateMicro(observed)).toBe((1400n * 800n + 2000n * 3000n + 99n) / 100n);
    expect(enhanceUsagePayload({ usage })).toMatchObject({ modelObservation: 'not_observed', total: 3400 });
    expect(enhanceUsagePayload({ usage, model: ENHANCE_MODEL })?.modelObservation).toBe('expected_snapshot');
    expect(enhanceUsagePayload({ usage, model: 'other' })?.modelObservation).toBe('response_unrecognised_model');
    expect(enhanceUsagePayload({ usage: { ...usage, input_tokens_details: {} } })).toBeNull();
    expect(enhanceUsagePayload({})).toBeNull();
  });

  it('classifies success, filters, failures and every rejected output', () => {
    expect(classifyEnhanceResponse(200, imageBody())).toMatchObject({ code: 'OK' });
    const stripped = classifyEnhanceResponse(200, imageBody(flatJpeg({ width: 1024, height: 1280,
      segments: [exifSegment(1), jpegSegment(0xeb, new Uint8Array([0x4a, 0x50, 1, 2]))] })));
    expect(stripped.code).toBe('OK');
    expect(stripped.image).toEqual(OUTPUT);
    expect(classifyEnhanceResponse(400, { error: { code: 'content_policy_violation' }, usage }).code).toBe('FILTERED');
    expect(classifyEnhanceResponse(400, { error: { code: 'x', innererror: { code: 'ResponsibleAIPolicyViolation' } } }).code).toBe('FILTERED');
    expect(classifyEnhanceResponse(429, { error: { code: 'rate_limit' } })).toMatchObject({ code: 'FAILED', usage: null });
    expect(classifyEnhanceResponse(200, { data: [] }).code).toBe('FAILED');
    expect(classifyEnhanceResponse(200, { data: [{ url: 'https://example.invalid/x' }] }).code).toBe('FAILED');
    for (const bad of [flatJpeg({ width: 1024, height: 1024 }), flatJpeg({ width: 1024, height: 1280, mode: 'progressive' }),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) {
      expect(classifyEnhanceResponse(200, imageBody(bad))).toMatchObject({ code: 'OUTPUT_REJECTED', image: null });
    }
    expect(classifyEnhanceResponse(200, { data: [{ b64_json: 'not base64!' }], usage })).toMatchObject({ code: 'OUTPUT_REJECTED' });
  });
});

describe('enhance-photo handler (mocked Auth, RPC and image provider)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service',
    azure: { apiKey: 'fictional-azure-image' } };
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: 1 }, policy: { activated: true, noticeRevision: 1,
    manifestId: ENHANCE_MANIFEST, modelId: ENHANCE_MODEL, maxRequestMicro: ENHANCE_RESERVATION_MICRO, providerAvailable: true } };
  const accounting = { basis: 'estimated', amountMicro: '71200', currency: 'USD' };
  type Call = { url: string; body: Record<string, unknown> | null; auth: string | null; at: number };
  let clock = 0;
  function backend(options: { status?: unknown; claim?: Record<string, unknown>; finish?: Record<string, unknown>;
    finishGate?: Promise<void> } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body: parsed, auth: new Headers(init.headers).get('Authorization'), at: clock++ });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/enhance_status')) return Response.json(options.status ?? status);
      if (url.endsWith('/rpc/enhance_claim')) return Response.json(options.claim ?? { code: 'OK', claimed: true,
        manifestId: ENHANCE_MANIFEST, dispatchBeforeMs: Date.now() + 5000, requestSeconds: 85 });
      if (url.endsWith('/rpc/enhance_finish')) {
        // Like a real fetch, an aborted signal fails the settlement: this proves which lifetime finish runs on.
        if (options.finishGate) await options.finishGate;
        init.signal?.throwIfAborted();
        return Response.json(options.finish ?? { code: 'OK', accounting, usableUntilMs: 1_900_000_000_000 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    return calls;
  }
  const provider = (respond: () => Response | Promise<Response>) => {
    const sent: FormData[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => { sent.push(init.body as FormData); clock++; return respond(); });
    return { transport, sent };
  };
  const post = (bytes: Uint8Array = INPUT, extra: Record<string, string> = {}) => new Request('http://127.0.0.1:54321/functions/v1/enhance-photo', {
    method: 'POST', headers: { Authorization: 'Bearer fictional-user', 'Content-Type': 'image/jpeg', 'X-Stillroom-Request-Id': REQUEST, ...extra },
    body: bytes as BodyInit });
  const finishBody = (calls: Call[]) => calls.find((call) => call.url.endsWith('/rpc/enhance_finish'))?.body;

  it('uses only the three enhancement RPCs', () => { expect(ENHANCE_RPCS).toEqual(['enhance_status', 'enhance_claim', 'enhance_finish']); });

  it('refuses a non-preservable or oversized photo before any network call', async () => {
    const calls = backend();
    const { transport } = provider(() => Response.json(imageBody()));
    for (const bytes of [flatJpeg({ width: 800, height: 1000, mode: 'progressive' }), flatJpeg({ width: 1700, height: 1000 }),
      flatJpeg({ width: 800, height: 1000, segments: [exifSegment(1)] }), new Uint8Array(PROVIDER_JPEG.acceptedBytes + 1)]) {
      const response = await createEnhanceHandler(config, transport)(post(bytes));
      expect([400, 413]).toContain(response.status);
    }
    expect(calls).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('claims for the verified owner, commits evidence before releasing the admitted bytes', async () => {
    const calls = backend();
    const { transport, sent } = provider(() => Response.json(imageBody()));
    const response = await createEnhanceHandler(config, transport)(post(INPUT, { Origin: 'http://127.0.0.1:5173' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(OUTPUT);
    expect(response.headers.get('X-Stillroom-Enhancement-Sha256')).toBe(sha(OUTPUT));
    expect(response.headers.get('X-Stillroom-Enhancement-Usable-Until')).toBe('1900000000000');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('x-stillroom-enhancement-sha256');
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['user', 'enhance_status', 'enhance_claim', 'enhance_finish']);
    expect(calls[2]!.body).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_manifest_id: ENHANCE_MANIFEST,
      p_input_sha256: sha(INPUT), p_probe_id: null });
    expect(calls[2]!.auth).toBe('Bearer fictional-service');
    expect(finishBody(calls)).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_code: 'OK',
      p_usage: { modelObservation: 'not_observed', input: 1400, output: 2000, total: 3400, inputText: 150, inputImage: 1250 },
      p_output_sha256: sha(OUTPUT), p_output_bytes: OUTPUT.length });
    expect(sent).toHaveLength(1);
    expect([...sent[0]!.keys()]).toEqual([...Object.keys(ENHANCE_PARAMETERS), 'prompt', 'image']);
    expect(JSON.stringify([...sent[0]!.entries()].filter(([, v]) => typeof v === 'string'))).not.toContain(OWNER);
  });

  it('stays inactive, unconsented or switched off without a claim or provider call', async () => {
    for (const [override, code] of [[{ policy: { ...status.policy, activated: false } }, 'INACTIVE'],
      [{ consent: { enabled: false, noticeRevision: null } }, 'CONSENT_REQUIRED'],
      [{ policy: { ...status.policy, providerAvailable: false } }, 'UNAVAILABLE'],
      [{ policy: { ...status.policy, maxRequestMicro: '1000' } }, 'UNCONFIGURED']] as const) {
      const calls = backend({ status: { ...status, ...override } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createEnhanceHandler(config, transport)(post());
      expect(await response.json()).toEqual({ code });
      expect(calls.some((call) => call.url.endsWith('/rpc/enhance_claim'))).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('passes admission refusals through without a provider call', async () => {
    for (const code of ['ALLOWANCE', 'RATE_LIMIT', 'UNAVAILABLE', 'BUSY', 'TERMINAL', 'PROBE_LIMIT']) {
      backend({ claim: { code, claimed: false } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createEnhanceHandler(config, transport)(post());
      expect((await response.json() as { code: string }).code).toBe(code === 'PROBE_LIMIT' ? 'UNAVAILABLE' : code);
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('settles as not dispatched after the dispatch deadline', async () => {
    const calls = backend({ claim: { code: 'OK', claimed: true, manifestId: ENHANCE_MANIFEST, dispatchBeforeMs: Date.now() - 1, requestSeconds: 85 } });
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createEnhanceHandler(config, transport)(post());
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
    expect(finishBody(calls)).toMatchObject({ p_code: 'NOT_DISPATCHED', p_usage: null, p_output_sha256: null, p_output_bytes: null });
    expect(transport).not.toHaveBeenCalled();
  });

  it('settles every rejected output as OUTPUT_REJECTED and returns no bytes', async () => {
    for (const bad of [flatJpeg({ width: 1024, height: 1024 }), flatJpeg({ width: 1024, height: 1280, mode: 'progressive' })]) {
      const calls = backend();
      const { transport } = provider(() => Response.json(imageBody(bad)));
      const response = await createEnhanceHandler(config, transport)(post());
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ code: 'OUTPUT_REJECTED' });
      expect(finishBody(calls)).toMatchObject({ p_code: 'OUTPUT_REJECTED', p_output_sha256: null, p_output_bytes: null });
      vi.unstubAllGlobals();
    }
  });

  it('reports filters, provider failures and missing usage with the matching finish', async () => {
    const cases: Array<[() => Response, string, unknown]> = [
      [() => Response.json({ error: { code: 'content_policy_violation' } }, { status: 400 }), 'FILTERED', null],
      [() => Response.json({ error: { code: '429' } }, { status: 429 }), 'FAILED', null],
      [() => new Response('<html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 'FAILED', null],
      [() => Response.json({ data: [{ b64_json: base64(OUTPUT) }] }), 'OK', null],
    ];
    for (const [respond, code, expectedUsage] of cases) {
      const calls = backend(code === 'OK' ? { finish: { code: 'INVALID_USAGE', accounting } } : { finish: { code, accounting } });
      const { transport } = provider(respond);
      const response = await createEnhanceHandler(config, transport)(post());
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ code: code === 'OK' ? 'FAILED' : code });
      expect(finishBody(calls)).toMatchObject({ p_code: code, p_usage: expectedUsage });
      vi.unstubAllGlobals();
    }
  });

  it('suppresses H2 when finish reports an anomaly, expiry, revocation or conflict', async () => {
    for (const [finished, code] of [['USAGE_ANOMALY', 'FAILED'], ['EXPIRED', 'TIMEOUT'], ['CONSENT_REQUIRED', 'CONSENT_REQUIRED'],
      ['UNAVAILABLE', 'UNAVAILABLE'], ['USAGE_CONFLICT', 'FAILED'], ['BUSY', 'BUSY']] as const) {
      backend({ finish: { code: finished, accounting } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createEnhanceHandler(config, transport)(post());
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ code });
      vi.unstubAllGlobals();
    }
  });

  it('leaves a provider that misses the real 70 s deadline held for provisional expiry, without finish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls = backend();
    let calledAt = 0, abortedAt = 0, reason: unknown;
    let called!: () => void;
    const dispatched = new Promise<void>((resolve) => { called = resolve; });
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      calledAt = Date.now();
      called();
      await new Promise((_, reject) => init.signal!.addEventListener('abort', () => {
        abortedAt = Date.now(); reason = init.signal!.reason; reject(init.signal!.reason);
      }));
      return Response.json({});
    });
    const pending = createEnhanceHandler(config, transport)(post());
    await dispatched;
    await vi.advanceTimersByTimeAsync(69_999);
    expect(abortedAt).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(abortedAt - calledAt).toBe(70_000);
    expect((reason as DOMException).name).toBe('TimeoutError');
    const response = await pending;
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
    expect(finishBody(calls)).toBeUndefined();
  });

  it('keeps the provider call running when the browser cancels, settles its usage and delivers nothing', async () => {
    const calls = backend();
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const overrun = { ...usage, input_tokens: 1400, output_tokens: 10_000, total_tokens: 11_400 };
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      providerSignal = init.signal!;
      controller.abort();
      await Promise.resolve();
      return Response.json(imageBody(OUTPUT, { usage: overrun }));
    });
    const response = await createEnhanceHandler(config, transport)(new Request(post(), { signal: controller.signal }));
    expect(providerSignal!.aborted).toBe(false);
    expect(finishBody(calls)).toMatchObject({ p_code: 'OK', p_usage: { output: 10_000, total: 11_400 }, p_output_sha256: sha(OUTPUT) });
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
  });

  it('completes settlement when the browser cancels while finish is in flight', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const calls = backend({ finish: { code: 'USAGE_ANOMALY', accounting }, finishGate: gate });
    const controller = new AbortController();
    const { transport } = provider(() => Response.json(imageBody()));
    const pending = createEnhanceHandler(config, transport)(new Request(post(), { signal: controller.signal }));
    await vi.waitFor(() => expect(finishBody(calls)).toBeDefined());
    controller.abort();
    open();
    const response = await pending;
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
    expect(calls.filter((call) => call.url.endsWith('/rpc/enhance_finish'))).toHaveLength(1);
    expect(finishBody(calls)).toMatchObject({ p_code: 'OK', p_output_sha256: sha(OUTPUT) });
  });

  it('settles as not dispatched when the browser cancels between claim and dispatch', async () => {
    const controller = new AbortController();
    const calls = backend();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/rpc/enhance_claim')) controller.abort();
      return response;
    });
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createEnhanceHandler(config, transport)(new Request(post(), { signal: controller.signal }));
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
    expect(transport).not.toHaveBeenCalled();
    expect(finishBody(calls)).toMatchObject({ p_code: 'NOT_DISPATCHED', p_usage: null });
  });
  it('refuses unknown request headers in preflight and any query string', async () => {
    const options = new Request('http://127.0.0.1:54321/functions/v1/enhance-photo', { method: 'OPTIONS', headers: {
      Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-stillroom-draft-id' } });
    expect((await createEnhanceHandler(config)(options)).status).toBe(400);
    const query = new Request('http://127.0.0.1:54321/functions/v1/enhance-photo?x=1', { method: 'POST' });
    expect((await createEnhanceHandler(config)(query)).status).toBe(400);
  });
});
