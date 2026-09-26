// B1-3: scripts/restore-own.mjs against the local Supabase stack, with the real pinned SDK behind the CLI's own request
// gate and a loopback proxy with a fixed upstream. The CLI runs as a child process with only the publishable key and OS
// variables; photo steps run in the locked Playwright Chromium. Fictional backups are built for account A. The gate checks
// A's rows, versions and stored file hashes after success, after every interruption and resume, and after each refusal;
// B's data, A's profile, preferences and consent never change. Replacement photos need the served finalize-image-change
// function: a missing gateway fails this gate, it is not mocked. Normal owner sessions only.
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import type { OwnerScope } from '../../src/auth/session';
import type { AppClient } from '../../src/data/client';
import type { Database } from '../../src/data/database.types';
import { ItemLifecycleClient } from '../../src/data/item-lifecycle';
import { canonical } from '../../src/domain/export-format';
import { deletionIntent } from '../../src/domain/item-lifecycle';
import { restoreId } from '../../src/domain/restore-plan';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';
import { syntheticId, writeSyntheticBackup, type SyntheticItem } from '../fixtures/restore-own-backup';
import { restoreDiagnostics } from '../fixtures/restore-own-diagnostics';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PASSPHRASE = 'synthetic restore-own passphrase';
const LOCK = '.stillroom-restore.lock';
const failure = new Error('Local restore-own gate failed.');
function check(value: unknown): asserts value { if (!value) throw failure; }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, failed) => { timer = setTimeout(() => failed(new Error('Timed out.')), ms); })]);
  } finally { clearTimeout(timer); }
}
function childEnvironment(key: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { SUPABASE_PUBLISHABLE_KEY: key };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  return { ...env, ...extra };
}

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Launched = { child: ChildProcess; done: Promise<Run> };
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
function processGone(pid: number | undefined) {
  if (pid === undefined) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
class Children {
  readonly all: Launched[] = [];
  launch(args: string[], env: Record<string, string>, input: string) {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
    child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
    const done = new Promise<Run>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    child.stdin!.end(input);
    const launched = { child, done };
    this.all.push(launched);
    return launched;
  }
  async finish(launched: Launched, ms = 180_000) {
    try { return await within(ms, launched.done); } catch (problem) { await this.stop(launched); throw problem; }
  }
  async stop(launched: Launched) {
    if (running(launched.child)) launched.child.kill('SIGKILL');
    await within(15_000, launched.done.catch(() => undefined)).catch(() => undefined);
  }
  async stopAll() {
    await Promise.all(this.all.map(launched => this.stop(launched)));
    return this.all.every(({ child }) => !running(child) && processGone(child.pid));
  }
}

// What the proxy does with one request: pass it on, answer 503, hold it until released, or pass it on and, once the
// upstream has answered in full, call `stop` (the test kills the CLI) without ever replying.
type Action = 'forward' | 'fail' | 'hold' | 'stop';
type Rule = (method: string, path: string, count: number) => Action;
async function startProxy(upstream: string) {
  const target = new URL(upstream);
  const sockets = new Set<Socket>(), outbound = new Set<ClientRequest>();
  const counts = new Map<string, number>();
  const state = { rule: (() => 'forward') as Rule, paths: [] as string[], answers: [] as string[], stop: () => {}, held: [] as (() => void)[], onHold: () => {} };
  const forward = (incoming: IncomingMessage, outgoing: ServerResponse, body: Buffer, reply: boolean, after?: () => void) => {
    const forwarded = request({ host: target.hostname, port: target.port, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, host: target.host } }, (answer) => {
      state.answers.push(`${incoming.method ?? 'GET'} ${(incoming.url ?? '/').split('?')[0]} ${answer.statusCode ?? 0}`);
      if (reply) { outgoing.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(outgoing); return; }
      answer.resume();
      answer.on('end', () => { after?.(); });
    });
    outbound.add(forwarded);
    forwarded.on('close', () => outbound.delete(forwarded));
    forwarded.setTimeout(30_000, () => forwarded.destroy(new Error('Upstream timed out.')));
    forwarded.on('error', () => { outgoing.destroy(); });
    outgoing.on('close', () => { if (reply && !forwarded.destroyed) forwarded.destroy(); });
    forwarded.end(body);
  };
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const method = incoming.method ?? 'GET', path = (incoming.url ?? '/').split('?')[0]!;
    const key = `${method} ${path.startsWith('/storage/') ? path.replace(/[0-9a-f-]{36}/g, 'ID') : path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    state.paths.push(`${method} ${path}`);
    const action = state.rule(method, path, count);
    if (action === 'fail') { outgoing.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"unavailable"}'); return; }
    if (action === 'hold') { state.held.push(() => forward(incoming, outgoing, body, true)); state.onHold(); return; }
    forward(incoming, outgoing, body, action === 'forward', () => state.stop());
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await within(5000, once(server, 'listening'));
  const address = server.address();
  check(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`, state, outbound,
    reset(rule: Rule = () => 'forward') { state.rule = rule; state.paths.length = 0; state.answers.length = 0; counts.clear(); state.held.length = 0; state.stop = () => {}; },
    release() { for (const go of state.held.splice(0)) go(); },
    async close() {
      const closing = [...outbound].map(forwarded => within(5000, once(forwarded, 'close')).catch(() => {}));
      for (const forwarded of outbound) forwarded.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
      await Promise.all([...closing, within(5000, once(server, 'close')).catch(() => {})]);
    },
  };
}

