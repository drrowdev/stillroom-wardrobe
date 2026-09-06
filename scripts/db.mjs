import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ROOT, MIGRATION_HASH, assertProjectConfig, requireDocker, requireLocalContainer,
  cli, localStatus, fail, reportError, runCommand,
} from './backend/local.mjs';

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['start', 'reset', 'types'].includes(action) || (args.length && !(action === 'types' && args.length === 1 && args[0] === '--check'))) {
    fail('REFUSED: usage is db.mjs start | reset | types [--check]; no remote or extra arguments are accepted.');
  }
  await assertProjectConfig();
  await requireDocker();
  if (action === 'start') {
    console.log('Starting the disposable local Supabase stack; Docker image downloads may take several minutes.');
    const started = await cli(['start', '--yes'], 15 * 60_000);
    if (started.code !== 0) fail('NOT RUN: local Supabase startup failed. Check Docker resources and local service ports; CLI output is withheld to protect credentials.');
    await requireLocalContainer();
    const status = await localStatus();
    try {
      const response = await fetch(`${status.url}/auth/v1/health`, {
        headers: { apikey: status.key }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) fail('NOT RUN: the local Auth service is not healthy.');
    } catch { fail('NOT RUN: the local Auth service did not respond after startup.'); }
    console.log('PASS: local Supabase started. Next run npm run db:reset to provision fictional accounts.');
    return;
  }
  await requireLocalContainer();
  if (action === 'reset') {
    const migration = await readFile(path.join(ROOT, 'supabase', 'migrations', '20260905000000_initial.sql'));
    if (createHash('sha256').update(migration).digest('hex') !== MIGRATION_HASH) fail('REFUSED: the initial migration differs from the reviewed blueprint.');
    console.log('Resetting only the disposable local Supabase database.');
    const reset = await cli(['db', 'reset', '--local', '--no-seed', '--yes'], 10 * 60_000);
    if (reset.code !== 0) fail('FAIL: local database reset failed; no account provisioning ran. CLI output is withheld.', 1);
    const provision = await runCommand(process.execPath, [path.join(ROOT, 'scripts', 'provision-test-users.mjs')]);
    if (provision.code !== 0) {
      // The fixture's only output is a deliberately coarse, non-sensitive outcome.
      console.error(provision.stderr.trim() || 'NOT RUN: isolated local account setup did not complete.');
      process.exitCode = provision.code;
      return;
    }
    console.log(provision.stdout.trim());
    console.log('PASS: local migration reset and separate fixture provisioning completed.');
    return;
  }
  const generated = await cli(['gen', 'types', 'typescript', '--local', '--schema', 'public'], 180_000);
  if (generated.code !== 0 || !generated.stdout.includes('export type Database =') || !generated.stdout.includes('item_images:')) {
    fail('NOT RUN: actual local schema type generation failed; the existing type file was not changed.');
  }
  const ts = await import('typescript');
  const parsed = ts.createSourceFile('database.types.ts', generated.stdout, ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length) fail('NOT RUN: generator output is not valid TypeScript; the existing type file was not changed.');
  const target = path.join(ROOT, 'src', 'data', 'database.types.ts');
  if (args[0] === '--check') {
    let existing;
    try { existing = await readFile(target, 'utf8'); }
    catch { fail('FAIL: generated database types are missing. Run npm run db:types against the real local stack.', 1); }
    if (existing !== generated.stdout) fail('FAIL: generated database types differ from the actual local schema.', 1);
    console.log('PASS: committed database types exactly match actual local generation.');
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.${randomUUID()}.pending`;
  try {
    await writeFile(staging, generated.stdout, { flag: 'wx' });
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
  console.log('PASS: src/data/database.types.ts generated from the actual local schema.');
}

main().catch(reportError);
