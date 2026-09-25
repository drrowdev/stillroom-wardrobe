// B1-1: scripts/export-own.mjs against the local Supabase stack. The CLI runs as a child process with only the publishable
// key and OS variables, talks to the stack through a loopback proxy with a fixed upstream, is killed while a photo
// download is held, and then resumes. The result must pass scripts/verify-backup.mjs and hold the same metadata as the
// browser Backup code path (src/data/export.ts) reading the same owner's fixture. Normal owner sessions only.
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import type { OwnerScope } from '../../src/auth/session';
import type { AppClient } from '../../src/data/client';
import type { Database } from '../../src/data/database.types';
import { prepareExport } from '../../src/data/export';
import { ItemLifecycleClient } from '../../src/data/item-lifecycle';
import { canonical, decryptPart } from '../../src/domain/export-format';
import { editGarmentField, newGarmentDraft } from '../../src/domain/garment-fields';
import { deletionIntent } from '../../src/domain/item-lifecycle';
import { newSaveAttempt, saveItem, type SaveAttempt } from '../../src/images/upload';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PASSPHRASE = 'synthetic weekly export passphrase';
const failure = new Error('Local export-own gate failed.');
function check(value: unknown): asserts value { if (!value) throw failure; }

// Bounded wait: every wait in this test has a deadline, so a hung child or proxy fails instead of stalling.
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, failed) => { timer = setTimeout(() => failed(new Error('Timed out.')), ms); })]);
  } finally { clearTimeout(timer); }
}

