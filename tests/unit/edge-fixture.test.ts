import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as gateway from '../../tests/edge-fixtures/fixture-gateway.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as double from '../../tests/edge-fixtures/provider-double.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as probe from '../../tests/edge-fixtures/egress-probe.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { canaryHits } from '../../tests/edge-fixtures/canary.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as controller from '../../scripts/edge-fixture.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as deploy from '../../scripts/check-deploy-artifacts.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { EDGE_DELEGATIONS, delegatedLine } from '../../tests/security/edge-delegations.mjs';
import { AZURE_REVIEW_EXPIRES } from '../../supabase/functions/analyze-clothing/azure-openai';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { analysisFacts } from '../integration/ai-analysis.sessions.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');
const request = (method: string, url: string, extra: string[] = []) =>
  ({ method, url, rawHeaders: ['Host', 'kong:8000', ...extra] });

describe('fixture gateway (rev5 A1)', () => {
  it('forwards only the exact allowlisted routes', () => {
    for (const route of gateway.ALLOWED_ROUTES as string[]) {
      const [method, url] = route.split(' ') as [string, string];
      expect(gateway.decide(request(method, url))).toBe('forward');
    }
    expect(gateway.decide(request('DELETE', '/auth/v1/user'))).toBe('route');
    expect(gateway.decide(request('GET', '/auth/v1/admin/users'))).toBe('route');
    expect(gateway.decide(request('POST', '/rest/v1/rpc/ai_begin_request'))).toBe('route');
    expect(gateway.decide(request('GET', '/storage/v1/object/x'))).toBe('route');
  });
  it('classifies every denied request shape before routing', () => {
    expect(gateway.decide({ method: 'CONNECT', url: 'x.invalid:443', rawHeaders: ['Host', 'x'] })).toBe('connect');
    expect(gateway.decide(request('GET', 'http://x.invalid/auth/v1/user'))).toBe('absolute-form');
    for (const url of ['/auth/v1/../x', '//x', '/auth/v1/%2e%2e/x', '/auth/v1%2Fx', '/auth/v1%5cx', '/auth/v1/user;x', '/auth/v1\\x']) {
      expect(gateway.decide(request('GET', url))).toBe('suspicious-path');
    }
    expect(gateway.decide({ method: 'GET', url: '/auth/v1/user', rawHeaders: [] })).toBe('host-count');
    expect(gateway.decide(request('GET', '/auth/v1/user', ['Host', 'evil.invalid']))).toBe('host-count');
    expect(gateway.decide(request('GET', '/auth/v1/user', ['Upgrade', 'websocket']))).toBe('upgrade');
    expect(gateway.decide(request('GET', '/auth/v1/user', ['Connection', 'keep-alive, Upgrade']))).toBe('upgrade');
    expect(gateway.decide(request('POST', '/rest/v1/rpc/ai_status', ['Transfer-Encoding', 'chunked']))).toBe('body-size');
    expect(gateway.decide(request('POST', '/rest/v1/rpc/ai_status', ['Content-Length', '1048577']))).toBe('body-size');
    expect(gateway.decide(request('POST', '/rest/v1/rpc/ai_status', ['Content-Length', '2', 'Content-Length', '2']))).toBe('body-size');
    expect(gateway.decide(request('POST', '/rest/v1/rpc/ai_status', ['Content-Length', '1048576']))).toBe('forward');
    expect(gateway.decide(request('GET', '/auth/v1/user?x=1'))).toBe('query');
    expect(gateway.decide({ method: 'GET', url: null, rawHeaders: [] })).toBe('malformed');
  });
  it('copies only allowlisted headers and refuses duplicates', () => {
    expect(gateway.filterHeaders(['Authorization', 'Bearer t', 'Cookie', 'c', 'X-Forwarded-Host', 'evil', 'apikey', 'k']))
      .toEqual({ authorization: 'Bearer t', apikey: 'k' });
    expect(gateway.filterHeaders(['Authorization', 'a', 'authorization', 'b'])).toBeNull();
  });
  it('never relays redirects and publishes its effective config', () => {
    expect([200, 204, 401, 404, 500].map(gateway.relayedStatus)).toEqual([200, 204, 401, 404, 500]);
    expect([301, 302, 307, 308, 100, 600, Number.NaN].map(gateway.relayedStatus)).toEqual(Array(7).fill(502));
    const config = gateway.effectiveConfig('http://10.0.0.2:8000');
    expect(config.upstream).toBe('http://10.0.0.2:8000');
    expect(config.routes).toEqual([...gateway.ALLOWED_ROUTES]);
    expect(config.diagnostics).toEqual(['GET /__config', 'GET /__forwarded']);
    for (const route of config.diagnostics as string[]) expect(gateway.ALLOWED_ROUTES).not.toContain(route);
    expect(config.ingress).toEqual({ route: 'POST /functions/v1/analyze-clothing', headers: [...gateway.INGRESS_HEADERS],
      target: 'http://edge-runtime:9000' });
  });
  it('allowlists exactly the backend calls the analyze handler makes', async () => {
    const source = await read('supabase/functions/analyze-clothing/handler.ts');
    const rpcs = [...source.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => `POST /rest/v1/rpc/${m[1]}`);
    expect(source).toContain('/auth/v1/user');
    expect(new Set(['GET /auth/v1/user', ...rpcs])).toEqual(new Set(gateway.ALLOWED_ROUTES));
  });
});

