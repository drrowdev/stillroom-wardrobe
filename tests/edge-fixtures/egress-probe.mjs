// CI-only PR-3b egress and forbidden-route probe. Runs with Node inside the fixture runtime's network namespace
// (`--network container:<runtime>`); raw TCP/DNS/HTTP only, never TLS or a real provider.
import { connect } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

// Host paths (review finding 1): the host canary listens on 0.0.0.0 and the stack API is published on the host,
// so each host-held bridge address (fixture bridge gateway, docker0, stack network gateway) and 0.0.0.0 must be dark.
export const HOST_TARGETS = Object.freeze(['tcp-host-bridge-canary', 'tcp-host-bridge-api', 'tcp-host-docker0-canary',
  'tcp-host-docker0-api', 'tcp-host-stack-canary', 'tcp-host-stack-api', 'tcp-zero-canary']);
export const PROBE_TARGETS = Object.freeze(['tcp-canary', 'dns-canary', 'tcp-public', 'tcp-kong-direct', ...HOST_TARGETS]);
export const NETWORK_FAILURES = Object.freeze(['refused', 'unreachable', 'timeout']);
const PUBLIC_IP = '1.1.1.1';

export function socketOutcome(code) {
  if (code === 'ECONNREFUSED') return 'refused';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN'].includes(code)) return 'unreachable';
  if (['ETIMEDOUT', 'ETIMEOUT', 'TIMEOUT'].includes(code)) return 'timeout';
  return 'error';
}
export function dnsOutcome(code) {
  if (code === null) return 'connected';
  // Any DNS answer, even a negative one, proves the query reached a resolver.
  if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'EFORMERR', 'ENOTIMP', 'EBADRESP'].includes(code)) return 'connected';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEOUT') return 'timeout';
  return 'error';
}

/** The denied request classes (rev5 A1) and the two allowed controls. `needle` is searched in the Kong log. */
export function routeCases(nonce) {
  const n = String(nonce);
  const get = (target, extra = '') => `GET ${target} HTTP/1.1\r\nHost: kong:8000\r\n${extra}Connection: close\r\n\r\n`;
  return [
    { class: 'route-functions', raw: get(`/functions/v1/${n}`), needle: n, expect: 'denied' },
    { class: 'route-auth-admin', raw: get(`/auth/v1/admin/${n}`), needle: n, expect: 'denied' },
    { class: 'route-pg', raw: get(`/pg/${n}`), needle: n, expect: 'denied' },
    { class: 'route-storage', raw: get(`/storage/v1/object/${n}`), needle: n, expect: 'denied' },
    { class: 'route-other-rpc', raw: `POST /rest/v1/rpc/${n} HTTP/1.1\r\nHost: kong:8000\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`, needle: n, expect: 'denied' },
    { class: 'method', raw: `DELETE /auth/v1/user HTTP/1.1\r\nHost: kong:8000\r\nConnection: close\r\n\r\n`, needle: '"DELETE /auth/v1/user', expect: 'denied' },
    { class: 'connect', raw: `CONNECT ${n}.invalid:443 HTTP/1.1\r\nHost: ${n}.invalid:443\r\n\r\n`, needle: n, expect: 'denied' },
    { class: 'absolute-form', raw: get(`http://${n}.invalid/auth/v1/user`), needle: n, expect: 'denied' },
    { class: 'dot-dot', raw: get(`/auth/v1/../${n}`), needle: n, expect: 'denied' },
    { class: 'double-slash', raw: get(`//${n}`), needle: n, expect: 'denied' },
    { class: 'pct-2e', raw: get(`/auth/v1/%2e%2e/${n}`), needle: n, expect: 'denied' },
    { class: 'pct-2f', raw: get(`/auth/v1%2f${n}`), needle: n, expect: 'denied' },
    { class: 'pct-5c', raw: get(`/auth/v1%5c${n}`), needle: n, expect: 'denied' },
    { class: 'semicolon', raw: get(`/auth/v1/user;${n}`), needle: n, expect: 'denied' },
    { class: 'backslash', raw: get(`/auth/v1\\${n}`), needle: n, expect: 'denied', parserMay400: true },
    { class: 'auth-query', raw: get(`/auth/v1/user?${n}`), needle: n, expect: 'denied' },
    { class: 'host-count', raw: `POST /rest/v1/rpc/ai_finish_analysis HTTP/1.1\r\nHost: kong:8000\r\nHost: ${n}.invalid\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      needle: '"POST /rest/v1/rpc/ai_finish_analysis', expect: 'denied', parserMay400: true },
    { class: 'body-size', raw: `POST /rest/v1/rpc/ai_claim_analysis HTTP/1.1\r\nHost: kong:8000\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n`,
      needle: '"POST /rest/v1/rpc/ai_claim_analysis', expect: 'denied' },
    { class: 'upgrade', raw: `POST /rest/v1/rpc/ai_analysis_status HTTP/1.1\r\nHost: kong:8000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nContent-Length: 0\r\n\r\n`,
      needle: '"POST /rest/v1/rpc/ai_analysis_status', expect: 'denied' },
    { class: 'allowed-auth', raw: get('/auth/v1/user'), needle: '"GET /auth/v1/user', expect: 'allowed' },
    { class: 'allowed-rpc', raw: `POST /rest/v1/rpc/ai_status HTTP/1.1\r\nHost: kong:8000\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      needle: '"POST /rest/v1/rpc/ai_status', expect: 'allowed' },
  ];
}

