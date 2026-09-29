// VTO-1b: the inactive try-on endpoint with mocked Auth, RPCs, Storage and an image-provider double (plan rev4 §6).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRYON_DEPLOYMENT, TRYON_MANIFEST, TRYON_MODEL, TRYON_PARAMETERS, TRYON_RESERVATION_MICRO, tryOnPrompt,
} from '../../src/domain/tryon';
import { classifyTryOnResponse, tryOnForm, tryOnUsagePayload } from '../../supabase/functions/try-on/azure';
import { claimedWorkObserver, createTryOnHandler, TRYON_RPCS } from '../../supabase/functions/try-on/handler';
import { exifSegment } from '../fixtures/jpeg-helpers';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const OWNER = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OUTFIT = '44444444-4444-4444-8444-444444444444';
const RESULT = '55555555-5555-4555-8555-555555555555';
const PROBE = '66666666-6666-4666-8666-666666666666';
const PATH = `${OWNER}/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888/main.jpg`;
const PERSON = flatJpeg({ width: 1024, height: 1280 });
const OUTPUT = flatJpeg({ width: 1024, height: 1280, colour: [90, 140, 60] });
const GARMENT = flatJpeg({ width: 800, height: 1000 });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const usage = { input_tokens: 9000, output_tokens: 6000, total_tokens: 15000, input_tokens_details: { text_tokens: 120, image_tokens: 8880 } };
const payload = { modelObservation: 'not_observed', input: 9000, output: 6000, total: 15000, inputText: 120, inputImage: 8880 };
const imageBody = (bytes: Uint8Array = OUTPUT) => ({ created: 1, data: [{ b64_json: base64(bytes) }], usage });
const TOKEN = 'probe-token-'.padEnd(48, 'x');

describe('try-on request contract', () => {
  it('uses only the four try-on RPCs', () => {
    expect(TRYON_RPCS).toEqual(['tryon_status', 'tryon_claim', 'tryon_dispatch', 'tryon_finish']);
  });
  it('sends the frozen parameters, the fixed slot prompt, then the person and the garment', async () => {
    const form = tryOnForm(PERSON, GARMENT, 'bottom');
    expect([...form.keys()]).toEqual([...Object.keys(TRYON_PARAMETERS), 'prompt', 'image[]', 'image[]']);
    expect(form.get('prompt')).toBe(tryOnPrompt('bottom'));
    expect(form.get('prompt')).toContain('(bottoms)');
    const [person, garment] = form.getAll('image[]') as File[];
    expect([person!.type, garment!.type]).toEqual(['image/jpeg', 'image/jpeg']);
    expect(new Uint8Array(await person!.arrayBuffer())).toEqual(PERSON);
    expect(new Uint8Array(await garment!.arrayBuffer())).toEqual(GARMENT);
    expect(TRYON_PARAMETERS.model).toBe(TRYON_DEPLOYMENT);
  });
  it('observes all five counters or none, and the model identity', () => {
    expect(tryOnUsagePayload({ usage })).toEqual(payload);
    expect(tryOnUsagePayload({ usage, model: TRYON_MODEL })?.modelObservation).toBe('expected_snapshot');
    expect(tryOnUsagePayload({ usage, model: TRYON_DEPLOYMENT })?.modelObservation).toBe('deployment_alias');
    expect(tryOnUsagePayload({ usage, model: 'other' })?.modelObservation).toBe('response_unrecognised_model');
    expect(tryOnUsagePayload({ usage: { ...usage, input_tokens_details: {} } })).toBeNull();
  });
  it('treats content filters as a normal outcome and rejects any other picture shape', () => {
    expect(classifyTryOnResponse(200, imageBody())).toMatchObject({ code: 'OK', usage: payload });
    expect(classifyTryOnResponse(400, { error: { code: 'content_policy_violation' }, usage })).toMatchObject({ code: 'FILTERED', usage: payload });
    expect(classifyTryOnResponse(400, { error: { code: 'x', inner_error: { code: 'ResponsibleAIPolicyViolation' } } }).code).toBe('FILTERED');
    expect(classifyTryOnResponse(500, { error: { code: 'server_error' } })).toMatchObject({ code: 'FAILED', usage: null });
    for (const bad of [flatJpeg({ width: 1024, height: 1024 }), flatJpeg({ width: 1024, height: 1280, mode: 'progressive' })]) {
      expect(classifyTryOnResponse(200, imageBody(bad))).toMatchObject({ code: 'OUTPUT_REJECTED', image: null });
    }
  });
});

