import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, WARM_FUNCTIONS, PROBE_STEPS, PROBE_CAUSES, probeServedFunction, warmServedFunctions,
  probeStep, probeCause, resetProbe, probeHttpCause, probeErrorCause, probeFailureDetail, probeReasonLine, adoptProbeReason,
} from '../../scripts/backend/local.mjs';

const signature = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Methods': 'POST' };
const worker = () => new Response(null, { status: 204, headers: signature });
const owned = () => ({ stop: vi.fn(async () => {}), ready: vi.fn(), assertRunning: vi.fn() });
const noPause = async () => {};

afterEach(() => { resetProbe(); vi.restoreAllMocks(); });

describe('served-function warm-up', () => {
  it('covers every served function except the readiness-probed analyzer', async () => {
    const entries = (await import('node:fs/promises')).readdir(path.join(ROOT, 'supabase', 'functions'));
    const served = (await entries).filter((name) => !name.startsWith('_') && name !== 'analyze-clothing').sort();
    expect([...WARM_FUNCTIONS].sort()).toEqual(served);
  });

  it('sends one OPTIONS preflight to each function and needs the handler signature', async () => {
    const transport = vi.fn<typeof fetch>(async () => worker());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause);
    expect(transport.mock.calls.map(([url, init]) => [url, init?.method])).toEqual(
      WARM_FUNCTIONS.map((name) => [`http://127.0.0.1:54321/functions/v1/${name}`, 'OPTIONS']));
    const line = log.mock.calls.at(-1)?.[0] as string;
    expect(line.startsWith('B1-WARM ')).toBe(true);
    expect(JSON.parse(line.slice(8))).toMatchObject({ functions: 3, attempts: 3, reason: 'ready', lastStatus: 204 });
  });

  it('keeps waiting through gateway 404/502/503 and transport failures, never treating them as ready', async () => {
    const replies = [new Response('x', { status: 404 }), new Response('x', { status: 502 }), new Response('x', { status: 503 })];
    let failures = 1;
    const transport = vi.fn<typeof fetch>(async () => {
      if (failures-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return replies.shift() ?? worker();
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause);
    expect(transport).toHaveBeenCalledTimes(7);
  });

  it('fails closed with a named reason when a worker never boots before the deadline', async () => {
    const transport = vi.fn<typeof fetch>(async (url) => String(url).endsWith('finalize-image-change')
      ? new Response('gateway', { status: 502 }) : worker());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deadline = Date.now() + 200;
    await expect(warmServedFunctions(owned(), deadline, transport, (ms) => new Promise((r) => setTimeout(r, ms))))
      .rejects.toMatchObject({ reason: 'warm-finalize-image-change-deadline' });
    expect(JSON.parse((log.mock.calls.at(-1)?.[0] as string).slice(8)))
      .toMatchObject({ functions: 1, reason: 'warm-finalize-image-change-deadline', lastStatus: 502 });
  });

  it.each([200, 400, 401, 403, 500])('fails at once on an unexpected %i even if a signed 204 would follow', async (status) => {
    const replies = [new Response('private worker body', { status }), worker()];
    const transport = vi.fn<typeof fetch>(async () => replies.shift() ?? worker());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause))
      .rejects.toMatchObject({ reason: `warm-finalize-analyzed-item-status-${Math.floor(status / 100)}xx` });
    expect(transport).toHaveBeenCalledOnce();
    const line = log.mock.calls.at(-1)?.[0] as string;
    expect(line).not.toContain('private');
    expect(JSON.parse(line.slice(8))).toMatchObject({ functions: 0, attempts: 1, lastStatus: status });
  });

  it('does not follow a redirect: a 302 followed by a signed 204 fails after one request', async () => {
    const replies = [new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1/elsewhere' } }), worker()];
    const transport = vi.fn<typeof fetch>(async () => replies.shift() ?? worker());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause))
      .rejects.toMatchObject({ reason: 'warm-finalize-analyzed-item-status-3xx' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it.each([
    ['an unexpected-redirect TypeError', new TypeError('unexpected redirect')],
    ['a fetch failure without a transient code', Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })],
    ['a foreign abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a plain error', new Error('private detail')],
  ])('fails closed on %s after one request, even if a signed 204 would follow', async (_label, failure) => {
    let first = true;
    const transport = vi.fn<typeof fetch>(async () => { if (first) { first = false; throw failure; } return worker(); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause))
      .rejects.toMatchObject({ reason: 'warm-finalize-analyzed-item-transport-other' });
    expect(transport).toHaveBeenCalledOnce();
    expect(log.mock.calls.at(-1)?.[0]).not.toContain('private');
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'])('retries a %s transport failure', async (code) => {
    let failures = 2;
    const transport = vi.fn<typeof fetch>(async () => {
      if (failures-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
      return worker();
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause);
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it('retries a timed-out preflight', async () => {
    let failures = 1;
    const transport = vi.fn<typeof fetch>(async () => {
      if (failures-- > 0) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return worker();
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('refuses at once when a 204 lacks the handler signature', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmServedFunctions(owned(), Date.now() + 60_000, transport, noPause))
      .rejects.toMatchObject({ reason: 'warm-finalize-analyzed-item-signature-mismatch' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('stops when the owned server dies during warm-up', async () => {
    const process = owned();
    process.assertRunning.mockImplementationOnce(() => {}).mockImplementation(() => {
      throw Object.assign(new Error('gone'), { reason: 'child-exit' });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmServedFunctions(process, Date.now() + 60_000, vi.fn<typeof fetch>(async () => worker()), noPause))
      .rejects.toMatchObject({ reason: 'warm-finalize-analyzed-item-reader-failed' });
  });

  it('probes only the listed functions', async () => {
    await expect(probeServedFunction('analyze-clothing', vi.fn<typeof fetch>())).rejects.toMatchObject({ reason: 'reader-failed' });
  });

  it('starts the warm-up only after the analyzer readiness gate and settles the gateway before returning the server', async () => {
    const source = await readFile(path.join(ROOT, 'scripts', 'backend', 'local.mjs'), 'utf8');
    expect(source).toContain('await waitForAnalysisHandler(owned, { deadline, spawnedAt, previous });\n      await warmServedFunctions(owned, deadline);\n      await settleGateway(owned, deadline, { before: kongBefore, key });\n      return owned;');
    const start = source.slice(source.indexOf('export async function startAnalysisServer('));
    expect(start.indexOf('const kongBefore = await readKongWorkers(deadline);')).toBeGreaterThan(0);
    expect(start.indexOf('const kongBefore = await readKongWorkers(deadline);')).toBeLessThan(start.indexOf('const child = spawn('));
  });
});

describe('rehearsal step and cause codes', () => {
  it('prints nothing when no step was marked', () => {
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('');
  });

  it('names the step and the recorded HTTP cause, then clears', () => {
    probeStep('replacement-complete'); probeCause(probeHttpCause(502));
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('; step=replacement-complete; cause=http-502');
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('');
  });

  it('prints an unknown reason as other, never as raw text', () => {
    probeStep('colour-consent'); probeCause('private owner@example.test detail');
    expect(probeFailureDetail(undefined)).toBe('; step=colour-consent; cause=other');
    probeStep('Private step with spaces');
    expect(probeFailureDetail(new Error('secret token abc'))).toBe('; step=other; cause=other');
  });

  it('keeps the first cause for a step and resets it on the next step', () => {
    probeStep('b2-upload'); probeCause('http-503'); probeCause('http-404');
    probeStep('b2-reserve');
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('; step=b2-reserve; cause=assert');
  });

  it.each([
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'transport-timeout'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'transport-aborted'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'transport-refused'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'transport-reset'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }), 'transport-socket'],
    [new TypeError('fetch failed'), 'transport-failed'],
    [new SyntaxError('Unexpected token'), 'unexpected-body'],
    [new Error('EVIDENCE_REQUIRED'), 'assert'],
    [new Error('some private message'), 'other'],
    ['raw string', 'other'], [null, 'other'],
  ])('classifies errors into fixed causes %#', (error, cause) => {
    expect(probeErrorCause(error)).toBe(cause);
  });

  it('maps statuses into fixed HTTP causes', () => {
    expect([404, 418, 502, 507, 302, Number.NaN].map(probeHttpCause))
      .toEqual(['http-404', 'http-4xx', 'http-502', 'http-5xx', 'http-other', 'http-other']);
  });

  it('only uses content-free codes', () => {
    for (const code of [...PROBE_STEPS, ...PROBE_CAUSES]) expect(code).toMatch(/^[a-z0-9-]{1,48}$/);
    expect(PROBE_CAUSES).toContain('other');
  });

  it('round-trips a child reason line and drops forged or ambiguous ones as other', () => {
    probeStep('b2-analysis-request'); probeCause('http-503');
    const line = probeReasonLine(new Error('EVIDENCE_REQUIRED'));
    expect(line).toBe('PROBE-REASON b2-analysis-request http-503');
    adoptProbeReason(`FAIL: B2 integration prepare; private details withheld; fixture state retained\n${line}\n`);
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('; step=b2-analysis-request; cause=http-503');
    for (const forged of ['PROBE-REASON b2-upload leaked-secret-value', 'PROBE-REASON Private step', `${line}\n${line}`]) {
      adoptProbeReason(forged);
      expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toMatch(/^; step=(b2-upload|other); cause=other$/);
    }
    adoptProbeReason('FAIL: no reason line');
    expect(probeFailureDetail(new Error('EVIDENCE_REQUIRED'))).toBe('');
  });

  it('keeps the existing FAIL prefixes and appends the codes after them', async () => {
    const ai = await readFile(path.join(ROOT, 'scripts', 'ai-analysis-rehearsal.mjs'), 'utf8');
    expect(ai).toContain('console.error(`FAIL: AI rehearsal at ${stage}; private evidence withheld; fixture state preserved, no automatic recovery${probeFailureDetail(error)}`);');
    const preservation = await readFile(path.join(ROOT, 'scripts', 'preservation-rehearsal.mjs'), 'utf8');
    expect(preservation).toContain('; subsequent stages NOT RUN${probeFailureDetail(error)}`);');
  });
});
