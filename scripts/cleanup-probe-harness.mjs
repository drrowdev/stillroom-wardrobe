#!/usr/bin/env node
// BG2c operator probe harness driver (plan rev4 §11.2, §11.2a). Operator-only: the coordinator runs it on the
// non-personal probe samples; it is never part of CI, the app build or a deployment. It builds the harness itself
// with `vite build --mode operator-probe` into the ignored `<repo>/.probe-dist`, serves only that directory on
// 127.0.0.1 with the existing test host, and drives Chromium with every non-loopback request blocked and service
// workers blocked. It makes no provider call: dispatch stays with `scripts/enhancement-probe.mjs`.
//
//   ALLOW_CLEANUP_HARNESS=1 node scripts/cleanup-probe-harness.mjs prepare <samples-dir> <prepared-dir>
//   ALLOW_CLEANUP_HARNESS=1 node scripts/cleanup-probe-harness.mjs measure <prepared-dir> <calls-dir> <measured-dir>
//   ALLOW_CLEANUP_HARNESS=1 node scripts/cleanup-probe-harness.mjs remeasure <probe-root> <new-out-dir>
//
// `prepare` reads `<samples-dir>/crops.json`: exactly 6 entries `{ file, role, turns, crop }` (5 visual, then 1
// disconnect; crop normalised) and writes, per sample, H0 (.jpg), R (.bin) and its binding (.json), plus the
// `samples.json` the probe CLI reads. `measure` re-verifies each binding against this build and runs the exact
// `cleanupCheck` on H0, R and the returned H2. Output is JSON and binary files only; the console gets codes and counts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath as fsRealpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOperatorTree, HARNESS_ENTRY, OPERATOR_TREE, readInventory } from './check-static-assets.mjs';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HARNESS_CALLS = 6;
export const REFERENCE_BYTES = 256 * 320;
const SAMPLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.(?:jpe?g|png)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export class HarnessRefusal extends Error {
  constructor(code) { super(code); this.name = 'HarnessRefusal'; this.code = code; }
}
const refuse = (code) => { throw new HarnessRefusal(code); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** Output folders never sit in a build tree, the repository's source or each other. */
export function checkFolders(folders) {
  const resolved = folders.map((folder) => path.resolve(folder));
  for (const folder of resolved) {
    if ([path.join(repository, 'dist'), OPERATOR_TREE].some((tree) => inside(tree, folder) || inside(folder, tree))) refuse('folder');
    if (inside(repository, folder)) refuse('folder');
  }
  if (new Set(resolved).size !== resolved.length) refuse('folder');
  return resolved;
}

const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** `crops.json`: exactly 5 visual samples then 1 disconnect, each with a valid normalised crop and quarter turns. */
export function parseCrops(value) {
  if (!Array.isArray(value) || value.length !== HARNESS_CALLS) refuse('crops');
  return value.map((entry, index) => {
    if (!record(entry) || Object.keys(entry).sort().join() !== 'crop,file,role,turns' || !SAMPLE.test(entry.file ?? '')
      || entry.role !== (index < HARNESS_CALLS - 1 ? 'visual' : 'disconnect') || ![0, 1, 2, 3].includes(entry.turns)) refuse('crops');
    const { crop } = entry;
    if (!record(crop) || Object.keys(crop).sort().join() !== 'height,width,x,y' || ![crop.x, crop.y, crop.width, crop.height].every(unit)
      || crop.width < 0.05 || crop.height < 0.05 || crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) refuse('crops');
    return { file: entry.file, role: entry.role, edit: { turns: entry.turns, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } } };
  });
}

