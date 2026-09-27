#!/usr/bin/env node
// Post-deploy check for the coordinator's receipt (ADR24): GETs both approved binaries from a deployed origin and
// compares them with the reviewed inventory in this checkout. It never reads a manifest from the site, accepts no
// redirect and needs no credentials. Usage: node scripts/check-deployed-assets.mjs https://<deployment-host>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInventory, sha256 } from './check-static-assets.mjs';

export async function checkDeployedAssets(origin, inventory, fetchImpl = fetch) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new Error('Give the deployment origin as https://host with no path, query or credentials.');
  }
  const results = [];
  for (const file of inventory) {
    const url = new URL(file.path, base);
    const problems = [];
    const response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    if (response.status !== 200) problems.push(`status ${response.status}${response.headers.get('location') ? ' (redirect refused)' : ''}`);
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!/\bimmutable\b/.test(cacheControl)) problems.push(`cache-control "${cacheControl}"`);
    if ((response.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') problems.push('missing nosniff');
    const bytes = response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
    const digest = sha256(bytes);
    if (response.status === 200 && (bytes.length !== file.bytes || digest !== file.sha256)) problems.push(`bytes ${bytes.length} sha256 ${digest}`);
    results.push({ path: file.path, status: response.status, bytes: bytes.length, sha256: digest, problems });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await checkDeployedAssets(process.argv[2] ?? '', await readInventory());
  for (const row of results) {
    console.log(`${row.problems.length ? 'FAIL' : 'PASS'} ${row.path} ${row.status} ${row.bytes} B ${row.sha256}${row.problems.length ? ` - ${row.problems.join('; ')}` : ''}`);
  }
  if (results.some((row) => row.problems.length)) process.exit(1);
}
