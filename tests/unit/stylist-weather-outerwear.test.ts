import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STYLIST_ITEM_FIELDS, STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_PROMPT, buildStylistRequest, orderStylistItems, weatherAppliesTo,
  type StylistInput, type StylistItem,
} from '../../src/domain/stylist';
import { createStylistHandler } from '../../supabase/functions/stylist-chat/handler';

// Source checks only. Nothing here shows how the real model behaves; that stays an owner-approved paid trial.
const read = (name: string) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (overrides: Partial<StylistInput> = {}): StylistInput => ({ requestId: REQUEST, message: 'Something for the office',
  history: [], occasion: 'business', season: 'autumn', weather: null, ...overrides });
const item = (n: number, overrides: Partial<StylistItem> = {}): StylistItem => ({ id: id(n), category: 'top', colours: ['navy'],
  pattern: 'solid', sleeve_length: 'long', garment_length: 'regular', seasons: ['autumn'], formality: 3, warmth: 2, min_temp: 12,
  max_temp: 18, rain_rating: 2, windproof: true, upper_coverage: 2, lower_coverage: null, favourite: false, ...overrides });
const rainy = { setting: 'outdoors' as const, temperatureC: 4, rainProbability: 90, windMetresPerSecond: 12 };
const messagesOf = (body: Record<string, unknown>) => body.messages as Array<{ role: string; content: string }>;
const clothesOf = (body: Record<string, unknown>) =>
  (JSON.parse(messagesOf(body)[1]!.content) as { clothes: Array<Record<string, unknown>> }).clothes;

describe('weather influences only outerwear (RAIN1)', () => {
  it('names outerwear as the only category the weather applies to', () => {
    expect(weatherAppliesTo('outerwear')).toBe(true);
    for (const category of ['top', 'bottom', 'one_piece', 'layer', 'footwear', 'accessory', '']) expect(weatherAppliesTo(category)).toBe(false);
  });

  it('changes only the two prompt sentences of v1 and stays inside the system budget', () => {
    expect(STYLIST_PROMPT).toContain('never by the weather');
    expect(STYLIST_PROMPT).toContain('The weather may influence only outerwear');
    expect(STYLIST_PROMPT).toContain('Never refuse, drop a garment or add a layer, footwear or accessory because of the weather.');
    expect(STYLIST_PROMPT).toContain('A missing or null value means unknown, not unusable.');
    expect(STYLIST_PROMPT).toContain('Never call a garment waterproof or windproof unless its rating says so');
    expect(STYLIST_PROMPT).toContain('return no outfits and say what is missing');
    expect(STYLIST_PROMPT).not.toContain('match the weather');
    expect(new TextEncoder().encode(STYLIST_PROMPT).length).toBeLessThanOrEqual(2000);
  });

  it('sends the new prompt as the system message of the actual request', () => {
    const built = buildStylistRequest(input({ weather: rainy }), [item(1)]);
    expect(messagesOf(built.body)[0]).toEqual({ role: 'system', content: STYLIST_PROMPT });
  });

  it('keeps the weather fields of outerwear and sends them as unknown for every other category', () => {
    const items = [item(1, { category: 'top' }), item(2, { category: 'bottom' }), item(3, { category: 'footwear' }),
      item(4, { category: 'layer' }), item(5, { category: 'accessory' }), item(6, { category: 'one_piece' }),
      item(7, { category: 'outerwear' })];
    const built = buildStylistRequest(input({ weather: rainy }), items);
    const clothes = clothesOf(built.body);
    expect(clothes).toHaveLength(7);
    for (const entry of clothes) {
      expect(Object.keys(entry).sort()).toEqual([...STYLIST_ITEM_FIELDS, 'ref'].sort());
      const weatherFields = [entry.min_temp, entry.max_temp, entry.rain_rating, entry.windproof];
      if (entry.category === 'outerwear') expect(weatherFields).toEqual([12, 18, 2, true]);
      else {
        expect(weatherFields).toEqual([null, null, null, null]);
        expect(entry.warmth).toBe(2);
      }
    }
  });

  it('ranks by temperature fit only for outerwear', () => {
    const outerwear = (n: number, minTemp: number, maxTemp: number) => item(n, { category: 'outerwear', min_temp: minTemp, max_temp: maxTemp });
    const fits = outerwear(1, 0, 10), misses = outerwear(2, 20, 30);
    const cold = input({ weather: { ...rainy, temperatureC: 5 } });
    expect(orderStylistItems([misses, fits], cold)[0]!.id).toBe(id(1));
    const tops = [item(3, { min_temp: 20, max_temp: 30 }), item(4, { min_temp: 0, max_temp: 10 })];
    expect(orderStylistItems(tops, cold).map((entry) => entry.id)).toEqual(orderStylistItems(tops, input()).map((entry) => entry.id));
    expect(orderStylistItems([...tops].reverse(), cold).map((entry) => entry.id)).toEqual(orderStylistItems(tops, cold).map((entry) => entry.id));
  });
});

