import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  ROOT, PROBE_CAUSES, probeErrorCause, settleGateway, parseKongWorkers, kongReloaded, readKongWorkers,
  failedBeforeResponse, retryBeforeResponse, closingFetch, type KongWorkers,
} from '../../scripts/backend/local.mjs';

const owned = () => ({ stop: vi.fn(async () => {}), ready: vi.fn(), assertRunning: vi.fn() });
const noPause = async () => {};
const socketError = (code = 'UND_ERR_SOCKET') => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const healthy = () => new Response('{}', { status: 200 });
const before: KongWorkers = { workers: ['101', '102'], draining: 0 };
const reloaded: KongWorkers = { workers: ['201', '202'], draining: 0 };

function gatewayLine(log: ReturnType<typeof vi.spyOn>) {
  const line = log.mock.calls.map(([value]: unknown[]) => String(value)).find((value: string) => value.startsWith('B1-GATEWAY '));
  return JSON.parse(line!.slice('B1-GATEWAY '.length)) as Record<string, unknown>;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Kong worker observation', () => {
  it('reads current and draining nginx workers from docker top', () => {
    const stdout = 'PID                 COMMAND\n900                 nginx: master process /usr/local/openresty/nginx/sbin/nginx -p /usr/local/kong\n'
      + '101                 nginx: worker process is shutting down\n201                 nginx: worker process\n';
    expect(parseKongWorkers(stdout)).toEqual({ workers: ['201'], draining: 1 });
  });

  it('refuses unexpected output', () => {
    for (const stdout of ['', 'garbage', 'PID COMMAND\nnot-a-pid nginx: worker process\n', 'PID COMMAND\n900 nginx: master process\n', 42]) {
      expect(parseKongWorkers(stdout)).toBeNull();
    }
  });

  it('counts a reload only when every worker is new and none is draining', () => {
    expect(kongReloaded(before, before)).toBe(false);
    expect(kongReloaded(before, { workers: ['201', '102'], draining: 0 })).toBe(false);
    expect(kongReloaded(before, { workers: ['201', '202'], draining: 1 })).toBe(false);
    expect(kongReloaded(before, null)).toBe(false);
    expect(kongReloaded(before, reloaded)).toBe(true);
  });

  it('reads the Kong container read-only and returns null when docker top fails', async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such container' }));
    await expect(readKongWorkers(Date.now() + 10_000, run)).resolves.toBeNull();
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(['docker', ['top', 'supabase_kong_stillroom-wardrobe', '-o', 'pid,args']]);
  });
});

describe('gateway settle', () => {
  it('waits for the observed reload, then needs three healthy Auth answers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readWorkers = vi.fn<(deadline: number) => Promise<KongWorkers | null>>()
      .mockResolvedValueOnce(before).mockResolvedValueOnce({ workers: ['201', '202'], draining: 2 }).mockResolvedValue(reloaded);
    const transport = vi.fn<typeof fetch>(async () => healthy());
    await settleGateway(owned(), Date.now() + 60_000, { before, key: 'publishable', readWorkers, transport, pause: noPause });
    expect(readWorkers).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:54321/auth/v1/health');
    expect(init).toMatchObject({ method: 'GET', headers: { apikey: 'publishable' } });
    expect(gatewayLine(log)).toMatchObject({ reload: 'observed', attempts: 3, socketErrors: 0, reason: 'ready' });
  });

  it('passes after a closed socket once the gateway answers again, restarting the healthy count', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(healthy()).mockRejectedValueOnce(socketError()).mockRejectedValueOnce(socketError('ECONNRESET'))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValue(healthy());
    await settleGateway(owned(), Date.now() + 60_000, { before: null, key: 'k', transport, pause: noPause });
    expect(transport).toHaveBeenCalledTimes(7);
    expect(gatewayLine(log)).toMatchObject({ reload: 'unobserved', socketErrors: 2, reason: 'ready' });
  });

  it('fails closed with a gateway cause when sockets keep closing until the deadline', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deadline = Date.now() + 200;
    const transport = vi.fn<typeof fetch>(async () => { throw socketError(); });
    const error = await settleGateway(owned(), deadline, { before: null, key: 'k', transport,
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'gateway-deadline' });
    expect(probeErrorCause(error)).toBe('startup-gateway');
    expect(PROBE_CAUSES).toContain('startup-gateway');
    expect(gatewayLine(log)).toMatchObject({ reason: 'gateway-deadline' });
  });

  it('fails at once on any other status or transport error, without retrying', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [answer, reason] of [
      [new Response(null, { status: 500 }), 'gateway-status-5xx'],
      [new Response(null, { status: 401 }), 'gateway-status-4xx'],
      [new SyntaxError('private'), 'gateway-transport-other'],
    ] as const) {
      const transport = vi.fn<typeof fetch>(async () => { if (answer instanceof Error) throw answer; return answer; });
      await expect(settleGateway(owned(), Date.now() + 60_000, { before: null, key: 'k', transport, pause: noPause }))
        .rejects.toMatchObject({ reason });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back to the timing heuristic when no reload is seen within its bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readWorkers = vi.fn(async () => before);
    const pause = async (ms: number) => { vi.setSystemTime(Date.now() + ms); };
    const transport = vi.fn<typeof fetch>(async () => healthy());
    await settleGateway(owned(), Date.now() + 60_000, { before, key: 'k', readWorkers, transport, pause });
    expect(gatewayLine(log)).toMatchObject({ reload: 'not-seen', reason: 'ready' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('stops when the owned server dies', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = owned();
    server.assertRunning.mockImplementation(() => { throw new Error('private exit detail'); });
    await expect(settleGateway(server, Date.now() + 60_000, { before: null, key: 'k', transport: vi.fn<typeof fetch>(), pause: noPause }))
      .rejects.toMatchObject({ reason: 'gateway-reader-failed' });
  });
});

