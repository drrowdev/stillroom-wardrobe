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

type Step = { chainId: string; step: number; outfitId: string | null; personSha: string; headers: Headers; signal: AbortSignal };
type Options = {
  step?: (call: Step, index: number) => Response | Promise<Response>;
  status?: (index: number) => Response;
  admit?: (bytes: Uint8Array) => unknown;
  output?: string[];
  readFail?: boolean;
};

function harness(options: Options = {}) {
  const fetches: string[] = [];
  const steps: Step[] = [];
  const written: { path: string; bytes: Uint8Array; flag?: string }[] = [];
  const sleeps: number[] = [];
  const timers: number[] = [];
  const starts: number[] = [];
  let clock = 0, ids = 0, statuses = 0;
  const deps = {
    readFile: async () => { if (options.readFail) throw new Error('missing'); return person; },
    readdir: async () => options.output ?? [],
    writeFile: async (path: string, bytes: Uint8Array, opts?: { flag?: string }) => { written.push({ path, bytes, flag: opts?.flag }); },
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
    newId: () => `22222222-2222-4222-8222-${String(++ids).padStart(12, '0')}`,
    admit: options.admit ?? ((bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: false })),
    setTimeout: (fn: () => void, ms: number) => { timers.push(ms); if (ms === DISCONNECT_AFTER_MS) queueMicrotask(fn); return 0; },
    clearTimeout: () => undefined,
    fetch: async (url: string, init: RequestInit) => {
      fetches.push(url.replace(HOSTED_URL, ''));
      if (url.endsWith('/rpc/tryon_status')) return options.status?.(statuses++) ?? json(statusBody());
      if (url.endsWith('/rpc/tryon_cancel')) return json({ code: 'CANCELLED' });
      if (url.endsWith('/rpc/tryon_chain_status')) return json({ code: 'OK', state: 'running', activeAttempt: false });
      if (url.endsWith('/rpc/tryon_result_image_v1')) return json({ code: 'OK', jpegBase64: Buffer.from(finalImage).toString('base64'), bytes: finalImage.byteLength });
      if (url.endsWith('/rpc/tryon_delete_result')) return json({ code: 'DELETED' });
      if (!url.endsWith('/functions/v1/try-on')) throw new Error(`unexpected ${url}`);
      starts.push(clock);
      const form = init.body as FormData;
      const file = form.get('person') as File;
      const call: Step = { chainId: String(form.get('chainId')), step: Number(form.get('step')), outfitId: form.get('outfitId') as string | null,
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
  return json({ code: 'OK', resultId: '44444444-4444-4444-8444-444444444444', expiresAtMs: 1 });
}

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
      [{}, { admit: (bytes: Uint8Array) => ({ bytes, width: 1024, height: 1280, stripped: true }) }, 'person'],
      [{}, { admit: (bytes: Uint8Array) => ({ bytes, width: 1024, height: 1024, stripped: false }) }, 'person'],
      [{}, { admit: () => { throw new Error('bad jpeg'); } }, 'person'],
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
    expect(report).toContain('P2 filter challenge: FILTERED.');
    expect(report).toContain('Paid calls sent: 5 of at most 5.');
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

  it('re-polls an unpaid RATE_LIMIT claim for up to 3 minutes, then stops', async () => {
    let refusals = 0;
    const h = harness({ step: (call) => call.step === 1 && call.outfitId === OUTFITS.P1 && refusals++ < 2 ? json({ code: 'RATE_LIMIT' }, 429) : defaultStep(call) });
    const { calls } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'DISCONNECTED', 'FILTERED']);
    expect(h.steps.filter((s) => s.outfitId === OUTFITS.P1)).toHaveLength(3);

    const stuck = harness({ step: () => json({ code: 'BUSY' }, 503) });
    const result = await runProbe(env(), stuck.deps);
    expect(result.calls).toHaveLength(0);
    expect(stuck.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
    expect(result.lines.join('\n')).toContain('Stopped after P1 step 1: BUSY.');
  });

  it('never sends P2 when the P3 call is not a disconnect', async () => {
    const h = harness({ step: (call) => call.outfitId === OUTFITS.P3 ? json({ code: 'FAILED' }, 502) : defaultStep(call) });
    const { calls, lines } = await runProbe(env(), h.deps);
    expect(calls.map((c) => c.code)).toEqual(['OK', 'OK', 'OK', 'FAILED']);
    expect(h.steps.some((s) => s.outfitId === OUTFITS.P2)).toBe(false);
    expect(lines.join('\n')).toContain('Stopped after P3: FAILED.');
  });
});
