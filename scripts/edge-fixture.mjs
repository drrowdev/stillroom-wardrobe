// PR-3b privileged Edge-runtime fixture controller (CI database job only). Long-lived child of
// `scripts/run-local-tests.mjs edge`; the normal-session gate never receives credentials. It accepts only closed
// IPC operations (no SQL, no identities from the caller), builds the isolated fixture topology, proves egress is
// dark and the fixed-upstream gateway allowlist is effective, and restores everything before exit.
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, TEST_EMAILS, cli, commandEnvironment, jwtClaims, runCommand, fail, reportError } from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { guardPrivileged, psql, freezeSql, restoreSql } from './isolation-catalog.mjs';
import { effectiveConfig, INGRESS_PORT } from '../tests/edge-fixtures/fixture-gateway.mjs';
import { probeVerdict, kongLogVerdict, upstreamVerdict } from '../tests/edge-fixtures/egress-probe.mjs';
import { canaryHits } from '../tests/edge-fixtures/canary.mjs';
import { AZURE_REVIEW_EXPIRES } from '../supabase/functions/analyze-clothing/azure-openai.ts';

export const FIXTURE_NETWORK = 'stillroom-edge-fixture';
export const CANARY_NETWORK = 'stillroom-canary';
export const STACK_NETWORK = 'supabase_network_stillroom-wardrobe';
export const KONG_CONTAINER = 'supabase_kong_stillroom-wardrobe';
export const STACK_RUNTIME = 'supabase_edge_runtime_stillroom-wardrobe';
export const CONTAINERS = Object.freeze({ double: 'stillroom-edge-double', gateway: 'stillroom-edge-gateway',
  runtime: 'stillroom-edge-runtime', canary: 'stillroom-edge-canary' });
export const LABEL = 'com.stillroom.edge-fixture=pr-3b';
const NODE_IMAGE = 'public.ecr.aws/supabase/postgres-meta:v0.98.0';
const NODE_DIGEST = 'sha256:cef71ba901751dcc242cc685cf13786935ea8926820fb342f23bb0fbef77de5a';
// Supabase CLI 2.116.0 runs supabase/edge-runtime:v1.74.3; OCI index digest, identical on public.ecr.aws and ghcr.io.
export const EDGE_RUNTIME_DIGEST = 'sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c';
const EDGE_RUNTIME_REPOS = Object.freeze(['public.ecr.aws/supabase/edge-runtime', 'ghcr.io/supabase/edge-runtime',
  'supabase/edge-runtime', 'docker.io/supabase/edge-runtime']);
export const GATEWAY_MODE_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';
export const REQUEST_PREFIX = 'e3b0';
export const OPERATIONS = Object.freeze(['freeze', 'restore', 'count', 'verify-deleted', 'down']);

