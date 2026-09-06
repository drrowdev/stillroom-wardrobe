import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, DB_CONTAINER, PROJECT_ID, MIGRATION_HASH, assertLoopbackUrl, assertLocalApi, assertPublishableKey,
  normalSessionEnvironment, validateSessionEnvironment, commandEnvironment, requireDocker, requireLocalContainer,
} from '../../scripts/backend/local.mjs';

const credentials = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only',
  TEST_A_EMAIL: 'user-a@example.test', TEST_A_PASSWORD: 'a'.repeat(32),
  TEST_B_EMAIL: 'user-b@example.test', TEST_B_PASSWORD: 'b'.repeat(32),
  ALLOW_SECURITY_TESTS: '1',
};

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
