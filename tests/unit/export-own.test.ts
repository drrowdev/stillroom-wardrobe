// scripts/export-own.mjs against a fake GoTrue/PostgREST/Storage server, through the real supabase-js client and the
// CLI's own transport guard, on a real temporary folder. Failures are injected between individual file operations.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLock, ExportError, forbiddenEnvironment, guardedFetch, nodeFiles, parseArguments, parseSecrets, publishableKey, releaseLock, resolveEndpoint, runExport, syncDirectory,
} from '../../scripts/export-own.mjs';
import { PromptError, readTerminalLine } from '../../scripts/backup-prompt.mjs';
import { listParts, partSource } from '../../scripts/verify-backup.mjs';
import { decryptPart, verifyBackup } from '../../src/domain/export-format';
import { parityWorld, PARITY_OWNER, type ParityWorld } from '../fixtures/export-parity';

const ORIGIN = 'http://127.0.0.1:54321';
const KEY = 'sb_publishable_unitTestKey_0123456789';
const EMAIL = 'owner.synthetic@example.test';
const PASSWORD = 'synthetic password with spaces ';
const PASSPHRASE = 'synthetic backup passphrase 2026';
const NOW = Date.parse('2026-09-25T10:30:00Z');
const ENV = { SUPABASE_PUBLISHABLE_KEY: KEY };
const permissive = () => {};
const ARGS = (dir: string) => ['--output', dir, '--local', ORIGIN];

type Server = {
  world: ParityWorld; calls: string[]; tokens: string[]; ttl: number; failRefresh: boolean; failStorage: (path: string) => number | null;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(sub: string, n: number) { return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', n })}.c2lnbmF0dXJl`; }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeServer(world: ParityWorld): Server {
  let issued = 0;
  const server: Server = {
    world, calls: [], tokens: [], ttl: 3600, failRefresh: false, failStorage: () => null,
    fetch: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const route = `${init.method} ${url.pathname}${url.search}`;
      server.calls.push(route);
      const session = () => {
        const token = jwt(PARITY_OWNER, ++issued);
        server.tokens.push(token);
        return json(200, { access_token: token, token_type: 'bearer', expires_in: server.ttl, expires_at: Math.floor(Date.now() / 1000) + server.ttl,
          refresh_token: `refresh-${issued}`, user: { id: PARITY_OWNER, aud: 'authenticated', role: 'authenticated', email: EMAIL } });
      };
      if (route === 'POST /auth/v1/token?grant_type=password') {
        const body = JSON.parse(String(init.body));
        return body.email === EMAIL && body.password === PASSWORD ? session() : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      if (route === 'POST /auth/v1/token?grant_type=refresh_token') return server.failRefresh ? json(400, { error: 'invalid_grant' }) : session();
      if (route === 'POST /auth/v1/logout?scope=local') return new Response(null, { status: 204 });
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
      if (!bearer || !server.tokens.includes(bearer)) return json(401, { message: 'JWT expired' });
      if (route === 'POST /rest/v1/rpc/export_manifest') {
        const args = JSON.parse(String(init.body));
        return json(200, { ...world.raw, export_id: args.p_export_id });
      }
      if (route === 'POST /rest/v1/rpc/item_attribution_history') {
        const value = world.attributions.get(JSON.parse(String(init.body)).p_item_id);
        return value === undefined ? json(403, { code: '42501', message: 'not saved' }) : json(200, value);
      }
      const prefix = '/storage/v1/object/authenticated/wardrobe/';
      if (init.method === 'GET' && url.pathname.startsWith(prefix)) {
        const path = url.pathname.slice(prefix.length);
        const failure = server.failStorage(path);
        if (failure) return json(failure, { message: 'unavailable' });
        const bytes = world.objects.get(path);
        return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 }) : json(404, { message: 'Object not found' });
      }
      return json(404, { message: 'no route' });
    },
  };
  return server;
}

function sink() { let text = ''; return { write: (chunk: string) => { text += chunk; return true; }, get text() { return text; } }; }
const piped = (text: string) => Readable.from([Buffer.from(text)]);
const secrets = (passphrase = PASSPHRASE) => `${EMAIL}\n${PASSWORD}\n${passphrase}\n`;

const CRASH = Object.assign(new Error('simulated crash'), { code: 'ECRASH' });
// Counts every file operation (including those on open handles). At operation `at` the process "dies": that and every
// later operation fails, handles are still really closed so the folder stays usable on Windows, and no cleanup succeeds.
function crashingFiles(at: number) {
  const state = { count: 0, crashed: false, ops: [] as string[] };
  const step = (name: string) => {
    if (state.crashed) throw CRASH;
    state.count++;
    state.ops.push(name);
    if (state.count === at) { state.crashed = true; throw CRASH; }
  };
  const wrap = <T extends unknown[], R>(name: string, run: (...args: T) => Promise<R>) => async (...args: T) => { step(name); return run(...args); };
  const files = {
    lstat: wrap('lstat', nodeFiles.lstat), readdir: wrap('readdir', nodeFiles.readdir), mkdir: wrap('mkdir', nodeFiles.mkdir),
    rename: wrap('rename', nodeFiles.rename), link: wrap('link', nodeFiles.link), unlink: wrap('unlink', nodeFiles.unlink), rmdir: wrap('rmdir', nodeFiles.rmdir),
    open: async (path: string, flags: string, mode?: number) => {
      step(`open:${flags}`);
      const handle = await nodeFiles.open(path, flags, mode);
      return {
        writeFile: async (data: string) => { step('write'); return handle.writeFile(data); },
        sync: async () => { step('sync'); return handle.sync(); },
        stat: () => handle.stat(),
        read: (...args: Parameters<typeof handle.read>) => handle.read(...args),
        close: async () => { await handle.close(); step('close'); },
      };
    },
  };
  return { files, state };
}

