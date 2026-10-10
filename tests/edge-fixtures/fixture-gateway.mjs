// CI-only PR-3b fixture gateway (rev5 A1). The only container on both the internal fixture network and the
// disposable stack network. One pinned upstream (the verified stack Kong); exact raw-target allowlist; no
// normalization, no redirects, no upstream chosen from the request. Never part of any deployment.
import { createServer, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

export const UPSTREAM_PORT = 8000;
export const INGRESS_PORT = 8081;
export const MAX_BODY_BYTES = 1024 * 1024;
/** Routes the fixture analyze-clothing, stylist-chat, enhance-photo and try-on runtime may reach, exact raw request target. */
export const ALLOWED_ROUTES = Object.freeze([
  'GET /auth/v1/user',
  'POST /rest/v1/rpc/ai_status',
  'POST /rest/v1/rpc/ai_claim_analysis',
  'POST /rest/v1/rpc/ai_analysis_status',
  'POST /rest/v1/rpc/ai_finish_analysis',
  'POST /rest/v1/rpc/stylist_status',
  'POST /rest/v1/rpc/stylist_claim',
  'POST /rest/v1/rpc/stylist_finish',
  'POST /rest/v1/rpc/enhance_status',
  'POST /rest/v1/rpc/enhance_claim',
  'POST /rest/v1/rpc/enhance_finish',
  'POST /rest/v1/rpc/tryon_status',
  'POST /rest/v1/rpc/tryon_claim',
  'POST /rest/v1/rpc/tryon_dispatch',
  'POST /rest/v1/rpc/tryon_finish',
]);
/**
 * The one pattern route: try-on's garment download, a stored main photo read with the owner's own JWT. Exactly an
 * owner/item/image UUID path ending main.jpg; no thumb, other bucket, extra segment or other method.
 */
const UUID_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const ALLOWED_PATTERNS = Object.freeze([
  new RegExp(`^GET /storage/v1/object/wardrobe/${UUID_SEGMENT}/${UUID_SEGMENT}/${UUID_SEGMENT}/main\\.jpg$`),
]);
export const FORWARDED_HEADERS = Object.freeze(['authorization', 'apikey', 'content-type', 'content-length', 'x-stillroom-ai-budget-contract']);
/** The only requests the host-side gate may send in, towards the fixture runtime. */
export const INGRESS_ROUTES = Object.freeze(['POST /functions/v1/analyze-clothing', 'POST /functions/v1/stylist-chat',
  'POST /functions/v1/enhance-photo', 'POST /functions/v1/try-on']);
export const INGRESS_HEADERS = Object.freeze([...FORWARDED_HEADERS,
  'x-stillroom-request-id', 'x-stillroom-draft-id', 'x-stillroom-generation']);
export const INGRESS_TARGET = 'http://edge-runtime:9000';
/** Response headers relayed back; the enhancement and try-on headers carry only a released photo's hash and expiry. */
export const RELAYED_RESPONSE_HEADERS = Object.freeze(['content-type', 'content-length', 'cache-control', 'x-content-type-options',
  'vary', 'x-stillroom-enhancement-sha256', 'x-stillroom-enhancement-usable-until', 'x-stillroom-tryon-sha256']);

const SUSPICIOUS = [/\.\./, /\/\//, /%2e/i, /%2f/i, /%5c/i, /;/, /\\/];
const header = (rawHeaders, name) => rawHeaders.filter((_, index) => index % 2 === 1
  && String(rawHeaders[index - 1]).toLowerCase() === name).map(String);
/**
 * Pure decision for one inbound request. `rawHeaders` is Node's flat [name, value, ...] list, so duplicate Host
 * headers stay visible. Returns 'forward' or the denial class.
 */
export function decide({ method, url, rawHeaders }, allowed = ALLOWED_ROUTES) {
  if (typeof method !== 'string' || typeof url !== 'string' || !Array.isArray(rawHeaders)) return 'malformed';
  if (method === 'CONNECT') return 'connect';
  if (!url.startsWith('/')) return 'absolute-form';
  if (SUSPICIOUS.some((pattern) => pattern.test(url))) return 'suspicious-path';
  if (header(rawHeaders, 'host').length !== 1) return 'host-count';
  if (header(rawHeaders, 'upgrade').length || header(rawHeaders, 'connection').some((value) => /upgrade/i.test(value))) return 'upgrade';
  const lengths = header(rawHeaders, 'content-length');
  if (header(rawHeaders, 'transfer-encoding').length || lengths.length > 1
    || lengths.some((value) => !/^[0-9]{1,8}$/.test(value) || Number(value) > MAX_BODY_BYTES)) return 'body-size';
  if (url.includes('?')) return 'query';
  const target = `${method} ${url}`;
  if (allowed.includes(target)) return 'forward';
  return allowed === ALLOWED_ROUTES && ALLOWED_PATTERNS.some((pattern) => pattern.test(target)) ? 'forward' : 'route';
}
/** Copies only allowlisted request headers; a duplicated allowlisted header returns null (refused). */
export function filterHeaders(rawHeaders, allowlist = FORWARDED_HEADERS) {
  const result = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    if (!allowlist.includes(name)) continue;
    if (Object.hasOwn(result, name)) return null;
    result[name] = String(rawHeaders[index + 1]);
  }
  return result;
}
/** Diagnostic reads on the ingress listener only; never forwarded. */
export const DIAGNOSTIC_ROUTES = Object.freeze(['GET /__config', 'GET /__forwarded']);
export function effectiveConfig(upstream) {
  return { upstream, routes: [...ALLOWED_ROUTES], patterns: ALLOWED_PATTERNS.map(String), headers: [...FORWARDED_HEADERS],
    maxBodyBytes: MAX_BODY_BYTES, diagnostics: [...DIAGNOSTIC_ROUTES],
    ingress: { routes: [...INGRESS_ROUTES], headers: [...INGRESS_HEADERS], target: INGRESS_TARGET } };
}
/** Upstream 3xx is never followed; it becomes 502. */
export const relayedStatus = (status) => (Number.isInteger(status) && status >= 200 && status < 600
  && !(status >= 300 && status < 400) ? status : 502);

function deny(res, reason) {
  res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(JSON.stringify({ code: 'EDGE_GATEWAY_DENIED', reason }));
}
function relay(req, res, target, headers) {
  let size = 0;
  const outbound = httpRequest(target, { method: req.method, headers, timeout: 20_000 }, (upstream) => {
    const status = relayedStatus(upstream.statusCode);
    const back = {};
    if (status === upstream.statusCode) {
      for (const name of RELAYED_RESPONSE_HEADERS) {
        if (upstream.headers[name] !== undefined) back[name] = upstream.headers[name];
      }
    }
    res.writeHead(status, back);
    if (status === upstream.statusCode) upstream.pipe(res);
    else { upstream.resume(); res.end(); }
  });
  outbound.on('timeout', () => outbound.destroy(new Error('timeout')));
  outbound.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { outbound.destroy(); req.destroy(); return; }
    outbound.write(chunk);
  });
  req.on('end', () => outbound.end());
}
function refuseSocket(_req, socket) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }

