import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OUTFITGEN_BODY_CONTROLS, OUTFITGEN_LIMITS, OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_PROMPT, OUTFITGEN_RESERVATION_MICRO,
  OUTFITGEN_SCHEMA, OUTFITGEN_SETTINGS, buildOutfitGenRequest, estimateInputTokens, isSuggestion, parseOutfitGenBody, parseOutfitGenItem,
  validateOutfitGenReply, type OutfitGenItem,
} from '../../src/domain/outfitgen';
import { classifyOutfitGenResponse, UNUSABLE_RESPONSE_USAGE } from '../../supabase/functions/outfit-generate/azure';
import { createOutfitGenHandler, OUTFITGEN_RPCS } from '../../supabase/functions/outfit-generate/handler';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, n, 1, 2, 3, 4, 5]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const item = (n: number, category: OutfitGenItem['category'], over: Partial<OutfitGenItem> = {}): OutfitGenItem => ({ id: id(n), category,
  colours: ['navy'], pattern: 'solid', sleeve_length: null, garment_length: null, seasons: ['autumn'], formality: 2, warmth: null,
  upper_coverage: 0, lower_coverage: null, favourite: false, unassessed: true, auto: true, coverage: 0,
  image: { path: `${OWNER}/${id(n)}/${id(1000 + n)}/main.jpg`, sha256: sha(JPEG(n)), bytes: JPEG(n).length }, ...over });
const wardrobe = () => [item(1, 'top'), item(2, 'bottom'), item(3, 'footwear'), item(4, 'top'), item(5, 'layer')];

