#!/usr/bin/env node
// Weekly encrypted backup of your own Stillroom account:
//   node scripts/export-own.mjs --output DIR [--local http://127.0.0.1:PORT]
// Signs in with your normal email and password (typed at the prompt, or three piped lines: email, password, passphrase).
// Nothing secret is accepted from arguments, the environment or files, and no administrator key is ever used. Reads go
// through your own row-level security. The result, DIR/stillroom-<export id>/, has the same parts as the Backup card
// and passes scripts/verify-backup.mjs. An interrupted run leaves DIR/.stillroom-export-<export id>.partial/, which the
// same command resumes (within a day) or reports as incomplete; a partial backup is never reported as complete.
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { assertMetadata, BACKUP_LIMITS, BackupFormatError, decryptPart, fromBase64, metadataDigest, partFileName, sha256Hex, verifyBackup } from '../src/domain/export-format.ts';
import { assemblePart, collectSnapshot, fromMetadata } from '../src/domain/export-run.ts';
import { PromptError, readPipedInput, readTerminalLine } from './backup-prompt.mjs';
import { HOSTED_URL } from './hosted-smoke.mjs';
import { exportPolicy, ownerTransport, REQUEST_TIMEOUT_MS } from './owner-transport.mjs';
import { checkJpeg, listParts, partSource } from './verify-backup.mjs';

