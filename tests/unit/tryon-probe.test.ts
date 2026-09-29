import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DISCONNECT_AFTER_MS, DISPATCH_SPACING_MS, PROBE_CALLS, ProbeRefusal, runProbe } from '../../scripts/tryon-probe.mjs';
import { HOSTED_URL } from '../../scripts/hosted-smoke.mjs';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const JWT = ['aaaa', 'bbbb', 'cccc'].join('.');
const TOKEN = 'probe-token-'.padEnd(48, 'x');
const KEY = 'sb_publishable_syntheticKey123';
const OUTFITS = { P1: '33333333-3333-4333-8333-000000000001', P3: '33333333-3333-4333-8333-000000000003', P2: '33333333-3333-4333-8333-000000000002' };
const person = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const stepImage = (n: number) => new Uint8Array(2048).fill(n);
const finalImage = new Uint8Array(4096).fill(7);
const RESULT = '44444444-4444-4444-8444-444444444444';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const env = (over: Record<string, string | undefined> = {}) => ({
  ALLOW_TRYON_PROBE: '1', PROBE_PROJECT_URL: HOSTED_URL, PROBE_AUTHORISATION_ID: '11111111-1111-4111-8111-111111111111',
  PROBE_ACCESS_TOKEN: JWT, TRYON_PROBE_TOKEN: TOKEN, PROBE_PUBLISHABLE_KEY: KEY, PROBE_PERSON: '/in/person.jpg', PROBE_OUTPUT: '/out',
  PROBE_OUTFIT_P1: OUTFITS.P1, PROBE_OUTFIT_P3: OUTFITS.P3, PROBE_OUTFIT_P2: OUTFITS.P2, ...over,
});
const statusBody = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({ code: 'INACTIVE',
  policy: { activated: false, manifestId: 'azure-global-image25-sunburst-tryon-v1', modelId: 'gpt-image-2.5-sunburst', providerAvailable: true,
    maxRequestMicro: '360000', tryOnAllowanceMicro: '5000000', totalAllowanceMicro: '20000000', ...over },
  usage: { tryOnMicro: '0', totalMicro: '0', tryOnLastHour: 0, ...usage } });

type Step = { chainId: string; requestId: string; step: number; outfitId: string | null; personSha: string; headers: Headers; signal: AbortSignal };
type Options = {
  step?: (call: Step, index: number) => Response | Promise<Response>;
  status?: (index: number) => Response;
  admit?: (bytes: Uint8Array) => unknown;
  personInput?: (bytes: Uint8Array) => boolean;
  output?: string[];
  readFail?: boolean;
  writeFail?: boolean;
  chainStatus?: (index: number) => Response;
  resultImage?: () => Response;
  cancel?: () => Response;
  sleep?: (ms: number) => void;
};

