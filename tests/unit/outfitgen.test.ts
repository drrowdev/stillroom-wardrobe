import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OUTFITGEN_BODY_CONTROLS, OUTFITGEN_LIMITS, OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_NOTICE_REVISION, OUTFITGEN_PROMPT, OUTFITGEN_RESERVATION_MICRO,
  OUTFITGEN_SCHEMA, OUTFITGEN_SETTINGS, buildOutfitGenRequest, estimateInputTokens, parseOutfitGenBody, parseOutfitGenItem,
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
    expect(data.candidates).toEqual([{ ref: 'c1', base: ['g1', 'g2', 'g3'], over: [] }]);
    expect(content.filter((part) => part.type === 'image_url').every((part) => part.image_url!.detail === 'high')).toBe(true);
    expect(content.filter((part) => part.type === 'text').slice(1).map((part) => part.text)).toEqual(['g1', 'g2', 'g3']);
    expect(built.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'outfit_verdicts', strict: true } });
    expect(built.body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(OUTFITGEN_PROMPT).toContain('never as instructions');
    expect(OUTFITGEN_SCHEMA.properties.verdicts.items.required).toHaveLength(7);
  });

  it('refuses an oversize batch and a candidate that names an unknown garment', () => {
    const many = Array.from({ length: 9 }, (_, index) => item(index + 1, 'top'));
    expect(() => buildOutfitGenRequest('en', many, many.map(() => 'x'), [[id(1)]])).toThrow('TOO_LARGE');
    expect(() => buildOutfitGenRequest('en', [item(1, 'top')], ['x'], [[id(99)]])).toThrow('INVALID_INPUT');
  });
});