const dirs: string[] = [];
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'export-own-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(server: Server, dir: string, extra: Record<string, unknown> = {}) {
  const stdout = sink(), stderr = sink();
  const code = await runExport({ argv: ARGS(dir), env: ENV, stdin: piped(secrets()), stdout, stderr, fetchImpl: server.fetch, now: () => NOW,
    checkJpeg: permissive, ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function finished(dir: string) {
  const names = (await readdir(dir)).filter(name => name.startsWith('stillroom-'));
  return names;
}
async function verifyFinal(dir: string, name: string) {
  return verifyBackup(partSource(await listParts(join(dir, name))), PASSPHRASE, permissive);
}

describe('export-own arguments and refusals', () => {
  it('accepts only --output and --local, each once, with a value', () => {
    expect(parseArguments(['--output', 'out']).local).toBeUndefined();
    expect(parseArguments(['--output', 'out', '--local', ORIGIN]).local).toBe(ORIGIN);
    for (const argv of [[], ['--local', ORIGIN], ['--output'], ['--output', 'a', '--output', 'b'], ['--output', 'a', 'extra'],
      ['--output', 'a', '--password', 'x'], ['--output', 'a', '--passphrase', 'x'], ['--output', '--local'], ['--email', 'a', '--output', 'b']]) {
      expect(() => parseArguments(argv), argv.join(' ')).toThrow(expect.objectContaining({ code: 'usage' }));
    }
  });

  it('allows only the configured project, or --local on a loopback address with a port', () => {
    expect(resolveEndpoint({}, undefined)).toBe('https://xwrdrugastphdiihzuia.supabase.co');
    expect(resolveEndpoint({ SUPABASE_URL: 'https://xwrdrugastphdiihzuia.supabase.co' }, undefined)).toBe('https://xwrdrugastphdiihzuia.supabase.co');
    expect(resolveEndpoint({}, 'http://localhost:54321/')).toBe('http://localhost:54321');
    expect(resolveEndpoint({}, 'http://[::1]:5000')).toBe('http://[::1]:5000');
    expect(resolveEndpoint({ SUPABASE_URL: ORIGIN }, ORIGIN)).toBe(ORIGIN);
    const refused: Array<[Record<string, string>, string | undefined]> = [
      [{ SUPABASE_URL: 'https://other.supabase.co' }, undefined], [{ SUPABASE_URL: ORIGIN }, undefined], [{ SUPABASE_URL: 'http://127.0.0.1:1' }, ORIGIN],
      [{}, 'http://example.com:54321'], [{}, 'https://127.0.0.1:54321'], [{}, 'http://127.0.0.1'], [{}, 'http://user:pw@127.0.0.1:54321'],
      [{}, 'http://127.0.0.1:54321/rest'], [{}, 'http://127.0.0.1:54321/?x=1'], [{}, 'http://127.0.0.1:54321/#a'], [{}, 'http://127.0.0.2:54321'],
      [{}, 'http://0x7f.0.0.1:54321'], [{}, 'not a url'],
    ];
    for (const [env, local] of refused) expect(() => resolveEndpoint(env, local), `${local}`).toThrow(expect.objectContaining({ code: 'endpoint' }));
  });

  it('accepts only a publishable or anon key and refuses administrator credentials in the environment', () => {
    expect(publishableKey({ SUPABASE_PUBLISHABLE_KEY: KEY })).toBe(KEY);
    const anon = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon' })}.sig`;
    expect(publishableKey({ SUPABASE_PUBLISHABLE_KEY: anon })).toBe(anon);
    for (const key of [undefined, '', ['sb', 'secret', 'abcdefghijklmnop'].join('_'), `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.sig`, 'sb_publishable_short']) {
      expect(() => publishableKey({ SUPABASE_PUBLISHABLE_KEY: key } as never)).toThrow(expect.objectContaining({ code: 'key' }));
    }
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE', 'APP_SECRET_KEY', 'SUPABASE_ACCESS_TOKEN', 'DATABASE_URL', 'PGPASSWORD', 'DB_PASSWORD']) {
      expect(forbiddenEnvironment({ [name]: 'x' }), name).toBe(true);
    }
    expect(forbiddenEnvironment({ SUPABASE_PUBLISHABLE_KEY: KEY, PATH: '/bin', SUPABASE_SERVICE_ROLE_KEY: '' })).toBe(false);
  });

  it('refuses before prompting or connecting', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 100, 50));
    for (const [argv, env, code] of [
      [['--output', dir, '--password', 'x'], ENV, 'usage'], [ARGS(dir), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'x' }, 'environment'],
      [['--output', dir, '--local', 'http://evil.test:1'], ENV, 'endpoint'], [ARGS(dir), {}, 'key'],
    ] as const) {
      const stderr = sink();
      const stdin = piped(secrets());
      expect(await runExport({ argv: [...argv], env, stdin, stdout: sink(), stderr, fetchImpl: server.fetch })).toBe(2);
      expect(stderr.text).toContain(`Backup refused (${code})`);
      expect(stdin.readableEnded).toBe(false);
    }
    expect(server.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('export-own piped secrets', () => {
  const ok = { email: EMAIL, password: PASSWORD, passphrase: PASSPHRASE };
  it('reads exactly three LF or CRLF lines without trimming', () => {
    for (const text of [secrets(), `${EMAIL}\n${PASSWORD}\n${PASSPHRASE}`, `${EMAIL}\r\n${PASSWORD}\r\n${PASSPHRASE}\r\n`, `${EMAIL}\r\n${PASSWORD}\n${PASSPHRASE}`]) {
      expect(parseSecrets(Buffer.from(text))).toEqual(ok);
    }
    expect(parseSecrets(Buffer.from(`${EMAIL}\n  pw  \n ${PASSPHRASE} \n`))).toEqual({ email: EMAIL, password: '  pw  ', passphrase: ` ${PASSPHRASE} ` });
  });
  it('refuses missing, extra or malformed lines, bad UTF-8, NUL, stray CR, overlong input and short passphrases', () => {
    const bad = [
      '', `${EMAIL}\n${PASSWORD}\n`, `${EMAIL}\n${PASSWORD}\n${PASSPHRASE}\n\n`, `${EMAIL}\n${PASSWORD}\n${PASSPHRASE}\nextra\n`,
      `${EMAIL}\n\n${PASSPHRASE}\n`, `not-an-email\n${PASSWORD}\n${PASSPHRASE}\n`, ` ${EMAIL}\n${PASSWORD}\n${PASSPHRASE}\n`,
      `${EMAIL}\n${PASSWORD}\n${'x'.repeat(15)}\n`, `${EMAIL}\npass\rword\n${PASSPHRASE}\n`, `${EMAIL}\n${PASSWORD}\0\n${PASSPHRASE}\n`,
      `${EMAIL}\n${'p'.repeat(1025)}\n${PASSPHRASE}\n`, `${EMAIL}\n${PASSWORD}\n${'q'.repeat(1025)}\n`,
    ].map(text => Buffer.from(text));
    bad.push(Buffer.concat([Buffer.from(`${EMAIL}\n`), Buffer.from([0xc3, 0x28]), Buffer.from(`\n${PASSPHRASE}\n`)]));
    bad.push(Buffer.from(`${EMAIL}\n${PASSWORD}\n${'z'.repeat(4096)}`));
    for (const buffer of bad) expect(() => parseSecrets(buffer)).toThrow(expect.objectContaining({ code: 'input' }));
    expect(parseSecrets(Buffer.from(`${EMAIL}\n${PASSWORD}\n${'x'.repeat(16)}`)).passphrase).toHaveLength(16);
  });
});

class FakeTerminal extends EventEmitter {
  isTTY = true; raw = false; paused = true;
  setRawMode(value: boolean) { this.raw = value; return this; }
  setEncoding() { return this; }
  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
}
describe('terminal prompts', () => {
  it('never echoes hidden input, handles backspace and escapes, and restores the terminal on every path', async () => {
    for (const [keys, expected] of [['secret\u007fT\r', 'secreT'], ['a\u001b[Db\n', 'ab']] as const) {
      const input = new FakeTerminal(), output = sink();
      const line = readTerminalLine({ input, output, prompt: 'P: ', hidden: true, limit: 50 });
      expect(input.raw).toBe(true);
      input.emit('data', keys);
      expect(await line).toBe(expected);
      expect(output.text).toBe('P: \n');
      expect([input.raw, input.paused, input.listenerCount('data'), input.listenerCount('end'), input.listenerCount('error')]).toEqual([false, true, 0, 0, 0]);
    }
    for (const [event, payload, problem] of [['data', 'ab\u0003', 'cancelled'], ['data', '\u0004', 'cancelled'], ['end', undefined, 'cancelled'],
      ['error', new Error('x'), 'cancelled'], ['data', 'abcdef', 'tooLong']] as const) {
      const input = new FakeTerminal(), output = sink();
      const line = readTerminalLine({ input, output, prompt: '', hidden: true, limit: 3 });
      input.emit(event, payload);
      await expect(line).rejects.toEqual(expect.objectContaining({ problem }));
      expect([input.raw, input.listenerCount('data'), input.listenerCount('end'), input.listenerCount('error')]).toEqual([false, 0, 0, 0]);
      expect(output.text).not.toContain('ab');
    }
    const input = new FakeTerminal(), output = sink();
    const visible = readTerminalLine({ input, output, prompt: '', hidden: false, limit: 3, overflow: 'ignore' });
    input.emit('data', 'abcdef\r');
    expect(await visible).toBe('abc');
    expect(output.text).toBe('abc\n');
    expect(new PromptError('cancelled').problem).toBe('cancelled');
  });

  it('prompts on a terminal, confirms a new passphrase and refuses a mismatch', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 100, 50));
    const stdin = new FakeTerminal();
    const stderr = sink();
    const done = runExport({ argv: ARGS(dir), env: ENV, stdin, stdout: sink(), stderr, fetchImpl: server.fetch, now: () => NOW, checkJpeg: permissive });
    for (const line of [EMAIL, PASSWORD, PASSPHRASE, `${PASSPHRASE}x`]) {
      await expect.poll(() => stdin.listenerCount('data')).toBe(1);
      stdin.emit('data', `${line}\r`);
    }
    expect(await done).toBe(2);
    expect(stderr.text).toContain('Backup refused (mismatch)');
    expect(stderr.text).toContain(EMAIL);
    expect(stderr.text).not.toContain(PASSWORD.trim());
    expect(stderr.text).not.toContain(PASSPHRASE);
    expect(server.calls).toEqual([]);
    expect(stdin.raw).toBe(false);
  });
});

