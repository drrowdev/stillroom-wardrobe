#!/usr/bin/env node
// Offline check of a Stillroom backup: `node scripts/verify-backup.mjs --input DIR [--decode]`.
// The passphrase is read from the terminal (hidden) or from piped standard input, never from arguments or the
// environment. The metadata part is checked first, then one photo part at a time. Only counts, sizes and the metadata hash are printed; nothing in the backup is opened as a path or URL.
// Three levels, reported separately:
//   1. integrity and structure (decides the exit code): every part, hash and length, and the structure Restore checks
//      before any decoder starts (the full structure of each main photo; each thumbnail a JPEG within the thumbnail limits);
//   2. which photos Restore can keep byte for byte and which it will encode again, subject to a full Check;
//   3. with --decode only: every photo decoded and planned in the locked Playwright Chromium, the way Restore does.
//      A failure, or Chromium not being available, exits nonzero.
// Passing does not mean a restore will succeed: Check still compares the backup with the account.
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKUP_LIMITS, BackupFormatError, verifyBackup } from '../src/domain/export-format.ts';
import { assertSanitizedJpeg, JPEG_LIMITS, readJpegHeader } from '../src/images/jpeg.ts';
import { checkRestoreJpeg } from '../src/images/restore-jpeg.ts';
import { readPipedInput, readTerminalLine } from './backup-prompt.mjs';

const partName = /^stillroom-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{1,3})\.json\.enc$/;

function usage(message) {
  process.stderr.write(`${message}\nUsage: node scripts/verify-backup.mjs --input DIR [--decode]\n`);
  process.exit(2);
}

export function parseArguments(argv) {
  const decode = argv.length === 3 && argv[2] === '--decode';
  if ((argv.length !== 2 && !decode) || argv[0] !== '--input' || !argv[1] || argv[1].startsWith('-')) usage('Expected --input DIR, optionally followed by --decode.');
  return { directory: resolve(argv[1]), decode };
}

// The export's own check of the files it writes (used by scripts/export-own.mjs). It is stricter than Restore needs.
export function checkJpeg(bytes, variant, width, height) {
  const header = readJpegHeader(bytes);
  if (variant === 'main') {
    if (bytes.length > JPEG_LIMITS.mainBytes || header.width !== width || header.height !== height) throw new BackupFormatError('invalid');
  } else if (bytes.length > JPEG_LIMITS.thumbBytes || Math.max(header.width, header.height) > JPEG_LIMITS.thumbSide) {
    throw new BackupFormatError('invalid');
  }
  if (header.orientation !== 1) throw new BackupFormatError('invalid');
  assertSanitizedJpeg(bytes, header.width, header.height);
}

/**
 * Restore's own checks while reading (src/images/restore-jpeg.ts `checkRestoreJpeg`), counting which main photos Restore
 * can keep byte for byte (`kept`) and which it will encode again (`encoded`).
 */
export function restoreReadiness() {
  const tally = { kept: 0, encoded: 0 };
  const check = (bytes, variant, width, height) => {
    let verdict;
    try { verdict = checkRestoreJpeg(bytes, variant, width, height); } catch { throw new BackupFormatError('invalid'); }
    if (variant === 'main') tally[verdict.kind === 'preserve' ? 'kept' : 'encoded']++;
  };
  return { check, tally };
}

// Level 3: every photo decoded and planned the way Restore does, in the locked Playwright Chromium.
export async function decodedReadiness(listing, passphrase) {
  const { registerSourceLoader } = await import('./src-loader.mjs');
  const { startImageWorker } = await import('./restore-image-client.mjs');
  registerSourceLoader();
  const { preflightBackup } = await import('../src/data/restore.ts');
  let worker;
  try { worker = await startImageWorker(); } catch (error) { return { ok: false, problem: error?.code === 'missing' ? 'chromium' : error?.code === 'sandbox' ? 'sandbox' : 'images' }; }
  try {
    const source = partSource(listing);
    const files = [...listing.paths.entries()].sort(([a], [b]) => a - b)
      .map(([index, part]) => ({ name: part.path.split(/[\\/]/).pop(), size: part.size, text: () => source.read(index) }));
    const { photos } = await preflightBackup(files, passphrase, new AbortController().signal, worker.deps);
    return { ok: true, photos: photos.size };
  } catch {
    return { ok: false, problem: worker.failure() ? 'images' : 'invalid' };
  } finally { await worker.close(); }
}

