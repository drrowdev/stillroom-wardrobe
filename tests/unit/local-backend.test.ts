import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { AssertionError } from 'node:assert';
import path from 'node:path';
import {
  ROOT, DB_CONTAINER, PROJECT_ID, MIGRATION_HASH, assertLoopbackUrl, assertLocalApi, assertPublishableKey,
  normalSessionEnvironment, validateSessionEnvironment, commandEnvironment, requireDocker, requireLocalContainer,
  LocalBackendError, securityFailureExitCode, describeGenerationResult,
} from '../../scripts/backend/local.mjs';

declare module '../../scripts/backend/local.mjs' {
  export function describeGenerationResult(result: unknown, elapsedMs: unknown): {
    tag: 'success' | 'nonzero-empty-output' | 'nonzero-with-stderr' | 'nonzero-with-stdout'
      | 'missing-database-output' | 'missing-images-output' | 'invalid-result';
    exitCode: number | null;
    elapsedMs: number | null;
    stdoutBytes: number | null;
    stderrBytes: number | null;
    hasDatabaseOutput: boolean;
    hasImagesOutput: boolean;
  };
}

const credentials = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only',
  TEST_A_EMAIL: 'user-a@example.test', TEST_A_PASSWORD: 'a'.repeat(32),
  TEST_B_EMAIL: 'user-b@example.test', TEST_B_PASSWORD: 'b'.repeat(32),
  ALLOW_SECURITY_TESTS: '1',
};

