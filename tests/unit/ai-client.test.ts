import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import { AiClient, AiError } from '../../src/data/ai';
import { parseAiStatus, supportedAiPolicy, parseAnalysisReply } from '../../src/domain/ai-controls';

const owner = '10000000-0000-4000-8000-000000000001';
const context = { ownerId: owner, epoch: 1, requestId: '30000000-0000-4000-8000-000000000001',
  draftId: '20000000-0000-4000-8000-000000000001', generation: 1, imageSha256: 'a'.repeat(64) };
function status() {
  return { code: 'OK', period: '2026-09', serverTimeMs: Date.now(),
    consent: { enabled: true, noticeRevision: 1, consentedAt: '2026-09-12T00:00:00Z', profileVersion: '1' },
    policy: { activated: true, modelId: 'gemini-3.8-flash', promptVersion: 1, noticeRevision: 1,
      maxRequestMicro: '2270823', monthlyAllowanceMicro: '100000000', maxRequestsPerHour: 200, resultTtlSeconds: 3600 },
    usage: { accountedMicro: '0', requestsLastHour: 0, warning: false } };
}
function fixture() {
  const abort = new AbortController(), scope = { ownerId: owner, epoch: 1, signal: abort.signal };
  const client = createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_test_only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const session: Session = { access_token: 'fictional-unit-only', refresh_token: 'fictional-unit-refresh',
    token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
  const auth = vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  const refresh = vi.spyOn(client.auth, 'refreshSession').mockResolvedValue({ data: { session, user: session.user }, error: null });
  const ai = new AiClient(client, { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test_only', version: 'test' }, scope);
  const photo = { main: new Blob(['synthetic'], { type: 'image/jpeg' }), thumb: new Blob(['thumb'], { type: 'image/jpeg' }),
    mainSha256: context.imageSha256, thumbSha256: 'b'.repeat(64), width: 120, height: 80 };
  return { ai, auth, refresh, session, scope, abort, photo };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function responseReader(text = JSON.stringify(status())) {
  const response = new Response(text, { headers: { 'content-type': 'application/json' } });
  if (!response.body) throw new Error('Synthetic response body missing');
  const reader = response.body.getReader();
  vi.spyOn(response.body, 'getReader').mockReturnValue(reader);
  const cancel = vi.spyOn(reader, 'cancel');
  const unlock = reader.releaseLock.bind(reader);
  const release = vi.spyOn(reader, 'releaseLock');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetcher);
  return { response, reader, cancel, release, unlock, fetcher };
}
describe('closed ordinary-auth AI boundary', () => {
  it('returns a parsed reply only after cancellation and lock release', async () => {
    const f = fixture(), stream = responseReader();
    let finish: (() => void) | undefined;
    stream.cancel.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;
    const result = f.ai.status().then((reply) => { settled = true; return reply; });
    await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false); expect(stream.release).not.toHaveBeenCalled();
    if (!finish) throw new Error('Synthetic cleanup was not reached');
    finish();
    expect(await result).toMatchObject({ code: 'OK', consent: { profileVersion: '1' } });
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
    expect(stream.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, false, 0, new AiError('TIMEOUT')])('retains cleanup-only failure %# after valid JSON', async (reason) => {
    const f = fixture(), stream = responseReader();
    stream.cancel.mockRejectedValue(reason);
    await expect(f.ai.status()).rejects.toMatchObject({ code: reason instanceof AiError ? 'TIMEOUT' : 'UNAVAILABLE' });
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false); expect(stream.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['read', 'parse'] as const)('preserves primary %s failure over cleanup failure', async (kind) => {
    const f = fixture(), stream = responseReader(kind === 'parse' ? '{' : JSON.stringify(status()));
    if (kind === 'read') vi.spyOn(stream.reader, 'read').mockRejectedValue(new AiError('CONFLICT'));
    stream.cancel.mockRejectedValue(new AiError('TIMEOUT'));
    await expect(f.ai.status()).rejects.toMatchObject({ code: kind === 'read' ? 'CONFLICT' : 'UNAVAILABLE' });
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false); expect(stream.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, false, 0])('retains falsy primary failure %# over cleanup failure', async (reason) => {
    const f = fixture(), stream = responseReader();
    vi.spyOn(stream.reader, 'read').mockRejectedValue(reason);
    stream.cancel.mockRejectedValue(new AiError('TIMEOUT'));
    await expect(f.ai.status()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['release', 'cancel', 'read'] as const)('retains %s failure priority when lock release also fails', async (kind) => {
    const f = fixture(), stream = responseReader();
    if (kind === 'read') vi.spyOn(stream.reader, 'read').mockRejectedValue(new AiError('INVALID_INPUT'));
    if (kind !== 'release') stream.cancel.mockRejectedValue(new AiError('CONFLICT'));
    stream.release.mockImplementation(() => { stream.unlock(); throw new AiError('TIMEOUT'); });
    await expect(f.ai.status()).rejects.toMatchObject({ code: kind === 'read' ? 'INVALID_INPUT' : kind === 'cancel' ? 'CONFLICT' : 'TIMEOUT' });
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false); expect(stream.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['DISCARDED', 'EXPIRED', 'FAILED', 'UNAVAILABLE', 'INVALID_FACTS'])('confirms strictly terminal %s without inference', async (reason) => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 'TERMINAL', reason }));
    vi.stubGlobal('fetch', fetcher);
    expect(parseAnalysisReply({ code: 'TERMINAL', reason })).toEqual({ code: 'TERMINAL', reason });
    await expect(f.ai.discard(context)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:54321/rest/v1/rpc/ai_request_control');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ p_request_id: context.requestId, p_action: 'discard' });
  });
  it.each([
    { code: 'TERMINAL', reason: ['FAILED'] }, { code: 'TERMINAL', reason: { reason: 'FAILED' } },
    { code: 'TERMINAL', reason: null }, { code: 'TERMINAL', reason: 1 }, { code: 'TERMINAL', reason: false },
    { code: 'TERMINAL', reason: 'OTHER' }, { code: 'TERMINAL', reason: 'FAILED', extra: true },
    { code: 'UNAVAILABLE', reason: 'FAILED' }, null,
  ])('rejects malformed terminal envelope %#', async (body) => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetcher);
    expect(parseAnalysisReply(body)).toBeNull();
    await expect(f.ai.discard(context)).rejects.toThrow('aiC.unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:54321/rest/v1/rpc/ai_request_control');
  });
  it.each([
    { status: 200, body: { code: 'TERMINAL' } },
    { status: 200, body: { code: 'UNAVAILABLE' } },
    { status: 200, body: { code: 'OK', status: 'dispatched', result: null,
      accounting: { basis: 'held', amountMicro: '2270823', currency: 'USD' } } },
    { status: 202, body: { code: 'TERMINAL', reason: 'FAILED' } },
    { status: 409, body: { code: 'TERMINAL', reason: 'FAILED' } },
    { status: 500, body: { code: 'TERMINAL', reason: 'FAILED' } },
  ])('rejects nonterminal or non-200 discard response %#', async ({ status: code, body }) => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: code }));
    vi.stubGlobal('fetch', fetcher);
    await expect(f.ai.discard(context)).rejects.toThrow('aiC.unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:54321/rest/v1/rpc/ai_request_control');
  });
  it('uses fixed routes, fresh ordinary auth, no cache, and a literal null opt-out', async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 'OK', profileVersion: '9007199254740993' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await f.ai.consent({ enabled: false, noticeRevision: null, expectedVersion: 1 })).toBe('9007199254740993');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:54321/rest/v1/rpc/ai_set_consent');
    expect(JSON.parse(String(init?.body))).toEqual({ p_enabled: false, p_notice_revision: null, p_expected_version: 1 });
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fictional-unit-only');
    expect(f.auth).toHaveBeenCalledTimes(1);
  });
  it('refreshes an expiring session, but does not retry a 401', async () => {
    const f = fixture(); f.session.expires_at = 1;
    const fetcher = vi.fn(async () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(f.ai.status()).rejects.toThrow();
    expect(f.refresh).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([0, 512001])('rejects %s prepared bytes before auth or dispatch', async (size) => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(f.ai.analyze(context, { ...f.photo, main: new Blob([new Uint8Array(size)], { type: 'image/jpeg' }) })).rejects.toThrow();
    expect(f.auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses changed owner, epoch and hash before dispatch', async () => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const changed of [{ ...context, ownerId: context.draftId }, { ...context, epoch: 2 }, { ...context, imageSha256: 'b'.repeat(64) }]) {
      await expect(f.ai.analyze(changed, f.photo)).rejects.toThrow();
    }
    f.auth.mockImplementation(async () => { f.scope.epoch++; return { data: { session: f.session }, error: null }; });
    await expect(f.ai.status()).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'oversized', 'content-type', 'unknown-key'] as const)('rejects %s response', async (kind) => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'unknown-key'
      ? Response.json({ ...status(), extra: true })
      : new Response(kind === 'oversized' ? 'x'.repeat(32769) : '{', { headers: { 'content-type': kind === 'content-type' ? 'text/html' : 'application/json' } })));
    await expect(f.ai.status()).rejects.toThrow('aiC.unavailable');
  });
  it('bounds a stalled stream and cancellation within five seconds', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() {}, cancel }), { headers: { 'content-type': 'application/json' } })));
    const rejected = expect(f.ai.status()).rejects.toThrow('aiC.uncertain');
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('ignores a late auth completion after owner abort', async () => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    let release!: () => void;
    f.auth.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ data: { session: f.session }, error: null }); }));
    const rejected = expect(f.ai.status()).rejects.toThrow('aiC.unavailable');
    f.abort.abort(); release(); await rejected; expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([202, 504])('keeps %s distinct and sends only one analysis POST', async (code) => {
    const f = fixture();
    const fetcher = vi.fn(async (url: string) => url.endsWith('/ai_status') ? Response.json(status())
      : Response.json(code === 202 ? { code: 'OK', status: 'dispatched', result: null,
        accounting: { basis: 'held', amountMicro: '2270823', currency: 'USD' } } : { code: 'TIMEOUT' }, { status: code }));
    vi.stubGlobal('fetch', fetcher);
    if (code === 202) expect(await f.ai.analyze(context, f.photo)).toMatchObject({ status: 'dispatched', result: null });
    else await expect(f.ai.analyze(context, f.photo)).rejects.toThrow('aiC.uncertain');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/analyze-clothing'))).toHaveLength(1);
  });
  it('keeps the analysis outer deadline at 25 seconds including auth and reads', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/ai_status') ? Response.json(status()) : new Promise<Response>(() => {})));
    const rejected = expect(f.ai.analyze(context, f.photo)).rejects.toThrow('aiC.uncertain');
    await vi.advanceTimersByTimeAsync(25001); await rejected;
  });
});
describe('status validation and current policy', () => {
  it('rejects unsafe numeric money, bad counters and extra fields', () => {
    const good = status();
    expect(parseAiStatus(good)).not.toBeNull();
    expect(parseAiStatus({ ...good, usage: { ...good.usage, accountedMicro: 0 } })).toBeNull();
    expect(parseAiStatus({ ...good, policy: { ...good.policy, resultTtlSeconds: 86401 } })).toBeNull();
    expect(parseAiStatus({ ...good, consent: { ...good.consent, profileVersion: '01' } })).toBeNull();
    expect(parseAnalysisReply({ code: 'TERMINAL', reason: 'private text' })).toBeNull();
  });
  it('refuses unknown notice/model, inactive controls and expired review', () => {
    const good = parseAiStatus(status())!;
    expect(supportedAiPolicy(good, Date.parse('2026-09-12T00:00:00Z'))).toBe(true);
    expect(supportedAiPolicy(good, Date.parse('2027-01-01T00:00:00Z'))).toBe(false);
    for (const policy of [{ ...good.policy!, noticeRevision: 2 }, { ...good.policy!, modelId: 'other' }, { ...good.policy!, activated: false }])
      expect(supportedAiPolicy({ ...good, policy })).toBe(false);
  });
});
