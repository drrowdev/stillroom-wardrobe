import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, assertNoServiceSecrets, readCredentialCache, normalSessionEnvironment,
  validateSessionEnvironment, fail, reportError,
} from './backend/local.mjs';
import { privilegedEnvironment, trackPhase } from './isolation-catalog.mjs';

async function main() {
  const [suite, ...args] = process.argv.slice(2);
  if (!['integration', 'security'].includes(suite) || args.length) fail('REFUSED: choose integration or security with no extra arguments.');
  assertNoServiceSecrets(process.env);
  if (process.env.ALLOW_SECURITY_TESTS !== '1') fail('NOT RUN: set ALLOW_SECURITY_TESTS=1 explicitly for disposable local tests.');
  const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD'];
  const explicit = names.some((name) => process.env[name]);
  const credentials = explicit ? process.env : await readCredentialCache();
  const env = normalSessionEnvironment(process.env, credentials);
  validateSessionEnvironment(env);
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) fail('NOT RUN: the local Auth service is not healthy; no test assertions ran.');
  } catch {
    fail('NOT RUN: the local Auth service is unavailable; no test assertions ran.');
  }
  const script = suite === 'security' ? ['security', 'rls.sessions.mjs'] : ['integration', 'local.sessions.mjs'];
  // No CLI status/admin request runs here. Only the normal-session allowlist reaches the child.
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', ...script)], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (code !== 0) { process.exitCode = code; return; }
  const aiCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'ai-controls.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (aiCode !== 0) { process.exitCode = aiCode; return; }
  const analysisCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'ai-analysis.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (analysisCode !== 0) { process.exitCode = analysisCode; return; }
  const saveCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'item-save.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (saveCode !== 0) { process.exitCode = saveCode; return; }
  const analyzedSaveCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'analyzed-save.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (analyzedSaveCode !== 0) { process.exitCode = analyzedSaveCode; return; }
  const lifecycleCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'item-lifecycle.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (lifecycleCode !== 0) { process.exitCode = lifecycleCode; return; }
  const imageChangeCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'image-replacement.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (imageChangeCode !== 0) { process.exitCode = imageChangeCode; return; }
  const outfitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'outfit-rpc.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (outfitCode !== 0) { process.exitCode = outfitCode; return; }
  if (suite === 'integration') {
    const recoveryCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test', '--config', path.join(ROOT, 'playwright.local.config.ts'),
      ], { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', () => resolve(2));
      child.on('close', (value) => resolve(value ?? 2));
    });
    if (recoveryCode !== 0) process.exitCode = recoveryCode;
  }
  if (suite === 'security') {
    const isolationCode = await isolationAudit(env);
    if (isolationCode !== 0) process.exitCode = isolationCode;
  }
}

// I17: the normal-session audit child holds all tokens; this controller runs only the closed privileged CLI.
const ISOLATION_DEADLINE_MS = 12 * 60_000, RESTORE_RESERVE_MS = 2 * 60_000, PHASE_MS = 60_000;
function runPrivileged(args, privileged, timeout) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'isolation-catalog.mjs'), ...args], {
      cwd: ROOT, env: privileged, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(() => child.kill(), Math.max(1_000, timeout));
    child.on('error', () => { clearTimeout(timer); resolve(2); });
    child.on('close', (value) => { clearTimeout(timer); resolve(value ?? 2); });
  });
}
async function isolationAudit(normalEnv) {
  const started = Date.now(), remaining = () => ISOLATION_DEADLINE_MS - (Date.now() - started);
  const privileged = privilegedEnvironment(process.env);
  const catalogCode = await runPrivileged(['catalog'], privileged, PHASE_MS);
  const touched = new Set();
  let queue = Promise.resolve();
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'security', 'isolation-audit.sessions.mjs')], {
    cwd: ROOT, env: normalEnv, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (message) => {
    queue = queue.then(async () => {
      const valid = message && message.type === 'phase' && Number.isSafeInteger(message.id)
        && (message.phase === 'barrier' ? message.owner === null
          : ['freeze', 'restore'].includes(message.phase) && ['A', 'B'].includes(message.owner));
      if (!valid) { if (child.connected) child.send({ type: 'ack', id: message?.id, ok: false }); return; }
      let ok = false;
      if (message.phase === 'barrier') {
        // Cleanup waits for this: every owner whose freeze was requested, acknowledged or not, is restored first.
        for (const owner of [...touched]) {
          const code = await runPrivileged(['restore', owner], privileged, Math.min(PHASE_MS, Math.max(1_000, remaining())));
          trackPhase(touched, 'restore', owner, 'after', code);
        }
        ok = touched.size === 0;
      } else {
        const budget = remaining() - (message.phase === 'freeze' ? RESTORE_RESERVE_MS : 0);
        if (budget > 0) {
          trackPhase(touched, message.phase, message.owner, 'before');
          const code = await runPrivileged([message.phase, message.owner], privileged, Math.min(PHASE_MS, budget));
          trackPhase(touched, message.phase, message.owner, 'after', code);
          ok = code === 0;
        }
      }
      if (child.connected) child.send({ type: 'ack', id: message.id, ok });
    });
  });
  const deadline = setTimeout(() => child.kill(), Math.max(1_000, remaining() - RESTORE_RESERVE_MS));
  const auditCode = await new Promise((resolve) => {
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  clearTimeout(deadline);
  await queue;
  let restoreCode = 0;
  for (const owner of touched) {
    // Restore runs even after an audit failure; both the primary and any restore failure are reported.
    const code = await runPrivileged(['restore', owner], privileged, PHASE_MS);
    if (code !== 0) { console.error(`FAIL: I17 approval restore for fictional owner ${owner} did not complete`); restoreCode = code; }
  }
  if (catalogCode !== 0) console.error('FAIL: I17 catalogue check failed');
  if (auditCode !== 0) console.error('FAIL: I17 normal-session isolation audit failed');
  return [catalogCode, auditCode, restoreCode].find((code) => code !== 0) ?? 0;
}

main().catch(reportError);