export { REQUEST_TIMEOUT_MS };
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const INPUT_BYTES = 4096;
const LOCK = '.stillroom-export.lock';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`);
const stagingPattern = new RegExp(`^\\.stillroom-export-(${uuid})\\.partial$`);


// Only fixed text leaves the process: counts, part numbers, the random export ID, the metadata hash and generated folder names.
const MESSAGES = {
  usage: 'Usage: node scripts/export-own.mjs --output DIR [--local http://127.0.0.1:PORT]',
  endpoint: 'Only the Stillroom project, or --local with a loopback address and port, can be backed up.',
  key: 'Set SUPABASE_PUBLISHABLE_KEY to the project\'s publishable key. Secret keys are refused.',
  environment: 'Administrator or database credentials are set in this environment. Remove them and run again.',
  input: 'Expected the email, password and passphrase as three lines. The passphrase needs at least 16 characters.',
  mismatch: 'The two passphrases were different.',
  output: 'The output folder can\'t be used.',
  auth: 'Sign-in failed or the session ended. Check your email and password, then run the same command again.',
  unavailable: 'Stillroom couldn\'t be reached. Run the same command again to continue.',
  changed: 'Items or photos changed while the backup was being made. Delete the unfinished folder and run again.',
  passphrase: 'That passphrase doesn\'t open the unfinished backup.',
  stale: 'The unfinished backup is more than a day old. Delete it and run again.',
  unresumable: 'The unfinished backup has no saved snapshot. Delete it and run again.',
  conflict: 'The output folder has unexpected or conflicting backup files. Nothing was changed.',
  busy: `Another backup is using this output folder. If no backup is running, delete ${LOCK} and ${LOCK}.reclaim (if present) from the folder and run again.`,
  tooLarge: 'The wardrobe is larger than one backup can hold.',
  cancelled: 'Cancelled. Run the same command again to continue.',
  io: 'Writing the backup failed. Check the disk, then run the same command again to continue.',
  invalid: 'The backup couldn\'t be completed. Run the same command again to continue.',
};
const REFUSALS = new Set(['usage', 'endpoint', 'key', 'environment', 'input', 'mismatch', 'output']);

export class ExportError extends Error {
  constructor(code, staging) { super(code); this.name = 'ExportError'; this.code = code; this.staging = staging; }
}
const refuse = (code, staging) => { throw new ExportError(code, staging); };

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--output', '--local'].includes(name) || Object.hasOwn(options, name) || typeof value !== 'string' || !value || value.startsWith('-')) refuse('usage');
    options[name] = value;
  }
  if (!options['--output']) refuse('usage');
  return { output: resolve(options['--output']), local: options['--local'] };
}

export function forbiddenEnvironment(env) {
  const forbidden = /(?:SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)|DATABASE_URL|DB_PASSWORD|PGPASSWORD)/i;
  return Object.entries(env).some(([name, value]) => value && forbidden.test(name));
}

export function resolveEndpoint(env, local) {
  let origin = HOSTED_URL;
  if (local !== undefined) {
    let url;
    try { url = new URL(local); } catch { refuse('endpoint'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || ![url.origin, `${url.origin}/`].includes(local)) refuse('endpoint');
    origin = url.origin;
  }
  if (env.SUPABASE_URL !== undefined && env.SUPABASE_URL !== origin) refuse('endpoint');
  return origin;
}

export function publishableKey(env) {
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (typeof key !== 'string') refuse('key');
  if (/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(key)) return key;
  const parts = key.split('.');
  if (parts.length === 3 && key.length <= 4096) {
    try { if (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon') return key; } catch { /* refused below */ }
  }
  return refuse('key');
}

// Piped input is exactly three lines, each ending in LF or CRLF (the last line ending is optional), in at most 4096 bytes
// of UTF-8. Nothing is trimmed: spaces are part of the password and passphrase.
export function parseSecrets(buffer) {
  if (buffer.length > INPUT_BYTES) refuse('input');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { refuse('input'); }
  if (text.includes('\0')) refuse('input');
  if (text.endsWith('\r\n')) text = text.slice(0, -2); else if (text.endsWith('\n')) text = text.slice(0, -1);
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.length !== 3 || lines.some(line => line.includes('\r'))) refuse('input');
  const [email, password, passphrase] = lines;
  checkSecrets(email, password, passphrase);
  return { email, password, passphrase };
}

function checkSecrets(email, password, passphrase) {
  if (!/^[^\s@]{1,256}@[^\s@]{1,256}$/.test(email) || email.length > 320 || !password || password.length > 1024
    || passphrase.length < BACKUP_LIMITS.passphrase || passphrase.length > 1024) refuse('input');
}

export async function readSecrets({ stdin, stderr }, confirm) {
  if (!stdin.isTTY) {
    try { return parseSecrets(await readPipedInput(stdin, INPUT_BYTES)); } catch (error) { if (error instanceof PromptError) refuse('input'); throw error; }
  }
  const line = (prompt, hidden) => readTerminalLine({ input: stdin, output: stderr, prompt, hidden, limit: hidden ? 1024 : 320 })
    .catch(error => refuse(error instanceof PromptError && error.problem === 'cancelled' ? 'cancelled' : 'input'));
  const email = await line('Email: ', false);
  const password = await line('Password: ', true);
  const passphrase = await line('Backup passphrase (at least 16 characters): ', true);
  if (confirm && await line('Type the passphrase again: ', true) !== passphrase) refuse('mismatch');
  checkSecrets(email, password, passphrase);
  return { email, password, passphrase };
}

// Every request the SDK or the downloader makes passes the shared gate with the export policy: one origin, sign-in, the
// two export RPCs and the owner's storage prefix, no redirects, no cookies, no caching and a deadline.
export function guardedFetch({ origin, key, fetchImpl, state }) {
  return ownerTransport({ origin, key, fetchImpl, state, policy: exportPolicy, refusal: () => new ExportError('invalid') });
}

export function memoryStorage() {
  const values = new Map();
  return { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: (name) => { values.delete(name); } };
}

export const claimsOf = (token) => {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return {}; }
};
const retryable = (error) => !error || error.name === 'AuthRetryableFetchError' || Number(error.status) >= 500 || Number(error.status) === 0;

// `context.transport` (restore-own) replaces the export gate with another policy on the same shared gate.
export async function signIn(context, secrets) {
  const { origin, key, fetchImpl, guard } = context;
  const client = createClient(origin, key, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, storage: memoryStorage(), storageKey: `${context.storagePrefix ?? 'stillroom-export'}-${randomUUID()}` },
    global: { fetch: context.transport ?? guardedFetch({ origin, key, fetchImpl, state: guard }) },
  });
  context.client = client;
  const { data, error } = await client.auth.signInWithPassword({ email: secrets.email, password: secrets.password });
  if (guard.refused) refuse('invalid');
  if (error || !data?.session || !data.user) refuse(retryable(error) && error?.status !== 400 ? 'unavailable' : 'auth');
  const claims = claimsOf(data.session.access_token);
  if (claims.role !== 'authenticated' || claims.sub !== data.user.id || !uuidPattern.test(data.user.id)) refuse('auth');
  guard.owner = data.user.id;
  return data.user.id;
}

async function accessToken(context) {
  const { data, error } = await context.client.auth.getSession();
  if (context.guard.refused) refuse('invalid');
  if (error || !data?.session) refuse(error && retryable(error) && error.status !== 400 ? 'unavailable' : 'auth');
  return data.session.access_token;
}

function rpcFailure(context, error, status) {
  if (context.guard.refused) refuse('invalid');
  if (status === 401 || error?.code === 'PGRST301' || error?.code === 'PGRST303') refuse('auth');
  refuse('unavailable');
}

function snapshotSource(context) {
  return {
    manifest: async (exportId, signal) => {
      const { data, error, status } = await context.client.rpc('export_manifest', { p_export_id: exportId }).abortSignal(signal);
      if (signal.aborted) refuse('cancelled');
      if (error) rpcFailure(context, error, status);
      return data;
    },
    attribution: async (itemId, signal) => {
      const { data, error, status } = await context.client.rpc('item_attribution_history', { p_item_id: itemId }).abortSignal(signal);
      if (signal.aborted) refuse('cancelled');
      // The item left the saved set (Trash or deletion) after the snapshot.
      if (error?.code === '42501') throw new BackupFormatError('changed');
      if (error) rpcFailure(context, error, status);
      return data;
    },
  };
}

function pause(ms, signal) {
  return new Promise((done, failed) => {
    if (signal.aborted) { failed(new ExportError('cancelled')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); done(); }, ms);
    const stop = () => { clearTimeout(timer); failed(new ExportError('cancelled')); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function boundedBody(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) { await response.body?.cancel().catch(() => {}); throw new BackupFormatError('changed'); }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new BackupFormatError('changed');
      chunks.push(chunk);
    }
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

// Downloads one photo through the authenticated Storage API. Network errors, timeouts and disconnects (while waiting for
// the headers or while reading the body), 408, 429 and 5xx are retried (three attempts). Cancellation, an oversized body
// and a missing or refused object are not retried; the last two mean the wardrobe changed since the snapshot. A content
// hash mismatch is found by the caller and is not retried either.
function fileFetcher(context) {
  const fetchGuarded = guardedFetch({ origin: context.origin, key: context.key, fetchImpl: context.fetchImpl, state: context.guard });
  return async (ref) => {
    if (!ref.path.startsWith(`${context.guard.owner}/`)) refuse('invalid');
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchGuarded(`${context.origin}/storage/v1/object/authenticated/wardrobe/${ref.path}`, {
          method: 'GET', headers: { apikey: context.key, Authorization: `Bearer ${await accessToken(context)}` },
        });
        if (response.ok) return await boundedBody(response, ref.byteLength);
        // Disposal is best effort: a body that already failed must not skip the status below.
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (error instanceof ExportError || error instanceof BackupFormatError) throw error;
        if (context.signal.aborted) refuse('cancelled');
        if (attempt >= 3) refuse('unavailable');
        await pause(500 * attempt, context.signal);
        continue;
      }
      if (response.status === 401) refuse('auth');
      if ([408, 429].includes(response.status) || response.status >= 500) {
        if (attempt >= 3) refuse('unavailable');
        await pause(500 * attempt, context.signal);
        continue;
      }
      throw new BackupFormatError('changed');
    }
  };
}

// ---- Files. Every write goes to an exclusive temporary file, is flushed and closed, then renamed into place, and the
// parent folder is synced. This survives the process being killed at any point. Surviving power loss also depends on
// the disk honouring flushes; on Windows a folder cannot be synced, so a just-renamed name may be lost on power loss.

export const nodeFiles = {
  lstat: (path) => fsp.lstat(path),
  readdir: (path) => fsp.readdir(path),
  mkdir: (path) => fsp.mkdir(path, { mode: 0o700 }),
  open: (path, flags, mode) => fsp.open(path, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  link: (from, to) => fsp.link(from, to),
  unlink: (path) => fsp.unlink(path),
  rmdir: (path) => fsp.rmdir(path),
};

async function present(files, path) {
  try { return await files.lstat(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// Windows cannot open a folder for syncing (EISDIR, or EPERM on some file systems); only that case is tolerated.
export async function syncDirectory(files, path, platform) {
  let handle;
  try {
    handle = await files.open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (platform === 'win32' && ['EISDIR', 'EPERM'].includes(error?.code)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeIfPresent(files, path) {
  try { await files.unlink(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function writeDurable(context, temporary, target, text) {
  const { files, platform } = context;
  await removeIfPresent(files, temporary);
  const handle = await files.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await files.rename(temporary, target);
  await syncDirectory(files, resolve(target, '..'), platform);
}

async function readBounded(files, path, limit) {
  const info = await files.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) refuse('conflict');
  const handle = await files.open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size !== info.size) refuse('conflict');
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    if (bytesRead !== size || (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) refuse('conflict');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    if (error instanceof TypeError) refuse('conflict');
    throw error;
  } finally {
    await handle.close();
  }
}

// ---- Lock: one writer per output folder. The lock is created exclusively, so a second run always reports busy. A lock
// left by a run that was killed is never removed automatically: the owner checks that no backup is running and deletes
// it. A `.reclaim` file (from earlier development builds) is treated the same way.

function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

async function busy(context, path) {
  let detail = '';
  try {
    const { mtimeMs } = await context.files.lstat(path);
    detail = ` The lock was created ${new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z')} (${ago(context.now() - mtimeMs)}).`;
  } catch { /* removed meanwhile; busy without a time */ }
  throw Object.assign(new ExportError('busy'), { detail });
}