/**
 * Verdict over the probe's stdout (rev5 A1). PASS only if every target is present exactly once with a
 * network-level failure; any connection is FAIL; a crash, missing tool, malformed output or missing target is BLOCKED.
 */
export function probeVerdict({ code, stdout }, nonce) {
  if (code !== 0 || typeof stdout !== 'string') return { verdict: 'BLOCKED', reason: 'probe-exit' };
  const probes = [], routes = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue;
    const match = /^(EDGE-PROBE|EDGE-ROUTE) (\{.*\})$/.exec(line);
    if (!match) return { verdict: 'BLOCKED', reason: 'malformed-output' };
    let value;
    try { value = JSON.parse(match[2]); } catch { return { verdict: 'BLOCKED', reason: 'malformed-output' }; }
    (match[1] === 'EDGE-PROBE' ? probes : routes).push(value);
  }
  const cases = routeCases(nonce);
  for (const target of PROBE_TARGETS) {
    if (probes.filter((p) => p?.target === target).length !== 1) return { verdict: 'BLOCKED', reason: `missing-${target}` };
  }
  if (probes.length !== PROBE_TARGETS.length) return { verdict: 'BLOCKED', reason: 'unexpected-target' };
  if (probes.some((p) => p.outcome === 'connected')) return { verdict: 'FAIL', reason: 'egress-connected' };
  if (probes.some((p) => !NETWORK_FAILURES.includes(p.outcome))) return { verdict: 'BLOCKED', reason: 'probe-error' };
  for (const item of cases) {
    const seen = routes.filter((r) => r?.class === item.class);
    if (seen.length !== 1 || !Number.isInteger(seen[0].status)) return { verdict: 'BLOCKED', reason: `missing-route-${item.class}` };
    const status = seen[0].status;
    const ok = item.expect === 'allowed' ? status !== 403 && status > 0
      : status === 403 || item.parserMay400 === true && status === 400;
    if (!ok) return { verdict: 'FAIL', reason: `route-${item.class}-${status}` };
  }
  if (routes.length !== cases.length) return { verdict: 'BLOCKED', reason: 'unexpected-route' };
  return { verdict: 'PASS', reason: 'dark' };
}
/**
 * Gateway upstream record around the probe: exactly the allowed controls were forwarded and no request carrying the
 * nonce reached Kong. Covers the parser-400 classes too, which the gateway itself never answered. Missing data is BLOCKED.
 */