/** The source commit the harness is built from: a clean checkout only, so the build is exactly that commit. */
export function sourceCommit(run = (args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' })) {
  const head = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=no']);
  if (head.status !== 0 || status.status !== 0) refuse('git');
  const commit = head.stdout.trim();
  if (!COMMIT.test(commit)) refuse('git');
  if (status.stdout.trim() !== '') refuse('dirty');
  return commit;
}

/** Only this loopback origin; everything else is aborted and counted. */
export function loopbackOnly(origin) {
  const allowed = new URL(origin);
  return (url) => {
    try {
      const target = new URL(url);
      return target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.port === allowed.port;
    } catch { return false; }
  };
}

/** The binding the probe CLI verifies (`scripts/enhancement-probe.mjs` `verifyBinding`). */
export function bindingFor({ commit, modelSha256, sampleSha256, edit, prepared, h0, reference }) {
  const cleanup = prepared.cleanup;
  if (!cleanup) refuse('unframed');
  if (cleanup.photoInput !== true || cleanup.sha256 !== sha256(h0) || cleanup.bytes !== h0.byteLength) refuse('h0');
  if (cleanup.width * 5 !== cleanup.height * 4) refuse('h0');
  if (reference.byteLength !== REFERENCE_BYTES || cleanup.referenceSha256 !== sha256(reference) || reference.some((value) => value > 1)) refuse('reference');
  return {
    version: 1, commit, modelSha256, sampleSha256, crop: edit, frame: cleanup.frame,
    h0: { sha256: cleanup.sha256, bytes: cleanup.bytes, width: cleanup.width, height: cleanup.height },
    reference: { sha256: cleanup.referenceSha256, bytes: REFERENCE_BYTES },
    ambiguous: cleanup.ambiguous === true,
  };
}

/** Re-verifies a prepared binding against this build and its files before `measure`. */
export function verifyPrepared(binding, { commit, modelSha256, h0, reference }) {
  if (!record(binding) || binding.version !== 1 || binding.commit !== commit || binding.modelSha256 !== modelSha256) refuse('binding');
  if (binding.h0?.sha256 !== sha256(h0) || binding.h0?.bytes !== h0.byteLength) refuse('binding');
  if (binding.reference?.sha256 !== sha256(reference) || reference.byteLength !== REFERENCE_BYTES) refuse('binding');
}

async function emptyFolder(folder) {
  let existing = [];
  try { existing = await readdir(folder); } catch { await mkdir(folder, { recursive: true }); }
  if (existing.length !== 0) refuse('output');
}

function buildHarness() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_') && !key.startsWith('STILLROOM_')));
  const result = spawnSync(process.execPath, [path.join(repository, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'operator-probe'], {
    cwd: repository, stdio: ['ignore', 'ignore', 'inherit'], env,
  });
  if (result.status !== 0) refuse('build');
}

/** Builds, checks and serves the harness, then hands a ready page to `work`. Always stops the server and browser. */
export async function withHarness(work, { chromium } = {}) {
  await rm(OPERATOR_TREE, { recursive: true, force: true });
  buildHarness();
  const inventory = await readInventory();
  const problems = await checkOperatorTree(OPERATOR_TREE, inventory);
  if (problems.length) refuse('operatorTree');
  const { startDistServer } = await import('./serve-dist.mjs');
  const server = await startDistServer({ root: OPERATOR_TREE, host: '127.0.0.1', port: 0 });
  const browserType = chromium ?? (await import('@playwright/test')).chromium;
  const browser = await browserType.launch();
  const blocked = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const allowed = loopbackOnly(server.url);
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (allowed(url)) return route.continue();
      blocked.push(new URL(url).origin);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(`${server.url}/${HARNESS_ENTRY}`);
    await page.waitForFunction(() => Boolean(window.__stillroomCleanupHarness), undefined, { timeout: 30_000 });
    const assets = await page.evaluate(() => window.__stillroomCleanupHarness.verifyAssets());
    if (assets.length !== inventory.length || !assets.every((asset) => asset.ok)) refuse('assets');
    const modelSha256 = inventory.find((file) => file.role === 'model').sha256;
    const result = await work({ page, modelSha256, assets });
    const registrations = await page.evaluate(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0);
    return { result, blocked, registrations, requests: server.requests.length };
  } finally {
    await browser.close();
    await server.close();
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'base64'));