function jpeg(width: number) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10,
    width >> 8, width & 0xff, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}
const azureBody = (bytes: Buffer, change: Record<string, unknown> = {}) => JSON.stringify({ model: double.DEPLOYMENT,
  stream: false, n: 1, store: false, messages: [{}, { content: [{ image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }] }],
  ...change });
const headers = { 'api-key': 'local-dummy-not-a-credential', 'content-type': 'application/json' };

describe('provider double', () => {
  it('reads the frame width and selects the mode', () => {
    expect(double.jpegWidth(jpeg(120))).toBe(120);
    expect(double.jpegWidth(Buffer.from([1, 2, 3, 4]))).toBeNull();
    expect(double.requestMode(headers, azureBody(jpeg(120)))).toBe('ready');
    expect(double.requestMode(headers, azureBody(jpeg(121)))).toBe('unclear');
    expect(double.requestMode(headers, azureBody(jpeg(122)))).toBe('malformed');
    expect(double.requestMode(headers, azureBody(jpeg(123)))).toBe('server-error');
  });
  it('refuses anything that is not the pinned request shape', () => {
    expect(double.requestMode({ ...headers, 'api-key': 'real' }, azureBody(jpeg(120)))).toBeNull();
    expect(double.requestMode(headers, azureBody(jpeg(120), { model: 'other' }))).toBeNull();
    expect(double.requestMode(headers, azureBody(jpeg(120), { store: true }))).toBeNull();
    expect(double.requestMode(headers, azureBody(Buffer.from('not a jpeg')))).toBeNull();
    expect(double.requestMode(headers, '{')).toBeNull();
  });
  it('names a content-free reason for each refusal', () => {
    const reason = (h: Record<string, string>, text: string) => double.requestVerdict(h, text).reason;
    expect(reason({ ...headers, 'api-key': 'real' }, azureBody(jpeg(120)))).toBe('api-key');
    expect(reason({ ...headers, 'content-type': 'text/plain' }, azureBody(jpeg(120)))).toBe('content-type');
    expect(reason(headers, '')).toBe('empty-body');
    expect(reason(headers, '{')).toBe('json');
    expect(reason(headers, azureBody(jpeg(120), { n: 2 }))).toBe('parameters');
    expect(reason(headers, azureBody(Buffer.from('not a jpeg')))).toBe('jpeg');
    expect(double.requestVerdict(headers, azureBody(jpeg(120)))).toEqual({ mode: 'ready' });
  });
  it('returns the production-shaped facts', () => {
    expect(double.READY_FACTS).toEqual(analysisFacts);
    expect(JSON.parse(double.completion('ready').choices[0].message.content)).toEqual(analysisFacts);
    expect(() => JSON.parse(double.completion('malformed').choices[0].message.content)).toThrow();
  });
});