type Account = { client: AppClient; scope: OwnerScope; email: string; password: string };
// Every public table an owner session can read, every column (versions and timestamps included), plus the owner's
// Storage objects: names, and for restored items also the bytes' hashes.
const tables = ['items', 'item_images', 'outfits', 'outfit_items', 'wear_events', 'wear_event_items', 'combination_rules',
  'suggestion_feedback', 'profiles', 'style_preferences'] as const;
type Snapshot = Record<(typeof tables)[number], Record<string, unknown>[]> & { objects: string[] };
async function listFolder(account: Account, prefix: string) {
  const listed = await account.client.storage.from('wardrobe').list(prefix, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  check(!listed.error && Array.isArray(listed.data) && listed.data.length < 1000);
  return listed.data.map(entry => ({ name: entry.name, folder: entry.id === null }));
}
// The owner's objects as `path` (every item folder) or `path sha256` (restored items). A normal session sees the objects
// its image rows name; the create policy admits no object without such a row.
async function storedObjects(account: Account, hashed: ReadonlySet<string>) {
  const owner = account.scope.ownerId, result: string[] = [];
  for (const item of await listFolder(account, owner)) {
    if (!item.folder) { result.push(`${owner}/${item.name}`); continue; }
    for (const image of await listFolder(account, `${owner}/${item.name}`)) {
      const folder = `${owner}/${item.name}/${image.name}`;
      if (!image.folder) { result.push(folder); continue; }
      for (const file of await listFolder(account, folder)) {
        const path = `${folder}/${file.name}`;
        if (file.folder || !hashed.has(item.name)) { result.push(path); continue; }
        const body = await account.client.storage.from('wardrobe').download(path);
        check(!body.error && body.data);
        result.push(`${path} ${sha(new Uint8Array(await body.data.arrayBuffer()))}`);
      }
    }
  }
  return result.sort();
}
async function snapshot(account: Account, hashed: ReadonlySet<string> = new Set()): Promise<Snapshot> {
  const result = {} as Snapshot;
  for (const table of tables) {
    const found = await account.client.from(table).select('*').eq('owner_id', account.scope.ownerId);
    check(!found.error && Array.isArray(found.data));
    result[table] = (found.data as unknown as Record<string, unknown>[]).sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);
  }
  result.objects = await storedObjects(account, hashed);
  return result;
}
const objectsOf = (snap: Snapshot, ids: readonly string[]) => snap.objects.filter(entry => ids.some(id => entry.includes(`/${id}/`)));
// Every stored file's bytes against its row.
async function storedFilesMatch(account: Account, images: Record<string, unknown>[]) {
  for (const image of images.filter(entry => entry.state !== 'pending')) {
    for (const variant of ['main', 'thumb'] as const) {
      const file = await account.client.storage.from('wardrobe').download(String(image[`${variant}_path`]));
      check(!file.error && file.data);
      check(sha(new Uint8Array(await file.data.arrayBuffer())) === image[`${variant}_sha256`]);
    }
  }
}

const appJpeg = async () => new Uint8Array(await readFile(new URL('../security/fixture.jpg', import.meta.url)));
const baseline = (width: number, height: number, colour: number[]) => ({ bytes: flatJpeg({ width, height, colour }), width, height });
const progressive = (width: number, height: number, colour: number[]) => ({ bytes: flatJpeg({ width, height, colour, mode: 'progressive' }), width, height });
const restart = (width: number, height: number, colour: number[]) => ({ bytes: flatJpeg({ width, height, colour, mode: 'restart', restartInterval: 1 }), width, height });
// Structurally fatal: bytes after EOI.
const hostile = (width: number, height: number) => {
  const good = flatJpeg({ width, height, colour: [128, 128, 128] });
  const bytes = new Uint8Array(good.length + 4);
  bytes.set(good); bytes.set([0x41, 0x42, 0x43, 0x44], good.length);
  return { bytes, width, height };
};
const jsonReport = (stdout: string) => JSON.parse(stdout.split('\n').find(line => line.startsWith('{')) ?? 'null') as
  { counts: Record<string, number>; photos: { sourceImageId: string; outcome: string; planned: { main: string; sourceSha256: string; mainSha256: string; thumbSha256: string }; stored: { mainSha256: string; thumbSha256: string } | null }[] } | null;