describe('transport guard', () => {
  it('allows only the fixed routes, the key and the owner storage prefix, without redirects, cookies or caching', async () => {
    const seen: RequestInit[] = [];
    const state = { owner: PARITY_OWNER, refused: false };
    const guarded = guardedFetch({ origin: ORIGIN, key: KEY, fetchImpl: async (_: string, init: RequestInit) => { seen.push(init); return new Response('{}'); }, state });
    const h = { apikey: KEY };
    const image = `${PARITY_OWNER}/${PARITY_OWNER}/${PARITY_OWNER}/main.jpg`;
    await guarded(`${ORIGIN}/auth/v1/token?grant_type=password`, { method: 'POST', headers: h });
    await guarded(`${ORIGIN}/rest/v1/rpc/export_manifest`, { method: 'POST', headers: h });
    await guarded(`${ORIGIN}/storage/v1/object/authenticated/wardrobe/${image}`, { headers: h });
    expect(seen.map(init => [init.redirect, init.credentials, init.cache])).toEqual(Array(3).fill(['error', 'omit', 'no-store']));
    expect(seen.every(init => init.signal instanceof AbortSignal)).toBe(true);
    const other = '99999999-9999-4999-8999-999999999999';
    for (const [url, init] of [
      [`http://127.0.0.1:1/rest/v1/rpc/export_manifest`, { method: 'POST', headers: h }], [`${ORIGIN}/rest/v1/items`, { headers: h }],
      [`${ORIGIN}/rest/v1/rpc/delete_account`, { method: 'POST', headers: h }], [`${ORIGIN}/rest/v1/rpc/export_manifest`, { method: 'POST', headers: { apikey: 'other' } }],
      [`${ORIGIN}/auth/v1/token?grant_type=password&x=1`, { method: 'POST', headers: h }], [`${ORIGIN}/auth/v1/logout?scope=global`, { method: 'POST', headers: h }],
      [`${ORIGIN}/storage/v1/object/authenticated/wardrobe/${other}/${other}/${other}/main.jpg`, { headers: h }],
      [`${ORIGIN}/storage/v1/object/authenticated/wardrobe/${image}`, { method: 'DELETE', headers: h }],
      [`${ORIGIN}/storage/v1/object/authenticated/wardrobe/${PARITY_OWNER}/../x/main.jpg`, { headers: h }],
    ] as const) {
      await expect(guarded(url, init as RequestInit), url).rejects.toBeInstanceOf(ExportError);
    }
    await expect(guarded(new Request(`${ORIGIN}/rest/v1/rpc/export_manifest`) as never, {})).rejects.toBeInstanceOf(ExportError);
    expect(seen).toHaveLength(3);
    expect(state.refused).toBe(true);
  });

  it('syncs folders, tolerating only the documented unsupported case on Windows', async () => {
    const failing = (code: string) => ({ ...nodeFiles, open: async () => { throw Object.assign(new Error(code), { code }); } }) as never;
    await expect(syncDirectory(failing('EISDIR'), 'x', 'win32')).resolves.toBeUndefined();
    await expect(syncDirectory(failing('EPERM'), 'x', 'win32')).resolves.toBeUndefined();
    await expect(syncDirectory(failing('EIO'), 'x', 'win32')).rejects.toMatchObject({ code: 'EIO' });
    await expect(syncDirectory(failing('EISDIR'), 'x', 'linux')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(syncDirectory(nodeFiles as never, await workspace(), process.platform)).resolves.toBeUndefined();
  });
});

describe('export-own backups', { timeout: 600_000 }, () => {
  it('writes a complete backup that verify-backup accepts, signs out and prints nothing private', async () => {
    const dir = await workspace();
    const world = parityWorld(3, 4000, 800);
    const server = fakeServer(world);
    const result = await run(server, dir);
    expect(result.code, result.stderr).toBe(0);
    const [name] = await finished(dir);
    expect(await readdir(dir)).toEqual([name]);
    const summary = await verifyFinal(dir, name!);
    expect(summary.metadata.owner_id).toBe(PARITY_OWNER);
    expect(result.stdout).toBe(`Backup complete: ${summary.parts} parts, ${summary.items} items, ${summary.photos} photos, ${summary.fileBytes} photo bytes, `
      + `metadata sha256 ${summary.manifestSha256}. Folder: ${name}\n`);
    expect(server.calls.at(-1)).toBe('POST /auth/v1/logout?scope=local');
    const output = result.stdout + result.stderr;
    for (const secret of [EMAIL, PASSWORD.trim(), PASSPHRASE, ...server.tokens, 'refresh-1', 'Synthetic garment', dir, 'Photo 1']) expect(output).not.toContain(secret);
  });

  it('refreshes a short-lived session through the guard, and a failed refresh leaves the backup incomplete', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(2, 3000, 500));
    server.ttl = 30;
    expect((await run(server, dir)).code).toBe(0);
    expect(server.calls.filter(call => call.includes('grant_type=refresh_token')).length).toBeGreaterThan(0);
    const again = await workspace();
    const failing = fakeServer(parityWorld(2, 3000, 500));
    // The session expires while the first snapshot is being read, so the next request must refresh, and the refresh is refused.
    failing.ttl = 2;
    failing.failRefresh = true;
    const serve = failing.fetch;
    failing.fetch = async (input, init) => {
      const response = await serve(input, init);
      if (String(input).endsWith('rpc/export_manifest')) await new Promise(done => setTimeout(done, 3000));
      return response;
    };
    const result = await run(failing, again);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Backup incomplete \((auth)\)/);
    expect(result.stdout).toBe('');
    expect(failing.calls).toContain('POST /auth/v1/token?grant_type=refresh_token');
  });

  it('a wrong password or an unreachable server leaves nothing behind', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 100, 50));
    const wrong = await runExport({ argv: ARGS(dir), env: ENV, stdin: piped(`${EMAIL}\nwrong\n${PASSPHRASE}\n`), stdout: sink(), stderr: sink(), fetchImpl: server.fetch });
    expect(wrong).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    const stderr = sink();
    expect(await runExport({ argv: ARGS(dir), env: ENV, stdin: piped(secrets()), stdout: sink(), stderr, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).toBe(1);
    expect(stderr.text).toContain('Backup incomplete (unavailable)');
    expect(await readdir(dir)).toEqual([]);
  });

  it('resumes after a failure, keeps the original snapshot and reuses the finished parts byte for byte (500 photos)', async () => {
    const dir = await workspace();
    const world = parityWorld(500, 30_000, 2_000);
    const server = fakeServer(world);
    // Photos after the first 900 distinct files (in the last photo part) fail until the second run.
    const served = new Set<string>();
    let blocked = true;
    server.failStorage = path => {
      if (blocked && !served.has(path) && served.size >= 900) return 503;
      served.add(path);
      return null;
    };
    const first = await run(server, dir);
    expect(first.code).toBe(1);
    expect(first.stderr).toMatch(/Backup incomplete \(unavailable\).*Unfinished folder: \.stillroom-export-[0-9a-f-]{36}\.partial/);
    const [staging] = await readdir(dir).then(names => names.filter(name => name.endsWith('.partial')));
    const partsDir = join(dir, staging!, 'parts');
    const before = new Map(await Promise.all((await readdir(partsDir)).map(async name => [name, await readFile(join(partsDir, name), 'utf8')] as const)));
    expect(before.size).toBeGreaterThanOrEqual(2);
    // The live wardrobe changes after the interruption: a renamed item and a new one. Photos are unchanged.
    (world.raw.tables as Record<string, Array<Record<string, unknown>>>).items![0]!.title = 'Renamed later';
    server.calls.length = 0;
    blocked = false;
    const second = await run(server, dir);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain('Continuing the unfinished backup.');
    expect(server.calls.some(call => call.includes('/rest/v1/'))).toBe(false);
    const [name] = await finished(dir);
    expect(name).toBe(staging!.replace(/^\.stillroom-export-(.*)\.partial$/, 'stillroom-$1'));
    for (const [file, text] of before) expect(await readFile(join(dir, name!, file), 'utf8')).toBe(text);
    const summary = await verifyFinal(dir, name!);
    expect(summary.parts).toBeGreaterThanOrEqual(3);
    expect(summary.photos).toBeGreaterThanOrEqual(500);
    expect(summary.metadata.tables.items.map(item => item.title)).not.toContain('Renamed later');
    expect(await readdir(dir)).toEqual([name]);
  });

  it('completes or reports unresumable after a crash between any two file operations', async () => {
    const world = parityWorld(2, 3000, 500);
    let at = 1;
    const outcomes = { resumed: 0, unresumable: 0, fresh: 0, recoveredFinal: 0 };
    for (; ; at++) {
      const dir = await workspace();
      const server = fakeServer(world);
      const { files, state } = crashingFiles(at);
      const first = await run(server, dir, { files });
      if (!state.crashed) { expect(first.code).toBe(0); break; }
      // A crash while releasing the lock comes after the backup was reported complete.
      if (first.code !== 0) expect(first.stdout).toBe('');
      const firstName = (await readdir(dir)).find(name => name.endsWith('.partial'));
      const hadFinal = (await readdir(dir)).some(name => /^stillroom-[0-9a-f-]{36}$/.test(name));
      // A lock left by the crashed run keeps the folder busy until the owner deletes it.
      if (await lstat(join(dir, '.stillroom-export.lock')).catch(() => null)) {
        const blocked = await run(server, dir);
        expect([blocked.code, blocked.stderr.includes('(busy)')], `crash at operation ${at}`).toEqual([1, true]);
        await rm(join(dir, '.stillroom-export.lock'));
      }
      server.calls.length = 0;
      const second = await run(server, dir);
      if (second.code === 1 && second.stderr.includes('(unresumable)')) {
        outcomes.unresumable++;
        expect(firstName).toBeDefined();
        expect(await lstat(join(dir, firstName!, 'parts', `stillroom-${firstName!.slice(18, 54)}-0.json.enc`)).catch(() => null)).toBeNull();
        continue;
      }
      expect(second.code, `crash at operation ${at} (${state.ops.at(-1)}): ${second.stderr}`).toBe(0);
      const names = await finished(dir);
      expect(names).toHaveLength(1 + (hadFinal && !firstName ? 1 : 0));
      if (firstName) {
        expect(names).toContain(`stillroom-${firstName.slice(18, 54)}`);
        expect(server.calls.some(call => call.includes('rpc/export_manifest'))).toBe(false);
        if (hadFinal) outcomes.recoveredFinal++; else outcomes.resumed++;
      } else outcomes.fresh++;
      for (const name of names) await verifyFinal(dir, name);
      expect((await readdir(dir)).filter(name => !names.includes(name))).toEqual([]);
    }
    expect(at).toBeGreaterThan(20);
    expect(outcomes.resumed).toBeGreaterThan(5);
    expect(outcomes.unresumable).toBeGreaterThan(0);
    expect(outcomes.recoveredFinal).toBeGreaterThan(0);
  });

  it('recovers a backup that was already moved into place, even days later, before applying the age limit', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 2000, 400));
    // Crash on the first operation after promotion (the folder sync), leaving the finished folder and the staging state.
    let promoted = false;
    const files = { ...nodeFiles, rename: async (from: string, to: string) => { await nodeFiles.rename(from, to); if (/[\\/]stillroom-[0-9a-f-]{36}$/.test(to)) { promoted = true; throw CRASH; } } };
    expect((await run(server, dir, { files })).code).toBe(1);
    expect(promoted).toBe(true);
    const later = await run(server, dir, { now: () => NOW + 3 * 24 * 3600 * 1000 });
    expect(later.code, later.stderr).toBe(0);
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    await verifyFinal(dir, names[0]!);
  });

  it('refuses stale, future, foreign or conflicting unfinished backups without changing them', async () => {
    const world = parityWorld(1, 2000, 400);
    const interrupted = async () => {
      const dir = await workspace();
      const server = fakeServer(world);
      server.failStorage = () => 404;
      const first = await run(server, dir);
      expect(first.stderr).toContain('(changed)');
      const staging = (await readdir(dir)).find(name => name.endsWith('.partial'))!;
      return { dir, server, staging };
    };
    const snapshot = async (dir: string) => JSON.stringify(await Promise.all((await readdir(dir, { recursive: true })).sort().map(async name => {
      const info = await lstat(join(dir, name));
      return [name, info.isFile() ? (await readFile(join(dir, name))).toString('base64') : 'dir'];
    })));
    const expectRefused = async (dir: string, code: string, extra: Record<string, unknown> = {}, stdin = piped(secrets())) => {
      const before = await snapshot(dir);
      const result = await run(fakeServer(world), dir, { stdin, ...extra });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`(${code})`);
      expect(await snapshot(dir)).toBe(before);
    };
    let { dir, staging } = await interrupted();
    await expectRefused(dir, 'stale', { now: () => NOW + 25 * 3600 * 1000 });
    await expectRefused(dir, 'conflict', { now: () => NOW - 3600 * 1000 });
    await expectRefused(dir, 'passphrase', {}, piped(secrets('another passphrase entirely')));
    await writeFile(join(dir, staging, 'unexpected.txt'), 'x');
    await expectRefused(dir, 'conflict');
    ({ dir } = await interrupted());
    await mkdir(join(dir, '.stillroom-export-99999999-9999-4999-8999-999999999999.partial'));
    await expectRefused(dir, 'conflict');
    ({ dir, staging } = await interrupted());
    const other = fakeServer(world);
    const foreign = '99999999-9999-4999-8999-999999999999';
    const originalFetch = other.fetch;
    other.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (!String(input).includes('grant_type=password')) return response;
      const body = await response.json();
      const token = jwt(foreign, 99);
      other.tokens.push(token);
      return json(200, { ...body, access_token: token, user: { ...body.user, id: foreign } });
    };
    const before = await snapshot(dir);
    const result = await run(other, dir);
    expect([result.code, result.stderr.includes('(conflict)')]).toEqual([1, true]);
    expect(await snapshot(dir)).toBe(before);
    // A torn state file is bookkeeping only: the snapshot is re-authenticated from part 0 and the backup completes.
    await writeFile(join(dir, staging, 'state.json'), '{"v":1,');
    const healed = await run(fakeServer(world), dir);
    expect(healed.code, healed.stderr).toBe(0);
  });

  it('refuses while a lock or reclaim file exists, says when it was created, and continues once the owner deletes it', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 2000, 400));
    const lock = join(dir, '.stillroom-export.lock'), reclaim = join(dir, '.stillroom-export.lock.reclaim');
    await writeFile(lock, JSON.stringify({ token: 'left by a killed run' }));
    const created = (await lstat(lock)).mtimeMs;
    const busy = await run(server, dir, { now: () => created + 45 * 60_000 });
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain(`Backup incomplete (busy). Another backup is using this output folder. If no backup is running, delete .stillroom-export.lock and .stillroom-export.lock.reclaim (if present) from the folder and run again. The lock was created ${new Date(created).toISOString().replace(/\.\d{3}Z$/, 'Z')} (45 minutes ago).`);
    expect(busy.stderr).not.toContain(dir);
    expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('left by a killed run');
    await rm(lock);
    await writeFile(reclaim, '');
    const marker = await run(server, dir);
    expect([marker.code, marker.stderr.includes('(busy)')]).toEqual([1, true]);
    expect((await readdir(dir)).sort()).toEqual(['.stillroom-export.lock.reclaim']);
    expect(server.calls).toEqual([]);
    await rm(reclaim);
    const done = await run(server, dir);
    expect(done.code, done.stderr).toBe(0);
    expect((await readdir(dir)).some(name => name.includes('.lock'))).toBe(false);
  });

  it('parts decrypt with the passphrase and belong to one export', async () => {
    const dir = await workspace();
    expect((await run(fakeServer(parityWorld(2, 2000, 400)), dir)).code).toBe(0);
    const [name] = await finished(dir);
    const files = (await readdir(join(dir, name!))).sort();
    for (const file of files) {
      const part = await decryptPart(await readFile(join(dir, name!, file), 'utf8'), PASSPHRASE);
      expect(`stillroom-${part.exportId}`).toBe(name);
    }
  });
});