// `dir` and `name` let restore-own keep its own lock beside the backup folder; export-own uses the defaults.
export async function acquireLock(context, dir = context.output, name = LOCK) {
  const { files } = context, output = dir;
  const path = join(output, name), reclaim = join(output, `${name}.reclaim`);
  if (await present(files, reclaim)) await busy(context, reclaim);
  const token = randomUUID();
  let handle;
  try { handle = await files.open(path, 'wx', 0o600); } catch (error) {
    if (error?.code === 'EEXIST') await busy(context, path);
    throw error;
  }
  try {
    try {
      await handle.writeFile(JSON.stringify({ token }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeIfPresent(files, path).catch(() => {});
    throw error;
  }
  context.lock = { path, token };
  await syncDirectory(files, output, context.platform);
}

export async function releaseLock(context) {
  if (!context.lock) return;
  const { path, token } = context.lock;
  context.lock = null;
  try {
    const holder = JSON.parse(await readBounded(context.files, path, 1024));
    if (holder.token === token) await removeIfPresent(context.files, path);
  } catch { /* nothing more to release */ }
}

// ---- Staging.

const stagingName = (exportId) => `.stillroom-export-${exportId}.partial`;
const finalName = (exportId) => `stillroom-${exportId}`;
const partTemp = (index) => `part-${index}.tmp`;
const partLimit = (index) => index === 0 ? BACKUP_LIMITS.metadataPartBytes : BACKUP_LIMITS.encryptedPartBytes;
const ownerHash = (ownerId) => createHash('sha256').update(`stillroom-export-owner:${ownerId}`).digest('hex');
const fileHash = (text) => createHash('sha256').update(text).digest('hex');

async function findStaging(context) {
  const found = [];
  for (const name of await context.files.readdir(context.output)) {
    const match = stagingPattern.exec(name);
    if (!match) continue;
    const info = await context.files.lstat(join(context.output, name));
    if (!info.isDirectory() || info.isSymbolicLink()) refuse('conflict');
    found.push(match[1]);
  }
  if (found.length > 1) refuse('conflict');
  return found[0] ?? null;
}

// Lists an unfinished backup; anything that isn't one of its own files, or is a link, stops the run untouched.
async function readLayout(context, exportId) {
  const { files } = context;
  const staging = join(context.output, stagingName(exportId));
  const layout = { staging, parts: new Map(), temporaries: [], state: false, partsFolder: false };
  const partPattern = new RegExp(`^stillroom-${exportId}-(0|[1-9][0-9]{0,2})\\.json\\.enc$`);
  for (const name of await files.readdir(staging)) {
    const info = await files.lstat(join(staging, name));
    if (info.isSymbolicLink()) refuse('conflict', stagingName(exportId));
    if (name === 'parts' && info.isDirectory()) { layout.partsFolder = true; continue; }
    if (!info.isFile()) refuse('conflict', stagingName(exportId));
    if (name === 'state.json') layout.state = true;
    else if (name === 'state.json.tmp' || /^part-(0|[1-9][0-9]{0,2})\.tmp$/.test(name)) layout.temporaries.push(name);
    else refuse('conflict', stagingName(exportId));
  }
  if (layout.partsFolder) {
    for (const name of await files.readdir(join(staging, 'parts'))) {
      const match = partPattern.exec(name);
      const path = join(staging, 'parts', name);
      const info = await files.lstat(path);
      if (!match || !info.isFile() || info.isSymbolicLink()) refuse('conflict', stagingName(exportId));
      const index = Number(match[1]);
      if (index >= BACKUP_LIMITS.parts || info.size > partLimit(index)) refuse('conflict', stagingName(exportId));
      layout.parts.set(index, path);
    }
  }
  return layout;
}

const stateKeys = ['v', 'exportId', 'ownerSha256', 'manifestSha256', 'partCount', 'startedAt', 'parts'];
function parseState(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== stateKeys.length
    || !stateKeys.every(key => Object.hasOwn(value, key)) || value.v !== 1) return null;
  return value;
}

function checkStamp(stamp, now, staging) {
  const time = typeof stamp === 'string' && stamp.length <= 40 ? Date.parse(stamp) : Number.NaN;
  if (!Number.isFinite(time) || time > now + CLOCK_SKEW_MS) refuse('conflict', staging);
  if (now - time > RESUME_WINDOW_MS) refuse('stale', staging);
}

async function writeState(context, run) {
  const state = { v: 1, exportId: run.prepared.exportId, ownerSha256: ownerHash(run.prepared.ownerId), manifestSha256: run.prepared.manifestSha256,
    partCount: run.prepared.partCount, startedAt: run.startedAt,
    parts: Object.fromEntries([...run.recorded].sort(([a], [b]) => a - b).map(([index, entry]) => [String(index), entry])) };
  await writeDurable(context, join(run.staging, 'state.json.tmp'), join(run.staging, 'state.json'), JSON.stringify(state));
}

const decryptOrRefuse = async (text, passphrase, staging) => {
  try { return await decryptPart(text, passphrase); } catch (error) {
    if (error instanceof BackupFormatError && error.problem === 'passphrase') refuse('passphrase', staging);
    refuse('conflict', staging);
  }
};

// Authenticates a photo part against the snapshot: identity, order and every photo's bytes.
async function checkPhotoPart(prepared, index, text, passphrase, staging) {
  const part = await decryptOrRefuse(text, passphrase, staging);
  const expected = prepared.plan[index - 1];
  if (part.exportId !== prepared.exportId || part.partIndex !== index || part.partCount !== prepared.partCount
    || part.manifestSha256 !== prepared.manifestSha256 || Object.hasOwn(part, 'manifest') || part.files.length !== expected.length) refuse('conflict', staging);
  for (let position = 0; position < expected.length; position++) {
    const file = part.files[position], ref = expected[position];
    if (!file || file.imageId !== ref.imageId || file.variant !== ref.variant || file.sha256 !== ref.sha256 || file.byteLength !== ref.byteLength
      || file.mime !== 'image/jpeg') refuse('conflict', staging);
    let bytes;
    try { bytes = fromBase64(file.base64, ref.byteLength); } catch { refuse('conflict', staging); }
    if (bytes.length !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) refuse('conflict', staging);
  }
}

async function verifyFolder(folder, exportId, partCount, passphrase, ownerId, context) {
  let summary;
  try {
    const listing = await listParts(folder);
    if (listing.exportId !== exportId || (partCount !== undefined && listing.count !== partCount)) refuse('conflict');
    summary = await verifyBackup(partSource(listing), passphrase, context.checkJpeg);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    if (error instanceof BackupFormatError) refuse(error.problem === 'passphrase' ? 'passphrase' : 'conflict');
    throw error;
  }
  if (summary.metadata.owner_id !== ownerId || summary.exportId !== exportId) refuse('conflict');
  return summary;
}

async function removeStaging(context, layout) {
  const { files } = context;
  for (const name of [...layout.temporaries, ...(layout.state ? ['state.json'] : [])]) await removeIfPresent(files, join(layout.staging, name));
  await files.rmdir(layout.staging);
  await syncDirectory(files, context.output, context.platform);
}

// Resumes the one unfinished backup. Its snapshot comes only from its own encrypted part 0, checked against the signed-in
// owner, the file names and the state; metadata and attributions are never collected again for an export ID.
async function resume(context, exportId, ownerId, passphrase) {
  const { files } = context;
  const label = stagingName(exportId);
  const layout = await readLayout(context, exportId);
  const final = join(context.output, finalName(exportId));
  const finalInfo = await present(files, final);
  if (finalInfo) {
    // Crashed after the verified parts were moved into place: check the finished backup again, then tidy up.
    if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink() || layout.partsFolder) refuse('conflict', label);
    const summary = await verifyFolder(final, exportId, undefined, passphrase, ownerId, context);
    context.staging = null;
    await removeStaging(context, layout);
    return { done: summary };
  }
  if (!layout.parts.has(0)) refuse('unresumable', label);
  const head = await decryptOrRefuse(await readBounded(files, layout.parts.get(0), BACKUP_LIMITS.metadataPartBytes), passphrase, label);
  if (head.partIndex !== 0 || !Object.hasOwn(head, 'manifest') || head.files.length || head.exportId !== exportId) refuse('conflict', label);
  const metadata = head.manifest;
  try { assertMetadata(metadata); } catch { refuse('conflict', label); }
  if (metadata.export_id !== exportId) refuse('conflict', label);
  if (metadata.owner_id !== ownerId) refuse('conflict', label);
  let digest, prepared;
  try { digest = await metadataDigest(metadata); prepared = fromMetadata(metadata, digest); } catch { refuse('conflict', label); }
  if (digest !== head.manifestSha256 || prepared.partCount !== head.partCount) refuse('conflict', label);
  for (const index of layout.parts.keys()) if (index >= prepared.partCount) refuse('conflict', label);
  let startedAt = metadata.created_at;
  if (layout.state) {
    const state = parseState(await readBounded(files, join(layout.staging, 'state.json'), 64 * 1024));
    if (state) {
      if (state.exportId !== exportId || state.ownerSha256 !== ownerHash(ownerId) || state.manifestSha256 !== digest
        || state.partCount !== prepared.partCount) refuse('conflict', label);
      startedAt = state.startedAt;
    }
  }
  const now = context.now();
  checkStamp(startedAt, now, label);
  checkStamp(metadata.created_at, now, label);
  if (!layout.partsFolder) refuse('unresumable', label);
  for (const name of layout.temporaries) await removeIfPresent(files, join(layout.staging, name));
  const recorded = new Map();
  const head0 = await readBounded(files, layout.parts.get(0), BACKUP_LIMITS.metadataPartBytes);
  recorded.set(0, { bytes: Buffer.byteLength(head0), sha256: fileHash(head0) });
  for (const [index, path] of [...layout.parts].sort(([a], [b]) => a - b)) {
    if (index === 0) continue;
    const text = await readBounded(files, path, BACKUP_LIMITS.encryptedPartBytes);
    await checkPhotoPart(prepared, index, text, passphrase, label);
    recorded.set(index, { bytes: Buffer.byteLength(text), sha256: fileHash(text) });
  }
  const run = { prepared, staging: layout.staging, startedAt, recorded, resumed: true };
  await writeState(context, run);
  return { run };
}

async function begin(context, ownerId, passphrase) {
  const { files } = context;
  const exportId = context.newId();
  const prepared = await collectSnapshot(snapshotSource(context), ownerId, exportId, context.signal);
  const text = JSON.stringify(await assemblePart(prepared, 0, async () => refuse('invalid'), passphrase));
  if (Buffer.byteLength(text) > BACKUP_LIMITS.metadataPartBytes) refuse('tooLarge');
  const staging = join(context.output, stagingName(exportId));
  if (await present(files, staging) || await present(files, join(context.output, finalName(exportId)))) refuse('conflict');
  context.staging = stagingName(exportId);
  await files.mkdir(staging);
  await files.mkdir(join(staging, 'parts'));
  await syncDirectory(files, staging, context.platform);
  await syncDirectory(files, context.output, context.platform);
  await writeDurable(context, join(staging, partTemp(0)), join(staging, 'parts', partFileName(exportId, 0)), text);
  const run = { prepared, staging, startedAt: new Date(context.now()).toISOString(), recorded: new Map([[0, { bytes: Buffer.byteLength(text), sha256: fileHash(text) }]]) };
  await writeState(context, run);
  return run;
}

async function complete(context, run, passphrase) {
  const { files } = context;
  const { prepared } = run;
  const label = stagingName(prepared.exportId);
  const fetchFile = fileFetcher(context);
  for (let index = 1; index < prepared.partCount; index++) {
    if (run.recorded.has(index)) continue;
    if (context.signal.aborted) refuse('cancelled', label);
    const text = JSON.stringify(await assemblePart(prepared, index, fetchFile, passphrase));
    if (Buffer.byteLength(text) > BACKUP_LIMITS.encryptedPartBytes) refuse('tooLarge', label);
    const target = join(run.staging, 'parts', partFileName(prepared.exportId, index));
    if (await present(files, target)) refuse('conflict', label);
    await writeDurable(context, join(run.staging, partTemp(index)), target, text);
    run.recorded.set(index, { bytes: Buffer.byteLength(text), sha256: fileHash(text) });
    await writeState(context, run);
    context.stderr.write(`Part ${index + 1} of ${prepared.partCount} saved.\n`);
  }
  const summary = await verifyFolder(join(run.staging, 'parts'), prepared.exportId, prepared.partCount, passphrase, prepared.ownerId, context);
  if (summary.manifestSha256 !== prepared.manifestSha256) refuse('conflict', label);
  const final = join(context.output, finalName(prepared.exportId));
  if (await present(files, final)) refuse('conflict', label);
  await files.rename(join(run.staging, 'parts'), final);
  await syncDirectory(files, context.output, context.platform);
  context.staging = null;
  await removeStaging(context, await readLayout(context, prepared.exportId));
  return summary;
}

function classify(error) {
  if (error instanceof ExportError) return error;
  if (error instanceof BackupFormatError) {
    return new ExportError({ changed: 'changed', tooLarge: 'tooLarge', passphrase: 'passphrase' }[error.problem] ?? 'invalid');
  }
  if (error instanceof DOMException && error.name === 'AbortError') return new ExportError('cancelled');
  if (error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) return new ExportError('io');
  return new ExportError('invalid');
}

// Runs one export. All effects come through `deps`, so tests can replace the network, the disk and the clock.
export async function runExport(deps) {
  const { argv, env, stdout, stderr } = deps;
  const context = {
    files: deps.files ?? nodeFiles, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? Date.now, platform: deps.platform ?? process.platform,
    newId: deps.newId ?? randomUUID, checkJpeg: deps.checkJpeg ?? checkJpeg, signal: deps.signal ?? new AbortController().signal,
    stderr, guard: { owner: null, refused: false, signal: deps.signal }, client: null, lock: null, staging: null,
  };
  let secrets = null;
  try {
    const { output, local } = parseArguments(argv);
    if (forbiddenEnvironment(env)) refuse('environment');
    context.origin = resolveEndpoint(env, local);
    context.key = publishableKey(env);
    context.output = output;
    const info = await present(context.files, output);
    if (!info) await fsp.mkdir(output, { recursive: true, mode: 0o700 });
    else if (!info.isDirectory()) refuse('output');
    await acquireLock(context);
    const pending = await findStaging(context);
    secrets = await readSecrets(deps, pending === null);
    const { passphrase } = secrets;
    const ownerId = await signIn(context, secrets);
    // Strings can't be zeroized; drop every reference to the sign-in secrets as soon as they have been used.
    secrets.email = secrets.password = secrets.passphrase = '';
    let summary;
    if (pending !== null) {
      context.staging = stagingName(pending);
      stderr.write('Continuing the unfinished backup.\n');
      const resumed = await resume(context, pending, ownerId, passphrase);
      summary = resumed.done ?? await complete(context, resumed.run, passphrase);
    } else {
      summary = await complete(context, await begin(context, ownerId, passphrase), passphrase);
    }
    stdout.write(`Backup complete: ${summary.parts} parts, ${summary.items} items, ${summary.photos} photos, ${summary.fileBytes} photo bytes, `
      + `metadata sha256 ${summary.manifestSha256}. Folder: ${finalName(summary.exportId)}\n`);
    return 0;
  } catch (failure) {
    const error = classify(failure);
    const staging = error.staging ?? context.staging;
    const where = staging ? ` Unfinished folder: ${staging}` : '';
    stderr.write(REFUSALS.has(error.code) ? `Backup refused (${error.code}). ${MESSAGES[error.code]}\n`
      : `Backup incomplete (${error.code}). ${MESSAGES[error.code]}${error.detail ?? ''}${where}\n`);
    return REFUSALS.has(error.code) ? 2 : 1;
  } finally {
    if (secrets) secrets.email = secrets.password = secrets.passphrase = '';
    if (context.client) {
      await context.client.auth.stopAutoRefresh().catch(() => {});
      if (context.guard.owner) await context.client.auth.signOut({ scope: 'local' }).catch(() => {});
      context.client = null;
    }
    await releaseLock(context).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => { if (interrupted) process.exit(130); interrupted = true; controller.abort(); });
  runExport({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal })
    .then((code) => { process.exitCode = code; });
}
