#!/usr/bin/env node
// Offline check of a Stillroom backup: `node scripts/verify-backup.mjs --input DIR`.
// The passphrase is read from the terminal (hidden) or from piped standard input, never from arguments or the
// environment. Only counts, sizes and the metadata hash are printed; nothing in the backup is opened as a path or URL.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKUP_LIMITS, BackupFormatError, verifyParts } from '../src/domain/export-format.ts';
import { assertSanitizedJpeg, JPEG_LIMITS, readJpegHeader } from '../src/images/jpeg.ts';

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

export async function readParts(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupFormatError('invalid');
  const names = (await readdir(directory)).sort();
  if (names.length < 1 || names.length > BACKUP_LIMITS.parts) throw new BackupFormatError('incomplete');
  let total = 0;
  const texts = [];
  for (const name of names) {
    if (!partName.test(name)) throw new BackupFormatError('invalid');
    const path = join(directory, name);
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > BACKUP_LIMITS.encryptedPartBytes) throw new BackupFormatError('tooLarge');
    total += file.size;
    if (total > BACKUP_LIMITS.parts * BACKUP_LIMITS.encryptedPartBytes) throw new BackupFormatError('tooLarge');
    texts.push(await readFile(path, 'utf8'));
  }
  return texts;
}

async function readPassphrase() {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      if (size > 4096) usage('Passphrase input is too long.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write('Backup passphrase: ');
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((done, failed) => {
    let value = '';
    const finish = (error) => {
      input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stderr.write('\n');
      if (error) failed(error); else done(value);
    };
    const onData = (text) => {
      for (const character of text) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (value.length < 4096) value += character;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  const directory = parseArguments(process.argv.slice(2));
  const texts = await readParts(directory);
  const passphrase = await readPassphrase();
  if (passphrase.length < BACKUP_LIMITS.passphrase) usage('The passphrase is too short.');
  const summary = await verifyParts(texts, passphrase, checkJpeg);
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