describe('output folder lock', { timeout: 120_000 }, () => {
  const LOCK = '.stillroom-export.lock';
  // Every file operation of one contender passes through `hook` first; a close is reported after the handle is closed.
  function hooked(hook: (op: string) => Promise<void> | void) {
    const wrap = <T extends unknown[], R>(name: string, run: (...args: T) => Promise<R>) => async (...args: T) => { await hook(name); return run(...args); };
    return {
      lstat: wrap('lstat', nodeFiles.lstat), readdir: wrap('readdir', nodeFiles.readdir), mkdir: wrap('mkdir', nodeFiles.mkdir),
      rename: wrap('rename', nodeFiles.rename), link: wrap('link', nodeFiles.link), unlink: wrap('unlink', nodeFiles.unlink), rmdir: wrap('rmdir', nodeFiles.rmdir),
      open: async (path: string, flags: string, mode?: number) => {
        await hook(`open:${flags}`);
        const handle = await nodeFiles.open(path, flags, mode);
        return {
          writeFile: async (data: string) => { await hook('write'); return handle.writeFile(data); },
          sync: async () => { await hook('sync'); return handle.sync(); },
          stat: () => handle.stat(), read: (...args: Parameters<typeof handle.read>) => handle.read(...args),
          close: async () => { await handle.close(); await hook('close'); },
        };
      },
    };
  }
  const contender = (dir: string, files: unknown) =>
    ({ files: files as typeof nodeFiles, output: dir, now: () => NOW, platform: process.platform, lock: null as null | { path: string; token: string } });
  const attempt = async (context: ReturnType<typeof contender>) => {
    try { await acquireLock(context); return 'held' as const; } catch (error) {
      if (error instanceof ExportError && error.code === 'busy') return 'busy' as const;
      throw error;
    }
  };

  it('two runs on one folder: the second, at any point of the first, gets busy and changes nothing', async () => {
    const solo = await workspace();
    let total = 0;
    const alone = contender(solo, hooked(() => { total++; }));
    expect(await attempt(alone)).toBe('held');
    const acquireOps = total;
    await releaseLock(alone);
    total = acquireOps;
    expect(total).toBeGreaterThan(3);
    for (let at = 1; at <= total; at++) {
      const dir = await workspace();
      let count = 0, existed = false, second: 'held' | 'busy' | undefined;
      const b = contender(dir, nodeFiles);
      const a = contender(dir, hooked(async () => {
        if (++count !== at) return;
        existed = (await readdir(dir)).includes(LOCK);
        second = await attempt(b);
      }));
      const first = await attempt(a);
      // Before the first run has created its lock the second one gets it; from then on the second one is busy.
      expect([first, second], `operation ${at}`).toEqual(existed ? ['held', 'busy'] : ['busy', 'held']);
      const holder = first === 'held' ? a : b;
      expect(JSON.parse(await readFile(join(dir, LOCK), 'utf8')).token).toBe(holder.lock!.token);
      expect(await readdir(dir)).toEqual([LOCK]);
      await releaseLock(holder);
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it('a reclaim file on its own keeps the folder busy, and nothing is removed', async () => {
    const dir = await workspace();
    await writeFile(join(dir, `${LOCK}.reclaim`), '');
    expect(await attempt(contender(dir, nodeFiles))).toBe('busy');
    expect(await readdir(dir)).toEqual([`${LOCK}.reclaim`]);
  });
});

describe('photo download retries', { timeout: 300_000 }, () => {
  const storage = '/storage/v1/object/authenticated/wardrobe/';
  const firstPhoto = (server: Server) => [...server.world.objects.keys()].sort()[0]!;
  const count = (server: Server, path: string) => server.calls.filter(call => call === `GET ${storage}${path}`).length;
  // The first download of one photo sends part of the body and then fails in the given way.
  function breakBodyOnce(server: Server, failure: () => Error) {
    const target = firstPhoto(server);
    const serve = server.fetch;
    let broken = false;
    server.fetch = async (input, init) => {
      const response = await serve(input, init);
      if (broken || !String(input).endsWith(`${storage}${target}`) || !response.ok) return response;
      broken = true;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 16)); controller.error(failure()); } }), { status: 200 });
    };
    return target;
  }

  it('retries a disconnect or timeout while the body is being read, then completes', async () => {
    for (const failure of [
      () => Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) }),
      () => new DOMException('The operation timed out.', 'TimeoutError'),
    ]) {
      const dir = await workspace();
      const server = fakeServer(parityWorld(1, 2000, 400));
      const target = breakBodyOnce(server, failure);
      const result = await run(server, dir);
      expect(result.code, result.stderr).toBe(0);
      expect(count(server, target)).toBe(2);
      const [name] = await finished(dir);
      await verifyFinal(dir, name!);
    }
  });

  it('retries a 503 whose body has already failed, then completes', async () => {
    const dir = await workspace();
    const server = fakeServer(parityWorld(1, 2000, 400));
    const target = firstPhoto(server);
    const serve = server.fetch;
    let failed = false;
    server.fetch = async (input, init) => {
      if (failed || !String(input).endsWith(`${storage}${target}`)) return serve(input, init);
      failed = true;
      server.calls.push(`GET ${storage}${target}`);
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }), { status: 503 });
    };
    const result = await run(server, dir);
    expect(result.code, result.stderr).toBe(0);
    expect(count(server, target)).toBe(2);
    const [name] = await finished(dir);
    await verifyFinal(dir, name!);
  });

  it('does not retry an oversized body, changed content or cancellation', async () => {
    const oversized = fakeServer(parityWorld(1, 2000, 400));
    const big = firstPhoto(oversized);
    oversized.world.objects.set(big, new Uint8Array(oversized.world.objects.get(big)!.length + 1));
    const tooBig = await run(oversized, await workspace());
    expect([tooBig.code, count(oversized, big)]).toEqual([1, 1]);
    expect(tooBig.stderr).toContain('(changed)');

    const altered = fakeServer(parityWorld(1, 2000, 400));
    const same = firstPhoto(altered);
    const bytes = altered.world.objects.get(same)!.slice();
    bytes[0] = bytes[0]! ^ 0xff;
    altered.world.objects.set(same, bytes);
    const changed = await run(altered, await workspace());
    expect([changed.code, count(altered, same)]).toEqual([1, 1]);
    expect(changed.stdout).toBe('');

    const controller = new AbortController();
    const cancelled = fakeServer(parityWorld(1, 2000, 400));
    const stopped = breakBodyOnce(cancelled, () => { controller.abort(); return new DOMException('This operation was aborted', 'AbortError'); });
    const result = await run(cancelled, await workspace(), { signal: controller.signal });
    expect([result.code, count(cancelled, stopped)]).toEqual([1, 1]);
    expect(result.stderr).toContain('(cancelled)');
  });
});

