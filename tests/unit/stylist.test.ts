import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STYLIST_BODY_CONTROLS, STYLIST_ITEM_FIELDS, STYLIST_LIMITS, STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_PROMPT,
  STYLIST_RESERVATION_MICRO, STYLIST_SCHEMA, STYLIST_SETTINGS, buildStylistRequest, conversationBytes, orderStylistItems,
  parseStylistBody, parseStylistItem, stylistEligible, utf8Bytes, validateStylistReply, type StylistCandidate, type StylistInput,
  type StylistItem,
} from '../../src/domain/stylist';
import { eligible } from '../../src/domain/recommendations';
import { classifyStylistResponse } from '../../supabase/functions/stylist-chat/azure';
import { createStylistHandler, STYLIST_RPCS } from '../../supabase/functions/stylist-chat/handler';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (overrides: Partial<StylistInput> = {}): StylistInput => ({ requestId: REQUEST, message: 'Something for work',
  history: [], occasion: 'business', season: 'autumn', weather: null, ...overrides });
const item = (n: number, overrides: Partial<StylistItem> = {}): StylistItem => ({ id: id(n), category: 'top', colours: ['navy'],
  pattern: 'solid', sleeve_length: 'long', garment_length: 'regular', seasons: ['autumn'], formality: 3, warmth: 2, min_temp: 0,
  max_temp: 20, rain_rating: 0, windproof: false, upper_coverage: 2, lower_coverage: null, favourite: false, ...overrides });
const body = (overrides: Record<string, unknown> = {}) => ({ requestId: REQUEST, message: 'Something for work', history: [],
  occasion: null, season: null, weather: null, ...overrides });

