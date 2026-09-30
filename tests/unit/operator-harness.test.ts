import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkOperatorTree, checkStaticTree, HARNESS_ENTRY, HARNESS_MARKER, OPERATOR_TREE, sha256, type InventoryFile,
} from '../../scripts/check-static-assets.mjs';
import {
  bindingFor, CALL_FILES, checkFolders, HarnessRefusal, loopbackOnly, MEASURED_FILES, parseCrops, planRemeasure, PREPARED_FILES, REFERENCE_BYTES,
  remeasureRecord, repository, sourceCommit, verifyPrepared, writeRemeasure, type RemeasureIo, type RemeasurePlan,
} from '../../scripts/cleanup-probe-harness.mjs';

// BG2c operator harness (plan rev4 §11.2, §11.2a): the deploy check refuses it, its own check passes only its fixed
// tree in `<repo>/.probe-dist`, and the driver's pure checks refuse bad inputs before anything runs.
const model = Buffer.from('fictional model');
const runtime = Buffer.from('fictional runtime');
const entry = (role: 'model' | 'runtime', bytes: Buffer, name: string, extension: string): InventoryFile => ({
  role, path: `/models/${name}-${sha256(bytes).slice(0, 8)}.${extension}`, source: `fixture/${name}`, bytes: bytes.length, sha256: sha256(bytes),
});
const inventory = [entry('model', model, 'u2netp', 'onnx'), entry('runtime', runtime, 'ort-wasm', 'wasm')];
const binaries = { [inventory[0]!.path.slice(1)]: model, [inventory[1]!.path.slice(1)]: runtime };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function write(root: string, files: Record<string, Buffer | string>) {
  await rm(root, { recursive: true, force: true });
  roots.push(root);
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  }
  return root;
}
const temporary = async (files: Record<string, Buffer | string>) => write(await mkdtemp(path.join(tmpdir(), 'stillroom-deploy-')), files);
const deploy = () => ({ 'index.html': '<!doctype html>', 'assets/index-abc.js': 'console.log(1)', ...binaries });
const operator = () => ({ [HARNESS_ENTRY]: '<!doctype html>', '_headers': '/*\n', 'assets/harness-abc.js': `window.${HARNESS_MARKER}={}`,
  'assets/segment-worker-abc.js': 'self.onmessage=null', ...binaries });

describe('deploy tree refuses the operator harness', () => {
  it('still passes a clean tree', async () => {
    expect(await checkStaticTree(await temporary(deploy()), inventory)).toEqual([]);
  });

  it('refuses a probe/ path and the harness marker, together or alone', async () => {
    expect(await checkStaticTree(await temporary({ ...deploy(), [HARNESS_ENTRY]: '<!doctype html>', 'assets/harness-abc.js': `x.${HARNESS_MARKER}=1` }), inventory))
      .toEqual([`operator harness file ${HARNESS_ENTRY}`, 'operator harness marker in assets/harness-abc.js']);
    expect(await checkStaticTree(await temporary({ ...deploy(), 'assets/harness-abc.js': `x.${HARNESS_MARKER}=1` }), inventory))
      .toEqual(['operator harness marker in assets/harness-abc.js']);
    expect(await checkStaticTree(await temporary({ ...deploy(), 'probe/other.txt': 'x' }), inventory)).toEqual(['operator harness file probe/other.txt']);
    expect(await checkStaticTree(await temporary({ ...deploy(), 'index.html': `<script>${HARNESS_MARKER}</script>` }), inventory))
      .toEqual(['operator harness marker in index.html']);
  });
});