/** AZURE_REVIEW_EXPIRES blocks the gate: an expired or invalid review date is BLOCKED, never a pass. */
export function reviewGate(now, expires = AZURE_REVIEW_EXPIRES) {
  return Number.isFinite(expires) && Number.isFinite(now) && now < expires ? 'open' : 'blocked';
}
/** Closed IPC operation shape; owner labels are the fixed fictional A/B only. */
export function validOperation(message) {
  if (!message || typeof message !== 'object' || message.type !== 'op' || !Number.isSafeInteger(message.id)) return false;
  const keys = Object.keys(message).sort().join(',');
  if (['freeze', 'restore'].includes(message.op)) return keys === 'id,op,owner,type' && ['A', 'B'].includes(message.owner);
  return OPERATIONS.includes(message.op) && keys === 'id,op,type';
}
/** Topology proof over `docker inspect` values (rev5 A1). Returns problems; empty means verified. */
export function topologyProblems(inspected, networks) {
  const problems = [];
  const expected = { [CONTAINERS.double]: [FIXTURE_NETWORK], [CONTAINERS.runtime]: [FIXTURE_NETWORK],
    [CONTAINERS.gateway]: [FIXTURE_NETWORK, STACK_NETWORK].sort(), [CONTAINERS.canary]: [CANARY_NETWORK] };
  for (const [name, wanted] of Object.entries(expected)) {
    const value = inspected[name];
    if (!value) { problems.push(`${name}: missing`); continue; }
    if (!isDeepStrictEqual([...value.networks].sort(), wanted)) problems.push(`${name}: networks`);
    if (value.published) problems.push(`${name}: published ports`);
    if (value.env.some((entry) => /^(https?_proxy|all_proxy|no_proxy)=/i.test(entry))) problems.push(`${name}: proxy env`);
    if (value.running !== true) problems.push(`${name}: not running`);
  }
  if (networks[FIXTURE_NETWORK]?.internal !== true) problems.push('fixture network is not internal');
  if (networks[FIXTURE_NETWORK]?.options?.[GATEWAY_MODE_OPTION] !== 'isolated') problems.push('fixture network gateway mode is not isolated');
  if (networks[FIXTURE_NETWORK]?.ipv6 !== false) problems.push('fixture network has IPv6');
  if (networks[CANARY_NETWORK]?.internal !== false) problems.push('canary network must be non-internal');
  return problems;
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
const toInt = (ip) => ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
/** IPv4 CIDR containment; anything malformed is null (callers treat null as unverified). */
export function inSubnet(ip, cidr) {
  const match = /^([0-9.]+)\/([0-9]{1,2})$/.exec(cidr ?? '');
  if (!match || !ipv4.test(match[1]) || !ipv4.test(ip ?? '') || Number(match[2]) > 30 || Number(match[2]) < 8) return null;
  const size = 2 ** (32 - Number(match[2]));
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(match[1]) / size);
}
export function firstHost(cidr) {
  const match = /^([0-9.]+)\/([0-9]{1,2})$/.exec(cidr ?? '');
  if (!match || inSubnet(match[1], cidr) === null) return null;
  const size = 2 ** (32 - Number(match[2])), base = Math.floor(toInt(match[1]) / size) * size + 1;
  return [24, 16, 8, 0].map((shift) => Math.floor(base / 2 ** shift) % 256).join('.');
}
/**
 * Host-input isolation proof (review finding 1): the host holds no address inside the fixture subnet and cannot bind
 * the bridge gateway address. A successful bind, a host address in the subnet or missing data is a problem.
 */
export function hostIsolationProblems({ subnet, gateway, hostAddresses, bindCode }) {
  const problems = [];
  if (inSubnet(gateway, subnet) !== true) problems.push('fixture gateway address not verified');
  if (!Array.isArray(hostAddresses) || !hostAddresses.length) problems.push('host addresses unavailable');
  else if (hostAddresses.some((address) => inSubnet(address, subnet) !== false)) problems.push('host holds a fixture-subnet address');
  if (bindCode !== 'EADDRNOTAVAIL') problems.push(`host bind on fixture gateway: ${bindCode ?? 'bound'}`);
  return problems;
}
/** The immutable runtime reference: a pinned repo@digest present in the stack runtime image's RepoDigests, or null. */
export function pinnedRuntimeReference(repoDigests, digest = EDGE_RUNTIME_DIGEST) {
  const allowed = new Set(EDGE_RUNTIME_REPOS.map((repo) => `${repo}@${digest}`));
  return (Array.isArray(repoDigests) ? repoDigests : []).find((entry) => allowed.has(entry)) ?? null;
}