const nonce = 'n0nce';
const probes = (outcome = 'refused') => (probe.PROBE_TARGETS as string[]).map((target) => `EDGE-PROBE ${JSON.stringify({ target, outcome })}`);
const routes = (status: (c: { class: string; expect: string }) => number = (c) => (c.expect === 'allowed' ? 401 : 403)) =>
  (probe.routeCases(nonce) as { class: string; expect: string }[]).map((c) => `EDGE-ROUTE ${JSON.stringify({ class: c.class, status: status(c) })}`);
const verdict = (lines: string[], code = 0) => probe.probeVerdict({ code, stdout: `${lines.join('\n')}\n` }, nonce).verdict;

describe('egress probe verdict (rev5 A1)', () => {
  it('passes only when every target fails at the network level and every route behaves', () => {
    expect(verdict([...probes(), ...routes()])).toBe('PASS');
    expect(verdict([...probes('timeout'), ...routes()])).toBe('PASS');
  });
  it('covers every host path and fails when any of them connects', () => {
    for (const target of ['tcp-host-bridge-canary', 'tcp-host-bridge-api', 'tcp-host-docker0-canary', 'tcp-host-docker0-api',
      'tcp-host-stack-canary', 'tcp-host-stack-api', 'tcp-zero-canary']) {
      expect(probe.PROBE_TARGETS).toContain(target);
      const lines = probes().map((line) => (line.includes(`"${target}"`) ? line.replace('refused', 'connected') : line));
      expect(verdict([...lines, ...routes()]), target).toBe('FAIL');
      expect(verdict([...probes().filter((line) => !line.includes(`"${target}"`)), ...routes()]), target).toBe('BLOCKED');
    }
  });
  it('fails on any connection or any denied route that was forwarded', () => {
    const connected = probes(); connected[0] = (connected[0] ?? '').replace('refused', 'connected');
    expect(verdict([...connected, ...routes()])).toBe('FAIL');
    expect(verdict([...probes(), ...routes((c) => (c.class === 'route-pg' ? 404 : c.expect === 'allowed' ? 401 : 403))])).toBe('FAIL');
    expect(verdict([...probes(), ...routes((c) => (c.expect === 'allowed' ? 403 : 403))])).toBe('FAIL');
    expect(verdict([...probes(), ...routes((c) => (c.class === 'dot-dot' ? 400 : c.expect === 'allowed' ? 401 : 403))])).toBe('FAIL');
  });
  it('accepts a parser 400 only for the flagged classes', () => {
    expect(verdict([...probes(), ...routes((c) => (['backslash', 'host-count'].includes(c.class) ? 400 : c.expect === 'allowed' ? 401 : 403))])).toBe('PASS');
  });
  it('is BLOCKED on missing evidence, never PASS', () => {
    expect(verdict([...probes(), ...routes()], 1)).toBe('BLOCKED');
    expect(verdict([...probes().slice(1), ...routes()])).toBe('BLOCKED');
    expect(verdict([...probes(), ...routes().slice(1)])).toBe('BLOCKED');
    expect(verdict([...probes('error'), ...routes()])).toBe('BLOCKED');
    expect(verdict([...probes(), ...routes(), 'noise'])).toBe('BLOCKED');
    expect(probe.probeVerdict({ code: 0, stdout: undefined }, nonce).verdict).toBe('BLOCKED');
  });
  it('maps socket and DNS failures conservatively', () => {
    expect(probe.socketOutcome('ECONNREFUSED')).toBe('refused');
    expect(probe.socketOutcome('ENETUNREACH')).toBe('unreachable');
    expect(probe.socketOutcome('EWHATEVER')).toBe('error');
    expect(probe.dnsOutcome('ENOTFOUND')).toBe('connected');
    expect(probe.dnsOutcome(null)).toBe('connected');
    expect(probe.dnsOutcome('ETIMEOUT')).toBe('timeout');
  });
  it('checks the Kong access log for denied and allowed needles', () => {
    const allowed = '"GET /auth/v1/user HTTP/1.1" 401\n"POST /rest/v1/rpc/ai_status HTTP/1.1" 200\n';
    expect(probe.kongLogVerdict(allowed, nonce).verdict).toBe('PASS');
    expect(probe.kongLogVerdict(`${allowed}"GET /pg/${nonce} HTTP/1.1" 404\n`, nonce).verdict).toBe('FAIL');
    expect(probe.kongLogVerdict('"GET /auth/v1/user HTTP/1.1" 401\n', nonce).verdict).toBe('BLOCKED');
    expect(probe.kongLogVerdict('', nonce).verdict).toBe('BLOCKED');
  });
  it('proves from the gateway record that no denied probe reached any upstream', () => {
    const allowed = ['GET /auth/v1/user', 'POST /rest/v1/rpc/ai_status'];
    expect(probe.upstreamVerdict(['GET /auth/v1/user'], ['GET /auth/v1/user', ...allowed.reverse()], nonce).verdict).toBe('PASS');
    expect(probe.upstreamVerdict([], [...allowed, `GET /auth/v1\\${nonce}`], nonce).verdict).toBe('FAIL');
    expect(probe.upstreamVerdict([], [...allowed, 'POST /rest/v1/rpc/ai_finish_analysis'], nonce).verdict).toBe('FAIL');
    expect(probe.upstreamVerdict([], ['GET /auth/v1/user'], nonce).verdict).toBe('FAIL');
    expect(probe.upstreamVerdict(null, allowed, nonce).verdict).toBe('BLOCKED');
    expect(probe.upstreamVerdict(['GET /x'], allowed, nonce).verdict).toBe('BLOCKED');
  });
  it('counts canary hits', () => {
    expect(canaryHits('EDGE-CANARY listening\nEDGE-CANARY-HIT tcp\nEDGE-CANARY-HIT dns-udp\n')).toBe(2);
    expect(canaryHits(undefined)).toBeNull();
  });
});

