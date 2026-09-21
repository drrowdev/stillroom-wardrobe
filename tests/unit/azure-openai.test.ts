import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  AZURE_MODEL, AZURE_MANIFEST, AZURE_ENDPOINT, AZURE_PROMPT, AZURE_SCHEMA, AZURE_SETTINGS,
  analyzeAzure, azureRequest, observeAzureUsage, validAzureFacts, validAzureUsage,
} from '../../supabase/functions/analyze-clothing/azure-openai';
import { aiNoticeProfile, parseAnalysisReply, parseAiStatus, supportedAiPolicy } from '../../src/domain/ai-controls';
import messages from '../../src/i18n/messages.json';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers';

const fields = Object.fromEntries(AZURE_SCHEMA.properties.fields.required.map((key) =>
  [key, ['colours', 'seasons', 'style_tags'].includes(key) ? [] : null]));
const facts = { outcome: 'ready', fields: { ...fields, category: 'top', colours: ['green'], formality: 0 } };
const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } };
const response = () => ({ model: AZURE_MODEL, usage: structuredClone(usage),
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', refusal: null, content: JSON.stringify(facts) } }] });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
describe('fixed inactive Azure profile', () => {
  it('pins exact NFC literals and independent Google identity without rewriting historical manifests', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20260921193000_azure_terra_analysis.sql', import.meta.url), 'utf8');
    const entries = [[AZURE_PROMPT, 1421, 'fd0218f1e71b7902af437cb58f17c724883c78f3d76d085ca8bbb1cea0eb25ff'],
      [JSON.stringify(AZURE_SCHEMA), 1543, '84d87dca033cc587c6cae54cc8a0a2936f3dabefa0ab18fb4c3ee03467cc8ff1'],
      [JSON.stringify(AZURE_SETTINGS), 1780, '8a4eef8a47549d57d2466148efee37ebaeed57beb6a046c5a464e977da15eb88']] as const;
    for (const [value, length, hash] of entries) {
      expect(Buffer.byteLength(value)).toBe(length); expect(digest(value)).toBe(hash);
      expect(value.normalize('NFC')).toBe(value); expect(sql).toContain(hash);
    }
    const notice = JSON.stringify({ noticeRevision: 2, 'aiC.notice': messages['aiC.azureNotice'],
      'aiC.trainingNotice': messages['aiC.azureTrainingNotice'] });
    expect(Buffer.byteLength(notice)).toBe(991);
    expect(digest(notice)).toBe('606487b1c973f49c739dfac8ca8c15bcad33d190fdbcc83147cdd60112c51d24');
    expect(messages['aiC.notice'].en).toContain('Google Cloud');
    expect((922000n * 440n + 2048n * 1980n + 99n) / 100n).toBe(4097351n);
  });
  it('sends exactly approved controls and unchanged prepared bytes to one fixed endpoint', async () => {
    const image = jpegHeaderFixture();
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(AZURE_ENDPOINT);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(azureRequest(image));
      expect(Object.keys(body).sort()).toEqual(['model','n','stream','reasoning_effort','max_completion_tokens',
        'store','prompt_cache_options','messages','response_format'].sort());
      expect(Buffer.from(body.messages[1].content[0].image_url.url.split(',')[1], 'base64')).toEqual(Buffer.from(image));
      expect(body.messages[0]).toEqual({ role: 'system', content: AZURE_PROMPT });
      return Response.json(response());
    });
    const result = await analyzeAzure({ apiKey: 'fictional-unit-only' }, image, AbortSignal.timeout(1000), transport);
    expect(result.facts).toEqual(facts); expect(validAzureUsage(result.usage)).toBe(true);
    expect(result.usage).toEqual({ input: 100, output: 30, total: 130, reasoning: 20, cacheRead: 0,
      cacheWrite: 0, modelObservation: 'expected_snapshot', controlObservation: 'ordinary' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['gpt-5.6-terra-2026-07-09', 'gpt-5.6-terra', 'eval-terra-20260709', 'unexpected', undefined])(
    'records only finite identity evidence for %s', (model) => {
      const observed = observeAzureUsage({ ...(model === undefined ? {} : { model }), usage });
      expect(observed.modelObservation).toBe(model === AZURE_MODEL ? 'expected_snapshot' : model === 'gpt-5.6-terra'
        ? 'model_family' : model === 'eval-terra-20260709' ? 'deployment_alias'
          : model === undefined ? 'response_missing_model' : 'response_unrecognised_model');
      expect(JSON.stringify(observed)).not.toContain('unexpected');
    });
  it('ignores extensions without persisting their names, types or values', () => {
    expect(observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage, private_extension: { private: 'ignored' } } }))
      .toEqual(observeAzureUsage({ model: AZURE_MODEL, usage }));
  });
  it.each(['prompt_tokens', 'completion_tokens', 'total_tokens'])('requires the %s counter with no default zero', (key) => {
    for (const bad of [null, undefined, -1, 0.1, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(validAzureUsage(observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage, [key]: bad } }))).toBe(false);
    }
  });
  it('rejects missing nested counters and inconsistent totals but retains independent cache anomalies', () => {
    for (const details of [{}, { reasoning_tokens: null }, { reasoning_tokens: 31 }]) {
      expect(validAzureUsage(observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage, completion_tokens_details: details } }))).toBe(false);
    }
    const observed = observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage, total_tokens: null,
      prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 } } });
    expect(validAzureUsage(observed)).toBe(false); expect(observed.controlObservation).toBe('cache_read_write');
    expect(validAzureUsage(observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage, total_tokens: 131 } }))).toBe(false);
  });
  it.each(['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'])('retains known %s contradictions', (key) => {
    expect(observeAzureUsage({ model: AZURE_MODEL, usage: { ...usage,
      completion_tokens_details: { ...usage.completion_tokens_details, [key]: 1 } } }).controlObservation).toBe('contradictory');
  });
  it('enforces all14 keys, unique/capped arrays, code-point lengths and unknown-not-zero', () => {
    expect(validAzureFacts(facts)).toBe(true);
    expect(validAzureFacts({ outcome: 'ready', fields: {} })).toBe(false);
    expect(validAzureFacts({ outcome: 'unclear', fields })).toBe(true);
    expect(validAzureFacts({ outcome: 'unclear', fields: { ...fields, formality: 0 } })).toBe(false);
    for (const bad of [{ colours: ['green', 'green'] }, { colours: ['blue', 'green', 'red', 'black'] },
      { style_tags: [''] }, { subcategory: 'x'.repeat(61) }, { brand: '\0' }]) {
      expect(validAzureFacts({ ...facts, fields: { ...facts.fields, ...bad } })).toBe(false);
    }
    expect(validAzureFacts({ ...facts, fields: { ...facts.fields, brand: 'Case Sensitive', size_label: 'XL' } })).toBe(true);
  });
  it.each(['length', 'content_filter', 'tool_calls'])('keeps valid billing for rejected finish %s', async (finish_reason) => {
    const value = response(); value.choices[0]!.finish_reason = finish_reason;
    const result = await analyzeAzure({ apiKey: 'fictional' }, jpegHeaderFixture(), AbortSignal.timeout(1000),
      async () => Response.json(value));
    expect(result.facts).toBeNull(); expect(validAzureUsage(result.usage)).toBe(true);
  });
  it('keeps valid billing for invalid JSON and HTTP errors, without retry', async () => {
    for (const status of [200, 429, 500]) {
      const value = response(); value.choices[0]!.message.content = '{';
      const transport = vi.fn(async () => Response.json(value, { status }));
      const result = await analyzeAzure({ apiKey: 'fictional' }, jpegHeaderFixture(), AbortSignal.timeout(1000), transport);
      expect(result.facts).toBeNull(); expect(validAzureUsage(result.usage)).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds response streams and does not retry failures', async () => {
    const cancel = vi.fn(), transport = vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(262145)); }, cancel,
    }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(analyzeAzure({ apiKey: 'fictional' }, jpegHeaderFixture(), AbortSignal.timeout(1000), transport)).rejects.toThrow('TOO_LARGE');
    expect(cancel).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
  });
});
describe('historical receipt reading versus Azure-only new dispatch', () => {
  it('reads Google and Azure ready receipts after Azure review expiry without admitting new analysis', () => {
    for (const modelId of ['gemini-3.8-flash', AZURE_MODEL]) {
      expect(parseAnalysisReply({ code: 'OK', status: 'ready', accounting: { basis: 'estimated', amountMicro: '1034', currency: 'USD' },
        result: { schemaVersion: 1, requestId: '10000000-0000-4000-8000-000000000001',
          draftId: '20000000-0000-4000-8000-000000000001', generation: 1, imageSha256: 'a'.repeat(64),
          modelId, promptVersion: 1, createdAtMs: Date.parse('2026-11-01'), expiresAtMs: Date.parse('2026-11-01') + 60000,
          facts: { outcome: 'ready', fields: modelId === AZURE_MODEL ? facts.fields : { category: 'top' } } } })?.code).toBe('OK');
    }
    const status = parseAiStatus({ code: 'OK', period: '2026-09', serverTimeMs: Date.parse('2026-09-21'),
      consent: { enabled: true, noticeRevision: 2, consentedAt: '2026-09-21T00:00:00Z', profileVersion: '1' },
      policy: { activated: true, modelId: AZURE_MODEL, promptVersion: 1, noticeRevision: 2,
        executionManifestId: AZURE_MANIFEST, maxRequestMicro: '4097351', monthlyAllowanceMicro: '50000000',
        maxRequestsPerHour: 100, resultTtlSeconds: 3600 },
      usage: { accountedMicro: '0', requestsLastHour: 0, warning: false } })!;
    expect(supportedAiPolicy(status, Date.parse('2026-09-21'))).toBe(true);
    expect(supportedAiPolicy(status, Date.parse('2026-10-21'))).toBe(false);
    expect(aiNoticeProfile(status.policy)).toBe('azure');
    const legacy = { ...status, policy: { ...status.policy!, modelId: 'gemini-3.8-flash', noticeRevision: 1,
      executionManifestId: 'google-eu-3.8-v1' } };
    expect(aiNoticeProfile(legacy.policy)).toBe('google'); expect(supportedAiPolicy(legacy)).toBe(false);
  });
});