describe('forward manifest migration (RAIN1)', () => {
  it('leaves the v1 migration as recorded and adds v2 in its own transaction', async () => {
    const v1 = await read('20260928090000_stylist_chat.sql');
    const v2 = await read('20261009090000_stylist_weather_outerwear.sql');
    expect(v1).toContain("m.id<>'azure-eu-terra-stylist-v1'");
    expect(v2.indexOf('begin;')).toBeGreaterThan(-1);
    expect(v2.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('inserts a v2 row that copies the v1 numbers and differs only in version, hashes and description', async () => {
    const v1 = await read('20260928090000_stylist_chat.sql');
    const v2 = await read('20261009090000_stylist_weather_outerwear.sql');
    const row = (sql: string, manifest: string) => {
      const start = sql.indexOf(`insert into private.ai_execution_manifests values (\n  '${manifest}'`);
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start, sql.indexOf('\n);', start));
    };
    const old = row(v1, 'azure-eu-terra-stylist-v1'), next = row(v2, STYLIST_MANIFEST);
    const strip = (text: string) => text.replace(/'azure-eu-terra-stylist-v[12]'/, 'ID').replace(/,[12],\n/, ',N,\n')
      .replace(/\n {2}'[0-9a-f]{64}',\n {2}'[0-9a-f]{64}',\n {2}'[0-9a-f]{64}',/, '\n  HASHES,').replace(/\n {2}'INACTIVE[^\n]*',/, '\n  DESCRIPTION,');
    expect(strip(next)).toBe(strip(old));
    expect(next).toContain(`'${sha(STYLIST_PROMPT)}'`);
    expect(next).toContain(`'${STYLIST_MANIFEST}','${STYLIST_MODEL}',2,`);
    expect(next).toContain("'2026-12-01T00:00:00Z'");
  });

  it('replaces only the claim, with one admitted-manifest change, and touches no controls, grants or data', async () => {
    const v1 = await read('20260928090000_stylist_chat.sql');
    const v2 = await read('20261009090000_stylist_weather_outerwear.sql');
    const body = (sql: string, header: string) => {
      const start = sql.indexOf(header);
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start, sql.indexOf('\n$$;', start) + 4);
    };
    const oldBody = body(v1, 'create function public.stylist_claim(');
    const newBody = body(v2, 'create or replace function public.stylist_claim(');
    expect(newBody).toBe(oldBody.replace('create function', 'create or replace function')
      .replace("m.id<>'azure-eu-terra-stylist-v1'", "m.id not in ('azure-eu-terra-stylist-v1','azure-eu-terra-stylist-v2')"));
    expect(newBody).toContain('c.stylist_manifest_id<>m.id');
    expect(v2.match(/^create (or replace )?function /gm)).toHaveLength(1);
    const code = v2.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code).not.toMatch(/^(alter|drop|grant|revoke|update|delete|truncate)\b/im);
    expect(code).not.toMatch(/^insert into (?!private\.ai_execution_manifests)/im);
    expect(code.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
  });
});

describe('stylist handler across the manifest cutover (RAIN1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'fictional-public', serviceKey: 'fictional-service',
    azure: { apiKey: 'fictional-azure' } };
  const policy = (manifestId: string) => ({ code: 'OK', consent: { enabled: true, noticeRevision: 1 }, policy: { activated: true,
    noticeRevision: 1, manifestId, modelId: STYLIST_MODEL, maxRequestMicro: '200000' } });
  function backend(manifestId: string, items: StylistItem[]) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url.split('/').pop()!);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/stylist_status')) return Response.json(policy(manifestId));
      if (url.endsWith('/rpc/stylist_claim')) return Response.json({ code: 'OK', claimed: true, manifestId, dispatchBeforeMs: Date.now() + 5000, items });
      if (url.endsWith('/rpc/stylist_finish')) return Response.json({ code: 'OK', accounting: { basis: 'confirmed', amountMicro: '5000', currency: 'USD' } });
      throw new Error(`unexpected fetch ${url}`);
    }));
    return calls;
  }
  const post = (value: unknown) => new Request('http://127.0.0.1:54321/functions/v1/stylist-chat', { method: 'POST',
    headers: { Authorization: 'Bearer fictional.jwt.token', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const message = { requestId: REQUEST, message: 'Something for the office', history: [], occasion: 'business', season: 'autumn',
    weather: rainy };
  const transportFor = () => {
    const sent: Array<Record<string, unknown>> = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ model: STYLIST_MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ reply: 'Here is one.', outfits: [{ refs: ['i1'], note: '' }] }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 50 } } });
    });
    return { transport, sent };
  };

  it('under v2 sends the new prompt and keeps every usable non-outerwear garment even when it is cold and wet', async () => {
    const calls = backend(STYLIST_MANIFEST, [item(1, { category: 'top', min_temp: 15, max_temp: 25 }),
      item(2, { category: 'bottom', min_temp: 15, max_temp: 25 }), item(3, { category: 'outerwear', min_temp: 20, max_temp: 30 }),
      item(4, { category: 'outerwear', min_temp: 0, max_temp: 10, rain_rating: 1 })]);
    const { transport, sent } = transportFor();
    const response = await createStylistHandler(config, transport)(post(message));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['user', 'stylist_status', 'stylist_claim', 'stylist_finish']);
    expect(sent).toHaveLength(1);
    expect(messagesOf(sent[0]!)[0]!.content).toBe(STYLIST_PROMPT);
    expect(clothesOf(sent[0]!).map((entry) => entry.category).sort()).toEqual(['bottom', 'outerwear', 'top']);
    const outerwear = clothesOf(sent[0]!).find((entry) => entry.category === 'outerwear')!;
    expect(outerwear).toMatchObject({ min_temp: 0, max_temp: 10, rain_rating: 1 });
  });

  it('returns UNCONFIGURED without a provider call while the owner controls still select v1', async () => {
    const calls = backend('azure-eu-terra-stylist-v1', [item(1)]);
    const { transport } = transportFor();
    const response = await createStylistHandler(config, transport)(post(message));
    expect([response.status, (await response.json()).code]).toEqual([503, 'UNCONFIGURED']);
    expect(calls).toEqual(['user', 'stylist_status']);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a claim that names the v1 manifest without a provider call', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: OWNER, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/rpc/stylist_status')) return Response.json(policy(STYLIST_MANIFEST));
      if (url.endsWith('/rpc/stylist_claim')) return Response.json({ code: 'OK', claimed: true, manifestId: 'azure-eu-terra-stylist-v1',
        dispatchBeforeMs: Date.now() + 5000, items: [item(1)] });
      throw new Error(`unexpected fetch ${url}`);
    }));
    const { transport } = transportFor();
    const response = await createStylistHandler(config, transport)(post(message));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps the claim-side eligibility rules and the closed item shape under v2', async () => {
    const sql = await read('20261009090000_stylist_weather_outerwear.sql');
    for (const rule of ["i.owner_id=p.owner_id and i.deleted_at is null and i.lifecycle='active' and i.availability='ready'", 'and not i.exclude_suggestions']) expect(sql).toContain(rule);
  });
});
