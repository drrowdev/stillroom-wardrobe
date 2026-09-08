import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, assertNoServiceSecrets, assertProjectConfig, requireDocker, requireLocalContainer,
  cli, runCommand, normalSessionEnvironment, readCredentialCache, validateSessionEnvironment,
} from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import {
  SOURCE_HASHES, requireEvidence, assertSnapshotAbsent, cleanupSnapshot,
} from '../tests/integration/preservation.sessions.mjs';

export const MIGRATIONS = Object.freeze([
  { name: '20260905000000_initial.sql', version: '20260905000000', bytes: 35214, sha256: SOURCE_HASHES.base },
  { name: '20260906000000_item_field_provenance.sql', version: '20260906000000', bytes: 5923, sha256: SOURCE_HASHES.target },
]);

export function assertRehearsalEnvironment(env, args) {
  requireEvidence(Array.isArray(args) && args.length === 0);
  requireEvidence(env.ALLOW_PRESERVATION_REHEARSAL === '1' && env.CI === 'true' && env.GITHUB_ACTIONS === 'true');
  assertNoServiceSecrets(env);
}

export function validateInventory(entries) {
  requireEvidence(Array.isArray(entries) && entries.length === MIGRATIONS.length);
  for (const expected of MIGRATIONS) {
    const found = entries.filter((entry) => entry.name === expected.name);
    requireEvidence(found.length === 1);
    const entry = found[0];
    requireEvidence(entry.regular === true && entry.symlink === false
      && entry.bytes === expected.bytes && entry.sha256 === expected.sha256);
  }
}

export async function assertMigrationInventory() {
  const directory = path.join(ROOT, 'supabase', 'migrations');
  const stat = await lstat(directory);
  requireEvidence(stat.isDirectory() && !stat.isSymbolicLink());
  const entries = [];
  for (const name of await readdir(directory)) {
    requireEvidence(MIGRATIONS.some((entry) => entry.name === name));
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    requireEvidence(info.isFile() && !info.isSymbolicLink() && info.size <= 35214);
    entries.push({ name, regular: true, symlink: false, bytes: info.size,
      sha256: createHash('sha256').update(await readFile(filename)).digest('hex') });
  }
  validateInventory(entries);
}

export function assertCapabilities(results) {
  requireEvidence(Array.isArray(results) && results.length === 3);
  for (const [index, flags] of [['--local', '--version'], ['--local'], ['--local']].entries()) {
    const result = results[index];
    requireEvidence(result?.code === 0 && typeof result.stdout === 'string');
    for (const flag of flags) {
      requireEvidence(new RegExp(`^ *${flag}(?: +|$)`, 'm').test(result.stdout));
    }
  }
}

// Source-derived from CLI v2.116.0 makeTable/RenderTable (Glamour ASCII).
// Only the first authorized fresh CI run can establish actual CLI compatibility.
export function parseMigrationHistory(output) {
  requireEvidence(typeof output === 'string' && output.length <= 4096 && /^[\x20-\x7e\r\n]*$/.test(output));
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim());
  requireEvidence(lines.length === 4);
  const cells = (line) => line.split('|').map((cell) => cell.trim());
  requireEvidence(JSON.stringify(cells(lines[0])) === JSON.stringify(['Local', 'Remote', 'Time (UTC)']));
  requireEvidence(/^-+\|-+\|-+$/.test(lines[1]));
  const rows = lines.slice(2).map((line, index) => {
    const row = cells(line);
    const version = MIGRATIONS[index].version;
    const time = index === 0 ? '2026-09-05 00:00:00' : '2026-09-06 00:00:00';
    requireEvidence(row.length === 3 && row[0] === version
      && (row[1] === '' || row[1] === version) && row[2] === time);
    return { local: row[0], applied: row[1] };
  });
  return {
    applied: rows.filter((row) => row.applied !== '').map((row) => row.applied),
    pending: rows.filter((row) => row.applied === '').map((row) => row.local),
  };
}