describe('outfit generation request contract', () => {
  it('pins the reservation arithmetic and keeps the applicable tariff separate', () => {
    expect(BigInt(OUTFITGEN_RESERVATION_MICRO)).toBe((48000n * 440n + 8192n * 1980n + 99n) / 100n);
    expect(OUTFITGEN_RESERVATION_MICRO).toBe('373402');
    expect(OUTFITGEN_SETTINGS.metering).toMatchObject({ applicableTariff: 'ShortCo', inputRateHundredthsPerMillion: 220,
      outputRateHundredthsPerMillion: 1320, reservationValuation: 'LongCo 440/1980' });
    expect(OUTFITGEN_BODY_CONTROLS).toMatchObject({ reasoning_effort: 'medium', store: false, n: 1, stream: false });
    expect(estimateInputTokens(OUTFITGEN_LIMITS.garments)).toBeLessThanOrEqual(OUTFITGEN_LIMITS.plannedInputTokens);
    expect(OUTFITGEN_LIMITS.plannedInputTokens).toBeLessThan(OUTFITGEN_LIMITS.inputTokens);
    expect(OUTFITGEN_LIMITS.garments * OUTFITGEN_LIMITS.singleImageBytes).toBeGreaterThan(OUTFITGEN_LIMITS.imageBytes);
  });

  it('parses only the closed body', () => {
    expect(parseOutfitGenBody({ requestId: REQUEST, mode: 'auto', language: 'fi' })).toEqual({ requestId: REQUEST, mode: 'auto', language: 'fi' });
    for (const bad of [{ requestId: REQUEST, mode: 'auto' }, { requestId: REQUEST, mode: 'all', language: 'en' }, { requestId: REQUEST, mode: 'auto', language: 'de' },
      { requestId: 'x', mode: 'auto', language: 'en' }, { requestId: REQUEST, mode: 'auto', language: 'en', ownerId: OWNER },
      { requestId: REQUEST, mode: 'auto', language: 'en', itemIds: [id(1)] }, null, [], 'x']) expect(parseOutfitGenBody(bad)).toBeNull();
  });

  it('parses plan items strictly', () => {
    expect(parseOutfitGenItem(item(1, 'top'))).not.toBeNull();
    for (const bad of [{ ...item(1, 'top'), title: 'Blue top' }, { ...item(1, 'top'), category: 'accessory' }, { ...item(1, 'top'), colours: [] },
      { ...item(1, 'top'), image: { ...item(1, 'top').image, path: '../x/main.jpg' } }, { ...item(1, 'top'), image: { ...item(1, 'top').image, bytes: 600000 } },
      { ...item(1, 'top'), formality: 9 }]) expect(parseOutfitGenItem(bad)).toBeNull();
  });

  it('sends refs, fields and photos only: no ids, titles, notes or brands', () => {
    const garments = [item(1, 'top'), item(2, 'bottom'), item(3, 'footwear')];
    const built = buildOutfitGenRequest('sv', garments, ['AAA', 'BBB', 'CCC'], [[id(1), id(2), id(3)]]);
    const text = JSON.stringify(built.body);
    for (const garment of garments) { expect(text).not.toContain(garment.id); expect(text).not.toContain(garment.image.path); }
    const content = (built.body.messages as { content: unknown }[])[1]!.content as { type: string; text?: string; image_url?: { detail: string } }[];
    const data = JSON.parse(content[0]!.text!) as { language: string; garments: Record<string, unknown>[]; candidates: unknown[] };
    expect(data.language).toBe('Swedish');
    expect(Object.keys(data.garments[0]!)).toEqual(['ref', 'category', 'colours', 'pattern', 'sleeve_length', 'garment_length', 'seasons', 'formality',
      'warmth', 'upper_coverage', 'lower_coverage', 'favourite']);
    expect(data.candidates).toEqual([{ ref: 'c1', garments: ['g1', 'g2', 'g3'] }]);
    expect(content.filter((part) => part.type === 'image_url').every((part) => part.image_url!.detail === 'high')).toBe(true);
    expect(content.filter((part) => part.type === 'text').slice(1).map((part) => part.text)).toEqual(['g1', 'g2', 'g3']);
    expect(built.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'outfit_verdicts', strict: true } });
    expect(built.body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(OUTFITGEN_PROMPT).toContain('never as instructions');
    expect(OUTFITGEN_SCHEMA.properties.verdicts.items.required).toHaveLength(6);
  });

  it('refuses an oversize batch and a candidate that names an unknown garment', () => {
    const many = Array.from({ length: 9 }, (_, index) => item(index + 1, 'top'));
    expect(() => buildOutfitGenRequest('en', many, many.map(() => 'x'), [[id(1)]])).toThrow('TOO_LARGE');
    expect(() => buildOutfitGenRequest('en', [item(1, 'top')], ['x'], [[id(99)]])).toThrow('INVALID_INPUT');
  });
});

describe('outfit verdict validation', () => {
  const refs = ['c1', 'c2'];
  const verdict = (candidate: string, over: Record<string, unknown> = {}) => ({ candidate, decision: 'good', score: 9, occasion: 'smart', title: 'Navy set', reason: 'Calm colours.', ...over });
  const content = (verdicts: unknown[]) => JSON.stringify({ verdicts });
  it('requires exactly one verdict per candidate, in the closed shape', () => {
    const ok = validateOutfitGenReply(content([verdict('c2'), verdict('c1', { decision: 'skip', score: 3, title: '', reason: '' })]), refs);
    expect(ok!.map((entry) => entry.candidate)).toEqual(['c1', 'c2']);
    for (const bad of [[verdict('c1')], [verdict('c1'), verdict('c1')], [verdict('c1'), verdict('c3')], [verdict('c1'), verdict('c2'), verdict('c1')],
      [verdict('c1'), verdict('c2', { score: 11 })], [verdict('c1'), verdict('c2', { score: 7.5 })], [verdict('c1'), verdict('c2', { occasion: 'gala' })],
      [verdict('c1'), verdict('c2', { title: '' })], [verdict('c1'), verdict('c2', { reason: 'x'.repeat(161) })],
      [verdict('c1'), verdict('c2', { title: 'x'.repeat(41) })], [verdict('c1'), verdict('c2', { extra: 1 })],
      [verdict('c1'), verdict('c2', { decision: 'skip', title: 'not empty', reason: '' })], [verdict('c1'), verdict('c2', { title: 'a\nb' })]]) {
      expect(validateOutfitGenReply(content(bad), refs)).toBeNull();
    }
    expect(validateOutfitGenReply('not json', refs)).toBeNull();
    expect(validateOutfitGenReply(JSON.stringify({ verdicts: [], other: 1 }), refs)).toBeNull();
    expect(validateOutfitGenReply(null, refs)).toBeNull();
  });
  it('keeps a suggestion only for a good verdict at the trial quality bar', () => {
    expect(isSuggestion(verdict('c1') as never)).toBe(true);
    expect(isSuggestion(verdict('c1', { score: 7 }) as never)).toBe(false);
    expect(isSuggestion(verdict('c1', { decision: 'skip', score: 9, title: '', reason: '' }) as never)).toBe(false);
  });
});