describe('safe local type-generation description', () => {
  const stdout = 'export type Database = { item_images: {} }';
  const keys = ['tag', 'exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes', 'hasDatabaseOutput', 'hasImagesOutput'];
  const tags = ['success', 'nonzero-empty-output', 'nonzero-with-stderr', 'nonzero-with-stdout',
    'missing-database-output', 'missing-images-output', 'invalid-result'];

  function expectFixedReport(report: ReturnType<typeof describeGenerationResult>) {
    expect(Object.keys(report)).toEqual(keys);
    expect(tags).toContain(report.tag);
    for (const field of ['exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes'] as const) {
      const value = report[field];
      expect(value === null || typeof value === 'number' && Number.isSafeInteger(value)).toBe(true);
      if (field !== 'exitCode' && value !== null) expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(typeof report.hasDatabaseOutput).toBe('boolean');
    expect(typeof report.hasImagesOutput).toBe('boolean');
    expect(JSON.stringify(report).length).toBeLessThan(400);
  }

  it('describes the exact successful tuple without changing or returning it', () => {
    const result = Object.freeze({ code: 0, stdout, stderr: '' });
    const report = describeGenerationResult(result, 12.75);
    expect(report).toEqual({
      tag: 'success', exitCode: 0, elapsedMs: 12, stdoutBytes: 42, stderrBytes: 0,
      hasDatabaseOutput: true, hasImagesOutput: true,
    });
    expectFixedReport(report);
    expect(result).toEqual({ code: 0, stdout, stderr: '' });
  });

  it.each([
    [2, '', '', 'nonzero-empty-output', false, false],
    [1, '', 'synthetic error', 'nonzero-with-stderr', false, false],
    [1, stdout, 'synthetic error', 'nonzero-with-stderr', true, true],
    [-1, stdout, '', 'nonzero-with-stdout', true, true],
    [0, '', '', 'missing-database-output', false, false],
    [0, 'item_images:', '', 'missing-database-output', false, true],
    [0, 'export type Database = {}', '', 'missing-images-output', true, false],
    [0, stdout, 'synthetic warning', 'success', true, true],
    [0, 'export type Database= { item_images : {} }', '', 'missing-database-output', false, false],
  ])('uses observational precedence for case %#', (code, output, error, tag, database, images) => {
    const report = describeGenerationResult({ code, stdout: output, stderr: error }, 180_001);
    expectFixedReport(report);
    expect(report).toMatchObject({ tag, exitCode: code, hasDatabaseOutput: database, hasImagesOutput: images });
    expect(report.stdoutBytes).toBe(Buffer.byteLength(output as string, 'utf8'));
    expect(report.stderrBytes).toBe(Buffer.byteLength(error as string, 'utf8'));
  });

  it('counts UTF-8 bytes of retained strings, not characters or supplied counters', () => {
    const report = describeGenerationResult({
      code: 1, stdout: 'ä🙂', stderr: '漢\u0000', stdoutBytes: 999, stderrBytes: 999,
      tag: 'success', hasDatabaseOutput: true, hasImagesOutput: true,
    }, 0);
    expectFixedReport(report);
    expect(report).toEqual({
      tag: 'nonzero-with-stderr', exitCode: 1, elapsedMs: 0, stdoutBytes: 6, stderrBytes: 4,
      hasDatabaseOutput: false, hasImagesOutput: false,
    });
  });

  it.each([undefined, null, false, '0', 1n, NaN, Infinity, -Infinity, 0.5,
    Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])('rejects invalid exit code case %#', (code) => {
    const report = describeGenerationResult({ code, stdout, stderr: '' }, 1);
    expectFixedReport(report);
    expect(report).toMatchObject({ tag: 'invalid-result', exitCode: null, hasDatabaseOutput: true, hasImagesOutput: true });
  });

  it.each([undefined, null, '1', false, 1n, NaN, Infinity, -Infinity, -0.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid elapsed case %#', (elapsed) => {
      const report = describeGenerationResult({ code: 0, stdout, stderr: '' }, elapsed);
      expectFixedReport(report);
      expect(report).toMatchObject({ tag: 'invalid-result', elapsedMs: null });
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER])('preserves bounded exit code %s', (code) => {
    const report = describeGenerationResult({ code, stdout, stderr: '' }, Number.MAX_SAFE_INTEGER);
    expectFixedReport(report);
    expect(report).toMatchObject({ exitCode: code, elapsedMs: Number.MAX_SAFE_INTEGER,
      tag: code === 0 ? 'success' : 'nonzero-with-stdout' });
  });

  it('never serializes synthetic private text, including malformed and unknown inputs', () => {
    const canary = 'generation-report-canary-8f42c6e9';
    const privateParts = [
      canary, ['sb', 'secret', 'fictional-only-0123456789'].join('_'),
      ['ghp', 'x'.repeat(36)].join('_'),
      [Buffer.from('{}').toString('base64url'),
        Buffer.from(JSON.stringify({ role: ['service', 'role'].join('_') })).toString('base64url'), 'signature'].join('.'),
      ['postgresql:', '//fictional:never-a-password@example.test/db'].join(''),
      '/private/fictional.sql', 'SELECT fictional_private_value;',
    ];
    const text = privateParts.join('\n');
    const accessor = vi.fn(() => { throw new Error(text); });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const unknown = { code: 0, stdout, stderr: '', toJSON: accessor, message: text, path: text, payload: text };
    Object.defineProperty(unknown, 'unrelated', { get: accessor });
    const cases = [
      undefined, null, true, 0, text, Symbol(text), [], new Error(text), {},
      Object.create({ code: 0, stdout, stderr: '' }),
      { code: 0, stdout: text, stderr: text }, { code: 1, stdout: text, stderr: text },
      { code: 1, stdout: text, stderr: '' }, { code: 2, stdout: '', stderr: '' },
      { code: 0, stdout: `${stdout}\n${text}`, stderr: text },
      { code: 0, stdout: `export type Database = {}\n${text}`, stderr: text },
      { code: text, stdout: text, stderr: text }, { code: 0, stdout: { toString: accessor }, stderr: text },
      { code: 0, stdout: text, stderr: null }, Object.defineProperty({}, 'code', { get: accessor }),
      new Proxy({}, { getOwnPropertyDescriptor: accessor }), revoked.proxy, unknown,
    ];
    for (const result of cases) {
      const report = describeGenerationResult(result, 1);
      expectFixedReport(report);
      for (const part of privateParts) expect(JSON.stringify(report).includes(part)).toBe(false);
    }
    for (const result of [null, {}, new Error(text), revoked.proxy,
      { code: 0, stdout: null, stderr: '' }, { code: 0, stdout, stderr: [] }]) {
      expect(describeGenerationResult(result, 1).tag).toBe('invalid-result');
    }
    expect(accessor).toHaveBeenCalledTimes(1); // Only the throwing Proxy trap, never an accessor/coercion/toJSON.
    expect(describeGenerationResult(unknown, text)).toMatchObject({ tag: 'invalid-result', elapsedMs: null });
  });
});

describe('security failure classification', () => {
  const outage = new LocalBackendError('BLOCKED: fictional outage.');
  const assertion = new AssertionError({ message: 'Fictional assertion failure.' });

  it.each([undefined, 0, 1, 2])('preserves primary %s across cleanup outages and assertion failures', (primary) => {
    expect(securityFailureExitCode(primary, outage)).toBe(primary === 1 ? 1 : 2);
    expect(securityFailureExitCode(primary, assertion)).toBe(primary === 2 ? 2 : 1);
  });

  it.each([undefined, null, false, 0, 'BLOCKED', { name: 'LocalBackendError', exitCode: 2 }])('never treats an unknown error as success: %j', (error) => {
    for (const primary of [undefined, 0, 1, 2]) {
      expect(securityFailureExitCode(primary, error)).toBe(primary === 2 ? 2 : 1);
    }
  });

  it.each([null, -1, 3, Number.NaN, '0', '1', '2', {}])('does not propagate an unrecognized primary value: %j', (primary) => {
    expect(securityFailureExitCode(primary, outage)).toBe(2);
    expect(securityFailureExitCode(primary, assertion)).toBe(1);
  });
});

describe('disposable local backend boundaries', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321/', 'http://[::1]:54321'])('accepts literal loopback origin %s', (url) => {
    expect(assertLocalApi(url)).toBe(url.replace(/\/$/, ''));
  });

  it.each([
    'https://example.supabase.co', 'http://127.0.0.1.evil.test:54321', 'http://user:password@localhost:54321',
    'http://localhost:54321/path', 'http://localhost:54321/?redirect=remote', 'http://localhost:54321/#fragment',
    'http://0.0.0.0:54321', 'http://127.1:54321', 'http://2130706433:54321', 'http://0177.0.0.1:54321',
    'https://localhost:54321', 'http://[::ffff:127.0.0.1]:54321', 'file:///localhost', 'not a URL',
  ])('refuses unsafe/nonliteral URL %s', (url) => {
    expect(() => assertLoopbackUrl(url)).toThrow(/REFUSED/);
  });

  it('restricts tests to the fixed disposable API port even on loopback', () => {
    expect(() => assertLocalApi('http://localhost:443')).toThrow(/port 54321/);
    expect(() => assertLocalApi('http://127.0.0.1:54324')).toThrow(/port 54321/);
    expect(() => validateSessionEnvironment({ ...credentials, SUPABASE_URL: 'https://example.supabase.co', ALLOW_REMOTE_TEST_PROJECT: '1' })).toThrow(/REFUSED/);
  });

  it('rejects both modern service keys and service-role JWTs', () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ role: ['service', 'role'].join('_') })).toString('base64url')}.signature`;
    expect(() => assertPublishableKey(['sb', 'secret', 'unit'].join('_'))).toThrow(/REFUSED/);
    expect(() => assertPublishableKey(jwt)).toThrow(/REFUSED/);
    expect(() => assertPublishableKey('unknown')).toThrow(/REFUSED/);
    const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
    expect(assertPublishableKey(anon)).toBe(anon);
  });

  it('requires explicit consent and distinct fictional credentials', () => {
    expect(() => validateSessionEnvironment({ ...credentials, ALLOW_SECURITY_TESTS: '' })).toThrow(/NOT RUN/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_A_PASSWORD: '' })).toThrow(/NOT RUN/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_B_PASSWORD: credentials.TEST_A_PASSWORD })).toThrow(/REFUSED/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_A_EMAIL: 'not-a-fixture@example.test' })).toThrow(/REFUSED/);
  });

  it('whitelists child environment and refuses administrator variables', () => {
    const env = normalSessionEnvironment({
      ALLOW_SECURITY_TESTS: '1', NODE_OPTIONS: '--inspect', UNRELATED_TOKEN: 'private',
      GH_TOKEN: 'not-forwarded', GITHUB_TOKEN: 'not-forwarded', AWS_SECRET_ACCESS_KEY: 'not-forwarded',
    }, credentials);
    expect(Object.keys(env).sort()).toEqual(Object.keys(credentials).sort());
    expect(() => normalSessionEnvironment({ ALLOW_SECURITY_TESTS: '1', SUPABASE_SERVICE_ROLE_KEY: 'private' }, credentials)).toThrow(/REFUSED/);
    expect(() => normalSessionEnvironment({ ALLOW_SECURITY_TESTS: '1', DATABASE_URL: 'private' }, credentials)).toThrow(/REFUSED/);
    expect(commandEnvironment({
      PATH: 'local', SUPABASE_ACCESS_TOKEN: 'private', NODE_OPTIONS: '--inspect', SUPABASE_CLI_BINARY_OVERRIDE: 'other',
      GH_TOKEN: 'not-forwarded', GITHUB_TOKEN: 'not-forwarded', AWS_SECRET_ACCESS_KEY: 'not-forwarded',
    })).toEqual({
      PATH: 'local', NO_COLOR: '1', SUPABASE_TELEMETRY_DISABLED: 'true',
    });
  });

  it('reports missing Docker as NOT RUN with nonzero exit status without requiring Docker', async () => {
    const run = vi.fn().mockResolvedValue({ code: 2, stdout: '', stderr: 'never surfaced' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('NOT RUN: Docker') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses remote Docker contexts before any daemon/reset operation', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ssh://remote.example.test', stderr: '' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('REFUSED') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine'])('checks daemon health for local Docker endpoint %s', async (endpoint) => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: endpoint, stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'never surfaced' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('NOT RUN') });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('requires the known project label, container name and Postgres image', async () => {
    const container = { name: `/${DB_CONTAINER}`, project: PROJECT_ID, image: 'public.ecr.aws/supabase/postgres:17.6.1', running: true };
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(container), stderr: '' });
    await expect(requireLocalContainer(run)).resolves.toBeUndefined();
    for (const change of [{ project: 'another-project' }, { name: '/different-db' }, { running: false }, { image: 'postgres:17' }]) {
      run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ...container, ...change }), stderr: '' });
      await expect(requireLocalContainer(run)).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('rejects unknown/remote db arguments without reaching Docker', () => {
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.mjs'), 'reset', '--linked'], {
      env: commandEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('REFUSED');
    expect(child.stdout).toBe('');
  });

  it.each([
    ['scripts', 'run-local-tests.mjs', 'security'],
    ['scripts', 'run-local-tests.mjs', 'integration'],
    ['tests', 'security', 'rls.sessions.mjs'],
    ['tests', 'integration', 'local.sessions.mjs'],
  ])('does not silently skip unavailable normal-session configuration: %s %s', (...segments) => {
    const isRunner = segments[0] === 'scripts';
    const file = path.join(ROOT, ...segments.slice(0, isRunner ? 2 : 3));
    const child = spawnSync(process.execPath, [file, ...(isRunner ? [segments[2]!] : [])], {
      env: commandEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('NOT RUN');
    expect(child.stdout).not.toContain('PASS');
  });

  it('keeps the reviewed migration and synthetic JPEG byte-for-byte intact', async () => {
    const source = await readFile(path.join(ROOT, 'blueprint', '07-DATABASE-AND-RLS.sql'));
    const migration = await readFile(path.join(ROOT, 'supabase', 'migrations', '20260905000000_initial.sql'));
    expect(migration.equals(source)).toBe(true);
    expect(createHash('sha256').update(migration).digest('hex')).toBe(MIGRATION_HASH);
    const original = await readFile(path.join(ROOT, 'blueprint', 'validation', 'fixture.jpg'));
    const fixture = await readFile(path.join(ROOT, 'tests', 'security', 'fixture.jpg'));
    expect(fixture.equals(original)).toBe(true);
  });
});