async function prepareAll(samplesDir, preparedDir) {
  const [folder, out] = checkFolders([samplesDir, preparedDir]);
  const crops = parseCrops(JSON.parse(await readFile(path.join(folder, 'crops.json'), 'utf8')));
  await emptyFolder(out);
  const commit = sourceCommit();
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { isPhotoInputJpeg } = await import('../src/images/restore-jpeg.ts');
  const report = [];
  const listing = [];
  const run = await withHarness(async ({ page, modelSha256 }) => {
    for (const [index, sample] of crops.entries()) {
      const input = new Uint8Array(await readFile(path.join(folder, sample.file)));
      const type = /\.png$/i.test(sample.file) ? 'image/png' : 'image/jpeg';
      const prepared = await page.evaluate(([data, kind, edit]) => window.__stillroomCleanupHarness.prepare(data, kind, edit), [b64(input), type, sample.edit]);
      if (!prepared.cleanup) { report.push({ sample: index + 1, code: 'UNFRAMED' }); continue; }
      const h0 = bytesOf(prepared.cleanup.h0), reference = bytesOf(prepared.cleanup.reference);
      if (!isPhotoInputJpeg(h0, prepared.cleanup.width, prepared.cleanup.height)) { report.push({ sample: index + 1, code: 'H0_REJECTED' }); continue; }
      const binding = bindingFor({ commit, modelSha256, sampleSha256: sha256(input), edit: sample.edit, prepared, h0, reference });
      const name = `s${index + 1}`;
      await writeFile(path.join(out, `${name}.jpg`), h0, { flag: 'wx' });
      await writeFile(path.join(out, `${name}.bin`), reference, { flag: 'wx' });
      await writeFile(path.join(out, `${name}.json`), `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' });
      listing.push({ file: `${name}.jpg`, sha256: binding.h0.sha256, reference: `${name}.bin`, binding: `${name}.json`, role: sample.role });
      report.push({ sample: index + 1, code: binding.ambiguous ? 'AMBIGUOUS' : 'READY', h0Bytes: binding.h0.bytes });
    }
  });
  // The probe CLI refuses an ambiguous binding; an unframed or rejected sample leaves no samples.json at all.
  if (listing.length === HARNESS_CALLS) await writeFile(path.join(out, 'samples.json'), `${JSON.stringify(listing, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(out, 'prepare-report.json'), `${JSON.stringify({ commit, report, blocked: run.blocked, registrations: run.registrations }, null, 2)}\n`, { flag: 'wx' });
  return { report, blocked: run.blocked.length, registrations: run.registrations, ready: listing.length === HARNESS_CALLS };
}

async function measureAll(preparedDir, callsDir, measuredDir) {
  const [prepared, callsFolder, out] = checkFolders([preparedDir, callsDir, measuredDir]);
  const listing = JSON.parse(await readFile(path.join(prepared, 'samples.json'), 'utf8'));
  if (!Array.isArray(listing) || listing.length !== HARNESS_CALLS) refuse('samples');
  await emptyFolder(out);
  const commit = sourceCommit();
  const metrics = {};
  const pending = [];
  const run = await withHarness(async ({ page, modelSha256 }) => {
    for (const [index, entry] of listing.entries()) {
      if (entry.role !== 'visual') continue;
      let call;
      try { call = JSON.parse(await readFile(path.join(callsFolder, `call-${index + 1}.json`), 'utf8')); } catch { pending.push(`call-${index + 1}`); continue; }
      if (!record(call) || call.code !== 'OK' || call.inputSha256 !== entry.sha256) { pending.push(`call-${index + 1}`); continue; }
      const h0 = new Uint8Array(await readFile(path.join(prepared, entry.file)));
      const reference = new Uint8Array(await readFile(path.join(prepared, entry.reference)));
      const binding = JSON.parse(await readFile(path.join(prepared, entry.binding), 'utf8'));
      verifyPrepared(binding, { commit, modelSha256, h0, reference });
      const h2 = new Uint8Array(await readFile(path.join(callsFolder, `call-${index + 1}.jpg`)));
      if (sha256(h2) !== call.outputSha256) { pending.push(`call-${index + 1}`); continue; }
      const measured = await page.evaluate(([a, r, b]) => window.__stillroomCleanupHarness.measure(a, r, b), [b64(h0), b64(reference), b64(h2)]);
      const verdict = measured.verdict;
      metrics[call.requestId] = { call: index + 1, reason: verdict.accepted ? 'accepted' : verdict.reason, metrics: verdict.metrics,
        h0Sha256: measured.h0Sha256, h2Sha256: measured.h2Sha256, referenceSha256: measured.referenceSha256, commit, modelSha256 };
    }
  });
  await writeFile(path.join(out, 'metrics.json'), `${JSON.stringify({ commit, metrics, pending, blocked: run.blocked }, null, 2)}\n`, { flag: 'wx' });
  return { measured: Object.keys(metrics).length, pending, blocked: run.blocked.length };
}

// BG2c-3 `remeasure` (plan rev8 §6): runs the frozen v2 check on exactly the 5 visual results of an existing probe
// run and writes one schema-2 `metrics.json` of numbers and hashes into a new output folder. The probe tree is only
// listed and read: nothing in it is written, renamed, copied or deleted, and the disconnect sample (`s6.*`,
// `call-6.json`) is listed by name and size but never opened.
export const VISUAL_CALLS = HARNESS_CALLS - 1;
const HASH = /^[0-9a-f]{64}$/;
const samplesOf = (count) => Array.from({ length: count }, (_, index) => `s${index + 1}`);
export const PREPARED_FILES = Object.freeze([...samplesOf(HARNESS_CALLS).flatMap((name) => [`${name}.jpg`, `${name}.bin`, `${name}.json`]),
  'samples.json', 'prepare-report.json'].sort());
export const CALL_FILES = Object.freeze([...Array.from({ length: VISUAL_CALLS }, (_, index) => [`call-${index + 1}.jpg`, `call-${index + 1}.json`]).flat(),
  `call-${HARNESS_CALLS}.json`].sort());
export const MEASURED_FILES = Object.freeze(['metrics.json']);
const PROBE_FOLDERS = ['prepared', 'calls', 'measured'];
const LEGACY_KEYS = 'blocked,commit,metrics,pending';
const defaultIo = { realpath: fsRealpath, lstat, readdir, readFile, mkdir, writeFile };

async function exactFolder(io, folder, names) {
  const status = await io.lstat(folder).catch(() => refuse('inventory'));
  if (status.isSymbolicLink() || !status.isDirectory() || await io.realpath(folder) !== folder) refuse('inventory');
  const entries = await io.readdir(folder, { withFileTypes: true });
  const listed = entries.map((entry) => entry.name).sort();
  if (listed.length !== names.length || listed.some((name, index) => name !== names[index])) refuse('inventory');
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) refuse('inventory');
  const sizes = new Map();
  for (const name of names) sizes.set(name, (await io.lstat(path.join(folder, name))).size);
  return sizes;
}

/** Reads one listed regular file, re-checking that its real path is itself (no symlink swapped in after listing). */
async function readListed(io, folder, name) {
  const file = path.join(folder, name);
  const status = await io.lstat(file);
  if (status.isSymbolicLink() || !status.isFile() || await io.realpath(file) !== file) refuse('inventory');
  return new Uint8Array(await io.readFile(file, { flag: 'r' }));
}
const parseJson = (bytes, code) => { try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return refuse(code); } };

/**
 * Validates the known probe inventory and selects the 5 visual entries (§6.1, §6.2). Returns the bytes to measure and
 * the facts the schema-2 record carries. `io` is injectable so tests can observe every read.
 */
export async function planRemeasure(root, outDir, io = defaultIo) {
  const realRoot = await io.realpath(path.resolve(root)).catch(() => refuse('inventory'));
  const [prepared, calls, measured] = PROBE_FOLDERS.map((name) => path.join(realRoot, name));
  const requested = path.resolve(outDir);
  const out = path.join(await io.realpath(path.dirname(requested)).catch(() => refuse('output')), path.basename(requested));
  for (const folder of [prepared, calls, measured, path.join(realRoot, 'samples')]) {
    if (inside(folder, out) || inside(out, folder)) refuse('output');
  }
  checkFolders([out]);
  if (await io.lstat(out).then(() => true, () => false)) refuse('output');
  await exactFolder(io, prepared, PREPARED_FILES);
  await exactFolder(io, calls, CALL_FILES);
  await exactFolder(io, measured, MEASURED_FILES);

  const listing = parseJson(await readListed(io, prepared, 'samples.json'), 'samples');
  if (!Array.isArray(listing) || listing.length !== HARNESS_CALLS) refuse('samples');
  listing.forEach((entry, index) => {
    const name = `s${index + 1}`;
    if (!record(entry) || Object.keys(entry).sort().join() !== 'binding,file,reference,role,sha256' || entry.file !== `${name}.jpg`
      || entry.reference !== `${name}.bin` || entry.binding !== `${name}.json` || !HASH.test(entry.sha256 ?? '')
      || entry.role !== (index < VISUAL_CALLS ? 'visual' : 'disconnect')) refuse('samples');
  });
  const report = parseJson(await readListed(io, prepared, 'prepare-report.json'), 'report');
  if (!record(report) || !COMMIT.test(report.commit ?? '') || !Array.isArray(report.report) || report.report.length !== HARNESS_CALLS
    || report.report.some((item, index) => !record(item) || item.sample !== index + 1 || item.code !== 'READY')) refuse('report');
  const preparedCommit = report.commit;

  const metricsBytes = await readListed(io, measured, 'metrics.json');
  const metricsSha256 = sha256(metricsBytes);
  const legacy = parseJson(metricsBytes, 'legacy');
  // Legacy v1: no schema key, its original keys, and measured at the prepared commit (its original rule).
  if (!record(legacy) || Object.keys(legacy).sort().join() !== LEGACY_KEYS || legacy.commit !== preparedCommit || !record(legacy.metrics)) refuse('legacy');

  let modelSha256 = null;
  const entries = [];
  for (let index = 0; index < VISUAL_CALLS; index++) {
    const name = `s${index + 1}`, call = index + 1;
    const h0 = await readListed(io, prepared, `${name}.jpg`);
    const reference = await readListed(io, prepared, `${name}.bin`);
    const binding = parseJson(await readListed(io, prepared, `${name}.json`), 'binding');
    if (!record(binding) || binding.version !== 1 || binding.commit !== preparedCommit || !HASH.test(binding.modelSha256 ?? '')
      || binding.ambiguous !== false) refuse('binding');
    modelSha256 ??= binding.modelSha256;
    if (binding.modelSha256 !== modelSha256) refuse('model');
    if (binding.h0?.sha256 !== sha256(h0) || binding.h0?.bytes !== h0.byteLength || listing[index].sha256 !== binding.h0.sha256) refuse('h0');
    if (reference.byteLength !== REFERENCE_BYTES || binding.reference?.sha256 !== sha256(reference) || binding.reference?.bytes !== REFERENCE_BYTES) refuse('reference');
    const callRecord = parseJson(await readListed(io, calls, `call-${call}.json`), 'call');
    if (!record(callRecord) || callRecord.role !== 'visual' || callRecord.call !== call || callRecord.code !== 'OK'
      || typeof callRecord.requestId !== 'string' || !callRecord.requestId || callRecord.inputSha256 !== binding.h0.sha256
      || !HASH.test(callRecord.outputSha256 ?? '')) refuse('call');
    const h2 = await readListed(io, calls, `call-${call}.jpg`);
    if (sha256(h2) !== callRecord.outputSha256) refuse('h2');
    const prior = Object.hasOwn(legacy.metrics, callRecord.requestId) ? legacy.metrics[callRecord.requestId] : null;
    if (!record(prior)) refuse('requestId');
    if (prior.call !== call || prior.h0Sha256 !== binding.h0.sha256 || prior.h2Sha256 !== callRecord.outputSha256
      || prior.referenceSha256 !== binding.reference.sha256 || prior.commit !== preparedCommit || typeof prior.reason !== 'string') refuse('legacy');
    if (prior.modelSha256 !== modelSha256) refuse('model');
    entries.push({ call, requestId: callRecord.requestId, h0, reference, h2, h0Sha256: binding.h0.sha256, h2Sha256: callRecord.outputSha256,
      referenceSha256: binding.reference.sha256, priorReason: prior.reason });
  }
  return { preparedCommit, modelSha256, out, metricsFile: path.join(measured, 'metrics.json'), metricsSha256, entries };
}

/** The schema-2 record (§6.3), refusing results that don't match this build, the plan's hashes or each other. */
export function remeasureRecord(plan, { measuredCommit, modelSha256, configSha256, results, blocked }) {
  if (!COMMIT.test(measuredCommit ?? '') || !HASH.test(configSha256 ?? '')) refuse('build');
  if (modelSha256 !== plan.modelSha256) refuse('model');
  if (!Array.isArray(results) || results.length !== plan.entries.length) refuse('results');
  const metrics = {};
  plan.entries.forEach((entry, index) => {
    const result = results[index];
    if (!record(result) || result.checkVersion !== 2 || result.configSha256 !== configSha256 || result.h0Sha256 !== entry.h0Sha256
      || result.h2Sha256 !== entry.h2Sha256 || result.referenceSha256 !== entry.referenceSha256 || !record(result.verdict)) refuse('results');
    const { verdict } = result;
    metrics[entry.requestId] = { call: entry.call, reason: verdict.accepted ? 'accepted' : verdict.reason, metrics: verdict.metrics,
      h0Sha256: entry.h0Sha256, h2Sha256: entry.h2Sha256, referenceSha256: entry.referenceSha256, priorReason: entry.priorReason };
  });
  return { schema: 2, preparedCommit: plan.preparedCommit, measuredCommit, checkVersion: 2, configSha256, modelSha256,
    metrics, blocked: Array.isArray(blocked) ? blocked : [] };
}

/** Confirms the legacy metrics are unchanged, then writes the record into the new output folder with `wx`. */
export async function writeRemeasure(plan, value, io = defaultIo) {
  if (sha256(new Uint8Array(await io.readFile(plan.metricsFile, { flag: 'r' }))) !== plan.metricsSha256) refuse('changed');
  await io.mkdir(plan.out).catch(() => refuse('output'));
  await io.writeFile(path.join(plan.out, 'metrics.json'), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function remeasureAll(root, outDir) {
  const plan = await planRemeasure(root, outDir);
  const measuredCommit = sourceCommit();
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { CLEANUP_V2_SHA256 } = await import('../src/images/cleanup-calibration.ts');
  // Route interception (every request passes `context.route`) also disables the HTTP cache; the context is fresh and
  // non-persistent, with no screenshots, traces, video, HAR or downloads.
  const run = await withHarness(async ({ page, modelSha256 }) => {
    const results = [];
    for (const entry of plan.entries) {
      results.push(await page.evaluate(([a, r, b]) => window.__stillroomCleanupHarness.measure(a, r, b), [b64(entry.h0), b64(entry.reference), b64(entry.h2)]));
    }
    return { modelSha256, results };
  });
  const value = remeasureRecord(plan, { measuredCommit, modelSha256: run.result.modelSha256, configSha256: CLEANUP_V2_SHA256,
    results: run.result.results, blocked: run.blocked });
  await writeRemeasure(plan, value);
  return { measured: plan.entries.length, blocked: run.blocked.length, registrations: run.registrations,
    reasons: Object.values(value.metrics).map((entry) => entry.reason) };
}

async function main() {
  const [mode, ...folders] = process.argv.slice(2);
  try {
    if (process.env.ALLOW_CLEANUP_HARNESS !== '1') refuse('notAllowed');
    let summary;
    if (mode === 'prepare' && folders.length === 2) summary = await prepareAll(folders[0], folders[1]);
    else if (mode === 'measure' && folders.length === 3) summary = await measureAll(folders[0], folders[1], folders[2]);
    else if (mode === 'remeasure' && folders.length === 2) summary = await remeasureAll(folders[0], folders[1]);
    else refuse('usage');
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`Harness refused (${error instanceof HarnessRefusal ? error.code : 'unexpected'}). Nothing was dispatched.\n`);
    process.exitCode = 2;
  } finally {
    await rm(OPERATOR_TREE, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