const completion = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, unknown> | null = { prompt_tokens: 30000, completion_tokens: 2000,
  total_tokens: 32000, completion_tokens_details: { reasoning_tokens: 500 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }) => ({
  model: 'eval-terra-20260709', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', refusal: null, ...message } }], ...(usage ? { usage } : {}) });

describe('outfit generation response classification', () => {
  it('separates ordinary, refused, tool-shaped and unreadable replies, and keeps usage honest', () => {
    expect(classifyOutfitGenResponse(200, completion({ content: '{}' })).code).toBe('OK');
    expect(classifyOutfitGenResponse(200, completion({ content: null, refusal: 'No' })).code).toBe('FILTERED');
    expect(classifyOutfitGenResponse(200, completion({ content: null }, 'content_filter')).code).toBe('FILTERED');
    expect(classifyOutfitGenResponse(200, completion({ content: null, tool_calls: [{ id: 't' }] }, 'tool_calls')).code).toBe('FAILED');
    expect(classifyOutfitGenResponse(200, completion({ content: '{}' }, 'length')).code).toBe('FAILED');
    expect(classifyOutfitGenResponse(200, completion({ content: '{}' })).usage).toMatchObject({ input: 30000, output: 2000, reasoning: 500 });
    // A 429 or 5xx without counters has no usage (the reservation is kept, the feature stays on); with counters it keeps them.
    expect(classifyOutfitGenResponse(429, { error: { code: '429' } })).toEqual({ code: 'FAILED', content: null, usage: null });
    expect(classifyOutfitGenResponse(500, completion({ content: '{}' })).usage).toMatchObject({ input: 30000 });
    expect(classifyOutfitGenResponse(200, completion({ content: '{}' }, 'stop', null)).usage).toMatchObject({ input: null });
    expect(UNUSABLE_RESPONSE_USAGE.modelObservation).toBe('not_observed');
  });
});

describe('outfit generation handler (mocked Auth, RPC, Storage and provider)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service', azure: { apiKey: 'fictional-azure' } };
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: 1 }, policy: { activated: true, noticeRevision: 1, manifestId: OUTFITGEN_MANIFEST,
    modelId: OUTFITGEN_MODEL, maxRequestMicro: '400000' },
  budget: { monthlyAllowanceMicro: '5000000', usedMicro: '0', remainingMicro: '5000000', warning: false },
  pending: 0, unassessed: 5, autoUnassessed: 5, autoCallsLeft: 3, live: false, serverTimeMs: 1_000_000, cooldownUntilMs: null };
  const accounting = { basis: 'estimated', amountMicro: '90000', currency: 'USD' };
  const plan = (items: OutfitGenItem[] = wardrobe(), over: Record<string, unknown> = {}) => ({ code: 'OK', items, pairs: [], disliked: [], known: [], pendingRoom: 40, ...over });
  type Call = { url: string; body: Record<string, unknown> | null; auth: string | null };
  function backend(options: { status?: unknown; plan?: unknown; claim?: Record<string, unknown>; finish?: Record<string, unknown>; image?: (n: number) => Response | null } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body: parsed, auth: new Headers(init.headers).get('Authorization') });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/outfitgen_status')) return Response.json(options.status ?? status);
      if (url.endsWith('/rpc/outfitgen_plan')) return Response.json(options.plan ?? plan());
      if (url.endsWith('/rpc/outfitgen_assess')) return Response.json({ code: 'OK', assessed: 1 });
      if (url.endsWith('/rpc/outfitgen_claim')) return Response.json(options.claim ?? { code: 'OK', claimed: true, manifestId: OUTFITGEN_MANIFEST, dispatchBeforeMs: Date.now() + 60000 });
      if (url.endsWith('/rpc/outfitgen_finish')) return Response.json(options.finish ?? { code: 'OK', accounting, recorded: { suggested: 2, declined: 1, assessed: 3 } });
      if (url.includes('/storage/v1/object/wardrobe/')) {
        const n = Number(/\/wardrobe\/[^/]+\/00000000-0000-4000-8000-(\d{12})\//.exec(url)?.[1] ?? 0);
        const override = options.image?.(n); if (override) return override;
        return new Response(JPEG(n), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    return calls;
  }
  const verdicts = (sent: Record<string, unknown>, mutate: (index: number) => Record<string, unknown> = () => ({})) => {
    const content = ((sent.messages as { content: { text?: string }[] }[])[1]!.content)[0]!.text!;
    const count = (JSON.parse(content) as { candidates: unknown[] }).candidates.length;
    return JSON.stringify({ verdicts: Array.from({ length: count }, (_, index) => ({ candidate: `c${index + 1}`, decision: index === 0 ? 'good' : 'skip',
      score: index === 0 ? 9 : 4, occasion: 'smart', title: index === 0 ? 'Navy set' : '', reason: index === 0 ? 'Calm colours.' : '', ...mutate(index) })) });
  };
  function provider(options: { reply?: (sent: Record<string, unknown>) => Response } = {}) {
    const sent: Record<string, unknown>[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      return options.reply ? options.reply(body) : Response.json(completion({ content: verdicts(body) }));
    });
    return { transport, sent };
  }
  const registrar = () => { const works: Promise<unknown>[] = []; return { works, register: (work: Promise<unknown>) => { works.push(work); } }; };
  const post = (value: unknown, contract: string | null = '2') => new Request('http://127.0.0.1:54321/functions/v1/outfit-generate', { method: 'POST',
    headers: { Authorization: 'Bearer fictional.user.token', ...(contract === null ? {} : { 'X-Stillroom-AI-Budget-Contract': contract }), 'Content-Type': 'application/json' },
    body: JSON.stringify(value) });
  const body = (over: Record<string, unknown> = {}) => ({ requestId: REQUEST, mode: 'manual', language: 'en', ...over });
  const names = (calls: Call[]) => calls.map((call) => call.url.split('/').pop());

  it('uses only the five outfit generation RPCs', () => {
    expect(OUTFITGEN_RPCS).toEqual(['outfitgen_status', 'outfitgen_plan', 'outfitgen_assess', 'outfitgen_claim', 'outfitgen_finish']);
  });

  it('refuses unknown body fields and a missing budget contract before any network call', async () => {
    for (const [value, contract] of [[body({ ownerId: OWNER }), '2'], [body({ itemIds: [id(1)] }), '2'], [body(), null], [body(), '1']] as const) {
      const calls = backend();
      const { transport } = provider();
      const response = await createOutfitGenHandler(config, registrar().register, transport)(post(value, contract));
      expect(response.status).toBe(contract === '2' ? 400 : 403);
      expect(calls).toHaveLength(0);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('stays inactive, needs consent, a current manifest and a registrar, and never plans, claims or calls the provider otherwise', async () => {
    const cases: [Record<string, unknown> | null, string, number, boolean][] = [
      [{ ...status, policy: { ...status.policy, activated: false } }, 'INACTIVE', 503, true],
      [{ ...status, consent: { enabled: false, noticeRevision: null } }, 'CONSENT_REQUIRED', 403, true],
      [{ ...status, consent: { enabled: true, noticeRevision: 0 } }, 'CONSENT_REQUIRED', 403, true],
      [{ ...status, policy: { ...status.policy, manifestId: 'other' } }, 'UNCONFIGURED', 503, true],
      [{ ...status, policy: { ...status.policy, maxRequestMicro: '1' } }, 'UNCONFIGURED', 503, true],
      [{ ...status, budget: null }, 'UNAVAILABLE', 403, true],
      [{ ...status, live: true }, 'BUSY', 503, true],
      [{ ...status, pending: 40 }, 'PENDING_FULL', 409, true],
      [status, 'UNCONFIGURED', 503, false],
    ];
    for (const [value, code, statusCode, withRegistrar] of cases) {
      const calls = backend({ status: value });
      const { transport } = provider();
      const response = await createOutfitGenHandler(config, withRegistrar ? registrar().register : null, transport)(post(body()));
      expect([response.status, (await response.json()).code]).toEqual([statusCode, code]);
      expect(names(calls)).toEqual(['user', 'outfitgen_status']);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('judges one server-built batch end to end: photos first, then the claim, then one provider call and the finish', async () => {
    const calls = backend();
    const { transport, sent } = provider();
    const { works, register } = registrar();
    const response = await createOutfitGenHandler(config, register, transport)(post(body()));
    expect(response.status).toBe(200);
    const finish = calls.at(-1)!.body!;
    const results = finish.p_results as { items: string[]; decision: string; title: string | null }[];
    expect(await response.json()).toEqual({ code: 'OK', suggested: 2, judged: results.length, remaining: false });
    expect(works).toHaveLength(1);
    const order = names(calls);
    expect(order.slice(0, 3)).toEqual(['user', 'outfitgen_status', 'outfitgen_plan']);
    expect(order.at(-2)).toBe('outfitgen_claim');
    expect(order.at(-1)).toBe('outfitgen_finish');
    expect(order.slice(3, -2).every((name) => name === 'main.jpg')).toBe(true);
    // Photos are read with the owner's JWT, never the service key; the service RPCs get the verified owner only.
    for (const call of calls.filter((entry) => entry.url.includes('/storage/'))) expect(call.auth).toBe('Bearer fictional.user.token');
    const claim = calls.find((call) => call.url.endsWith('/outfitgen_claim'))!;
    expect(claim.body).toMatchObject({ p_owner_id: OWNER, p_request_id: REQUEST, p_manifest_id: OUTFITGEN_MANIFEST, p_auto: false });
    expect((claim.body!.p_signatures as string[]).every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(claim.auth).toBe('Bearer fictional-service');
    expect(finish).toMatchObject({ p_owner_id: OWNER, p_code: 'OK', p_usage: { input: 30000, output: 2000, reasoning: 500 } });
    expect(results).toHaveLength((claim.body!.p_signatures as string[]).length);
    expect(results[0]).toMatchObject({ decision: 'suggested', title: 'Navy set' });
    expect(results.slice(1).every((entry) => entry.decision === 'declined' && entry.title === null)).toBe(true);
    expect((finish.p_assessed as string[]).sort()).toEqual((claim.body!.p_targets as string[]).sort());
    expect(sent).toHaveLength(1);
    const text = JSON.stringify(sent[0]);
    for (const garment of wardrobe()) expect(text).not.toContain(garment.id);
    expect(text).not.toContain('fictional');
  });

  it('keeps a missing or extra verdict from becoming a decline: nothing is recorded', async () => {
    for (const reply of [(sent: Record<string, unknown>) => Response.json(completion({ content: verdicts(sent).replace(/\{"candidate":"c2"[^}]*\},?/, '') })),
      (sent: Record<string, unknown>) => Response.json(completion({ content: verdicts(sent, (index) => index === 1 ? { candidate: 'c1' } : {}) })),
      () => Response.json(completion({ content: 'nope' }))]) {
      const calls = backend();
      const { transport } = provider({ reply });
      const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
      expect([response.status, (await response.json()).code]).toEqual([502, 'FAILED']);
      expect(calls.at(-1)!.body).toMatchObject({ p_code: 'FAILED', p_results: null, p_assessed: null, p_usage: { input: 30000 } });
    }
  });

  it('settles a provider error without counters as a failure that keeps the reservation, and an unreadable 200 as invalid metering', async () => {
    let calls = backend();
    let { transport } = provider({ reply: () => Response.json({ error: { code: '429' } }, { status: 429 }) });
    let response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect([response.status, (await response.json()).code]).toEqual([502, 'FAILED']);
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'FAILED', p_usage: null, p_results: null });
    calls = backend();
    ({ transport } = provider({ reply: () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) }));
    response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect(response.status).toBe(502);
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'FAILED', p_usage: { modelObservation: 'not_observed', input: null } });
  });

  it('accounts a refusal without recording anything', async () => {
    const calls = backend();
    const { transport } = provider({ reply: () => Response.json(completion({ content: null, refusal: 'No' })) });
    const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect([response.status, (await response.json()).code]).toEqual([422, 'FILTERED']);
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'FILTERED', p_results: null });
  });

  it('finishes as not dispatched, without a provider call, when the deadline passed or the runtime refused the work', async () => {
    let calls = backend({ claim: { code: 'OK', claimed: true, manifestId: OUTFITGEN_MANIFEST, dispatchBeforeMs: Date.now() - 1 } });
    let { transport } = provider();
    const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect(response.status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'NOT_DISPATCHED', p_usage: null });
    calls = backend();
    ({ transport } = provider());
    await createOutfitGenHandler(config, () => { throw new Error('no runtime'); }, transport)(post(body()));
    expect(transport).not.toHaveBeenCalled();
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'NOT_DISPATCHED' });
  });

  it('never claims when a photo cannot be read or no longer matches its recorded hash', async () => {
    for (const image of [() => new Response('x', { status: 404 }), () => new Response(JPEG(9), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
      () => new Response(JPEG(1), { status: 200, headers: { 'Content-Type': 'image/png' } })]) {
      const calls = backend({ image });
      const { transport } = provider();
      const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
      expect(response.status).toBe(502);
      expect(names(calls)).not.toContain('outfitgen_claim');
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('maps every claim refusal to its closed code without a provider call', async () => {
    for (const [code, statusCode] of [['BUSY', 503], ['PENDING_FULL', 409], ['CONFLICT', 409], ['RATE_LIMIT', 429], ['COOLDOWN', 429], ['ALLOWANCE', 429],
      ['CONSENT_REQUIRED', 403], ['TERMINAL', 409], ['SOMETHING_ELSE', 502]] as const) {
      const calls = backend({ claim: { code, claimed: false } });
      const { transport } = provider();
      const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
      expect([response.status, (await response.json()).code]).toEqual([statusCode, statusCode === 502 ? 'FAILED' : code]);
      expect(names(calls).at(-1)).toBe('outfitgen_claim');
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('maps finish outcomes: an expired request is a timeout and a busy finish is never reported as success', async () => {
    for (const [finish, statusCode, code] of [[{ code: 'EXPIRED', accounting }, 504, 'TIMEOUT'], [{ code: 'BUSY' }, 503, 'BUSY'],
      [{ code: 'USAGE_ANOMALY', accounting }, 502, 'FAILED'], [{ code: 'CONSENT_REQUIRED', accounting }, 403, 'CONSENT_REQUIRED']] as const) {
      backend({ finish });
      const { transport } = provider();
      const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
      expect([response.status, (await response.json()).code]).toEqual([statusCode, code]);
    }
  });

  it('automatic runs need new items, calls left and no cooldown, and claim as automatic', async () => {
    let calls = backend({ status: { ...status, autoUnassessed: 0 } });
    let { transport } = provider();
    let response = await createOutfitGenHandler(config, registrar().register, transport)(post(body({ mode: 'auto' })));
    expect([response.status, await response.json()]).toEqual([200, { code: 'OK', suggested: 0, judged: 0, remaining: false }]);
    expect(names(calls)).toEqual(['user', 'outfitgen_status']);
    for (const value of [{ ...status, autoCallsLeft: 0 }, { ...status, cooldownUntilMs: 2_000_000 }]) {
      calls = backend({ status: value });
      response = await createOutfitGenHandler(config, registrar().register, provider().transport)(post(body({ mode: 'auto' })));
      expect([response.status, (await response.json()).code]).toEqual([429, 'COOLDOWN']);
      expect(names(calls)).toEqual(['user', 'outfitgen_status']);
    }
    calls = backend();
    ({ transport } = provider());
    response = await createOutfitGenHandler(config, registrar().register, transport)(post(body({ mode: 'auto' })));
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.url.endsWith('/outfitgen_claim'))!.body).toMatchObject({ p_auto: true });
  });

  it('marks items assessed without a claim when nothing can be judged, and judges only items with candidates', async () => {
    const calls = backend({ plan: plan([item(1, 'top'), item(2, 'top')]) });
    const { transport } = provider();
    const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect([response.status, await response.json()]).toEqual([200, { code: 'OK', suggested: 0, judged: 0, remaining: false }]);
    expect(names(calls)).toEqual(['user', 'outfitgen_status', 'outfitgen_plan', 'outfitgen_assess']);
    expect((calls.at(-1)!.body!.p_items as string[]).sort()).toEqual([id(1), id(2)]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('skips candidates that are already known, so a repeated run judges nothing twice', async () => {
    let calls = backend();
    const { transport, sent } = provider();
    await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    const signatures = calls.find((call) => call.url.endsWith('/outfitgen_claim'))!.body!.p_signatures as string[];
    calls = backend({ plan: plan(wardrobe(), { known: signatures }) });
    const again = provider();
    const response = await createOutfitGenHandler(config, registrar().register, again.transport)(post(body()));
    expect(response.status).toBe(200);
    expect(again.sent.length === 0 || (again.sent[0] !== sent[0])).toBe(true);
    const next = calls.find((call) => call.url.endsWith('/outfitgen_claim'))?.body?.p_signatures as string[] | undefined;
    for (const signature of next ?? []) expect(signatures).not.toContain(signature);
  });

  it('answers CORS preflight only for its own header set', async () => {
    const handler = createOutfitGenHandler(config, null, vi.fn());
    const ok = await handler(new Request('http://127.0.0.1:54321/functions/v1/outfit-generate', { method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-stillroom-ai-budget-contract' } }));
    expect(ok.status).toBe(204);
    const bad = await handler(new Request('http://127.0.0.1:54321/functions/v1/outfit-generate', { method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-other' } }));
    expect(bad.status).toBe(400);
  });
});

describe('manifest pins', () => {
  it('records the prompt, schema and settings hashes in the migration', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../../supabase/migrations/20261106090000_outfit_generation.sql', import.meta.url), 'utf8');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    for (const value of [hash(OUTFITGEN_PROMPT), hash(JSON.stringify(OUTFITGEN_SCHEMA)), hash(JSON.stringify(OUTFITGEN_SETTINGS))]) expect(sql).toContain(`'${value}'`);
    expect(sql).toContain(`'${OUTFITGEN_MANIFEST}','${OUTFITGEN_MODEL}',1,`);
    expect(sql).toContain(`220,1320,48000,8192,${OUTFITGEN_RESERVATION_MICRO},512000,1600,262144,32768,${OUTFITGEN_LIMITS.requestMs / 1000},`);
  });
});
