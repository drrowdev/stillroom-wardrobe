import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { earliestStart, evidenceState, PROBE_CALLS, prepareProbe, ProbeRefusal, REFERENCE_BYTES, runProbe } from '../../scripts/enhancement-probe.mjs';
import { HOSTED_URL } from '../../scripts/hosted-smoke.mjs';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl';
const TOKEN = 'probe-token-'.padEnd(48, 'x');
const KEY = 'sb_publishable_syntheticKey123';
const sampleBytes = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const outputBytes = new Uint8Array(2048).fill(9);
const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const SWITCH_ON = '2026-10-05T11:58:00.000Z';
const COMMIT = 'a'.repeat(40);
const MODEL = 'b'.repeat(64);
const referenceBytes = (n: number) => { const r = new Uint8Array(REFERENCE_BYTES); r[n] = 1; return r; };
const bindingFor = (index: number, over: Record<string, unknown> = {}) => ({ version: 1, commit: COMMIT, modelSha256: MODEL,
  sampleSha256: 'c'.repeat(64), crop: { x: 0, y: 0, width: 1, height: 1 }, frame: { width: 800, height: 1000 },
  h0: { sha256: hash(sampleBytes(index)), bytes: sampleBytes(index).byteLength, width: 800, height: 1000 },
  reference: { sha256: hash(referenceBytes(index)), bytes: REFERENCE_BYTES }, ambiguous: false, ...over });
const entry = (index: number, role = index < 5 ? 'visual' : 'disconnect') => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)),
  reference: `s${index}.bin`, binding: `s${index}.json`, role });
const env = (over: Record<string, string | undefined> = {}) => ({
  ALLOW_ENHANCEMENT_PROBE: '1', PROBE_PROJECT_URL: HOSTED_URL, PROBE_AUTHORISATION_ID: '11111111-1111-4111-8111-111111111111',
  PROBE_ACCESS_TOKEN: JWT, ENHANCE_PROBE_TOKEN: TOKEN, PROBE_PUBLISHABLE_KEY: KEY, PROBE_SAMPLES: '/samples', PROBE_OUTPUT: '/out', PROBE_SWITCH_ON_AT: SWITCH_ON, ...over,
});
const statusBody = (over: Record<string, unknown> = {}) => JSON.stringify({ code: 'INACTIVE', policy: { activated: false,
  manifestId: 'azure-global-image25-sunburst-cleanup-v1', modelId: 'gpt-image-2.5-sunburst', providerAvailable: true, maxRequestMicro: '300000',
  enhanceAllowanceMicro: '5000000', totalAllowanceMicro: '20000000' }, usage: { enhanceMicro: '0', totalMicro: '0', enhanceLastHour: 0 }, ...over });

type HarnessOptions = { listing?: unknown; reply?: (call: number) => Response; status?: () => Response; output?: string[];
  binding?: (index: number) => unknown; reference?: (index: number) => Uint8Array; latencyMs?: (call: number) => number };