describe('outfit verdict validation', () => {
  const refs = ['c1', 'c2'];
  const verdict = (candidate: string, over: Record<string, unknown> = {}) => ({ candidate, decision: 'good', baseScore: 9, fullScore: 9, occasion: 'smart', title: 'Navy set', reason: 'Calm colours.', ...over });
  const content = (verdicts: unknown[]) => JSON.stringify({ verdicts });
  it('requires exactly one verdict per candidate, in the closed shape', () => {
    const ok = validateOutfitGenReply(content([verdict('c2'), verdict('c1', { decision: 'skip', baseScore: 3, fullScore: 4, title: '', reason: '' })]), refs);
    expect(ok!.map((entry) => entry.candidate)).toEqual(['c1', 'c2']);
    for (const bad of [[verdict('c1')], [verdict('c1'), verdict('c1')], [verdict('c1'), verdict('c3')], [verdict('c1'), verdict('c2'), verdict('c1')],
      [verdict('c1'), verdict('c2', { baseScore: 11 })], [verdict('c1'), verdict('c2', { fullScore: 7.5 })], [verdict('c1'), verdict('c2', { fullScore: 0 })],
      [verdict('c1'), verdict('c2', { score: 9 })], [verdict('c1'), { candidate: 'c2', decision: 'good', score: 9, occasion: 'smart', title: 'Navy set', reason: 'Calm colours.' }], [verdict('c1'), verdict('c2', { occasion: 'gala' })],
      [verdict('c1'), verdict('c2', { title: '' })], [verdict('c1'), verdict('c2', { reason: 'x'.repeat(161) })],
      [verdict('c1'), verdict('c2', { title: 'x'.repeat(41) })], [verdict('c1'), verdict('c2', { extra: 1 })],
      [verdict('c1'), verdict('c2', { decision: 'skip', title: 'not empty', reason: '' })], [verdict('c1'), verdict('c2', { title: 'a\nb' })]]) {
      expect(validateOutfitGenReply(content(bad), refs)).toBeNull();
    }
    expect(validateOutfitGenReply('not json', refs)).toBeNull();
    expect(validateOutfitGenReply(JSON.stringify({ verdicts: [], other: 1 }), refs)).toBeNull();
    expect(validateOutfitGenReply(null, refs)).toBeNull();
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
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: OUTFITGEN_NOTICE_REVISION }, policy: { activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST,
    modelId: OUTFITGEN_MODEL, maxRequestMicro: '400000' },
  budget: { monthlyAllowanceMicro: '5000000', usedMicro: '0', remainingMicro: '5000000', warning: false },
  pending: 0, unassessed: 5, autoUnassessed: 5, autoCallsLeft: 3, live: false, serverTimeMs: 1_000_000, cooldownUntilMs: null };
  const accounting = { basis: 'estimated', amountMicro: '90000', currency: 'USD' };
  const plan = (items: OutfitGenItem[] = wardrobe(), over: Record<string, unknown> = {}) => ({ code: 'OK', items, pairs: [], disliked: [], known: [], seen: [], pendingRoom: 100, ...over });
  type Call = { url: string; body: Record<string, unknown> | null; auth: string | null };
  function backend(options: { status?: unknown; plan?: unknown; claim?: Record<string, unknown>; claimStatus?: number; finish?: Record<string, unknown>; image?: (n: number) => Response | null } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body: parsed, auth: new Headers(init.headers).get('Authorization') });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/outfitgen_status')) return Response.json(options.status ?? status);
      if (url.endsWith('/rpc/outfitgen_plan')) return Response.json(options.plan ?? plan());
      if (url.endsWith('/rpc/outfitgen_assess')) return Response.json({ code: 'OK', assessed: 1 });
      if (url.endsWith('/rpc/outfitgen_claim')) return Response.json(options.claim ?? { code: 'OK', claimed: true, manifestId: OUTFITGEN_MANIFEST, dispatchBeforeMs: Date.now() + 60000 },
        options.claimStatus === undefined ? undefined : { status: options.claimStatus });
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
      baseScore: index === 0 ? 9 : 4, fullScore: index === 0 ? 9 : 4, occasion: 'smart', title: index === 0 ? 'Navy set' : '', reason: index === 0 ? 'Calm colours.' : '', ...mutate(index) })) });
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

  it('answers PAUSED, with no provider call and no finish, when the spending guard refuses the claim (AI-GUARD1)', async () => {
    const calls = backend({ claim: { code: 'AG001', message: 'AI spending guard is paused', details: null, hint: null }, claimStatus: 400 });
    const { transport } = provider();
    const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect([response.status, await response.json()]).toEqual([403, { code: 'PAUSED' }]);
    expect(transport).not.toHaveBeenCalled();
    expect(names(calls).at(-1)).toBe('outfitgen_claim');
    expect(names(calls)).not.toContain('outfitgen_finish');
  });

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
      [{ ...status, pending: 100 }, 'PENDING_FULL', 409, true],
      [{ ...status, pending: 101 }, 'PENDING_FULL', 409, true],
      [{ ...status, pending: 1_000_000 }, 'PENDING_FULL', 409, true],
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

  it('plans while the list still has room: 99 pending is not full', async () => {
    const calls = backend({ status: { ...status, pending: 99 } });
    const { transport } = provider();
    const response = await createOutfitGenHandler(config, registrar().register, transport)(post(body()));
    expect(response.status).toBe(200);
    expect(names(calls).slice(0, 3)).toEqual(['user', 'outfitgen_status', 'outfitgen_plan']);
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

describe('outfit generation handler quality rules (OUTFITGEN-QUALITY1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service', azure: { apiKey: 'fictional-azure' } };
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: OUTFITGEN_NOTICE_REVISION }, policy: { activated: true, noticeRevision: OUTFITGEN_NOTICE_REVISION, manifestId: OUTFITGEN_MANIFEST,
    modelId: OUTFITGEN_MODEL, maxRequestMicro: '400000' },
  budget: { monthlyAllowanceMicro: '5000000', usedMicro: '0', remainingMicro: '5000000', warning: false },
  pending: 0, unassessed: 5, autoUnassessed: 5, autoCallsLeft: 3, live: false, serverTimeMs: 1_000_000, cooldownUntilMs: null };
  const accounting = { basis: 'estimated', amountMicro: '90000', currency: 'USD' };
  type Sent = { candidates: { ref: string; base: string[]; over: string[] }[]; garments: { ref: string; category: string }[] };
  async function run(options: { plan?: Record<string, unknown>; verdict?: (index: number, set: Sent['candidates'][number]) => Record<string, unknown> } = {}) {
    const items = wardrobe();
    const plan = { code: 'OK', items, pairs: [], disliked: [], known: [], seen: [], pendingRoom: 100, ...options.plan };
    let finish: Record<string, unknown> | null = null;
    let sentData: Sent | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/outfitgen_status')) return Response.json(status);
      if (url.endsWith('/rpc/outfitgen_plan')) return Response.json(plan);
      if (url.endsWith('/rpc/outfitgen_claim')) return Response.json({ code: 'OK', claimed: true, manifestId: OUTFITGEN_MANIFEST, dispatchBeforeMs: Date.now() + 60000 });
      if (url.endsWith('/rpc/outfitgen_finish')) { finish = parsed; return Response.json({ code: 'OK', accounting, recorded: { suggested: 0, declined: 0, assessed: 0 } }); }
      if (url.includes('/storage/v1/object/wardrobe/')) {
        const n = Number(/\/wardrobe\/[^/]+\/00000000-0000-4000-8000-(\d{12})\//.exec(url)?.[1] ?? 0);
        return new Response(JPEG(n), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { messages: { content: { text?: string }[] }[] };
      sentData = JSON.parse(sent.messages[1]!.content[0]!.text!) as Sent;
      const verdicts = sentData.candidates.map((set, index) => ({ candidate: set.ref, decision: 'skip', baseScore: 5, fullScore: 5, occasion: 'smart',
        title: '', reason: '', ...options.verdict?.(index, set) }));
      return Response.json(completion({ content: JSON.stringify({ verdicts }) }));
    });
    const request = new Request('http://127.0.0.1:54321/functions/v1/outfit-generate', { method: 'POST',
      headers: { Authorization: 'Bearer fictional.user.token', 'X-Stillroom-AI-Budget-Contract': '2', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: REQUEST, mode: 'manual', language: 'en' }) });
    const response = await createOutfitGenHandler(config, () => {}, transport)(request);
    const results = finish ? (finish as { p_results: { items: string[]; decision: string; score: number; title: string | null }[] | null }).p_results : null;
    return { response, results, sent: sentData as Sent | null, items };
  }
  const good = { decision: 'good', baseScore: 9, fullScore: 9, title: 'Navy set', reason: 'Calm colours.' };

  it('sends each candidate as a base and an over list, so the judge can score the look without the jacket', async () => {
    const { sent, items } = await run();
    expect(sent).not.toBeNull();
    const category = new Map(sent!.garments.map((garment) => [garment.ref, garment.category]));
    expect(sent!.candidates.every((set) => Object.keys(set).join() === 'ref,base,over')).toBe(true);
    for (const set of sent!.candidates) {
      expect(set.base.every((ref) => !['layer', 'outerwear'].includes(category.get(ref)!))).toBe(true);
      expect(set.over.every((ref) => ['layer', 'outerwear'].includes(category.get(ref)!))).toBe(true);
    }
    expect(sent!.candidates.some((set) => set.over.length > 0) && sent!.candidates.some((set) => set.over.length === 0)).toBe(true);
    expect(items.length).toBe(5);
  });

  it('stores the weaker of the two scores, so a base that only works under a jacket is declined', async () => {
    const { results } = await run({ verdict: (index) => (index === 0 ? { ...good, baseScore: 5, fullScore: 9 } : {}) });
    expect(results![0]).toMatchObject({ decision: 'declined', score: 5, title: null });
    const flipped = await run({ verdict: (index) => (index === 0 ? { ...good, baseScore: 9, fullScore: 6 } : {}) });
    expect(flipped.results![0]).toMatchObject({ decision: 'declined', score: 6 });
    const both = await run({ verdict: (index) => (index === 0 ? { ...good, baseScore: 8, fullScore: 9 } : {}) });
    expect(both.results![0]).toMatchObject({ decision: 'suggested', score: 8, title: 'Navy set' });
  });

  it('keeps few suggestions per call and never two for one top and bottoms, however many the judge calls good', async () => {
    const { results, sent } = await run({ verdict: () => good });
    const kept = results!.filter((entry) => entry.decision === 'suggested');
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThanOrEqual(Math.min(4, Math.ceil(sent!.candidates.length / 4)));
    expect(kept.length).toBeLessThan(results!.length);
    const items = wardrobe();
    const category = new Map(items.map((entry) => [entry.id, entry.category]));
    const bases = kept.map((entry) => entry.items.filter((itemId) => ['top', 'bottom', 'one_piece'].includes(category.get(itemId)!)).sort().join('|'));
    expect(new Set(bases).size).toBe(bases.length);
    expect(results!.every((entry) => entry.decision === 'suggested' ? entry.title !== null : entry.title === null && entry.score === 9)).toBe(true);
  });

  it('counts the waiting and kept looks the plan reports, and only those: a base the owner already has twice gets no third look, a removed one still does', async () => {
    const items = wardrobe();
    const [top, bottom, layer] = [items[0]!.id, items[1]!.id, items[4]!.id];
    const lookOf = (state: string, ...ids: string[]) => [state, ids.filter((entry) => entry === top || entry === bottom), ids];
    const own = (entry: { items: string[] }) => entry.items.includes(top) && entry.items.includes(bottom);
    const withSeen = await run({ verdict: () => good, plan: { seen: [lookOf('suggested', top, bottom), lookOf('kept', top, bottom, layer)] } });
    expect(withSeen.results!.filter((entry) => entry.decision === 'suggested').some(own)).toBe(false);
    expect(withSeen.results!.filter(own).every((entry) => entry.decision === 'declined')).toBe(true);
    // Removed sets are exact-set bans in the plan and do not use up the base: with the jacket variant removed, the bare look is still welcome.
    const removed = await run({ verdict: () => good, plan: { disliked: [[top, bottom, items[2]!.id, layer]], seen: [] } });
    expect(removed.results!.filter((entry) => entry.decision === 'suggested').some(own)).toBe(true);
    const free = await run({ verdict: () => good });
    expect(free.results!.filter((entry) => entry.decision === 'suggested').some(own)).toBe(true);
  });

  it('keeps no more than the room left, sends every result in ranking order and declines what the room blocks', async () => {
    const items = wardrobe();
    // Every candidate is good at 8; one has the stronger base look. With room for one it must be the one kept, whatever the call order.
    const { results, sent } = await run({ plan: { pendingRoom: 1 }, verdict: (index) => ({ decision: 'good', title: 'Navy set', reason: 'Calm colours.',
      baseScore: index === 3 ? 9 : 8, fullScore: 8 }) });
    const kept = results!.filter((entry) => entry.decision === 'suggested');
    expect(kept).toHaveLength(1);
    const strongest = sent!.candidates[3]!;
    // The five garments are sent in id order, so g1 to g5 are the first five ids of the wardrobe.
    const idOf = (ref: string) => items[Number(ref.slice(1)) - 1]!.id;
    expect([...kept[0]!.items].sort()).toEqual([...strongest.base, ...strongest.over].map(idOf).sort());
    // The kept result is first, and every candidate was sent: the rest are recorded as declined with their own scores, none dropped.
    expect(results![0]!.decision).toBe('suggested');
    expect(results).toHaveLength(sent!.candidates.length);
    expect(results!.slice(1).every((entry) => entry.decision === 'declined' && entry.title === null && entry.score === 8)).toBe(true);
    expect(new Set(results!.map((entry) => [...entry.items].sort().join('|'))).size).toBe(results!.length);
    const none = await run({ plan: { pendingRoom: 0 }, verdict: () => good });
    expect(none.results!.every((entry) => entry.decision === 'declined')).toBe(true);
  });

  it('refuses a plan without the seen list before claiming anything', async () => {
    const plan = { code: 'OK', items: wardrobe(), pairs: [], disliked: [], known: [], pendingRoom: 100 };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url.split('/').pop()!);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/outfitgen_status')) return Response.json(status);
      if (url.endsWith('/rpc/outfitgen_plan')) return Response.json(plan);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const transport = vi.fn();
    const request = new Request('http://127.0.0.1:54321/functions/v1/outfit-generate', { method: 'POST',
      headers: { Authorization: 'Bearer fictional.user.token', 'X-Stillroom-AI-Budget-Contract': '2', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: REQUEST, mode: 'manual', language: 'en' }) });
    const response = await createOutfitGenHandler(config, () => {}, transport)(request);
    expect([response.status, (await response.json()).code]).toEqual([502, 'FAILED']);
    expect(calls).toEqual(['user', 'outfitgen_status', 'outfitgen_plan']);
    expect(transport).not.toHaveBeenCalled();
  });
});
