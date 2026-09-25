import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the real shared client wrapper: a deletion reply may take longer than the ordinary 20 s limit.
const OWNER = '11111111-1111-4111-8111-111111111111';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'public-key', version: 'test' };

function delayedFetch(delayMs: number, body: unknown) {
  const seen: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const address = input instanceof Request ? input.url : String(input);
    seen.push(new URL(address).pathname);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })), delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); });
    });
  });
  return { fetch, seen };
}

describe('deletion request transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fake timers do not cover AbortSignal.timeout, so it is rebuilt on the faked setTimeout.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out.', 'TimeoutError')), ms);
      return controller.signal;
    });
    const store = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

  async function setup(delayMs: number, body: unknown) {
    const transport = delayedFetch(delayMs, body);
    vi.stubGlobal('fetch', transport.fetch);
    const { makeClient } = await import('../../src/data/client');
    const { deleteAccount } = await import('../../src/data/delete-account');
    const client = makeClient(config);
    vi.spyOn(client.auth, 'getSession').mockResolvedValue({
      data: { session: { user: { id: OWNER }, access_token: 'token' } }, error: null,
    } as never);
    const scope = { ownerId: OWNER, epoch: 1, signal: new AbortController().signal };
    return { client, scope, transport, deleteAccount };
  }

  it('waits past the ordinary 20 s limit for a deletion that completes after 25 s', async () => {
    const { client, scope, transport, deleteAccount } = await setup(25_000, { state: 'complete' });
    const result = deleteAccount(client, scope, 'password', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBe('complete');
    expect(transport.seen).toEqual(['/functions/v1/delete-account']);
  });

  it('still gives up on a deletion reply after the deletion limit', async () => {
    const { client, scope, deleteAccount } = await setup(200_000, { state: 'complete' });
    const result = deleteAccount(client, scope, 'password', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(130_000);
    await expect(result).resolves.toBe('failed');
  });

  it('keeps the 20 s limit for every other request', async () => {
    const { client, transport } = await setup(25_000, { state: 'complete' });
    const settled = client.functions.invoke('finalize-image-change', { body: {}, method: 'POST' }).then((reply) => reply.error);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(settled).resolves.not.toBeNull();
    expect(transport.seen).toEqual(['/functions/v1/finalize-image-change']);
  });
});
