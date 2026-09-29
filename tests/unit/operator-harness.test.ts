import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkOperatorTree, checkStaticTree, HARNESS_ENTRY, HARNESS_MARKER, OPERATOR_TREE, sha256, type InventoryFile,
} from '../../scripts/check-static-assets.mjs';
import {
  bindingFor, checkFolders, HarnessRefusal, loopbackOnly, parseCrops, REFERENCE_BYTES, repository, sourceCommit, verifyPrepared,
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