function harness(options: HarnessOptions = {}) {
  const files = new Map<string, Uint8Array | string>();
  const listing = options.listing ?? Array.from({ length: 6 }, (_, index) => entry(index));
  files.set('samples.json', JSON.stringify(listing));
  for (let index = 0; index < 6; index++) {
    files.set(`s${index}.jpg`, sampleBytes(index));
    files.set(`s${index}.bin`, options.reference?.(index) ?? referenceBytes(index));
    files.set(`s${index}.json`, JSON.stringify(options.binding?.(index) ?? bindingFor(index)));
  }
  let clock = T0;
  const dispatches: number[] = [];
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
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
    newId: () => `22222222-2222-4222-8222-${String(fetches.length).padStart(12, '0')}`,
    readHeader: () => ({ width: 800, height: 1000 }),
    accepts: () => true,
    admit: (bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: false }),
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (url.endsWith('/rpc/enhance_status')) return options.status?.() ?? new Response(statusBody(), { headers: { 'content-type': 'application/json' } });
      calls++;
      dispatches.push(clock);
      clock += options.latencyMs?.(calls) ?? 1_000;
      return options.reply?.(calls) ?? new Response(outputBytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(outputBytes.byteLength),
        'x-stillroom-enhancement-sha256': hash(outputBytes) } });
    },
  };
  return { deps, fetches, written, providerCalls: () => calls, dispatches };
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
      [{}, { listing: Array.from({ length: 6 }, (_, index) => entry(index, 'visual')) }, 'samples'],
      [{}, { listing: Array.from({ length: 7 }, (_, index) => entry(index, index < 5 ? 'visual' : 'disconnect')) }, 'samples'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ ...entry(index), sha256: 'f'.repeat(64) })) }, 'sample'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ ...entry(index), file: `../s${index}.jpg` })) }, 'samples'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ ...entry(index), reference: `../s${index}.bin` })) }, 'samples'],
      [{}, { listing: Array.from({ length: 6 }, (_, index) => ({ file: `s${index}.jpg`, sha256: hash(sampleBytes(index)), role: index < 5 ? 'visual' : 'disconnect' })) }, 'samples'],
      [{}, { binding: (index) => bindingFor(index, { h0: { ...bindingFor(index).h0 as object, sha256: 'e'.repeat(64) } }) }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { h0: { ...bindingFor(index).h0 as object, width: 801 } }) }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { commit: index === 3 ? 'd'.repeat(40) : COMMIT }) }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { commit: 'not-a-commit' }) }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { modelSha256: index === 2 ? 'd'.repeat(64) : MODEL }) }, 'binding'],
      [{}, { binding: (index) => ({ ...bindingFor(index), extra: 1 }) }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { ambiguous: index === 1 }) }, 'ambiguous'],
      [{}, { reference: () => new Uint8Array(REFERENCE_BYTES - 1) }, 'binding'],
      [{}, { reference: (index) => { const r = referenceBytes(index); r[7] = 255; return r; } }, 'binding'],
      [{}, { binding: (index) => bindingFor(index, { reference: { sha256: 'f'.repeat(64), bytes: REFERENCE_BYTES } }) }, 'binding'],
      [{ PROBE_SWITCH_ON_AT: undefined }, {}, 'switchOnTime'],
      [{ PROBE_SWITCH_ON_AT: '2026-10-05 11:58' }, {}, 'switchOnTime'],
      [{ PROBE_SWITCH_ON_AT: '2026-10-05T12:30:00.000Z' }, {}, 'switchOnTime'],
      [{ PROBE_LAST_KEY_USE_AT: 'yesterday' }, {}, 'lastKeyUse'],
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
    expect(h.written.filter(path => path.endsWith('.jpg'))).toHaveLength(5);
    expect(h.written.filter(path => path.endsWith('.json'))).toHaveLength(6);
    const sent = h.fetches.filter(entry => entry.url.endsWith('/functions/v1/enhance-photo'));
    for (const entry of sent) {
      const headers = entry.init.headers as Record<string, string>;
      expect(headers['X-Stillroom-Probe-Authorisation']).toBe('11111111-1111-4111-8111-111111111111');
      expect(Object.keys(headers).some(name => name.toLowerCase() === 'origin')).toBe(false);
      expect(entry.init.redirect).toBe('error');
      expect(entry.url).toBe(`${HOSTED_URL}/functions/v1/enhance-photo`);
    }
    expect(lines.some((line: string) => line.startsWith('Ledger after 180 s'))).toBe(true);
    expect(lines).toContain('Paid calls sent: 6 of at most 6.');
    expect(lines.at(-1)).toMatch(/^Evidence: \{"state":"pending"/);
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

  it('paces fast responses by the real slot lifetime, not only 33 s since the last dispatch (R4)', async () => {
    const h = harness({ latencyMs: () => 1_000 });
    await runProbe(env(), h.deps);
    const [s1, s2, s3] = h.dispatches as [number, number, number];
    expect(s1).toBe(T0);
    expect(s2 - s1).toBe(33_000);
    // 33 s after the 2nd dispatch has passed at s1 + 66 s, but call 1's slot may live until r1 + 65 s.
    expect(s3 - s2).toBeGreaterThan(33_000);
    expect(s3).toBe(s1 + 1_000 + 66_000);
    for (let k = 2; k < h.dispatches.length; k++) {
      expect(h.dispatches[k]! - h.dispatches[k - 1]!).toBeGreaterThanOrEqual(33_000);
      expect(h.dispatches[k]!).toBeGreaterThanOrEqual(h.dispatches[k - 2]! + 1_000 + 66_000);
    }
  });

  it('lets the 33 s spacing bind when the previous call returned well within it', async () => {
    const h = harness({ latencyMs: () => 10_000 });
    await runProbe(env(), h.deps);
    expect(h.dispatches[1]! - h.dispatches[0]!).toBe(33_000);
  });

  it('waits out the switch-on time and any known earlier key use before the first call', async () => {
    const recent = harness();
    await runProbe(env({ PROBE_SWITCH_ON_AT: new Date(T0 - 10_000).toISOString() }), recent.deps);
    expect(recent.dispatches[0]).toBe(T0 - 10_000 + 66_000);
    const used = harness();
    await runProbe(env({ PROBE_LAST_KEY_USE_AT: new Date(T0 - 5_000).toISOString() }), used.deps);
    expect(used.dispatches[0]).toBe(T0 - 5_000 + 66_000);
    expect(earliestStart({ notBefore: 5 }, [], [])).toBe(5);
  });

  it('stops on RATE_LIMIT with no retry and leaves the rest pending', async () => {
    const h = harness({ reply: (call) => call === 3 ? new Response(JSON.stringify({ code: 'RATE_LIMIT' }), { status: 429,
      headers: { 'content-type': 'application/json' } }) : new Response(outputBytes, { headers: { 'content-type': 'image/jpeg',
      'content-length': String(outputBytes.byteLength), 'x-stillroom-enhancement-sha256': hash(outputBytes) } }) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(h.providerCalls()).toBe(3);
    expect(calls.map((entry: { code: string }) => entry.code)).toEqual(['OK', 'OK', 'RATE_LIMIT']);
    expect(lines).toContain('Stopped after call 3: RATE_LIMIT.');
    expect(lines.at(-1)).toContain('"state":"pending"');
  });

  it('keeps acceptance pending without visual metrics or the disconnect settlement read-back', () => {
    const calls = [...Array.from({ length: 5 }, (_, index) => ({ call: index + 1, role: 'visual', code: 'OK', requestId: `r${index}` })),
      { call: 6, role: 'disconnect', code: 'DISCONNECTED', requestId: 'r5' }];
    const metrics = Object.fromEntries(calls.slice(0, 5).map(entry => [entry.requestId, { reason: 'accepted' }]));
    const settled = { requestId: 'r5', terminal: true, accounted: true, slotEnded: true };
    expect(evidenceState(calls, metrics, settled)).toEqual({ state: 'ready-for-paired-review', missing: [] });
    expect(evidenceState(calls, {}, settled).missing).toEqual(['metrics-1', 'metrics-2', 'metrics-3', 'metrics-4', 'metrics-5']);
    expect(evidenceState(calls, metrics, null).missing).toEqual(['disconnect-settlement']);
    expect(evidenceState(calls, metrics, { ...settled, slotEnded: false }).state).toBe('pending');
    expect(evidenceState(calls, metrics, { ...settled, requestId: 'other' }).state).toBe('pending');
    expect(evidenceState(calls.slice(0, 4), metrics, settled).missing).toContain('calls');
    expect(evidenceState([{ ...calls[0], code: 'FAILED' }, ...calls.slice(1)], metrics, settled).missing).toContain('call-1');
  });

  it('prepares nothing from a samples folder that is not exactly 5 visual and 1 disconnect', async () => {
    const h = harness({ listing: Array.from({ length: 6 }, (_, index) => entry(index, index === 0 ? 'disconnect' : 'visual')) });
    await expect(prepareProbe(env(), h.deps)).rejects.toBeInstanceOf(ProbeRefusal);
  });
});