// Lists the parts by name and size only; nothing is read until every name, type, per-file and total limit passes.
export async function listParts(directory, limits = BACKUP_LIMITS) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupFormatError('invalid');
  const names = await readdir(directory);
  if (names.length < 1 || names.length > limits.parts) throw new BackupFormatError('incomplete');
  const paths = new Map();
  let exportId;
  let total = 0;
  for (const name of names) {
    const match = partName.exec(name);
    if (!match || (exportId !== undefined && match[1] !== exportId)) throw new BackupFormatError('invalid');
    exportId = match[1];
    const index = Number(match[2]);
    if (String(index) !== match[2] || paths.has(index)) throw new BackupFormatError('invalid');
    const path = join(directory, name);
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new BackupFormatError('invalid');
    const limit = index === 0 ? limits.metadataPartBytes : limits.encryptedPartBytes;
    if (file.size > limit) throw new BackupFormatError('tooLarge');
    total += file.size;
    if (total > limits.totalEncryptedBytes) throw new BackupFormatError('tooLarge');
    paths.set(index, { path, size: file.size, limit });
  }
  for (let index = 0; index < names.length; index++) if (!paths.has(index)) throw new BackupFormatError('incomplete');
  return { exportId, count: names.length, paths };
}

// Reads one part, refusing a file that grew past its limit after it was listed.
async function readBounded({ path, limit }) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > limit) throw new BackupFormatError('tooLarge');
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    if (bytesRead !== size || (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) throw new BackupFormatError('invalid');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    if (error instanceof BackupFormatError) throw error;
    throw new BackupFormatError('invalid');
  } finally { await handle.close(); }
}

export function partSource(listing) {
  return { count: listing.count, exportId: listing.exportId, read: (index) => readBounded(listing.paths.get(index)) };
}
async function readPassphrase() {
  if (!process.stdin.isTTY) {
    let buffer;
    try { buffer = await readPipedInput(process.stdin, 4096); } catch { usage('Passphrase input is too long.'); }
    return buffer.toString('utf8').replace(/\r?\n$/, '');
  }
  return readTerminalLine({ input: process.stdin, output: process.stderr, prompt: 'Backup passphrase: ', hidden: true, limit: 4096, overflow: 'ignore' });
}

const DECODE_PROBLEMS = {
  chromium: 'the Playwright Chromium isn\'t installed (run `npx playwright install chromium` in the repository)',
  sandbox: 'Chromium couldn\'t start its sandbox on this system (see docs/phase-6-result.md, Linux: Chromium sandbox)',
  images: 'Chromium didn\'t start or stopped',
  invalid: 'a photo failed to decode or its re-encoded result failed its checks',
};

async function main() {
  const { directory, decode } = parseArguments(process.argv.slice(2));
  const listing = await listParts(directory);
  const passphrase = await readPassphrase();
  if (passphrase.length < BACKUP_LIMITS.passphrase) usage('The passphrase is too short.');
  const readiness = restoreReadiness();
  const summary = await verifyBackup(partSource(listing), passphrase, readiness.check);
  process.stdout.write(`Backup verified: ${summary.parts} parts, ${summary.items} items, ${summary.photos} photos, `
    + `${summary.fileBytes} photo bytes, metadata sha256 ${summary.manifestSha256}.\n`);
  process.stdout.write(`Restore can keep ${readiness.tally.kept} photos as they are and will encode ${readiness.tally.encoded} again, `
    + 'subject to a full Check against your account.\n');
  if (!decode) {
    process.stdout.write('Decoded check: not checked. Add --decode to decode every photo the way Restore does.\n');
    return;
  }
  const decoded = await decodedReadiness(listing, passphrase);
  if (!decoded.ok) {
    process.stderr.write(`Decoded check failed: ${DECODE_PROBLEMS[decoded.problem]}.\n`);
    process.exit(1);
  }
  process.stdout.write(`Decoded check: all ${decoded.photos} photos decoded and planned the way Restore does. `
    + 'A restore still depends on a full Check against your account.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const problem = error instanceof BackupFormatError ? error.problem : 'invalid';
    process.stderr.write(`Backup check failed: ${problem}.\n`);
    process.exit(1);
  });
}