function harness(options: Options = {}) {
  const fetches: string[] = [];
  const steps: Step[] = [];
  const written: { path: string; bytes: Uint8Array; flag?: string }[] = [];
  const sleeps: number[] = [];
  const timers: number[] = [];
  const starts: number[] = [];
  let clock = 0, ids = 0, statuses = 0, chainStatuses = 0;
  const deps = {
    readFile: async () => { if (options.readFail) throw new Error('missing'); return person; },
    readdir: async () => options.output ?? [],
    writeFile: async (path: string, bytes: Uint8Array, opts?: { flag?: string }) => {
      if (options.writeFail) throw new Error('disk full');
      written.push({ path, bytes, flag: opts?.flag });
    },
    now: () => clock,
    sleep: async (ms: number) => { options.sleep?.(ms); sleeps.push(ms); clock += ms; },
    newId: () => `22222222-2222-4222-8222-${String(++ids).padStart(12, '0')}`,
    admit: options.admit ?? ((bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: false })),
    personInput: options.personInput ?? (() => true),
    setTimeout: (fn: () => void, ms: number) => { timers.push(ms); if (ms === DISCONNECT_AFTER_MS) queueMicrotask(fn); return 0; },
    clearTimeout: () => undefined,
    fetch: async (url: string, init: RequestInit) => {
      fetches.push(url.replace(HOSTED_URL, ''));
      if (url.endsWith('/rpc/tryon_status')) return options.status?.(statuses++) ?? json(statusBody());
      if (url.endsWith('/rpc/tryon_cancel')) return options.cancel?.() ?? json({ code: 'CANCELLED' });
      if (url.endsWith('/rpc/tryon_chain_status')) {
        return options.chainStatus?.(chainStatuses++) ?? json({ code: 'OK', state: 'complete', activeAttempt: false, resultId: RESULT });
      }
      if (url.endsWith('/rpc/tryon_result_image_v1')) {
        return options.resultImage?.() ?? json({ code: 'OK', jpegBase64: Buffer.from(finalImage).toString('base64'), bytes: finalImage.byteLength });
      }
      if (url.endsWith('/rpc/tryon_delete_result')) return json({ code: 'DELETED' });
      if (!url.endsWith('/functions/v1/try-on')) throw new Error(`unexpected ${url}`);
      starts.push(clock);
      const form = init.body as FormData;
      const file = form.get('person') as File;
      const call: Step = { chainId: String(form.get('chainId')), requestId: String(form.get('requestId')), step: Number(form.get('step')), outfitId: form.get('outfitId') as string | null,
        personSha: hash(new Uint8Array(await file.arrayBuffer())), headers: new Headers(init.headers), signal: init.signal! };
      steps.push(call);
      if (options.step) return options.step(call, steps.length);
      return defaultStep(call);
    },
  };
  return { deps, fetches, steps, written, sleeps, timers, starts };
}
function defaultStep(call: Step): Response | Promise<Response> {
  if (call.outfitId === OUTFITS.P3) {
    return new Promise((_, reject) => {
      const fail = () => reject(new DOMException('aborted', 'AbortError'));
      if (call.signal.aborted) fail(); else call.signal.addEventListener('abort', fail);
    });
  }
  if (call.outfitId === OUTFITS.P2) return json({ code: 'FILTERED' }, 422);
  if (call.step < 3) {
    const bytes = stepImage(call.step);
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'x-stillroom-tryon-sha256': hash(bytes) } });
  }
  return json({ code: 'OK', resultId: RESULT, expiresAtMs: 1 });
}
const report = (lines: string[]) => lines.join('\n');
const expectStartsSpaced = (starts: number[]) => {
  for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(DISPATCH_SPACING_MS);
};

