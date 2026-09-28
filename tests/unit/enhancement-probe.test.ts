import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROBE_CALLS, prepareProbe, ProbeRefusal, runProbe } from '../../scripts/enhancement-probe.mjs';
import { HOSTED_URL } from '../../scripts/hosted-smoke.mjs';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl';
const TOKEN = 'probe-token-'.padEnd(48, 'x');
const KEY = 'sb_publishable_syntheticKey123';
const sampleBytes = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const outputBytes = new Uint8Array(2048).fill(9);
const env = (over: Record<string, string | undefined> = {}) => ({
  ALLOW_ENHANCEMENT_PROBE: '1', PROBE_PROJECT_URL: HOSTED_URL, PROBE_AUTHORISATION_ID: '11111111-1111-4111-8111-111111111111',
  PROBE_ACCESS_TOKEN: JWT, ENHANCE_PROBE_TOKEN: TOKEN, PROBE_PUBLISHABLE_KEY: KEY, PROBE_SAMPLES: '/samples', PROBE_OUTPUT: '/out', ...over,
});
const statusBody = (over: Record<string, unknown> = {}) => JSON.stringify({ code: 'INACTIVE', policy: { activated: false,
  manifestId: 'azure-global-image25-sunburst-enhance-v1', modelId: 'gpt-image-2.5-sunburst', providerAvailable: true, maxRequestMicro: '300000',
  enhanceAllowanceMicro: '5000000', totalAllowanceMicro: '20000000' }, usage: { enhanceMicro: '0', totalMicro: '0', enhanceLastHour: 0 }, ...over });

function harness(options: { listing?: unknown; reply?: (call: number) => Response; status?: () => Response; output?: string[] } = {}) {
  const files = new Map<string, Uint8Array | string>();
  const listing = options.listing ?? Array.from({ length: 6 }, (_, index) => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)),
    role: index < 5 ? 'visual' : 'disconnect' }));
  files.set('samples.json', JSON.stringify(listing));
  for (let index = 0; index < 6; index++) files.set(`s${index}.jpg`, sampleBytes(index));
  const fetches: { url: string; init: RequestInit }[] = [];
  const written: string[] = [];
  let calls = 0;
  const deps = {
    readFile: async (path: string, encoding?: string) => {
      const name = path.replace(/\\/g, '/').split('/').at(-1)!;
      const value = files.get(name);
      if (value === undefined) throw new Error('missing');
      return encoding ? String(value) : value;
    },
    readdir: async () => options.output ?? [],
    writeFile: async (path: string) => { written.push(path); },
    mkdir: async () => undefined,
    now: () => 0, sleep: async () => undefined,
    newId: () => `22222222-2222-4222-8222-${String(fetches.length).padStart(12, '0')}`,
    readHeader: () => ({ width: 800, height: 1000 }),
    inspect: () => ({ kind: 'preserve' }),
    admit: (bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: false }),
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (url.endsWith('/rpc/enhance_status')) return options.status?.() ?? new Response(statusBody(), { headers: { 'content-type': 'application/json' } });
      calls++;
      return options.reply?.(calls) ?? new Response(outputBytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(outputBytes.byteLength),
        'x-stillroom-enhancement-sha256': hash(outputBytes) } });
    },
  };
  return { deps, fetches, written, providerCalls: () => calls };
}

