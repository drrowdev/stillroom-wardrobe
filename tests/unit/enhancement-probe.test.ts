import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  earliestStart, evidenceState, metricsEvidence, PROBE_CALLS, prepareProbe, ProbeRefusal, REASON_METRICS, REFERENCE_BYTES, runProbe, V2_REASON_METRICS,
} from '../../scripts/enhancement-probe.mjs';
import { HOSTED_URL } from '../../scripts/hosted-smoke.mjs';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl';
const TOKEN = 'probe-token-'.padEnd(48, 'x');
const KEY = 'sb_publishable_syntheticKey123';
const sampleBytes = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);
const outputBytes = new Uint8Array(2048).fill(9);
const T0 = Date.parse('2026-10-05T12:00:00.000Z');
// The monotonic clock starts somewhere unrelated to wall time, as performance.now() does.
const MONO0 = 5_000;
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
const budget = (used = '0', allowance = '20000000') => ({ monthlyAllowanceMicro: allowance, usedMicro: used,
  remainingMicro: String(BigInt(allowance) - BigInt(used)), warning: false });
const statusBody = (over: Record<string, unknown> = {}) => JSON.stringify({ code: 'INACTIVE', policy: { activated: false,
  manifestId: 'azure-global-image25-sunburst-cleanup-v1', modelId: 'gpt-image-2.5-sunburst', providerAvailable: true, maxRequestMicro: '300000',
  }, budget: budget(), ...over });

type HarnessOptions = { listing?: unknown; reply?: (call: number) => Response; status?: () => Response; output?: string[];
  binding?: (index: number) => unknown; reference?: (index: number) => Uint8Array; latencyMs?: (call: number) => number;
  /** Wall-clock jumps only: after call N's reply, or during the first sleep. The monotonic clock never jumps. */
  wallJumpAfterCall?: (call: number) => number; wallJumpInFirstSleep?: number; monotonic?: false };