describe('operator tree check', () => {
  it('passes the fixed synthetic operator tree in .probe-dist only', async () => {
    expect(await checkOperatorTree(await write(OPERATOR_TREE, operator()), inventory)).toEqual([]);
    // The same files anywhere else, including dist/, are never a pass.
    expect(await checkOperatorTree(await temporary(operator()), inventory)).toEqual([`operator tree must be ${OPERATOR_TREE}`]);
    expect(await checkOperatorTree(path.join(repository, 'dist'), inventory)).toEqual([`operator tree must be ${OPERATOR_TREE}`]);
  });

  it.each([
    ['a service worker', { 'service-worker.js': 'self' }, ['unexpected operator file service-worker.js']],
    ['a precache manifest', { 'precache-manifest.json': '{}' }, ['unexpected operator file precache-manifest.json']],
    ['the app page', { 'index.html': '<!doctype html>' }, ['unexpected operator file index.html']],
    ['a web manifest', { 'manifest.webmanifest': '{}' }, ['unexpected operator file manifest.webmanifest']],
    ['another probe file', { 'probe/extra.html': '<!doctype html>' }, ['unexpected operator file probe/extra.html']],
    ['a duplicated marker', { 'assets/copy-abc.js': HARNESS_MARKER }, ['harness marker in assets/copy-abc.js, assets/harness-abc.js']],
    ['an unapproved binary', { 'models/other-00000000.onnx': model }, ['unapproved binary models/other-00000000.onnx', 'unexpected operator file models/other-00000000.onnx']],
    ['a changed model', { [inventory[0]!.path.slice(1)]: 'fictional modex' }, [`changed binary ${inventory[0]!.path.slice(1)}`]],
  ])('refuses %s', async (_name, extra, problems) => {
    expect(await checkOperatorTree(await write(OPERATOR_TREE, { ...operator(), ...extra }), inventory)).toEqual(problems);
  });

  it('refuses a missing entry, marker or runtime', async () => {
    const noEntry: Record<string, Buffer | string> = operator(); delete noEntry[HARNESS_ENTRY];
    expect(await checkOperatorTree(await write(OPERATOR_TREE, noEntry), inventory)).toEqual([`missing ${HARNESS_ENTRY}`]);
    expect(await checkOperatorTree(await write(OPERATOR_TREE, { ...operator(), 'assets/harness-abc.js': 'x' }), inventory))
      .toEqual(['harness marker in no file']);
    const noRuntime: Record<string, Buffer | string> = operator(); delete noRuntime[inventory[1]!.path.slice(1)];
    expect(await checkOperatorTree(await write(OPERATOR_TREE, noRuntime), inventory)).toEqual([`missing binary ${inventory[1]!.path.slice(1)}`]);
  });

  it('is called only from the operator-probe branch of vite.config.ts', async () => {
    const read = (file: string) => readFile(path.join(repository, file), 'utf8');
    const config = await read('vite.config.ts');
    expect(config.match(/checkOperatorTree\(/g)).toHaveLength(1);
    expect(config).toContain('const problems = operator ? await checkOperatorTree(outDir, inventory) : await checkStaticTree(outDir, inventory);');
    for (const file of ['scripts/check-bundle-budget.mjs', 'scripts/serve-dist.mjs', 'scripts/check-deployed-assets.mjs', 'tests/pwa/builds.ts']) {
      expect(await read(file), file).not.toContain('checkOperatorTree');
    }
    expect(await read('.gitignore')).toMatch(/^\.probe-dist\/$/m);
  });

  it('refuses an operator-probe build into any other directory before writing', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'stillroom-operator-'));
    roots.push(outDir);
    const result = spawnSync(process.execPath, [path.join(repository, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'operator-probe',
      '--outDir', outDir], { cwd: repository, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))) });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('The operator-probe build writes only to');
  }, 60_000);
});