describe('try-on probe script', () => {
  it('refuses every bad input with zero network calls', async () => {
    const cases: [Record<string, string | undefined>, Options, string][] = [
      [{ ALLOW_TRYON_PROBE: undefined }, {}, 'notAllowed'],
      [{ ALLOW_TRYON_PROBE: 'true' }, {}, 'notAllowed'],
      [{ PROBE_PROJECT_URL: 'https://example.supabase.co' }, {}, 'project'],
      [{ PROBE_AUTHORISATION_ID: 'nope' }, {}, 'authorisation'],
      [{ PROBE_ACCESS_TOKEN: undefined }, {}, 'accessToken'],
      [{ TRYON_PROBE_TOKEN: 'short' }, {}, 'probeToken'],
      [{ PROBE_PUBLISHABLE_KEY: 'service_role' }, {}, 'publishableKey'],
      [{ PROBE_OUTFIT_P2: OUTFITS.P1 }, {}, 'outfits'],
      [{ PROBE_OUTFIT_P3: undefined }, {}, 'outfits'],
      [{ PROBE_PERSON: undefined }, {}, 'folders'],
      [{}, { readFail: true }, 'person'],
      [{}, { personInput: () => false }, 'person'],
      [{}, { personInput: () => { throw new Error('bad jpeg'); } }, 'person'],
      [{}, { output: ['old.jpg'] }, 'output'],
    ];
    for (const [over, options, code] of cases) {
      const h = harness(options);
      await expect(runProbe(env(over), h.deps)).rejects.toEqual(new ProbeRefusal(code));
      expect(h.fetches).toHaveLength(0);
    }
  });

  it('runs P1 steps 1-3, the P3 disconnect and the P2 filter challenge, in that order and no more', async () => {
    const h = harness();
    const { lines, calls } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'DISCONNECTED', 'FILTERED']);
    expect(calls.length).toBeLessThanOrEqual(PROBE_CALLS);
    expect(h.steps.map((s) => [s.outfitId, s.step])).toEqual([[OUTFITS.P1, 1], [null, 2], [null, 3], [OUTFITS.P3, 1], [OUTFITS.P2, 1]]);
    // Step 2 and 3 carry the previous intermediate as the person; the P3 and P2 calls use the owner's photo again.
    expect(h.steps.map((s) => s.personSha)).toEqual([hash(person), hash(stepImage(1)), hash(stepImage(2)), hash(person), hash(person)]);
    expect(new Set(h.steps.slice(0, 3).map((s) => s.chainId)).size).toBe(1);
    for (const s of h.steps) {
      expect(s.headers.get('X-Stillroom-Probe-Authorisation')).toBe('11111111-1111-4111-8111-111111111111');
      expect(s.headers.get('X-Stillroom-Probe-Token')).toBe(TOKEN);
      expect(s.headers.has('Origin')).toBe(false);
    }
    // Only the P3 call is cut at 20 s; dispatch starts are at least 65 s apart.
    expect(h.timers.filter((ms) => ms === DISCONNECT_AFTER_MS)).toHaveLength(1);
    for (let index = 1; index < h.starts.length; index++) expect(h.starts[index]! - h.starts[index - 1]!).toBeGreaterThanOrEqual(DISPATCH_SPACING_MS);
    // A status preflight before every paid call; every chain is stopped afterwards.
    const order = h.fetches.filter((url) => url.endsWith('tryon_status') || url.endsWith('/try-on'));
    for (let index = 0; index < order.length; index += 2) expect(order.slice(index, index + 2)).toEqual(['/rest/v1/rpc/tryon_status', '/functions/v1/try-on']);
    expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(3);
    expect(h.fetches).toContain('/rest/v1/rpc/tryon_chain_status');
    // Only the final P1 picture is written, never an intermediate.
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.path.replace(/\\/g, '/')).toMatch(/\/out\/p1-final\.jpg$/);
    expect(h.written[0]!.flag).toBe('wx');
    expect(hash(h.written[0]!.bytes)).toBe(hash(finalImage));
    const report = lines.join('\n');
    expect(report).not.toContain(JWT);
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain(KEY);
    expect(report).not.toMatch(/base64|jpegBase64|[A-Za-z0-9+/]{200,}/);
    // Hashes and result IDs stay in the transient checks, never the report.
    for (const known of [hash(person), hash(stepImage(1)), hash(stepImage(2)), hash(finalImage), RESULT]) expect(report).not.toContain(known);
    expect(report).not.toMatch(/[0-9a-f]{64}/);
    expect(report).toContain('P2 filter challenge: FILTERED.');
    expect(report).toContain('Paid calls sent: 5 of at most 5.');
    expect(report).toContain('Outcome: COMPLETE.');
    for (const s of h.steps) expect(report).toContain(s.requestId);
  });

  it('stops without a replacement call after a failed P1 step', async () => {
    const h = harness({ step: (call) => call.step === 2 ? json({ code: 'FAILED' }, 502) : defaultStep(call) });
    const { lines, calls } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'FAILED']);
    expect(h.steps).toHaveLength(2);
    expect(h.written).toHaveLength(0);
    expect(lines.join('\n')).toContain('Stopped after P1 step 2: FAILED.');
  });

  it('stops when the provider evidence does not match', async () => {
    const h = harness({ step: (call) => call.step === 1
      ? new Response(stepImage(1), { headers: { 'content-type': 'image/jpeg', 'x-stillroom-tryon-sha256': 'f'.repeat(64) } }) : defaultStep(call) });
    const { calls } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['EVIDENCE_MISMATCH']);
    expect(h.steps).toHaveLength(1);
  });

  it('stops before a paid call if try-on is active, the provider is off or the allowance is short', async () => {
    for (const [status, code] of [
      [json({ ...statusBody({ activated: true }), code: 'OK' }), 'activated'],
      [json(statusBody({ providerAvailable: false })), 'policy'],
      [json(statusBody({}, { tryOnMicro: '4800000' })), 'allowance'],
      [json({ code: 'OK' }), 'statusUnreadable'],
    ] as const) {
      const h = harness({ status: () => status.clone() });
      const { lines, calls } = await runProbe(env(), h.deps);
      expect(calls).toHaveLength(0);
      expect(h.steps).toHaveLength(0);
      expect(lines.join('\n')).toContain(`Stopped before P1 step 1: ${code}.`);
    }
  });

  it('stops before call 5 when the probe allowance is used up after the disconnect', async () => {
    const h = harness({ status: (index) => json(index >= 4 ? statusBody({}, { tryOnMicro: '4700000' }) : statusBody()) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'DISCONNECTED']);
    expect(lines.join('\n')).toContain('Stopped before P2 step 1: allowance.');
  });

  it('retries only a pre-claim RATE_LIMIT or BUSY, 65 s after the last actual start, with a fresh preflight each time', async () => {
    let refusals = 0;
    const h = harness({ step: (call) => call.step === 1 && call.outfitId === OUTFITS.P1 && refusals++ < 2 ? json({ code: 'RATE_LIMIT' }, 429) : defaultStep(call) });
    const { calls, lines, complete } = await runProbe(env(), h.deps);
    expect(complete).toBe(true);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'DISCONNECTED', 'FILTERED']);
    expect(h.steps.filter((s) => s.outfitId === OUTFITS.P1)).toHaveLength(3);
    // Refusal -> refusal -> success -> the next steps: every attempt is spaced from the one before it.
    expectStartsSpaced(h.starts);
    const order = h.fetches.filter((url) => url.endsWith('tryon_status') || url.endsWith('/try-on'));
    for (let index = 0; index < order.length; index += 2) expect(order.slice(index, index + 2)).toEqual(['/rest/v1/rpc/tryon_status', '/functions/v1/try-on']);
    expect(report(lines)).toContain('(refused before a claim)');
    expect(report(lines)).toContain('Paid calls sent: 5 of at most 5.');

    const stuck = harness({ step: () => json({ code: 'BUSY' }, 503) });
    const result = await runProbe(env(), stuck.deps);
    expect(result.calls).toHaveLength(0);
    expect(result.complete).toBe(false);
    expect(stuck.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
    expectStartsSpaced(stuck.starts);
    expect(report(result.lines)).toContain('Stopped after P1 step 1: BUSY.');
    for (const s of stuck.steps) expect(report(result.lines)).toContain(s.requestId);
  });

  it('never retries a code that may follow a claim, keeps its request ID and stops the chain', async () => {
    for (const code of ['FAILED', 'UNAVAILABLE', 'CONFLICT', 'NOT_FOUND', 'TIMEOUT', 'INVALID_INPUT', 'CONFIG_CHANGED', 'WITHDRAWN', 'UNCONFIGURED',
      'INACTIVE', 'CONSENT_REQUIRED', 'CHAIN_MISMATCH', 'TOO_LARGE']) {
      const h = harness({ step: () => json({ code }, 503) });
      const { calls, lines, complete } = await runProbe(env(), h.deps);
      expect(h.steps).toHaveLength(1);
      expect(calls.map((c) => c.code)).toEqual([code]);
      expect(complete).toBe(false);
      expect(report(lines)).toContain(h.steps[0]!.requestId);
      expect(report(lines)).toContain('Paid calls sent: 1 of at most 5.');
      expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(1);
    }
  });

  it('counts a call whose probe authorisation was stopped or expired while the provider ran', async () => {
    // tryon_finish records the observed usage, then its probe-permission check answers INACTIVE; the handler passes it on.
    const h = harness({ step: (call) => call.step === 2 ? json({ code: 'INACTIVE' }, 503) : defaultStep(call) });
    const { calls, lines, complete } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'INACTIVE']);
    expect(h.steps).toHaveLength(2);
    expect(complete).toBe(false);
    const text = report(lines);
    expect(text).toContain('Stopped after P1 step 2: INACTIVE.');
    expect(text).not.toContain('refused before a claim');
    expect(text).toContain('Paid calls sent: 2 of at most 5.');
    expect(text).toContain('Outcome: INCOMPLETE.');
    expect(text).toContain(h.steps[1]!.requestId);
    expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(1);
  });

  it('stops with call 4 incomplete unless the P3 chain completes on its own', async () => {
    const cases: [(index: number) => Response, string][] = [
      [() => json({ code: 'OK', state: 'running', activeAttempt: false, resultId: null }), 'P3_NO_ACTIVE_ATTEMPT'],
      [() => json({ code: 'OK', state: 'expired', activeAttempt: false, resultId: null }), 'P3_EXPIRED'],
      [() => json({ code: 'OK', state: 'complete', activeAttempt: false, resultId: null }), 'P3_COMPLETE'],
      [() => new Response('x', { status: 500 }), 'STATUS_UNREADABLE'],
      [() => json({ code: 'OK', state: 'running', activeAttempt: true, resultId: null }), 'SETTLE_TIMEOUT'],
    ];
    for (const [chainStatus, code] of cases) {
      const h = harness({ chainStatus });
      const { calls, lines, complete } = await runProbe(env(), h.deps);
      expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'DISCONNECTED']);
      expect(h.steps.some((s) => s.outfitId === OUTFITS.P2)).toBe(false);
      expect(complete).toBe(false);
      expect(report(lines)).toContain(`Stopped after P3: ${code}; call 4 acceptance is incomplete.`);
      expect(report(lines)).toContain('Outcome: INCOMPLETE.');
      expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(2);
    }
  });

  it('reports every request ID and stops the chain when the final picture cannot be read or written', async () => {
    for (const [options, code] of [
      [{ resultImage: () => { throw new TypeError('fetch failed'); } }, 'RESULT_UNREADABLE'],
      [{ resultImage: () => new Response('x', { status: 500 }) }, 'RESULT_UNREADABLE'],
      [{ writeFail: true, cancel: () => json({ code: 'COMPLETED', resultId: RESULT }) }, 'WRITE_FAILED'],
    ] as const) {
      const h = harness(options);
      const { calls, lines, complete } = await runProbe(env(), h.deps);
      expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK']);
      expect(complete).toBe(false);
      expect(h.written).toHaveLength(0);
      const text = report(lines);
      expect(text).toContain(`Stopped after P1 step 3: ${code}.`);
      for (const s of h.steps) expect(text).toContain(s.requestId);
      expect(text).toContain('Paid calls sent: 3 of at most 5.');
      expect(text).toContain('Outcome: INCOMPLETE.');
      expect(text).not.toContain(RESULT);
      expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(1);
      expect(h.fetches.filter((url) => url.endsWith('tryon_delete_result'))).toHaveLength(code === 'WRITE_FAILED' ? 1 : 0);
    }
  });

  it('turns an unexpected failure after a paid call into an incomplete report, and still stops the chain', async () => {
    const h = harness({ sleep: () => { throw new Error('clock'); } });
    const { calls, lines, complete } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK']);
    expect(complete).toBe(false);
    const text = report(lines);
    expect(text).toContain('Stopped: unexpected failure during P1 step 2; treat every request below as possibly paid.');
    expect(text).toContain(h.steps[0]!.requestId);
    expect(text).toContain('Outcome: INCOMPLETE.');
    expect(h.fetches.filter((url) => url.endsWith('tryon_cancel'))).toHaveLength(1);
  });

  it('never sends P2 when the P3 call is not a disconnect', async () => {
    const h = harness({ step: (call) => call.outfitId === OUTFITS.P3 ? json({ code: 'FAILED' }, 502) : defaultStep(call) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'FAILED']);
    expect(h.steps.some((s) => s.outfitId === OUTFITS.P2)).toBe(false);
    expect(lines.join('\n')).toContain('Stopped after P3: FAILED.');
  });
});
