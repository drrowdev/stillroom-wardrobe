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
  { name: '20260905000000_initial.sql', version: '20260905000000', time: '2026-09-05 00:00:00', bytes: 35214, sha256: SOURCE_HASHES.base },
  { name: '20260906000000_item_field_provenance.sql', version: '20260906000000', time: '2026-09-06 00:00:00', bytes: 5923, sha256: SOURCE_HASHES.target },
  { name: '20260909070000_item_description_edit.sql', version: '20260909070000', time: '2026-09-09 07:00:00', bytes: 2618, sha256: SOURCE_HASHES.description },
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
    requireEvidence(info.isFile() && !info.isSymbolicLink() && info.size <= Math.max(...MIGRATIONS.map((entry) => entry.bytes)));
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

const HISTORY_REASONS = Object.freeze([
  'history-command', 'length-cap', 'charset', 'line-count', 'header', 'separator',
  'cell-count', 'cell-quoting', 'cell-content', 'version-mismatch', 'remote-mismatch',
  'time-mismatch', 'inventory-mismatch',
]);

class HistoryError extends Error {
  constructor(reason) {
    super('EVIDENCE_REQUIRED');
    this.reason = reason;
  }
}

function requireHistory(condition, reason) {
  if (!condition) throw new HistoryError(reason);
}

export function historyFailureDetail(error) {
  const reason = error instanceof HistoryError
    ? HISTORY_REASONS.find((label) => label === error.reason) : undefined;
  return reason ? `; reason=${reason}` : '';
}

// SOURCE-DERIVED: CLI v2.116.0 makeTable/RenderTable preserves body backticks.
// Actual compatibility still requires a successful authorized fresh CI history gate.
export function parseMigrationHistory(output) {
  requireHistory(typeof output === 'string', 'cell-content');
  requireHistory(output.length <= 4096, 'length-cap');
  requireHistory(/^[\x20-\x7e\r\n]*$/.test(output), 'charset');
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim());
  requireHistory(lines.length === MIGRATIONS.length + 2, 'line-count');
  const cells = (line) => line.split('|').map((cell) => cell.trim());
  requireHistory(JSON.stringify(cells(lines[0])) === JSON.stringify(['Local', 'Remote', 'Time (UTC)']), 'header');
  requireHistory(/^-+\|-+\|-+$/.test(lines[1]), 'separator');
  const rows = lines.slice(2).map((line, index) => {
    const quoted = cells(line);
    requireHistory(quoted.length === 3, 'cell-count');
    const row = quoted.map((cell) => {
      requireHistory(/^`[^`]*`$/.test(cell), 'cell-quoting');
      const inner = cell.slice(1, -1);
      requireHistory(inner.length > 0 && (inner === ' ' || inner.trim() === inner), 'cell-content');
      return inner === ' ' ? '' : inner;
    });
    const { version, time } = MIGRATIONS[index];
    requireHistory(row[0] === version, 'version-mismatch');
    requireHistory(row[1] === '' || row[1] === version, 'remote-mismatch');
    requireHistory(row[2] === time, 'time-mismatch');
    return { local: row[0], applied: row[1] };
  });
  return {
    applied: rows.filter((row) => row.applied !== '').map((row) => row.applied),
    pending: rows.filter((row) => row.applied === '').map((row) => row.local),
  };
}

export function assertHistory(output, stage) {
  requireHistory(stage === 'base' || stage === 'target', 'inventory-mismatch');
  const inventory = parseMigrationHistory(output);
  const expected = stage === 'base'
    ? { applied: [MIGRATIONS[0].version], pending: MIGRATIONS.slice(1).map((entry) => entry.version) }
    : { applied: MIGRATIONS.map((entry) => entry.version), pending: [] };
  requireHistory(JSON.stringify(inventory) === JSON.stringify(expected), 'inventory-mismatch');
  return inventory;
}

export function assertHistoryResult(result, stage) {
  requireHistory(result?.code === 0, 'history-command');
  return assertHistory(result.stdout, stage);
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
  const inventory = assertHistoryResult(result, stage);
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
    console.log('PASS: pinned 2.116.0 capabilities and exact three-source inventory');
    for (const entry of MIGRATIONS) console.log(`PASS: source ${entry.version} bytes=${entry.bytes} sha256=${entry.sha256}`);
    stage = 'S1-base-reset';
    requireEvidence((await cli(['db', 'reset', '--local', '--no-seed', '--yes', '--version', MIGRATIONS[0].version], 10 * 60_000)).code === 0);
    stage = 'S1-base-history';
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
    stage = 'S3-base-history';
    await history('base');
    stage = 'S3-migration-up';
    requireEvidence((await cli(['migration', 'up', '--local'])).code === 0);
    stage = 'S3-target-history';
    await history('target');
    stage = 'S4-verify';
    await child('verify');
    console.log('PASS: populated base-to-target preservation and bounded post-comparison probes');
  } catch (error) {
    console.error(`FAIL: preservation ${stage}; EVIDENCE_REQUIRED${historyFailureDetail(error)}; subsequent stages NOT RUN`);
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
