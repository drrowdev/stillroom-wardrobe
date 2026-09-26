import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT, LOCK, outcomeOf, parseArguments, RestoreOwnError, runRestoreOwn } from '../../scripts/restore-own.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const exportId = '33333333-3333-4333-8333-333333333333';
const origin = 'http://127.0.0.1:54321';
const key = 'sb_publishable_abcdefghijkl';
const email = 'owner@example.test';
const password = 'a synthetic password';
const passphrase = 'a long synthetic passphrase';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function folder() {
  const parent = mkdtempSync(join(tmpdir(), 'stillroom-restore-own-'));
  directories.push(parent);
  const backup = join(parent, 'backup');
  mkdirSync(backup);
  writeFileSync(join(backup, `stillroom-${exportId}-0.json.enc`), '{}');
  return { parent, backup };
}
const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ role: 'authenticated', sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;

type Result = ReturnType<typeof emptyResult>;
function emptyResult() {
  return { restored: 0, same: 0, conflicts: 0, trash: 0, failed: 0, blocked: 0, deferred: 0, outfits: 0, outfitConflicts: 0, history: 0,
    historyConflicts: 0, photos: [] as { sourceImageId: string; outcome: string; planned: unknown; stored: unknown }[] };
}
function world(options: { sourceOwner?: string; account?: string; result?: Partial<Result>; run?: (client: { rpc: (name: string) => Promise<unknown> }) => Promise<Result>; preflight?: () => Promise<unknown>;
  worker?: () => Promise<unknown>; drift?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (address: string, init: RequestInit) => {
    const url = new URL(address);
    calls.push(`${init.method} ${url.pathname}`);
    if (url.pathname === '/auth/v1/token') {
      const account = options.account ?? owner;
      return Response.json({ access_token: token(account), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'r', user: { id: account, aud: 'authenticated', role: 'authenticated', email } });
    }
    return new Response(null, { status: 204 });
  });
  const backup = { data: { sourceOwner: options.sourceOwner ?? owner, exportId, events: [] } };
  const photos = new Map([['p', { main: 'preserved', reason: null, sourceSha256: 'a', mainSha256: 'a', thumbSha256: 'b', width: 2, height: 2 }]]);
  const closed = vi.fn(async () => {});
  const engine = {
    preflightBackup: vi.fn(options.preflight ?? (async () => ({ backup, photos }))),
    checkBackup: vi.fn(async () => ({ backup, photos: options.drift ? new Map() : photos, counts: { add: 1, same: 0, conflicts: 0, trash: 0, outfits: 0, reencoded: 1 } })),
    runRestore: vi.fn(options.run ?? (async () => ({ ...emptyResult(), restored: 1, ...options.result }))),
    restoreReport: vi.fn(() => null as Result | null),
  };
  const startImageWorker = vi.fn(options.worker ?? (async () => ({ deps: {}, failure: () => null, close: closed })));
  return { calls, fetchImpl, engine, startImageWorker, closed };
}
function streams(lines: string[] | null, tty = false) {
  const stdout: string[] = [], stderr: string[] = [];
  let stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  if (tty) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const answers = [...(lines ?? [])];
    stdin = input;
    return { stdin, stdout, stderr, out: { write: (text: string) => { stdout.push(text); return true; } },
      err: { write: (text: string) => { stderr.push(text); if (text.endsWith(': ')) setTimeout(() => input.write(`${answers.shift() ?? '\u0003'}\r`), 1); return true; } } };
  }
  stdin = Readable.from(lines ? [Buffer.from(`${lines.join('\n')}\n`)] : []);
  return { stdin, stdout, stderr, out: { write: (text: string) => { stdout.push(text); return true; } }, err: { write: (text: string) => { stderr.push(text); return true; } } };
}
async function run(args: string[], w: ReturnType<typeof world>, io = streams([email, password, passphrase]), env: Record<string, string> = {}) {
  const code = await runRestoreOwn({ argv: args, env: { SUPABASE_PUBLISHABLE_KEY: key, ...env }, stdin: io.stdin, stdout: io.out, stderr: io.err,
    fetchImpl: w.fetchImpl, loadEngine: async () => w.engine, startImageWorker: w.startImageWorker });
  return { code, stdout: io.stdout.join(''), stderr: io.stderr.join('') };
}