describe('stylist request contract', () => {
  it('pins the prompt, schema and settings hashes recorded in the manifest migration', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20260928090000_stylist_chat.sql', import.meta.url), 'utf8');
    for (const hash of [sha(STYLIST_PROMPT), sha(JSON.stringify(STYLIST_SCHEMA)), sha(JSON.stringify(STYLIST_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${STYLIST_MANIFEST}','${STYLIST_MODEL}',1,`);
    expect(sql).toContain(`24000,1200,${STYLIST_RESERVATION_MICRO},0,0,262144,8192,25,`);
    expect(utf8Bytes(STYLIST_PROMPT)).toBeLessThanOrEqual(STYLIST_LIMITS.systemBytes);
    expect(utf8Bytes(JSON.stringify(STYLIST_SCHEMA))).toBeLessThanOrEqual(STYLIST_LIMITS.schemaBytes);
  });

  it('values the reservation at the conservative tier and keeps the applicable tariff separate', () => {
    expect(BigInt(STYLIST_RESERVATION_MICRO)).toBe((24000n * 440n + 1200n * 1980n + 99n) / 100n);
    expect(STYLIST_SETTINGS.metering).toMatchObject({ applicableTariff: 'ShortCo', inputRateHundredthsPerMillion: 220,
      outputRateHundredthsPerMillion: 1320, reservationValuation: 'LongCo 440/1980' });
  });

  it('sends explicit cache mode without breakpoints inside the hashed settings (D3)', () => {
    const built = buildStylistRequest(input(), [item(1)]);
    expect(built.body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(STYLIST_SETTINGS.bodyControls).toBe(STYLIST_BODY_CONTROLS);
    expect(JSON.stringify(built.body)).not.toContain('cache_control');
    expect(Object.keys(built.body).sort()).toEqual(['max_completion_tokens', 'messages', 'model', 'n', 'prompt_cache_options',
      'reasoning_effort', 'response_format', 'store', 'stream']);
    expect(built.body).toMatchObject({ store: false, stream: false, n: 1, max_completion_tokens: STYLIST_LIMITS.outputTokens });
  });

  it('sends only the minimised enum, number and boolean fields under local aliases (M3)', () => {
    const built = buildStylistRequest(input(), [item(1), item(2, { category: 'bottom' })]);
    const messages = built.body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    const context = JSON.parse(messages[1]!.content) as { clothes: Array<Record<string, unknown>> };
    expect(Object.keys(context).sort()).toEqual(['clothes', 'occasion', 'season', 'weather']);
    for (const entry of context.clothes) {
      expect(Object.keys(entry)).toEqual(['ref', ...STYLIST_ITEM_FIELDS]);
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'ref') expect(value).toMatch(/^i[0-9]+$/);
        else expect(value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value)).toBe(true);
      }
    }
    const text = JSON.stringify(built.body);
    for (const leaked of [id(1), id(2), OWNER]) expect(text).not.toContain(leaked);
    expect([...built.aliases]).toEqual([['i1', id(1)], ['i2', id(2)]]);
  });

  it('keeps the complete serialized messages within the byte cap with Unicode, escaping and full history (H3)', () => {
    const heavy = 'ä"\\\n😀'.repeat(100);
    const history = Array.from({ length: STYLIST_LIMITS.historyTurns }, (_, n) => ({ role: n % 2 ? 'assistant' as const : 'user' as const,
      text: heavy.slice(0, STYLIST_LIMITS.historyText) }));
    const value = input({ history: history.map((turn) => ({ ...turn, text: [...turn.text].slice(0, STYLIST_LIMITS.historyText).join('') })),
      message: [...heavy].slice(0, 200).join('') });
    expect(parseStylistBody(body({ history: value.history, message: value.message }))).not.toBeNull();
    const items = Array.from({ length: STYLIST_LIMITS.items }, (_, n) => item(n + 1, { colours: ['navy', 'light_blue', 'burgundy'] }));
    expect(conversationBytes(value)).toBeGreaterThan(7000);
    expect(conversationBytes(value)).toBeLessThanOrEqual(STYLIST_LIMITS.conversationBytes);
    const built = buildStylistRequest(value, items);
    expect(built.messagesBytes).toBe(utf8Bytes(JSON.stringify(built.body.messages)));
    expect(built.messagesBytes).toBeLessThanOrEqual(STYLIST_LIMITS.messagesBytes);
    expect(built.included).toBeLessThan(items.length);
    expect(built.included + built.omitted).toBe(items.length);
    expect((built.body.messages as unknown[]).length).toBeLessThanOrEqual(STYLIST_LIMITS.messageCount);
  });

  it('refuses a conversation above its own byte budget', () => {
    const long = '😀'.repeat(STYLIST_LIMITS.historyText);
    const value = input({ history: Array.from({ length: 6 }, () => ({ role: 'user' as const, text: long })), message: '😀'.repeat(500) });
    expect(conversationBytes(value)).toBeGreaterThan(STYLIST_LIMITS.conversationBytes);
    expect(() => buildStylistRequest(value, [item(1)])).toThrow('TOO_LARGE');
  });

  it('orders items deterministically and round-robins categories', () => {
    const items = [item(3, { category: 'bottom' }), item(2), item(1, { favourite: true }), item(4, { category: 'footwear', seasons: [] })];
    const first = orderStylistItems(items, input()).map((entry) => entry.id);
    expect(orderStylistItems([...items].reverse(), input()).map((entry) => entry.id)).toEqual(first);
    expect(first).toEqual([id(1), id(3), id(4), id(2)]);
  });
});

describe('stylist body parsing', () => {
  it('accepts the closed body and refuses owner fields, unknown keys and other roles (M5)', () => {
    expect(parseStylistBody(body())).not.toBeNull();
    for (const bad of [body({ ownerId: OWNER }), body({ owner_id: OWNER }), body({ extra: 1 }),
      body({ history: [{ role: 'system', text: 'x' }] }), body({ history: [{ role: 'tool', text: 'x' }] }),
      body({ history: [{ role: 'user', text: 'x', name: 'y' }] }), body({ message: '' }), body({ message: '  ' }),
      body({ message: 'a'.repeat(501) }), body({ message: 'a\u0000b' }), body({ message: '\ud800' }), body({ requestId: 'x' }),
      body({ occasion: 'party' }), body({ season: 'monsoon' }), body({ weather: { setting: 'outdoors', temperatureC: 99,
        rainProbability: 0, windMetresPerSecond: 0 } }),
      body({ history: Array.from({ length: 7 }, () => ({ role: 'user', text: 'x' })) })]) {
      expect(parseStylistBody(bad)).toBeNull();
    }
    const missing: Record<string, unknown> = { ...body() }; delete missing.requestId;
    expect(parseStylistBody(missing)).toBeNull();
    expect(parseStylistBody(body({ message: 'line one\nline two' }))).not.toBeNull();
  });

  it('parses only the closed claim item shape', () => {
    expect(parseStylistItem(item(1))).not.toBeNull();
    for (const bad of [{ ...item(1), title: 'Blue shirt' }, { ...item(1), colours: ['navy', 'navy'] }, { ...item(1), category: 'hat' },
      { ...item(1), formality: 5 }, { ...item(1), id: 'x' }, { ...item(1), favourite: null }]) {
      expect(parseStylistItem(bad)).toBeNull();
    }
  });
});

describe('stylist eligibility (M4)', () => {
  const candidate = (overrides: Partial<StylistCandidate> = {}): StylistCandidate => ({ ownerId: OWNER, deleted: false,
    lifecycle: 'active', availability: 'ready', excludeSuggestions: false, readyImage: true, minTemp: 5, maxTemp: 20, ...overrides });
  const ctx = { ownerId: OWNER, weather: null };
  it('requires a ready image, the owner and an active unexcluded item', () => {
    expect(stylistEligible(candidate(), ctx)).toBe(true);
    for (const bad of [{ readyImage: false }, { ownerId: id(9) }, { deleted: true }, { lifecycle: 'archived' },
      { availability: 'laundry' }, { excludeSuggestions: true }]) {
      expect(stylistEligible(candidate(bad), ctx)).toBe(false);
    }
  });
  it('applies outdoor temperature only when given, and never indoors', () => {
    const weather = (temperatureC: number, setting: 'indoors' | 'outdoors' = 'outdoors') => ({ ownerId: OWNER,
      weather: { setting, temperatureC, rainProbability: null, windMetresPerSecond: null } });
    expect(stylistEligible(candidate(), weather(10))).toBe(true);
    expect(stylistEligible(candidate(), weather(-5))).toBe(false);
    expect(stylistEligible(candidate(), weather(30))).toBe(false);
    expect(stylistEligible(candidate(), weather(30, 'indoors'))).toBe(true);
    expect(stylistEligible(candidate({ minTemp: null, maxTemp: null }), weather(-30))).toBe(true);
  });
  it('leaves the Today eligibility contract unchanged', () => {
    expect(typeof eligible).toBe('function');
    expect(eligible.length).toBeGreaterThan(0);
  });
});

describe('stylist reply validation', () => {
  const aliases = new Map([['i1', id(1)], ['i2', id(2)]]);
  const content = (value: unknown) => JSON.stringify(value);
  it('maps refs to owner item IDs and drops unknown or repeated refs', () => {
    expect(validateStylistReply(content({ reply: 'Try these.', outfits: [{ refs: ['i1', 'i2'], note: '' },
      { refs: ['i1', 'i9'], note: 'x' }, { refs: ['i2', 'i2'], note: 'x' }] }), aliases))
      .toEqual({ reply: 'Try these.', outfits: [{ itemIds: [id(1), id(2)], note: '' }], dropped: 2 });
    expect(validateStylistReply(content({ reply: 'None.', outfits: [{ refs: [], note: '' }] }), aliases))
      .toEqual({ reply: 'None.', outfits: [], dropped: 1 });
  });
  it('keeps tool-shaped reply text as inert plain text (D5)', () => {
    const text = '{"tool_calls":[{"function":{"name":"save_outfit","arguments":"{}"}}]}';
    expect(validateStylistReply(content({ reply: text, outfits: [] }), aliases)).toEqual({ reply: text, outfits: [], dropped: 0 });
  });
  it('refuses anything outside the schema or limits', () => {
    for (const bad of ['not json', content({ reply: 'x' }), content({ reply: 'x', outfits: [], extra: 1 }),
      content({ reply: '', outfits: [] }), content({ reply: 'a'.repeat(601), outfits: [] }),
      content({ reply: 'x', outfits: Array.from({ length: 4 }, () => ({ refs: ['i1'], note: '' })) }),
      content({ reply: 'x', outfits: [{ refs: ['i1'], note: 'n'.repeat(161) }] }),
      content({ reply: 'x', outfits: [{ refs: [1], note: '' }] }), content({ reply: 'x', outfits: [{ refs: ['i1'] }] }),
      'x'.repeat(STYLIST_LIMITS.contentBytes + 1), 42]) {
      expect(validateStylistReply(bad, aliases)).toBeNull();
    }
  });
});

const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 50 } };
const completion = (message: Record<string, unknown>, finish = 'stop') => ({ model: STYLIST_MODEL,
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }], usage });