describe('nothing private is printed when things fail', { timeout: 300_000 }, () => {
  const CANARY = { token: 'canary-token-5d1f8a', title: 'Canary garment title 7c2e', path: 'canary/private/path/0b9d' };
  const canaryText = () => `${CANARY.token} ${CANARY.title} ${CANARY.path} ${EMAIL} ${PASSWORD} ${PASSPHRASE}`;
  const secretsIn = (server: Server, dir: string) => [EMAIL, PASSWORD.trim(), PASSPHRASE, ...Object.values(CANARY), ...server.tokens,
    ...server.tokens.map((_, index) => `refresh-${index + 1}`), 'Synthetic garment', 'Photo 1', dir, ...server.world.objects.keys(), PARITY_OWNER];
  // The failing routes answer with the canaries in the body, or the transport throws an error carrying them.
  function failing(route: string, mode: 'body' | 'throw', status = 500) {
    const server = fakeServer(parityWorld(1, 2000, 400));
    const serve = server.fetch;
    server.fetch = async (input, init) => {
      const url = new URL(input);
      const matches = route === 'storage' ? url.pathname.startsWith('/storage/') : `${init.method} ${url.pathname}${url.search}` === route;
      if (!matches) {
        const response = await serve(input, init);
        if (route.includes('refresh_token') && url.pathname === '/rest/v1/rpc/export_manifest') await new Promise(done => setTimeout(done, 3000));
        return response;
      }
      server.calls.push(`${init.method} ${url.pathname}${url.search}`);
      if (mode === 'throw') throw Object.assign(new TypeError(`fetch failed ${canaryText()}`), { cause: new Error(canaryText()) });
      return json(status, { error: 'invalid_grant', error_description: canaryText(), message: canaryText(), code: 'PGRST000', details: canaryText(), hint: canaryText() });
    };
    if (route.includes('refresh_token')) server.ttl = 2;
    return server;
  }
  const cases: Array<[string, 'body' | 'throw', number?]> = [
    ['POST /auth/v1/token?grant_type=password', 'body', 400], ['POST /auth/v1/token?grant_type=password', 'throw'],
    ['POST /rest/v1/rpc/export_manifest', 'body'], ['POST /rest/v1/rpc/export_manifest', 'throw'],
    ['POST /rest/v1/rpc/item_attribution_history', 'body'], ['storage', 'body'], ['storage', 'throw'],
    ['POST /auth/v1/token?grant_type=refresh_token', 'body', 400], ['POST /auth/v1/token?grant_type=refresh_token', 'throw'],
  ];

  it('in this process: HTTP error bodies, thrown errors and refresh failures, through the real SDK and guard, with console output captured', async () => {
    let captured = '';
    const record = (...args: unknown[]) => { captured += args.map(value => value instanceof Error ? `${value.stack} ${String(value.cause)}` : typeof value === 'string' ? value : JSON.stringify(value)).join(' '); };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { record(String(chunk)); return true; }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { record(String(chunk)); return true; }),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(name => vi.spyOn(console, name).mockImplementation(record)),
    ];
    try {
      for (const [route, mode, status] of cases) {
        captured = '';
        const dir = await workspace();
        const server = failing(route, mode, status);
        const result = await run(server, dir);
        expect(result.code, `${route} ${mode}`).toBe(1);
        expect(server.calls, route).toContain(route === 'storage' ? server.calls.find(call => call.startsWith('GET /storage/')) : route);
        const output = result.stdout + result.stderr + captured;
        for (const secret of secretsIn(server, dir)) expect(output.includes(secret), `${route} ${mode} printed a private value`).toBe(false);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('as a real process: stdout and stderr of the CLI hold none of the canaries', async () => {
    for (const [route, mode, status] of cases.filter(([, mode]) => mode === 'body')) {
      const server = failing(route, mode, status);
      const http = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
        const answer = await server.fetch(`http://127.0.0.1${request.url}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined });
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
      });
      await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
      const port = (http.address() as { port: number }).port;
      const dir = await workspace();
      try {
        const env: Record<string, string> = { SUPABASE_PUBLISHABLE_KEY: KEY };
        for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name]!;
        const child = spawn(process.execPath, [join(process.cwd(), 'scripts', 'export-own.mjs'), '--output', dir, '--local', `http://127.0.0.1:${port}`],
          { cwd: process.cwd(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
        child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
        child.stdin.end(secrets());
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        const code = await new Promise<number | null>(done => child.once('close', done));
        clearTimeout(timer);
        expect(code, `${route}: ${output}`).toBe(1);
        expect(output).toMatch(/Backup incomplete \((auth|unavailable|invalid|changed)\)/);
        expect(server.calls.length).toBeGreaterThan(0);
        for (const secret of secretsIn(server, dir)) expect(output.includes(secret), `${route} printed a private value`).toBe(false);
      } finally {
        await new Promise(done => http.close(done));
      }
    }
  });
});