describe('privileged controller', () => {
  it('blocks the gate once the Azure review has expired', () => {
    expect(controller.reviewGate(AZURE_REVIEW_EXPIRES - 1)).toBe('open');
    expect(controller.reviewGate(AZURE_REVIEW_EXPIRES)).toBe('blocked');
    expect(controller.reviewGate(Date.now(), Number.NaN)).toBe('blocked');
  });
  it('accepts only the closed operations for the fixed owners', () => {
    expect(controller.validOperation({ type: 'op', id: 1, op: 'freeze', owner: 'A' })).toBe(true);
    expect(controller.validOperation({ type: 'op', id: 2, op: 'count' })).toBe(true);
    expect(controller.validOperation({ type: 'op', id: 3, op: 'freeze', owner: 'C' })).toBe(false);
    expect(controller.validOperation({ type: 'op', id: 4, op: 'freeze', owner: 'A', sql: 'select 1' })).toBe(false);
    expect(controller.validOperation({ type: 'op', id: 5, op: 'count', owner: 'A' })).toBe(false);
    expect(controller.validOperation({ type: 'op', id: 6, op: 'sql' })).toBe(false);
    expect(controller.validOperation({ type: 'op', id: 1.5, op: 'count' })).toBe(false);
  });
  it('rejects any topology other than the isolated one', () => {
    const c = controller.CONTAINERS;
    type Box = { networks: string[]; published: boolean; env: string[]; running: boolean };
    const good = (): Record<string, Box> => ({
      [c.double]: { networks: [controller.FIXTURE_NETWORK], published: false, env: [], running: true },
      [c.runtime]: { networks: [controller.FIXTURE_NETWORK], published: false, env: [], running: true },
      [c.gateway]: { networks: [controller.STACK_NETWORK, controller.FIXTURE_NETWORK], published: false, env: [], running: true },
      [c.canary]: { networks: [controller.CANARY_NETWORK], published: false, env: [], running: true },
    });
    const isolatedNet = { internal: true, ipv6: false, options: { [controller.GATEWAY_MODE_OPTION]: 'isolated' } };
    const networks = { [controller.FIXTURE_NETWORK]: isolatedNet, [controller.CANARY_NETWORK]: { internal: false } };
    expect(controller.topologyProblems(good(), networks)).toEqual([]);
    const wide = good(); wide[c.runtime]!.networks.push(controller.STACK_NETWORK);
    expect(controller.topologyProblems(wide, networks)).toContain(`${c.runtime}: networks`);
    const proxy = good(); proxy[c.runtime]!.env.push('HTTPS_PROXY=http://x');
    expect(controller.topologyProblems(proxy, networks)).toContain(`${c.runtime}: proxy env`);
    const published = good(); published[c.gateway]!.published = true;
    expect(controller.topologyProblems(published, networks)).toContain(`${c.gateway}: published ports`);
    expect(controller.topologyProblems(good(), { ...networks, [controller.FIXTURE_NETWORK]: { ...isolatedNet, internal: false } }))
      .toContain('fixture network is not internal');
    expect(controller.topologyProblems(good(), { ...networks, [controller.FIXTURE_NETWORK]: { internal: true, ipv6: false, options: {} } }))
      .toContain('fixture network gateway mode is not isolated');
    expect(controller.topologyProblems(good(), { ...networks, [controller.FIXTURE_NETWORK]: { ...isolatedNet,
      options: { [controller.GATEWAY_MODE_OPTION]: 'nat' } } })).toContain('fixture network gateway mode is not isolated');
    expect(controller.topologyProblems(good(), { ...networks, [controller.FIXTURE_NETWORK]: { ...isolatedNet, ipv6: true } }))
      .toContain('fixture network has IPv6');
    const missing = good(); delete missing[c.canary];
    expect(controller.topologyProblems(missing, networks)).toContain(`${c.canary}: missing`);
  });
  it('proves host-input isolation only from a failed bind and no host address in the fixture subnet', () => {
    expect(controller.inSubnet('172.20.0.1', '172.20.0.0/16')).toBe(true);
    expect(controller.inSubnet('172.21.0.1', '172.20.0.0/16')).toBe(false);
    expect(controller.inSubnet('172.20.0.1', 'nonsense')).toBeNull();
    expect(controller.firstHost('172.20.0.0/16')).toBe('172.20.0.1');
    expect(controller.firstHost('10.1.2.128/25')).toBe('10.1.2.129');
    const good = { subnet: '172.20.0.0/16', gateway: '172.20.0.1', hostAddresses: ['127.0.0.1', '172.17.0.1', '10.1.0.4'], bindCode: 'EADDRNOTAVAIL' };
    expect(controller.hostIsolationProblems(good)).toEqual([]);
    expect(controller.hostIsolationProblems({ ...good, bindCode: null })).toContain('host bind on fixture gateway: bound');
    expect(controller.hostIsolationProblems({ ...good, bindCode: 'EACCES' })).toContain('host bind on fixture gateway: EACCES');
    expect(controller.hostIsolationProblems({ ...good, hostAddresses: [...good.hostAddresses, '172.20.0.1'] }))
      .toContain('host holds a fixture-subnet address');
    expect(controller.hostIsolationProblems({ ...good, hostAddresses: [] })).toContain('host addresses unavailable');
    expect(controller.hostIsolationProblems({ ...good, subnet: null })).toContain('fixture gateway address not verified');
  });
  it('accepts the runtime only by the pinned digest', () => {
    const digest = controller.EDGE_RUNTIME_DIGEST;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(controller.pinnedRuntimeReference([`public.ecr.aws/supabase/edge-runtime@${digest}`])).toBe(`public.ecr.aws/supabase/edge-runtime@${digest}`);
    expect(controller.pinnedRuntimeReference([`ghcr.io/supabase/edge-runtime@${digest}`])).toBe(`ghcr.io/supabase/edge-runtime@${digest}`);
    expect(controller.pinnedRuntimeReference([`public.ecr.aws/supabase/edge-runtime@sha256:${'0'.repeat(64)}`])).toBeNull();
    expect(controller.pinnedRuntimeReference([`evil.example/supabase/edge-runtime@${digest}`])).toBeNull();
    expect(controller.pinnedRuntimeReference(null)).toBeNull();
  });
  it('keeps the fixture markers where the deploy check looks for them', async () => {
    expect(await read('tests/edge-fixtures/analyze-clothing-double/index.ts')).toContain('local-dummy-not-a-credential');
    expect(await read('scripts/edge-fixture.mjs')).toContain('stillroom-edge-gate-activation');
    expect(double.DUMMY_API_KEY).toBe('local-dummy-not-a-credential');
  });
  it('names a delegated line for every I17 delegation', () => {
    for (const key of Object.keys(EDGE_DELEGATIONS)) expect(delegatedLine(key)).toMatch(new RegExp(`^DELEGATED: .+ -> test:edge EDGE-RUNTIME ${key}$`));
  });
});

