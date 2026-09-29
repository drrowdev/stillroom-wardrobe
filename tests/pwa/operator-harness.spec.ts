import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { checkStaticTree, HARNESS_ENTRY, HARNESS_MARKER, listTree, OPERATOR_TREE, readInventory } from '../../scripts/check-static-assets.mjs';
import { REFERENCE_BYTES, withHarness } from '../../scripts/cleanup-probe-harness.mjs';
import { isPhotoInputJpeg } from '../../src/images/restore-jpeg';
import { builds, repository } from './builds';

// BG2c operator harness (plan rev4 §11.2a, R5'): the deploy tree the PWA job builds stays clean, a contaminated copy
// is refused by both deploy checks, and the real operator-probe build runs on loopback with the real model. The
// assertions read JSON and digests only; nothing is dispatched to any provider.
const budget = (dist: string) => spawnSync(process.execPath, [path.join(repository, 'scripts', 'check-bundle-budget.mjs'), dist], { cwd: repository, encoding: 'utf8' });
const temporaries: string[] = [];
test.afterAll(() => { for (const root of temporaries.splice(0)) rmSync(root, { recursive: true, force: true }); });
function copyOfBuild(extra: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'stillroom-contaminated-'));
  temporaries.push(root);
  cpSync(builds.a, root, { recursive: true });
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

test('the clean normal build has no harness and passes both deploy checks', async () => {
  const files = await listTree(builds.a);
  expect(files.filter((file) => file.startsWith('probe/'))).toEqual([]);
  expect(await checkStaticTree(builds.a, await readInventory())).toEqual([]);
  const result = budget(builds.a);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

test('a deploy tree with the harness, or only its marker chunk, is refused', async () => {
  const inventory = await readInventory();
  const withEntry = copyOfBuild({ [HARNESS_ENTRY]: '<!doctype html>', 'assets/harness-0000.js': `window.${HARNESS_MARKER}={};` });
  const markerOnly = copyOfBuild({ 'assets/harness-0000.js': `window.${HARNESS_MARKER}={};` });
  expect(await checkStaticTree(withEntry, inventory)).toEqual([`operator harness file ${HARNESS_ENTRY}`, 'operator harness marker in assets/harness-0000.js']);
  expect(await checkStaticTree(markerOnly, inventory)).toEqual(['operator harness marker in assets/harness-0000.js']);
  for (const tree of [withEntry, markerOnly]) {
    const result = budget(tree);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BUDGET: static assets: operator harness marker in assets/harness-0000.js');
  }
});

test('the real operator-probe build prepares H0 and R on loopback only', async () => {
  test.setTimeout(240_000);
  try {
    const run = await withHarness(async ({ page, assets }) => {
      const prepared = await page.evaluate(async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#d9d9d9'; context.fillRect(0, 0, 640, 800);
        context.fillStyle = '#1f3a93';
        context.beginPath();
        for (const [x, y] of [[230, 140], [410, 140], [560, 250], [500, 330], [450, 290], [450, 680], [190, 680], [190, 290], [140, 330], [80, 250]]) context.lineTo(x!, y!);
        context.closePath(); context.fill();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
        let text = '';
        for (const value of new Uint8Array(await blob.arrayBuffer())) text += String.fromCharCode(value);
        return window.__stillroomCleanupHarness!.prepare(btoa(text), 'image/png', { turns: 0, crop: { x: 0, y: 0, width: 1, height: 1 } });
      });
      return { prepared, assets };
    }, { chromium });
    expect(run.blocked).toEqual([]);
    expect(run.registrations).toBe(0);
    expect((run.result.assets as { ok: boolean }[]).map((asset) => asset.ok)).toEqual([true, true]);
    const cleanup = run.result.prepared.cleanup;
    expect(run.result.prepared.framed).toBe(true);
    expect(cleanup).not.toBeNull();
    const h0 = new Uint8Array(Buffer.from(cleanup!.h0, 'base64'));
    expect(cleanup!.photoInput).toBe(true);
    expect(isPhotoInputJpeg(h0, cleanup!.width, cleanup!.height)).toBe(true);
    expect(cleanup!.width * 5).toBe(cleanup!.height * 4);
    expect(Buffer.from(cleanup!.reference, 'base64').byteLength).toBe(REFERENCE_BYTES);
    expect(cleanup!.referenceBytes).toBe(REFERENCE_BYTES);
    expect(cleanup!.ambiguous).toBe(false);
  } finally {
    rmSync(OPERATOR_TREE, { recursive: true, force: true });
  }
  expect(readdirSync(repository)).not.toContain('.probe-dist');
});
