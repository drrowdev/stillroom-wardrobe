import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable CI runner has no TypeScript declaration.
import { MIGRATIONS, migrateToAzureTarget, preservationStagePath } from '../../scripts/preservation-rehearsal.mjs';
import { ROOT } from '../../scripts/backend/local.mjs';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), list: vi.fn(), write: vi.fn(), rm: vi.fn(),
  cli: vi.fn(), run: vi.fn(), project: vi.fn(), container: vi.fn(),
}));
vi.mock('node:fs/promises', async () => ({
  ...await vi.importActual('node:fs/promises'),
  readFile: mocks.read, lstat: mocks.stat, mkdir: mocks.mkdir, readdir: mocks.list,
  writeFile: mocks.write, rm: mocks.rm,
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual('../../scripts/backend/local.mjs'),
  cli: mocks.cli, runCommand: mocks.run, assertProjectConfig: mocks.project, requireLocalContainer: mocks.container,
}));
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const run = '510b0000-0000-4000-8000-000000000001';
const stage = path.join(ROOT, '.supabase', `preservation-stage-${run}`);
type Migration = { name: string; version: string; time: string };
const migrations = MIGRATIONS as Migration[];
const packagePath = createRequire(import.meta.url).resolve('supabase/package.json');
let files: Map<string, Buffer>, directories: Set<string>, applied: number;
const originalExitCode = process.exitCode;
const history = () => ({
  code: 0, stderr: '', stdout: [
    'Local | Remote | Time (UTC)', '-------|--------|-----------',
    ...migrations.map((m, i) => `\`${m.version}\` | \`${i < applied ? m.version : ' '}\` | \`${m.time}\``),
  ].join('\n'),
});
const node = (name: string, directory: boolean) => ({
  name, isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory,
});
beforeEach(async () => {
  vi.resetAllMocks(); files = new Map(); directories = new Set([path.dirname(stage)]); applied = 9;
  for (const key of Object.keys(process.env)) if (/(?:SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)|DATABASE_URL|DB_PASSWORD|PGPASSWORD)/i.test(key)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({
    ALLOW_CI_STORAGE_GUARD_INSTALL: '1', ALLOW_PRESERVATION_REHEARSAL: '1', CI: 'true',
    GITHUB_ACTIONS: 'true', GITHUB_JOB: 'database', GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe',
  })) vi.stubEnv(key, value);
  const configPath = path.join(ROOT, 'supabase', 'config.toml');
  files.set(configPath, await actual.readFile(configPath));
  for (const migration of migrations) {
    const filename = path.join(ROOT, 'supabase', 'migrations', migration.name);
    files.set(filename, await actual.readFile(filename));
  }
  files.set(packagePath, Buffer.from(JSON.stringify({ version: '2.116.0', bin: { supabase: 'bin/supabase' } })));
  directories.add(path.join(ROOT, 'supabase', 'migrations'));
  mocks.read.mockImplementation(async (filename: string, encoding?: string) => {
    const data = files.get(filename); if (!data) throw new Error('Missing fixture path');
    return encoding === 'utf8' ? data.toString('utf8') : data;
  });
  mocks.stat.mockImplementation(async (filename: string) => {
    if (!directories.has(filename) && !files.has(filename)) throw new Error('Missing fixture path');
    return { ...node(path.basename(filename), directories.has(filename)), size: files.get(filename)?.length ?? 0 };
  });
  mocks.mkdir.mockImplementation(async (filename: string) => {
    if (files.has(filename) || directories.has(filename)) throw new Error('Existing fixture path');
    directories.add(filename);
  });
  mocks.write.mockImplementation(async (filename: string, bytes: Uint8Array, options: unknown) => {
    expect(options).toEqual({ flag: 'wx' }); expect(files.has(filename)).toBe(false);
    files.set(filename, Buffer.from(bytes));
  });
  mocks.list.mockImplementation(async (directory: string, options?: { withFileTypes?: boolean }) => {
    const entries = [...files.keys(), ...directories].filter((f) => path.dirname(f) === directory).sort();
    return entries.map((f) => options?.withFileTypes ? node(path.basename(f), directories.has(f)) : path.basename(f));
  });
  mocks.rm.mockResolvedValue(undefined);
  mocks.cli.mockImplementation(async (args: string[]) => { expect(args).toEqual(['migration', 'list', '--local']); return history(); });
  mocks.run.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--version')) return { code: 0, stdout: '2.116.0\n', stderr: '' };
    if (args.includes('inspect')) return { code: 0, stdout: 'a'.repeat(64) + '\n', stderr: '' };
    expect(args.slice(-3)).toEqual(['migration', 'up', '--local']);
    applied = 10; return { code: 0, stdout: '', stderr: '' };
  });
});
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = originalExitCode; vi.restoreAllMocks(); });
describe('copy-only populated ten-migration stage (mocked filesystem/processes; no database)', () => {
  it.each(['base', 'prior-main'])('copies only verified config and first ten files from %s, then proves ROOT history/container', async (from) => {
    applied = from === 'base' ? 1 : 9;
    await migrateToAzureTarget(run, from);
    expect(mocks.write).toHaveBeenCalledTimes(11);
    expect(mocks.write.mock.calls.map((args) => String(args[0])).sort()).toEqual([
      path.join(stage, 'supabase', 'config.toml'),
      ...migrations.slice(0, 10).map((m) => path.join(stage, 'supabase', 'migrations', m.name)),
    ].sort());
    expect(mocks.mkdir.mock.calls.every((args) => args.length === 1)).toBe(true);
    const mutation = mocks.run.mock.calls.filter((args) => (args[1] as string[]).includes('up'));
    expect(mutation).toHaveLength(1);
    expect(mutation[0]?.[1]).toEqual([path.join(path.dirname(packagePath), 'bin/supabase'),
      '--agent', 'no', '--workdir', stage, 'migration', 'up', '--local']);
    expect(mutation[0]?.[2]).toEqual({ timeout: 120_000 });
    expect(mocks.cli).toHaveBeenCalledTimes(3);
    expect(mocks.container).toHaveBeenCalledTimes(3);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
    expect(files.get(path.join(stage, 'supabase', 'config.toml'))).toEqual(files.get(path.join(ROOT, 'supabase', 'config.toml')));
    expect(files.has(path.join(stage, 'supabase', 'migrations', migrations[10]!.name))).toBe(false);
  });
  it.each(['../escape', '', '510b0000-0000-4000-8000-000000000001/child'])('rejects unsafe stage identity %s', (id) => {
    expect(() => preservationStagePath(id)).toThrow(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects an existing stage without deleting or adopting it', async () => {
    directories.add(stage);
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.rm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
  });
  it('rejects a symlinked parent before any copy/CLI', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => true });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects changed source bytes and never copies unverified migrations', async () => {
    files.set(path.join(ROOT, 'supabase', 'migrations', migrations[0]!.name), Buffer.from('changed'));
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.mkdir).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it('does not fall through to ROOT migration up on a staged CLI failure', async () => {
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' } : args.includes('inspect')
        ? { code: 0, stdout: 'a'.repeat(64), stderr: '' } : { code: 1, stdout: '', stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
    expect(mocks.run.mock.calls.filter((args) => (args[1] as string[]).includes('up'))).toHaveLength(1);
  });
  it('refuses a different database container after the copy instead of migrating it', async () => {
    let inspections = 0;
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' }
      : { code: 0, stdout: (++inspections === 1 ? 'a' : 'b').repeat(64), stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('rejects changed copied config before migration rather than trimming function declarations', async () => {
    const original = mocks.write.getMockImplementation()!;
    mocks.write.mockImplementation(async (...args: unknown[]) => {
      await original(...args);
      if (args[0] === path.join(stage, 'supabase', 'config.toml')) files.set(String(args[0]), Buffer.from('changed'));
    });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('rejects ROOT ledger drift after copying and before any staged migration', async () => {
    let reads = 0;
    mocks.cli.mockImplementation(async () => { if (++reads === 2) applied = 10; return history(); });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('does not claim successful staging if the command leaves nine applied migrations', async () => {
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' } : args.includes('inspect')
        ? { code: 0, stdout: 'a'.repeat(64), stderr: '' } : { code: 0, stdout: '', stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(applied).toBe(9); expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('keeps a cleanup failure nonzero even after successful migration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rm.mockRejectedValue(new Error('Owned cleanup unavailable'));
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow('Owned cleanup unavailable');
    expect(process.exitCode).toBe(1); expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
  });
});