function harness(options: HarnessOptions = {}) {
  const files = new Map<string, Uint8Array | string>();
  const listing = options.listing ?? Array.from({ length: 6 }, (_, index) => entry(index));
  files.set('samples.json', JSON.stringify(listing));
  for (let index = 0; index < 6; index++) {
    files.set(`s${index}.jpg`, sampleBytes(index));
    files.set(`s${index}.bin`, options.reference?.(index) ?? referenceBytes(index));
    files.set(`s${index}.json`, JSON.stringify(options.binding?.(index) ?? bindingFor(index)));
  }
  let clock = T0, mono = MONO0, slept = 0;
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
    now: () => clock,
    ...(options.monotonic === false ? {} : { monotonic: () => mono }),
    sleep: async (ms: number) => { clock += ms + (slept++ === 0 ? options.wallJumpInFirstSleep ?? 0 : 0); mono += ms; },
    newId: () => `22222222-2222-4222-8222-${String(fetches.length).padStart(12, '0')}`,
    readHeader: () => ({ width: 800, height: 1000 }),
    accepts: () => true,
    admit: (bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: false }),
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (url.endsWith('/rpc/enhance_status')) return options.status?.() ?? new Response(statusBody(), { headers: { 'content-type': 'application/json' } });
      calls++;
      dispatches.push(mono);
      const latency = options.latencyMs?.(calls) ?? 1_000;
      clock += latency + (options.wallJumpAfterCall?.(calls) ?? 0);
      mono += latency;
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
      [{}, { monotonic: false }, 'clock'],
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
      expect(headers['X-Stillroom-AI-Budget-Contract']).toBe('2');
      expect(Object.keys(headers).some(name => name.toLowerCase() === 'origin')).toBe(false);
      expect(entry.init.redirect).toBe('error');
      expect(entry.url).toBe(`${HOSTED_URL}/functions/v1/enhance-photo`);
    }
    const statusCalls = h.fetches.filter(entry => entry.url.endsWith('/rpc/enhance_status'));
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const entry of statusCalls) expect((entry.init.headers as Record<string, string>)['X-Stillroom-AI-Budget-Contract']).toBe('2');
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
      statusBody({ budget: budget('19800000') }),
      statusBody({ budget: null }),
      // The retired usage/allowance shape is never accepted as a fallback.
      statusBody({ usage: { enhanceMicro: '0', totalMicro: '0', enhanceLastHour: 0 }, budget: undefined }),
      statusBody({ budget: { ...budget(), extra: 1 } })]) {
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
    expect(s1).toBe(MONO0);
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
    expect(recent.dispatches[0]).toBe(MONO0 - 10_000 + 66_000);
    const used = harness();
    await runProbe(env({ PROBE_LAST_KEY_USE_AT: new Date(T0 - 5_000).toISOString() }), used.deps);
    expect(used.dispatches[0]).toBe(MONO0 - 5_000 + 66_000);
    expect(earliestStart({ notBefore: 5 }, [], [])).toBe(5);
  });

  it('stops on a refusal with no retry and leaves the rest pending', async () => {
    const h = harness({ reply: (call) => call === 3 ? new Response(JSON.stringify({ code: 'ALLOWANCE' }), { status: 429,
      headers: { 'content-type': 'application/json' } }) : new Response(outputBytes, { headers: { 'content-type': 'image/jpeg',
      'content-length': String(outputBytes.byteLength), 'x-stillroom-enhancement-sha256': hash(outputBytes) } }) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(h.providerCalls()).toBe(3);
    expect(calls.map((entry: { code: string }) => entry.code)).toEqual(['OK', 'OK', 'ALLOWANCE']);
    expect(lines).toContain('Stopped after call 3: ALLOWANCE.');
    expect(lines.at(-1)).toContain('"state":"pending"');
  });

  it('keeps spacing on the monotonic clock when the wall clock jumps forward or back', async () => {
    // A 60 s forward jump after call 1 once shrank the real spacing to 1 s; a backward jump would stretch it.
    for (const jump of [60_000, -60_000, 3_600_000, -3_600_000]) {
      const h = harness({ wallJumpAfterCall: (call) => call === 1 ? jump : 0 });
      await runProbe(env(), h.deps);
      expect(h.dispatches).toHaveLength(6);
      expect(h.dispatches[1]! - h.dispatches[0]!).toBe(33_000);
      for (let k = 1; k < h.dispatches.length; k++) expect(h.dispatches[k]! - h.dispatches[k - 1]!).toBeGreaterThanOrEqual(33_000);
      for (let k = 2; k < h.dispatches.length; k++) expect(h.dispatches[k]!).toBeGreaterThanOrEqual(h.dispatches[k - 2]! + 1_000 + 66_000);
    }
  });

  it('converts the switch-on wait once, so a wall jump during it neither shortens nor stretches it', async () => {
    for (const jump of [60_000, -60_000]) {
      const h = harness({ wallJumpInFirstSleep: jump });
      await runProbe(env({ PROBE_SWITCH_ON_AT: new Date(T0 - 10_000).toISOString() }), h.deps);
      expect(h.dispatches[0]).toBe(MONO0 - 10_000 + 66_000);
      expect(h.dispatches[1]! - h.dispatches[0]!).toBe(33_000);
    }
  });

  describe('evidence for the paired review', () => {
    const binding = { commit: COMMIT, modelSha256: MODEL, referenceSha256: 'd'.repeat(64) };
    const input = (index: number) => hash(sampleBytes(index));
    const output = (index: number) => hash(new Uint8Array([index, 7]));
    const visual = Array.from({ length: 5 }, (_, index) => ({ call: index + 1, role: 'visual', code: 'OK', requestId: `r${index}`,
      inputSha256: input(index), outputSha256: output(index), binding }));
    const disconnect = { call: 6, role: 'disconnect', code: 'DISCONNECTED', requestId: 'r5', inputSha256: input(5), binding };
    const calls = [...visual, disconnect];
    const full = { ringDeltaE: 1, ringP95: 2, workingBytes: 3_360_000, largestShare: 0.99, containment: 0.97, retention: 0.95,
      centroid: { x: 0.01, y: -0.02 }, support: 0.8, meanDeltaE: 3, p95DeltaE: 8, ssim: 0.9, windows: 120 };
    const measuredFor = (index: number, over: Record<string, unknown> = {}) => ({ call: index + 1, reason: 'accepted', metrics: full,
      h0Sha256: input(index), h2Sha256: output(index), referenceSha256: binding.referenceSha256, commit: COMMIT, modelSha256: MODEL, ...over });
    const metrics = Object.fromEntries(visual.map((entry, index) => [entry.requestId, measuredFor(index)]));
    const settled = { requestId: 'r5', dispatched: true, chargeState: 'estimated', settlementOrigin: 'observed', anomaly: false,
      accountedMicro: '180000', settlementDigest: 'e'.repeat(64) };
    const withMetric = (over: Record<string, unknown>) => ({ ...metrics, r2: measuredFor(2, over) });

    it('is ready only with bound numeric metrics, a real disconnect and its observed settlement', () => {
      expect(evidenceState(calls, metrics, settled)).toEqual({ state: 'ready-for-paired-review', missing: [] });
      expect(evidenceState(calls, {}, settled).missing).toEqual(['metrics-1', 'metrics-2', 'metrics-3', 'metrics-4', 'metrics-5']);
      expect(evidenceState(calls.slice(0, 4), metrics, settled).missing).toContain('calls');
      expect(evidenceState([{ ...calls[0]!, code: 'FAILED' }, ...calls.slice(1)], metrics, settled).missing).toContain('call-1');
    });

    it('refuses a bare reason or metrics that do not match the verdict', () => {
      expect(evidenceState(calls, withMetric({ metrics: {} }), settled).missing).toEqual(['metrics-3']);
      expect(evidenceState(calls, withMetric({ reason: 'accepted', metrics: undefined }), settled).missing).toEqual(['metrics-3']);
      const noSsim: Record<string, unknown> = { ...full };
      delete noSsim.ssim;
      expect(evidenceState(calls, withMetric({ metrics: noSsim }), settled).missing).toEqual(['metrics-3']);
      expect(evidenceState(calls, withMetric({ metrics: { ...full, centroid: { x: 0 } } }), settled).missing).toEqual(['metrics-3']);
      expect(evidenceState(calls, withMetric({ metrics: { ...full, ssim: Number.NaN } }), settled).missing).toEqual(['metrics-3']);
      expect(evidenceState(calls, withMetric({ metrics: { ...full, ssim: '0.9' } }), settled).missing).toEqual(['metrics-3']);
      // Verdicts with no usable metrics never count, and an unknown reason is refused.
      for (const reason of ['size', 'nonFinite', 'somethingElse']) {
        expect(evidenceState(calls, withMetric({ reason }), settled).missing).toEqual(['metrics-3']);
      }
      // A rejection needs only the metrics its verdict reports.
      expect(evidenceState(calls, withMetric({ reason: 'background', metrics: { ringDeltaE: 9, ringP95: 20, workingBytes: 1 } }), settled).state)
        .toBe('ready-for-paired-review');
      expect(REASON_METRICS.accepted).toContain('ssim');
    });

    it('refuses metrics bound to another request, input, output, reference or build', () => {
      for (const over of [{ call: 4 }, { h0Sha256: 'f'.repeat(64) }, { h2Sha256: 'f'.repeat(64) }, { referenceSha256: 'f'.repeat(64) },
        { commit: 'f'.repeat(40) }, { modelSha256: 'f'.repeat(64) }]) {
        expect(evidenceState(calls, withMetric(over), settled).missing).toEqual(['metrics-3']);
      }
      // Right numbers filed under a different request ID.
      expect(evidenceState(calls, { ...metrics, r2: metrics.r3 }, settled).missing).toEqual(['metrics-3']);
    });

    describe('versioned metrics files (BG2c-3 §6.3)', () => {
      const CONFIG = 'c'.repeat(64), BUILD = { commit: 'b'.repeat(40), configSha256: CONFIG };
      const v2Metrics = { checkVersion: 2, ringDeltaE: 1, ringP95: 2, workingBytes: 5_839_972, largestShare: 1, containment: 0.9,
        unalignedRetention: 0.9, centroid: { x: 0.5, y: 0.5 }, scale: 1, tx: 0, ty: 0, added: 0.01, retention: 0.9, support: 20_000,
        fitted: 20_000, deltaL: 1, chroma: 1, hue: 0, modeDistance: 1, removed: 0, changeShare: 0.01, patternLoss: 0 };
      const v2Entry = (index: number, over: Record<string, unknown> = {}) => ({ call: index + 1, reason: 'accepted', metrics: v2Metrics,
        h0Sha256: input(index), h2Sha256: output(index), referenceSha256: binding.referenceSha256, priorReason: 'containment', ...over });
      const v2File = (over: Record<string, unknown> = {}) => ({ schema: 2, preparedCommit: COMMIT, measuredCommit: BUILD.commit, checkVersion: 2,
        configSha256: CONFIG, modelSha256: MODEL, metrics: Object.fromEntries(visual.map((entry, index) => [entry.requestId, v2Entry(index)])),
        blocked: [], ...over });
      const legacy = (over: Record<string, unknown> = {}) => ({ commit: COMMIT, metrics, pending: [], blocked: [], ...over });
      const refused = { state: 'pending', missing: ['metrics-contract'] };

      it('accepts legacy v1 only under its original rule and reason names', () => {
        expect(metricsEvidence(calls, legacy(), settled, BUILD)).toEqual({ state: 'ready-for-paired-review', missing: [] });
        expect(metricsEvidence(calls, legacy({ commit: 'f'.repeat(40) }), settled, BUILD)).toEqual(refused);
        expect(metricsEvidence(calls, { ...legacy(), extra: 1 }, settled, BUILD)).toEqual(refused);
        expect(metricsEvidence(calls, legacy({ metrics: withMetric({ commit: 'f'.repeat(40) }) }), settled, BUILD).missing).toEqual(['metrics-3']);
        // A v2 reason name in a v1 file is not a v1 verdict.
        expect(metricsEvidence(calls, legacy({ metrics: withMetric({ reason: 'colourMode' }) }), settled, BUILD).missing).toEqual(['metrics-3']);
      });

      it('accepts schema 2 only at the evaluated revision, check version and config', () => {
        expect(metricsEvidence(calls, v2File(), settled, BUILD)).toEqual({ state: 'ready-for-paired-review', missing: [] });
        for (const over of [{ measuredCommit: COMMIT }, { measuredCommit: 'f'.repeat(40) }, { configSha256: 'f'.repeat(64) }, { checkVersion: 1 },
          { preparedCommit: 'f'.repeat(40) }, { modelSha256: 'f'.repeat(64) }, { blocked: ['https://example.test'] }, { schema: 3 }, { extra: 1 }]) {
          expect(metricsEvidence(calls, v2File(over), settled, BUILD), JSON.stringify(over)).toEqual(refused);
        }
        expect(metricsEvidence(calls, v2File(), settled, { ...BUILD, configSha256: 'f'.repeat(64) })).toEqual(refused);
        expect(metricsEvidence(calls, v2File(), settled, { ...BUILD, commit: 'f'.repeat(40) })).toEqual(refused);
        // The contract refusal keeps the other gaps visible.
        expect(metricsEvidence(calls, v2File({ checkVersion: 1 }), null, BUILD).missing).toEqual(['metrics-contract', 'disconnect-settlement']);
      });

      it('binds each schema-2 entry to its call, hashes and v2 reason metrics', () => {
        const withV2 = (over: Record<string, unknown>) => v2File({ metrics: { ...v2File().metrics as Record<string, unknown>, r2: v2Entry(2, over) } });
        for (const over of [{ call: 4 }, { h0Sha256: 'f'.repeat(64) }, { h2Sha256: 'f'.repeat(64) }, { referenceSha256: 'f'.repeat(64) },
          { reason: 'colour' }, { reason: 'nonFinite' }, { priorReason: 'colourMode' }, { priorReason: undefined }, { commit: COMMIT },
          { metrics: { ...v2Metrics, checkVersion: 1 } }, { metrics: { ...v2Metrics, patternLoss: Number.NaN } }]) {
          expect(metricsEvidence(calls, withV2(over), settled, BUILD).missing, JSON.stringify(over)).toEqual(['metrics-3']);
        }
        // An early rejection needs only the metrics its stage reports.
        expect(metricsEvidence(calls, withV2({ reason: 'background', metrics: { checkVersion: 2, ringDeltaE: 9, ringP95: 20, workingBytes: 1 } }), settled, BUILD).state)
          .toBe('ready-for-paired-review');
        expect(metricsEvidence(calls, withV2({ reason: 'added', metrics: { checkVersion: 2, ringDeltaE: 9, ringP95: 20, workingBytes: 1 } }), settled, BUILD).missing)
          .toEqual(['metrics-3']);
        expect(V2_REASON_METRICS.accepted).toContain('patternLoss');
        expect(Object.keys(V2_REASON_METRICS)).not.toContain('colour');
      });
    });

    it('keeps F4 pending when the reply came before the disconnect', () => {
      const early = [...visual, { ...disconnect, code: 'RESPONDED_BEFORE_DISCONNECT' }];
      expect(evidenceState(early, metrics, settled)).toEqual({ state: 'pending', missing: ['disconnect-outcome'] });
      for (const code of ['CLIENT_TIMEOUT', 'TRANSPORT', 'OK']) {
        expect(evidenceState([...visual, { ...disconnect, code }], metrics, settled).missing).toEqual(['disconnect-outcome']);
      }
    });

    it('needs the disconnect request\'s own observed-usage settlement, not expiry or a bare terminal row', () => {
      expect(evidenceState(calls, metrics, null).missing).toEqual(['disconnect-settlement']);
      expect(evidenceState(calls, metrics, { requestId: 'r5', terminal: true, accounted: true, slotEnded: true }).missing)
        .toEqual(['disconnect-settlement']);
      for (const over of [{ requestId: 'r4' }, { settlementOrigin: 'provisional_expiry' }, { settlementOrigin: 'unmetered' },
        { settlementOrigin: 'terminal_anomaly' }, { settlementOrigin: 'non_dispatch' }, { chargeState: 'held' }, { dispatched: false },
        { anomaly: true }, { accountedMicro: 180000 }, { accountedMicro: '-1' }, { settlementDigest: undefined }, { settlementDigest: 'x' }]) {
        expect(evidenceState(calls, metrics, { ...settled, ...over }).missing).toEqual(['disconnect-settlement']);
      }
    });
  });

  it('prepares nothing from a samples folder that is not exactly 5 visual and 1 disconnect', async () => {
    const h = harness({ listing: Array.from({ length: 6 }, (_, index) => entry(index, index === 0 ? 'disconnect' : 'visual')) });
    await expect(prepareProbe(env(), h.deps)).rejects.toBeInstanceOf(ProbeRefusal);
  });
});