describe('try-on handler (mocked Auth, RPC, Storage and image provider)', () => {
  const registered: Promise<unknown>[] = [];
  const register = (work: Promise<unknown>) => { registered.push(work); };
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); registered.length = 0; claimedWorkObserver.current = null; });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service',
    azure: { apiKey: 'fictional-azure-image' } };
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: 1 }, policy: { activated: true, noticeRevision: 1,
    manifestId: TRYON_MANIFEST, modelId: TRYON_MODEL, maxRequestMicro: TRYON_RESERVATION_MICRO, providerAvailable: true } };
  const accounting = { basis: 'estimated', amountMicro: '252000', currency: 'USD' };
  type Call = { url: string; body: Record<string, unknown> | null; auth: string | null };
  type Options = { status?: unknown; claim?: Record<string, unknown>; steps?: number; dispatch?: () => Response | Promise<Response>;
    finish?: Record<string, unknown>; garment?: () => Response; onDispatch?: () => void };
  function backend(options: Options = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body: parsed, auth: new Headers(init.headers).get('Authorization') });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/tryon_status')) return Response.json(options.status ?? status);
      if (url.endsWith('/rpc/tryon_claim')) {
        const step = parsed!.p_step as number, steps = options.steps ?? 3;
        return Response.json(options.claim ?? { code: 'OK', claimed: true, manifestId: TRYON_MANIFEST, chainId: parsed!.p_chain_id,
          step, steps, last: step === steps, slot: 'top', garment: { path: PATH, mainSha256: sha(GARMENT), bytes: GARMENT.length },
          dispatchBeforeMs: Date.now() + 15_000, requestSeconds: 85, reservationMicro: TRYON_RESERVATION_MICRO });
      }
      if (url.includes('/storage/v1/object/wardrobe/')) {
        return options.garment?.() ?? new Response(GARMENT, { headers: { 'Content-Type': 'image/jpeg' } });
      }
      if (url.endsWith('/rpc/tryon_dispatch')) {
        options.onDispatch?.();
        return options.dispatch?.() ?? Response.json({ code: 'AUTHORISED', authorisedAtMs: Date.now(), dispatchBeforeMs: Date.now() + 10_000 });
      }
      if (url.endsWith('/rpc/tryon_finish')) {
        init.signal?.throwIfAborted();
        return Response.json(options.finish ?? (parsed!.p_output
          ? { code: 'OK', last: true, accounting, resultId: RESULT, deleted: false, expiresAtMs: 1_900_000_000_000 }
          : { code: 'OK', last: false, accounting }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    return calls;
  }
  const provider = (respond: () => Response | Promise<Response>) => {
    const sent: FormData[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => { sent.push(init.body as FormData); return respond(); });
    return { transport, sent };
  };
  const form = (step = 2, over: Record<string, string | null> = {}, person: Uint8Array = PERSON) => {
    const body = new FormData();
    const fields: Record<string, string | null> = { chainId: CHAIN, step: String(step), requestId: REQUEST, manifestId: TRYON_MANIFEST,
      ...(step === 1 ? { outfitId: OUTFIT } : {}), ...over };
    for (const [key, value] of Object.entries(fields)) if (value !== null) body.append(key, value);
    body.append('person', new Blob([person as BlobPart], { type: 'image/jpeg' }), 'person.jpg');
    return body;
  };
  const post = (body: FormData = form(), extra: Record<string, string> = {}, signal?: AbortSignal) =>
    new Request('http://127.0.0.1:54321/functions/v1/try-on', { method: 'POST', headers: { Authorization: 'Bearer fictional-user-jwt', ...extra }, body, signal });
  const rpcBody = (calls: Call[], name: string) => calls.find((call) => call.url.endsWith(`/rpc/${name}`))?.body;
  const names = (calls: Call[]) => calls.map((call) => call.url.includes('/storage/') ? 'storage' : call.url.split('/').pop());

  it('runs one intermediate step and releases its bytes only after finish returned OK', async () => {
    const calls = backend();
    const { transport, sent } = provider(() => Response.json(imageBody()));
    const response = await createTryOnHandler(config, register, transport)(post(form(2), { Origin: 'http://127.0.0.1:5173' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OUTPUT);
    expect(response.headers.get('X-Stillroom-TryOn-Sha256')).toBe(sha(OUTPUT));
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('x-stillroom-tryon-sha256');
    expect(names(calls)).toEqual(['user', 'tryon_status', 'tryon_claim', 'storage', 'tryon_dispatch', 'tryon_finish']);
    expect(rpcBody(calls, 'tryon_claim')).toEqual({ p_owner_id: OWNER, p_chain_id: CHAIN, p_step: 2, p_request_id: REQUEST,
      p_manifest_id: TRYON_MANIFEST, p_outfit_id: null, p_person_sha256: sha(PERSON), p_probe_id: null });
    expect(calls.find((call) => call.url.endsWith('/rpc/tryon_claim'))!.auth).toBe('Bearer fictional-service');
    // The garment is read with the owner's JWT, never the service role.
    expect(calls.find((call) => call.url.includes('/storage/'))).toMatchObject({ url: `http://127.0.0.1:54321/storage/v1/object/wardrobe/${PATH}`,
      auth: 'Bearer fictional-user-jwt' });
    expect(rpcBody(calls, 'tryon_dispatch')).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_client_present: true });
    expect(rpcBody(calls, 'tryon_finish')).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_code: 'OK', p_usage: payload,
      p_output_sha256: sha(OUTPUT), p_output_bytes: OUTPUT.length, p_output: null, p_fetch_started: true, p_client_live_at_fetch: true,
      p_client_gone: false });
    expect(sent).toHaveLength(1);
    const images = sent[0]!.getAll('image[]') as File[];
    expect(new Uint8Array(await images[0]!.arrayBuffer())).toEqual(PERSON);
    expect(new Uint8Array(await images[1]!.arrayBuffer())).toEqual(GARMENT);
    const text = JSON.stringify([...sent[0]!.entries()].filter(([, value]) => typeof value === 'string'));
    for (const id of [OWNER, CHAIN, REQUEST, OUTFIT]) expect(text).not.toContain(id);
  });

  it('starts a chain on step 1 with the outfit and no person hash, and commits the last picture as the result', async () => {
    const calls = backend({ steps: 1 });
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createTryOnHandler(config, register, transport)(post(form(1)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 'OK', resultId: RESULT, expiresAtMs: 1_900_000_000_000 });
    expect(rpcBody(calls, 'tryon_claim')).toMatchObject({ p_step: 1, p_outfit_id: OUTFIT, p_person_sha256: null });
    expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'OK', p_output_sha256: sha(OUTPUT),
      p_output: `\\x${Buffer.from(OUTPUT).toString('hex')}` });
  });

  it('strips photo metadata before hashing and sending the person', async () => {
    const calls = backend();
    const { transport, sent } = provider(() => Response.json(imageBody()));
    const tagged = flatJpeg({ width: 1024, height: 1280, segments: [exifSegment(1)] });
    await createTryOnHandler(config, register, transport)(post(form(2, {}, tagged)));
    const person = new Uint8Array(await (sent[0]!.getAll('image[]')[0] as File).arrayBuffer());
    expect(person).toEqual(PERSON);
    expect(rpcBody(calls, 'tryon_claim')).toMatchObject({ p_person_sha256: sha(PERSON) });
  });

  it('refuses closed ingress before any network call', async () => {
    const calls = backend();
    const { transport } = provider(() => Response.json(imageBody()));
    const bad: Array<[Request, number]> = [
      [post(form(1, { outfitId: null })), 400], [post(form(2, { outfitId: OUTFIT })), 400], [post(form(4)), 400],
      [post(form(2, { chainId: 'not-a-uuid' })), 400], [post(form(2, { extra: 'x' })), 400],
      [post(form(2, { manifestId: 'other' })), 503],
      [post(form(2, {}, flatJpeg({ width: 800, height: 1000 }))), 400],
      [post(form(2, {}, flatJpeg({ width: 1024, height: 1280, mode: 'progressive' }))), 400],
      [post(form(2, {}, new Uint8Array(600_001))), 413],
      [new Request('http://127.0.0.1:54321/functions/v1/try-on', { method: 'POST', headers: { Authorization: 'Bearer fictional-user-jwt',
        'Content-Type': 'image/jpeg' }, body: PERSON as BodyInit }), 415],
    ];
    for (const [request, code] of bad) expect((await createTryOnHandler(config, register, transport)(request)).status).toBe(code);
    expect(calls).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('stays inactive, unconsented, switched off or unregistered without a claim or provider call', async () => {
    for (const [override, code, registrar] of [[{ policy: { ...status.policy, activated: false } }, 'INACTIVE', register],
      [{ consent: { enabled: false, noticeRevision: null } }, 'CONSENT_REQUIRED', register],
      [{ policy: { ...status.policy, providerAvailable: false } }, 'UNAVAILABLE', register],
      [{ policy: { ...status.policy, maxRequestMicro: '1000' } }, 'UNCONFIGURED', register],
      [{}, 'UNCONFIGURED', null]] as const) {
      const calls = backend({ status: { ...status, ...override } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, registrar, transport)(post());
      expect(await response.json()).toEqual({ code });
      expect(names(calls)).not.toContain('tryon_claim');
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('passes claim refusals through without a download, mark or provider call', async () => {
    for (const code of ['ALLOWANCE', 'RATE_LIMIT', 'BUSY', 'RESULTS_FULL', 'CHAIN_MISMATCH', 'WITHDRAWN', 'CANCELLED', 'CONFLICT',
      'NO_GARMENTS', 'NOT_FOUND', 'TERMINAL', 'PROBE_LIMIT']) {
      const calls = backend({ claim: { code, claimed: false } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, register, transport)(post());
      expect((await response.json() as { code: string }).code).toBe(code === 'PROBE_LIMIT' ? 'UNAVAILABLE' : code);
      expect(names(calls)).toEqual(['user', 'tryon_status', 'tryon_claim']);
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('settles a refused registration as pre-dispatch, with no download', async () => {
    const calls = backend();
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createTryOnHandler(config, () => { throw new Error('refused'); }, transport)(post());
    expect(await response.json()).toEqual({ code: 'UNCONFIGURED' });
    expect(names(calls)).toEqual(['user', 'tryon_status', 'tryon_claim', 'tryon_finish']);
    expect(rpcBody(calls, 'tryon_finish')).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_code: 'PRE_DISPATCH', p_usage: null,
      p_output_sha256: null, p_output_bytes: null, p_output: null, p_fetch_started: false, p_client_live_at_fetch: null,
      p_client_gone: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a changed, oversized or unreadable garment before the mark', async () => {
    for (const garment of [() => new Response(flatJpeg({ width: 800, height: 1001 }), { headers: { 'Content-Type': 'image/jpeg' } }),
      () => new Response(new Uint8Array(GARMENT.length + 1), { headers: { 'Content-Type': 'image/jpeg' } }),
      () => new Response(GARMENT, { headers: { 'Content-Type': 'image/png' } }), () => new Response(null, { status: 404 })]) {
      const calls = backend({ garment });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, register, transport)(post());
      expect(await response.json()).toEqual({ code: 'FAILED' });
      expect(names(calls)).toEqual(['user', 'tryon_status', 'tryon_claim', 'storage', 'tryon_finish']);
      expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'PRE_DISPATCH', p_fetch_started: false });
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('fetches only after a committed AUTHORISED reply; every other mark outcome finishes pre-dispatch', async () => {
    for (const [dispatch, code] of [[() => Response.json({ code: 'ALREADY_AUTHORISED' }), 'FAILED'],
      [() => Response.json({ code: 'WITHDRAWN' }), 'WITHDRAWN'], [() => Response.json({ code: 'CANCELLED' }), 'CANCELLED'],
      [() => Response.json({ code: 'EXPIRED' }), 'TIMEOUT'], [() => Response.json({ code: 'CLIENT_GONE' }), 'TIMEOUT'],
      [() => Response.json({ code: 'PROBE_LIMIT' }), 'UNAVAILABLE'], [() => Response.json({ code: 'BUSY' }), 'FAILED'],
      [() => new Response('x', { status: 500 }), 'FAILED'],
      [() => Response.json({ code: 'AUTHORISED', authorisedAtMs: Date.now() }), 'FAILED'],
      [() => Response.json({ code: 'AUTHORISED', authorisedAtMs: Date.now() - 20, dispatchBeforeMs: Date.now() - 1 }), 'TIMEOUT'],
    ] as const) {
      const calls = backend({ dispatch });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, register, transport)(post());
      expect(await response.json()).toEqual({ code });
      expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'PRE_DISPATCH', p_usage: null, p_fetch_started: false,
        p_client_live_at_fetch: null });
      expect(calls.filter((call) => call.url.endsWith('/rpc/tryon_dispatch'))).toHaveLength(1);
      expect(transport).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('gives up on a mark reply after 2 s and does not fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = backend({ dispatch: () => new Promise<Response>(() => {}) });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/rpc/tryon_dispatch')) {
        calls.push({ url: String(url), body: null, auth: null });
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
      }
      return original(url, init);
    });
    const { transport } = provider(() => Response.json(imageBody()));
    const pending = createTryOnHandler(config, register, transport)(post());
    await vi.waitFor(() => expect(names(calls)).toContain('tryon_dispatch'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await (await pending).json()).toEqual({ code: 'TIMEOUT' });
    expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'PRE_DISPATCH', p_fetch_started: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports a client gone before the mark, so the mark refuses and nothing is fetched', async () => {
    const controller = new AbortController();
    const calls = backend({ dispatch: () => Response.json({ code: 'CLIENT_GONE' }) });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).includes('/storage/')) controller.abort();
      return response;
    });
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createTryOnHandler(config, register, transport)(post(form(), {}, controller.signal));
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
    expect(rpcBody(calls, 'tryon_dispatch')).toMatchObject({ p_client_present: false });
    expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'PRE_DISPATCH', p_client_gone: true });
    expect(transport).not.toHaveBeenCalled();
  });

  it('records the client state at the actual fetch start and keeps an authorised call running after a disconnect', async () => {
    const controller = new AbortController();
    const calls = backend({ onDispatch: () => controller.abort() });
    let providerSignal: AbortSignal | undefined;
    const { transport } = provider(() => Response.json(imageBody()));
    transport.mockImplementation(async (_url: string, init: RequestInit) => { providerSignal = init.signal!; return Response.json(imageBody()); });
    const response = await createTryOnHandler(config, register, transport)(post(form(), {}, controller.signal));
    expect(transport).toHaveBeenCalledOnce();
    expect(providerSignal!.aborted).toBe(false);
    expect(rpcBody(calls, 'tryon_dispatch')).toMatchObject({ p_client_present: true });
    expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: 'OK', p_usage: payload, p_fetch_started: true,
      p_client_live_at_fetch: false, p_client_gone: true });
    expect(await response.json()).toEqual({ code: 'TIMEOUT' });
  });

  it('records a live client at fetch when it leaves during the provider call', async () => {
    const controller = new AbortController();
    const calls = backend();
    const { transport } = provider(() => { controller.abort(); return Response.json(imageBody()); });
    await createTryOnHandler(config, register, transport)(post(form(), {}, controller.signal));
    expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_fetch_started: true, p_client_live_at_fetch: true, p_client_gone: true });
  });

  it('reports filters, failures and missing usage with the matching finish, and returns no bytes', async () => {
    for (const [respond, code, expectedUsage] of [
      [() => Response.json({ error: { code: 'content_policy_violation' }, usage }, { status: 400 }), 'FILTERED', payload],
      [() => Response.json({ error: { code: 'content_filter' } }, { status: 400 }), 'FILTERED', null],
      [() => new Response('<html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 'FAILED', null],
      [() => Response.json(imageBody(flatJpeg({ width: 1024, height: 1024 }))), 'OUTPUT_REJECTED', payload],
    ] as const) {
      const calls = backend({ finish: { code, accounting } });
      const { transport } = provider(respond);
      const response = await createTryOnHandler(config, register, transport)(post());
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ code });
      expect(rpcBody(calls, 'tryon_finish')).toMatchObject({ p_code: code, p_usage: expectedUsage, p_output_sha256: null,
        p_output: null, p_fetch_started: true, p_client_live_at_fetch: true });
      vi.unstubAllGlobals();
    }
  });

  it('suppresses the picture when finish reports a late, withdrawn, expired or anomalous step', async () => {
    for (const [finished, code] of [['LATE', 'CONFLICT'], ['EXPIRED', 'TIMEOUT'], ['USAGE_ANOMALY', 'FAILED'],
      ['INVALID_USAGE', 'FAILED'], ['CONSENT_REQUIRED', 'CONSENT_REQUIRED'], ['UNAVAILABLE', 'UNAVAILABLE'], ['BUSY', 'FAILED'],
      ['USAGE_CONFLICT', 'FAILED'], ['INACTIVE', 'INACTIVE'], ['UNCONFIGURED', 'UNCONFIGURED']] as const) {
      backend({ finish: { code: finished, accounting: finished === 'BUSY' ? null : accounting } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, register, transport)(post());
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ code });
      // The provider ran: a finish BUSY after it must never read as an unclaimed, retryable BUSY.
      expect(transport).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it('reports an oversized finish reply after the provider ran as FAILED, never as the ingress TOO_LARGE', async () => {
    for (const last of [false, true]) {
      backend({ steps: 2, finish: { code: 'OK', last, accounting, padding: 'x'.repeat(40_000) } });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler(config, register, transport)(post(form(last ? 2 : 1)));
      expect(await response.json()).toEqual({ code: 'FAILED' });
      expect(transport).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it('reports a result that was deleted before a replayed last finish, and never recreates it', async () => {
    backend({ steps: 2, finish: { code: 'OK', replayed: true, last: true, accounting, resultId: null, deleted: true, expiresAtMs: null } });
    const { transport } = provider(() => Response.json(imageBody()));
    const response = await createTryOnHandler(config, register, transport)(post(form(2)));
    expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('leaves a provider that misses its 70 s deadline held for provisional expiry, without finish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = backend();
    let called!: () => void;
    const dispatched = new Promise<void>((resolve) => { called = resolve; });
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      called();
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    });
    const pending = createTryOnHandler(config, register, transport)(post());
    await dispatched;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await (await pending).json()).toEqual({ code: 'TIMEOUT' });
    expect(rpcBody(calls, 'tryon_finish')).toBeUndefined();
  });

  it('registers exactly the work promise it awaits, once per claimed request', async () => {
    backend();
    const observed: Promise<unknown>[] = [];
    claimedWorkObserver.current = (work) => { observed.push(work); };
    const { transport } = provider(() => Response.json(imageBody()));
    await createTryOnHandler(config, register, transport)(post());
    expect(observed).toHaveLength(1);
    expect(registered).toEqual(observed);
  });

  it('refuses a malformed claim reply and a garment outside the owner', async () => {
    for (const claim of [{ code: 'OK', claimed: true }, { code: 'OK', claimed: true, manifestId: TRYON_MANIFEST, chainId: CHAIN, step: 2,
      steps: 3, last: false, slot: 'top', garment: { path: `${PROBE}/x/y/main.jpg`, mainSha256: sha(GARMENT), bytes: GARMENT.length },
      dispatchBeforeMs: Date.now() + 15_000, requestSeconds: 85, reservationMicro: TRYON_RESERVATION_MICRO }]) {
      const calls = backend({ claim });
      const { transport } = provider(() => Response.json(imageBody()));
      expect(await (await createTryOnHandler(config, register, transport)(post())).json()).toEqual({ code: 'FAILED' });
      expect(names(calls)).toEqual(['user', 'tryon_status', 'tryon_claim']);
      vi.unstubAllGlobals();
    }
  });

  it('refuses unknown preflight headers, a query string and a foreign origin', async () => {
    const options = new Request('http://127.0.0.1:54321/functions/v1/try-on', { method: 'OPTIONS', headers: {
      Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-stillroom-probe-token' } });
    expect((await createTryOnHandler(config, register)(options)).status).toBe(400);
    const ok = new Request('http://127.0.0.1:54321/functions/v1/try-on', { method: 'OPTIONS', headers: {
      Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    expect((await createTryOnHandler(config, register)(ok)).status).toBe(204);
    expect((await createTryOnHandler(config, register)(new Request('http://127.0.0.1:54321/functions/v1/try-on?x=1',
      { method: 'POST' }))).status).toBe(400);
    expect((await createTryOnHandler(config, register)(post(form(), { Origin: 'https://evil.example' }))).status).toBe(403);
  });

  describe('operator probe gate', () => {
    const probeHeaders = { 'X-Stillroom-Probe-Authorisation': PROBE, 'X-Stillroom-Probe-Token': TOKEN };
    const inactive = { ...status, code: 'INACTIVE', consent: { enabled: false, noticeRevision: null },
      policy: { ...status.policy, activated: false } };
    it('refuses probe headers from a browser, without a configured secret or with a wrong token, before any RPC', async () => {
      for (const [cfg, extra, code] of [[{ ...config, probeToken: TOKEN }, { ...probeHeaders, Origin: 'http://127.0.0.1:5173' }, 'INVALID_INPUT'],
        [config, probeHeaders, 'UNCONFIGURED'], [{ ...config, probeToken: TOKEN }, { ...probeHeaders, 'X-Stillroom-Probe-Token': 'y'.repeat(48) },
          'UNAUTHENTICATED'], [{ ...config, probeToken: TOKEN }, { 'X-Stillroom-Probe-Token': TOKEN }, 'INVALID_INPUT']] as const) {
        const calls = backend({ status: inactive });
        const response = await createTryOnHandler(cfg, register)(post(form(), extra));
        expect(await response.json()).toEqual({ code });
        expect(calls).toHaveLength(0);
        vi.unstubAllGlobals();
      }
    });
    it('claims with the probe id only while ordinary try-on is switched off', async () => {
      const calls = backend({ status: inactive });
      const { transport } = provider(() => Response.json(imageBody()));
      const response = await createTryOnHandler({ ...config, probeToken: TOKEN }, register, transport)(post(form(), probeHeaders));
      expect(response.status).toBe(200);
      expect(rpcBody(calls, 'tryon_claim')).toMatchObject({ p_probe_id: PROBE });
      vi.unstubAllGlobals();
      const active = backend();
      const refused = await createTryOnHandler({ ...config, probeToken: TOKEN }, register, transport)(post(form(), probeHeaders));
      expect(await refused.json()).toEqual({ code: 'INVALID_INPUT' });
      expect(names(active)).not.toContain('tryon_claim');
    });
  });
});
