import { expect, test, type Page, type Response as PlaywrightResponse, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { messages, type Language } from '../../src/i18n';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';
import { analysisPath, mockBackend, owners, signIn, type RawAnalysisObservation } from './mock-backend';

type AiFixture = Awaited<ReturnType<typeof aiFixture>>;
// A ready draft shows no status line: the filled fields and their "Suggested" markers are the signal.
async function filled(page: Page, language: Language = 'en') {
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await expect(page.locator('.field-marker', { hasText: messages['aiC.markSuggested'][language] }).first()).toBeVisible();
  await expect(page.locator('#analysis-status')).toHaveCount(0);
}
const statusRegion = (page: Page) => page.locator('#analysis-status');
const posts = (api: AiFixture) => api.calls.filter((call) => call.route.endsWith('/analyze-clothing'));
// A schema-valid "still working" status reply, so the client really parses it as dispatched.
const dispatched = { code: 'OK', status: 'dispatched', result: null, accounting: { basis: 'held', amountMicro: '1034', currency: 'USD' } };
const statusChecks = (api: AiFixture) => api.calls.filter((call) => call.route.endsWith('/ai_analysis_status'));
type RawAnalysisClient = { status: number | null; outcome: 'response' | 'network-rejection'; constructedBytes?: number };
type RawAnalysisEvidence = {
  case: 'oversized' | 'response-sequence' | 'boundaries'; project: 'chromium' | 'mobile' | 'webkit-photo' | null;
  retry: number | null; repeat: number | null; fixturePresent: boolean;
  snapshotPhase: 'not-captured' | 'before-cleanup' | 'fixture-unavailable';
  cleanupStarted: boolean; cleanupCompleted: boolean; captureError: boolean;
  client: Array<RawAnalysisClient | null>; observation: RawAnalysisObservation | null;
  cumulative: AiFixture['analysisWire'] | null;
};
function rawAnalysisEvidence(kind: RawAnalysisEvidence['case']): RawAnalysisEvidence {
  return { case: kind, project: null, retry: null, repeat: null, fixturePresent: false,
    snapshotPhase: 'not-captured', cleanupStarted: false, cleanupCompleted: false, captureError: false,
    client: [], observation: null, cumulative: null };
}
function copyRawAnalysisClient(client: unknown, kind?: RawAnalysisEvidence['case']): RawAnalysisClient | null {
  if (client === null) return null;
  if (!client || typeof client !== 'object' || Array.isArray(client)) throw new Error('Invalid analysis client observation');
  const fields = kind === undefined ? ['status', 'outcome'] : ['status', 'outcome', 'constructedBytes'];
  const keys = Reflect.ownKeys(client);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    throw new Error('Invalid analysis client observation');
  }
  const status: unknown = Object.getOwnPropertyDescriptor(client, 'status')?.value;
  const outcome: unknown = Object.getOwnPropertyDescriptor(client, 'outcome')?.value;
  if ((status !== null && (typeof status !== 'number' || ![200, 400, 403, 413, 502, 504].includes(status)))
    || (outcome !== 'response' && outcome !== 'network-rejection')) throw new Error('Invalid analysis client observation');
  if (kind === undefined) return { status, outcome };
  const constructedBytes: unknown = Object.getOwnPropertyDescriptor(client, 'constructedBytes')?.value;
  if (typeof constructedBytes !== 'number' || !Number.isSafeInteger(constructedBytes)
    || constructedBytes < 0 || constructedBytes > 512001) throw new Error('Invalid analysis client observation');
  return { status, outcome, constructedBytes };
}
function snapshotRawAnalysis(evidence: RawAnalysisEvidence, api: AiFixture | undefined,
  clients: readonly (Awaited<ReturnType<typeof sendBrowserAnalysis>> | null)[]) {
  try {
    evidence.fixturePresent = api !== undefined;
    evidence.snapshotPhase = api ? 'before-cleanup' : 'fixture-unavailable';
    evidence.client = clients.slice(0, 4).map((client) => {
      try { return copyRawAnalysisClient(client, evidence.case); }
      catch {
        evidence.captureError = true;
        return null;
      }
    });
    if (clients.length > 4) evidence.captureError = true;
    if (api?.rawAnalysisObservation) {
      const observation = api.rawAnalysisObservation;
      const { detail, boundaryDetail, ...baseObservation } = observation;
      evidence.observation = { ...baseObservation, posts: observation.posts.slice(0, 4).map((post) => ({
        ...post, firstPostTerminalReject: post.firstPostTerminalReject ? { ...post.firstPostTerminalReject } : null,
      })), firstAttemptedPost400: observation.firstAttemptedPost400 ? { ...observation.firstAttemptedPost400 } : null };
      evidence.cumulative = { ...api.analysisWire };
      if (evidence.case === 'response-sequence') {
        if (detail) {
          evidence.observation.detail = { ...detail,
            routes: detail.routes.slice(0, 4).map((record) => ({ ...record })),
            receivers: detail.receivers.slice(0, 4).map((record) => ({ ...record })) };
          if (detail.overflow || detail.evidenceError || detail.routes.length > 4 || detail.receivers.length > 4) {
            evidence.captureError = true;
          }
        } else evidence.captureError = true;
      }
      if (evidence.case === 'boundaries') {
        if (!boundaryDetail || boundaryDetail.mode !== 'boundary-framing-v1'
          || Object.keys(boundaryDetail).sort().join(',') !== 'evidenceError,mode,overflow,receivers'
          || typeof boundaryDetail.overflow !== 'boolean' || typeof boundaryDetail.evidenceError !== 'boolean'
          || !Array.isArray(boundaryDetail.receivers)) throw new Error('Invalid boundary observation');
        evidence.observation.boundaryDetail = {
          mode: 'boundary-framing-v1', overflow: boundaryDetail.overflow, evidenceError: boundaryDetail.evidenceError,
          receivers: boundaryDetail.receivers.slice(0, 2).map(record => {
            if (!record || Object.keys(record).sort().join(',') !== 'complete,contentLength,ordinal,readableEnded,readableLength,transferEncoding'
              || (record.ordinal !== 1 && record.ordinal !== 2)
              || !['absent', 'zero', '1', '512000', 'other', 'invalid'].includes(record.contentLength)
              || !['absent', 'chunked', 'other'].includes(record.transferEncoding)
              || !['zero', '1', '512000', 'other', 'invalid'].includes(record.readableLength)
              || typeof record.complete !== 'boolean' || typeof record.readableEnded !== 'boolean') throw new Error('Invalid boundary record');
            return { ordinal: record.ordinal, contentLength: record.contentLength, transferEncoding: record.transferEncoding,
              complete: record.complete, readableEnded: record.readableEnded, readableLength: record.readableLength };
          }),
        };
        if (boundaryDetail.overflow || boundaryDetail.evidenceError || boundaryDetail.receivers.length > 2) evidence.captureError = true;
      }
      if (observation.overflow || observation.evidenceError || observation.posts.length > 4) evidence.captureError = true;
    } else evidence.captureError = true;
  } catch { evidence.captureError = true; }
}
function emitRawAnalysis(evidence: RawAnalysisEvidence, testInfo: TestInfo) {
  try {
    if (!Number.isSafeInteger(testInfo.retry) || testInfo.retry < 0 || testInfo.retry > 1) evidence.captureError = true;
    else evidence.retry = testInfo.retry;
    if (!Number.isSafeInteger(testInfo.repeatEachIndex) || testInfo.repeatEachIndex < 0) evidence.captureError = true;
    else evidence.repeat = testInfo.repeatEachIndex;
    const project = testInfo.project.name;
    if (project === 'chromium' || project === 'mobile' || project === 'webkit-photo') evidence.project = project;
    else evidence.captureError = true;
  } catch { evidence.captureError = true; }
  try { testInfo.annotations.push({ type: 'synthetic-raw-analysis-localization', description: JSON.stringify(evidence) }); }
  catch { evidence.captureError = true; }
  try { console.log('synthetic-raw-analysis-localization', JSON.stringify(evidence)); }
  catch { evidence.captureError = true; }
}
const fixtureKey = 'sb_publishable_browser_fixture_only';
const analysisHeaderNames = 'authorization, apikey, content-type, x-stillroom-request-id, x-stillroom-draft-id, x-stillroom-generation';
function analysisIds(account: 'a' | 'b' = 'a') {
  const id = () => `c329${account}000-${randomUUID().slice(9)}`;
  return { requestId: id(), draftId: id(), generation: '1' };
}
function storageCounts(api: AiFixture) {
  const { posts, preflights, rejected, receivedBytes, payloadBytes, peakBufferedBytes } = api.uploadWire;
  return { posts, preflights, rejected, receivedBytes, payloadBytes, peakBufferedBytes };
}
function assertAnalysisBytes(input: { bytes: number; sha256: string }, expected: Buffer) {
  expect(input.bytes).toBeGreaterThan(0);
  expect(input.bytes).toBe(expected.length);
  expect(input.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
}
async function assertAnalysisClosed(page: Page, api: AiFixture) {
  await page.close();
  await expect.poll(() => ({ closed: api.uploadWire.closed, listening: api.uploadWire.listening,
    connections: api.uploadWire.connections, active: api.analysisWire.active }))
    .toEqual({ closed: true, listening: false, connections: 0, active: 0 });
}
type BrowserAnalysisKind = 'valid' | 'wrong-key' | 'wrong-bearer' | 'wrong-owner' | 'request-id' |
  'draft-id' | 'generation' | 'method' | 'path' | 'query' | 'content-type' | 'empty' | 'oversized';
async function sendBrowserAnalysis(page: Page, api: AiFixture, kind: BrowserAnalysisKind = 'valid',
  bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)), captureSize = false): Promise<{ status: number | null; outcome: string; constructedBytes?: number }> {
  const ids = analysisIds();
  const result = await page.evaluate(async ({ authorization, ids, kind, bytes, route, key }) => {
    const headers = { authorization: kind === 'wrong-bearer' ? 'Bearer not-issued' : authorization,
      apikey: kind === 'wrong-key' ? 'wrong-fixture-key' : key,
      'content-type': kind === 'content-type' ? 'text/plain' : 'image/jpeg',
      'x-stillroom-request-id': kind === 'request-id' ? 'invalid' : kind === 'wrong-owner'
        ? ids.requestId.replace('c329a000', 'c329b000') : ids.requestId,
      'x-stillroom-draft-id': kind === 'draft-id' ? 'invalid' : ids.draftId,
      'x-stillroom-generation': kind === 'generation' ? '0' : ids.generation };
    const body = new Blob([kind === 'empty' ? new Uint8Array() : kind === 'oversized'
      ? new Uint8Array(512001) : new Uint8Array(bytes)], { type: headers['content-type'] });
    const constructedBytes = body.size;
    try {
      const response = await fetch('http://127.0.0.1:54321' + route
        + (kind === 'path' ? '-unapproved' : kind === 'query' ? '?unexpected=1' : ''), {
        method: kind === 'method' ? 'PUT' : 'POST', headers, body, credentials: 'omit', signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, outcome: 'response', constructedBytes };
    } catch { return { status: null, outcome: 'network-rejection', constructedBytes }; }
  }, { authorization: api.issuedWireAuthorization('a'), ids, kind, bytes: [...bytes], route: analysisPath, key: fixtureKey });
  return { status: result.status, outcome: result.outcome,
    ...(captureSize ? { constructedBytes: result.constructedBytes } : {}) };
}
test('raw analysis client copier preserves closed pre-fetch observations without reading content', () => {
  let invoked = 0;
  const hostile = () => { invoked++; throw new Error('private-analysis-observation-canary'); };
  for (const kind of ['boundaries', 'response-sequence', 'oversized'] as const) {
    for (const constructedBytes of [0, 1, 512000, 512001]) {
      for (const status of [null, 200, 400, 403, 413, 502, 504]) {
        const input = Object.freeze({ status, outcome: status === null ? 'network-rejection' : 'response', constructedBytes });
        const copied = copyRawAnalysisClient(input, kind);
        expect(copied).toEqual(input);
        expect(copied).not.toBe(input);
        expect(Object.keys(copied!)).toEqual(['status', 'outcome', 'constructedBytes']);
      }
    }
    expect(copyRawAnalysisClient({ status: 400, outcome: 'response', constructedBytes: 0 }, kind))
      .toEqual({ status: 400, outcome: 'response', constructedBytes: 0 });
    expect(copyRawAnalysisClient(null, kind)).toBeNull();
    const valid = { status: 413, outcome: 'response', constructedBytes: 512001 };
    const invalid: unknown[] = [
      undefined, false, [], 'private-analysis-observation-canary', Object.create(valid),
      { status: 413, outcome: 'response' }, { ...valid, extra: 'private-analysis-observation-canary' },
      { ...valid, [Symbol('private')]: 1 }, { ...valid, toJSON: hostile },
      { ...valid, status: 404 }, { ...valid, status: '413' }, { ...valid, status: undefined },
      { ...valid, outcome: 'timeout' }, { ...valid, outcome: { toString: hostile } },
      ...[-1, 512002, 0.5, NaN, Infinity, -Infinity, '512001', null, undefined, { valueOf: hostile }]
        .map(constructedBytes => ({ ...valid, constructedBytes })),
      ...Object.keys(valid).map(field => Object.defineProperty({ ...valid }, field, { get: hostile })),
      ...Object.keys(valid).map(field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field))),
      new Proxy(valid, { ownKeys: () => { throw new Error('private-analysis-observation-canary'); } }),
    ];
    const revoked = Proxy.revocable(valid, {}); revoked.revoke(); invalid.push(revoked.proxy);
    for (const input of invalid) expect(() => copyRawAnalysisClient(input, kind)).toThrow();
  }
  for (const input of [{ status: 200, outcome: 'response' }, { status: null, outcome: 'network-rejection' }]) {
    const copied = copyRawAnalysisClient(input);
    expect(copied).toEqual(input);
    expect(Object.keys(copied!)).toEqual(['status', 'outcome']);
  }
  expect(() => copyRawAnalysisClient({ status: 200, outcome: 'response', constructedBytes: 5 })).toThrow();
  const input = { status: 400, outcome: 'response', constructedBytes: 0 };
  const copied = copyRawAnalysisClient(input, 'oversized');
  input.constructedBytes = 5;
  expect(copied).toEqual({ status: 400, outcome: 'response', constructedBytes: 0 });
  expect(JSON.stringify(copied)).not.toContain('private-analysis-observation-canary');
  expect(invoked).toBe(0);
});
function analysisTarget(page: Page, api: AiFixture) {
  const target = new URL(api.uploadWireUrl), origin = new URL(page.url()).origin;
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash
    || origin !== `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5181}`) throw new Error('Fixture analysis target refused.');
  target.pathname = analysisPath;
  return { target, origin };
}
type DirectAnalysisKind = 'valid' | 'origin' | 'cookie' | 'empty-cookie' | 'key' | 'bearer' | 'owner' | 'request-id' |
  'draft-owner' | 'generation' | 'method' | 'query' | 'content-type' | 'empty' | 'over-limit' |
  'preflight' | 'preflight-headers' | 'preflight-method' | 'preflight-origin' | 'preflight-cookie';
