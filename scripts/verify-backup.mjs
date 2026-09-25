#!/usr/bin/env node
// Offline check of a Stillroom backup: `node scripts/verify-backup.mjs --input DIR`.
// The passphrase is read from the terminal (hidden) or from piped standard input, never from arguments or the
// environment. The metadata part is checked first, then one photo part at a time. Only counts, sizes and the metadata hash are printed; nothing in the backup is opened as a path or URL.
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKUP_LIMITS, BackupFormatError, verifyBackup } from '../src/domain/export-format.ts';
import { assertSanitizedJpeg, JPEG_LIMITS, readJpegHeader } from '../src/images/jpeg.ts';
import { readPipedInput, readTerminalLine } from './backup-prompt.mjs';

const partName = /^stillroom-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{1,3})\.json\.enc$/;

function usage(message) {
  process.stderr.write(`${message}\nUsage: node scripts/verify-backup.mjs --input DIR\n`);
  process.exit(2);
}

export function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--input' || !argv[1] || argv[1].startsWith('-')) usage('Expected exactly --input DIR.');
  return resolve(argv[1]);
}

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

async function main() {
  const directory = parseArguments(process.argv.slice(2));
  const listing = await listParts(directory);
  const passphrase = await readPassphrase();
  if (passphrase.length < BACKUP_LIMITS.passphrase) usage('The passphrase is too short.');
  const summary = await verifyBackup(partSource(listing), passphrase, checkJpeg);
  process.stdout.write(`Backup verified: ${summary.parts} parts, ${summary.items} items, ${summary.photos} photos, `
    + `${summary.fileBytes} photo bytes, metadata sha256 ${summary.manifestSha256}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const problem = error instanceof BackupFormatError ? error.problem : 'invalid';
    process.stderr.write(`Backup check failed: ${problem}.\n`);
    process.exit(1);
  });
}
