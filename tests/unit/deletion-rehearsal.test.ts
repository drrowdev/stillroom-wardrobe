import { readFileSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as rehearsal from '../../scripts/run-deletion-rehearsal.mjs';

const {
  API_URL, DOCKER_HOST, PREFIX, REFUSED_EXIT, ROOT, assertCi, assertNoOverrides, childEnvironment, projectId,
  rehearsalConfig, rehearse, sqlFailure, verifyStack,
} = rehearsal;

const SOURCE = readFileSync(path.join(ROOT, 'scripts', 'run-deletion-rehearsal.mjs'), 'utf8');
const CI = Object.freeze({
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe', GITHUB_JOB: 'deletion-rehearsal',
  STILLROOM_DELETION_REHEARSAL: '1', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: '/tmp/runner',
  HOME: '/home/runner',
});
const ID = `${PREFIX}123-1`;
const EXEC = '/usr/local/bin/node';

type Call = { bin: string; args: string[]; env: Record<string, string> | undefined };
type Script = {
  context?: string; endpoint?: string; daemonName?: string; exact?: string; otherLabels?: string; lockCode?: number;
  statusBefore?: { code: number; stdout: string }; startCode?: number; hostPort?: string; hostIp?: string; image?: string;
  socket?: 'symlink' | 'file' | 'elsewhere'; osType?: string; exerciseFails?: boolean;
};

function fakeSystem(script: Script = {}, env: Record<string, string | undefined> = CI) {
  const calls: Call[] = [];
  const removed: string[] = [];
  let started = false;
  let exercised = false;
  const stat = (kind: 'file' | 'socket', link = false) => ({ isFile: () => kind === 'file', isSocket: () => kind === 'socket', isSymbolicLink: () => link, uid: 0 });
  const fs = {
    lstat: async (file: string) => (file.endsWith('docker.sock')
      ? stat(script.socket === 'file' ? 'file' : 'socket', script.socket === 'symlink') : stat('file')),
    realpath: async (file: string) => (script.socket === 'elsewhere' ? '/tmp/x.sock' : file),
    mkdtemp: async (prefix: string) => `${prefix}x`,
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    cp: async () => undefined,
    open: async () => ({ fd: 9 }),
    rm: async (target: string) => { removed.push(`fs:${target}`); },
    readFile: async (file: string, encoding: BufferEncoding) => {
      const text = await realFs.readFile(file, encoding);
      return file.endsWith('config.toml') ? text.replace(/\r\n/g, '\n') : text;
    },
  };
  const reply = (code: number, stdout = '') => ({ code, stdout, stderr: '' });
  const run = async (bin: string, args: string[], options: { env?: Record<string, string> } = {}) => {
    calls.push({ bin, args, env: options.env });
    if (bin === '/usr/bin/flock') return reply(script.lockCode ?? 0);
    if (bin === EXEC) {
      if (args.includes('status')) {
        if (!started) return reply(script.statusBefore?.code ?? 1, script.statusBefore?.stdout ?? '');
        return reply(0, JSON.stringify({ API_URL, DB_URL: 'postgresql://postgres@127.0.0.1:55322/postgres',
          SERVICE_ROLE_KEY: `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`, PUBLISHABLE_KEY: 'sb_publishable_x' }));
      }
      if (args.includes('start')) { started = true; return reply(script.startCode ?? 0); }
      if (args.includes('stop')) { removed.push('supabase:stop'); return reply(0); }
      return reply(2);
    }
    const joined = args.join(' ');
    if (joined === 'context show') return reply(0, `${script.context ?? 'default'}\n`);
    if (joined.startsWith('context inspect')) return reply(0, `${script.endpoint ?? DOCKER_HOST}\n`);
    if (joined.startsWith('info')) return reply(0, JSON.stringify({ OSType: script.osType ?? 'linux', Name: script.daemonName ?? 'runner-host' }));
    if (joined.startsWith('ps -a --filter')) return reply(0, started && (script.startCode ?? 0) === 0 ? 'c1\n' : (script.exact ?? ''));
    if (joined.startsWith('volume ls --filter')) return reply(0, started && (script.startCode ?? 0) === 0 ? 'v1\n' : '');
    if (joined.startsWith('ps -a --format') || joined.startsWith('volume ls --format')) return reply(0, script.otherLabels ?? '');
    if (joined.startsWith('container inspect')) {
      return reply(0, JSON.stringify({ name: `/supabase_db_${ID}`, image: script.image ?? 'public.ecr.aws/supabase/postgres:17.6.1.165', project: ID,
        running: true, ports: { '5432/tcp': [{ HostIp: script.hostIp ?? '127.0.0.1', HostPort: script.hostPort ?? '55322' }] } }));
    }
    if (joined.startsWith('rm -f') || joined.startsWith('volume rm')) { removed.push(`docker:${joined}`); return reply(0); }
    return reply(2);
  };
  const logs: string[] = [];
  const sys = {
    env, fs, run, hostname: 'runner-host', execPath: EXEC, root: ROOT, platform: 'linux', log: (line: string) => logs.push(line),
    exercise: async () => { exercised = true; if (script.exerciseFails) throw new Error('RESULT:owner-c'); },
  };
  return { sys, calls, removed, logs, exercised: () => exercised };
}

describe('deletion rehearsal guards', () => {
  it('runs only in the approved CI job, repository and opt-in', () => {
    expect(() => assertCi(CI, 'linux')).not.toThrow();
    for (const change of [{ GITHUB_JOB: 'database' }, { GITHUB_REPOSITORY: 'someone/fork' }, { STILLROOM_DELETION_REHEARSAL: undefined },
      { GITHUB_ACTIONS: undefined }, { ALLOW_HOSTED_SMOKE: '1' }, { GITHUB_RUN_ID: '1;rm' }, { RUNNER_TEMP: 'relative' }]) {
      expect(() => assertCi({ ...CI, ...change }, 'linux')).toThrow(expect.objectContaining({ code: 'CI_REQUIRED' }));
    }
    expect(() => assertCi(CI, 'win32')).toThrow(expect.objectContaining({ code: 'CI_REQUIRED' }));
  });

  it.each([['DOCKER_HOST', 'tcp://127.0.0.1:9'], ['DOCKER_HOST', 'unix:///tmp/other.sock'], ['DOCKER_HOST', 'ssh://runner@docker.example.test'], ['DOCKER_CONTEXT', 'remote'],
    ['DOCKER_TLS_VERIFY', '1'], ['PGHOST', 'db.example.test'], ['DATABASE_URL', 'postgres://x'], ['SUPABASE_CLI_BINARY_OVERRIDE', '/tmp/cli'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'], ['HTTPS_PROXY', 'http://proxy.test']])('refuses the %s override', (name, value) => {
    expect(() => assertNoOverrides({ [name]: value })).toThrow(expect.objectContaining({ code: 'ENDPOINT_OVERRIDE' }));
  });

  it('allows only the exact local socket as DOCKER_HOST', () => {
    expect(() => assertNoOverrides({ DOCKER_HOST })).not.toThrow();
    expect(() => assertNoOverrides({})).not.toThrow();
  });

  it('uses a run-unique project and moves every rehearsal port away from the ordinary local stack', () => {
    expect(projectId(CI)).toBe(ID);
    const config = rehearsalConfig(readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8').replace(/\r\n/g, '\n'), ID);
    expect(config).toContain(`project_id = "${ID}"`);
    expect(config).not.toMatch(/ = 543\d\d\b/);
    expect(config).toContain('port = 55321\n');
    expect(() => rehearsalConfig('project_id = "other"\n', ID)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
  });

  it('gives the normal-session child no service key, Docker or hosted setting', () => {
    const child = childEnvironment({ ...CI, SUPABASE_SERVICE_ROLE_KEY: 'secret', DOCKER_HOST }, API_URL, 'sb_publishable_x',
      { C: { email: 'c@example.test', password: 'p1' }, D: { email: 'd@example.test', password: 'p2' } });
    expect(Object.keys(child).sort()).toEqual(['HOME', 'NO_COLOR', 'PATH', 'REHEARSAL_C_EMAIL', 'REHEARSAL_C_PASSWORD',
      'REHEARSAL_D_EMAIL', 'REHEARSAL_D_PASSWORD', 'REHEARSAL_PUBLISHABLE_KEY', 'REHEARSAL_URL']);
  });

  it('has exactly one process-spawn site and no shell helpers', () => {
    expect(SOURCE.match(/\bspawnImpl\(/g)).toHaveLength(1);
    expect(SOURCE.match(/\bspawn\b/g)).toHaveLength(2);
    expect(SOURCE).toContain('createRun(spawnImpl = spawn)');
    expect(SOURCE.match(/from 'node:child_process'/g)).toHaveLength(1);
    expect(SOURCE).toContain("import { spawn } from 'node:child_process';");
    expect(SOURCE).not.toMatch(/\b(?:execSync|execFile|execFileSync|spawnSync|fork)\b|shell:\s*true/);
  });
});

describe('deletion rehearsal ownership', () => {
  const destructive = (removed: string[]) => removed.filter((entry) => !entry.startsWith('fs:/tmp/runner/stillroom-docker-config'));

  it('refuses an endpoint override before any subprocess, and cleans up nothing', async () => {
    const fake = fakeSystem({}, { ...CI, DOCKER_HOST: 'tcp://127.0.0.1:9' });
    expect(await rehearse(fake.sys)).toBe(REFUSED_EXIT);
    expect(fake.logs).toEqual(['REFUSED: ENDPOINT_OVERRIDE']);
    expect(fake.calls).toEqual([]);
    expect(fake.removed).toEqual([]);
  });

  it.each([
    [{ context: 'remote' }, 'CONTEXT'],
    [{ socket: 'symlink' }, 'SOCKET'],
    [{ socket: 'file' }, 'SOCKET'],
    [{ socket: 'elsewhere' }, 'SOCKET'],
    [{ osType: 'windows' }, 'DAEMON'],
    [{ endpoint: 'tcp://docker.example.test:2376' }, 'CONTEXT'],
    [{ daemonName: 'someone-else' }, 'DAEMON'],
    [{ exact: 'leftover\n' }, 'PREEXISTING'],
    [{ otherLabels: `${PREFIX}99-1\n` }, 'PREEXISTING'],
    [{ lockCode: 1 }, 'LOCK_BUSY'],
    [{ statusBefore: { code: 0, stdout: `API_URL: ${API_URL}` } }, 'STACK_REACHABLE'],
  ] as const)('refusal %o is %s and never stops or removes anything', async (script, code) => {
    const fake = fakeSystem(script);
    expect(await rehearse(fake.sys)).toBe(REFUSED_EXIT);
    expect(fake.logs).toEqual([`REFUSED: ${code}`]);
    expect(fake.removed).toEqual([]);
    expect(fake.calls.some((call) => call.args.includes('start') || call.args.includes('stop') || call.args[0] === 'rm')).toBe(false);
    expect(fake.exercised()).toBe(false);
  });

  it('pins the Docker endpoint and a fresh empty Docker config for every Docker and Supabase subprocess', async () => {
    const fake = fakeSystem();
    expect(await rehearse(fake.sys)).toBe(0);
    expect(fake.exercised()).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(8);
    for (const call of fake.calls) {
      expect(call.env).toMatchObject({ DOCKER_HOST, PATH: '/usr/bin:/bin', DOCKER_CONFIG: '/tmp/runner/stillroom-docker-config-x' });
      expect(Object.keys(call.env ?? {}).some((name) => /CONTEXT|TLS|SECRET|SERVICE/.test(name))).toBe(false);
    }
    const contextCheck = fake.calls.findIndex((call) => call.args.join(' ') === 'context show');
    const start = fake.calls.findIndex((call) => call.args.includes('start'));
    expect(contextCheck).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(contextCheck);
  });

  it('after a recorded start, removes only this run\'s stack, containers, volumes and directory', async () => {
    const fake = fakeSystem();
    expect(await rehearse(fake.sys)).toBe(0);
    expect(destructive(fake.removed)).toEqual(['supabase:stop', 'docker:rm -f c1', 'docker:volume rm -f v1', `fs:/tmp/runner/${ID}-x`]);
    const stop = fake.calls.find((call) => call.args.includes('stop'));
    expect(stop?.args).toContain(`/tmp/runner/${ID}-x`);
  });

  it('a failed start still stops its own project, and removes only resources labelled with this run', async () => {
    const fake = fakeSystem({ startCode: 1 });
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; START_FAILED');
    expect(destructive(fake.removed)).toEqual(['supabase:stop', `fs:/tmp/runner/${ID}-x`]);
    const labelQueries = fake.calls.filter((call) => call.args[0] === 'ps' && call.args[2] === '--filter');
    for (const query of labelQueries) expect(query.args[3]).toBe(`label=com.supabase.cli.project=${ID}`);
  });

  it('refuses outside the CI opt-in with no subprocess or cleanup', async () => {
    const fake = fakeSystem({}, { ...CI, STILLROOM_DELETION_REHEARSAL: undefined });
    expect(await rehearse(fake.sys)).toBe(REFUSED_EXIT);
    expect(fake.logs).toEqual(['REFUSED: CI_REQUIRED']);
    expect(fake.calls).toEqual([]);
    expect(fake.removed).toEqual([]);
  });

  it('a failure after recording removes only the recorded and same-label resources', async () => {
    const fake = fakeSystem({ exerciseFails: true });
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; RESULT:owner-c');
    expect(destructive(fake.removed)).toEqual(['supabase:stop', 'docker:rm -f c1', 'docker:volume rm -f v1', `fs:/tmp/runner/${ID}-x`]);
  });

  it('fails a stack that publishes an ordinary local port', async () => {
    const fake = fakeSystem({ hostPort: '54322' });
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; BINDING');
    expect(fake.exercised()).toBe(false);
  });

  it.each([
    'public.ecr.aws/supabase/postgres:17.6.1.011', 'supabase/postgres:17.6.1.165', 'public.ecr.aws/supabase/postgres:latest',
    'ghcr.io/supabase/postgres@sha256:0', 'docker.io/library/postgres:17', 'public.ecr.aws/supabase/postgres:17.6.1.165-x',
  ])('fails a stack running an image outside the exact pinned list (%s)', async (image) => {
    const fake = fakeSystem({ image });
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; BINDING');
    expect(fake.exercised()).toBe(false);
  });

  it('accepts only the exact pinned images from either CLI registry', () => {
    expect(rehearsal.IMAGES).toContain('public.ecr.aws/supabase/postgres:17.6.1.165');
    expect(rehearsal.IMAGES).toContain('ghcr.io/supabase/gotrue:v2.196.0');
    expect(rehearsal.IMAGES.every((image: string) => /^(?:public\.ecr\.aws|ghcr\.io)\/supabase\/[a-z-]+:[^:@]+$/.test(image) && !image.endsWith(':latest'))).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.5', '::1', ''])('fails a port published on a non-loopback, wildcard or unspecified address (%s)', async (hostIp) => {
    const fake = fakeSystem({ hostIp });
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; BINDING');
    expect(fake.exercised()).toBe(false);
  });

  it('reads the effective published addresses, not the requested bindings, and accepts loopback only', async () => {
    expect(SOURCE).toContain('"ports":{{json .NetworkSettings.Ports}}');
    expect(SOURCE).not.toContain('HostConfig.PortBindings');
    expect(rehearsal.HOST_IPS).toEqual(['127.0.0.1']);
    const fake = fakeSystem({ hostIp: '127.0.0.1' });
    expect(await rehearse(fake.sys)).toBe(0);
    expect(fake.exercised()).toBe(true);
  });

  it('never changes Docker daemon configuration itself', () => {
    expect(SOURCE).not.toMatch(/daemon\.json|systemctl|\/etc\/docker/);
  });

  it('reports a failed SQL step with its SQLSTATE and a redacted first line only', () => {
    const stderr = 'psql:<stdin>:2: ERROR:  42501: permission denied for table items of 11111111-1111-4111-8111-111111111111 (c@example.test)\n'
      + 'DETAIL:  Key (email)=(secret@example.test) already exists.\nLOCATION:  aclcheck_error, aclchk.c:2843\n';
    const message = sqlFailure('cascade', stderr);
    expect(message).toBe('SQL:cascade:42501:permission denied for table items of UUID EMAIL');
    expect(message).not.toMatch(/secret|DETAIL|LOCATION|example/);
    expect(sqlFailure('q2', 'psql: could not connect')).toBe('SQL:q2:UNKNOWN');
    expect(sqlFailure('guard', `ERROR:  P0001: ${'x'.repeat(400)}`).length).toBeLessThanOrEqual(140);
  });

  it('prints a labelled SQL failure through the FAIL line', async () => {
    const fake = fakeSystem();
    fake.sys.exercise = async () => { throw new Error(sqlFailure('loop-first', 'ERROR:  40001: Request conflict')); };
    expect(await rehearse(fake.sys)).toBe(1);
    expect(fake.logs[0]).toBe('FAIL: account deletion rehearsal; SQL:loop-first:40001:Request conflict');
  });

  it('refuses a status that points anywhere but the rehearsal API', async () => {
    const docker = async () => ({ code: 0, stdout: JSON.stringify({ name: `/supabase_db_${ID}`, image: 'supabase/postgres:17.6.1', project: ID, running: true, ports: {} }), stderr: '' });
    const supabase = async () => ({ code: 0, stdout: JSON.stringify({ API_URL: 'https://abc.supabase.co', DB_URL: 'x', SERVICE_ROLE_KEY: 'a', PUBLISHABLE_KEY: 'b' }), stderr: '' });
    await expect(verifyStack({ docker, supabase, id: ID, containers: ['c1'] })).rejects.toThrow('BINDING');
  });
});