const say = (line) => console.log(line);
const env = () => commandEnvironment(process.env);
async function docker(args, { secrets = {}, timeout = 60_000, max = 1024 * 1024 } = {}) {
  return runCommand('docker', args, { env: { ...env(), ...secrets }, timeout, maxOutputBytes: max });
}
async function dockerOk(args, what, options) {
  const result = await docker(args, options);
  if (result.code !== 0) fail(`FAIL: EDGE-RUNTIME fixture step ${what} failed`, 1);
  return result.stdout.trim();
}
async function inspectJson(kind, name, template) {
  const result = await docker([kind, 'inspect', '--format', template, name]);
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function localKeys() {
  const result = await cli(['status', '--output', 'json']);
  let data;
  try { data = JSON.parse(result.stdout); } catch { fail('BLOCKED: EDGE-RUNTIME local status unavailable', 1); }
  const anon = data?.ANON_KEY, service = data?.SERVICE_ROLE_KEY;
  if (result.code !== 0 || typeof anon !== 'string' || typeof service !== 'string'
    || jwtClaims(anon).role !== 'anon' || jwtClaims(service).role !== 'service_role') fail('BLOCKED: EDGE-RUNTIME local JWT keys unavailable', 1);
  return { anon, service };
}
async function nodeImage() {
  const digests = await dockerOk(['image', 'inspect', '--format', '{{range .RepoDigests}}{{println .}}{{end}}', NODE_IMAGE], 'node-image');
  const lines = digests.split('\n').map((line) => line.trim());
  if (!lines.some((line) => line === `public.ecr.aws/supabase/postgres-meta@${NODE_DIGEST}` || line === `ghcr.io/supabase/postgres-meta@${NODE_DIGEST}`)) {
    fail('REFUSED: EDGE-RUNTIME node image digest differs from the pinned pg-meta image', 2);
  }
  return NODE_IMAGE;
}
async function stackIdentity() {
  const kong = await inspectJson('container', KONG_CONTAINER, `{"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"running":{{json .State.Running}},"ip":{{json (index .NetworkSettings.Networks "${STACK_NETWORK}").IPAddress}},"bindings":{{json .HostConfig.PortBindings}}}`);
  const runtime = await inspectJson('container', STACK_RUNTIME, '{"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Image}},"running":{{json .State.Running}}}');
  const apiPort = Number(kong?.bindings?.['8000/tcp']?.[0]?.HostPort);
  if (!kong || kong.project !== 'stillroom-wardrobe' || kong.running !== true || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(kong.ip ?? '')
    || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535
    || !runtime || runtime.project !== 'stillroom-wardrobe' || runtime.running !== true
    || !/^sha256:[0-9a-f]{64}$/.test(runtime.image ?? '')) fail('REFUSED: EDGE-RUNTIME stack Kong/runtime identity not verified', 2);
  const digests = await inspectJson('image', runtime.image, '{{json .RepoDigests}}');
  const reference = pinnedRuntimeReference(digests);
  if (!reference) fail('REFUSED: EDGE-RUNTIME stack runtime image is not the pinned edge-runtime digest', 2);
  return { kongIp: kong.ip, apiPort, runtimeImageId: runtime.image, runtimeReference: reference };
}
async function requireAbsent() {
  const containers = await dockerOk(['ps', '-a', '--filter', 'name=^/stillroom-edge-', '--format', '{{.Names}}'], 'container-inventory');
  const networks = await dockerOk(['network', 'ls', '--filter', 'label=com.stillroom.edge-fixture', '--format', '{{.Name}}'], 'network-inventory');
  if (containers || networks) fail('REFUSED: EDGE-RUNTIME fixture resources already exist; nothing is reused', 2);
}
// --no-healthcheck: the pinned pg-meta image's own HEALTHCHECK would GET localhost:8080 inside every fixture container.
const common = (name, network, alias) => ['run', '-d', '--name', name, '--label', LABEL, '--network', network,
  ...(alias ? ['--network-alias', alias] : []), '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--no-healthcheck', '--memory', '512m', '--pids-limit', '256'];
const mount = (source, target) => ['-v', `${path.join(ROOT, source)}:${target}:ro`];

async function containerFacts(name) {
  return inspectJson('container', name, '{"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}},"bindings":{{json .HostConfig.PortBindings}},"env":{{json .Config.Env}},"running":{{json .State.Running}}}');
}
function summarize(value) {
  if (!value) return null;
  const published = Object.values(value.ports ?? {}).some((entry) => Array.isArray(entry) && entry.length)
    || Object.keys(value.bindings ?? {}).length > 0;
  return { networks: Object.keys(value.networks ?? {}), published, env: value.env ?? [], running: value.running,
    ips: Object.fromEntries(Object.entries(value.networks ?? {}).map(([key, entry]) => [key, entry.IPAddress])) };
}
async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
function tcpTouch(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
function udpTouch(host, port) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.send(Buffer.from('edge-canary-liveness'), port, host, (error) => { socket.close(); resolve(!error); });
  });
}
async function canaryCount() {
  const result = await docker(['logs', CONTAINERS.canary]);
  return result.code === 0 ? canaryHits(`${result.stdout}\n${result.stderr}`) : null;
}