async function sendDirectAnalysis(page: Page, api: AiFixture, kind: DirectAnalysisKind) {
  const { target, origin } = analysisTarget(page, api), ids = analysisIds();
  if (kind === 'query') target.search = '?unexpected=1';
  const preflight = kind.startsWith('preflight');
  const headers: Record<string, string> = preflight ? {
    origin: kind === 'preflight-origin' ? 'http://127.0.0.1:1' : origin,
    'access-control-request-method': kind === 'preflight-method' ? 'PUT' : 'POST',
    'access-control-request-headers': kind === 'preflight-headers' ? analysisHeaderNames + ', x-unapproved' : analysisHeaderNames,
  } : {
    origin: kind === 'origin' ? 'http://127.0.0.1:1' : origin, apikey: kind === 'key' ? 'wrong-key' : fixtureKey,
    authorization: kind === 'bearer' ? 'Bearer not-issued' : api.issuedWireAuthorization('a'),
    'content-type': kind === 'content-type' ? 'text/plain' : 'image/jpeg',
    'x-stillroom-request-id': kind === 'request-id' ? 'invalid' : kind === 'owner'
      ? ids.requestId.replace('c329a000', 'c329b000') : ids.requestId,
    'x-stillroom-draft-id': kind === 'draft-owner' ? ids.draftId.replace('c329a000', 'c329b000') : ids.draftId,
    'x-stillroom-generation': kind === 'generation' ? '2147483648' : ids.generation,
  };
  if (kind === 'cookie' || kind === 'preflight-cookie') headers.cookie = 'synthetic=1';
  if (kind === 'empty-cookie') headers.cookie = '';
  const body = Buffer.alloc(preflight || kind === 'empty' ? 0 : kind === 'over-limit' ? 512001 : 17, 197);
  return new Promise<{ status: number | null; outcome: string; allowOrigin?: string; allowHeaders?: string; credentials?: string }>((resolve) => {
    let outcome = 'incomplete', status: number | null = null;
    let cors: { allowOrigin?: string; allowHeaders?: string; credentials?: string } = {};
    const request = httpRequest(target, { method: preflight ? 'OPTIONS' : kind === 'method' ? 'PUT' : 'POST', headers, agent: false });
    const timer = setTimeout(() => { outcome = 'timeout'; request.destroy(); }, 5000);
    const fail = (error: NodeJS.ErrnoException) => {
      if (outcome !== 'timeout') outcome = ['EPIPE', 'ECONNRESET'].includes(error.code ?? '') ? 'reset' : 'unexpected-error';
      request.destroy();
    };
    request.on('error', fail);
    request.on('response', (response) => {
      status = response.statusCode ?? null;
      const header = (key: string) => typeof response.headers[key] === 'string' ? response.headers[key] : undefined;
      cors = { allowOrigin: header('access-control-allow-origin'), allowHeaders: header('access-control-allow-headers'),
        credentials: header('access-control-allow-credentials') };
      response.on('error', fail);
      response.once('end', () => { outcome = 'response'; request.destroy(); });
      response.resume();
    });
    let offset = 0;
    const write = () => {
      while (!request.destroyed && offset < body.length) {
        const end = Math.min(offset + 16384, body.length), ready = request.write(body.subarray(offset, end));
        offset = end;
        if (!ready) return;
      }
      if (!request.destroyed) request.end();
    };
    request.on('drain', write);
    request.once('close', () => { clearTimeout(timer); request.off('drain', write); resolve({ status, outcome, ...cors }); });
    write();
  });
}

