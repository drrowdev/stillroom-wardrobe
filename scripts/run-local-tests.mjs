import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, assertNoServiceSecrets, readCredentialCache, normalSessionEnvironment,
  validateSessionEnvironment, fail, reportError,
} from './backend/local.mjs';

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
  const saveCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', suite, 'item-save.sessions.mjs')], {
      cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(2));
    child.on('close', (value) => resolve(value ?? 2));
  });
  if (saveCode !== 0) { process.exitCode = saveCode; return; }
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
}

main().catch(reportError);
