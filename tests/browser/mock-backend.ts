// Browser contract fixtures only. Real Auth/Storage authorization is a separate blocking suite.
import type { Page, Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Language } from '../../src/i18n';
import { garmentFields, garmentPayload, parseGarmentValues, sameValue } from '../../src/domain/garment-fields';
import { parseFieldProvenance, provenanceFields } from '../../src/domain/attribute-provenance';
import { isRecord, isUuid } from '../../src/domain/wardrobe';
import { rawColumns } from '../../src/domain/export-format';
import type { ImageChangeReceipt } from '../../src/domain/image-replacement';
import type { DeletionOperation } from '../../src/domain/item-lifecycle';
import { wardrobeTargetDeleteRoute } from '../../src/data/storage-delete';

export const owners = {
  a: '10000000-0000-4000-8000-000000000001',
  b: '10000000-0000-4000-8000-000000000002',
};
type JsonRow = Record<string, unknown>;
export type FeedbackFault = { method: 'POST' | 'DELETE' | 'READ'; commit: boolean; fail: number | 'abort' };
const itemDefaults = () => ({
  subcategory: null, colours: [], pattern: null, sleeve_length: null, garment_length: null,
  brand: null, size_label: null, material: null, seasons: [],
  formality: null, warmth: null, min_temp: null, max_temp: null, rain_rating: null, windproof: null,
  upper_coverage: null, lower_coverage: null, style_tags: [], tags: [], purchase_date: null,
  purchase_price: null, currency: 'EUR', notes: '', favourite: false, availability: 'ready',
  lifecycle: 'active', wear_more: false, exclude_suggestions: false, field_provenance: {},
});
const storagePrefix = '/storage/v1/object/wardrobe/';
const fixtureKey = 'sb_publishable_browser_fixture_only';
const uploadHeaders = ['authorization', 'apikey', 'content-type', 'x-upsert', 'x-client-info'];
const uploadLimit = 1024 * 1024;
export const analysisPath = '/functions/v1/analyze-clothing';
const analysisHeaders = ['authorization', 'apikey', 'content-type', 'x-stillroom-request-id', 'x-stillroom-draft-id', 'x-stillroom-generation'];
export type AnalysisInput = { owner: string; requestId: string; draftId: string; generation: number; bytes: Buffer };
type AnalysisHandler = (input: AnalysisInput) => { body: JsonRow; status: number };
type StatusProof = { owner: string | null; issuedBearer: boolean; emptyObject: boolean };

type RawAnalysisGuard = 'end-identity' | 'end-incomplete' | 'end-empty' | 'end-closing' |
  'aborted' | 'request-error' | 'close-before-terminal' | 'timeout' | 'body-limit' | 'admission' | 'callback-error';
type RawAnalysisRejection = Readonly<{
  guard: RawAnalysisGuard; ordinal: number; forwardedAtReceipt: number;
  receivedBytes: number; acceptedBytes: number;
  identityPresent: boolean; complete: boolean; readableEnded: boolean; aborted: boolean; closing: boolean;
}>;
type RawAnalysisPost = {
  ordinal: number; forwardedAtReceipt: number; receivedBytes: number; acceptedBytes: number;
  writeStatus: ReturnType<typeof rawAnalysisStatus> | null;
  writeResponseDestroyed: boolean | null; writeResponseWritableFinished: boolean | null;
  endCallbackRan: boolean; postTerminalRejects: number; firstPostTerminalReject: RawAnalysisRejection | null;
};
export type RawAnalysisObservation = {
  postCount: number; overflow: boolean; evidenceError: boolean; posts: RawAnalysisPost[];
  firstAttemptedPost400: RawAnalysisRejection | null;
  detail?: {
    routePosts: number; receiverPosts: number; overflow: boolean; evidenceError: boolean;
    routes: Array<{ ordinal: number; body: 'absent' | 'empty' | '4096' | 'other' }>;
    receivers: Array<{
      ordinal: number; contentLength: 'absent' | 'zero' | '4096' | 'other' | 'invalid';
      transferEncoding: 'absent' | 'chunked' | 'other'; complete: boolean; readableEnded: boolean;
      readableLength: 'zero' | '4096' | 'other' | 'invalid';
    }>;
  };
  boundaryDetail?: {
    mode: 'boundary-framing-v1'; overflow: boolean; evidenceError: boolean;
    receivers: Array<{
      ordinal: 1 | 2; contentLength: 'absent' | 'zero' | '1' | '512000' | 'other' | 'invalid';
      transferEncoding: 'absent' | 'chunked' | 'other'; complete: boolean; readableEnded: boolean;
      readableLength: 'zero' | '1' | '512000' | 'other' | 'invalid';
    }>;
  };
};
function rawAnalysisStatus(status: number) {
  switch (status) {
    case 200: case 202: case 204: case 400: case 403: case 408: case 413: case 500: case 502: case 504: return status;
    default: return 'unexpected' as const;
  }
}
function rawAnalysisRejection(guard: RawAnalysisGuard, post: RawAnalysisPost, request: IncomingMessage,
  identityPresent: boolean, closing: boolean): RawAnalysisRejection {
  return { guard, ordinal: post.ordinal, forwardedAtReceipt: post.forwardedAtReceipt,
    receivedBytes: post.receivedBytes, acceptedBytes: post.acceptedBytes, identityPresent,
    complete: request.complete, readableEnded: request.readableEnded, aborted: request.aborted, closing };
}

export const wireStages = [
  'none', 'route-auth', 'route-owner', 'route-existing', 'route-reservation-credentials',
  'receiver-reservation-origin', 'receiver-preflight', 'receiver-method-credentials',
  'receiver-content-type', 'receiver-body-read', 'receiver-body-limit', 'receiver-envelope',
  'receiver-form-parse', 'receiver-form-fields', 'receiver-file-read', 'receiver-store',
  'receiver-timeout', 'receiver-client-error',
] as const;
export type WireStage = typeof wireStages[number];
export type WireBackend = 'first' | 'second';
type WireFieldFailure = 'none' | 'file-count' | 'file-kind' | 'file-type' | 'file-empty' |
  'cache-count' | 'cache-value' | 'metadata-count' | 'metadata-kind' | 'extra-key';
type WireReceiverFacts = {
  fieldFailure: WireFieldFailure | null;
  boundaryLength: number | null; bodyTrailer: 'crlf' | 'bare' | 'other' | null;
  parsedFileSize: number | null; bodyHighByte: 'present' | 'absent' | null;
  rawBodyBytes: number | null; streamCompletion: 'complete' | 'incomplete' | null;
};
type WireDiagnostic = {
  backend: WireBackend; routePosts: number; receiverPosts: number; success: number;
  routeRejected: number; receiverRejected: number; routeStage: WireStage; receiverStage: WireStage;
  rejections: Record<WireStage, number>;
  // Facts describe the last completed/rejected receiver request; counters remain cumulative.
  receiverFacts: WireReceiverFacts | null;
  firstPost400Attempt: {
    receiverPostOrdinal: number; routePostsAtReceipt: number; stage: WireStage; facts: WireReceiverFacts | null;
  } | null;
};