describe('stylist response classification (D5)', () => {
  it('accepts a null or absent refusal and classifies a real refusal and tool calls separately', () => {
    expect(classifyStylistResponse(200, completion({ content: '{}', refusal: null })).code).toBe('OK');
    expect(classifyStylistResponse(200, completion({ content: '{}' })).code).toBe('OK');
    expect(classifyStylistResponse(200, completion({ content: null, refusal: 'I cannot help' })).code).toBe('FILTERED');
    expect(classifyStylistResponse(200, completion({ content: null }, 'content_filter')).code).toBe('FILTERED');
    expect(classifyStylistResponse(200, completion({ content: null, tool_calls: [{ id: 't' }] }, 'tool_calls')).code).toBe('FAILED');
    expect(classifyStylistResponse(200, completion({ content: '{}', function_call: { name: 'x' } })).code).toBe('FAILED');
    expect(classifyStylistResponse(200, completion({ content: '{}' }, 'length')).code).toBe('FAILED');
    expect(classifyStylistResponse(500, completion({ content: '{}' })).code).toBe('FAILED');
    expect(classifyStylistResponse(200, completion({ content: '{}' })).usage).toMatchObject({ input: 1000, output: 200, reasoning: 50 });
  });
});

describe('stylist handler (mocked Auth, RPC and provider)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service',
    azure: { apiKey: 'fictional-azure' } };
  const status = { code: 'OK', consent: { enabled: true, noticeRevision: 1 }, policy: { activated: true, noticeRevision: 1,
    manifestId: STYLIST_MANIFEST, modelId: STYLIST_MODEL, maxRequestMicro: '200000' } };
  const accounting = { basis: 'confirmed', amountMicro: '5000', currency: 'USD' };
  type Call = { url: string; body: Record<string, unknown> | null; auth: string | null };
  function backend(options: { status?: unknown; claim?: Record<string, unknown>; finish?: Record<string, unknown> } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, body: parsed, auth: new Headers(init.headers).get('Authorization') });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/stylist_status')) return Response.json(options.status ?? status);
      if (url.endsWith('/rpc/stylist_claim')) return Response.json(options.claim ?? { code: 'OK', claimed: true,
        manifestId: STYLIST_MANIFEST, dispatchBeforeMs: Date.now() + 5000, items: [item(1), item(2, { category: 'bottom' })] });
      if (url.endsWith('/rpc/stylist_finish')) return Response.json(options.finish ?? { code: 'OK', accounting });
      throw new Error(`unexpected fetch ${url}`);
    }));
    return calls;
  }
  const provider = (message: Record<string, unknown>, finish = 'stop') => {
    const sent: Array<Record<string, unknown>> = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(completion(message, finish));
    });
    return { transport, sent };
  };
  const post = (value: unknown) => new Request('http://127.0.0.1:54321/functions/v1/stylist-chat', { method: 'POST',
    headers: { Authorization: 'Bearer fictional.jwt.token', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const replyContent = (refs: string[], reply = 'Here is one.') => JSON.stringify({ reply, outfits: [{ refs, note: 'Smart' }] });

  it('uses only the three stylist RPCs', () => { expect(STYLIST_RPCS).toEqual(['stylist_status', 'stylist_claim', 'stylist_finish']); });

  it('refuses owner fields before any network call', async () => {
    const calls = backend();
    const { transport } = provider({ content: '{}' });
    const response = await createStylistHandler(config, transport)(post(body({ ownerId: id(9) })));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('claims for the verified user only and returns owner item IDs', async () => {
    const calls = backend();
    const { transport, sent } = provider({ content: replyContent(['i1', 'i2']), refusal: null });
    const response = await createStylistHandler(config, transport)(post(body()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 'OK', reply: 'Here is one.', outfits: [{ itemIds: [id(1), id(2)], note: 'Smart' }] });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['user', 'stylist_status', 'stylist_claim', 'stylist_finish']);
    expect(calls[2]!.body).toEqual({ p_owner_id: OWNER, p_request_id: REQUEST, p_manifest_id: STYLIST_MANIFEST });
    expect(calls[2]!.auth).toBe('Bearer fictional-service');
    expect(calls[3]!.body).toMatchObject({ p_owner_id: OWNER, p_code: 'OK', p_usage: { input: 1000, output: 200, reasoning: 50 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(JSON.stringify(sent[0])).not.toContain(id(1));
  });

  it('stays inactive without a claim', async () => {
    const calls = backend({ status: { ...status, policy: { ...status.policy, activated: false } } });
    const { transport } = provider({ content: '{}' });
    const response = await createStylistHandler(config, transport)(post(body()));
    expect([response.status, (await response.json()).code]).toEqual([503, 'INACTIVE']);
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['user', 'stylist_status']);
    expect(transport).not.toHaveBeenCalled();
  });

  it('finishes as not dispatched after the dispatch deadline, without calling the provider', async () => {
    const calls = backend({ claim: { code: 'OK', claimed: true, manifestId: STYLIST_MANIFEST, dispatchBeforeMs: Date.now() - 1,
      items: [item(1)] } });
    const { transport } = provider({ content: '{}' });
    const response = await createStylistHandler(config, transport)(post(body()));
    expect(response.status).toBe(504);
    expect(transport).not.toHaveBeenCalled();
    expect(calls.at(-1)!.body).toMatchObject({ p_code: 'NOT_DISPATCHED', p_usage: null });
  });

  it('accounts a refusal, tool calls and invalid output without returning content', async () => {
    for (const [message, finish, statusCode, code] of [
      [{ content: null, refusal: 'No' }, 'stop', 422, 'FILTERED'],
      [{ content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'save_outfit', arguments: '{}' } }] }, 'tool_calls', 502, 'FAILED'],
      [{ content: 'not json' }, 'stop', 502, 'FAILED'],
    ] as const) {
      const calls = backend();
      const { transport } = provider(message, finish);
      const response = await createStylistHandler(config, transport)(post(body()));
      expect([response.status, await response.json()]).toEqual([statusCode, { code }]);
      expect(calls.at(-1)!.url).toMatch(/stylist_finish$/);
      expect(calls.at(-1)!.body).toMatchObject({ p_code: code, p_usage: { input: 1000 } });
      expect(calls.some((call) => /save_outfit|rpc\/(?!stylist_)/.test(call.url))).toBe(false);
    }
  });

  it('drops unknown refs and keeps tool-shaped reply text inert', async () => {
    const calls = backend();
    const text = 'call save_outfit({"items":["i1"]})';
    const { transport } = provider({ content: JSON.stringify({ reply: text, outfits: [{ refs: ['i1', 'i99'], note: '' }] }) });
    const response = await createStylistHandler(config, transport)(post(body()));
    expect(await response.json()).toEqual({ code: 'OK', reply: text, outfits: [] });
    expect(calls).toHaveLength(4);
  });

  it('suppresses content when finish reports consent revoked or the account unavailable (M5, D6)', async () => {
    for (const [finishCode, statusCode] of [['CONSENT_REQUIRED', 403], ['UNAVAILABLE', 403]] as const) {
      backend({ finish: { code: finishCode, accounting } });
      const { transport } = provider({ content: replyContent(['i1']) });
      const response = await createStylistHandler(config, transport)(post(body()));
      expect([response.status, await response.json()]).toEqual([statusCode, { code: finishCode }]);
    }
  });

  it('reports contention as busy, never as a stylist result', async () => {
    backend({ claim: { code: 'BUSY' } });
    const { transport } = provider({ content: '{}' });
    const response = await createStylistHandler(config, transport)(post(body()));
    expect([response.status, await response.json()]).toEqual([503, { code: 'BUSY' }]);
    expect(transport).not.toHaveBeenCalled();
  });
});