async function world() {
  validateSessionEnvironment(process.env);
  const base = assertLocalApi(process.env.SUPABASE_URL!), key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  const clients: AppClient[] = [];
  const signIn = async (label: 'A' | 'B'): Promise<Account> => {
    const client = createClient<Database>(base, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `restore-own-${randomUUID()}`, debug: false },
    }) as AppClient;
    clients.push(client);
    const email = process.env[`TEST_${label}_EMAIL`]!, password = process.env[`TEST_${label}_PASSWORD`]!;
    const login = await client.auth.signInWithPassword({ email, password });
    check(!login.error && login.data.user);
    return { client, scope: { ownerId: login.data.user.id, epoch: 1, signal: new AbortController().signal } as OwnerScope, email, password };
  };
  const a = await signIn('A'), b = await signIn('B');
  check(a.scope.ownerId !== b.scope.ownerId);
  // What account A has before this test; cleanup removes everything the restores added, so later suites see A as it was.
  const ownRows = async () => {
    const rows = new Map<string, Set<string>>();
    for (const table of ['items', 'item_images', 'outfits', 'wear_events', 'wear_event_items', 'combination_rules', 'suggestion_feedback'] as const) {
      const found = await a.client.from(table).select('id').eq('owner_id', a.scope.ownerId);
      check(!found.error && Array.isArray(found.data));
      rows.set(table, new Set((found.data as { id: string }[]).map(row => String(row.id))));
    }
    return rows;
  };
  const initial = await ownRows();
  const proxy = await startProxy(base);
  const children = new Children();
  const parent = await mkdtemp(join(tmpdir(), 'restore-own-local-'));
  const backup = async (name: string, items: SyntheticItem[], exportId = randomUUID(), extras = true) => {
    const folder = join(parent, name);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder);
    const parts = await writeSyntheticBackup(folder, { owner: a.scope.ownerId, exportId, items, extras }, PASSPHRASE);
    // The IDs the restore gives these items in account A.
    const ids = await Promise.all(items.map((_, n) => restoreId(2, a.scope.ownerId, exportId, 'items', syntheticId(exportId, 1, n))));
    return { folder, exportId, parts, ids };
  };
  const cli = (folder: string, who: Account = a, args: string[] = ['--yes', '--report', 'json'], env: Record<string, string> = {}) =>
    children.launch([join(ROOT, 'scripts', 'restore-own.mjs'), folder, '--local', proxy.url, ...args], childEnvironment(key, env),
      `${who.email}\n${who.password}\n${PASSPHRASE}\n`);
  const secrets = [a.email, a.password, b.email, b.password, PASSPHRASE, parent, a.scope.ownerId, b.scope.ownerId];
  const quiet = (run: Run) => secrets.every(secret => !(run.stdout + run.stderr).includes(secret));
  const removeLock = () => rm(join(parent, LOCK));
  const cleanup = async () => {
    const problems: string[] = [];
    if (!await children.stopAll()) problems.push('process');
    await proxy.close();
    if (proxy.outbound.size !== 0) problems.push('proxy');
    // History, outfits, rules and feedback the restores added are deleted by the owner (entries and links go with them),
    // then every item the restores added is removed the way the app deletes items.
    for (const table of ['wear_events', 'outfits', 'combination_rules', 'suggestion_feedback'] as const) {
      const rows = await a.client.from(table).select('id').eq('owner_id', a.scope.ownerId);
      if (rows.error) { problems.push(`residue:${table}`); continue; }
      const added = (rows.data as { id: string }[]).map(row => String(row.id)).filter(id => !initial.get(table)!.has(id));
      if (added.length && (await a.client.from(table).delete().eq('owner_id', a.scope.ownerId).in('id', added)).error) problems.push(`delete:${table}`);
    }
    const items = await a.client.from('items').select('id').eq('owner_id', a.scope.ownerId);
    if (items.error) problems.push('residue:items');
    for (const id of ((items.data ?? []) as { id: string }[]).map(row => String(row.id)).filter(id => !initial.get('items')!.has(id))) {
      try {
        const lifecycle = new ItemLifecycleClient(a.client, { url: base, publishableKey: key, version: 'local-restore-own-test' }, a.scope);
        let status = await lifecycle.statusOf(id);
        if (!status.deleted_at) await lifecycle.change(id, true, status.version, () => {});
        status = await lifecycle.statusOf(id);
        await lifecycle.delete(deletionIntent(status, a.scope.epoch), true, () => {});
      } catch { problems.push('item'); }
    }
    try {
      for (const [table, ids] of await ownRows()) if ([...ids].some(id => !initial.get(table)!.has(id))) problems.push(`residue:${table}`);
    } catch { problems.push('residue'); }
    await rm(parent, { recursive: true, force: true }).catch(() => problems.push('folder'));
    for (const client of clients) await client.auth.signOut({ scope: 'local' }).catch(() => problems.push('sign-out'));
    return problems;
  };
  return { a, b, proxy, children, parent, backup, cli, quiet, removeLock, cleanup };
}