// Only OS variables and the publishable key reach the child: no SUPABASE_URL, no TEST_* credentials, no service keys.
function childEnvironment(key: string) {
  const env: Record<string, string> = { SUPABASE_PUBLISHABLE_KEY: key };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  return env;
}

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Launched = { child: ChildProcess; done: Promise<Run> };
function launch(args: string[], env: Record<string, string>, input: string | null): Launched {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
  child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
  const done = new Promise<Run>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  if (input !== null) child.stdin!.end(input);
  return { child, done };
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
function processGone(pid: number | undefined) {
  if (pid === undefined) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

// Every child is registered as soon as it is spawned. A timed-out wait kills the child and waits for it to close, and
// stopAll does the same for every child in finally, so no process outlives the test.
class Children {
  readonly all: Launched[] = [];
  launch(args: string[], env: Record<string, string>, input: string | null) {
    const launched = launch(args, env, input);
    this.all.push(launched);
    return launched;
  }
  async finish(launched: Launched, ms: number) {
    try { return await within(ms, launched.done); } catch (problem) { await this.stop(launched); throw problem; }
  }
  async stop(launched: Launched) {
    if (running(launched.child)) launched.child.kill('SIGKILL');
    await within(15_000, launched.done.catch(() => undefined)).catch(() => undefined);
    launched.child.stdin?.destroy();
  }
  async stopAll() {
    await Promise.all(this.all.map(launched => this.stop(launched)));
    return this.all.every(({ child }) => !running(child) && processGone(child.pid));
  }
}

// A loopback proxy with a fixed upstream. It never follows redirects (node:http does not) and can hold the first photo
// download until the test releases or destroys it.
async function startProxy(upstream: string) {
  const target = new URL(upstream);
  const sockets = new Set<Socket>();
  const outbound = new Set<ClientRequest>();
  const held: ServerResponse[] = [];
  const events = { hold: false, heldOnce: null as null | (() => void), paths: [] as string[] };
  const heldSignal = new Promise<void>(resolve => { events.heldOnce = resolve; });
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const path = incoming.url ?? '/';
    events.paths.push(`${incoming.method} ${path.split('?')[0]}`);
    if (events.hold && incoming.method === 'GET' && path.startsWith('/storage/v1/object/authenticated/wardrobe/')) {
      held.push(outgoing);
      events.heldOnce?.();
      return;
    }
    const forwarded = request({ host: target.hostname, port: target.port, method: incoming.method, path,
      headers: { ...incoming.headers, host: target.host } }, (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    });
    outbound.add(forwarded);
    forwarded.on('close', () => outbound.delete(forwarded));
    // Every upstream request has a deadline; a hung upstream closes the client's connection instead of holding it.
    forwarded.setTimeout(30_000, () => forwarded.destroy(new Error('Upstream timed out.')));
    forwarded.on('error', () => { outgoing.destroy(); });
    outgoing.on('close', () => { if (!forwarded.destroyed) forwarded.destroy(); });
    incoming.pipe(forwarded);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await within(5000, once(server, 'listening'));
  const address = server.address();
  check(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`, events, heldSignal, outbound,
    async close() {
      for (const response of held) response.destroy();
      // destroy() emits 'close' asynchronously (for a request still waiting for its socket, only after it gets one), so
      // wait for every tracked upstream request to close, within a bound, before reporting the proxy closed.
      const closing = [...outbound].map(forwarded => within(5000, once(forwarded, 'close')).catch(() => {}));
      for (const forwarded of outbound) forwarded.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
      await Promise.all([...closing, within(5000, once(server, 'close')).catch(() => {})]);
    },
  };
}

test('export-own: resumable CLI backup verified and equal to the browser export path, owner only', async () => {
  test.setTimeout(240_000);
  validateSessionEnvironment(process.env);
  const base = assertLocalApi(process.env.SUPABASE_URL!), key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  const jpg = new Uint8Array(await readFile(new URL('../security/fixture.jpg', import.meta.url)));
  const hash = createHash('sha256').update(jpg).digest('hex');
  const photo = { main: new Blob([jpg], { type: 'image/jpeg' }), thumb: new Blob([jpg], { type: 'image/jpeg' }), mainSha256: hash, thumbSha256: hash, width: 2, height: 2 };
  const clients: AppClient[] = [];
  const fixtures: { client: AppClient; scope: OwnerScope; attempts: SaveAttempt[] }[] = [];
  const output = await mkdtemp(join(tmpdir(), 'export-own-local-'));
  const proxy = await startProxy(base);
  const children = new Children();
  let stage = 'fixtures';
  const cleanupFailures: string[] = [];
  const signIn = async (label: 'A' | 'B') => {
    const client = createClient<Database>(base, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `export-own-${randomUUID()}`, debug: false },
    }) as AppClient;
    clients.push(client);
    const login = await client.auth.signInWithPassword({ email: process.env[`TEST_${label}_EMAIL`]!, password: process.env[`TEST_${label}_PASSWORD`]! });
    check(!login.error && login.data.user);
    const scope: OwnerScope = { ownerId: login.data.user.id, epoch: 1, signal: new AbortController().signal } as OwnerScope;
    const value = { client, scope, attempts: [] as SaveAttempt[] };
    fixtures.push(value);
    return value;
  };
  const save = async (value: typeof fixtures[number], title: string) => {
    let draft = newGarmentDraft('EUR', 'en');
    draft = editGarmentField(draft, 'title', title, 'en');
    draft = editGarmentField(draft, 'category', 'top', 'en');
    const attempt = newSaveAttempt(draft, 'Synthetic export fixture', photo, value.scope);
    value.attempts.push(attempt);
    await saveItem(value.client, value.scope, attempt, () => {});
  };
  const cli = (input: string) => children.launch([join(ROOT, 'scripts', 'export-own.mjs'), '--output', output, '--local', proxy.url], childEnvironment(key), input);
  const credentials = (password: string) => `${process.env.TEST_A_EMAIL}\n${password}\n${PASSPHRASE}\n`;
  try {
    const a = await signIn('A'), b = await signIn('B');
    check(a.scope.ownerId !== b.scope.ownerId);
    await save(a, 'Fictional export A 1');
    await save(a, 'Fictional export A 2');
    await save(b, 'Fictional export B 1');

    stage = 'wrong-password';
    const refused = await children.finish(cli(credentials(`${process.env.TEST_A_PASSWORD}-wrong`)), 60_000);
    check(refused.code === 1 && refused.stderr.includes('Backup incomplete (auth)') && refused.stdout === '');
    check((await readdir(output)).length === 0);

    stage = 'interrupted';
    proxy.events.hold = true;
    const first = cli(credentials(process.env.TEST_A_PASSWORD!));
    await within(60_000, proxy.heldSignal).catch(async (problem) => { await children.stop(first); throw problem; });
    first.child.kill('SIGKILL');
    const killed = await children.finish(first, 15_000);
    check(killed.code !== 0 && killed.stdout === '');
    const staging = (await readdir(output)).filter(name => /^\.stillroom-export-[0-9a-f-]{36}\.partial$/.test(name));
    check(staging.length === 1);
    const exportId = staging[0]!.slice(18, 54);
    const partZero = `stillroom-${exportId}-0.json.enc`;
    const heldPartZero = await readFile(join(output, staging[0]!, 'parts', partZero), 'utf8');

    stage = 'fixture-changes-after-interruption';
    await save(a, 'Fictional export A added later');

    stage = 'lock-left-by-killed-run';
    proxy.events.hold = false;
    const blocked = await children.finish(cli(credentials(process.env.TEST_A_PASSWORD!)), 60_000);
    check(blocked.code === 1 && blocked.stderr.includes('Backup incomplete (busy)') && blocked.stdout === '');
    // The owner checks that no backup is running and deletes the lock, as the message says.
    await rm(join(output, '.stillroom-export.lock'));

    stage = 'resume';
    proxy.events.paths.length = 0;
    const second = await children.finish(cli(credentials(process.env.TEST_A_PASSWORD!)), 120_000);
    check(second.code === 0 && second.stderr.includes('Continuing the unfinished backup.'));
    check(second.stdout.startsWith('Backup complete: ') && second.stdout.includes(`Folder: stillroom-${exportId}`));
    check(!proxy.events.paths.some(path => path.includes('/rest/v1/')));
    check((await readdir(output)).join() === `stillroom-${exportId}`);
    const folder = join(output, `stillroom-${exportId}`);
    check(await readFile(join(folder, partZero), 'utf8') === heldPartZero);
    for (const secret of [process.env.TEST_A_EMAIL!, process.env.TEST_A_PASSWORD!, PASSPHRASE, output, 'Fictional export', a.scope.ownerId]) {
      check(![killed, blocked, second, refused].some(run => (run.stdout + run.stderr).includes(secret)));
    }

    stage = 'verify-backup';
    const verified = await children.finish(children.launch([join(ROOT, 'scripts', 'verify-backup.mjs'), '--input', folder], childEnvironment(key), `${PASSPHRASE}\n`), 60_000);
    check(verified.code === 0);

    stage = 'browser-export-path';
    const part = await decryptPart(heldPartZero, PASSPHRASE);
    const metadata = part.manifest!;
    check(metadata.owner_id === a.scope.ownerId && metadata.export_id === exportId);
    const titles = metadata.tables.items.map(item => String(item.title)).sort();
    check(titles.join('|') === 'Fictional export A 1|Fictional export A 2');
    check(metadata.tables.items.every(item => item.owner_id === a.scope.ownerId));
    // The browser path now sees the item added after the interruption; everything else must be identical.
    const browser = await prepareExport(a.client, a.scope, new AbortController().signal);
    const withoutLater = (tables: typeof metadata.tables) => {
      const later = new Set(tables.items.filter(item => item.title === 'Fictional export A added later').map(item => String(item.id)));
      return canonical(Object.fromEntries(Object.entries(tables).map(([name, rows]) =>
        [name, (rows as Array<Record<string, unknown>>).filter(row => !later.has(String(row.id)) && !later.has(String(row.item_id)))])));
    };
    check(withoutLater(browser.metadata.tables) === withoutLater(metadata.tables));
    check(browser.metadata.tables.items.length === metadata.tables.items.length + 1);
  } catch (problem) {
    throw new AggregateError([new Error(`export-own primary failed at ${stage}.`)], problem === failure ? 'Local export-own gate failed.' : 'Local export-own gate failed (unexpected).', { cause: problem });
  } finally {
    if (!await children.stopAll()) cleanupFailures.push('process');
    await proxy.close();
    if (proxy.outbound.size !== 0) cleanupFailures.push('proxy');
    await rm(output, { recursive: true, force: true }).catch(() => cleanupFailures.push('output'));
    for (const { client, scope, attempts } of fixtures) {
      for (const attempt of attempts) {
        try {
          const lifecycle = new ItemLifecycleClient(client, { url: base, publishableKey: key, version: 'local-export-own-test' }, scope);
          let status = await lifecycle.statusOf(attempt.itemId);
          if (!status.deleted_at) await lifecycle.change(attempt.itemId, true, status.version, () => {});
          status = await lifecycle.statusOf(attempt.itemId);
          const outcome = await lifecycle.delete(deletionIntent(status, scope.epoch), true, () => {});
          check(outcome.removed === 2 && outcome.missing === 0);
          const absent = await client.from('items').select('id').eq('owner_id', scope.ownerId).eq('id', attempt.itemId);
          check(!absent.error && absent.data?.length === 0);
        } catch { cleanupFailures.push('item'); }
      }
    }
    for (const client of clients) await client.auth.signOut({ scope: 'local' }).catch(() => cleanupFailures.push('sign-out'));
  }
  expect(cleanupFailures).toEqual([]);
});

// Cleanup itself: a child that never gets its input and a child whose request hangs at the upstream are both killed when
// their wait times out, the proxy's upstream request and sockets are destroyed, and nothing is written afterwards.
test('export-own: timed-out children and a hung upstream are cleaned up with no surviving process or late write', async () => {
  test.setTimeout(90_000);
  const sockets = new Set<Socket>();
  let upstreamRequests = 0;
  const hung = createServer(() => { upstreamRequests++; });
  hung.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  hung.listen(0, '127.0.0.1');
  await within(5000, once(hung, 'listening'));
  const upstream = `http://127.0.0.1:${(hung.address() as { port: number }).port}`;
  const proxy = await startProxy(upstream);
  const output = await mkdtemp(join(tmpdir(), 'export-own-hang-'));
  const children = new Children();
  let upstreamOpen: number | undefined;
  const key = `sb_publishable_${'x'.repeat(24)}`;
  const cli = (input: string | null) => children.launch([join(ROOT, 'scripts', 'export-own.mjs'), '--output', output, '--local', proxy.url], childEnvironment(key), input);
  const listing = async () => JSON.stringify((await readdir(output, { recursive: true })).sort());
  try {
    const waiting = cli(null);
    await expect(children.finish(waiting, 3000)).rejects.toThrow('Timed out.');
    expect(running(waiting.child)).toBe(false);
    await rm(join(output, '.stillroom-export.lock'));


    const stalled = cli(`owner.synthetic@example.test\nsynthetic password\n${PASSPHRASE}\n`);
    await within(30_000, (async () => { while (upstreamRequests === 0) await new Promise(done => setTimeout(done, 50)); })())
      .catch(async (problem) => { await children.stop(stalled); throw problem; });
    await expect(children.finish(stalled, 1000)).rejects.toThrow('Timed out.');
    expect(running(stalled.child)).toBe(false);
  } finally {
    expect(await children.stopAll()).toBe(true);
    await proxy.close();
    // The proxy itself must have closed its upstream connection; the test only destroys what is left afterwards.
    await within(5000, (async () => { while (sockets.size > 0) await new Promise(done => setTimeout(done, 20)); })()).catch(() => {});
    upstreamOpen = sockets.size;
    for (const socket of sockets) socket.destroy();
    hung.close();
    await within(5000, once(hung, 'close')).catch(() => {});
  }
  expect(proxy.outbound.size).toBe(0);
  expect(upstreamOpen).toBe(0);
  expect(children.all.every(({ child }) => processGone(child.pid))).toBe(true);
  const settled = await listing();
  await new Promise(done => setTimeout(done, 1500));
  expect(await listing()).toBe(settled);
  // Only the lock of the killed run remains; no backup files were started.
  expect(settled).toBe(JSON.stringify(['.stillroom-export.lock']));
  await rm(output, { recursive: true, force: true });
});