function main() {
  const upstream = process.env.EDGE_GATEWAY_UPSTREAM ?? '';
  if (!/^http:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}:8000$/.test(upstream)) {
    console.error('EDGE-GATEWAY refused: upstream must be a pinned IPv4 Kong address');
    process.exit(2);
  }
  const config = effectiveConfig(upstream);
  // Every request actually sent to the upstream Kong, in order (bounded), so denied probes can be proven unforwarded.
  const forwarded = [];
  // Towards Kong, for the fixture runtime, which reaches this listener as `kong:8000` on the internal network.
  createServer((req, res) => {
    const verdict = decide(req);
    const headers = verdict === 'forward' ? filterHeaders(req.rawHeaders) : null;
    if (verdict !== 'forward' || headers === null) { deny(res, verdict === 'forward' ? 'header-duplicate' : verdict); return; }
    if (forwarded.length < 10_000) forwarded.push(`${req.method} ${req.url}`);
    relay(req, res, `${upstream}${req.url}`, headers);
  }).on('connect', refuseSocket).on('upgrade', refuseSocket).listen(UPSTREAM_PORT, '0.0.0.0');
  // Towards the fixture runtime, for the host-side normal-session gate only.
  createServer((req, res) => {
    if (decide(req, ['GET /__config']) === 'forward') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(config));
      return;
    }
    if (decide(req, ['GET /__forwarded']) === 'forward') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(forwarded));
      return;
    }
    const verdict = decide(req, INGRESS_ROUTES);
    const headers = verdict === 'forward' ? filterHeaders(req.rawHeaders, INGRESS_HEADERS) : null;
    if (verdict !== 'forward' || headers === null) { deny(res, verdict === 'forward' ? 'header-duplicate' : verdict); return; }
    relay(req, res, `${INGRESS_TARGET}${req.url}`, headers);
  }).on('connect', refuseSocket).on('upgrade', refuseSocket).listen(INGRESS_PORT, '0.0.0.0');
  console.log('EDGE-GATEWAY listening');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