export function upstreamVerdict(before, after, nonce) {
  if (!Array.isArray(before) || !Array.isArray(after) || after.length < before.length
    || !before.every((entry, index) => after[index] === entry)) return { verdict: 'BLOCKED', reason: 'gateway-record' };
  const delta = after.slice(before.length);
  if (delta.some((entry) => typeof entry !== 'string' || entry.includes(String(nonce)))) return { verdict: 'FAIL', reason: 'nonce-forwarded' };
  const expected = ['GET /auth/v1/user', 'POST /rest/v1/rpc/ai_status'];
  if (JSON.stringify([...delta].sort()) !== JSON.stringify(expected)) return { verdict: 'FAIL', reason: 'unexpected-forward' };
  return { verdict: 'PASS', reason: 'allowed-controls-only' };
}
/** Kong access-log check: denied needles never reach Kong, allowed needles do. No Kong log at all is BLOCKED. */
export function kongLogVerdict(logText, nonce) {
  if (typeof logText !== 'string' || !/"(GET|POST) \//.test(logText)) return { verdict: 'BLOCKED', reason: 'kong-log-empty' };
  for (const item of routeCases(nonce)) {
    const present = logText.includes(item.needle);
    if (item.expect === 'denied' && present) return { verdict: 'FAIL', reason: `kong-saw-${item.class}` };
    if (item.expect === 'allowed' && !present) return { verdict: 'BLOCKED', reason: `kong-missing-${item.class}` };
  }
  return { verdict: 'PASS', reason: 'allowlist-only' };
}

function tcp(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome, error) => { socket.destroy(); resolve({ outcome, error }); };
    socket.setTimeout(ms, () => done('timeout', 'TIMEOUT'));
    socket.once('connect', () => done('connected', null));
    socket.once('error', (error) => done(socketOutcome(error.code), String(error.code ?? 'error')));
  });
}
function raw(host, text, ms = 5000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 8000 });
    let data = '';
    const done = () => { socket.destroy(); const m = /^HTTP\/1\.[01] ([0-9]{3})/.exec(data); resolve(m ? Number(m[1]) : 0); };
    socket.setTimeout(ms, done);
    socket.on('data', (chunk) => { data += chunk.toString('latin1'); if (/\r\n/.test(data)) done(); });
    socket.once('error', done);
    socket.once('connect', () => socket.write(text, 'latin1'));
    socket.once('close', done);
  });
}
async function main() {
  const { EDGE_CANARY_IP: canary, EDGE_GATEWAY_IP: gateway, EDGE_KONG_IP: kong, EDGE_PROBE_NONCE: nonce,
    EDGE_BRIDGE_GW: bridge, EDGE_DOCKER0_GW: docker0, EDGE_STACK_GW: stack } = process.env;
  const hostPort = Number(process.env.EDGE_HOST_PORT), apiPort = Number(process.env.EDGE_API_PORT);
  const ip = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  const port = (value) => Number.isInteger(value) && value > 0 && value < 65536;
  if (![canary, gateway, kong, bridge, docker0, stack].every((value) => ip.test(value ?? '')) || !port(hostPort) || !port(apiPort)
    || !/^[a-z0-9]{16,40}$/.test(nonce ?? '')) process.exit(2);
  const print = (kind, value) => console.log(`${kind} ${JSON.stringify(value)}`);
  print('EDGE-PROBE', { target: 'tcp-canary', ...await tcp(canary, 8443) });
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([`${canary}:5300`]);
  let dnsCode = null;
  try { await resolver.resolve4('edge-canary.example.test'); } catch (error) { dnsCode = String(error.code ?? 'error'); }
  print('EDGE-PROBE', { target: 'dns-canary', outcome: dnsOutcome(dnsCode), error: dnsCode });
  print('EDGE-PROBE', { target: 'tcp-public', ...await tcp(PUBLIC_IP, 443) });
  print('EDGE-PROBE', { target: 'tcp-kong-direct', ...await tcp(kong, 8000) });
  for (const [name, host] of [['bridge', bridge], ['docker0', docker0], ['stack', stack]]) {
    print('EDGE-PROBE', { target: `tcp-host-${name}-canary`, ...await tcp(host, hostPort) });
    print('EDGE-PROBE', { target: `tcp-host-${name}-api`, ...await tcp(host, apiPort) });
  }
  print('EDGE-PROBE', { target: 'tcp-zero-canary', ...await tcp('0.0.0.0', hostPort) });
  for (const item of routeCases(nonce)) print('EDGE-ROUTE', { class: item.class, status: await raw(gateway, item.raw) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
