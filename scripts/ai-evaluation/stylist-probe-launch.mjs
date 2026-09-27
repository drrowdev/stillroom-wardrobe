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
// ---- Narrow child environments. Names are matched in any case, because Windows environment names are. ----
/** The only inherited variables either child receives: the OS basics a process, git and the home directory need. */
const BASIC = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER',
  'LOGNAME', 'LANG', 'LC_ALL'];
/** Azure CLI also gets its login location and, if set, the proxy (TLS verification still applies through a proxy). */
const AZURE_INHERITED = [...BASIC, 'AZURE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
/**
 * Set for every `az` call. Environment values override the operator's az config file, so file logging (which writes
 * DEBUG output whatever the console verbosity), telemetry, colour and progress output are off without changing any
 * global configuration.
 */
export const AZURE_FIXED = Object.freeze({
  AZURE_LOGGING_ENABLE_LOG_FILE: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_COLLECT_TELEMETRY: 'false',
  AZURE_CORE_NO_COLOR: 'true', AZURE_CORE_DISABLE_PROGRESS_BAR: 'true', AZURE_CORE_SURVEY_MESSAGE: 'false',
  AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
});
/** TLS-verification overrides, key logging, tracing and code injection: refused if inherited at all. */
export const REFUSED_VARIABLES = Object.freeze(['AZURE_CLI_DISABLE_CONNECTION_VERIFICATION', 'ADAL_PYTHON_SSL_NO_VERIFY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PYTHONHTTPSVERIFY', 'SSLKEYLOGFILE',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP',
  'PYTHONVERBOSE', 'PYTHONDEBUG', 'PYTHONINSPECT', 'PYTHONTRACEMALLOC', 'PYTHONDEVMODE', 'AZURE_CORE_LOG_LEVEL']);
function pick(base, names) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string' && names.includes(name.toUpperCase())) env[name] = value;
  }
  return env;
}
function assertSafeEnvironment(base) {
  if (Object.keys(base).some((name) => REFUSED_VARIABLES.includes(name.toUpperCase()))) throw new ProbeError('UNSAFE_ENVIRONMENT');
}
/** The whole environment of each `az` call. */
export function azureEnvironment(base) {
  assertSafeEnvironment(base);
  return { ...pick(base, AZURE_INHERITED), ...AZURE_FIXED };
}
/** The whole environment of the probe child: the OS basics plus the key, and nothing else. */
export function probeEnvironment(base, key) {
  assertSafeEnvironment(base);
  return { ...pick(base, BASIC), [PROBE.keyVariable]: key };
}

const AZ_PROGRAM = process.platform === 'win32' ? { file: 'cmd.exe', prefix: ['/d', '/s', '/c', 'az.cmd'] } : { file: 'az', prefix: [] };
/** Runs `az` with every argument checked to be free of shell metacharacters; output is captured, never printed. */
export function runAzure(args, env, program = AZ_PROGRAM) {
  if (!args.every((arg) => /^[A-Za-z0-9._-]+$/.test(arg))) return Promise.reject(new ProbeError('USAGE'));
  if (env?.AZURE_LOGGING_ENABLE_LOG_FILE !== 'false') return Promise.reject(new ProbeError('UNSAFE_ENVIRONMENT'));
  return new Promise((resolve, reject) => {
    execFile(program.file, [...program.prefix, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 65536, windowsHide: true, env },
      (error, stdout) => (error ? reject(new ProbeError('AZURE_CLI_FAILED')) : resolve(stdout)));
  });
}
function jsonString(text, code) {
  let value;
  try { value = JSON.parse(text); } catch { throw new ProbeError(code); }
  if (typeof value !== 'string') throw new ProbeError(code);
  return value;
}
const PROBE_PROGRAM = { file: process.execPath, prefix: [PROBE_SCRIPT] };
/** Starts the probe child; any start failure or signal is exit code 1. */
export function runChild(env, args, program = PROBE_PROGRAM) {
  return new Promise((resolve) => {
    const child = spawn(program.file, [...program.prefix, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** CI, the runtime and the inherited environment are checked before either Azure CLI call. */
export async function launch(args, { azure = runAzure, child = runChild, baseEnv = process.env, runtime = {} } = {}) {
  assertRuntime({ env: baseEnv, ...runtime });
  const { subscription, id, slot } = parseLauncherArguments(args);
  const azureEnv = azureEnvironment(baseEnv);
  const commands = azureCommands(subscription);
  let endpoint;
  try { endpoint = jsonString(await azure(commands.endpoint, azureEnv), 'RESOURCE_MISMATCH'); } catch { throw new ProbeError('RESOURCE_MISMATCH'); }
  let origin = null;
  try { origin = new URL(endpoint).origin; } catch { /* fixed error below */ }
  if (origin !== new URL(STYLIST_ENDPOINT).origin) throw new ProbeError('RESOURCE_MISMATCH');
  // The key lives only in this child environment object, which is wiped in finally.
  const holder = { env: null };
  try {
    let key;
    try { key = jsonString(await azure(commands.keys, azureEnv), 'KEY_RETRIEVAL_FAILED'); } catch { throw new ProbeError('KEY_RETRIEVAL_FAILED'); }
    if (!KEY.test(key)) throw new ProbeError('KEY_RETRIEVAL_FAILED');
    holder.env = probeEnvironment(baseEnv, key);
    return await child(holder.env, ['send', id, slot]);
  } finally {
    if (holder.env) delete holder.env[PROBE.keyVariable];
    holder.env = null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof ProbeError ? error.code : 'LAUNCH_FAILED');
    process.exitCode = 1;
  });
}
