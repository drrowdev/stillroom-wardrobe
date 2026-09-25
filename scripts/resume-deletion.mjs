#!/usr/bin/env node
// Operator tool for existing account-deletion jobs. It never creates a job: `begin` belongs to the owner's
// re-authenticated Edge request. The service key is read from a hidden terminal prompt only.
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runDeletion } from '../supabase/functions/_shared/deletion-loop.ts';
import { createCall, serviceDeps } from '../supabase/functions/_shared/deletion-service.ts';

export const USAGE = `Usage:
  node scripts/resume-deletion.mjs --url <project URL> --owner <uuid>                 resume an existing job
  node scripts/resume-deletion.mjs --url <project URL> --owner <uuid> --grant --confirm <uuid>
  node scripts/resume-deletion.mjs --url <project URL> --owner <uuid> --reconcile
  node scripts/resume-deletion.mjs --url <project URL> --purge-completed`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URL_PATTERN = /^(?:https:\/\/[a-z0-9]{20}\.supabase\.co|http:\/\/127\.0\.0\.1:(?:54321|55321))$/;
const SECRET_ENV = /SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)/i;
export const RUN_BUDGET_MS = 100000;

export class OperatorError extends Error {}

/** Parses the closed argument set; anything else is refused before any prompt or network call. */
export function parseArgs(argv) {
  const out = { url: null, owner: null, action: 'resume', confirm: null };
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) throw new OperatorError(`Repeated ${arg}.`);
    flags.add(arg);
    if (arg === '--url' || arg === '--owner' || arg === '--confirm') {
      const value = argv[index + 1];
      if (value === undefined) throw new OperatorError(`${arg} needs a value.`);
      index += 1;
      out[arg.slice(2)] = value;
    } else if (arg === '--grant' || arg === '--reconcile' || arg === '--purge-completed') {
      if (out.action !== 'resume') throw new OperatorError('Choose one action.');
      out.action = arg === '--purge-completed' ? 'purge' : arg.slice(2);
    } else {
      throw new OperatorError(`Unknown argument ${arg}.`);
    }
  }
  if (!out.url || !URL_PATTERN.test(out.url)) throw new OperatorError('--url must be the exact project API URL.');
  if (out.action === 'purge') {
    if (out.owner !== null || out.confirm !== null) throw new OperatorError('--purge-completed takes no owner.');
  } else if (!out.owner || !UUID.test(out.owner)) {
    throw new OperatorError('--owner must be the account UUID.');
  }
  if (out.action === 'grant' ? out.confirm !== out.owner : out.confirm !== null) {
    throw new OperatorError('--grant needs --confirm with the same UUID; other actions take no --confirm.');
  }
  return out;
}

export function assertNoSecretEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (SECRET_ENV.test(key)) throw new OperatorError('Unset service credentials in the environment; the key is read from the prompt.');
  }
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new OperatorError('The service key must be typed at a terminal prompt.');
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') { process.stdin.off('data', onData); resolve(value); return; }
          if (char === '\u0003') { process.stdin.off('data', onData); reject(new OperatorError('Cancelled.')); return; }
          if (char === '\u007f') value = value.slice(0, -1); else value += char;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
  }
}

async function rpc(call, key, name, body) {
  const got = await call(`/rest/v1/rpc/${name}`, { method: 'POST', bearer: key, key, body }, 10000);
  if (!got) return { ok: false, text: 'no response' };
  const text = await got.response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { /* not JSON */ }
  return got.response.ok ? { ok: true, value } : { ok: false, text: typeof value?.message === 'string' ? value.message : `HTTP ${got.response.status}` };
}

/** Runs one parsed action with an injected call; prints only states, stages and counts. */
export async function operate(options, key, call, log = console.log) {
  if (options.action === 'purge') {
    const result = await rpc(call, key, 'purge_deletion_receipts', {});
    if (!result.ok) throw new OperatorError(`Purge failed: ${result.text}`);
    log(`Purged ${Number(result.value)} completed receipt(s).`);
    return 0;
  }
  if (options.action === 'grant' || options.action === 'reconcile') {
    const result = await rpc(call, key, 'deletion_control', { p_owner_id: options.owner, p_action: options.action, p_op: null, p_code: null });
    if (!result.ok) throw new OperatorError(`${options.action} refused: ${result.text}`);
    log(`${options.action}: stage=${result.value?.stage} attempts=${result.value?.attempts} grants=${result.value?.grants}`);
    return 0;
  }
  const deps = { ...serviceDeps(options.owner, key, call), now: Date.now };
  const state = await runDeletion(deps, options.owner, 'resume', randomUUID(), Date.now() + RUN_BUDGET_MS);
  log(`resume: ${state}`);
  return state === 'complete' ? 0 : 3;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertNoSecretEnvironment(process.env);
  const key = await promptSecret('Service key (hidden): ');
  if (!key || key.length > 8192) throw new OperatorError('No service key.');
  return operate(options, key, createCall(options.url));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof OperatorError ? `REFUSED: ${error.message}\n${USAGE}` : 'FAILED: unexpected error.');
    process.exitCode = 2;
  });
}