describe('enhancement probe script', () => {
  it('refuses every bad input with zero network calls', async () => {
    const cases: [Record<string, string | undefined>, Parameters<typeof harness>[0], string][] = [
      [{ ALLOW_ENHANCEMENT_PROBE: undefined }, {}, 'notAllowed'],
      [{ PROBE_PROJECT_URL: 'https://example.supabase.co' }, {}, 'project'],
      [{ PROBE_PROJECT_URL: `${HOSTED_URL}/` }, {}, 'project'],
      [{ PROBE_AUTHORISATION_ID: 'nope' }, {}, 'authorisation'],
      [{ PROBE_ACCESS_TOKEN: undefined }, {}, 'accessToken'],
      [{ ENHANCE_PROBE_TOKEN: 'short' }, {}, 'probeToken'],
      [{ PROBE_PUBLISHABLE_KEY: undefined }, {}, 'publishableKey'],
      [{}, { listing: [] }, 'samples'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)), role: 'visual' })) }, 'samples'],
      [{}, { listing: Array.from({ length: 7 }, (_, index) => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)), role: index < 5 ? 'visual' : 'disconnect' })) }, 'samples'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ file: `s${index}.jpg`, sha256: 'f'.repeat(64), role: index < 5 ? 'visual' : 'disconnect' })) }, 'sample'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ file: `../s${index}.jpg`, sha256: hash(sampleBytes(index)), role: index < 5 ? 'visual' : 'disconnect' })) }, 'samples'],
      [{}, { output: ['old.jpg'] }, 'output'],
    ];
    for (const [over, options, code] of cases) {
      const h = harness(options);
      await expect(runProbe(env(over), h.deps)).rejects.toEqual(new ProbeRefusal(code));
      expect(h.fetches).toHaveLength(0);
    }
  });

  it('sends at most 6 paid calls with the probe headers and no Origin, then observes the ledger', async () => {
    const h = harness({ reply: (call) => call === 6 ? (() => { throw new DOMException('aborted', 'AbortError'); })() : new Response(outputBytes, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(outputBytes.byteLength), 'x-stillroom-enhancement-sha256': hash(outputBytes) } }) });
    const { lines, calls } = await runProbe(env(), h.deps);
    expect(h.providerCalls()).toBe(PROBE_CALLS);
    expect(calls.map((entry: { code: string }) => entry.code)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'TRANSPORT']);
    expect(h.written).toHaveLength(5);
    const sent = h.fetches.filter(entry => entry.url.endsWith('/functions/v1/enhance-photo'));
    for (const entry of sent) {
      const headers = entry.init.headers as Record<string, string>;
      expect(headers['X-Stillroom-Probe-Authorisation']).toBe('11111111-1111-4111-8111-111111111111');
      expect(Object.keys(headers).some(name => name.toLowerCase() === 'origin')).toBe(false);
      expect(entry.init.redirect).toBe('error');
      expect(entry.url).toBe(`${HOSTED_URL}/functions/v1/enhance-photo`);
    }
    expect(lines.some((line: string) => line.startsWith('Ledger after 180 s'))).toBe(true);
    expect(lines.at(-1)).toBe('Paid calls sent: 6 of at most 6.');
  });

  it('stops after a failed call with no later calls', async () => {
    const h = harness({ reply: (call) => call === 2 ? new Response(JSON.stringify({ code: 'FAILED' }), { status: 502, headers: { 'content-type': 'application/json' } })
      : new Response(outputBytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(outputBytes.byteLength), 'x-stillroom-enhancement-sha256': hash(outputBytes) } }) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(h.providerCalls()).toBe(2);
    expect(calls.at(-1)?.code).toBe('FAILED');
    expect(lines).toContain('Stopped after call 2: FAILED.');
  });

  it('stops before dispatch when the owner is activated or the allowance cannot hold a reservation', async () => {
    for (const body of [statusBody({ code: 'OK', policy: { ...JSON.parse(statusBody()).policy, activated: true } }),
      statusBody({ usage: { enhanceMicro: '4800000', totalMicro: '0', enhanceLastHour: 0 } })]) {
      const h = harness({ status: () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
      const { calls } = await runProbe(env(), h.deps);
      expect(calls).toHaveLength(0);
      expect(h.providerCalls()).toBe(0);
    }
  });

  it('keeps tokens, JWTs, headers and image bytes out of the report', async () => {
    const h = harness();
    const { lines } = await runProbe(env(), h.deps);
    const report = lines.join('\n');
    for (const secret of [TOKEN, JWT, KEY, Buffer.from(outputBytes).toString('base64').slice(0, 24), 'Bearer', 'X-Stillroom-Probe-Token']) {
      expect(report).not.toContain(secret);
    }
    expect(/[A-Za-z0-9+/]{120,}/.test(report)).toBe(false);
  });

  it('prepares nothing from a samples folder that is not exactly 5 visual and 1 disconnect', async () => {
    const h = harness({ listing: Array.from({ length: 6 }, (_, index) => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)), role: index === 0 ? 'disconnect' : 'visual' })) });
    await expect(prepareProbe(env(), h.deps)).rejects.toBeInstanceOf(ProbeRefusal);
  });
});