test('analysis wire preserves actual browser binary bytes; length/hash oracle detects corruption and truncation', async ({ page }) => {
  const api = await aiFixture(page), before = storageCounts(api);
  try {
    const sent = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
    expect(await sendBrowserAnalysis(page, api, 'valid', sent)).toEqual({ status: 200, outcome: 'response' });
    expect(api.inputs).toHaveLength(1);
    assertAnalysisBytes(api.inputs[0]!, sent);
    const corrupted = Buffer.from(sent); corrupted[123] = corrupted[123]! ^ 1;
    expect(() => assertAnalysisBytes(api.inputs[0]!, corrupted)).toThrow();
    expect(() => assertAnalysisBytes(api.inputs[0]!, sent.subarray(1))).toThrow();
    expect(api.results.get(api.inputs[0]!.requestId)?.imageSha256).toBe(api.inputs[0]!.sha256);
    expect(api.analysisWire).toMatchObject({ posts: 1, callbacks: 1, receivedBytes: 4096, payloadBytes: 4096, rejected: 0 });
    expect(storageCounts(api)).toEqual(before);
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
  } finally { await assertAnalysisClosed(page, api); }
});
test('analysis browser wire admits exactly the one-byte and 512000-byte boundaries', async ({ page }, testInfo) => {
  let api: AiFixture | undefined;
  const results: [Awaited<ReturnType<typeof sendBrowserAnalysis>> | null, Awaited<ReturnType<typeof sendBrowserAnalysis>> | null] = [null, null];
  const evidence = rawAnalysisEvidence('boundaries');
  try {
    try {
      api = await aiFixture(page, 'en', true, undefined, true);
      if (!api.rawAnalysisObservation) throw new Error('Missing raw analysis observation');
      api.rawAnalysisObservation.boundaryDetail = { mode: 'boundary-framing-v1', overflow: false, evidenceError: false, receivers: [] };
      const before = storageCounts(api);
      for (const size of [1, 512000]) {
        const sent = Buffer.alloc(size, 197), index = size === 1 ? 0 : 1;
        results[index] = await sendBrowserAnalysis(page, api, 'valid', sent, true);
        expect(results[index]).toEqual({ status: 200, outcome: 'response', constructedBytes: size });
        assertAnalysisBytes(api.inputs.at(-1)!, sent);
      }
      expect(api.analysisWire).toMatchObject({ posts: 2, callbacks: 2, payloadBytes: 512001, rejected: 0 });
      expect(api.inputs).toHaveLength(2);
      expect(storageCounts(api)).toEqual(before);
      expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    } finally {
      snapshotRawAnalysis(evidence, api, results);
      if (api) {
        evidence.cleanupStarted = true;
        await assertAnalysisClosed(page, api);
        evidence.cleanupCompleted = true;
      }
    }
  } finally { emitRawAnalysis(evidence, testInfo); }
});
test('status admission proves the issued bearer separately from legacy decoded-owner request records', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const initial = { items: new Set<PlaywrightResponse>(), images: new Set<PlaywrightResponse>() };
  const observeInitial = (response: PlaywrightResponse) => {
    const url = new URL(response.url());
    if (response.request().method() !== 'GET' || url.origin !== 'http://127.0.0.1:54321'
      || url.searchParams.get('owner_id') !== `eq.${owners.a}`) return;
    if (url.pathname === '/rest/v1/items') initial.items.add(response);
    if (url.pathname === '/rest/v1/item_images') initial.images.add(response);
  };
  page.on('response', observeInitial);
  try {
    await page.goto('/'); await signIn(page);
    // Effect cleanup cancels the stale StrictMode load; settle the active metadata pair.
    await expect(page.locator('.empty-copy').getByRole('button', { name: messages['wardrobe.add'].en, exact: true })).toBeVisible();
    await expect.poll(() => [initial.items.size, initial.images.size]).toEqual([1, 1]);
    const responses = [...initial.items, ...initial.images];
    expect(responses.map((response) => response.status())).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.finished()))).toEqual([null, null]);
    expect([initial.items.size, initial.images.size]).toEqual([1, 1]);
  } finally { page.off('response', observeInitial); }
  const before = api.requests.length;
  for (const kind of ['valid', 'forged', 'nonempty', 'array'] as const) {
    const status = await page.evaluate(async ({ authorization, kind }) => {
      const response = await fetch('http://127.0.0.1:54321/rest/v1/rpc/ai_status', {
        method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(5000),
        headers: { authorization: kind === 'forged' ? authorization + '-unissued' : authorization,
          apikey: 'sb_publishable_browser_fixture_only', 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'array' ? [] : kind === 'nonempty' ? { unexpected: true } : {}),
      });
      return response.status;
    }, { authorization: api.issuedWireAuthorization('a'), kind });
    expect(status).toBe(kind === 'valid' ? 200 : 401);
  }
  expect(api.requests.slice(before)).toEqual(Array.from({ length: 4 }, () => ({
    method: 'POST', path: '/rest/v1/rpc/ai_status', owner: owners.a, ownerFilter: null,
  })));
  expect(api.statusProofs()).toEqual([
    { owner: owners.a, issuedBearer: true, emptyObject: true },
    { owner: null, issuedBearer: false, emptyObject: true },
    { owner: owners.a, issuedBearer: true, emptyObject: false },
    { owner: owners.a, issuedBearer: true, emptyObject: false },
  ]);
  expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
});
for (const kind of ['wrong-key', 'wrong-bearer', 'wrong-owner', 'request-id', 'draft-id', 'generation',
  'method', 'path', 'query', 'content-type', 'empty', 'oversized'] as const) {
  test(`analysis source forwarding refuses ${kind} without synthetic analysis or storage traffic`, async ({ page }, testInfo) => {
    let api: AiFixture | undefined;
    let result: Awaited<ReturnType<typeof sendBrowserAnalysis>> | null = null;
    const evidence = kind === 'oversized' ? rawAnalysisEvidence('oversized') : null;
    try {
      try {
        api = await aiFixture(page, 'en', true, undefined, kind === 'oversized');
        const before = storageCounts(api);
        result = await sendBrowserAnalysis(page, api, kind, undefined, kind === 'oversized');
        expect(result).toEqual({ status: kind === 'path' ? 404 : kind === 'empty' ? 400 : kind === 'oversized' ? 413 : 403,
          outcome: 'response', ...(kind === 'oversized' ? { constructedBytes: 512001 } : {}) });
        expect(api.analysisWire.callbacks).toBe(0);
        expect(api.analysisWire.peakBufferedBytes).toBeLessThanOrEqual(512000);
        if (!['empty', 'oversized'].includes(kind)) expect(api.analysisWire.forwarded).toBe(0);
        expect(api.inputs).toHaveLength(0); expect(api.results.size).toBe(0);
        expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
        expect(storageCounts(api)).toEqual(before);
        expect(api.uploadWire.listening).toBe(true);
      } finally {
        if (evidence) snapshotRawAnalysis(evidence, api, [result]);
        if (api) {
          if (evidence) evidence.cleanupStarted = true;
          await assertAnalysisClosed(page, api);
          if (evidence) evidence.cleanupCompleted = true;
        }
      }
    } finally { if (evidence) emitRawAnalysis(evidence, testInfo); }
  });
}
test('analysis receiver independently refuses invalid credentials/envelopes and bounds streamed bytes', async ({ page }) => {
  const api = await aiFixture(page), before = storageCounts(api);
  try {
    const preflight = await sendDirectAnalysis(page, api, 'preflight');
    expect(preflight).toEqual({ status: 204, outcome: 'response', allowOrigin: new URL(page.url()).origin,
      allowHeaders: analysisHeaderNames, credentials: undefined });
    for (const kind of ['origin', 'cookie', 'empty-cookie', 'key', 'bearer', 'owner', 'request-id', 'draft-owner', 'generation', 'method',
      'query', 'content-type', 'empty', 'over-limit', 'preflight-headers', 'preflight-method', 'preflight-origin', 'preflight-cookie'] as const) {
      const result = await sendDirectAnalysis(page, api, kind);
      expect(result.outcome).toBe('response');
      expect(result.status).toBe(kind === 'empty' ? 400 : kind === 'over-limit' ? 413 : 403);
      expect(api.uploadWire.listening).toBe(true);
    }
    expect(api.analysisWire).toMatchObject({ callbacks: 0, rejected: 18, preflights: 1, timedOut: 0, active: 0 });
    expect(api.analysisWire.receivedBytes).toBeGreaterThan(512000);
    expect(api.analysisWire.peakBufferedBytes).toBeLessThanOrEqual(512000);
    expect(api.inputs).toHaveLength(0); expect(api.results.size).toBe(0);
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    expect(storageCounts(api)).toEqual(before);
  } finally { await assertAnalysisClosed(page, api); }
});
test('expected analysis 403/502/504 responses leave the shared storage receiver alive', async ({ page }, testInfo) => {
  let api: AiFixture | undefined;
  const results: Array<Awaited<ReturnType<typeof sendBrowserAnalysis>> | null> = [null, null, null, null];
  const evidence = rawAnalysisEvidence('response-sequence');
  try {
    try {
      api = await aiFixture(page, 'en', true, undefined, true);
      if (api.rawAnalysisObservation) {
        api.rawAnalysisObservation.detail = { routePosts: 0, receiverPosts: 0, overflow: false, evidenceError: false,
          routes: [], receivers: [] };
      } else evidence.captureError = true;
      const before = storageCounts(api);
      api.consent.set(owners.a, false);
      results[0] = await sendBrowserAnalysis(page, api, 'valid', undefined, true);
      expect(results[0].status).toBe(403);
      api.consent.set(owners.a, true); api.mode('failed');
      results[1] = await sendBrowserAnalysis(page, api, 'valid', undefined, true);
      expect(results[1].status).toBe(502);
      api.mode('timeout');
      results[2] = await sendBrowserAnalysis(page, api, 'valid', undefined, true);
      expect(results[2].status).toBe(504);
      api.mode('ready');
      results[3] = await sendBrowserAnalysis(page, api, 'valid', undefined, true);
      expect(results[3].status).toBe(200);
      expect(api.analysisWire).toMatchObject({ posts: 4, callbacks: 4, rejected: 0, timedOut: 0,
        receivedBytes: 16384, payloadBytes: 16384 });
      expect(api.rawAnalysisObservation?.posts.map(({ receivedBytes, acceptedBytes }) => ({ receivedBytes, acceptedBytes })))
        .toEqual(Array.from({ length: 4 }, () => ({ receivedBytes: 4096, acceptedBytes: 4096 })));
      expect(api.uploadWire.listening).toBe(true);
      expect(storageCounts(api)).toEqual(before);
      expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    } finally {
      snapshotRawAnalysis(evidence, api, results);
      if (api) {
        evidence.cleanupStarted = true;
        await assertAnalysisClosed(page, api);
        evidence.cleanupCompleted = true;
      }
    }
  } finally { emitRawAnalysis(evidence, testInfo); }
});
for (const mode of ['parser-error', 'truncated', 'stalled'] as const) {
  test(`isolated analysis ${mode} never invokes the callback and cleans its receiver`, async ({ page }) => {
    const api = await aiFixture(page), { target, origin } = analysisTarget(page, api), ids = analysisIds();
    try {
      const started = performance.now();
      const outcome = await new Promise<string>((resolve) => {
        let result = 'incomplete';
        const socket = connect({ host: '127.0.0.1', port: Number(target.port) });
        const timer = setTimeout(() => { result = 'watchdog'; socket.destroy(); }, 6500);
        socket.on('error', (error: NodeJS.ErrnoException) => {
          result = ['EPIPE', 'ECONNRESET'].includes(error.code ?? '') ? 'reset' : 'unexpected-error';
        });
        socket.on('data', () => { result = 'response'; });
        socket.once('close', () => { clearTimeout(timer); resolve(result); });
        socket.once('connect', () => {
          if (mode === 'parser-error') { socket.end('INVALID HTTP\r\n\r\n'); return; }
          const headers = `POST ${analysisPath} HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: ${origin}\r\n` +
            `Authorization: ${api.issuedWireAuthorization('a')}\r\nApikey: ${fixtureKey}\r\nContent-Type: image/jpeg\r\n` +
            `X-Stillroom-Request-Id: ${ids.requestId}\r\nX-Stillroom-Draft-Id: ${ids.draftId}\r\n` +
            `X-Stillroom-Generation: 1\r\nContent-Length: 100\r\n\r\n`;
          if (mode === 'truncated') socket.end(headers + 'partial');
          else socket.write(headers);
        });
      });
      expect(['response', 'reset', 'incomplete']).toContain(outcome);
      expect(api.analysisWire.callbacks).toBe(0);
      expect(api.results.size).toBe(0); expect(api.inputs).toHaveLength(0);
      expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
      if (mode === 'stalled') {
        expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
        expect(performance.now() - started).toBeLessThan(6500);
        if (api.analysisWire.timedOut === 0) {
          // The unchanged HTTP server deadline can win the race with the analysis timer.
          await expect.poll(() => api.uploadWire.closed).toBe(true);
          expect(api.uploadWire.rejected).toBe(1);
        } else expect(api.analysisWire.timedOut).toBe(1);
      }
      if (mode === 'parser-error') {
        await expect.poll(() => api.uploadWire.closed).toBe(true);
        expect(api.uploadWire.rejected).toBe(1);
      } else expect(api.analysisWire.rejected).toBe(1);
    } finally { await assertAnalysisClosed(page, api); }
  });
}

