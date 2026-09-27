#!/usr/bin/env node
// The static tree Cloudflare Pages receives (ADR24): at most 20,000 files, none larger than 25 MiB, and exactly
// the approved model/runtime binaries from src/images/background/model-assets.json, byte for byte. Any other,
// missing or changed .onnx/.wasm file fails. The production build runs this from its own closeBundle step, so a
// Pages build (`npm ci && npm run build`) cannot publish an unchecked tree.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pagesLimits = Object.freeze({ files: 20_000, fileBytes: 25 * 1024 * 1024 });
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const inventoryPath = path.join(repository, 'src', 'images', 'background', 'model-assets.json');
const binary = /\.(?:onnx|wasm)$/i;
const sha256Hex = /^[0-9a-f]{64}$/;
const assetPath = /^\/models\/[a-z0-9-]+-[0-9a-f]{8}\.(?:onnx|wasm)$/;

export function parseInventory(value) {
  const fail = (reason) => { throw new Error(`Invalid model asset inventory: ${reason}.`); };
  if (!value || value.version !== 1 || !Array.isArray(value.files) || value.files.length !== 2) fail('shape');
  const roles = new Set();
  for (const file of value.files) {
    if (Object.keys(file).sort().join() !== 'bytes,path,role,sha256,source') fail('keys');
    if (file.role !== 'model' && file.role !== 'runtime' || roles.has(file.role)) fail('roles');
    roles.add(file.role);
    if (!assetPath.test(file.path) || !file.path.includes(`-${file.sha256.slice(0, 8)}.`)) fail(`path ${file.path}`);
    if (!sha256Hex.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > pagesLimits.fileBytes) fail(`entry ${file.path}`);
    if (typeof file.source !== 'string' || path.isAbsolute(file.source) || file.source.includes('..')) fail(`source ${file.path}`);
  }
  return value.files;
}

export async function readInventory(file = inventoryPath) {
  return parseInventory(JSON.parse(await readFile(file, 'utf8')));
}

export async function listTree(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listTree(root, file) : [file];
  }));
  return nested.flat().sort();
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Returns the problems found in `dist`; an empty list is a pass. */
export async function checkStaticTree(dist, inventory) {
  const problems = [];
  const files = await listTree(dist);
  if (files.length > pagesLimits.files) problems.push(`${files.length} files > ${pagesLimits.files}`);
  const expected = new Map(inventory.map((file) => [file.path.slice(1), file]));
  for (const file of files) {
    const size = (await stat(path.join(dist, file))).size;
    if (size > pagesLimits.fileBytes) problems.push(`${file} ${size} B > ${pagesLimits.fileBytes} B`);
    if (!binary.test(file)) continue;
    const entry = expected.get(file);
    if (!entry) { problems.push(`unapproved binary ${file}`); continue; }
    const bytes = await readFile(path.join(dist, file));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) problems.push(`changed binary ${file}`);
  }
  for (const file of expected.keys()) if (!files.includes(file)) problems.push(`missing binary ${file}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? 'dist');
  const problems = await checkStaticTree(dist, await readInventory());
  for (const problem of problems) console.error(`STATIC ASSETS: ${problem}`);
  if (problems.length) process.exit(1);
  console.log('Static assets: pass');
}