describe('harness driver checks', () => {
  const refusal = (code: string) => new HarnessRefusal(code);
  const crops = () => Array.from({ length: 6 }, (_, index) => ({ file: `p${index}.jpg`, role: index < 5 ? 'visual' : 'disconnect', turns: 0,
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }));

  it('parses exactly 5 visual and 1 disconnect sample with valid crops', () => {
    expect(parseCrops(crops())[5]).toEqual({ file: 'p5.jpg', role: 'disconnect', edit: { turns: 0, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } } });
    for (const bad of [crops().slice(0, 5), [...crops(), crops()[0]], crops().map((item, index) => index === 0 ? { ...item, role: 'disconnect' } : item),
      crops().map((item, index) => index === 1 ? { ...item, file: '../p1.jpg' } : item),
      crops().map((item, index) => index === 2 ? { ...item, turns: 4 } : item),
      crops().map((item, index) => index === 3 ? { ...item, crop: { x: 0.5, y: 0, width: 0.6, height: 1 } } : item),
      crops().map((item, index) => index === 4 ? { ...item, crop: { x: 0, y: 0, width: 0.01, height: 1 } } : item),
      crops().map((item, index) => index === 0 ? { ...item, extra: 1 } : item)]) {
      expect(() => parseCrops(bad)).toThrow(refusal('crops'));
    }
  });

  it('keeps output folders out of the checkout, the build trees and each other', () => {
    const outside = path.join(tmpdir(), 'stillroom-probe-a');
    expect(checkFolders([outside, `${outside}-b`])).toEqual([path.resolve(outside), path.resolve(`${outside}-b`)]);
    for (const folders of [[path.join(repository, 'dist', 'x')], [OPERATOR_TREE], [path.join(repository, 'samples')], [outside, outside]]) {
      expect(() => checkFolders(folders)).toThrow(refusal('folder'));
    }
  });

  it('builds only from a clean checkout at an exact commit', () => {
    const git = (head: string, status: string) => (args: string[]) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${head}\n` : status });
    expect(sourceCommit(git('a'.repeat(40), ''))).toBe('a'.repeat(40));
    expect(() => sourceCommit(git('a'.repeat(40), ' M src/x.ts\n'))).toThrow(refusal('dirty'));
    expect(() => sourceCommit(git('main', ''))).toThrow(refusal('git'));
    expect(() => sourceCommit(() => ({ status: 128, stdout: '' }))).toThrow(refusal('git'));
  });

  it('allows only its own loopback origin', () => {
    const allowed = loopbackOnly('http://127.0.0.1:4321');
    expect(allowed('http://127.0.0.1:4321/models/x.onnx')).toBe(true);
    for (const url of ['http://127.0.0.1:4322/', 'http://localhost:4321/', 'https://127.0.0.1:4321/', 'https://example.test/', 'data:text/plain,x']) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('binds H0 and R exactly and re-verifies them before measuring', () => {
    const h0 = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
    const reference = new Uint8Array(REFERENCE_BYTES); reference[10] = 1;
    const prepared = { framed: true, cleanup: { photoInput: true, sha256: sha256(h0), bytes: h0.byteLength, width: 1280, height: 1600,
      referenceSha256: sha256(reference), ambiguous: false, frame: { canvas: { width: 1280, height: 1600 } } } };
    const input = { commit: 'a'.repeat(40), modelSha256: 'b'.repeat(64), sampleSha256: 'c'.repeat(64), edit: { turns: 0, crop: { x: 0, y: 0, width: 1, height: 1 } } };
    const binding = bindingFor({ ...input, prepared, h0, reference });
    expect(binding).toMatchObject({ version: 1, ambiguous: false, h0: { sha256: sha256(h0), bytes: 5, width: 1280, height: 1600 },
      reference: { sha256: sha256(reference), bytes: REFERENCE_BYTES } });
    expect(() => bindingFor({ ...input, prepared: { framed: false, cleanup: null }, h0, reference })).toThrow(refusal('unframed'));
    expect(() => bindingFor({ ...input, prepared: { ...prepared, cleanup: { ...prepared.cleanup, photoInput: false } }, h0, reference })).toThrow(refusal('h0'));
    expect(() => bindingFor({ ...input, prepared: { ...prepared, cleanup: { ...prepared.cleanup, height: 1601 } }, h0, reference })).toThrow(refusal('h0'));
    expect(() => bindingFor({ ...input, prepared, h0, reference: reference.slice(1) })).toThrow(refusal('reference'));
    expect(() => verifyPrepared(binding, { commit: input.commit, modelSha256: input.modelSha256, h0, reference })).not.toThrow();
    for (const other of [{ commit: 'd'.repeat(40) }, { modelSha256: 'd'.repeat(64) }, { h0: new Uint8Array([1]) }, { reference: new Uint8Array(REFERENCE_BYTES) }]) {
      expect(() => verifyPrepared(binding, { commit: input.commit, modelSha256: input.modelSha256, h0, reference, ...other })).toThrow(refusal('binding'));
    }
  });
});

describe('remeasure (BG2c-3 §6): a synthetic copy of the probe layout', () => {
  const COMMIT = 'a'.repeat(40), MODEL = 'b'.repeat(64), CONFIG = 'c'.repeat(64), MEASURED = 'e'.repeat(40);
  const refusal = (code: string) => new HarnessRefusal(code);
  const bytes = (seed: number, length: number) => Buffer.from(Array.from({ length }, (_, index) => (seed * 31 + index * 7) & 0xff));
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  type Layout = Record<string, Buffer | string>;
  function layout(): Layout {
    const files: Layout = { 'samples/raw-1.jpg': bytes(99, 40), 'NOTE.txt': 'note', 'review.html': '<!doctype html>' };
    const listing = [], metrics: Record<string, unknown> = {};
    for (let index = 0; index < 6; index++) {
      const name = `s${index + 1}`, h0 = Buffer.concat([Buffer.from([0xff, 0xd8]), bytes(index, 30), Buffer.from([0xff, 0xd9])]);
      const reference = Buffer.from(Array.from({ length: REFERENCE_BYTES }, (_, at) => (at + index) % 3 === 0 ? 1 : 0));
      const binding = { version: 1, commit: COMMIT, modelSha256: MODEL, sampleSha256: 'd'.repeat(64), crop: {}, frame: {},
        h0: { sha256: sha256(h0), bytes: h0.length, width: 1280, height: 1600 }, reference: { sha256: sha256(reference), bytes: REFERENCE_BYTES }, ambiguous: false };
      files[`prepared/${name}.jpg`] = h0; files[`prepared/${name}.bin`] = reference; files[`prepared/${name}.json`] = json(binding);
      listing.push({ file: `${name}.jpg`, sha256: sha256(h0), reference: `${name}.bin`, binding: `${name}.json`, role: index < 5 ? 'visual' : 'disconnect' });
      const call = { call: index + 1, role: index < 5 ? 'visual' : 'disconnect', requestId: `request-${index + 1}`, inputSha256: sha256(h0),
        code: index < 5 ? 'OK' : 'DISCONNECTED', binding: { commit: COMMIT, modelSha256: MODEL, referenceSha256: sha256(reference) } };
      if (index < 5) {
        const h2 = Buffer.concat([Buffer.from([0xff, 0xd8]), bytes(index + 50, 30), Buffer.from([0xff, 0xd9])]);
        files[`calls/call-${index + 1}.jpg`] = h2;
        files[`calls/call-${index + 1}.json`] = json({ ...call, outputSha256: sha256(h2) });
        metrics[call.requestId] = { call: index + 1, reason: index < 2 ? 'colour' : 'containment', metrics: { ringDeltaE: 1 },
          h0Sha256: sha256(h0), h2Sha256: sha256(h2), referenceSha256: sha256(reference), commit: COMMIT, modelSha256: MODEL };
      } else files[`calls/call-${index + 1}.json`] = json(call);
    }
    files['prepared/samples.json'] = json(listing);
    files['prepared/prepare-report.json'] = json({ commit: COMMIT, report: listing.map((_, index) => ({ sample: index + 1, code: 'READY', h0Bytes: 34 })), blocked: [], registrations: 0 });
    files['measured/metrics.json'] = json({ commit: COMMIT, metrics, pending: [], blocked: [] });
    return files;
  }
  const probe = async (files: Layout = layout()) => {
    const root = await temporary(files);
    return { root, out: path.join(root, 'remeasured') };
  };
  async function snapshot(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) { const file = path.join(entry.parentPath, entry.name); out[path.relative(root, file)] = sha256(await readFile(file)); }
    }
    return out;
  }
  const spyIo = (reads: string[]) => ({ realpath, lstat, readdir, mkdir, writeFile,
    readFile: (file: string, options: { flag: 'r' }) => { reads.push(file); return readFile(file, options); } }) as unknown as RemeasureIo;
  const results = (plan: RemeasurePlan, over: Record<string, unknown> = {}) => plan.entries.map((entry, index) => ({
    h0Sha256: entry.h0Sha256, h2Sha256: entry.h2Sha256, referenceSha256: entry.referenceSha256, checkVersion: 2, configSha256: CONFIG,
    verdict: index === 0 ? { accepted: true, metrics: { checkVersion: 2 } } : { accepted: false, reason: 'colourMode', metrics: { checkVersion: 2 } }, ...over }));
  const build = (plan: RemeasurePlan, over: Record<string, unknown> = {}) =>
    ({ measuredCommit: MEASURED, modelSha256: MODEL, configSha256: CONFIG, results: results(plan), blocked: [], ...over });

  it('selects exactly the 5 visual entries, never opens s6 or call-6, writes one schema-2 file and leaves the tree unchanged', async () => {
    const { root, out } = await probe();
    const before = await snapshot(root);
    const reads: string[] = [];
    const plan = await planRemeasure(root, out, spyIo(reads));
    expect(plan.entries.map((entry) => [entry.call, entry.requestId, entry.priorReason])).toEqual([
      [1, 'request-1', 'colour'], [2, 'request-2', 'colour'], [3, 'request-3', 'containment'], [4, 'request-4', 'containment'], [5, 'request-5', 'containment']]);
    const value = remeasureRecord(plan, build(plan));
    await writeRemeasure(plan, value, spyIo(reads));
    expect(reads.filter((file) => /[\\/](s6\.|call-6\.)/.test(file))).toEqual([]);
    expect(reads.some((file) => /[\\/]samples[\\/]|NOTE\.txt|review\.html/.test(file))).toBe(false);
    const written = JSON.parse(await readFile(path.join(out, 'metrics.json'), 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['blocked', 'checkVersion', 'configSha256', 'measuredCommit', 'metrics', 'modelSha256', 'preparedCommit', 'schema']);
    expect(written).toMatchObject({ schema: 2, preparedCommit: COMMIT, measuredCommit: MEASURED, checkVersion: 2, configSha256: CONFIG, modelSha256: MODEL, blocked: [] });
    expect(written.metrics['request-2']).toEqual({ call: 2, reason: 'colourMode', metrics: { checkVersion: 2 }, h0Sha256: plan.entries[1]!.h0Sha256,
      h2Sha256: plan.entries[1]!.h2Sha256, referenceSha256: plan.entries[1]!.referenceSha256, priorReason: 'colour' });
    const after = await snapshot(root);
    delete after[path.join('remeasured', 'metrics.json')];
    expect(after).toEqual(before);
    // The output is written once, with wx: a second write refuses.
    await expect(writeRemeasure(plan, value)).rejects.toThrow(refusal('output'));
  });

  it.each([
    ['a missing file', (files: Layout) => { delete files['prepared/s3.bin']; }],
    ['an extra file', (files: Layout) => { files['calls/call-7.json'] = '{}'; }],
    ['a renamed file', (files: Layout) => { files['calls/call-6.jsn'] = files['calls/call-6.json']!; delete files['calls/call-6.json']; }],
    ['an extra measured file', (files: Layout) => { files['measured/metrics.old'] = '{}'; }],
    ['a nested folder', (files: Layout) => { files['prepared/s1.bin.d/x'] = 'x'; delete files['prepared/s1.bin']; }],
  ])('refuses %s in the known inventory', async (_name, change) => {
    const files = layout(); change(files);
    const { root, out } = await probe(files);
    await expect(planRemeasure(root, out)).rejects.toThrow(refusal('inventory'));
  });

  it('refuses a symlinked folder or file', async () => {
    const { root, out } = await probe();
    const elsewhere = await temporary({ 'x.txt': 'x' });
    await rm(path.join(root, 'measured'), { recursive: true });
    await symlink(elsewhere, path.join(root, 'measured'), 'junction');
    await expect(planRemeasure(root, out)).rejects.toThrow(refusal('inventory'));
    // A symlinked file, observed through the injected listing (file symlinks need privileges on Windows).
    const fresh = await probe();
    const io = { realpath, lstat, mkdir, writeFile, readFile,
      readdir: async (folder: string, options: { withFileTypes: true }) => (await readdir(folder, options)).map((entry) =>
        entry.name === 's2.jpg' ? Object.assign(Object.create(entry), { isSymbolicLink: () => true, isFile: () => false, name: entry.name }) : entry) } as unknown as RemeasureIo;
    await expect(planRemeasure(fresh.root, fresh.out, io)).rejects.toThrow(refusal('inventory'));
  });

  it('refuses a role change in samples.json or a call record', async () => {
    for (const change of [(files: Layout) => { files['prepared/samples.json'] = String(files['prepared/samples.json']).replace('"role": "visual"', '"role": "disconnect"'); },
      (files: Layout) => { files['calls/call-2.json'] = String(files['calls/call-2.json']).replace('"role": "visual"', '"role": "disconnect"'); }]) {
      const files = layout(); change(files);
      const { root, out } = await probe(files);
      await expect(planRemeasure(root, out)).rejects.toBeInstanceOf(HarnessRefusal);
    }
  });

  it('refuses an output folder that exists, is nested in the probe folders or contains them', async () => {
    const { root } = await probe();
    for (const [out, code] of [[path.join(root, 'prepared', 'new'), 'output'], [path.join(root, 'samples', 'new'), 'output'], [root, 'output'],
      [path.join(root, 'measured'), 'output'], [path.join(repository, 'remeasured'), 'folder']] as const) {
      await expect(planRemeasure(root, out)).rejects.toThrow(refusal(code));
    }
    await mkdir(path.join(root, 'existing'));
    await expect(planRemeasure(root, path.join(root, 'existing'))).rejects.toThrow(refusal('output'));
    await writeFile(path.join(root, 'existing', 'x'), 'x');
    await expect(planRemeasure(root, path.join(root, 'existing'))).rejects.toThrow(refusal('output'));
  });

  it.each([
    ['H0', 'h0', (files: Layout) => { files['prepared/s2.jpg'] = Buffer.concat([files['prepared/s2.jpg'] as Buffer, Buffer.from([0])]); }],
    ['R', 'reference', (files: Layout) => { const r = Buffer.from(files['prepared/s3.bin'] as Buffer); r[0] = r[0] ? 0 : 1; files['prepared/s3.bin'] = r; }],
    ['H2', 'h2', (files: Layout) => { files['calls/call-4.jpg'] = Buffer.concat([files['calls/call-4.jpg'] as Buffer, Buffer.from([0])]); }],
    ['the request ID', 'requestId', (files: Layout) => { files['calls/call-5.json'] = String(files['calls/call-5.json']).replace('request-5', 'request-9'); }],
    ['the model', 'model', (files: Layout) => { files['prepared/s4.json'] = String(files['prepared/s4.json']).replace(MODEL, 'f'.repeat(64)); }],
    ['the legacy entry\'s model', 'model', (files: Layout) => { files['measured/metrics.json'] = String(files['measured/metrics.json']).replace(`"modelSha256": "${MODEL}"`, `"modelSha256": "${'f'.repeat(64)}"`); }],
  ])('refuses a hash mismatch for %s', async (_name, code, change) => {
    const files = layout(); change(files);
    const { root, out } = await probe(files);
    await expect(planRemeasure(root, out)).rejects.toThrow(refusal(code));
  });

  it('accepts the legacy v1 metrics only under their original rule', async () => {
    for (const change of [(files: Layout) => { files['measured/metrics.json'] = String(files['measured/metrics.json']).replace(`"commit": "${COMMIT}",\n  "metrics"`, `"commit": "${'f'.repeat(40)}",\n  "metrics"`); },
      (files: Layout) => { files['measured/metrics.json'] = String(files['measured/metrics.json']).replace('"pending"', '"schema": 1, "pending"'); }]) {
      const files = layout(); change(files);
      const { root, out } = await probe(files);
      await expect(planRemeasure(root, out)).rejects.toThrow(refusal('legacy'));
    }
  });

  it('refuses results from another model, config, version or input, and legacy metrics changed during the run', async () => {
    const { root, out } = await probe();
    const plan = await planRemeasure(root, out);
    expect(() => remeasureRecord(plan, build(plan, { modelSha256: 'f'.repeat(64) }))).toThrow(refusal('model'));
    expect(() => remeasureRecord(plan, build(plan, { measuredCommit: 'main' }))).toThrow(refusal('build'));
    for (const over of [{ configSha256: 'f'.repeat(64) }, { checkVersion: 1 }, { h2Sha256: 'f'.repeat(64) }]) {
      expect(() => remeasureRecord(plan, build(plan, { results: results(plan, over) }))).toThrow(refusal('results'));
    }
    expect(() => remeasureRecord(plan, build(plan, { results: results(plan).slice(1) }))).toThrow(refusal('results'));
    await writeFile(plan.metricsFile, 'changed');
    await expect(writeRemeasure(plan, remeasureRecord(plan, build(plan)))).rejects.toThrow(refusal('changed'));
    await expect(readdir(out)).rejects.toThrow();
  });

  it('keeps measure strict: a binding from another commit is refused', () => {
    const h0 = new Uint8Array([1]), reference = new Uint8Array(REFERENCE_BYTES);
    const binding = { version: 1, commit: COMMIT, modelSha256: MODEL, h0: { sha256: sha256(h0), bytes: 1 }, reference: { sha256: sha256(reference) } };
    expect(() => verifyPrepared(binding, { commit: MEASURED, modelSha256: MODEL, h0, reference })).toThrow(refusal('binding'));
  });

  it('lists the known inventory exactly', () => {
    expect(PREPARED_FILES).toHaveLength(20);
    expect(CALL_FILES).toEqual(['call-1.jpg', 'call-1.json', 'call-2.jpg', 'call-2.json', 'call-3.jpg', 'call-3.json', 'call-4.jpg', 'call-4.json',
      'call-5.jpg', 'call-5.json', 'call-6.json']);
    expect(MEASURED_FILES).toEqual(['metrics.json']);
  });
});