for (const language of ['en', 'fi', 'sv'] as const) {
  test(`photo-first ${language}: one call, editable facts, unknown local text and explicit trusted Save`, async ({ page }) => {
    const api = await aiFixture(page, language);
    const claims: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/reserve_analyzed_item_save')) claims.push((request.postDataJSON() as { p_claim: unknown }).p_claim);
    });
    await addAiPhoto(page, api, language);
    await filled(page, language);
    await expect(page.locator('#item-title')).not.toHaveValue('');
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    await page.locator('#item-title').fill('My corrected title');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('');
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.items).toHaveLength(1);
    expect(api.items[0]!.field_provenance).toMatchObject({
      title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
      formality: { kind: 'ai_estimated', revision: 1 }, tags: { kind: 'unknown', revision: 1 },
    });
    expect(api.items[0]).toMatchObject({ tags: ['relaxed'], style_tags: [], sleeve_length: null, garment_length: null,
      upper_coverage: null, lower_coverage: null });
    expect(claims).toHaveLength(1);
    expect(Object.keys((claims[0] as { fields: object }).fields).sort()).toEqual(['category', 'colours', 'formality', 'material']);
    for (const hidden of ['sleeve_length', 'garment_length', 'upper_coverage', 'lower_coverage', 'style_tags']) {
      expect(Object.hasOwn(api.items[0]!.field_provenance as object, hidden)).toBe(false);
    }
    expect(api.images[0]!.alt_text).toBe('');
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(1);
    expect(api.requests.some((call) => /reserve_item_save|commit_image|finalize_item_save/.test(call.path))).toBe(false);
  });
}
test('language change never regenerates draft title, description, tags or analysis', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await filled(page);
  await page.locator('details.optional-details summary').click();
  const title = await page.locator('#item-title').inputValue(), description = await page.locator('#item-alt').inputValue();
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#item-title')).toHaveValue(title);
  await expect(page.locator('#item-alt')).toHaveValue(description);
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
});
for (const mode of ['pending', 'timeout'] as const) {
  test(`${mode}: automatic same-request status checks resolve without another POST`, async ({ page }) => {
    const api = await aiFixture(page); api.mode(mode);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/rest/v1/rpc/ai_analysis_status', async (route) => { await held; await route.fallback(); });
    await addAiPhoto(page, api);
    await expect(statusRegion(page).getByText(messages['aiC.filling'].en, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: messages['capture.save'].en, exact: true })).toBeDisabled();
    await page.locator('#item-title').fill('Retain my pending edit');
    release();
    await filled(page);
    await expect(page.locator('#item-title')).toHaveValue('Retain my pending edit');
    expect(posts(api)).toHaveLength(1);
    const checks = statusChecks(api);
    expect(checks.length).toBeGreaterThanOrEqual(1); expect(checks.length).toBeLessThanOrEqual(5);
    for (const check of checks) expect(check.body).toEqual({ p_request_id: (posts(api)[0]!.body as { requestId: string }).requestId });
    expect(api.items).toHaveLength(0);
  });
}
test('status checks stop after the deadline; Try again makes one more check and never a new analysis', async ({ page }) => {
  await page.clock.install();
  const api = await aiFixture(page); api.mode('pending');
  await page.route('**/rest/v1/rpc/ai_analysis_status', async (route) => {
    const body = route.request().postDataJSON() as { p_request_id: string };
    api.calls.push({ route: '/rest/v1/rpc/ai_analysis_status', body });
    await route.fulfill({ json: dispatched });
  });
  await addAiPhoto(page, api);
  await expect.poll(() => posts(api).length).toBe(1);
  await page.clock.runFor(31000);
  await expect(statusRegion(page).getByText(messages['aiC.stillWorking'].en, { exact: true })).toBeVisible();
  const after = statusChecks(api).length;
  expect(after).toBeGreaterThanOrEqual(1); expect(after).toBeLessThanOrEqual(5);
  await page.clock.runFor(35000);
  expect(statusChecks(api)).toHaveLength(after);
  await statusRegion(page).getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect.poll(() => statusChecks(api).length).toBe(after + 1);
  await expect(statusRegion(page).getByText(messages['aiC.stillWorking'].en, { exact: true })).toBeVisible();
  expect(posts(api)).toHaveLength(1);
  expect(new Set(statusChecks(api).map((call) => JSON.stringify(call.body))).size).toBe(1);
  expect(api.items).toHaveLength(0);
});
for (const action of ['new-analysis', 'manual'] as const) {
  test(`closed failed analysis: first explicit ${action} succeeds without a false cancellation warning`, async ({ page }) => {
    await page.clock.install();
    const api = await aiFixture(page); api.mode('failed');
    await addAiPhoto(page, api);
    await expect(statusRegion(page).getByText(messages['aiC.fillFailed'].en, { exact: true })).toBeVisible();
    await page.clock.runFor(35000);
    const first = api.calls.filter((call) => call.route.endsWith('/analyze-clothing'));
    expect(first).toHaveLength(1);
    expect(api.results.size).toBe(0);
    await page.locator('#item-title').fill('My retained manual title');
    if (action === 'new-analysis') {
      api.mode('ready');
      await statusRegion(page).getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
      await filled(page);
      const sent = posts(api);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body).not.toEqual(sent[0]!.body);
      expect(api.results.size).toBe(1);
      expect([...api.results.values()][0]!.generation).toBe(2);
    } else {
      expect(statusChecks(api)).toHaveLength(0);
      await page.locator('#item-category').selectOption('top');
      const discarded = page.waitForResponse((response) => response.url().endsWith('/ai_request_control'));
      await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
      expect(await (await discarded).json()).toEqual({ code: 'TERMINAL', reason: 'FAILED' });
      await expect(page.locator('#wardrobe-title')).toBeVisible();
      expect(posts(api)).toHaveLength(1);
      expect(api.results.size).toBe(0);
      expect(api.items[0]!.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
    }
    if (action === 'new-analysis') {
      await expect(page.locator('#item-title')).toHaveValue('My retained manual title');
      expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    } else expect(api.items[0]!.title).toBe('My retained manual title');
    await expect(page.getByText(messages['aiC.discardUnconfirmed'].en, { exact: true })).toHaveCount(0);
    expect(api.calls.filter((call) => call.route.endsWith('/ai_request_control'))).toHaveLength(1);
  });
}
test('unclear result and manual continuation never imply verified or automatically saved facts', async ({ page }) => {
  const api = await aiFixture(page); api.mode('unclear');
  await addAiPhoto(page, api);
  await expect(statusRegion(page).getByText(messages['aiC.fillFailed'].en, { exact: true })).toBeVisible();
  await expect(statusRegion(page).getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('');
  await page.locator('#item-title').fill('Manual garment');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]!.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
});
test('expiry retains fields but requires explicit unknown continuation, without another analysis', async ({ page }) => {
  await page.clock.install();
  const api = await aiFixture(page); api.ttl(2000);
  await addAiPhoto(page, api);
  await filled(page);
  const title = await page.locator('#item-title').inputValue();
  await page.clock.fastForward(2001);
  await expect(statusRegion(page).getByText(messages['aiC.needsCheck'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue(title);
  await expect(page.getByRole('button', { name: messages['capture.save'].en, exact: true })).toBeDisabled();
  expect(api.items).toHaveLength(0);
  await statusRegion(page).getByRole('button', { name: messages['aiC.keep'].en, exact: true }).click();
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.items[0]!.field_provenance).toMatchObject({ title: { kind: 'unknown', revision: 1 }, category: { kind: 'unknown', revision: 1 } });
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
});
test('owner change clears an in-flight draft and ignores its late completion', async ({ page }) => {
  const api = await aiFixture(page);
  let release!: () => void, reached = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/functions/v1/analyze-clothing', async (route) => {
    reached = true; await held;
    try { await route.fallback(); } catch { /* The old owner's request is deliberately aborted. */ }
  });
  await addAiPhoto(page, api);
  await expect.poll(() => reached).toBe(true);
  await page.locator('#item-title').fill('Old owner private draft');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('#capture-title')).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('');
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  release();
  await expect(page.getByText('Old owner private draft', { exact: true })).toHaveCount(0);
  expect(api.items).toHaveLength(0); expect(api.files.size).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
test('crop movement and cancellation do not analyze; an applied crop creates exactly one new generation', async ({ page }) => {
  const api = await aiFixture(page);
  await addAiPhoto(page, api);
  await filled(page);
  await page.locator('#item-title').fill('Retained manual title');
  await page.locator('#edit-photo').click(); await page.locator('#crop-width').fill('80');
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
  await page.getByRole('button', { name: messages['photo.cancelCrop'].en, exact: true }).click();
  await expect(page.locator('#edit-photo')).toBeVisible();
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
  await page.locator('#edit-photo').click(); await page.locator('#crop-width').fill('80'); await page.locator('#apply-crop').click();
  await expect.poll(() => api.calls.filter((call) => call.route.endsWith('/analyze-clothing')).length).toBe(2);
  await filled(page);
  await expect(page.locator('#item-title')).toHaveValue('Retained manual title');
  expect([...api.results.values()][0]!.generation).toBe(2);
});
test('late result after an implicit manual Save cannot overwrite edits or add AI facts', async ({ page }) => {
  await page.clock.install();
  const api = await aiFixture(page); api.mode('pending');
  let armed = false, reached = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/rest/v1/rpc/ai_analysis_status', async (route) => {
    if (!armed) {
      api.calls.push({ route: '/rest/v1/rpc/ai_analysis_status', body: route.request().postDataJSON() });
      await route.fulfill({ json: dispatched }); return;
    }
    const body = route.request().postDataJSON() as { p_request_id: string };
    api.calls.push({ route: '/rest/v1/rpc/ai_analysis_status', body });
    // Snapshot the valid ready reply now: the manual Save discards the request before this late reply is released.
    const late = { code: 'OK', status: 'ready', result: api.results.get(body.p_request_id),
      accounting: { basis: 'estimated', amountMicro: '1034', currency: 'USD' } };
    expect(late.result?.facts.outcome).toBe('ready');
    reached = true;
    await gate;
    await route.fulfill({ json: late }).catch(() => undefined);
  });
  await addAiPhoto(page, api);
  await expect.poll(() => posts(api).length).toBe(1);
  const requestId = (posts(api)[0]!.body as { requestId: string }).requestId;
  await page.clock.runFor(31000);
  await expect(statusRegion(page).getByText(messages['aiC.stillWorking'].en, { exact: true })).toBeVisible();
  const before = statusChecks(api).length;
  armed = true;
  await statusRegion(page).getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect.poll(() => reached).toBe(true);
  await page.locator('#item-title').fill('Manual after abort');
  await page.locator('#item-category').selectOption('bottom');
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  release();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await page.clock.runFor(35000);
  expect(posts(api)).toHaveLength(1);
  expect(statusChecks(api).length).toBeLessThanOrEqual(before + 1);
  for (const check of statusChecks(api)) expect(check.body).toEqual({ p_request_id: requestId });
  expect(api.items).toHaveLength(1);
  expect(api.items[0]).toMatchObject({ title: 'Manual after abort', category: 'bottom', colours: [], material: null });
  expect(api.items[0]!.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
  expect(api.requests.some((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toBe(false);
});
test('an accepted analysis whose response is lost keeps checking the same request and never resends', async ({ page }) => {
  const api = await aiFixture(page);
  // The request reaches the receiver unchanged (WebKit keeps the native upload body), which accepts and answers it;
  // the browser then loses that reply as a network error, with no timeout involved.
  await page.evaluate((path) => {
    const native = window.fetch.bind(window);
    const counter = window as unknown as { lostAnalysisReplies: number };
    counter.lostAnalysisReplies = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'POST' || new URL(url).pathname !== path) return native(input, init);
      const reply = await native(input, init);
      await reply.arrayBuffer().catch(() => undefined);
      counter.lostAnalysisReplies += 1;
      throw new TypeError('Failed to fetch');
    };
  }, analysisPath);
  await addAiPhoto(page, api);
  await filled(page);
  expect(await page.evaluate(() => (window as unknown as { lostAnalysisReplies: number }).lostAnalysisReplies)).toBe(1);
  expect(posts(api)).toHaveLength(1);
  const requestId = (posts(api)[0]!.body as { requestId: string }).requestId;
  expect(statusChecks(api).length).toBeGreaterThanOrEqual(1);
  expect(statusChecks(api).length).toBeLessThanOrEqual(5);
  for (const check of statusChecks(api)) expect(check.body).toEqual({ p_request_id: requestId });
  await expect(page.getByText(messages['aiC.fillFailed'].en, { exact: true })).toHaveCount(0);
  expect(api.items).toHaveLength(0);
});
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`provider-correct notices and accessibility ${language}: agreement is reset by changed policy`, async ({ page }) => {
    const api = await aiFixture(page, language, false);
    await page.getByRole('button', { name: messages['account.menu'][language] }).click();
    await page.getByRole('link', { name: messages['nav.settings'][language], exact: true }).click();
    await expect(page.getByText(messages['aiC.azureNotice'][language], { exact: true })).toBeVisible();
    await expect(page.getByText(messages['aiC.azureTrainingNotice'][language], { exact: true })).toBeVisible();
    await expect(page.getByText(messages['aiC.notice'][language], { exact: true })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const agreement = page.getByRole('checkbox', { name: messages['aiC.azureAgree'][language] });
    await agreement.check();
    await expect(page.getByRole('button', { name: messages['aiC.enable'][language], exact: true })).toBeEnabled();
    api.policy({ maxRequestMicro: '4097352' });
    await page.getByRole('button', { name: messages['aiC.checkConsent'][language], exact: true }).click();
    await expect(agreement).not.toBeChecked();
    await expect(page.getByRole('button', { name: messages['aiC.enable'][language], exact: true })).toBeDisabled();
    api.policy({ noticeRevision: 1, modelId: 'gemini-3.8-flash', executionManifestId: 'google-eu-3.8-v1' });
    await page.getByRole('button', { name: messages['aiC.checkConsent'][language], exact: true }).click();
    await expect(page.getByText(messages['aiC.notice'][language], { exact: true })).toBeVisible();
    await expect(page.getByText(messages['aiC.azureNotice'][language], { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: messages['aiC.enable'][language], exact: true })).toBeDisabled();
    api.policy({ modelId: 'unrecognized-model' });
    await page.getByRole('button', { name: messages['aiC.checkConsent'][language], exact: true }).click();
    await expect(page.getByText(messages['aiC.notice'][language], { exact: true })).toHaveCount(0);
    await expect(page.getByText(messages['aiC.azureNotice'][language], { exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: messages['aiC.agree'][language] })).toHaveCount(0);
    expect(api.calls.filter((call) => call.route.endsWith('/ai_set_consent'))).toHaveLength(0);
  });
  test(`committed first refusal and accessibility ${language}: preserve edits and require explicit unknown Save`, async ({ page }) => {
    const api = await aiFixture(page, language); await addAiPhoto(page, api, language);
    await filled(page, language);
    await page.locator('#item-title').fill('My retained title');
    const category = await page.locator('#item-category').inputValue();
    for (const [id, result] of api.results) api.results.set(id, { ...result, expiresAtMs: Date.now() - 1 });
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(statusRegion(page).getByText(messages['aiC.needsCheck'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#item-title')).toHaveValue('My retained title');
    await expect(page.locator('#item-category')).toHaveValue(category);
    await expect(page.getByRole('button', { name: messages['capture.save'][language], exact: true })).toBeDisabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
    await statusRegion(page).getByRole('button', { name: messages['aiC.keep'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.items).toHaveLength(1);
    expect(api.items[0]!.field_provenance).toMatchObject({
      title: { kind: 'user', revision: 1 }, category: { kind: 'unknown', revision: 1 },
    });
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
  });
}
for (const entry of ['refused analysis', 'inactive analysis'] as const) test(
  `${entry} then manual Save retries a lost finalizer ACK without writing ready objects`, async ({ page }) => {
  const enabled = entry === 'refused analysis';
  const api = await aiFixture(page, 'en', enabled, 'finalizer'); await addAiPhoto(page, api);
  if (enabled) await filled(page);
  else await expect(statusRegion(page).getByText(messages['aiC.off'].en, { exact: true })).toBeVisible();
  if (enabled) {
    await page.locator('#item-title').fill('Retained manual title');
    for (const [id, result] of api.results) api.results.set(id, { ...result, expiresAtMs: Date.now() - 1 });
  }
  let readyWrites = 0;
  await page.route('**/storage/v1/object/wardrobe/**', async (route) => {
    if (route.request().method() === 'POST' && api.images.some((image) => image.state === 'ready')) {
      readyWrites++;
      await route.fulfill({ status: 403, json: { statusCode: '403', error: 'Unauthorized' } });
    } else await route.fallback();
  });
  if (enabled) {
    await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(statusRegion(page).getByText(messages['aiC.needsCheck'].en, { exact: true })).toBeVisible();
  }
  expect(api.items).toHaveLength(0); expect(api.images).toHaveLength(0); expect(api.files.size).toBe(0);
  if (enabled) await statusRegion(page).getByRole('button', { name: messages['aiC.keep'].en, exact: true }).click();
  if (!enabled) {
    await page.locator('#item-title').fill('Retained manual title');
    await page.locator('#item-category').selectOption('top');
  }
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: messages['aiC.keep'].en, exact: true })).toHaveCount(0);
  const items = structuredClone(api.items), images = structuredClone(api.images);
  const requestsBefore = api.requests.length;
  expect(images).toHaveLength(1); expect(images[0]!.state).toBe('ready');
  await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(readyWrites).toBe(0);
  expect(api.requests.slice(requestsBefore).filter((call) => call.method === 'POST' && call.path.startsWith('/storage/v1/object/'))).toHaveLength(0);
  expect(api.requests.filter((call) => call.path.endsWith(enabled ? '/reserve_analyzed_item_save' : '/reserve_item_save'))).toHaveLength(enabled ? 3 : 2);
  expect(api.requests.filter((call) => call.path.endsWith(enabled ? '/finalize-analyzed-item' : '/finalize_item_save'))).toHaveLength(2);
  expect(api.items).toEqual(items); expect(api.images).toEqual(images);
  expect(api.items[0]).toMatchObject({ title: 'Retained manual title',
    field_provenance: { title: { kind: 'user', revision: 1 }, category: { kind: enabled ? 'unknown' : 'user', revision: 1 } } });
  expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(enabled ? 1 : 0);
});
for (const lost of ['reservation', 'finalizer'] as const) {
  test(`lost ${lost} ACK: Cancel never reserves; retry preserves the frozen Save`, async ({ page }) => {
    const api = await aiFixture(page, 'en', true, lost); await addAiPhoto(page, api);
    await filled(page);
    await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
    await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: messages['aiC.keep'].en, exact: true })).toHaveCount(0);
    const frozen = structuredClone(api.items);
    await page.getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
    const before = api.requests.length;
    await page.getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
    await expect(page.getByText(messages['aiC.leaveWarning'].en, { exact: true })).toBeVisible();
    expect(api.requests.slice(before).some((call) => call.path.includes('reserve'))).toBe(false);
    expect(api.requests.slice(before).filter((call) => call.path.includes('cancel_analyzed'))).toHaveLength(lost === 'reservation' ? 0 : 1);
    await page.getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
    await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
    expect(api.items).toEqual(frozen);
    expect(api.images[0]!.state).toBe('ready');
    expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(2);
  });
}
test('a reserved incomplete Save can be cancelled, without a second reservation or a deletion claim', async ({ page }) => {
  const api = await aiFixture(page); await addAiPhoto(page, api);
  await filled(page);
  await page.route('**/functions/v1/finalize-analyzed-item', (route) => route.abort('failed'));
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect(page.getByRole('button', { name: messages['common.retry'].en, exact: true })).toBeVisible();
  await page.getByRole('button', { name: messages['common.cancel'].en, exact: true }).click();
  await page.getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(api.images[0]!.state).toBe('pending');
  expect(api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save'))).toHaveLength(1);
  expect(api.requests.filter((call) => call.path.endsWith('/cancel_analyzed_item_save'))).toHaveLength(1);
});
test('Save excludes Cancel until its finalizer has settled', async ({ page }) => {
  const api = await aiFixture(page); await addAiPhoto(page, api);
  await filled(page);
  let release!: () => void, reached = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/functions/v1/finalize-analyzed-item', async (route) => { reached = true; await held; await route.fallback(); });
  await page.getByRole('button', { name: messages['capture.save'].en, exact: true }).click();
  await expect.poll(() => reached).toBe(true);
  await expect(page.getByRole('button', { name: messages['common.cancel'].en, exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.requests.some((call) => call.path.endsWith('/cancel_analyzed_item_save'))).toBe(false);
  release(); await expect(page.locator('#wardrobe-title')).toBeVisible();
});
test.describe('bounded C visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`consent and analyzed draft ${selected.suffix}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== selected.project);
      const language: Language = selected.language, api = await aiFixture(page, language);
      await page.setViewportSize({ width: selected.width, height: 900 });
      const directory = path.resolve('test-results/i29-photo-first-visual');
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      const capture = async (name: 'consent' | 'analyzed-draft') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await page.getByRole('button', { name: messages['account.menu'][language] }).click();
      await page.getByRole('link', { name: messages['nav.settings'][language], exact: true }).click();
      await expect(page.getByText(messages['aiC.enabled'][language], { exact: true })).toBeVisible();
      await capture('consent');
      await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
      await addAiPhoto(page, api, language);
      await filled(page, language);
      await page.locator('details.optional-details summary').click();
      await capture('analyzed-draft');
      expect(api.calls.filter((call) => call.route.endsWith('/analyze-clothing'))).toHaveLength(1);
      expect(api.items).toHaveLength(0);
    });
  }
});