export function assertHistory(output, stage) {
  requireEvidence(stage === 'base' || stage === 'target');
  const inventory = parseMigrationHistory(output);
  const expected = stage === 'base'
    ? { applied: [MIGRATIONS[0].version], pending: [MIGRATIONS[1].version] }
    : { applied: MIGRATIONS.map((entry) => entry.version), pending: [] };
  requireEvidence(JSON.stringify(inventory) === JSON.stringify(expected));
  return inventory;
}

export function exportBodyEvidence(sql) {
  requireEvidence(typeof sql === 'string');
  const declaration = /create(?: or replace)? function public\.export_manifest\(p_export_id uuid\) returns jsonb\nlanguage sql stable security invoker set search_path = '' as \$\$\n/g;
  const matches = [...sql.matchAll(declaration)];
  requireEvidence(matches.length === 1);
  // Include the opening newline: do not trim PostgreSQL's stored body literal.
  const start = matches[0].index + matches[0][0].length - 1;
  const end = sql.indexOf('\n$$;', start);
  requireEvidence(end > start && !sql.slice(start, end).includes('$$'));
  const body = sql.slice(start, end + 1);
  return { bytes: Buffer.byteLength(body), md5: createHash('md5').update(body).digest('hex') };
}

async function history(stage) {
  const result = await cli(['migration', 'list', '--local']);
  requireEvidence(result.code === 0);
  const inventory = assertHistory(result.stdout, stage);
  console.log(`PASS: history ${stage} applied=${inventory.applied.join(',')} pending=${inventory.pending.join(',') || 'none'}`);
}

async function main() {
  let stage = 'guards', run, ownsSnapshot = false;
  try {
    assertRehearsalEnvironment(process.env, process.argv.slice(2));
    await assertProjectConfig();
    await requireDocker();
    await requireLocalContainer();
    await assertMigrationInventory();
    stage = 'capabilities';
    const help = [];
    for (const args of [['db', 'reset', '--help'], ['migration', 'up', '--help'], ['migration', 'list', '--help']]) {
      help.push(await cli(args));
    }
    assertCapabilities(help);
    console.log('PASS: pinned 2.116.0 capabilities and exact two-source inventory');
    for (const entry of MIGRATIONS) console.log(`PASS: source ${entry.version} bytes=${entry.bytes} sha256=${entry.sha256}`);
    stage = 'S1-base-reset';
    requireEvidence((await cli(['db', 'reset', '--local', '--no-seed', '--yes', '--version', MIGRATIONS[0].version], 10 * 60_000)).code === 0);
    await history('base');
    stage = 'S1-provision';
    requireEvidence((await runCommand(process.execPath, [path.join(ROOT, 'scripts', 'provision-test-users.mjs')])).code === 0);
    const env = normalSessionEnvironment(process.env, await readCredentialCache());
    validateSessionEnvironment(env);
    run = randomUUID();
    await assertSnapshotAbsent(run);
    ownsSnapshot = true;
    const child = async (phase) => {
      const result = await runCommand(process.execPath, [
        path.join(ROOT, 'tests', 'integration', 'preservation.sessions.mjs'), phase, run,
      ], { env });
      // Never forward child assertions, HTTP data or arbitrary exception text.
      requireEvidence(result.code === 0 && result.stdout.trim() === `PASS: preservation ${phase}; owners=2 tables=10 rows=30 objects=8`);
      console.log(result.stdout.trim());
    };
    stage = 'S2-capture';
    await child('capture');
    stage = 'S3-inventory';
    await assertMigrationInventory();
    await history('base');
    stage = 'S3-migration-up';
    requireEvidence((await cli(['migration', 'up', '--local'])).code === 0);
    await history('target');
    stage = 'S4-verify';
    await child('verify');
    console.log('PASS: populated base-to-target preservation and bounded post-comparison probes');
  } catch {
    console.error(`FAIL: preservation ${stage}; EVIDENCE_REQUIRED; subsequent stages NOT RUN`);
    process.exitCode = 1;
  } finally {
    if (ownsSnapshot) {
      try {
        await cleanupSnapshot(run);
        console.log('PASS: exact-run snapshot cleanup');
      } catch {
        console.error('FAIL: preservation cleanup; EVIDENCE_REQUIRED');
        process.exitCode = 1;
      }
    }
  }
}

if (isMain(import.meta.url)) await main();
