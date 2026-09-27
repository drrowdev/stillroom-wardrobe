import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkStaticTree, pagesLimits, parseInventory, readInventory, sha256, type InventoryFile } from '../../scripts/check-static-assets.mjs';
import { checkDeployedAssets } from '../../scripts/check-deployed-assets.mjs';
import { modelAssetBytes, modelAssets } from '../../src/images/background/model-assets';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const model = Buffer.from('fictional model');
const runtime = Buffer.from('fictional runtime');
const entry = (role: 'model' | 'runtime', bytes: Buffer, name: string, extension: string): InventoryFile => ({
  role, path: `/models/${name}-${sha256(bytes).slice(0, 8)}.${extension}`, source: `fixture/${name}`, bytes: bytes.length, sha256: sha256(bytes),
});
const inventory = [entry('model', model, 'u2netp', 'onnx'), entry('runtime', runtime, 'ort-wasm', 'wasm')];
async function dist(files: Record<string, Buffer | string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'stillroom-static-'));
  roots.push(root);
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  }
  return root;
}
const good = () => ({ 'index.html': '<!doctype html>', [inventory[0]!.path.slice(1)]: model, [inventory[1]!.path.slice(1)]: runtime });

describe('approved model asset inventory', () => {
  it('names the committed model and the locked runtime, byte for byte', async () => {
    const files = await readInventory();
    expect(files.map((file) => file.role).sort()).toEqual(['model', 'runtime']);
    for (const file of files) {
      const bytes = await readFile(path.resolve(file.source));
      expect(bytes.length, file.source).toBe(file.bytes);
      expect(sha256(bytes), file.source).toBe(file.sha256);
    }
    expect(modelAssets).toEqual(files);
    expect(modelAssetBytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
  });

  it.each([
    ['no files', { version: 1, files: [] }],
    ['another version', { version: 2, files: inventory }],
    ['a duplicate role', { version: 1, files: [inventory[0], { ...inventory[1], role: 'model' }] }],
    ['an extra key', { version: 1, files: [{ ...inventory[0], url: 'https://cdn.example.test/x' }, inventory[1]] }],
    ['a path outside /models', { version: 1, files: [{ ...inventory[0], path: '/assets/u2netp-00000000.onnx' }, inventory[1]] }],
    ['a path without its digest', { version: 1, files: [{ ...inventory[0], path: '/models/u2netp-00000000.onnx' }, inventory[1]] }],
    ['a source outside the checkout', { version: 1, files: [{ ...inventory[0], source: '../secret' }, inventory[1]] }],
    ['a file over the Pages limit', { version: 1, files: [{ ...inventory[0], bytes: pagesLimits.fileBytes + 1 }, inventory[1]] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseInventory(value)).toThrow('Invalid model asset inventory');
  });
});

describe('static tree check', () => {
  it('passes the exact approved binaries', async () => {
    expect(await checkStaticTree(await dist(good()), inventory)).toEqual([]);
  });

  it('rejects missing, changed and extra binaries', async () => {
    const missing = good(); delete missing[inventory[1]!.path.slice(1)];
    expect(await checkStaticTree(await dist(missing), inventory)).toEqual([`missing binary ${inventory[1]!.path.slice(1)}`]);
    expect(await checkStaticTree(await dist({ ...good(), [inventory[0]!.path.slice(1)]: 'fictional modex' }), inventory))
      .toEqual([`changed binary ${inventory[0]!.path.slice(1)}`]);
    expect(await checkStaticTree(await dist({ ...good(), 'assets/ort-wasm-simd-threaded-abc.wasm': runtime, 'extra.onnx': model }), inventory))
      .toEqual(['unapproved binary assets/ort-wasm-simd-threaded-abc.wasm', 'unapproved binary extra.onnx']);
  });

  it('rejects a file over the Pages per-file limit', async () => {
    const root = await dist(good());
    await writeFile(path.join(root, 'big.bin'), Buffer.alloc(pagesLimits.fileBytes + 1));
    expect(await checkStaticTree(root, inventory)).toEqual([`big.bin ${pagesLimits.fileBytes + 1} B > ${pagesLimits.fileBytes} B`]);
  });
});

describe('deployed asset check', () => {
  const headers = { 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  const site = (override: (file: InventoryFile) => Response | undefined = () => undefined) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: URL, init: RequestInit) => {
      seen.push({ url: url.href, init });
      const file = inventory.find((item) => item.path === url.pathname)!;
      return override(file) ?? new Response(file.role === 'model' ? model : runtime, { status: 200, headers });
    };
    return { seen, fetcher };
  };

  it('passes the served bytes and headers and asks for no redirect or credentials', async () => {
    const { seen, fetcher } = site();
    const rows = await checkDeployedAssets('https://candidate.example.test', inventory, fetcher);
    expect(rows.map((row) => row.problems)).toEqual([[], []]);
    expect(seen.map((request) => request.url)).toEqual(inventory.map((file) => `https://candidate.example.test${file.path}`));
    for (const { init } of seen) expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });

  it('fails a redirect, changed bytes and missing headers', async () => {
    const redirect = site((file) => file.role === 'model' ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/m' } }) : undefined);
    expect((await checkDeployedAssets('https://candidate.example.test', inventory, redirect.fetcher))[0]!.problems[0]).toBe('status 302 (redirect refused)');
    const changed = site((file) => file.role === 'runtime' ? new Response('fictional runtimf', { status: 200, headers }) : undefined);
    expect((await checkDeployedAssets('https://candidate.example.test', inventory, changed.fetcher))[1]!.problems).toHaveLength(1);
    const bare = site(() => new Response(model, { status: 200 }));
    expect((await checkDeployedAssets('https://candidate.example.test', inventory, bare.fetcher))[0]!.problems)
      .toEqual(['cache-control ""', 'missing nosniff']);
  });

  it('refuses a non-https or non-origin target before fetching', async () => {
    const { seen, fetcher } = site();
    for (const origin of ['http://candidate.example.test', 'https://candidate.example.test/app', 'https://user:pw@candidate.example.test', '']) {
      await expect(checkDeployedAssets(origin, inventory, fetcher)).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });
});
