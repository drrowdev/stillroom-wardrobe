// ST-OP secret-safe launcher (Q3). Reads the one intended key of the pinned Azure OpenAI resource through the Azure
// CLI, captured in memory, and passes it only in the environment of one `stylist-probe.mjs send` child. The key is never
// in arguments, files, logs or this process's own environment. Errors are fixed codes. On any retrieval failure it
// stops: it never rotates keys, changes RBAC or tries another resource.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLIST_ENDPOINT } from '../../src/domain/stylist.ts';
import { PROBE, ProbeError, SLOTS, assertRuntime } from './stylist-probe.mjs';

export const AZURE_TARGET = Object.freeze({ resourceGroup: 'rg-stillroom-ai-eval', resource: 'stillroom-ai-eval', keyName: 'key1' });
const PROBE_SCRIPT = fileURLToPath(new URL('./stylist-probe.mjs', import.meta.url));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[\x21-\x7e]{16,512}$/;

export function parseLauncherArguments(args) {
  const [flag, subscription, command, id, slot, ...rest] = args;
  if (flag !== '--subscription' || !GUID.test(subscription ?? '') || command !== 'send' || !/^[a-f0-9]{32}$/.test(id ?? '')
    || !SLOTS.includes(slot) || rest.length) throw new ProbeError('USAGE');
  return { subscription, id, slot };
}
/** The only two Azure CLI calls: a read of the resource endpoint and the key list. No debug or verbose output. */
export function azureCommands(subscription) {
  const target = ['--subscription', subscription, '--resource-group', AZURE_TARGET.resourceGroup, '--name', AZURE_TARGET.resource];
  return {
    endpoint: ['cognitiveservices', 'account', 'show', ...target, '--query', 'properties.endpoint', '--output', 'json', '--only-show-errors'],
    keys: ['cognitiveservices', 'account', 'keys', 'list', ...target, '--query', AZURE_TARGET.keyName, '--output', 'json', '--only-show-errors'],
  };
}
/** Runs `az` with every argument checked to be free of shell metacharacters; output is captured, never printed. */
export function runAzure(args) {
  if (!args.every((arg) => /^[A-Za-z0-9._-]+$/.test(arg))) return Promise.reject(new ProbeError('USAGE'));
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(windows ? 'cmd.exe' : 'az', windows ? ['/d', '/s', '/c', 'az.cmd', ...args] : args,
      { encoding: 'utf8', timeout: 60000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: 'true' } },
      (error, stdout) => (error ? reject(new ProbeError('AZURE_CLI_FAILED')) : resolve(stdout)));
  });
}
function jsonString(text, code) {
  let value;
  try { value = JSON.parse(text); } catch { throw new ProbeError(code); }
  if (typeof value !== 'string') throw new ProbeError(code);
  return value;
}
/** The child environment: the caller's, minus any inherited key, plus the key. Returned so `finally` can clear it. */
export function childEnvironment(base, key) {
  const env = { ...base };
  delete env[PROBE.keyVariable];
  env[PROBE.keyVariable] = key;
  return env;
}
function runChild(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE_SCRIPT, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function launch(args, { azure = runAzure, child = runChild, baseEnv = process.env } = {}) {
  const { subscription, id, slot } = parseLauncherArguments(args);
  const commands = azureCommands(subscription);
  let endpoint;
  try { endpoint = jsonString(await azure(commands.endpoint), 'RESOURCE_MISMATCH'); } catch { throw new ProbeError('RESOURCE_MISMATCH'); }
  let origin = null;
  try { origin = new URL(endpoint).origin; } catch { /* fixed error below */ }
  if (origin !== new URL(STYLIST_ENDPOINT).origin) throw new ProbeError('RESOURCE_MISMATCH');
  // The key lives only in this child environment object, which is wiped in finally.
  const holder = { env: null };
  try {
    let key;
    try { key = jsonString(await azure(commands.keys), 'KEY_RETRIEVAL_FAILED'); } catch { throw new ProbeError('KEY_RETRIEVAL_FAILED'); }
    if (!KEY.test(key)) throw new ProbeError('KEY_RETRIEVAL_FAILED');
    holder.env = childEnvironment(baseEnv, key);
    return await child(holder.env, ['send', id, slot]);
  } finally {
    if (holder.env) delete holder.env[PROBE.keyVariable];
    holder.env = null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    assertRuntime();
    process.exitCode = await launch(process.argv.slice(2));
  })().catch((error) => {
    console.error(error instanceof ProbeError ? error.code : 'LAUNCH_FAILED');
    process.exitCode = 1;
  });
}