describe('deploy-artifact check (rev5 A2)', () => {
  let temp: string | null = null;
  afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = null; });
  async function repo(files: Record<string, string>) {
    temp = await mkdtemp(path.join(tmpdir(), 'deploy-check-'));
    const base = { 'supabase/config.toml': '[functions.f]\nverify_jwt = true\n', 'supabase/functions/f/index.ts': "import { x } from './lib.ts';\n",
      'supabase/functions/f/lib.ts': 'export const x = 1;\n', 'supabase/migrations/1_init.sql': 'select 1;\n' };
    for (const [name, text] of Object.entries({ ...base, ...files })) {
      await mkdir(path.dirname(path.join(temp, name)), { recursive: true });
      await writeFile(path.join(temp, name), text);
    }
    return deploy.analyzeDeployArtifacts(temp);
  }
  it('passes the real repository and a clean synthetic one', async () => {
    const real = await deploy.analyzeDeployArtifacts(root);
    expect(real.problems).toEqual([]);
    expect(Object.keys(real.graph).sort()).toEqual(['analyze-clothing', 'delete-account', 'finalize-analyzed-item', 'finalize-image-change']);
    expect((await repo({})).problems).toEqual([]);
  });
  it('fails an entrypoint that points at a fixture', async () => {
    const result = await repo({ 'supabase/config.toml': '[functions.f]\nentrypoint = "../tests/edge-fixtures/analyze-clothing-double/index.ts"\n',
      'tests/edge-fixtures/analyze-clothing-double/index.ts': 'export {};\n' });
    expect(result.problems.join('\n')).toMatch(/fixture-path/);
  });
  it('fails an import-map alias into tests/', async () => {
    const result = await repo({ 'supabase/functions/f/deno.json': JSON.stringify({ imports: { double: '../../../tests/edge-fixtures/provider-double.mjs' } }) });
    expect(result.problems.join('\n')).toMatch(/import-map double/);
  });
  it('fails a multi-line relative import into tests/ and a non-literal dynamic import', async () => {
    const result = await repo({ 'supabase/functions/f/lib.ts': "import {\n  a,\n} from '../../../tests/x.ts';\nconst m = await import(name);\nexport const x = a;\n",
      'tests/x.ts': 'export const a = 1;\n' });
    const text = result.problems.join('\n');
    expect(text).toMatch(/tests\/x\.ts \(fixture-path\)/);
    expect(text).toMatch(/non-literal import/);
  });
  it('ignores commented-out imports but fails fixture markers in migrations and seeds', async () => {
    expect((await repo({ 'supabase/functions/f/lib.ts': "// import '../../../tests/x.ts';\n/* import '../../../tests/y.ts' */\nexport const x = 1;\n" })).problems).toEqual([]);
    expect((await repo({ 'supabase/migrations/2_bad.sql': "select 'local-dummy-not-a-credential';\n" })).problems.join('\n')).toMatch(/2_bad\.sql contains fixture marker/);
    expect((await repo({ 'supabase/seed.sql': '-- stillroom-edge-gate-activation\n' })).problems.join('\n')).toMatch(/seed\.sql contains fixture marker/);
  });
  const fixture = { 'tests/edge-fixtures/analyze-clothing-double/index.ts': 'export {};\n' };
  it('fails closed on TOML it does not parse: literal, multi-line and quoted-key entrypoints', async () => {
    for (const config of [
      "[functions.f]\nentrypoint = '../tests/edge-fixtures/analyze-clothing-double/index.ts'\n",
      '[functions.f]\nentrypoint = """\n../tests/edge-fixtures/analyze-clothing-double/index.ts"""\n',
      '[functions.f]\n"entrypoint" = "../tests/edge-fixtures/analyze-clothing-double/index.ts"\n',
      '[functions."f"]\nentrypoint = "../tests/edge-fixtures/analyze-clothing-double/index.ts"\n',
      '[functions]\nf.entrypoint = "../tests/edge-fixtures/analyze-clothing-double/index.ts"\n',
      '[functions.f]\nentrypoint = "a\\u002e./tests/x.ts"\n',
      '[[functions.f]]\nentrypoint = "x"\n',
      '[functions.f]\nstatic_files = ["../tests/edge-fixtures/provider-double.mjs"]\n',
      '[functions.f]\nverify_jwt = true\n[functions.f]\nentrypoint = "x"\n',
      '[functions.f]\nsettings = { entrypoint = "x" }\n',
    ]) expect((await repo({ 'supabase/config.toml': config, ...fixture })).problems, config).not.toEqual([]);
  }, 30_000);
  it('parses the supported subset exactly', () => {
    const parsed = deploy.parseToml('a = "x" # c\n[t.u]\nb = [ "p", "q", ]\nc = -3\nd = false\n');
    expect(parsed.problems).toEqual([]);
    expect(parsed.value).toEqual({ a: 'x', t: { u: { b: ['p', 'q'], c: -3, d: false } } });
  });
  it('resolves import-map scopes, so a scoped override into a fixture fails', async () => {
    const scoped = JSON.stringify({ imports: { './lib.ts': './lib.ts' },
      scopes: { './': { './lib.ts': '../../../tests/edge-fixtures/provider-double.mjs' } } });
    const result = await repo({ 'supabase/functions/f/deno.json': scoped, 'tests/edge-fixtures/provider-double.mjs': 'export const x = 1;\n' });
    expect(result.problems.join('\n')).toMatch(/provider-double\.mjs \((fixture-path|fixture-name)\)/);
    expect(result.graph.f).toContain('tests/edge-fixtures/provider-double.mjs');
    const map = deploy.importMap({ imports: { lib: './safe.ts' }, scopes: { './sub/': { lib: './other.ts' } } }, 'file:///r/m.json', 'm');
    expect(deploy.resolveSpecifier('lib', 'file:///r/sub/a.ts', map)).toBe('file:///r/other.ts');
    expect(deploy.resolveSpecifier('lib', 'file:///r/a.ts', map)).toBe('file:///r/safe.ts');
    expect(deploy.resolveSpecifier('./b.ts', 'file:///r/a.ts', map)).toBe('file:///r/b.ts');
    expect(deploy.resolveSpecifier('left-pad', 'file:///r/a.ts', map)).toBeNull();
  });
  it('reads deno.jsonc and fails ambiguous or unsupported import-map files', async () => {
    const jsonc = '{\n  // comment\n  "imports": { /* x */ "double": "../../../tests/edge-fixtures/provider-double.mjs" }\n}\n';
    expect((await repo({ 'supabase/functions/f/deno.jsonc': jsonc })).problems.join('\n')).toMatch(/import-map double/);
    expect((await repo({ 'supabase/functions/f/deno.json': '{"imports":{}}', 'supabase/functions/f/deno.jsonc': '{"imports":{}}' }))
      .problems.join('\n')).toMatch(/both deno\.json and deno\.jsonc/);
    expect((await repo({ 'supabase/functions/f/deno.json': '{"importMap":"../../../tests/m.json"}' })).problems.join('\n')).toMatch(/importMap is not supported/);
    expect((await repo({ 'supabase/functions/f/deno.json': '{"imports":{"a":"b",},}' })).problems.join('\n')).toMatch(/unreadable import map/);
    expect((await repo({ 'supabase/functions/import_map.json': JSON.stringify({ imports: { x: '../../tests/edge-fixtures/canary.mjs' } }) }))
      .problems.join('\n')).toMatch(/import-map x/);
  }, 30_000);
  it('joins every scope key against the map URL, so a bare-relative scope reaching a fixture transitively fails', async () => {
    const map = JSON.stringify({ imports: {}, scopes: { 'sub/': { './sub/b.ts': './helper.ts' } } });
    const result = await repo({
      'supabase/functions/f/index.ts': "import './sub/a.ts';\nexport const x = 1;\n",
      'supabase/functions/f/sub/a.ts': "import './b.ts';\n",
      'supabase/functions/f/sub/b.ts': 'export const safe = 1;\n',
      'supabase/functions/f/helper.ts': "import '../../../tests/edge-fixtures/canary.mjs';\n",
      'supabase/functions/f/deno.json': map,
    });
    expect(result.graph.f).toContain('supabase/functions/f/helper.ts');
    expect(result.graph.f).not.toContain('supabase/functions/f/sub/b.ts');
    expect(result.problems.join('\n')).toMatch(/f: tests\/edge-fixtures\/canary\.mjs/);
    const parsed = deploy.importMap({ scopes: { 'sub/': {}, '../up/': {}, 'https://x.test/': {} } }, 'file:///r/m.json', 'm');
    expect(Object.keys(parsed.scopes).sort()).toEqual(['file:///r/sub/', 'file:///up/', 'https://x.test/']);
  });
  it('treats import-map keys and targets with URL join semantics', () => {
    const map = deploy.importMap({ imports: { 'lib.ts': './other.ts', './own.ts': './mapped.ts', 'pkg/': './vendor/pkg/',
      'bad': 'lib.ts', 'slash/': './no-slash.ts', 'https://cdn.test/a': './local.ts' } }, 'file:///r/m.json', 'm');
    expect(map.problems.join('\n')).toMatch(/bad -> lib\.ts \(invalid address\)/);
    expect(map.problems.join('\n')).toMatch(/slash\/ -> \.\/no-slash\.ts \(prefix target without \/\)/);
    expect(deploy.resolveSpecifier('lib.ts', 'file:///r/a.ts', map)).toBe('file:///r/other.ts');
    expect(deploy.resolveSpecifier('./lib.ts', 'file:///r/a.ts', map)).toBe('file:///r/lib.ts');
    expect(deploy.resolveSpecifier('./own.ts', 'file:///r/a.ts', map)).toBe('file:///r/mapped.ts');
    expect(deploy.resolveSpecifier('pkg/x.ts', 'file:///r/a.ts', map)).toBe('file:///r/vendor/pkg/x.ts');
    expect(deploy.resolveSpecifier('pkg/../../escape.ts', 'file:///r/a.ts', map)).toBeNull();
    expect(deploy.resolveSpecifier('bad', 'file:///r/a.ts', map)).toBeNull();
    expect(deploy.resolveSpecifier('https://cdn.test/a', 'file:///r/a.ts', map)).toBe('file:///r/local.ts');
  });
  it('walks function directories that have no config entry', async () => {
    const result = await repo({ 'supabase/functions/g/index.ts': "import '../../../tests/edge-fixtures/canary.mjs';\n" });
    expect(result.problems.join('\n')).toMatch(/g: tests\/edge-fixtures\/canary\.mjs/);
  });
});