// The browser's own photo steps, in the app page, for the parity check against what the CLI stored.
async function appSteps(page: Page) {
  await page.goto('/');
  await page.evaluate(async (entry) => { await import(entry); }, '/src/images/restore-worker-entry.ts');
  return (step: string, ...args: unknown[]) => page.evaluate(([name, values]) =>
    (globalThis as unknown as { stillroomRestoreImages: Record<string, (...a: unknown[]) => Promise<{ ok: boolean; value: Record<string, unknown> }>> })
      .stillroomRestoreImages[name as string]!(...(values as unknown[])), [step, args] as const);
}

test.describe.configure({ mode: 'serial' });

test('restore-own: restore, parity with the browser steps, idempotent rerun, conflicts, refusals and stops', async ({ page }) => {
  test.setTimeout(900_000);
  const w = await world();
  const { a, b, proxy, cli, children, quiet } = w;
  let stage = 'fixtures', detail = '';
  let problems: string[];
  try {
    const app = await appJpeg();
    const beforeA = await snapshot(a), beforeB = await snapshot(b);
    const items: SyntheticItem[] = [
      { title: 'Fictional shirt', photos: [{ bytes: app, width: 2, height: 2 }, progressive(24, 16, [90, 110, 150])],
        provenance: { title: { kind: 'user', revision: 3 }, category: { kind: 'ai_observed', revision: 2 }, colours: { kind: 'ai_estimated', revision: 1 }, seasons: { kind: 'user', revision: 2 } } },
      { title: 'Fictional trousers', photos: [baseline(16, 24, [60, 120, 140])], notes: 'Fictional note' },
      { title: 'Fictional jacket', photos: [baseline(16, 16, [40, 100, 160]), restart(32, 16, [70, 130, 120]), baseline(24, 24, [150, 90, 110])] },
    ];
    const main = await w.backup('main', items);

    stage = 'chromium-missing';
    proxy.reset();
    const noBrowser = await children.finish(cli(main.folder, a, ['--yes'], { PLAYWRIGHT_BROWSERS_PATH: join(w.parent, 'no-browsers') }));
    check(noBrowser.code === 1 && noBrowser.stderr.includes('npx playwright install chromium') && proxy.state.paths.length === 0);

    stage = 'late-photo-fatal';
    const fatal = await w.backup('fatal', [items[1]!, { title: 'Fictional broken', photos: [baseline(8, 8, [1, 2, 3]), hostile(16, 16)] }]);
    const refusedFatal = await children.finish(cli(fatal.folder));
    check(refusedFatal.code === 1 && refusedFatal.stderr.includes('(invalid)') && proxy.state.paths.length === 0);

    stage = 'restore';
    proxy.reset();
    const restored = await children.finish(cli(main.folder));
    // Bounded diagnostics for CI: allowlisted outcomes, refusal codes and routes only; nothing from output that fails
    // the redaction check.
    detail = restoreDiagnostics(restored, proxy.state.paths, quiet(restored), proxy.state.answers);
    check(restored.code === 0 && restored.stdout.includes('Restore complete.') && restored.stderr.includes('2 photos will be re-encoded.'));
    check(quiet(restored) && quiet(noBrowser) && quiet(refusedFatal));
    // Later photos are completed by the served finalize-image-change function, and no other function is called.
    check(proxy.state.paths.includes('POST /functions/v1/finalize-image-change')
      && proxy.state.paths.every(path => !path.includes('/functions/') || path === 'POST /functions/v1/finalize-image-change'));
    stage = 'restore:report';
    const report = jsonReport(restored.stdout);
    check(report && report.counts.restored === 3 && report.photos.length === 6 && report.photos.every(photo => photo.outcome === 'written'));
    stage = 'restore:rows';
    const after = await snapshot(a);
    const own = after.items.filter(item => main.ids.includes(String(item.id)));
    check(own.length === 3);
    for (const [n, item] of items.entries()) {
      const row = after.items.find(entry => entry.id === main.ids[n]!);
      check(row && row.title === item.title && row.deleted_at === null && Number(row.version) >= 1);
      const photos = after.item_images.filter(image => image.item_id === main.ids[n]!);
      check(photos.filter(image => image.state === 'ready').length === 1 && photos.filter(image => image.state === 'retired').length === item.photos.length - 1);
    }
    stage = 'restore:provenance';
    const shirt = after.items.find(entry => entry.id === main.ids[0]!)!;
    const kinds = Object.fromEntries(Object.entries(shirt.field_provenance as Record<string, { kind: string }>).map(([field, entry]) => [field, entry.kind]));
    // Kinds are kept (an AI kind on a field the analyzer can't fill that way becomes unknown, colours being observed, not
    // estimated); a cleared field (no seasons) carries none, as in the browser restore.
    check(kinds.title === 'user' && kinds.category === 'ai_observed' && kinds.colours === 'unknown' && !('seasons' in kinds));
    check(after.items.find(entry => entry.id === main.ids[1]!)!.notes === 'Fictional note');
    stage = 'restore:hashes';
    // Planned hashes are what was stored; kept photos are the backup's bytes, unchanged.
    for (const photo of report.photos) {
      const row = after.item_images.find(image => image.main_sha256 === photo.stored!.mainSha256);
      check(row && row.thumb_sha256 === photo.stored!.thumbSha256 && photo.planned.mainSha256 === photo.stored!.mainSha256
        && photo.planned.thumbSha256 === photo.stored!.thumbSha256);
      check(photo.planned.main === 'preserved' ? photo.planned.mainSha256 === photo.planned.sourceSha256 : photo.planned.mainSha256 !== photo.planned.sourceSha256);
    }
    check(report.photos.filter(photo => photo.planned.main !== 'preserved').length === 2);
    stage = 'restore:files';
    await storedFilesMatch(a, after.item_images.filter(image => own.some(item => item.id === image.item_id)));
    stage = 'restore:history';
    // History keeps the text of the item that is gone, without a link; the other entry links the restored shirt.
    const event = await restoreId(2, a.scope.ownerId, main.exportId, 'wear_events', syntheticId(main.exportId, 4, 1));
    const entries = after.wear_event_items.filter(entry => entry.event_id === event);
    check(entries.length === 2 && entries.some(entry => entry.item_id === main.ids[0])
      && entries.some(entry => entry.item_id === null && entry.title_snapshot === 'Fictional scarf, long gone' && entry.category_snapshot === 'accessory'));
    stage = 'restore:related';
    check(after.outfits.length === beforeA.outfits.length + 1 && after.combination_rules.length === beforeA.combination_rules.length + 1
      && after.suggestion_feedback.length === beforeA.suggestion_feedback.length + 1);
    stage = 'restore:unchanged';
    // The account's own profile, preferences and consent are kept; nothing of B changed.
    check(canonical(after.profiles) === canonical(beforeA.profiles) && canonical(after.style_preferences) === canonical(beforeA.style_preferences));
    check(canonical(await snapshot(b)) === canonical(beforeB));

    stage = 'browser-parity';
    const step = await appSteps(page);
    const reencoded = await step('reencode', Buffer.from(items[0]!.photos[1]!.bytes).toString('base64'));
    check(reencoded.ok && after.item_images.some(image => image.main_sha256 === reencoded.value.mainSha256 && image.thumb_sha256 === reencoded.value.thumbSha256));
    const kept = await step('thumbnail', Buffer.from(items[1]!.photos[0]!.bytes).toString('base64'), 16, 24);
    check(kept.ok && after.item_images.some(image => image.main_sha256 === sha(items[1]!.photos[0]!.bytes) && image.thumb_sha256 === kept.value.sha256));

    stage = 'idempotent';
    const settled = await snapshot(a, new Set(main.ids));
    check(objectsOf(settled, main.ids).length === 12 && objectsOf(settled, main.ids).every(entry => / [0-9a-f]{64}$/.test(entry)));
    proxy.reset();
    const again = await children.finish(cli(main.folder));
    check(again.code === 0 && again.stdout.includes('Items: 0 restored, 3 already here'));
    check(!proxy.state.paths.some(path => /rpc\/reserve_|POST \/storage|functions/.test(path)));
    const unchanged = await snapshot(a, new Set(main.ids));
    check(canonical(unchanged) === canonical(settled));
    await storedFilesMatch(a, unchanged.item_images.filter(image => own.some(item => item.id === image.item_id)));

    stage = 'conflict';
    const trousers = unchanged.items.find(entry => entry.id === main.ids[1]!)!;
    const edited = await a.client.from('items').update({ notes: 'Changed here' }).eq('id', String(trousers.id)).eq('owner_id', a.scope.ownerId)
      .eq('version', Number(trousers.version)).select('version');
    check(!edited.error && edited.data?.length === 1);
    const kept5 = await children.finish(cli(main.folder));
    check(kept5.code === 5 && kept5.stdout.includes('1 changed here and left as they are'));
    check((await snapshot(a)).items.find(entry => entry.id === main.ids[1]!)!.notes === 'Changed here');

    stage = 'other-account';
    proxy.reset();
    const other = await children.finish(cli(main.folder, b));
    check(other.code === 1 && other.stderr.includes('(otherAccount)') && quiet(other));
    check(proxy.state.paths.every(path => path.includes('/auth/v1/')));
    const crossPiped = await children.finish(cli(main.folder, b, ['--yes', '--allow-other-account']));
    check(crossPiped.code === 1 && crossPiped.stderr.includes('(crossTty)'));
    check(canonical(await snapshot(b)) === canonical(beforeB));

    stage = 'retryable';
    const retry = await w.backup('retry', [{ title: 'Fictional retry top', photos: [baseline(8, 16, [30, 90, 200])] },
      { title: 'Fictional retry skirt', photos: [baseline(16, 8, [200, 90, 30])] }]);
    proxy.reset((_method, path) => path === '/rest/v1/rpc/save_outfit' ? 'fail' : 'forward');
    const unavailable = await children.finish(cli(retry.folder));
    check(unavailable.code === 2 && unavailable.stderr.includes('Restore incomplete') && /run the same command again/i.test(unavailable.stderr));
    const outfit = await restoreId(2, a.scope.ownerId, retry.exportId, 'outfits', syntheticId(retry.exportId, 3, 1));
    check(!(await snapshot(a)).outfits.some(row => row.id === outfit));
    proxy.reset();
    const retried = await children.finish(cli(retry.folder));
    check(retried.code === 0 && (await snapshot(a)).outfits.some(row => row.id === outfit));

    if (process.platform !== 'win32') {
      stage = 'cancel';
      const cancelled = await w.backup('cancel', [{ title: 'Fictional cancelled coat', photos: [baseline(8, 8, [10, 200, 10])] }], randomUUID(), false);
      const held = new Promise<void>(resolve => { proxy.state.onHold = resolve; });
      proxy.reset((_method, path, count) => path === '/rest/v1/rpc/reserve_restored_item_save' && count === 1 ? 'hold' : 'forward');
      const running = cli(cancelled.folder);
      await within(120_000, held);
      running.child.kill('SIGINT');
      const stopped = await children.finish(running);
      proxy.release();
      check(stopped.code === 130 && stopped.stderr.includes('(cancelled)'));
      proxy.reset();
      check((await children.finish(cli(cancelled.folder))).code === 0);
    }

    stage = 'recheck-changed';
    const drift = await w.backup('drift', [{ title: 'Fictional drift one', photos: [baseline(8, 8, [20, 60, 90])] },
      { title: 'Fictional drift two', photos: [baseline(8, 8, [90, 60, 20])] }]);
    const other1 = await w.backup('drift-other', [{ title: 'Fictional drift one', photos: [baseline(8, 8, [21, 60, 90])] },
      { title: 'Fictional drift two', photos: [baseline(8, 8, [91, 60, 20])] }], drift.exportId);
    const heldItems = new Promise<void>(resolve => { proxy.state.onHold = resolve; });
    // The first item's reservation is held; the file changes before the second item's photo is read again.
    proxy.reset((_method, path, count) => path === '/rest/v1/rpc/reserve_restored_item_save' && count === 1 ? 'hold' : 'forward');
    const drifting = cli(drift.folder);
    await within(120_000, heldItems);
    await copyFile(join(other1.folder, other1.parts[1]!), join(drift.folder, drift.parts[1]!));
    proxy.release();
    const recheck = await children.finish(drifting);
    check(recheck.code === 3 && recheck.stderr.includes('(recheck)') && jsonReport(recheck.stdout)?.counts.restored === 1);
    const partial = await snapshot(a);
    check(partial.items.some(item => item.id === drift.ids[0]!) && !partial.items.some(item => item.id === drift.ids[1]!));
    // Rerunning with the changed file refuses it before any request: its content no longer matches the backup.
    proxy.reset();
    const changedFile = await children.finish(cli(drift.folder));
    check(changedFile.code === 1 && changedFile.stderr.includes('(invalid)') && proxy.state.paths.length === 0);

    stage = 'recheck-deleted';
    const gone = await w.backup('gone', [{ title: 'Fictional gone one', photos: [baseline(8, 8, [120, 60, 90])] },
      { title: 'Fictional gone two', photos: [baseline(8, 8, [60, 120, 90])] }]);
    const heldGone = new Promise<void>(resolve => { proxy.state.onHold = resolve; });
    proxy.reset((_method, path, count) => path === '/rest/v1/rpc/reserve_restored_item_save' && count === 1 ? 'hold' : 'forward');
    const deleting = cli(gone.folder);
    await within(120_000, heldGone);
    await rm(join(gone.folder, gone.parts[1]!));
    proxy.release();
    const deleted = await children.finish(deleting);
    check(deleted.code === 3 && deleted.stderr.includes('(recheck)'));

    stage = 'resumed-fatal';
    const resumed = await w.backup('resumed', [{ title: 'Fictional resumed one', photos: [baseline(8, 8, [33, 66, 99])] },
      { title: 'Fictional resumed two', photos: [baseline(8, 8, [99, 66, 33])] }]);
    let resolveStop = () => {};
    const stopSignal = new Promise<void>(resolve => { resolveStop = resolve; });
    proxy.reset((_method, path, count) => path === '/rest/v1/rpc/finalize_item_save' && count === 1 ? 'stop' : 'forward');
    proxy.state.stop = () => resolveStop();
    const first = cli(resumed.folder);
    await within(120_000, stopSignal);
    first.child.kill('SIGKILL');
    await children.finish(first);
    await w.removeLock();
    await w.backup('resumed', [{ title: 'Fictional resumed one', photos: [baseline(8, 8, [33, 66, 99])] },
      { title: 'Fictional resumed two', photos: [baseline(8, 8, [99, 66, 33]), hostile(16, 8)] }], resumed.exportId);
    proxy.reset();
    const refusedLate = await children.finish(cli(resumed.folder));
    check(refusedLate.code === 1 && refusedLate.stderr.includes('(invalid)') && proxy.state.paths.length === 0);
    check((await snapshot(a)).items.some(item => item.id === resumed.ids[0]!));

    stage = 'blocked';
    const blocked = await w.backup('blocked', [{ title: 'Fictional blocked shirt', photos: [baseline(8, 8, [44, 88, 132])] },
      { title: 'Fictional blocked trousers', photos: [baseline(8, 8, [132, 88, 44])] }]);
    let stopBlocked = () => {};
    const reserved = new Promise<void>(resolve => { stopBlocked = resolve; });
    proxy.reset((_method, path, count) => path === '/rest/v1/rpc/reserve_restored_item_save' && count === 1 ? 'stop' : 'forward');
    proxy.state.stop = () => stopBlocked();
    const reserving = cli(blocked.folder);
    await within(120_000, reserved);
    reserving.child.kill('SIGKILL');
    await children.finish(reserving);
    await w.removeLock();
    const pending = (await snapshot(a)).item_images.filter(image => image.item_id === blocked.ids[0]!);
    check(pending.length === 1 && pending[0]!.state === 'pending');
    // Same backup IDs, other bytes for the reserved photo: the reservation no longer matches.
    await w.backup('blocked', [{ title: 'Fictional blocked shirt', photos: [baseline(8, 8, [45, 88, 132])] },
      { title: 'Fictional blocked trousers', photos: [baseline(8, 8, [132, 88, 44])] }], blocked.exportId);
    proxy.reset();
    const blockedRun = await children.finish(cli(blocked.folder));
    check(blockedRun.code === 6 && blockedRun.stderr.includes('Restore incomplete. Completed changes remain; blocked photos and their dependents were not completed.'));
    check(!/run the same command again/i.test(blockedRun.stderr) && jsonReport(blockedRun.stdout)?.counts.blocked === 1);
    const kept6 = (await snapshot(a)).item_images.filter(image => image.item_id === blocked.ids[0]!);
    check(canonical(kept6) === canonical(pending));
    check(canonical(await snapshot(b)) === canonical(beforeB));
    const finalA = await snapshot(a);
    check(canonical(finalA.profiles) === canonical(beforeA.profiles) && canonical(finalA.style_preferences) === canonical(beforeA.style_preferences));

    // An unfinished save has only a pending photo, so it cannot be moved to the trash. The owner finishes the blocked and
    // the refused backups from their original files; afterwards every restored item can be deleted the way the app deletes items.
    stage = 'finish-unfinished';
    await w.backup('blocked', [{ title: 'Fictional blocked shirt', photos: [baseline(8, 8, [44, 88, 132])] },
      { title: 'Fictional blocked trousers', photos: [baseline(8, 8, [132, 88, 44])] }], blocked.exportId);
    check((await children.finish(cli(blocked.folder))).code === 0);
    await w.backup('resumed', [{ title: 'Fictional resumed one', photos: [baseline(8, 8, [33, 66, 99])] },
      { title: 'Fictional resumed two', photos: [baseline(8, 8, [99, 66, 33])] }], resumed.exportId);
    check((await children.finish(cli(resumed.folder))).code === 0);
    const finished = (await snapshot(a)).item_images.filter(image => [...blocked.ids, ...resumed.ids].includes(String(image.item_id)));
    check(finished.length === 4 && finished.every(image => image.state === 'ready'));
  } catch (problem) {
    throw new AggregateError([new Error(`restore-own primary failed at ${stage}.${stage.startsWith('restore') ? detail : ''}`)], problem === failure ? 'Local restore-own gate failed.' : 'Local restore-own gate failed (unexpected).', { cause: problem });
  } finally {
    problems = await w.cleanup();
  }
  expect(problems).toEqual([]);
});

