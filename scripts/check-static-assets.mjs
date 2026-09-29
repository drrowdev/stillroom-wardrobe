#!/usr/bin/env node
// The static tree Cloudflare Pages receives (ADR24): at most 20,000 files, none larger than 25 MiB, and exactly
// the approved model/runtime binaries from src/images/background/model-assets.json, byte for byte. Any other,
// missing or changed .onnx/.wasm file fails. The production build runs this from its own closeBundle step, so a
// Pages build (`npm ci && npm run build`) cannot publish an unchecked tree. The BG2c operator harness never deploys:
// a tree with a `probe/` path or its marker fails here, and its own build is checked by `checkOperatorTree` instead.
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

/** The BG2c operator harness (plan rev4 §11.2a): its only entry, its marker and the one directory it may build into. */
export const HARNESS_ENTRY = 'probe/cleanup-harness.html';
export const HARNESS_MARKER = '__stillroomCleanupHarness';
export const OPERATOR_TREE = path.join(repository, '.probe-dist');
const textFile = /\.(?:js|mjs|html|css|json|webmanifest|txt)$/i;

/** The file count and size limits and the approved binaries, shared by both checks. */
async function inventoryProblems(dist, files, inventory) {
  const problems = [];
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

async function markerFiles(root, files) {
  const found = [];
  for (const file of files) {
    if (textFile.test(file) && (await readFile(path.join(root, file), 'utf8')).includes(HARNESS_MARKER)) found.push(file);
  }
  return found;
}

/** Returns the problems found in `dist`; an empty list is a pass. */
export async function checkStaticTree(dist, inventory) {
  const files = await listTree(dist);
  const problems = await inventoryProblems(dist, files, inventory);
  for (const file of files) if (file === 'probe' || file.startsWith('probe/')) problems.push(`operator harness file ${file}`);
  for (const file of await markerFiles(dist, files)) problems.push(`operator harness marker in ${file}`);
  return problems;
}

/**
 * The operator-probe build only (plan rev4 §11.2a). It passes nothing but `<repo>/.probe-dist`, so it can never
 * validate `dist` or a deployment. The same inventory checks as `checkStaticTree`, then a closed allowlist: the
 * harness entry, hashed `assets/*.js|css` chunks (the segmentation worker is one), the approved `models/` binaries and
 * `_headers`. No service worker, precache manifest, app page or web manifest; the marker in exactly one JS chunk.
 */
export async function checkOperatorTree(tree, inventory) {
  if (path.resolve(tree) !== OPERATOR_TREE) return [`operator tree must be ${OPERATOR_TREE}`];
  const files = await listTree(tree);
  const problems = await inventoryProblems(tree, files, inventory);
  const models = new Set(inventory.map((file) => file.path.slice(1)));
  if (!files.includes(HARNESS_ENTRY)) problems.push(`missing ${HARNESS_ENTRY}`);
  for (const file of files) {
    if (file === HARNESS_ENTRY || file === '_headers' || models.has(file) || /^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(file)) continue;
    problems.push(`unexpected operator file ${file}`);
  }
  const marked = await markerFiles(tree, files);
  const chunks = marked.filter((file) => file.endsWith('.js'));
  if (chunks.length !== 1 || marked.length !== 1) problems.push(`harness marker in ${marked.length ? marked.join(', ') : 'no file'}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? 'dist');
  const problems = await checkStaticTree(dist, await readInventory());
  for (const problem of problems) console.error(`STATIC ASSETS: ${problem}`);
  if (problems.length) process.exit(1);
  console.log('Static assets: pass');
}