describe('closing probe transport', () => {
  it('uses a fresh connection that the server sees closed after each probe', async () => {
    const connections: string[] = [];
    const server = http.createServer((request, response) => {
      connections.push(String(request.headers.connection));
      response.writeHead(204, { 'X-Probe': 'yes' }); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      for (let i = 0; i < 2; i++) {
        const response = await closingFetch(`http://127.0.0.1:${port}/x`, { method: 'OPTIONS', signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(204);
        expect(response.headers.get('x-probe')).toBe('yes');
        await response.body.cancel();
      }
      expect(connections).toEqual(['close', 'close']);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('reports a refused connection like fetch does', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    const error = await closingFetch(`http://127.0.0.1:${port}/`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(probeErrorCause(error)).toBe('transport-refused');
  });
});

describe('sign-in transport retry', () => {
  it('retries only a connection closed or reset before any response', () => {
    expect(failedBeforeResponse(socketError())).toBe(true);
    expect(failedBeforeResponse(socketError('ECONNRESET'))).toBe(true);
    for (const error of [socketError('ECONNREFUSED'), Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }),
      Object.assign(new Error('x'), { name: 'TimeoutError' }), new Error('EVIDENCE_REQUIRED'), null]) {
      expect(failedBeforeResponse(error)).toBe(false);
    }
  });

  it('succeeds after two closed sockets', async () => {
    const operation = vi.fn().mockRejectedValueOnce(socketError()).mockRejectedValueOnce(socketError('ECONNRESET')).mockResolvedValue('ok');
    await expect(retryBeforeResponse(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after three attempts as transport-socket', async () => {
    const operation = vi.fn(async () => { throw socketError(); });
    const error = await retryBeforeResponse(operation).catch((caught: unknown) => caught);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(probeErrorCause(error)).toBe('transport-socket');
  });

  it('never retries an answer or any other failure', async () => {
    const answered = vi.fn(async () => ({ ok: false, status: 400 }));
    await expect(retryBeforeResponse(answered)).resolves.toEqual({ ok: false, status: 400 });
    const failed = vi.fn(async () => { throw new Error('EVIDENCE_REQUIRED'); });
    await expect(retryBeforeResponse(failed)).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(answered).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('wraps only the normal-session password sign-in', async () => {
    const source = await readFile(path.join(ROOT, 'tests', 'integration', 'preservation.sessions.mjs'), 'utf8');
    expect(source.match(/retryBeforeResponse\(/g)).toHaveLength(1);
    expect(source).toContain("retryBeforeResponse(() => request(null, '/auth/v1/token?grant_type=password'");
  });
});