async function uploadReceiver(page: Page, items: JsonRow[], images: JsonRow[], files: Map<string, Buffer>, tokens: Map<string, string>,
  decorateWireResponses: boolean, diagnostic?: WireDiagnostic, analysis?: AnalysisHandler, rawObservation?: RawAnalysisObservation) {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? 5181);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid browser test port.');
  const origin = `http://127.0.0.1:${port}`;
  const cors = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': uploadHeaders.join(', '),
    vary: 'Origin',
  };
  const sockets = new Set<Socket>();
  const lifetime = new AbortController();
  const state = {
    get listening() { return server.listening; },
    get connections() { return sockets.size; },
    closed: false, posts: 0, preflights: 0, rejected: 0, receivedBytes: 0, payloadBytes: 0, peakBufferedBytes: 0,
  };
  const analysisState = { forwarded: 0, routeRejected: 0, posts: 0, preflights: 0, rejected: 0, callbacks: 0,
    receivedBytes: 0, payloadBytes: 0, peakBufferedBytes: 0, active: 0, timedOut: 0 };
  const analysisCors = {
    'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': analysisHeaders.join(', '), vary: 'Origin',
  };
  const analysisPreflightAllowed = (headers: IncomingHttpHeaders) => {
    const names = typeof headers['access-control-request-headers'] === 'string'
      ? headers['access-control-request-headers'].split(',').map((name) => name.trim().toLowerCase()).sort() : [];
    return headers.origin === origin && headers.cookie === undefined && headers['access-control-request-method'] === 'POST'
      && sameValue(names, [...analysisHeaders].sort());
  };
  const analysisIdentity = (headers: IncomingHttpHeaders) => {
    const owner = tokens.get(headers.authorization ?? '');
    const prefix = owner === owners.a ? 'c329a000-' : owner === owners.b ? 'c329b000-' : null;
    const requestId = headers['x-stillroom-request-id'], draftId = headers['x-stillroom-draft-id'];
    const generation = headers['x-stillroom-generation'];
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!owner || !prefix || headers.origin !== origin || headers.cookie !== undefined || headers.apikey !== fixtureKey
      || headers['content-type'] !== 'image/jpeg'
      || typeof requestId !== 'string' || !id.test(requestId) || !requestId.startsWith(prefix)
      || typeof draftId !== 'string' || !id.test(draftId) || !draftId.startsWith(prefix)
      || typeof generation !== 'string' || !/^[1-9][0-9]{0,9}$/.test(generation)
      || Number(generation) > 2147483647) return null;
    return { owner, requestId, draftId, generation: Number(generation) };
  };
  const reservedOwner = (pathname: string) => {
    if (!pathname.startsWith(storagePrefix)) return undefined;
    const path = pathname.slice(storagePrefix.length);
    const [owner, item, image, variant, extra] = path.split('/');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (extra !== undefined || ![owners.a, owners.b].includes(owner ?? '') ||
      !uuid.test(item ?? '') || !uuid.test(image ?? '') || !['main.jpg', 'thumb.jpg'].includes(variant ?? '')) return undefined;
    return items.some((row) => row.owner_id === owner && row.id === item) &&
      images.some((row) => row.owner_id === owner && row.item_id === item && row.id === image &&
        (row.main_path === path || row.thumb_path === path)) ? owner : undefined;
  };
  const preflightAllowed = (headers: IncomingHttpHeaders) => headers.origin === origin && !headers.cookie &&
    headers['access-control-request-method'] === 'POST' &&
    typeof headers['access-control-request-headers'] === 'string' &&
    headers['access-control-request-headers'].split(',').every((name) => uploadHeaders.includes(name.trim().toLowerCase()));
  const credentialsAllowed = (headers: IncomingHttpHeaders, owner: string) => headers.origin === origin && !headers.cookie &&
    headers.apikey === fixtureKey && tokens.get(headers.authorization ?? '') === owner && headers['x-upsert'] === 'false';
  const recordRejection = (stage: WireStage, facts: WireReceiverFacts | null = null) => {
    if (diagnostic) {
      diagnostic.receiverRejected++;
      diagnostic.receiverStage = stage;
      diagnostic.rejections[stage]++;
      diagnostic.receiverFacts = facts ? { ...facts } : null;
    }
  };
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    if (analysis && (request.url ?? '').split('?')[0] === analysisPath) {
      analysisState.active++;
      let observedPost: RawAnalysisPost | undefined;
      if (rawObservation && request.method === 'POST') {
        rawObservation.postCount++;
        if (rawObservation.posts.length < 4) {
          observedPost = { ordinal: rawObservation.postCount, forwardedAtReceipt: analysisState.forwarded,
            receivedBytes: 0, acceptedBytes: 0, writeStatus: null,
            writeResponseDestroyed: null, writeResponseWritableFinished: null, endCallbackRan: false,
            postTerminalRejects: 0, firstPostTerminalReject: null };
          rawObservation.posts.push(observedPost);
        } else { rawObservation.overflow = true; rawObservation.evidenceError = true; }
      }
      const boundaryDetail = rawObservation?.boundaryDetail;
      if (boundaryDetail?.mode === 'boundary-framing-v1' && request.method === 'POST' && observedPost) {
        if ((observedPost.ordinal !== 1 && observedPost.ordinal !== 2) || boundaryDetail.receivers.length >= 2) {
          boundaryDetail.overflow = true; boundaryDetail.evidenceError = true;
        } else {
          try {
            const length = request.headers['content-length'], transfer = request.headers['transfer-encoding'];
            const validLength = typeof length === 'string' && /^[0-9]+$/.test(length)
              && Number.isSafeInteger(Number(length)) && Number(length) >= 0;
            const readable = request.readableLength;
            boundaryDetail.receivers.push({
              ordinal: observedPost.ordinal,
              contentLength: length === undefined ? 'absent' : !validLength ? 'invalid'
                : Number(length) === 0 ? 'zero' : Number(length) === 1 ? '1' : Number(length) === 512000 ? '512000' : 'other',
              transferEncoding: transfer === undefined ? 'absent' : transfer === 'chunked' ? 'chunked' : 'other',
              complete: request.complete, readableEnded: request.readableEnded,
              readableLength: typeof readable !== 'number' || !Number.isSafeInteger(readable) || readable < 0 ? 'invalid'
                : readable === 0 ? 'zero' : readable === 1 ? '1' : readable === 512000 ? '512000' : 'other',
            });
          } catch { boundaryDetail.evidenceError = true; }
        }
      }
      let terminal = false;
      const timer = setTimeout(() => {
        analysisState.timedOut++;
        reject(408, 'timeout');
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('aborted', onAborted);
        request.off('error', onError);
      };
      const finish = (body: JsonRow, status: number, destroyRequest = false) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        analysisState.active--;
        if (!response.destroyed) {
          response.writeHead(status, { ...analysisCors, 'content-type': 'application/json' });
          if (observedPost) {
            observedPost.writeStatus = rawAnalysisStatus(status);
            observedPost.writeResponseDestroyed = response.destroyed;
            observedPost.writeResponseWritableFinished = response.writableFinished;
            if (observedPost.writeStatus === 'unexpected' && rawObservation) rawObservation.evidenceError = true;
          }
          response.end(JSON.stringify(body), () => {
            if (observedPost) observedPost.endCallbackRan = true;
            if (destroyRequest) request.destroy();
          });
        } else request.destroy();
      };
      const reject = (status: number, guard: RawAnalysisGuard) => {
        if (terminal) {
          if (observedPost) {
            observedPost.postTerminalRejects++;
            observedPost.firstPostTerminalReject ??= rawAnalysisRejection(guard, observedPost, request, identity !== null, Boolean(closing));
          }
          return;
        }
        if (rawObservation && observedPost && status === 400 && !response.destroyed && rawObservation.firstAttemptedPost400 === null) {
          rawObservation.firstAttemptedPost400 = rawAnalysisRejection(guard, observedPost, request, identity !== null, Boolean(closing));
        }
        analysisState.rejected++;
        finish({ code: 'INVALID_INPUT' }, status, true);
      };
      const onAborted = () => reject(400, 'aborted');
      const onError = () => reject(400, 'request-error');
      const chunks: Buffer[] = [];
      let length = 0;
      const onData = (chunk: Buffer) => {
        if (terminal) return;
        analysisState.receivedBytes += chunk.length;
        if (observedPost) observedPost.receivedBytes += chunk.length;
        if (chunk.length > 512000 - length) { reject(413, 'body-limit'); return; }
        length += chunk.length;
        if (observedPost) observedPost.acceptedBytes = length;
        chunks.push(chunk);
        analysisState.peakBufferedBytes = Math.max(analysisState.peakBufferedBytes, length);
      };
      const identity = analysisIdentity(request.headers);
      const onEnd = () => {
        if (terminal) return;
        if (!identity || !request.complete || length < 1 || closing) {
          reject(400, !identity ? 'end-identity' : !request.complete ? 'end-incomplete' : length < 1 ? 'end-empty' : 'end-closing');
          return;
        }
        const bytes = Buffer.concat(chunks, length);
        try {
          analysisState.callbacks++;
          const reply = analysis({ ...identity, bytes });
          analysisState.payloadBytes += length;
          finish(reply.body, reply.status);
        } catch {
          reject(500, 'callback-error');
        }
      };
      request.once('close', () => {
        if (!terminal) reject(400, 'close-before-terminal');
        cleanup();
      });
      request.on('error', onError);
      request.once('aborted', onAborted);
      const address = server.address();
      if (request.url !== analysisPath || !address || typeof address === 'string'
        || request.headers.host !== `127.0.0.1:${address.port}`) { reject(403, 'admission'); return; }
      if (request.method === 'OPTIONS') {
        if (!analysisPreflightAllowed(request.headers)) { reject(403, 'admission'); return; }
        analysisState.preflights++;
        finish({}, 204);
        return;
      }
      if (request.method !== 'POST' || !identity) { reject(403, 'admission'); return; }
      analysisState.posts++;
      const detail = rawObservation?.detail;
      if (detail) {
        if (detail.receiverPosts >= 4) { detail.overflow = true; detail.evidenceError = true; }
        else {
          const ordinal = ++detail.receiverPosts;
          try {
            const contentLength = request.headers['content-length'], transferEncoding = request.headers['transfer-encoding'];
            const length = typeof contentLength === 'string' && /^[0-9]+$/.test(contentLength) ? Number(contentLength) : NaN;
            const readableLength = request.readableLength;
            detail.receivers.push({ ordinal,
              contentLength: contentLength === undefined ? 'absent' : !Number.isSafeInteger(length) || length < 0
                ? 'invalid' : length === 0 ? 'zero' : length === 4096 ? '4096' : 'other',
              transferEncoding: transferEncoding === undefined ? 'absent' : transferEncoding === 'chunked' ? 'chunked' : 'other',
              complete: request.complete, readableEnded: request.readableEnded,
              readableLength: !Number.isSafeInteger(readableLength) || readableLength < 0 ? 'invalid'
                : readableLength === 0 ? 'zero' : readableLength === 4096 ? '4096' : 'other' });
          } catch { detail.evidenceError = true; }
        }
      }
      request.on('data', onData);
      request.once('end', onEnd);
      return;
    }
    if (diagnostic && request.method === 'POST') diagnostic.receiverPosts++;
    const postAtReceipt = diagnostic && request.method === 'POST'
      ? { receiverPostOrdinal: diagnostic.receiverPosts, routePostsAtReceipt: diagnostic.routePosts } : null;
    const facts: WireReceiverFacts | null = diagnostic ? {
      fieldFailure: null, boundaryLength: null, bodyTrailer: null, parsedFileSize: null, bodyHighByte: null,
      rawBodyBytes: null, streamCompletion: null,
    } : null;
    let stage: WireStage = 'receiver-reservation-origin';
    const timer = setTimeout(() => { state.rejected++; recordRejection('receiver-timeout', facts); void close(); }, 5000);
    const finish = (body: JsonRow, status = 200, responseStage: WireStage = 'none') => {
      response.writeHead(status, { ...cors, 'content-type': 'application/json', ...(status >= 400 ? { connection: 'close' } : {}) });
      response.end(JSON.stringify(decorateWireResponses && diagnostic ? { ...body, wireBackend: diagnostic.backend, wireStage: responseStage } : body),
        () => { if (status >= 400) void close(); });
    };
    response.once('close', () => clearTimeout(timer));
    void (async () => {
      const pathname = request.url ?? '';
      const owner = reservedOwner(pathname);
      if (!owner || request.headers.origin !== origin || request.headers.cookie) throw new Error('Fixture upload rejected.');
      if (request.method === 'OPTIONS') {
        stage = 'receiver-preflight';
        if (!preflightAllowed(request.headers)) throw new Error('Fixture upload rejected.');
        state.preflights++;
        if (diagnostic) { diagnostic.receiverStage = 'none'; diagnostic.receiverFacts = facts ? { ...facts } : null; }
        response.writeHead(204, cors).end();
        return;
      }
      stage = 'receiver-method-credentials';
      if (request.method !== 'POST' || !credentialsAllowed(request.headers, owner)) {
        throw new Error('Fixture upload rejected.');
      }
      state.posts++;
      const contentType = request.headers['content-type'] ?? '';
      const boundary = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'-]{1,70})"|([A-Za-z0-9'-]{1,70}))$/i.exec(contentType);
      stage = 'receiver-content-type';
      if (!boundary) throw new Error('Fixture upload rejected.');
      if (facts) facts.boundaryLength = (boundary[1] ?? boundary[2])!.length;
      const chunks: Buffer[] = [];
      let length = 0;
      stage = 'receiver-body-read';
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        state.receivedBytes += bytes.length;
        if (bytes.length > uploadLimit - length) { stage = 'receiver-body-limit'; throw new Error('Fixture upload rejected.'); }
        length += bytes.length;
        chunks.push(bytes);
        state.peakBufferedBytes = Math.max(state.peakBufferedBytes, length);
      }
      const body = Buffer.concat(chunks, length);
      if (facts) {
        facts.rawBodyBytes = body.length;
        facts.streamCompletion = request.complete ? 'complete' : 'incomplete';
      }
      const delimiter = `--${boundary[1] ?? boundary[2]}`;
      const ending = Buffer.from(`\r\n${delimiter}--`);
      stage = 'receiver-envelope';
      if (facts) {
        facts.bodyTrailer = body.subarray(-ending.length).equals(ending) ? 'bare' :
          body.subarray(-ending.length - 2).equals(Buffer.concat([ending, Buffer.from('\r\n')])) ? 'crlf' : 'other';
        facts.bodyHighByte = body.some((byte) => byte >= 0x80) ? 'present' : 'absent';
      }
      if (!body.subarray(0, delimiter.length + 2).equals(Buffer.from(`${delimiter}\r\n`)) ||
        !(body.subarray(-ending.length).equals(ending) || body.subarray(-ending.length - 2).equals(Buffer.concat([ending, Buffer.from('\r\n')])))) {
        throw new Error('Fixture upload rejected.');
      }
      stage = 'receiver-form-parse';
      const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
      const file = form.get('');
      if (facts) facts.parsedFileSize = file instanceof Blob ? file.size : -1;
      stage = 'receiver-form-fields';
      function rejectField(reason: WireFieldFailure): never {
        if (facts) facts.fieldFailure = reason;
        throw new Error('Fixture upload rejected.');
      }
      if (form.getAll('').length !== 1) rejectField('file-count');
      if (!(file instanceof Blob)) rejectField('file-kind');
      if (file.type !== 'image/jpeg') rejectField('file-type');
      if (!file.size) rejectField('file-empty');
      if (form.getAll('cacheControl').length !== 1) rejectField('cache-count');
      if (form.get('cacheControl') !== '0') rejectField('cache-value');
      if (form.getAll('metadata').length > 1) rejectField('metadata-count');
      if (form.has('metadata') && typeof form.get('metadata') !== 'string') rejectField('metadata-kind');
      if ([...form.keys()].some((key) => !['', 'cacheControl', 'metadata'].includes(key))) rejectField('extra-key');
      if (facts) facts.fieldFailure = 'none';
      stage = 'receiver-file-read';
      const bytes = Buffer.from(await file.arrayBuffer());
      const path = pathname.slice(storagePrefix.length);
      stage = 'receiver-store';
      if (closing || files.has(path)) throw new Error('Fixture upload rejected.');
      files.set(path, bytes);
      state.payloadBytes += bytes.length;
      if (diagnostic) {
        diagnostic.success++; diagnostic.receiverStage = 'none';
        diagnostic.receiverFacts = facts ? { ...facts } : null;
      }
      finish({ Id: 'fixture', Key: `wardrobe/${path}` });
    })().catch(() => {
      state.rejected++;
      recordRejection(stage, facts);
      if (!response.destroyed && !response.headersSent) {
        if (diagnostic && postAtReceipt && diagnostic.firstPost400Attempt === null) {
          diagnostic.firstPost400Attempt = { ...postAtReceipt, stage, facts: facts ? { ...facts } : null };
        }
        finish({ message: 'Fixture upload rejected.' }, 400, stage);
      } else void close();
    });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    page.off('close', onPageClose);
    lifetime.abort();
    server.close(() => { state.closed = true; resolve(); });
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  });
  const onPageClose = () => { void close(); };
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.on('error', onPageClose);
  server.on('clientError', (_error, socket) => { state.rejected++; recordRejection('receiver-client-error'); socket.destroy(); void close(); });
  page.once('close', onPageClose);
  try {
    if (page.isClosed()) throw new Error('Fixture page closed.');
    await new Promise<void>((resolve, reject) => {
      const closed = () => reject(new Error('Fixture receiver unavailable.'));
      server.once('error', reject);
      server.once('close', closed);
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }, () => {
        server.off('error', reject);
        server.off('close', closed);
        resolve();
      });
    });
    if (page.isClosed() || closing) throw new Error('Fixture page closed.');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture receiver unavailable.');
    return { url: `http://127.0.0.1:${address.port}`, state, cors, reservedOwner, preflightAllowed, credentialsAllowed, close,
      analysisState, analysisCors, analysisPreflightAllowed, analysisIdentity };
  } catch {
    await close();
    throw new Error('Fixture receiver unavailable.');
  }
}
export type MockOptions = {
  imageChangeLoss?: 'reservation' | 'finalizer' | 'cancel';
  lifecycleLoss?: 'begin' | 'delete' | 'finish' | 'change';
  initialLanguage?: Language | null; failCommitOnce?: boolean; failLanguageSave?: boolean;
  weather?: Partial<Record<'a' | 'b', JsonRow>>;
  loseFinalizeReplyOnce?: boolean;
  loseAnalyzedReserveReplyOnce?: boolean;
  recoverStatus?: number; updateStatus?: number; logoutStatus?: number; recoveryUser?: string;
  wireDiagnostic?: WireBackend;
  wireObservation?: WireBackend;
  aiResults?: Map<string, import('../../src/domain/ai-analysis').AiResult>;
  analysis?: AnalysisHandler;
  observeRawAnalysis?: boolean;
};
export function recoveryHash(owner = owners.a, seconds = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: owner, aud: 'authenticated', role: 'authenticated', exp: expires }), 'c2lnbmF0dXJl'].join('.');
  return '#' + new URLSearchParams({ access_token: token, refresh_token: 'unused-opaque-fixture',
    expires_at: String(expires), expires_in: String(Math.max(1, seconds)), token_type: 'bearer', type: 'recovery', sb: '' });
}
export async function mockBackend(page: Page, options: MockOptions = {}) {
  const profiles: Record<string, JsonRow> = {
    [owners.a]: { owner_id: owners.a, display_name: 'Alex', ui_language: options.initialLanguage ?? null, timezone: 'Europe/Helsinki', currency: 'EUR', version: 1,
      weather_enabled: false, weather_city: null, latitude: null, longitude: null, ...options.weather?.a },
    [owners.b]: { owner_id: owners.b, display_name: 'Robin', ui_language: 'sv', timezone: 'Europe/Helsinki', currency: 'EUR', version: 1,
      weather_enabled: false, weather_city: null, latitude: null, longitude: null, ...options.weather?.b },
  };
  const items: JsonRow[] = [];
  const wearEvents: JsonRow[] = [];
  const wearLinks: JsonRow[] = [];
  const outfits: JsonRow[] = [];
  const outfitItems: JsonRow[] = [];
  const combinationRules: JsonRow[] = [];
  const suggestionFeedback: JsonRow[] = [];
  // Scripts feedback faults in order (a committed write can still lose its reply) and can hold list reads after taking their snapshot.
  const feedbackControl: { faults: FeedbackFault[]; hold: (() => void) | null } = { faults: [], hold: null };
  let feedbackReadGate: Promise<void> | null = null;
  let feedbackReadsHeld = 0;
  const takeFeedbackFault = (method: string) => {
    const index = feedbackControl.faults.findIndex(fault => fault.method === method);
    return index < 0 ? null : feedbackControl.faults.splice(index, 1)[0]!;
  };
  const holdFeedbackReads = () => {
    feedbackReadGate = new Promise<void>(resolve => { feedbackControl.hold = resolve; });
    return {
      held: () => feedbackReadsHeld,
      release: () => { feedbackReadGate = null; feedbackControl.hold?.(); feedbackControl.hold = null; },
    };
  };
  // Scripts the next outfit save or outfit reads: lost replies, commits whose reply is lost, and failed rereads.
  const outfitControl: { nextSave: null | { mode: 'lost' | 'committedLost' | 'transport' } | { mode: 'error'; status: number; body: unknown };
    readFailures: number; readFailureStatus: number; saves: number } = { nextSave: null, readFailures: 0, readFailureStatus: 500, saves: 0 };
  const preferences: Record<string, JsonRow> = Object.fromEntries(Object.values(owners).map((owner) => [owner, {
    owner_id: owner, version: 1, preferred_colours: [], style_tags: [], excluded_categories: [],
    minimum_upper_coverage: 0, minimum_lower_coverage: 0, cold_sensitivity: 0, repeat_gap_days: 2,
  }]));
  const images: JsonRow[] = [];
  // Backup fixture: attribution histories by item, a hook that runs before each attribution read, and manifest reads.
  const exportControl: { attributions: Map<string, unknown[]>; beforeAttribution: (() => void) | null; manifests: number } = {
    attributions: new Map(), beforeAttribution: null, manifests: 0 };
  const files = new Map<string, Buffer>();
  const deletionClaims = new Map<string, { request_id: string; expected_version: number; started_at: string }>();
  let lifecycleReplyLost = false;
  const manifest = (itemId: unknown, owner: string) => createHash('sha256').update(JSON.stringify(
    images.filter(row => row.item_id === itemId && row.owner_id === owner).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  )).digest('hex');
  const deletionStatus = (item: JsonRow, owner: string) => {
    const all = images.filter(row => row.owner_id === owner && row.item_id === item.id);
    const ready = all.filter(row => row.state === 'ready');
    if (ready.length > 1) throw new Error('Invalid lifecycle fixture.');
    const count = [...files.keys()].filter(path => path.startsWith(`${owner}/${item.id}/`)
      && !all.some(row => row.main_path === path || row.thumb_path === path)).length;
    return { id: item.id, owner_id: owner, title: item.title, version: item.version, deleted_at: item.deleted_at,
      photo_count: all.length, current_image_id: ready[0]?.id ?? null, current_thumb_path: ready[0]?.thumb_path ?? null,
      image_manifest_sha256: manifest(item.id, owner), cleanup_blocked: count > 0, unmanifested_count: count,
      request_id: null, expected_version: null, started_at: null, ...deletionClaims.get(String(item.id)) };
  };
  const saves: Array<{ owner: string; itemId: string; imageId: string; fingerprint: string; state: 'reserved' | 'completed'; analyzed?: boolean; cancelled?: boolean }> = [];
  const imageChanges: Array<{ owner: string; intent: JsonRow; itemBefore: JsonRow; imageBefore: JsonRow; receipt: ImageChangeReceipt }> = [];
  type Target = { ordinal: number; path: string; category: 'pending' | 'registered' | 'unmanifested';
    objectId: string | null; version: string | null; authorized: boolean; absent: boolean };
  type Operation = { owner: string; manifest: string; receipt: DeletionOperation; targets: Target[]; imagePage: number; objectPage: number; imagesDone: boolean };
  const deletionOperations: Operation[] = [];
  let imageChangeLost = false;
  const restoreControl = { reservations: 0 };
  const fenced = (owner: string, itemId: unknown) => deletionOperations.some(value => value.owner === owner
    && value.receipt.itemId === itemId && value.receipt.phase !== 'cancelled');
  const imageBytesMatch = (image: JsonRow) => ['main', 'thumb'].every(kind => {
    const bytes = files.get(String(image[`${kind}_path`]));
    return bytes && bytes.length === image[`${kind}_bytes`] && createHash('sha256').update(bytes).digest('hex') === image[`${kind}_sha256`];
  });
  const imageKeys = ['id', 'main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text'];
  const fingerprintFor = (item: JsonRow, image: JsonRow) => {
    const values = garmentPayload(parseGarmentValues(item)), provenance = parseFieldProvenance(item.field_provenance);
    return createHash('sha256').update(JSON.stringify([
      item.id, garmentFields.map((key) => values[key]), provenanceFields.map((key) => provenance[key] ?? null),
      imageKeys.map((key) => image[key]),
    ])).digest('hex');
  };
  const currentSave = (save: typeof saves[number]) => {
    const item = items.find((row) => row.id === save.itemId && row.owner_id === save.owner);
    const image = images.find((row) => row.id === save.imageId && row.item_id === save.itemId && row.owner_id === save.owner);
    const prefix = `${save.owner}/${save.itemId}/${save.imageId}`;
    if (save.cancelled || !item || !image || item.version !== 1 || item.deleted_at !== null || image.description_version !== 1
      || image.retired_at !== null || image.state !== (save.state === 'reserved' ? 'pending' : 'ready')
      || image.main_path !== `${prefix}/main.jpg` || image.thumb_path !== `${prefix}/thumb.jpg`) return null;
    try { if (fingerprintFor(item, image) !== save.fingerprint) return null; }
    catch { return null; }
    return { item, image, fingerprint: save.fingerprint, state: save.state };
  };
  const requests: Array<{ method: string; path: string; owner: string | null; ownerFilter: string | null }> = [];
  let commitFailed = false, analyzedReserveReplyLost = false;
  const fixture = await readFile(new URL('../../blueprint/validation/fixture.jpg', import.meta.url));
  const tokens = new Map<string, string>();
  const statusProofs: StatusProof[] = [];
  const admitAiStatus = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:54321' || url.pathname !== '/rest/v1/rpc/ai_status') return false;
    const owner = tokens.get(request.headers().authorization ?? '') ?? null;
    let emptyObject = false;
    try {
      const body: unknown = request.postDataJSON();
      emptyObject = isRecord(body) && Object.keys(body).length === 0;
    } catch { /* Malformed status JSON is recorded as a failed proof and refused. */ }
    const issuedBearer = owner === owners.a || owner === owners.b;
    statusProofs.push({ owner, issuedBearer, emptyObject });
    return request.method() === 'POST' && !url.search && issuedBearer && emptyObject;
  };
  const decorateWireResponses = options.wireDiagnostic !== undefined;
  const wireBackend = options.wireDiagnostic ?? options.wireObservation;
  const wireDiagnostic: WireDiagnostic | undefined = wireBackend ? {
    backend: wireBackend, routePosts: 0, receiverPosts: 0, success: 0, routeRejected: 0, receiverRejected: 0,
    routeStage: 'none', receiverStage: 'none',
    rejections: Object.fromEntries(wireStages.map((stage) => [stage, 0])) as Record<WireStage, number>,
    receiverFacts: null, firstPost400Attempt: null,
  } : undefined;
  const rawAnalysisObservation: RawAnalysisObservation | undefined = options.observeRawAnalysis ? {
    postCount: 0, overflow: false, evidenceError: false, posts: [], firstAttemptedPost400: null,
  } : undefined;
  const receiver = await uploadReceiver(page, items, images, files, tokens, decorateWireResponses, wireDiagnostic, options.analysis, rawAnalysisObservation);
  // The weather service is never reached from tests; a spec that needs it adds its own route, which runs first.
  await page.route(/^https:\/\/(geocoding-api|api)\.open-meteo\.com\//, route => route.abort('blockedbyclient'));
  await page.route('http://127.0.0.1:54321/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (options.analysis && url.pathname === analysisPath) {
      const headers = await request.allHeaders();
      const validSource = url.origin === 'http://127.0.0.1:54321' && !url.search;
      const valid = validSource && (method === 'OPTIONS' ? receiver.analysisPreflightAllowed(headers)
        : method === 'POST' && receiver.analysisIdentity(headers) !== null);
      if (!valid) {
        receiver.analysisState.routeRejected++;
        await route.fulfill({ status: 403, json: { code: 'INVALID_INPUT' }, headers: receiver.analysisCors });
        return;
      }
      receiver.analysisState.forwarded++;
      const detail = rawAnalysisObservation?.detail;
      if (detail && method === 'POST') {
        if (detail.routePosts >= 4) { detail.overflow = true; detail.evidenceError = true; }
        else {
          const ordinal = ++detail.routePosts;
          try {
            const body = request.postDataBuffer();
            detail.routes.push({ ordinal, body: body === null ? 'absent' : body.length === 0 ? 'empty'
              : body.length === 4096 ? '4096' : 'other' });
          } catch { detail.evidenceError = true; }
        }
      }
      try { await route.continue({ url: receiver.url + analysisPath }); }
      catch { throw new Error('Fixture analysis continuation failed.'); }
      return;
    }
    const wirePost = method === 'POST' && url.pathname.startsWith(storagePrefix);
    if (wireDiagnostic && wirePost) { wireDiagnostic.routePosts++; wireDiagnostic.routeStage = 'none'; }
    let owner: string | null = null;
    const token = request.headers().authorization?.split(' ')[1]?.split('.')[1];
    if (token) {
      try { const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString()); if (typeof value === 'object' && value && 'sub' in value && typeof value.sub === 'string') owner = value.sub; }
      catch { /* The mocked anonymous key carries no owner. */ }
    }
    requests.push({ method, path: url.pathname, owner, ownerFilter: url.searchParams.get('owner_id') });
    const json = (body: unknown, status = 200, stage: WireStage = 'none') => {
      if (wireDiagnostic && wirePost) {
        wireDiagnostic.routeStage = stage;
        if (status >= 400) { wireDiagnostic.routeRejected++; wireDiagnostic.rejections[stage]++; }
        if (decorateWireResponses) body = { ...body as JsonRow, wireBackend: wireDiagnostic.backend, wireStage: stage };
      }
      return route.fulfill({ status, json: body, headers: { 'x-supabase-api-version': '2024-01-01' } });
    };
    const failFeedback = (fault: FeedbackFault) => fault.fail === 'abort'
      ? route.abort('failed') : json({ message: 'Service unavailable' }, fault.fail);
    if (method === 'OPTIONS') {
      if (url.pathname.startsWith(storagePrefix)) {
        const allowed = !url.search && receiver.reservedOwner(url.pathname) && receiver.preflightAllowed(request.headers());
        await route.fulfill({ status: allowed ? 204 : 403, headers: receiver.cors });
      } else await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === '/auth/v1/token') {
      const body = request.postDataJSON() as { email?: string; password?: string };
      const id = body.email === 'user-a@example.test' ? owners.a : body.email === 'user-b@example.test' ? owners.b : null;
      if (!id || body.password !== 'fictional-test-password') { await json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400); return; }
      const claims = { sub: id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID() };
      const accessToken = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.browser-fixture`;
      tokens.set('Bearer ' + accessToken, id);
      await json({ access_token: accessToken, refresh_token: `fixture-${id}`, expires_in: 3600, token_type: 'bearer', user: { id, email: body.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-06T00:00:00Z' } });
      return;
    }
    if (url.pathname === '/auth/v1/recover') { await json({}, options.recoverStatus ?? 200); return; }
    if (url.pathname === '/auth/v1/logout') { await route.fulfill({ status: options.logoutStatus ?? 204 }); return; }
    if (!owner || !profiles[owner]) { await json({ message: 'Unauthorized' }, 401, 'route-auth'); return; }
    if (url.pathname === '/auth/v1/user') {
      if (method === 'PUT' && options.updateStatus) { await json({ code: 'reauthentication_needed', message: 'Private upstream text' }, options.updateStatus); return; }
      const id = options.recoveryUser ?? owner;
      await json({ id, email: id === owners.a ? 'user-a@example.test' : 'user-b@example.test', aud: 'authenticated', role: 'authenticated', is_anonymous: false });
      return;
    }
    if (url.pathname === '/rest/v1/profiles' || url.pathname === '/rest/v1/style_preferences') {
      if (url.searchParams.get('owner_id') !== `eq.${owner}`) { await json(null); return; }
      const profile = (url.pathname === '/rest/v1/profiles' ? profiles : preferences)[owner];
      if (!profile) { await json(null); return; }
      if (method === 'PATCH') {
        const body = request.postDataJSON() as JsonRow;
        if (options.failLanguageSave && 'ui_language' in body) { await json({ message: 'Unavailable' }, 503); return; }
        if (url.searchParams.get('version') !== `eq.${profile.version}` || url.searchParams.get('ui_language') === 'is.null' && profile.ui_language !== null) { await json(null); return; }
        const allowed = url.pathname === '/rest/v1/profiles' ? ['display_name', 'timezone', 'currency', 'ui_language', 'weather_enabled', 'weather_city', 'latitude', 'longitude']
          : ['preferred_colours', 'style_tags', 'excluded_categories', 'minimum_upper_coverage', 'minimum_lower_coverage', 'cold_sensitivity', 'repeat_gap_days'];
        if (Object.keys(body).some((key) => !allowed.includes(key))) { await json({ code: '42501' }, 403); return; }
        Object.assign(profile, body);
        profile.version = Number(profile.version) + 1;
      }
      // Like PostgREST, a profile reply holds only the selected columns.
      const select = url.pathname === '/rest/v1/profiles' ? url.searchParams.get('select') : null;
      await json(select ? Object.fromEntries(select.split(',').filter(column => column in profile).map(column => [column, profile[column]])) : profile); return;
    }
    if (url.pathname === '/rest/v1/rpc/ai_status') {
      if (!admitAiStatus(request)) { await json({ code: 'UNAUTHENTICATED' }, 401); return; }
      await json({ code: 'UNCONFIGURED', period: new Date().toISOString().slice(0, 7), serverTimeMs: Date.now(),
        consent: { enabled: false, noticeRevision: null, consentedAt: null, profileVersion: String(profiles[owner]!.version) },
        policy: null, usage: { accountedMicro: '0', requestsLastHour: 0, warning: false } }); return;
    }
    if (['image_change_status', 'image_change_requests', 'image_recovery_versions', 'cancel_image_change'].some(name => url.pathname === `/rest/v1/rpc/${name}`)) {
      const body: unknown = request.postDataJSON();
      const invalid = () => json({ code: '22023', message: 'Invalid input', details: null, hint: null }, 400);
      const name = url.pathname.split('/').at(-1)!;
      const keys = name === 'image_recovery_versions' ? ['p_item_id', ...(isRecord(body) && Object.hasOwn(body, 'p_after') ? ['p_after'] : [])]
        : name === 'image_change_requests' ? ['p_item_id'] : ['p_item_id', 'p_request_id'];
      if (method !== 'POST' || !isRecord(body) || !sameValue(Object.keys(body).sort(), keys.sort())
        || !isUuid(body.p_item_id) || keys.includes('p_request_id') && !isUuid(body.p_request_id)
        || keys.includes('p_after') && !isUuid(body.p_after)) { await invalid(); return; }
      const own = imageChanges.filter(value => value.owner === owner && value.receipt.itemId === body.p_item_id);
      if (name === 'image_change_requests') { await json(own.filter(value => value.receipt.state === 'reserved').map(value => value.receipt).sort((a, b) => a.requestId.localeCompare(b.requestId))); return; }
      if (name === 'image_recovery_versions') {
        if (fenced(owner, body.p_item_id) || !items.some(row => row.owner_id === owner && row.id === body.p_item_id && row.deleted_at === null)) { await invalid(); return; }
        await json(images.filter(row => row.owner_id === owner && row.item_id === body.p_item_id && row.state === 'retired'
          && (body.p_after === undefined || String(row.id) > String(body.p_after))).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 40)
          .map(image => ({ image, eligible: Date.parse(String(image.retired_at)) <= Date.now() && Date.parse(String(image.retired_at)) >= Date.now() - 7 * 86400000 })));
        return;
      }
      const found = own.find(value => value.receipt.requestId === body.p_request_id);
      if (name === 'cancel_image_change' && found?.receipt.state === 'reserved') {
        found.receipt = { ...found.receipt, state: 'cancelled' };
        if (options.imageChangeLoss === 'cancel' && !imageChangeLost) { imageChangeLost = true; await route.abort('failed'); return; }
      }
      await json(found?.receipt ?? null); return;
    }
    if (url.pathname === '/rest/v1/rpc/reserve_image_change' || url.pathname === '/functions/v1/finalize-image-change') {
      const finalizer = url.pathname.endsWith('/finalize-image-change');
      const body: unknown = request.postDataJSON();
      const fail = (message: 'Invalid input' | 'Request conflict' | 'Upload incomplete') =>
        json(finalizer ? { code: message === 'Request conflict' ? 'CONFLICT' : message === 'Upload incomplete' ? 'UPLOAD_INCOMPLETE' : 'INVALID_INPUT' }
          : { code: '22023', message, details: null, hint: null }, finalizer ? 409 : 400);
      if (method !== 'POST' || !isRecord(body) || !sameValue(Object.keys(body).sort(), finalizer ? ['action', 'intent'] : ['p_intent'])) { await fail('Invalid input'); return; }
      const intent = finalizer ? body.intent : body.p_intent;
      const action = finalizer ? body.action : 'reserve';
      if (!isRecord(intent) || !sameValue(Object.keys(intent).sort(),
        ['requestId', 'itemId', 'imageId', 'expectedVersion', 'currentImageId', 'descriptionVersion', 'item', 'image', 'claim', 'sourceImageId'].sort())
        || ![intent.requestId, intent.itemId, intent.imageId, intent.currentImageId].every(isUuid)
        || !isRecord(intent.item) || !isRecord(intent.image) || !['reserve', 'complete', 'accept-recovery'].includes(String(action))
        || !sameValue(Object.keys(intent.item).sort(), [...garmentFields, 'field_provenance'].sort())
        || !sameValue(Object.keys(intent.image).sort(), [...imageKeys].sort()) || intent.image.id !== intent.imageId) { await fail('Invalid input'); return; }
      const item = items.find(row => row.owner_id === owner && row.id === intent.itemId);
      const currentImage = images.find(row => row.owner_id === owner && row.item_id === intent.itemId && row.id === intent.currentImageId);
      const fingerprint = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
      let existing = imageChanges.find(row => row.owner === owner && row.receipt.requestId === intent.requestId);
      if (!item || !currentImage || fenced(owner, item.id) || existing && (existing.receipt.fingerprint !== fingerprint || existing.receipt.state === 'cancelled')) { await fail('Request conflict'); return; }
      if (!existing || existing.receipt.state !== 'completed') {
        if (item.deleted_at !== null || item.version !== intent.expectedVersion || currentImage.state !== 'ready'
          || currentImage.description_version !== intent.descriptionVersion
          || existing && (!sameValue(item, existing.itemBefore) || !sameValue(currentImage, existing.imageBefore))) { await fail('Request conflict'); return; }
      }
      if (action === 'complete') {
        const next = existing && images.find(row => row.owner_id === owner && row.id === intent.imageId && row.item_id === item.id);
        if (!existing || !next || !imageBytesMatch(next)) { await fail('Upload incomplete'); return; }
        if (existing.receipt.state === 'reserved') {
          currentImage.state = 'retired'; currentImage.retired_at = new Date().toISOString(); next.state = 'ready';
          Object.assign(item, structuredClone(intent.item), { version: Number(item.version) + 1, updated_at: new Date().toISOString() });
          existing.receipt = { ...existing.receipt, state: 'completed', completedVersion: Number(item.version) };
        }
        if (options.imageChangeLoss === 'finalizer' && !imageChangeLost) { imageChangeLost = true; await route.abort('failed'); return; }
        await route.fulfill({ status: 204 }); return;
      }
      if (existing) { await json(existing.receipt); return; }
      if (images.some(row => row.id === intent.imageId) || intent.imageId === intent.currentImageId
        || imageChanges.some(row => row.owner === owner && row.receipt.imageId === intent.imageId)) { await fail('Request conflict'); return; }
      const recovery = action === 'accept-recovery';
      if (recovery) {
        const source = images.find(row => row.id === intent.sourceImageId && row.owner_id === owner && row.item_id === item.id && row.state === 'retired');
        const fields = Object.fromEntries([...garmentFields, 'field_provenance'].map(key => [key, item[key]]));
        const image = intent.image;
        if (!source || intent.claim !== null || !sameValue(fields, intent.item)
          || Date.parse(String(source.retired_at)) > Date.now() || Date.parse(String(source.retired_at)) < Date.now() - 7 * 86400000
          || !imageBytesMatch(source) || imageKeys.filter(key => key !== 'id' && key !== 'alt_text').some(key => !sameValue(source[key], image[key]))) { await fail('Request conflict'); return; }
      } else if (intent.sourceImageId !== null) { await fail('Invalid input'); return; }
      try {
        parseGarmentValues(intent.item);
        const before = parseFieldProvenance(item.field_provenance), after = parseFieldProvenance(intent.item.field_provenance);
        for (const field of provenanceFields) {
          if (!sameValue(before[field], after[field]) && after[field]?.revision !== (before[field]?.revision ?? 0) + 1
            || !sameValue(item[field], intent.item[field]) && sameValue(before[field], after[field])) throw new Error('Fixture revision');
        }
        if (intent.claim !== null) {
          const claim = intent.claim;
          if (!isRecord(claim) || !isRecord(claim.fields) || typeof claim.requestId !== 'string') throw new Error('Fixture claim');
          const result = options.aiResults?.get(claim.requestId);
          if (!result || result.imageSha256 !== intent.image.main_sha256 || result.draftId !== claim.draftId
            || result.generation !== claim.generation || !claim.requestId.startsWith(owner === owners.a ? 'c329a000-' : 'c329b000-')) throw new Error('Fixture claim');
          if (result.expiresAtMs <= Date.now()) {
            await json({ requestId: intent.requestId, itemId: intent.itemId, imageId: intent.imageId, state: 'analysis_unavailable' }); return;
          }
          for (const [field, entry] of Object.entries(claim.fields)) {
            if (!isRecord(entry) || !sameValue(entry.value, result.facts.fields[field as keyof typeof result.facts.fields])
              || !sameValue(intent.item[field], entry.value) || before[field as keyof typeof before]?.kind === 'user'
              || !(item[field] === null || item[field] === '' || Array.isArray(item[field]) && item[field].length === 0)
              || after[field as keyof typeof after]?.kind !== entry.kind) throw new Error('Fixture claim');
          }
        }
        for (const [field, entry] of Object.entries(after)) if (entry.kind.startsWith('ai_') && !sameValue(entry, before[field as keyof typeof before])
          && (!isRecord(intent.claim) || !isRecord(intent.claim.fields) || !Object.hasOwn(intent.claim.fields, field))) throw new Error('Fixture proof');
      } catch { await fail('Invalid input'); return; }
      const prefix = `${owner}/${item.id}/${intent.imageId}`;
      images.push({ ...structuredClone(intent.image), owner_id: owner, item_id: item.id, state: 'pending', retired_at: null,
        description_version: 1, created_at: new Date().toISOString(), main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg` });
      existing = { owner, intent: structuredClone(intent), itemBefore: structuredClone(item), imageBefore: structuredClone(currentImage),
        receipt: { requestId: String(intent.requestId), itemId: String(item.id), imageId: String(intent.imageId), kind: recovery ? 'recovery' : 'replacement',
          state: 'reserved', fingerprint, completedVersion: null } };
      imageChanges.push(existing);
      if (options.imageChangeLoss === 'reservation' && !imageChangeLost) { imageChangeLost = true; await route.abort('failed'); return; }
      await json(existing.receipt); return;
    }
    if (url.pathname === '/rest/v1/rpc/restore_image_change_status') {
      const body: unknown = request.postDataJSON();
      if (method !== 'POST' || !isRecord(body) || !sameValue(Object.keys(body).sort(), ['p_item_id', 'p_request_id'])
        || !isUuid(body.p_item_id) || !isUuid(body.p_request_id)) { await json({ code: '22023', message: 'Invalid input', details: null, hint: null }, 400); return; }
      const found = imageChanges.find(value => value.owner === owner && value.receipt.itemId === body.p_item_id && value.receipt.requestId === body.p_request_id);
      if (!found) { await json(null); return; }
      const image = images.find(row => row.owner_id === owner && row.item_id === found.receipt.itemId && row.id === found.receipt.imageId);
      await json({ ...found.receipt, expectedVersion: found.intent.expectedVersion, currentImageId: found.intent.currentImageId,
        descriptionVersion: found.intent.descriptionVersion, image: image ? Object.fromEntries(['state', 'main_path', 'thumb_path', 'main_bytes', 'thumb_bytes',
          'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text', 'description_version'].map(key => [key, image[key]])) : null }); return;
    }
    if (['reserve_item_save', 'reserve_analyzed_item_save', 'reserve_restored_item_save'].some(name => url.pathname === `/rest/v1/rpc/${name}`)) {
      const analyzed = url.pathname.endsWith('/reserve_analyzed_item_save');
      const restored = url.pathname.endsWith('/reserve_restored_item_save');
      if (restored) restoreControl.reservations++;
      const body: unknown = request.postDataJSON();
      const invalid = () => json({ code: '22023', message: 'Invalid input', details: null, hint: null }, 400);
      const conflict = () => json({ code: '22023', message: 'Request conflict', details: null, hint: null }, 400);
      if (method !== 'POST' || !isRecord(body) || Object.keys(body).length !== (analyzed ? 3 : 2)
        || !isRecord(body.p_item) || !isRecord(body.p_image)) { await invalid(); return; }
      const item = body.p_item, image = body.p_image;
      if (!sameValue(Object.keys(item).sort(), [...garmentFields, 'id', 'field_provenance'].sort())
        || !sameValue(Object.keys(image).sort(), [...imageKeys].sort()) || !isUuid(item.id) || !isUuid(image.id)) {
        await invalid(); return;
      }
      const existing = saves.find((save) => save.owner === owner && (save.itemId === item.id || save.imageId === image.id));
      let fingerprint: string;
      try {
        const provenance = parseFieldProvenance(item.field_provenance);
        if (Object.values(provenance).some((entry) => (!analyzed && !restored && entry.kind !== 'user') || entry.revision !== 1)) throw new Error('Invalid fixture intent');
        if (restored && Object.entries(provenance).some(([field, entry]) => entry.kind.startsWith('ai_')
          && (item[field] === null || item[field] === '' || Array.isArray(item[field]) && item[field].length === 0))) throw new Error('Invalid fixture intent');
        if (analyzed && !existing) {
          const claim = body.p_claim;
          if (claim !== null) {
            if (!isRecord(claim) || !isRecord(claim.fields) || typeof claim.requestId !== 'string') throw new Error('Invalid fixture claim');
            const result = options.aiResults?.get(claim.requestId);
            if (!result || result.draftId !== claim.draftId || result.generation !== claim.generation
              || result.imageSha256 !== claim.imageSha256 || result.imageSha256 !== image.main_sha256
              || !claim.requestId.startsWith(owner === owners.a ? 'c329a000-' : 'c329b000-')) {
              throw new Error('Invalid fixture claim');
            }
            if (result.expiresAtMs <= Date.now()) {
              options.aiResults?.delete(claim.requestId);
              await json([{ state: 'analysis_unavailable', fingerprint: null,
                item: { id: item.id, owner_id: owner }, image: { id: image.id, item_id: item.id, owner_id: owner } }]);
              return;
            }
            for (const [field, entry] of Object.entries(claim.fields)) {
              if (!isRecord(entry) || !sameValue(entry.value, result.facts.fields[field as keyof typeof result.facts.fields])
                || !sameValue(entry.value, item[field]) || provenance[field as keyof typeof provenance]?.kind !== entry.kind) throw new Error('Invalid fixture claim');
            }
          }
          for (const [field, entry] of Object.entries(provenance)) {
            if (entry.kind.startsWith('ai_') && (!isRecord(claim) || !isRecord(claim.fields) || !Object.hasOwn(claim.fields, field))) throw new Error('Invalid fixture provenance');
          }
        }
        for (const key of provenanceFields) {
          const value = item[key];
          if (value !== null && !(Array.isArray(value) && value.length === 0) && !(key === 'notes' && value === '') && !provenance[key]) {
            throw new Error('Invalid fixture intent');
          }
        }
        if (typeof image.alt_text !== 'string' || [...image.alt_text].length > 240
          || !['main_sha256', 'thumb_sha256'].every((key) => typeof image[key] === 'string' && /^[0-9a-f]{64}$/.test(image[key]))
          || !['width', 'height', 'main_bytes', 'thumb_bytes'].every((key) => typeof image[key] === 'number' && Number.isSafeInteger(image[key]) && image[key] > 0)) {
          throw new Error('Invalid fixture image');
        }
        fingerprint = fingerprintFor(item, image);
      } catch { await invalid(); return; }
      // A restored save may only replay while its photo is still pending and nothing else has touched the item.
      if (restored && (imageChanges.some(row => row.owner === owner && row.receipt.itemId === item.id)
        || items.some(row => row.owner_id === owner && row.id === item.id && row.deleted_at !== null)
        || images.some(row => row.owner_id === owner && row.item_id === item.id && row.state !== 'pending'))) { await conflict(); return; }
      if (existing) {
        if (existing.itemId !== item.id || existing.imageId !== image.id || existing.fingerprint !== fingerprint) { await conflict(); return; }
        const current = currentSave(existing);
        if (!current) { await conflict(); return; }
        if (existing.state === 'completed' && (!files.has(String(current.image.main_path)) || !files.has(String(current.image.thumb_path)))) {
          await json({ code: '22023', message: 'Upload incomplete', details: null, hint: null }, 400); return;
        }
        await json([current]); return;
      }
      if (items.some((row) => row.id === item.id) || images.some((row) => row.id === image.id)) { await conflict(); return; }
      const now = new Date().toISOString(), prefix = `${owner}/${item.id}/${image.id}`;
      items.push({ ...item, owner_id: owner, version: 1, deleted_at: null, created_at: now, updated_at: now });
      images.push({ ...image, owner_id: owner, item_id: item.id, description_version: 1, state: 'pending', retired_at: null,
        main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, created_at: now });
      const save = { owner, itemId: item.id, imageId: image.id, fingerprint, state: 'reserved' as const, analyzed };
      saves.push(save);
      if (analyzed && options.loseAnalyzedReserveReplyOnce && !analyzedReserveReplyLost) {
        analyzedReserveReplyLost = true; await route.abort('failed'); return;
      }
      await json([currentSave(save)]); return;
    }
    if (url.pathname === '/rest/v1/rpc/cancel_analyzed_item_save') {
      const body: unknown = request.postDataJSON();
      const save = isRecord(body) && saves.find((value) => value.owner === owner && value.analyzed
        && value.itemId === body.p_item_id && value.imageId === body.p_image_id && value.fingerprint === body.p_fingerprint);
      if (!save || save.state !== 'reserved' || !currentSave(save)) { await json({ code: '22023', message: 'Request conflict', details: null, hint: null }, 400); return; }
      save.cancelled = true; await route.fulfill({ status: 204 }); return;
    }
    if (url.pathname === '/rest/v1/rpc/finalize_item_save' || url.pathname === '/functions/v1/finalize-analyzed-item') {
      const analyzed = url.pathname.endsWith('/finalize-analyzed-item');
      const raw: unknown = request.postDataJSON();
      const body: unknown = analyzed && isRecord(raw) && Object.keys(raw).length === 3
        ? { p_item_id: raw.itemId, p_image_id: raw.imageId, p_fingerprint: raw.fingerprint } : raw;
      if (method !== 'POST' || !isRecord(body) || !sameValue(Object.keys(body).sort(), ['p_fingerprint', 'p_image_id', 'p_item_id'])
        || !isUuid(body.p_item_id) || !isUuid(body.p_image_id) || typeof body.p_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.p_fingerprint)) {
        await json({ code: '22023', message: 'Invalid input', details: null, hint: null }, 400); return;
      }
      const save = saves.find((value) => value.owner === owner && value.itemId === body.p_item_id
        && value.imageId === body.p_image_id && value.fingerprint === body.p_fingerprint);
      const current = save && currentSave(save);
      if (!save || Boolean(save.analyzed) !== analyzed || !current || images.some((row) => row.owner_id === owner && row.item_id === save.itemId && row.id !== save.imageId && row.state === 'ready')) {
        await json({ code: '22023', message: 'Request conflict', details: null, hint: null }, 400); return;
      }
      if (!files.has(String(current.image.main_path)) || !files.has(String(current.image.thumb_path))) {
        await json({ code: '22023', message: 'Upload incomplete', details: null, hint: null }, 400); return;
      }
      if (options.failCommitOnce && !commitFailed) { commitFailed = true; await json({ message: 'Unavailable' }, 503); return; }
      current.image.state = 'ready'; save.state = 'completed';
      if (options.loseFinalizeReplyOnce && !commitFailed) { commitFailed = true; await route.abort('failed'); return; }
      await route.fulfill({ status: 204 }); return;
    }
    if (['item_deletion_operations', 'item_deletion_operation_status', 'prepare_item_deletion', 'inventory_item_deletion',
      'cancel_item_deletion_preparation', 'authorize_item_deletion', 'item_deletion_next_target', 'reconcile_item_deletion_target',
      'begin_prepared_item_deletion'].some(name => url.pathname === `/rest/v1/rpc/${name}`)) {
      const body: unknown = request.postDataJSON(), name = url.pathname.split('/').at(-1)!;
      const fail = () => json({ code: '22023', message: 'Request conflict', details: null, hint: null }, 400);
      if (method !== 'POST' || !isRecord(body)) { await fail(); return; }
      if (name === 'item_deletion_operations') {
        const ids = body.p_item_ids;
        if (Object.keys(body).length !== 1 || !Array.isArray(ids) || !ids.length || ids.length > 40 || !ids.every(isUuid)
          || new Set(ids).size !== ids.length) { await fail(); return; }
        await json(deletionOperations.filter(value => value.owner === owner && ids.includes(value.receipt.itemId)
          && value.receipt.phase !== 'cancelled').map(value => value.receipt)); return;
      }
      const keys = ['p_item_id', 'p_request_id', ...(name === 'prepare_item_deletion' ? ['p_expected_version', 'p_image_manifest_sha256']
        : name === 'authorize_item_deletion' ? ['p_inventory_hash'] : name === 'reconcile_item_deletion_target' ? ['p_ordinal'] : [])];
      if (!sameValue(Object.keys(body).sort(), keys.sort()) || !isUuid(body.p_item_id) || !isUuid(body.p_request_id)) { await fail(); return; }
      const id = body.p_item_id, requestId = body.p_request_id;
      let operation = deletionOperations.find(value => value.owner === owner && value.receipt.requestId === requestId && value.receipt.itemId === id);
      if (name === 'item_deletion_operation_status') { await json(operation?.receipt ?? null); return; }
      const item = items.find(row => row.id === id && row.owner_id === owner);
      if (name === 'prepare_item_deletion') {
        if (operation) {
          if (operation.receipt.phase === 'cancelled' || operation.receipt.expectedVersion !== body.p_expected_version
            || operation.manifest !== body.p_image_manifest_sha256) { await fail(); return; }
          await json(operation.receipt); return;
        }
        if (!item || !item.deleted_at || item.version !== body.p_expected_version || body.p_image_manifest_sha256 !== manifest(id, owner)
          || fenced(owner, id) || deletionOperations.some(value => value.owner === owner && value.receipt.requestId === requestId)) { await fail(); return; }
        const claim = deletionClaims.get(id);
        if (claim && claim.request_id !== requestId) { await fail(); return; }
        operation = { owner, manifest: String(body.p_image_manifest_sha256), targets: [], imagePage: 0, objectPage: 0, imagesDone: false,
          receipt: { itemId: id, requestId, phase: 'preparing', expectedVersion: Number(item.version), inventoryHash: null,
            targetCount: 0, reason: null, begin: claim ? { ...claim, version: Number(item.version), image_manifest_sha256: manifest(id, owner) } : null,
            pendingTargets: 0, unmanifestedTargets: 0, registeredTargets: 0 } };
        deletionOperations.push(operation); await json(operation.receipt); return;
      }
      if (!operation || !item) { await fail(); return; }
      const op = operation;
      const coherent = () => ![...files.keys()].some(path => path.startsWith(`${owner}/${id}/`) && !op.targets.some(target => target.path === path))
        && op.targets.every(target => {
          const data = files.get(target.path);
          return data ? !target.absent && createHash('sha256').update(data).digest('hex') === target.version
            : ['authorized', 'removing_registered'].includes(op.receipt.phase) || target.objectId === null;
        });
      if (name === 'inventory_item_deletion') {
        if (op.receipt.phase !== 'preparing') { await fail(); return; }
        let done = false, supported = true;
        const enroll = (path: string, category: Target['category']) => {
          try { wardrobeTargetDeleteRoute(owner, id, path); } catch { supported = false; }
          if (op.targets.some(target => target.path === path)) return;
          const data = files.get(path);
          op.targets.push({ ordinal: op.targets.length + 1, path, category, objectId: data ? randomUUID() : null,
            version: data ? createHash('sha256').update(data).digest('hex') : null, authorized: false, absent: false });
        };
        if (!op.imagesDone) {
          const rows = images.filter(row => row.owner_id === owner && row.item_id === id).sort((a, b) => String(a.id).localeCompare(String(b.id)))
            .slice(op.imagePage, op.imagePage + 40);
          for (const image of rows) for (const path of [image.main_path, image.thumb_path]) enroll(String(path), image.state === 'pending' ? 'pending' : 'registered');
          op.imagePage += rows.length; op.imagesDone = rows.length < 40;
        } else {
          const paths = [...files.keys()].filter(path => path.startsWith(`${owner}/${id}/`)).sort().slice(op.objectPage, op.objectPage + 40);
          for (const path of paths) enroll(path, 'unmanifested');
          op.objectPage += paths.length; done = paths.length < 40;
        }
        const reason = !supported ? 'UNSUPPORTED_TARGET' : done && (manifest(id, owner) !== op.manifest || !coherent()) ? 'INVARIANT' : null;
        op.receipt = { ...op.receipt, phase: reason ? 'blocked_preflight' : done ? 'prepared' : 'preparing', reason,
          targetCount: op.targets.length, pendingTargets: op.targets.filter(t => t.category === 'pending').length,
          unmanifestedTargets: op.targets.filter(t => t.category === 'unmanifested').length,
          registeredTargets: op.targets.filter(t => t.category === 'registered').length,
          inventoryHash: done && !reason ? createHash('sha256').update(JSON.stringify(op.targets)).digest('hex') : null };
        await json(op.receipt); return;
      }
      if (name === 'cancel_item_deletion_preparation') {
        if (!['preparing', 'prepared', 'blocked_preflight', 'cancelled'].includes(op.receipt.phase) || op.receipt.begin) { await fail(); return; }
        op.targets = []; op.receipt = { ...op.receipt, phase: 'cancelled', reason: null, inventoryHash: null,
          targetCount: 0, pendingTargets: 0, unmanifestedTargets: 0, registeredTargets: 0 };
        await json(op.receipt); return;
      }
      if (name === 'authorize_item_deletion') {
        if (!['prepared', 'authorized', 'removing_registered'].includes(op.receipt.phase) || body.p_inventory_hash !== op.receipt.inventoryHash
          || !coherent() || op.receipt.phase === 'prepared' && (manifest(id, owner) !== op.manifest || item.version !== op.receipt.expectedVersion)) { await fail(); return; }
        if (op.receipt.phase === 'prepared') op.receipt = { ...op.receipt, phase: op.receipt.begin ? 'removing_registered' : 'authorized' };
        for (const change of imageChanges) if (change.owner === owner && change.receipt.itemId === id && change.receipt.state === 'reserved') change.receipt = { ...change.receipt, state: 'cancelled' };
        await json(op.receipt); return;
      }
      if (!['authorized', 'removing_registered'].includes(op.receipt.phase) || !coherent()) { await fail(); return; }
      const registered = op.receipt.phase === 'removing_registered';
      if (name === 'item_deletion_next_target') {
        const target = op.targets.find(target => !target.absent && (target.category === 'registered') === registered);
        if (target) target.authorized = true;
        await json(target ? { ordinal: target.ordinal, path: target.path, objectId: target.objectId, version: target.version } : null); return;
      }
      if (name === 'reconcile_item_deletion_target') {
        const target = op.targets.find(target => target.ordinal === body.p_ordinal && target.authorized && (target.category === 'registered') === registered);
        if (!target) { await fail(); return; }
        if (!files.has(target.path)) target.absent = true;
        await json({ ordinal: target.ordinal, state: target.absent ? 'reconciled_absent' : 'present' }); return;
      }
      if (name === 'begin_prepared_item_deletion') {
        if (!registered) {
          if (op.targets.some(target => target.category !== 'registered' && !target.absent) || item.version !== op.receipt.expectedVersion) { await fail(); return; }
          for (let i = images.length - 1; i >= 0; i--) if (images[i]!.owner_id === owner && images[i]!.item_id === id && images[i]!.state === 'pending') images.splice(i, 1);
          const claim = { request_id: requestId, expected_version: Number(item.version), started_at: new Date().toISOString() };
          deletionClaims.set(id, claim); item.version = Number(item.version) + 1; item.updated_at = new Date().toISOString();
          op.receipt = { ...op.receipt, phase: 'removing_registered', begin: { ...claim, version: Number(item.version), image_manifest_sha256: manifest(id, owner) } };
        }
        if (options.lifecycleLoss === 'begin' && !lifecycleReplyLost) { lifecycleReplyLost = true; await route.abort('failed'); return; }
        await json(op.receipt); return;
      }
      await fail(); return;
    }
    if (url.pathname === '/rest/v1/rpc/item_deletion_status') {
      const body = request.postDataJSON() as JsonRow;
      const ids = body.p_item_ids;
      if (method !== 'POST' || !Array.isArray(ids) || !ids.length || ids.length > 40 || new Set(ids).size !== ids.length || !ids.every(isUuid)) {
        await json({ code: '22023', message: 'Invalid input' }, 400); return;
      }
      await json(items.filter(row => row.owner_id === owner && typeof row.id === 'string' && ids.includes(row.id)).map(row => deletionStatus(row, owner!))); return;
    }
    if (['set_item_trashed', 'begin_item_deletion', 'finish_item_deletion'].some(name => url.pathname === `/rest/v1/rpc/${name}`)) {
      const body = request.postDataJSON() as JsonRow, id = String(body.p_item_id);
      const item = items.find(row => row.owner_id === owner && row.id === id);
      const conflict = () => json({ code: '22023', message: 'Request conflict' }, 400);
      const claim = deletionClaims.get(id);
      if (url.pathname.endsWith('/finish_item_deletion')) {
        if (!item) { await json([{ state: 'absent' }]); return; }
        if (!claim || claim.request_id !== body.p_request_id || item.version !== claim.expected_version + 1
          || [...files.keys()].some(path => path.startsWith(`${owner}/${id}/`))) { await conflict(); return; }
        const op = deletionOperations.find(value => value.owner === owner && value.receipt.itemId === id && value.receipt.phase !== 'cancelled');
        if (op && (op.receipt.requestId !== body.p_request_id || op.receipt.phase !== 'removing_registered' || op.targets.some(target => !target.absent))) { await conflict(); return; }
        items.splice(items.indexOf(item), 1);
        for (let i = images.length - 1; i >= 0; i--) if (images[i]!.owner_id === owner && images[i]!.item_id === id) images.splice(i, 1);
        for (let i = outfitItems.length - 1; i >= 0; i--) if (outfitItems[i]!.owner_id === owner && outfitItems[i]!.item_id === id) outfitItems.splice(i, 1);
        deletionClaims.delete(id);
        if (op) {
          op.targets = []; op.receipt = { ...op.receipt, phase: 'completed', expectedVersion: null, inventoryHash: null,
            targetCount: 0, pendingTargets: 0, unmanifestedTargets: 0, registeredTargets: 0, reason: null, begin: null };
        }
        if (options.lifecycleLoss === 'finish' && !lifecycleReplyLost) { lifecycleReplyLost = true; await route.abort('failed'); return; }
        await json([{ state: 'completed' }]); return;
      }
      if (!item || !Number.isSafeInteger(body.p_expected_version)) { await conflict(); return; }
      if (url.pathname.endsWith('/set_item_trashed')) {
        if (claim || fenced(owner, id) || item.version !== body.p_expected_version || typeof body.p_trashed !== 'boolean'
          || (body.p_trashed ? item.deleted_at !== null || !images.some(row => row.item_id === id && row.owner_id === owner && row.state === 'ready')
            : !item.deleted_at || Date.parse(String(item.deleted_at)) > Date.now() || Date.parse(String(item.deleted_at)) < Date.now() - 7 * 86400000)) {
          await conflict(); return;
        }
        item.deleted_at = body.p_trashed ? new Date().toISOString() : null;
        item.version = Number(item.version) + 1; item.updated_at = new Date().toISOString();
        if (options.lifecycleLoss === 'change' && !lifecycleReplyLost) { lifecycleReplyLost = true; await route.abort('failed'); return; }
        await json([{ id, owner_id: owner, version: item.version, deleted_at: item.deleted_at }]); return;
      }
      if (!isUuid(body.p_request_id) || !item.deleted_at || body.p_image_manifest_sha256 !== manifest(id, owner!)) { await conflict(); return; }
      if (claim ? claim.request_id !== body.p_request_id || claim.expected_version !== body.p_expected_version || item.version !== claim.expected_version + 1
        : item.version !== body.p_expected_version || deletionStatus(item, owner!).cleanup_blocked
          || images.some(row => row.item_id === id && row.owner_id === owner && row.state === 'pending')) { await conflict(); return; }
      if (!claim) {
        if ([...deletionClaims].some(([other, value]) => other !== id && value.request_id === body.p_request_id
          && items.some(row => row.id === other && row.owner_id === owner))) { await conflict(); return; }
        item.version = Number(item.version) + 1; item.updated_at = new Date().toISOString();
        deletionClaims.set(id, { request_id: body.p_request_id, expected_version: Number(body.p_expected_version), started_at: new Date().toISOString() });
      }
      if (options.lifecycleLoss === 'begin' && !lifecycleReplyLost) { lifecycleReplyLost = true; await route.abort('failed'); return; }
      await json([{ ...deletionClaims.get(id), version: item.version, image_manifest_sha256: manifest(id, owner!) }]); return;
    }
    if (url.pathname === '/rest/v1/wear_event_items' && method === 'GET') {
      const expected = 'id,owner_id,item_id,event_id,event:wear_events!wear_event_items_owner_id_event_id_fkey!inner(id,owner_id,local_date,state,deleted_at)';
      if (!owner || url.searchParams.get('select') !== expected || url.searchParams.get('owner_id') !== `eq.${owner}`
        || url.searchParams.get('event.owner_id') !== `eq.${owner}` || url.searchParams.get('event.state') !== 'eq.worn'
        || url.searchParams.get('event.deleted_at') !== 'is.null' || url.searchParams.get('item_id') !== 'not.is.null'
        || url.searchParams.get('order') !== 'id.asc' || url.searchParams.get('limit') !== '500') {
        await json({ code: '42501' }, 403); return;
      }
      const cursor = url.searchParams.get('id');
      if (cursor && (!cursor.startsWith('gt.') || !isUuid(cursor.slice(3)))) { await json({ code: '22023' }, 400); return; }
      const result = wearLinks.filter(row => row.owner_id === owner && row.item_id !== null && (!cursor || String(row.id) > cursor.slice(3)))
        .flatMap(row => {
          const event = wearEvents.find(event => event.id === row.event_id && event.owner_id === owner && event.state === 'worn' && event.deleted_at === null);
          return event ? [{ id: row.id, owner_id: row.owner_id, item_id: row.item_id, event_id: row.event_id,
            event: { id: event.id, owner_id: event.owner_id, local_date: event.local_date, state: event.state, deleted_at: event.deleted_at } }] : [];
        }).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0).slice(0, 500);
      await json(result); return;
    }
    if (url.pathname === '/rest/v1/outfits' && method === 'GET') {
      const expected = 'id,owner_id,title,occasion,notes,favourite,deleted_at,version,created_at,outfit_items!outfit_items_owner_id_outfit_id_fkey(owner_id,item_id,position)';
      if (!owner || url.searchParams.get('select') !== expected || url.searchParams.get('owner_id') !== `eq.${owner}`) { await json({ code: '42501' }, 403); return; }
      if (outfitControl.readFailures > 0) {
        outfitControl.readFailures--;
        await route.fulfill({ status: outfitControl.readFailureStatus, json: { message: 'Unavailable' }, headers: { 'x-supabase-api-version': '2024-01-01', 'retry-after': '0', 'access-control-expose-headers': 'retry-after' } }); return;
      }
      const id = url.searchParams.get('id');
      let rows = outfits.filter(row => row.owner_id === owner);
      if (id) {
        if (!id.startsWith('eq.') || !isUuid(id.slice(3)) || url.searchParams.has('or') || url.searchParams.has('deleted_at')) { await json({ code: '22023' }, 400); return; }
        rows = rows.filter(row => row.id === id.slice(3));
      } else {
        const keyset = url.searchParams.get('or');
        const match = keyset ? /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)\)$/.exec(keyset) : null;
        if (url.searchParams.get('deleted_at') !== 'is.null' || url.searchParams.get('order') !== 'created_at.desc,id.desc'
          || url.searchParams.get('limit') !== '500' || keyset && (!match || match[1] !== match[2] || !isUuid(match[3]))) { await json({ code: '22023' }, 400); return; }
        rows = rows.filter(row => row.deleted_at === null && (!match || String(row.created_at) < match[1]! || row.created_at === match[1] && String(row.id) < match[3]!))
          .sort((a, b) => String(a.created_at) < String(b.created_at) ? 1 : String(a.created_at) > String(b.created_at) ? -1 : String(a.id) < String(b.id) ? 1 : -1).slice(0, 500);
      }
      const shaped = rows.map(row => ({ id: row.id, owner_id: row.owner_id, title: row.title, occasion: row.occasion, notes: row.notes, favourite: row.favourite,
        deleted_at: row.deleted_at, version: row.version, created_at: row.created_at,
        outfit_items: outfitItems.filter(link => link.owner_id === owner && link.outfit_id === row.id).map(link => ({ owner_id: link.owner_id, item_id: link.item_id, position: link.position })) }));
      await json(request.headers().accept?.includes('vnd.pgrst.object') ? shaped[0] ?? null : shaped); return;
    }
    if (url.pathname === '/rest/v1/rpc/save_outfit') {
      outfitControl.saves++;
      const body = request.postDataJSON() as JsonRow;
      const script = outfitControl.nextSave;
      outfitControl.nextSave = null;
      if (script?.mode === 'lost') { await json({ message: 'Service unavailable' }, 503); return; }
      if (script?.mode === 'transport') { await route.abort('failed'); return; }
      if (script?.mode === 'error') { await json(script.body, script.status); return; }
      const keys = Object.keys(body).sort().join(',');
      const create = 'p_favourite,p_id,p_item_ids,p_notes,p_occasion,p_title', edit = 'p_expected_version,p_favourite,p_id,p_item_ids,p_notes,p_occasion,p_title';
      if (!owner || method !== 'POST' || keys !== create && keys !== edit) { await json({ code: '42501', message: 'Not available' }, 403); return; }
      const ids = body.p_item_ids;
      const invalid = () => json({ code: 'P0001', message: 'Invalid selection' }, 400);
      const conflict = () => json({ code: 'P0001', message: 'Request conflict' }, 400);
      if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length
        || ids.some(value => !items.some(item => item.id === value && item.owner_id === owner))) { await invalid(); return; }
      if (!isUuid(body.p_id) || typeof body.p_title !== 'string' || !body.p_title.trim() || typeof body.p_notes !== 'string'
        || typeof body.p_occasion !== 'string' || typeof body.p_favourite !== 'boolean') { await json({ code: '23514', message: 'Invalid input' }, 400); return; }
      const existing = outfits.find(row => row.id === body.p_id);
      if (existing && existing.owner_id !== owner) { await json({ code: '23505', message: 'duplicate key' }, 409); return; }
      const links = (outfitId: unknown) => outfitItems.filter(link => link.owner_id === owner && link.outfit_id === outfitId)
        .sort((a, b) => Number(a.position) - Number(b.position)).map(link => link.item_id);
      const write = (row: JsonRow) => {
        for (let i = outfitItems.length - 1; i >= 0; i--) if (outfitItems[i]!.outfit_id === row.id) outfitItems.splice(i, 1);
        ids.forEach((itemId, position) => outfitItems.push({ owner_id: owner, outfit_id: row.id, item_id: itemId, position }));
      };
      let version: number;
      if (keys === create) {
        if (existing) {
          const same = existing.title === body.p_title && existing.occasion === body.p_occasion && existing.notes === body.p_notes
            && existing.favourite === body.p_favourite && links(existing.id).join(',') === ids.join(',') && existing.deleted_at === null;
          if (!same) { await conflict(); return; }
          version = Number(existing.version);
        } else {
          const now = new Date().toISOString();
          const row = { id: body.p_id, owner_id: owner, title: body.p_title, occasion: body.p_occasion, notes: body.p_notes, favourite: body.p_favourite,
            deleted_at: null, version: 1, created_at: now, updated_at: now };
          outfits.push(row); write(row); version = 1;
        }
      } else {
        if (!existing || existing.deleted_at !== null || existing.version !== body.p_expected_version) { await conflict(); return; }
        Object.assign(existing, { title: body.p_title, occasion: body.p_occasion, notes: body.p_notes, favourite: body.p_favourite,
          version: Number(existing.version) + 1, updated_at: new Date().toISOString() });
        write(existing); version = Number(existing.version);
      }
      if (script?.mode === 'committedLost') { await json({ message: 'Service unavailable' }, 503); return; }
      await json(version); return;
    }
    if (url.pathname === '/rest/v1/wear_events' && owner) {
      if (method === 'POST') {
        const body = request.postDataJSON() as JsonRow;
        const keys = ['id', 'owner_id', 'outfit_id', 'local_date', 'timezone', 'state', 'label'];
        if (body.owner_id !== owner || !sameValue(Object.keys(body).sort(), [...keys].sort()) || !isUuid(body.id)
          || !['planned', 'worn'].includes(String(body.state)) || body.outfit_id !== null && !outfits.some(row => row.owner_id === owner && row.id === body.outfit_id)) {
          await json({ code: '42501' }, 403); return;
        }
        if (wearEvents.some(row => row.id === body.id)) { await json({ code: '23505', message: 'duplicate key' }, 409); return; }
        const now = new Date().toISOString();
        wearEvents.push({ ...body, deleted_at: null, version: 1, created_at: now, updated_at: now });
        await route.fulfill({ status: 201, body: '' }); return;
      }
      const select = 'id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at';
      const id = url.searchParams.get('id');
      if (method !== 'GET' || url.searchParams.get('select') !== select || url.searchParams.get('owner_id') !== `eq.${owner}`
        || !id?.startsWith('eq.')) { await json({ code: '42501' }, 403); return; }
      await json(wearEvents.filter(row => row.owner_id === owner && `eq.${row.id}` === id)
        .map(row => Object.fromEntries(select.split(',').map(key => [key, row[key] ?? null])))); return;
    }
    if (url.pathname === '/rest/v1/rpc/restore_history_entry') {
      const body = request.postDataJSON() as JsonRow;
      if (!owner || method !== 'POST' || !sameValue(Object.keys(body).sort(), ['p_category', 'p_event_id', 'p_id', 'p_import_id', 'p_item_id', 'p_title'])
        || !isUuid(body.p_import_id) || !wearEvents.some(row => row.owner_id === owner && row.id === body.p_event_id)
        || body.p_item_id !== null && !items.some(row => row.owner_id === owner && row.id === body.p_item_id)) {
        await json({ code: '42501', message: 'Not available' }, 403); return;
      }
      const existing = wearLinks.find(row => row.id === body.p_id);
      if (existing) {
        if (existing.owner_id === owner && existing.event_id === body.p_event_id && existing.item_id === body.p_item_id
          && existing.title_snapshot === body.p_title && existing.category_snapshot === body.p_category && existing.import_id === body.p_import_id) {
          await route.fulfill({ status: 204 }); return;
        }
        await json({ code: 'P0001', message: 'Request conflict' }, 400); return;
      }
      wearLinks.push({ id: body.p_id, owner_id: owner, event_id: body.p_event_id, item_id: body.p_item_id, title_snapshot: body.p_title,
        category_snapshot: body.p_category, import_id: body.p_import_id });
      await route.fulfill({ status: 204 }); return;
    }
    if (url.pathname === '/rest/v1/combination_rules' && method === 'POST' && owner) {
      const raw = request.postDataJSON() as JsonRow | JsonRow[];
      const body = Array.isArray(raw) ? raw[0]! : raw;
      if (url.searchParams.get('on_conflict') !== 'owner_id,item_low,item_high' || !request.headers().prefer?.includes('resolution=ignore-duplicates')
        || body.owner_id !== owner || typeof body.item_low !== 'string' || typeof body.item_high !== 'string' || !(body.item_low < body.item_high)
        || ![body.item_low, body.item_high].every(value => items.some(item => item.id === value && item.owner_id === owner))) {
        await json({ code: '23503', message: 'Invalid selection' }, 409); return;
      }
      if (!combinationRules.some(row => row.owner_id === owner && row.item_low === body.item_low && row.item_high === body.item_high)) {
        combinationRules.push({ id: randomUUID(), owner_id: owner, item_low: body.item_low, item_high: body.item_high, created_at: new Date().toISOString() });
      }
      await route.fulfill({ status: 201, body: '' }); return;
    }
    if (url.pathname === '/rest/v1/combination_rules' || url.pathname === '/rest/v1/suggestion_feedback') {
      const store = url.pathname === '/rest/v1/combination_rules' ? combinationRules : suggestionFeedback;
      if (!owner || method !== 'POST' && url.searchParams.get('owner_id') !== `eq.${owner}`) { await json({ code: '42501' }, 403); return; }
      const signatureOf = (ids: string[]) => createHash('sha256').update(ids.join('|')).digest('hex');
      if (method === 'GET') {
        const expected = store === combinationRules ? 'id,owner_id,item_low,item_high' : 'id,owner_id,item_ids,signature,vote';
        const exact = url.searchParams.get('signature');
        if (store === suggestionFeedback && exact !== null) {
          if (url.searchParams.get('select') !== expected || url.searchParams.get('limit') !== '2' || !/^eq\.[0-9a-f]{64}$/.test(exact)) { await json({ code: '22023' }, 400); return; }
          const fault = takeFeedbackFault('READ');
          if (fault) { await failFeedback(fault); return; }
          await json(suggestionFeedback.filter(row => row.owner_id === owner && row.signature === exact.slice(3)).map(row => ({ ...row }))); return;
        }
        const cursor = url.searchParams.get('id');
        if (url.searchParams.get('select') !== expected || url.searchParams.get('order') !== 'id.asc' || url.searchParams.get('limit') !== '500'
          || cursor && (!cursor.startsWith('gt.') || !isUuid(cursor.slice(3)))) { await json({ code: '22023' }, 400); return; }
        const snapshot = store.filter(row => row.owner_id === owner && (!cursor || String(row.id) > cursor.slice(3)))
          .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1).slice(0, 500).map(row => ({ ...row }));
        if (store === suggestionFeedback && feedbackReadGate) { feedbackReadsHeld++; await feedbackReadGate; }
        await json(snapshot).catch(() => undefined); return;
      }
      if (store !== suggestionFeedback) { await json({ code: '42501' }, 403); return; }
      const fault = takeFeedbackFault(method);
      if (fault && !fault.commit) { await failFeedback(fault); return; }
      if (method === 'POST') {
        const raw = request.postDataJSON() as JsonRow | JsonRow[];
        const body = Array.isArray(raw) ? raw[0]! : raw;
        const ids = body.item_ids;
        if (url.searchParams.get('on_conflict') !== 'owner_id,signature' || body.owner_id !== owner || (body.vote !== 1 && body.vote !== -1)
          || !Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length
          || ids.some(value => !items.some(item => item.id === value && item.owner_id === owner))) { await json({ code: 'P0001', message: 'Invalid selection' }, 400); return; }
        const sorted = [...ids].map(String).sort();
        const signature = signatureOf(sorted);
        const existing = suggestionFeedback.find(row => row.owner_id === owner && row.signature === signature);
        if (existing) { if (!request.headers().prefer?.includes('resolution=ignore-duplicates')) existing.vote = body.vote; }
        else suggestionFeedback.push({ id: randomUUID(), owner_id: owner, item_ids: sorted, signature, vote: body.vote, created_at: new Date().toISOString() });
        if (fault) { await failFeedback(fault); return; }
        await route.fulfill({ status: 201, body: '' }); return;
      }
      if (method === 'DELETE') {
        const signature = url.searchParams.get('signature');
        if (!signature?.startsWith('eq.')) { await json({ code: '22023' }, 400); return; }
        for (let i = suggestionFeedback.length - 1; i >= 0; i--) {
          if (suggestionFeedback[i]!.owner_id === owner && suggestionFeedback[i]!.signature === signature.slice(3)) suggestionFeedback.splice(i, 1);
        }
        if (fault) { await failFeedback(fault); return; }
        await route.fulfill({ status: 204 }); return;
      }
      await json({ code: '42501' }, 403); return;
    }
    const table = url.pathname === '/rest/v1/items' ? items : url.pathname === '/rest/v1/item_images' ? images : null;
    if (table) {
      if (method === 'POST') {
        const body = request.postDataJSON() as JsonRow;
        if (body.owner_id !== owner) { await json({ code: '42501' }, 403); return; }
        if (table === images && deletionClaims.has(String(body.item_id))) { await json({ code: '22023', message: 'Request conflict' }, 400); return; }
        if (table.some((row) => row.id === body.id)) { await json({ code: '23505', message: 'duplicate' }, 409); return; }
        if (table === items) {
          const row = { ...itemDefaults(), ...body, deleted_at: null, version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          try {
            parseGarmentValues(row);
            const provenance = parseFieldProvenance(row.field_provenance);
            if (Object.values(provenance).some((entry) => entry.kind !== 'user' || entry.revision !== 1)) throw new Error('Invalid fixture insert');
          } catch { await json({ code: '22023', message: 'Invalid input' }, 400); return; }
          table.push(row);
        }
        else table.push({ ...body, description_version: 1, retired_at: null, state: 'pending', main_path: `${owner}/${body.item_id}/${body.id}/main.jpg`, thumb_path: `${owner}/${body.item_id}/${body.id}/thumb.jpg` });
        await route.fulfill({ status: 201, body: '' }); return;
      }
      const own = table.filter((row) => row.owner_id === owner);
      const id = url.searchParams.get('id');
      const state = url.searchParams.get('state');
      const keyset = table === items && method === 'GET' ? url.searchParams.get('or') : null;
      const match = keyset ? /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)\)$/.exec(keyset) : null;
      if (keyset && (!match || match[1] !== match[2] || !isUuid(match[3]) || !Number.isFinite(Date.parse(match[1]!)))) {
        await json({ code: '22023' }, 400); return;
      }
      const inList = (value: string | null) => value?.startsWith('in.(') && value.endsWith(')') ? value.slice(4, -1).split(',') : null;
      const idIn = inList(id), itemIn = inList(url.searchParams.get('item_id'));
      const rows = own.filter((row) => (!id || (idIn ? idIn.includes(String(row.id)) : id.startsWith('gt.') ? String(row.id) > id.slice(3) : `eq.${row.id}` === id)) && (!state || `eq.${row.state}` === state)
        && (!match || String(row.created_at) < match[1]! || row.created_at === match[1] && String(row.id) < match[3]!)
        && (!url.searchParams.has('owner_id') || url.searchParams.get('owner_id') === `eq.${row.owner_id}`)
        && (!url.searchParams.has('item_id') || (itemIn ? itemIn.includes(String(row.item_id)) : url.searchParams.get('item_id') === `eq.${row.item_id}`))
        && (!url.searchParams.has('deleted_at') || (url.searchParams.get('deleted_at') === 'not.is.null' ? row.deleted_at !== null : row.deleted_at === null))
        && (!url.searchParams.has('retired_at') || row.retired_at === null));
      if (method === 'PATCH') {
        if (table !== items) { await json({ code: '42501' }, 403); return; }
        const row = rows.find((value) => url.searchParams.get('version') === `eq.${value.version}`);
        if (!row) { await json(null); return; }
        if (deletionClaims.has(String(row.id))) { await json({ code: '22023', message: 'Request conflict' }, 400); return; }
        const body = request.postDataJSON() as JsonRow;
        if (!id || url.searchParams.get('owner_id') !== `eq.${owner}` || url.searchParams.get('deleted_at') !== 'is.null'
          || Object.keys(body).some((key) => ![...garmentFields, 'field_provenance'].includes(key))) {
          await json({ code: '42501' }, 403); return;
        }
        let provenance;
        try {
          provenance = parseFieldProvenance(body.field_provenance ?? row.field_provenance);
          const old = parseFieldProvenance(row.field_provenance);
          for (const field of provenanceFields) {
            const previous = old[field]?.revision ?? 0, entry = provenance[field];
            if (entry?.kind === 'ai_observed' || entry?.kind === 'ai_estimated') throw new Error('Invalid fixture assertion');
            if (!sameValue(entry, old[field])) {
              if (!entry || entry.revision !== previous + 1 || previous === 2147483647) throw new Error('Invalid fixture revision');
            } else if (Object.hasOwn(body, field) && !sameValue(body[field], row[field])) {
              if (previous === 2147483647) throw new Error('Invalid fixture revision');
              provenance[field] = { kind: 'unknown', revision: previous + 1 };
            }
          }
          parseGarmentValues({ ...row, ...body });
        } catch { await json({ code: '22023', message: 'Request conflict' }, 400); return; }
        Object.assign(row, body, { field_provenance: provenance, version: Number(row.version) + 1, updated_at: new Date().toISOString() });
        await json(row); return;
      }
      const singular = request.headers().accept?.includes('vnd.pgrst.object');
      const ordered = [...rows];
      const order = url.searchParams.get('order');
      if (order) ordered.sort((a, b) => {
        for (const part of order.split(',')) {
          const [key, direction] = part.split('.');
          const left = String(a[key!]), right = String(b[key!]);
          const compare = left < right ? -1 : left > right ? 1 : 0;
          if (compare) return direction === 'desc' ? -compare : compare;
        }
        return 0;
      });
      const limit = url.searchParams.get('limit');
      const selected = limit ? ordered.slice(0, Number(limit)) : ordered;
      const select = url.searchParams.get('select');
      const projected = select ? selected.map(row => Object.fromEntries(select.split(',').filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))) : selected;
      await json(singular ? projected[0] ?? null : projected); return;
    }
    if (url.pathname === '/rest/v1/rpc/export_manifest') {
      const body = request.postDataJSON() as JsonRow;
      if (method !== 'POST' || Object.keys(body).length !== 1 || typeof body.p_export_id !== 'string') { await json({ code: '22023', message: 'Invalid input' }, 400); return; }
      exportControl.manifests++;
      const stamp = '2026-09-09T00:00:00Z';
      const fill = (table: keyof typeof rawColumns, rows: JsonRow[]) => rows.filter(row => row.owner_id === owner).map(row => Object.fromEntries(
        rawColumns[table].map(column => [column, Object.hasOwn(row, column) ? row[column] : column === 'created_at' || column === 'updated_at' ? stamp : null])));
      await json({ schema_version: 2, export_id: body.p_export_id, owner_id: owner, created_at: stamp, tables: {
        profiles: fill('profiles', [profiles[owner]!]), style_preferences: fill('style_preferences', [preferences[owner]!]), items: fill('items', items),
        item_images: fill('item_images', images), outfits: fill('outfits', outfits), outfit_items: fill('outfit_items', outfitItems),
        wear_events: fill('wear_events', wearEvents), wear_event_items: fill('wear_event_items', wearLinks),
        combination_rules: fill('combination_rules', combinationRules), suggestion_feedback: fill('suggestion_feedback', suggestionFeedback),
      } }); return;
    }
    if (url.pathname === '/rest/v1/rpc/item_attribution_history') {
      const body = request.postDataJSON() as JsonRow;
      exportControl.beforeAttribution?.();
      const item = items.find(row => row.id === body.p_item_id && row.owner_id === owner && row.deleted_at === null);
      if (method !== 'POST' || !item) { await json({ code: '42501', message: 'Not available', details: null, hint: null }, 403); return; }
      await json(exportControl.attributions.get(String(item.id)) ?? []); return;
    }
    if (url.pathname === '/rest/v1/rpc/update_image_description') {
      const body = request.postDataJSON() as JsonRow;
      if (method !== 'POST' || Object.keys(body).length !== 3 || typeof body.p_alt_text !== 'string'
        || [...body.p_alt_text].length > 240 || !Number.isInteger(body.p_expected_description_version)
        || Number(body.p_expected_description_version) < 1 || Number(body.p_expected_description_version) > 2147483647) {
        await json({ code: '22023', message: 'Invalid input' }, 400); return;
      }
      const image = images.find((row) => row.id === body.p_image_id && row.owner_id === owner && row.state === 'ready'
        && row.retired_at === null && items.some((item) => item.id === row.item_id && item.owner_id === owner && item.deleted_at === null));
      if (!image) { await json({ code: '42501', message: 'Not available' }, 403); return; }
      if (deletionClaims.has(String(image.item_id))) { await json({ code: '42501', message: 'Not available' }, 403); return; }
      if (image.description_version !== body.p_expected_description_version || image.description_version === 2147483647) {
        await json({ code: '22023', message: 'Request conflict' }, 400); return;
      }
      image.alt_text = body.p_alt_text; image.description_version = Number(image.description_version) + 1;
      await json([{ id: image.id, owner_id: owner, item_id: image.item_id, alt_text: image.alt_text, description_version: image.description_version }]); return;
    }
    if (url.pathname === '/rest/v1/rpc/commit_image') {
      if (options.failCommitOnce && !commitFailed) { commitFailed = true; await json({ message: 'Unavailable' }, 503); return; }
      const body = request.postDataJSON() as JsonRow;
      const image = images.find((row) => row.id === body.p_image_id && row.owner_id === owner);
      if (image && saves.some((save) => save.owner === owner && (save.itemId === image.item_id || save.imageId === image.id))) {
        await json({ code: '22023', message: 'Request conflict', details: null, hint: null }, 400); return;
      }
      if (!image || !files.has(String(image.main_path)) || !files.has(String(image.thumb_path))) { await json({ message: 'Upload incomplete' }, 400); return; }
      image.state = 'ready';
      await route.fulfill({ status: 204 }); return;
    }
    const prefix = '/storage/v1/object/wardrobe/';
    if (url.pathname.startsWith(prefix)) {
      const path = url.pathname.slice(prefix.length);
      if (!path.startsWith(`${owner}/`)) { await json({ statusCode: '403', message: 'Denied' }, 403, 'route-owner'); return; }
      if (method === 'POST') {
        if (deletionClaims.has(path.split('/')[1]!)) { await json({ statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' }, 400); return; }
        if (files.has(path)) { await json({ statusCode: '409', message: 'The resource already exists' }, 409, 'route-existing'); return; }
        if (url.search || receiver.reservedOwner(url.pathname) !== owner || !receiver.credentialsAllowed(request.headers(), owner)) {
          await json({ message: 'Fixture upload rejected.' }, 403, 'route-reservation-credentials'); return;
        }
        try { await route.continue({ url: receiver.url + url.pathname }); }
        catch { await receiver.close(); throw new Error('Fixture continuation failed.'); }
        return;
      }
      if (method === 'DELETE') {
        const item = items.find(row => row.id === path.split('/')[1] && row.owner_id === owner);
        const op = deletionOperations.find(value => value.owner === owner && value.receipt.itemId === item?.id && value.receipt.phase !== 'cancelled');
        const target = op?.targets.find(target => target.path === path);
        if (!item || (op ? !['authorized', 'removing_registered'].includes(op.receipt.phase) || !target?.authorized || target.absent
          || (target.category === 'registered') !== (op.receipt.phase === 'removing_registered')
          : !images.some(row => row.owner_id === owner && row.item_id === item.id && [row.main_path, row.thumb_path].includes(path)))) {
          await json({ statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' }, 400); return;
        }
        if (request.postData() !== null) { await json({ message: 'Invalid fixture delete' }, 400); return; }
        if (!files.delete(path)) { await json({ statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' }, 400); return; }
        if (options.lifecycleLoss === 'delete' && !lifecycleReplyLost) { lifecycleReplyLost = true; await route.abort('failed'); return; }
        await json({ message: 'Successfully deleted' }); return;
      }
      const bytes = files.get(path);
      if (!bytes) { await json({ message: 'Not found' }, 404); return; }
      await route.fulfill({ status: 200, body: bytes, contentType: 'image/jpeg' }); return;
    }
    if (url.pathname === '/storage/v1/object/wardrobe' && method === 'DELETE') { await json([]); return; }
    await json({ message: 'Unknown browser fixture route' }, 404);
  }).catch(async () => { await receiver.close(); throw new Error('Fixture routing unavailable.'); });
  return { restoreControl, profiles, preferences, items, images, wearEvents, wearLinks, outfits, outfitItems, combinationRules, suggestionFeedback, exportControl, feedbackControl, holdFeedbackReads, outfitControl, files, requests, fixture, deletionClaims, imageChanges, deletionOperations, uploadWire: receiver.state, wireDiagnostic,
    uploadWireUrl: receiver.url,
    analysisWire: receiver.analysisState, rawAnalysisObservation, admitAiStatus,
    statusProofs: (): readonly StatusProof[] => statusProofs.map((proof) => ({ ...proof })),
    seedSavedItem(account: 'a' | 'b' = 'a', title = 'Olive overshirt') {
      const owner = owners[account], id = randomUUID(), imageId = randomUUID(), now = '2026-09-09T00:00:00Z';
      const item = { ...itemDefaults(), id, owner_id: owner, title, category: 'top', version: 1,
        created_at: now, updated_at: now, deleted_at: null as string | null };
      const hash = createHash('sha256').update(fixture).digest('hex');
      const image = { id: imageId, owner_id: owner, item_id: id, state: 'ready', retired_at: null,
        alt_text: 'An olive overshirt', description_version: 1, created_at: now,
        main_path: `${owner}/${id}/${imageId}/main.jpg`, thumb_path: `${owner}/${id}/${imageId}/thumb.jpg`,
        main_sha256: hash, thumb_sha256: hash, main_bytes: fixture.length, thumb_bytes: fixture.length, width: 640, height: 800 };
      items.push(item); images.push(image);
      files.set(image.main_path, fixture); files.set(image.thumb_path, fixture);
      return { item, image };
    },
    issuedWireAuthorization(account: 'a' | 'b') {
      const authorization = [...tokens].find(([, owner]) => owner === owners[account])?.[0];
      if (!authorization) throw new Error('Fixture owner authorization unavailable.');
      return authorization;
    },
  };
}

export async function signIn(page: Page, account: 'a' | 'b' = 'a') {
  await page.locator('#email').fill(`user-${account}@example.test`);
  await page.locator('#password').fill('fictional-test-password');
  await page.locator('button[type="submit"]').click();
}