describe('restore-own arguments', () => {
  it('accepts one folder and the documented flags, once each', () => {
    expect(parseArguments(['dir', '--local', origin, '--yes', '--allow-other-account', '--report', 'json']))
      .toMatchObject({ local: origin, yes: true, allowOther: true, json: true });
    for (const argv of [[], ['a', 'b'], ['a', '--yes', '--yes'], ['a', '--report', 'text'], ['a', '--local'], ['a', '--local', '--yes'],
      ['a', '--passphrase', 'x'], ['a', '--email=x'], ['a', '']]) {
      expect(() => parseArguments(argv), argv.join(' ')).toThrow(RestoreOwnError);
    }
  });
});

describe('restore-own run', () => {
  it('restores after an offline check, then signs out, stops the photo worker and removes its lock', async () => {
    const { backup, parent } = folder();
    const w = world();
    const result = await run([backup, '--local', origin, '--yes'], w);
    expect(result.code).toBe(EXIT.complete);
    expect(result.stdout).toContain('Restore complete.');
    expect(result.stderr).toContain('1 photos will be re-encoded.');
    expect(w.engine.preflightBackup).toHaveBeenCalledBefore(w.fetchImpl);
    expect(w.calls).toEqual(['POST /auth/v1/token', 'POST /auth/v1/logout']);
    expect(w.closed).toHaveBeenCalled();
    expect(readdirSync(parent)).toEqual(['backup']);
    for (const secret of [email, password, passphrase, owner, parent]) expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('refuses administrator credentials, other endpoints and secret keys before reading anything', async () => {
    const { backup } = folder();
    const w = world();
    expect((await run([backup, '--local', origin], w, undefined, { SUPABASE_SERVICE_ROLE_KEY: 'x' })).stderr).toContain('(environment)');
    expect((await run([backup, '--local', 'http://example.test:54321'], w)).stderr).toContain('(endpoint)');
    expect((await run([backup, '--local', origin], w, undefined, { SUPABASE_PUBLISHABLE_KEY: ['sb', 'secret', 'abcdefghijkl'].join('_') })).stderr).toContain('(key)');
    expect(w.engine.preflightBackup).not.toHaveBeenCalled();
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a piped run that asks to restore another account\'s backup, before signing in', async () => {
    const { backup } = folder();
    const w = world({ sourceOwner: other });
    const result = await run([backup, '--local', origin, '--yes', '--allow-other-account'], w);
    expect(result).toMatchObject({ code: EXIT.refused });
    expect(result.stderr).toContain('(crossTty)');
    expect(w.startImageWorker).not.toHaveBeenCalled();
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it('compares the backup with the account the server signed in, and changes nothing for another account', async () => {
    const { backup } = folder();
    const piped = world({ sourceOwner: other });
    const result = await run([backup, '--local', origin, '--yes'], piped);
    expect(result.code).toBe(EXIT.refused);
    expect(result.stderr).toContain('(otherAccount)');
    expect(piped.engine.checkBackup).not.toHaveBeenCalled();
    expect(piped.calls).toEqual(['POST /auth/v1/token', 'POST /auth/v1/logout']);
    // Same email, different account: the token's subject decides.
    const signedInElsewhere = world({ account: other });
    expect((await run([backup, '--local', origin, '--yes'], signedInElsewhere)).stderr).toContain('(otherAccount)');
    expect(signedInElsewhere.engine.runRestore).not.toHaveBeenCalled();
  });

  it('asks for a typed confirmation on a terminal before restoring another account\'s backup', async () => {
    const { backup } = folder();
    const declined = world({ sourceOwner: other });
    const no = await run([backup, '--local', origin, '--yes', '--allow-other-account'], declined, streams([email, password, passphrase, 'yes'], true));
    expect(no.stderr).toContain('can\'t tell whether it was you');
    expect(no.stderr).toContain('(declined)');
    expect(declined.engine.checkBackup).not.toHaveBeenCalled();
    const accepted = world({ sourceOwner: other });
    const yes = await run([backup, '--local', origin, '--allow-other-account'], accepted, streams([email, password, passphrase, 'restore', 'yes'], true));
    expect(yes.code).toBe(EXIT.complete);
    expect(accepted.engine.runRestore).toHaveBeenCalled();
    expect(yes.stderr).not.toContain(password);
  });

  it('needs --yes when input is piped', async () => {
    const { backup } = folder();
    const w = world();
    const result = await run([backup, '--local', origin], w);
    expect(result.stderr).toContain('(confirm)');
    expect(w.engine.runRestore).not.toHaveBeenCalled();
  });

  it('makes no request when Chromium is missing, stops or a photo fails the offline check', async () => {
    const { backup } = folder();
    const missing = world({ worker: async () => { throw Object.assign(new Error('missing'), { code: 'missing' }); } });
    const first = await run([backup, '--local', origin, '--yes'], missing);
    expect(first.code).toBe(EXIT.refused);
    expect(first.stderr).toContain('npx playwright install chromium');
    const sandbox = world({ worker: async () => { throw Object.assign(new Error('sandbox'), { code: 'sandbox' }); } });
    const noSandbox = await run([backup, '--local', origin, '--yes'], sandbox);
    expect(noSandbox.code).toBe(EXIT.refused);
    expect(noSandbox.stderr).toContain('Restore refused (sandbox)');
    expect(noSandbox.stderr).toContain('Linux: Chromium sandbox');
    const invalid = world({ preflight: async () => { throw Object.assign(new Error('x'), { name: 'BackupFormatError', problem: 'invalid' }); } });
    expect((await run([backup, '--local', origin, '--yes'], invalid)).stderr).toContain('(invalid)');
    const wrong = world({ preflight: async () => { throw Object.assign(new Error('x'), { messageKey: 'restore.wrong' }); } });
    expect((await run([backup, '--local', origin, '--yes'], wrong)).stderr).toContain('(passphrase)');
    for (const w of [missing, sandbox, invalid, wrong]) expect(w.fetchImpl).not.toHaveBeenCalled();
    expect(invalid.closed).toHaveBeenCalled();
  });

  it('stops when Check against the account planned photos differently from the offline check', async () => {
    const { backup } = folder();
    const w = world({ drift: true });
    const result = await run([backup, '--local', origin, '--yes'], w);
    expect(result.code).toBe(EXIT.recheck);
    expect(w.engine.runRestore).not.toHaveBeenCalled();
  });

  it('reports busy while another restore holds the lock beside the backup folder, and continues once the owner removes it', async () => {
    const { backup, parent } = folder();
    writeFileSync(join(parent, LOCK), '{"token":"x"}');
    const w = world();
    const busy = await run([backup, '--local', origin, '--yes'], w);
    expect(busy.code).toBe(EXIT.refused);
    expect(busy.stderr).toContain(`delete ${LOCK}`);
    expect(busy.stderr).toMatch(/The lock was created \d{4}-/);
    expect(w.startImageWorker).not.toHaveBeenCalled();
    writeFileSync(join(parent, `${LOCK}.reclaim`), 'x');
    rmSync(join(parent, LOCK));
    expect((await run([backup, '--local', origin, '--yes'], w)).stderr).toContain('(busy)');
    rmSync(join(parent, `${LOCK}.reclaim`));
    expect((await run([backup, '--local', origin, '--yes'], w)).code).toBe(EXIT.complete);
  });

  it('keeps the partial report and maps each stop to its own exit code', async () => {
    const { backup } = folder();
    const partial = { ...emptyResult(), restored: 2, failed: 1 };
    const cases = [
      [Object.assign(new Error('x'), { name: 'RestoreRecheckError' }), EXIT.recheck, '(recheck)'],
      [new DOMException('Cancelled', 'AbortError'), EXIT.cancelled, '(cancelled)'],
      [new Error('network'), EXIT.retry, '(unavailable)'],
    ] as const;
    for (const [error, code, text] of cases) {
      const w = world({ run: async () => { throw error; } });
      w.engine.restoreReport.mockReturnValue(partial);
      const result = await run([backup, '--local', origin, '--yes', '--report', 'json'], w);
      expect(result.code).toBe(code);
      expect(result.stderr).toContain(text);
      expect(result.stderr).toContain('Items: 2 restored');
      expect(JSON.parse(result.stdout).counts).toMatchObject({ restored: 2, failed: 1 });
    }
    const blocked = world({ result: { blocked: 1, deferred: 2, photos: [{ sourceImageId: 'p', outcome: 'blocked', planned: null, stored: null }] } });
    const result = await run([backup, '--local', origin, '--yes'], blocked);
    expect(result.code).toBe(EXIT.blocked);
    expect(result.stderr).toContain('Restore incomplete. Completed changes remain; blocked photos and their dependents were not completed.');
    expect(result.stderr).not.toMatch(/run the same command again/i);
  });
});

describe('restore-own requests refused inside an item', () => {
  const blockedResult = () => ({ ...emptyResult(), blocked: 1, deferred: 2,
    photos: [{ sourceImageId: 'p', outcome: 'blocked', planned: null, stored: null }] });
  const refusing = (result: () => Result) => async (client: { rpc: (name: string) => Promise<unknown> }) => {
    await Promise.resolve(client.rpc('not_a_restore_rpc')).catch(() => {});
    return result();
  };
  const stoppedWorker = async () => ({ deps: {}, failure: () => 'timeout', close: async () => {} });
  const json = ['--local', origin, '--yes', '--report', 'json'];

  it('reports a refused request as refused, not as a run to repeat, after the report', async () => {
    const w = world({ run: refusing(() => ({ ...emptyResult(), failed: 1 })) });
    const refused = await run([folder().backup, ...json], w);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.stdout).toContain('"counts":{');
    expect(refused.stdout).toContain('1 not finished');
    expect(refused.stderr).toContain('Restore refused (refused).');
    expect(refused.stderr).not.toContain('Run the same command again');
    expect(w.calls).not.toContain('POST /rest/v1/rpc/not_a_restore_rpc');
  });

  it('reports a stopped Chromium as images after the report', async () => {
    const images = await run([folder().backup, ...json], world({ result: { failed: 1 }, worker: stoppedWorker }));
    expect(images.code).toBe(EXIT.retry);
    expect(images.stdout).toContain('"counts":{');
    expect(images.stderr).toContain('Restore incomplete (images).');
  });

  it.each([
    ['a refused request', { run: refusing(blockedResult) }, 'Also (refused): A request outside what a restore needs was refused.'],
    ['a stopped Chromium', { run: async () => blockedResult(), worker: stoppedWorker }, 'Also (images): Photos couldn\'t be checked: Chromium stopped.'],
  ])('keeps BLOCKED, its message and the report when %s happens as well', async (_, options, also) => {
    const result = await run([folder().backup, ...json], world(options));
    expect(result.code).toBe(EXIT.blocked);
    expect(result.stdout).toContain('"counts":{');
    expect(result.stderr).toContain('Restore incomplete. Completed changes remain; blocked photos and their dependents were not completed.');
    expect(result.stderr).toContain(also);
    expect(result.stderr).not.toContain('Run the same command again');
  });
});

describe('restore-own outcome', () => {
  it('separates complete, kept, retry and blocked', () => {
    expect(outcomeOf(emptyResult())).toEqual({ code: EXIT.complete, message: 'Restore complete.' });
    expect(outcomeOf({ ...emptyResult(), conflicts: 1 }).code).toBe(EXIT.kept);
    expect(outcomeOf({ ...emptyResult(), failed: 1 }).code).toBe(EXIT.retry);
    expect(outcomeOf({ ...emptyResult(), deferred: 1 }).code).toBe(EXIT.retry);
    const blocked = outcomeOf({ ...emptyResult(), blocked: 2, deferred: 3, failed: 1,
      photos: [{ sourceImageId: 'p', outcome: 'blocked', planned: null, stored: null }] });
    expect(blocked.code).toBe(EXIT.blocked);
    expect(blocked.message).toBe('Restore incomplete. Completed changes remain; blocked photos and their dependents were not completed. '
      + 'Blocked: 2 items, 1 photos; held back: 3 outfits, rules, feedback or history entries.');
  });
});