test('restore-own: interrupted at each write step, then resumed to the same result with no duplicates', async () => {
  test.setTimeout(900_000);
  const w = await world();
  const { a, b, proxy, cli, children, quiet } = w;
  let stage = 'fixtures';
  let problems: string[];
  try {
    const beforeB = await snapshot(b), beforeA = await snapshot(a);
    const items: SyntheticItem[] = [
      { title: 'Fictional resume shirt', photos: [baseline(16, 16, [80, 90, 100]), progressive(16, 24, [100, 90, 80]), baseline(24, 16, [90, 100, 80])] },
      { title: 'Fictional resume trousers', photos: [baseline(8, 16, [50, 60, 70]), baseline(16, 8, [70, 60, 50])] },
      { title: 'Fictional resume hat', photos: [baseline(8, 8, [20, 40, 60])] },
    ];
    const main = await w.backup('resume', items);
    const points: [string, (method: string, path: string, count: number) => boolean][] = [
      ['after-reserve', (_m, path, count) => path === '/rest/v1/rpc/reserve_restored_item_save' && count === 1],
      // Save uploads the thumbnail first: stop once it is stored, before the main file is sent.
      ['between-uploads', (m, path, count) => m === 'POST' && path.startsWith('/storage/v1/object/wardrobe/') && path.endsWith('/thumb.jpg') && count === 1],
      ['after-completion-before-reply', (_m, path, count) => path === '/rest/v1/rpc/finalize_item_save' && count === 1],
      ['during-replacement', (_m, path, count) => path === '/functions/v1/finalize-image-change' && count === 1],
      ['during-history', (_m, path, count) => path === '/rest/v1/rpc/restore_history_entry' && count === 1],
    ];
    for (const [index, [name, matches]] of points.entries()) {
      stage = name;
      let stopped = () => {};
      const reached = new Promise<void>(resolve => { stopped = resolve; });
      proxy.reset((method, path, count) => matches(method, path, count) ? 'stop' : 'forward');
      proxy.state.stop = () => stopped();
      const run = cli(main.folder);
      await within(180_000, Promise.race([reached, run.done.then(() => { throw failure; })]));
      run.child.kill('SIGKILL');
      const killed = await children.finish(run);
      check(killed.code !== 0 && quiet(killed));
      if (name === 'between-uploads') {
        check(!proxy.state.paths.some(path => path.startsWith('POST /storage/') && path.endsWith('/main.jpg')));
        const pending = (await snapshot(a)).item_images.filter(image => image.state === 'pending' && main.ids.includes(String(image.item_id)));
        check(pending.length === 1);
        const objects = await listFolder(a, String(pending[0]!.thumb_path).split('/').slice(0, 3).join('/'));
        check(objects.length === 1 && objects[0]!.name === 'thumb.jpg');
      }
      if (index === 0) {
        proxy.reset();
        const busy = await children.finish(cli(main.folder));
        check(busy.code === 1 && busy.stderr.includes('(busy)') && busy.stderr.includes(`delete ${LOCK}`) && proxy.state.paths.length === 0);
      }
      // The owner checks that no restore is running and deletes the lock, as the message says. It is never taken over by age.
      await w.removeLock();
      const midway = await snapshot(a);
      check(canonical(midway.profiles) === canonical(beforeA.profiles));
    }

    stage = 'resume';
    proxy.reset();
    const finished = await children.finish(cli(main.folder));
    check(finished.code === 0 && finished.stdout.includes('Restore complete.') && quiet(finished));
    const after = await snapshot(a);
    for (const [n, item] of items.entries()) {
      const row = after.items.find(entry => entry.id === main.ids[n]!);
      check(row && Number(row.version) >= 1 && row.deleted_at === null);
      const photos = after.item_images.filter(image => image.item_id === main.ids[n]!);
      check(photos.length === item.photos.length && photos.filter(image => image.state === 'ready').length === 1);
    }
    const own = new Set(items.map((_, n) => main.ids[n]!));
    await storedFilesMatch(a, after.item_images.filter(image => own.has(String(image.item_id))));
    // One history entry, restored once despite the interruption during history.
    const event = await restoreId(2, a.scope.ownerId, main.exportId, 'wear_events', syntheticId(main.exportId, 4, 1));
    check(after.wear_events.filter(entry => entry.id === event).length === 1);
    const entries = after.wear_event_items.filter(entry => entry.event_id === event);
    check(entries.length === 2 && entries.some(entry => entry.item_id === main.ids[0]) && entries.some(entry => entry.item_id === null));

    stage = 'no-further-changes';
    const settled = await snapshot(a, new Set(main.ids));
    check(objectsOf(settled, main.ids).length === 12);
    proxy.reset();
    const again = await children.finish(cli(main.folder));
    check(again.code === 0);
    check(canonical(await snapshot(a, new Set(main.ids))) === canonical(settled));
    check(canonical(await snapshot(b)) === canonical(beforeB));
  } catch (problem) {
    throw new AggregateError([new Error(`restore-own resume failed at ${stage}.`)], problem === failure ? 'Local restore-own gate failed.' : 'Local restore-own gate failed (unexpected).', { cause: problem });
  } finally {
    problems = await w.cleanup();
  }
  expect(problems).toEqual([]);
});