async function db(sql) { return psql(sql, process.env, runCommand, 256 * 1024); }
async function ownerIds() {
  const raw = await db(`select coalesce(jsonb_object_agg(email,user_id),'{}')::text from private.approved_accounts
    where email in (${TEST_EMAILS.map(literal).join(',')}) and user_id is not null;`);
  const value = JSON.parse(raw);
  const ids = { A: value[TEST_EMAILS[0]], B: value[TEST_EMAILS[1]] };
  if (!/^[0-9a-f-]{36}$/.test(ids.A ?? '') || !/^[0-9a-f-]{36}$/.test(ids.B ?? '') || ids.A === ids.B) fail('BLOCKED: EDGE-RUNTIME fixture owners unavailable', 1);
  return ids;
}
const ACTIVATE = (where) => `-- stillroom-edge-gate-activation (CI fixture only; never a migration or seed)
update private.ai_controls set activated=true,notice_revision=2,model_id='gpt-5.6-terra-2026-07-09',prompt_version=2,
  max_request_micro=4097351,monthly_allowance_micro=100000000,max_requests_per_hour=200,result_ttl_seconds=3600,
  execution_manifest_id='azure-eu-terra-devtest-v2' where ${where};`;

async function main() {
  const deadline = Date.now() + 5 * 60_000;
  if (process.argv.length !== 2 || typeof process.send !== 'function') fail('REFUSED: EDGE-RUNTIME controller runs only under test:edge', 2);
  await guardPrivileged({ env: process.env, readConfig: () => readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8') });
  if (reviewGate(Date.now()) !== 'open') {
    say('BLOCKED: EDGE-RUNTIME AZURE_REVIEW_EXPIRES has passed; the pinned provider review must be renewed before this gate can pass');
    process.exitCode = 1; return;
  }
  await requireAbsent();
  const keys = await localKeys();
  const image = await nodeImage();
  const { kongIp, apiPort, runtimeImageId, runtimeReference } = await stackIdentity();
  const ids = await ownerIds();
  const where = `owner_id in (${literal(ids.A)},${literal(ids.B)})`;
  const frozen = new Set();
  let snapshot = null, created = false, activated = false, hostCanary = null;
  const down = async () => {
    const failures = [];
    for (const owner of [...frozen]) {
      try { if (await db(restoreSql(owner)) === 'I17_RESTORE_OK') frozen.delete(owner); else failures.push(`restore-${owner}`); }
      catch { failures.push(`restore-${owner}`); }
    }
    if (activated && snapshot) {
      try {
        const columns = Object.keys(snapshot[0] ?? {}).filter((c) => c !== 'owner_id');
        if (!columns.every((c) => /^[a-z_]+$/.test(c))) throw new Error('columns');
        const restore = snapshot.map((row) => `update private.ai_controls c set ${columns.map((c) => `${c}=v.${c}`).join(',')}
          from jsonb_populate_record(null::private.ai_controls,${literal(JSON.stringify(row))}::jsonb) v where c.owner_id=v.owner_id;`).join('\n');
        await db(`begin;
          delete from private.ai_save_used_receipts where ${where} and request_id::text like '${REQUEST_PREFIX}%';
          delete from private.ai_usage where ${where} and request_id::text like '${REQUEST_PREFIX}%';
          ${restore}
          commit;`);
        const after = JSON.parse(await db(`select coalesce(jsonb_agg(to_jsonb(c) order by owner_id),'[]')::text from private.ai_controls c
          where owner_id=${literal(ids.A)};`));
        if (!isDeepStrictEqual(after, snapshot.filter((row) => row.owner_id === ids.A))) failures.push('ai-controls-restore');
        const residue = await db(`select (select count(*) from private.ai_save_used_receipts where request_id::text like '${REQUEST_PREFIX}%')
          + (select count(*) from private.ai_usage where request_id::text like '${REQUEST_PREFIX}%');`);
        if (residue !== '0') failures.push('gate-row-cleanup');
        else if (!failures.includes('ai-controls-restore')) say('PASS: EDGE-RUNTIME restore; ai_controls equal the pre-activation snapshot and no e3b0 gate rows remain');
      } catch { failures.push('ai-controls-restore'); }
    }
    if (created) {
      await docker(['rm', '-f', ...Object.values(CONTAINERS)]);
      for (const network of [FIXTURE_NETWORK, CANARY_NETWORK]) await docker(['network', 'rm', network]);
      const left = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}']);
      const nets = await docker(['network', 'ls', '--filter', 'label=com.stillroom.edge-fixture', '--format', '{{.Name}}']);
      if (left.code !== 0 || left.stdout.trim() || nets.code !== 0 || nets.stdout.trim()) failures.push('fixture-teardown');
    }
    return failures;
  };
  let failed = false;
  try {
    created = true;
    // Isolated gateway mode (Docker >= 28): the bridge gets no host address, so host services on the bridge, docker0
    // or 0.0.0.0 are unreachable from fixture containers. Proven below by inspect, host addresses and a bind attempt.
    const isolated = await docker(['network', 'create', '--internal', '-o', `${GATEWAY_MODE_OPTION}=isolated`, '--label', LABEL, FIXTURE_NETWORK]);
    if (isolated.code !== 0) fail('BLOCKED: EDGE-RUNTIME fixture network needs Docker isolated gateway mode (Docker 28 or newer)', 1);
    await dockerOk(['network', 'create', '--label', LABEL, CANARY_NETWORK], 'canary-network');
    await dockerOk([...common(CONTAINERS.double, FIXTURE_NETWORK, 'provider-double'), ...mount('tests/edge-fixtures', '/fixtures'),
      '--entrypoint', 'node', image, '/fixtures/provider-double.mjs'], 'provider-double');
    await dockerOk([...common(CONTAINERS.gateway, FIXTURE_NETWORK, 'kong'), ...mount('tests/edge-fixtures', '/fixtures'),
      '-e', `EDGE_GATEWAY_UPSTREAM=http://${kongIp}:8000`, '--entrypoint', 'node', image, '/fixtures/fixture-gateway.mjs'], 'gateway');
    await dockerOk(['network', 'connect', STACK_NETWORK, CONTAINERS.gateway], 'gateway-stack-network');
    await dockerOk([...common(CONTAINERS.canary, CANARY_NETWORK), ...mount('tests/edge-fixtures', '/fixtures'),
      '--entrypoint', 'node', image, '/fixtures/canary.mjs'], 'canary');
    // Keys reach only the fixture runtime, by name through the docker command environment, never argv or this process env.
    await dockerOk(['run', '-d', '--name', CONTAINERS.runtime, '--label', LABEL, '--network', FIXTURE_NETWORK,
      '--network-alias', 'edge-runtime', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g',
      '-e', 'SUPABASE_ANON_KEY', '-e', 'SUPABASE_SERVICE_ROLE_KEY',
      ...mount('supabase/functions', '/work/supabase/functions'), ...mount('src/images', '/work/src/images'),
      ...mount('tests/edge-fixtures', '/work/tests/edge-fixtures'),
      '--pull', 'never', '--entrypoint', 'edge-runtime', runtimeReference, 'start', '--main-service', '/work/tests/edge-fixtures/analyze-clothing-double',
      '--port', '9000'], 'fixture-runtime', { secrets: { SUPABASE_ANON_KEY: keys.anon, SUPABASE_SERVICE_ROLE_KEY: keys.service } });
    const fixtureRuntime = await inspectJson('container', CONTAINERS.runtime, '{"image":{{json .Image}}}');
    if (fixtureRuntime?.image !== runtimeImageId) fail('FAIL: EDGE-RUNTIME fixture runtime image differs from the stack runtime image', 1);
    say(`PASS: EDGE-RUNTIME runtime image pinned; stack and fixture both run ${runtimeReference.split('@')[0]}@${EDGE_RUNTIME_DIGEST}`);

    const inspected = {};
    for (const name of Object.values(CONTAINERS)) inspected[name] = summarize(await containerFacts(name));
    const networks = {};
    for (const name of [FIXTURE_NETWORK, CANARY_NETWORK]) networks[name] = await inspectJson('network', name,
      '{"internal":{{json .Internal}},"options":{{json .Options}},"ipv6":{{json .EnableIPv6}},"ipam":{{json .IPAM.Config}}}');
    const topology = topologyProblems(inspected, networks);
    if (topology.length) { for (const p of topology) say(`FAIL: EDGE-RUNTIME topology ${p}`); fail('FAIL: EDGE-RUNTIME topology not isolated', 1); }
    say('PASS: EDGE-RUNTIME topology; runtime and double internal-only, gateway on exactly two networks, no published ports or proxy env');
    const ipam = (networks[FIXTURE_NETWORK].ipam ?? []).filter((entry) => inSubnet(firstHost(entry?.Subnet), entry?.Subnet) === true);
    const subnet = ipam.length === 1 ? ipam[0].Subnet : null;
    const bridgeGateway = ipam.length === 1 ? (ipv4.test(ipam[0].Gateway ?? '') ? ipam[0].Gateway : firstHost(subnet)) : null;
    const hostAddresses = Object.values(networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4' || entry?.family === 4).map((entry) => entry.address);
    const bindCode = await new Promise((resolve) => {
      const probeServer = createServer();
      probeServer.once('error', (error) => resolve(String(error.code ?? 'error')));
      probeServer.listen({ host: bridgeGateway ?? '0.0.0.0', port: 0 }, () => probeServer.close(() => resolve(null)));
    });
    const isolation = hostIsolationProblems({ subnet, gateway: bridgeGateway, hostAddresses, bindCode });
    if (isolation.length) { for (const p of isolation) say(`FAIL: EDGE-RUNTIME host isolation ${p}`); fail('FAIL: EDGE-RUNTIME host input not isolated', 1); }
    say(`PASS: EDGE-RUNTIME fixture network is internal with isolated gateway mode; the host holds no ${subnet} address (bind ${bindCode})`);
    const hostGateway = async (network) => {
      const config = await inspectJson('network', network, '{{json .IPAM.Config}}');
      const gateways = (Array.isArray(config) ? config : []).map((entry) => entry?.Gateway).filter((value) => ipv4.test(value ?? ''));
      return gateways.length === 1 ? gateways[0] : null;
    };
    const docker0Gateway = await hostGateway('bridge'), stackGateway = await hostGateway(STACK_NETWORK);
    if (!docker0Gateway || !stackGateway) fail('BLOCKED: EDGE-RUNTIME host bridge gateways unavailable; host-path evidence missing', 1);
    const gatewayStackIp = inspected[CONTAINERS.gateway].ips[STACK_NETWORK], gatewayFixtureIp = inspected[CONTAINERS.gateway].ips[FIXTURE_NETWORK];
    const canaryIp = inspected[CONTAINERS.canary].ips[CANARY_NETWORK];
    const ingress = `http://${gatewayStackIp}:${INGRESS_PORT}`;

    const configOk = await waitFor(async () => {
      const response = await fetch(`${ingress}/__config`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      return response.ok && isDeepStrictEqual(await response.json(), effectiveConfig(`http://${kongIp}:8000`));
    }, 60_000);
    if (!configOk) fail('FAIL: EDGE-RUNTIME gateway effective configuration differs from the reviewed constants', 1);
    say('PASS: EDGE-RUNTIME gateway effective config equals the reviewed allowlist; upstream is the verified stack Kong');
    const ready = await waitFor(async () => {
      const response = await fetch(`${ingress}/functions/v1/analyze-clothing`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), signal: AbortSignal.timeout(5000) });
      const body = await response.json().catch(() => null);
      return response.status === 401 && body?.code === 'UNAUTHENTICATED';
    }, Math.max(1000, Math.min(120_000, deadline - Date.now())));
    if (!ready) {
      const logs = await docker(['logs', '--tail', '40', CONTAINERS.runtime], { max: 64 * 1024 });
      for (const line of `${logs.stdout}\n${logs.stderr}`.split('\n').slice(-40)) if (line.trim()) say(`EDGE-RUNTIME log: ${line.slice(0, 300)}`);
      fail('FAIL: EDGE-RUNTIME fixture runtime did not become ready', 1);
    }
    say('PASS: EDGE-RUNTIME fixture analyze-clothing served by the pinned stack edge-runtime image');

    await tcpTouch(canaryIp, 8443); await tcpTouch(canaryIp, 5300); await udpTouch(canaryIp, 5300);
    const live = await waitFor(async () => (await canaryCount()) === 3, 10_000);
    if (!live) { say('BLOCKED: EDGE-RUNTIME canary liveness not observed; egress evidence missing'); fail('BLOCKED: EDGE-RUNTIME canary', 1); }
    hostCanary = await new Promise((resolve, reject) => {
      const server = createServer((socket) => { server.hits += 1; socket.destroy(); });
      server.hits = 0;
      server.once('error', reject);
      server.listen({ host: '0.0.0.0', port: 0 }, () => resolve(server));
    });
    const hostPort = hostCanary.address().port;
    // Liveness from the host side: the 0.0.0.0 listener answers on loopback and both host-held bridge gateways, and the
    // stack API is published on the host, so a dark result from the fixture namespace is meaningful.
    const hostLive = await tcpTouch('127.0.0.1', hostPort) && await tcpTouch(docker0Gateway, hostPort) && await tcpTouch(stackGateway, hostPort)
      && await tcpTouch('127.0.0.1', apiPort) && await waitFor(async () => hostCanary.hits === 3, 5000);
    if (!hostLive) fail('BLOCKED: EDGE-RUNTIME host canary liveness not observed; host-path evidence missing', 1);
    const nonce = randomBytes(12).toString('hex');
    const forwardedRecord = async () => {
      try {
        const response = await fetch(`${ingress}/__forwarded`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
        return response.ok ? await response.json() : null;
      } catch { return null; }
    };
    const forwardedBefore = await forwardedRecord();
    const since = new Date(Date.now() - 1000).toISOString();
    const probe = await docker(['run', '--rm', '--network', `container:${CONTAINERS.runtime}`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', ...mount('tests/edge-fixtures', '/fixtures'),
      '-e', `EDGE_CANARY_IP=${canaryIp}`, '-e', `EDGE_GATEWAY_IP=${gatewayFixtureIp}`, '-e', `EDGE_KONG_IP=${kongIp}`,
      '-e', `EDGE_BRIDGE_GW=${bridgeGateway}`, '-e', `EDGE_DOCKER0_GW=${docker0Gateway}`, '-e', `EDGE_STACK_GW=${stackGateway}`,
      '-e', `EDGE_HOST_PORT=${hostPort}`, '-e', `EDGE_API_PORT=${apiPort}`,
      '-e', `EDGE_PROBE_NONCE=${nonce}`, '--entrypoint', 'node', image, '/fixtures/egress-probe.mjs'], { timeout: 120_000, max: 64 * 1024 });
    const verdict = probeVerdict({ code: probe.code, stdout: probe.stdout }, nonce);
    for (const line of probe.stdout.split('\n')) if (line.trim()) say(line.trim());
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const hits = await canaryCount();
    const egress = hits === null ? { verdict: 'BLOCKED', reason: 'canary-log' } : hits !== 3 ? { verdict: 'FAIL', reason: 'canary-connected' }
      : hostCanary.hits !== 3 ? { verdict: 'FAIL', reason: 'host-canary-connected' } : verdict;
    say(`${egress.verdict}: EDGE-RUNTIME egress canary and forbidden routes (${egress.reason})`);
    if (egress.verdict !== 'PASS') fail(`${egress.verdict}: EDGE-RUNTIME egress/route gate`, 1);
    const upstream = upstreamVerdict(forwardedBefore, await forwardedRecord(), nonce);
    say(`${upstream.verdict}: EDGE-RUNTIME gateway forwarded only the two allowed controls, no nonce-bearing request (${upstream.reason})`);
    if (upstream.verdict !== 'PASS') fail(`${upstream.verdict}: EDGE-RUNTIME gateway upstream record`, 1);
    const kongLogs = await docker(['logs', '--since', since, KONG_CONTAINER], { max: 4 * 1024 * 1024 });
    const logVerdict = kongLogVerdict(kongLogs.code === 0 ? `${kongLogs.stdout}\n${kongLogs.stderr}` : null, nonce);
    say(`${logVerdict.verdict}: EDGE-RUNTIME Kong access log shows only allowlisted gateway routes (${logVerdict.reason})`);
    if (logVerdict.verdict !== 'PASS') fail(`${logVerdict.verdict}: EDGE-RUNTIME Kong log gate`, 1);

    snapshot = JSON.parse(await db(`select coalesce(jsonb_agg(to_jsonb(c) order by owner_id),'[]')::text from private.ai_controls c where ${where};`));
    if (!Array.isArray(snapshot) || snapshot.length !== 2) fail('BLOCKED: EDGE-RUNTIME AI control rows unavailable', 1);
    const leftover = await db(`select count(*) from private.ai_usage where ${where} and request_id::text like '${REQUEST_PREFIX}%';`);
    if (leftover !== '0') fail('REFUSED: EDGE-RUNTIME request namespace is not empty', 2);
    activated = true;
    await db(`begin; ${ACTIVATE(where)} commit;`);
    process.send({ type: 'ready', ingress });

    await new Promise((resolve) => {
      process.on('message', async (message) => {
        if (!validOperation(message)) { process.send({ type: 'result', id: message?.id ?? null, ok: false }); return; }
        let ok = false, data = null;
        try {
          if (message.op === 'freeze') {
            frozen.add(message.owner);
            ok = await db(freezeSql(message.owner)) === 'I17_FREEZE_OK';
          } else if (message.op === 'restore') {
            ok = await db(restoreSql(message.owner)) === 'I17_RESTORE_OK';
            if (ok) frozen.delete(message.owner);
          } else if (message.op === 'count') {
            const result = await docker(['exec', CONTAINERS.double, 'node', '-e',
              "fetch('http://127.0.0.1:8080/__count').then(r=>r.text()).then(t=>process.stdout.write(t))"]);
            data = JSON.parse(result.stdout); ok = result.code === 0;
          } else if (message.op === 'verify-deleted') {
            data = JSON.parse(await db(`select jsonb_build_object(
              'authUser',(select count(*) from auth.users where id=${literal(ids.B)}),
              'objects',(select count(*) from storage.objects where bucket_id='wardrobe' and name like ${literal(`${ids.B}/%`)}),
              'profiles',(select count(*) from public.profiles where owner_id=${literal(ids.B)}),
              'items',(select count(*) from public.items where owner_id=${literal(ids.B)}),
              'images',(select count(*) from public.item_images where owner_id=${literal(ids.B)}),
              'survivorAuth',(select count(*) from auth.users where id=${literal(ids.A)}))::text;`));
            ok = true;
          } else if (message.op === 'down') {
            const failures = await down();
            created = false; activated = false;
            if (failures.length) process.exitCode = 1;
            process.send({ type: 'result', id: message.id, ok: failures.length === 0, data: failures });
            resolve(); return;
          }
        } catch { ok = false; }
        process.send({ type: 'result', id: message.id, ok, data });
      });
      process.on('disconnect', resolve);
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    hostCanary?.close();
    if (created || activated || frozen.size) {
      const failures = await down();
      for (const f of failures) console.error(`FAIL: EDGE-RUNTIME restore ${f}`);
      if (failures.length) process.exitCode = 1;
    }
    if (!failed && process.exitCode === undefined) process.exitCode = 0;
    process.disconnect?.();
  }
}
if (isMain(import.meta.url)) main().catch(reportError);
