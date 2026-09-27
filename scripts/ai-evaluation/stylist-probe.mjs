// ST-OP: the approved gate-5 stylist probe (issue #84). Exactly two direct calls, `min` then `max`, with the exact body
// the stylist-chat Edge function would send for two synthetic, non-personal requests. The body builder, response
// classifier and usage observer are the production modules, imported directly (Node strips their types). No Supabase
// client, database URL or hosted access: the D1 allocation is a separate coordinator SQL step whose receipt `init`
// checks for shape and arithmetic only. The operator record is cooperative, not tamper-proof.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STYLIST_BODY_CONTROLS, STYLIST_LIMITS, STYLIST_MANIFEST, STYLIST_RESERVATION_MICRO, STYLIST_REVIEW_EXPIRES, STYLIST_SETTINGS,
  STYLIST_ENDPOINT, buildStylistRequest, claimedCandidate, conversationBytes, parseStylistBody, parseStylistItem, stylistEligible,
  utf8Bytes, validateStylistReply,
} from '../../src/domain/stylist.ts';
import { callStylist } from '../../supabase/functions/stylist-chat/azure.ts';
import { validAzureUsage } from '../../supabase/functions/analyze-clothing/azure-openai.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const SLOTS = Object.freeze(['min', 'max']);
export const PROBE = Object.freeze({
  id: 'st-op-probe-1',
  manifestId: STYLIST_MANIFEST,
  valuationMicro: Number(STYLIST_RESERVATION_MICRO),
  minAllocationMicro: 2 * Number(STYLIST_RESERVATION_MICRO),
  maxAllocationMicro: 260000,
  maxMessagesBytesFloor: 19950,
  calibrationInputTokens: 20000,
  shortCoInputRate: 220,
  shortCoOutputRate: 1320,
  keyVariable: 'STILLROOM_AZURE_PROBE_KEY',
});
const ACCEPTED_MODELS = ['expected_snapshot', 'model_family', 'deployment_alias'];
export const SOURCE_PATHS = Object.freeze([
  'scripts/ai-evaluation/stylist-probe.mjs', 'scripts/ai-evaluation/stylist-probe-launch.mjs', 'src/domain/stylist.ts',
  'supabase/functions/stylist-chat/azure.ts', 'supabase/functions/analyze-clothing/azure-openai.ts',
  'supabase/functions/analyze-clothing/protocol.ts', '.node-version',
]);
const LEDGER = 'probe.jsonl';
const LOCK = 'probe.lock';
const PENDING = 'probe.pending';
const PENDING_LIMIT = 256;
const LEDGER_LIMIT = 65536;
/** Recognised CI markers, matched by name in any case and with any value. There is no bypass. */
export const CI_VARIABLES = Object.freeze(['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'TF_BUILD', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI',
  'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'APPVEYOR', 'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER', 'DRONE', 'RUNNER_TEMP']);
const RECEIPT_LIMIT = 8192;

export class ProbeError extends Error {
  constructor(code, cleanupCode = null) {
    super(cleanupCode ? `${code}; ${cleanupCode}` : code);
    this.code = code;
    this.cleanupCode = cleanupCode;
  }
}
function requireThat(condition, code) {
  if (!condition) throw new ProbeError(code);
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const micro = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const hex64 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isoTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => digest(JSON.stringify(value));
export const utcMonth = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Not in CI; the pinned Node from `.node-version`; and no preload, tracing, debugging or TLS override. */
export function assertRuntime({ versions = process.versions, execArgv = process.execArgv, env = process.env } = {}) {
  requireThat(!Object.keys(env).some((name) => CI_VARIABLES.includes(name.toUpperCase())), 'CI_ENVIRONMENT_REFUSED');
  const pinned = readFileSync(path.join(REPO, '.node-version'), 'utf8').trim();
  requireThat(versions.node === pinned, 'PINNED_NODE_REQUIRED');
  requireThat(execArgv.length === 0 && ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_V8_COVERAGE', 'SSLKEYLOGFILE',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_REPL_EXTERNAL_MODULE', 'UV_THREADPOOL_SIZE']
    .every((name) => !env[name]), 'TRACING_OR_PRELOAD_REFUSED');
}

// ---- Synthetic fixtures: fixed, non-personal, no owner ID. ----
const requestId = (n) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const itemId = (n) => `20000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** Used only in-process, for the handler's eligibility recheck; never sent. */
const FIXTURE_OWNER = '30000000-0000-4000-8000-000000000000';
const CATEGORIES = ['top', 'bottom', 'footwear', 'layer', 'outerwear', 'one_piece', 'accessory'];
function item(id, category, fields = {}) {
  return { id, category, colours: ['navy'], pattern: 'solid', sleeve_length: null, garment_length: null, seasons: ['autumn'],
    formality: 1, warmth: 2, min_temp: null, max_temp: null, rain_rating: null, windproof: null, upper_coverage: null,
    lower_coverage: null, favourite: false, ...fields };
}
const minItems = () => [
  item(itemId(1), 'top', { sleeve_length: 'long', upper_coverage: 2 }),
  item(itemId(2), 'bottom', { garment_length: 'long', lower_coverage: 2, colours: ['beige'] }),
  item(itemId(3), 'footwear', { colours: ['brown'] }),
];
/** 500 items, the claim maximum, with every field at its longest value and eligible for the max weather. */
const maxItems = () => Array.from({ length: STYLIST_LIMITS.items }, (_, index) => item(itemId(index + 1), CATEGORIES[index % CATEGORIES.length], {
  colours: ['light_blue', 'burgundy', 'silver'], pattern: 'abstract', sleeve_length: 'three_quarter', garment_length: 'regular',
  seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 2 + (index % 3), warmth: 3, min_temp: -10, max_temp: 25,
  rain_rating: 2, windproof: false, upper_coverage: 2, lower_coverage: 2, favourite: index % 5 === 0,
}));
const fill = (base, points, filler) => {
  let text = base;
  while ([...text].length < points) text += filler;
  return [...text].slice(0, points).join('');
};
/** Maximum-length Unicode with JSON escaping: quotes, a backslash, a newline, 2-, 3- and 4-byte characters. */
const MAX_MESSAGE = fill('What should I wear for a "smart" dinner at 8 °C with rain \\ wind?\nToivon jotain lämmintä, gärna ull. ',
  STYLIST_LIMITS.message, '👗🧥👢');
const ids = (from, count) => Array.from({ length: count }, (_, index) => itemId(from + index));
function maxBody(pad) {
  // 36 outfit references (the history maximum) to 12 distinct items, repeated across outfits and turns.
  return {
    requestId: requestId(2), message: MAX_MESSAGE,
    history: [
      { role: 'user', text: fill('Mitä laitan töihin huomenna? Något "enkelt" men snyggt. ', 300, 'ä') },
      { role: 'assistant', text: fill('Try one of these; the second is warmer. ', 400, 'é'), outfits: [ids(1, 12), ids(1, 12)] },
      { role: 'user', text: fill('And with \\ boots? ', 300, '🥾') },
      { role: 'assistant', text: fill('This keeps the same coat. ', 300, 'ö'), outfits: [ids(1, 12)] },
      { role: 'user', text: `${fill('Something for the weekend too. ', 120, 'å')}${' ok'.repeat(200).slice(0, pad)}` },
      { role: 'assistant', text: fill('Tell me the occasion and I will pick. ', 200, 'ü') },
    ],
    occasion: 'smart', season: 'autumn',
    weather: { setting: 'outdoors', temperatureC: 8, rainProbability: 60, windMetresPerSecond: 7 },
  };
}
const MIN_BODY = () => ({ requestId: requestId(1), message: 'What should I wear today?', history: [], occasion: 'everyday',
  season: 'autumn', weather: null });

/**
 * One fixture through the production ingress checks (closed body parse, ingress, message, history and conversation
 * limits, item parsing and the stylist eligibility recheck) and the production builder. Throws FIXTURE_INVALID.
 */
function checkedFixture(body, items) {
  const raw = JSON.stringify(body);
  const ingressBytes = utf8Bytes(raw);
  requireThat(ingressBytes <= STYLIST_LIMITS.bodyBytes, 'FIXTURE_INVALID');
  const input = parseStylistBody(JSON.parse(raw));
  requireThat(input !== null && JSON.stringify(input) === raw, 'FIXTURE_INVALID');
  requireThat(conversationBytes(input) <= STYLIST_LIMITS.conversationBytes && items.length <= STYLIST_LIMITS.items, 'FIXTURE_INVALID');
  requireThat(items.every((entry) => {
    const parsed = parseStylistItem(entry);
    return parsed !== null && stylistEligible(claimedCandidate(FIXTURE_OWNER, parsed), { ownerId: FIXTURE_OWNER, weather: input.weather });
  }), 'FIXTURE_INVALID');
  let built;
  try { built = buildStylistRequest(input, items); } catch { throw new ProbeError('FIXTURE_INVALID'); }
  const keys = [...Object.keys(STYLIST_BODY_CONTROLS), 'messages', 'response_format'];
  requireThat(exact(built.body, keys) && Array.isArray(built.body.messages)
    && built.body.messages.length <= STYLIST_LIMITS.messageCount
    && JSON.stringify(built.body.prompt_cache_options) === '{"mode":"explicit"}'
    && built.messagesBytes === utf8Bytes(JSON.stringify(built.body.messages))
    && built.messagesBytes <= STYLIST_LIMITS.messagesBytes && built.trimmedOutfits === 0, 'FIXTURE_INVALID');
  return { input, built, ingressBytes, conversationBytes: conversationBytes(input) };
}
/**
 * The two probe requests. The max fixture is tuned offline, by pure computation and no calls: the ASCII padding in
 * one history turn fills the gap the builder leaves after the last item that fits, so `messages` lands within
 * 19,950–20,000 UTF-8 bytes.
 */
export function fixture(slot) {
  requireThat(SLOTS.includes(slot), 'INVALID_SLOT');
  if (slot === 'min') return checkedFixture(MIN_BODY(), minItems());
  const items = maxItems();
  const untuned = checkedFixture(maxBody(0), items);
  const gap = STYLIST_LIMITS.messagesBytes - untuned.built.messagesBytes;
  const tuned = gap > STYLIST_LIMITS.messagesBytes - PROBE.maxMessagesBytesFloor ? checkedFixture(maxBody(gap - 20), items) : untuned;
  requireThat(tuned.built.messagesBytes >= PROBE.maxMessagesBytesFloor, 'FIXTURE_INVALID');
  return tuned;
}
export const bodyDigest = (slot) => jsonDigest(fixture(slot).built.body);
export const settingsDigest = () => jsonDigest(STYLIST_SETTINGS);
export function controlsDigest() {
  return jsonDigest({ probe: PROBE, settings: settingsDigest(), endpoint: STYLIST_ENDPOINT, bodies: { min: bodyDigest('min'), max: bodyDigest('max') } });
}

// ---- D1 allocation receipt (coordinator SQL, not verifiable here). ----
const RECEIPT_KEYS = ['kind', 'ownerRef', 'allocationMicro', 'reply', 'readBack', 'allocatedAt', 'approvalRef'];
export function validateReceipt(value) {
  requireThat(exact(value, RECEIPT_KEYS) && value.kind === 'stylist-probe-allocation-v1' && hex64(value.ownerRef)
    && micro(value.allocationMicro) && exact(value.reply, ['code', 'previousTotalMicro', 'newTotalMicro']) && value.reply.code === 'OK'
    && micro(value.reply.previousTotalMicro) && micro(value.reply.newTotalMicro)
    && exact(value.readBack, ['monthlyAllowanceMicro', 'stylistMonthlyAllowanceMicro'])
    && micro(value.readBack.monthlyAllowanceMicro) && micro(value.readBack.stylistMonthlyAllowanceMicro)
    && isoTime(value.allocatedAt)
    && typeof value.approvalRef === 'string'
    && /^https:\/\/github\.com\/drrowdev\/stillroom-wardrobe\/(?:issues|pull)\/[1-9][0-9]{0,6}#issuecomment-[1-9][0-9]{0,15}$/.test(value.approvalRef),
  'RECEIPT_INVALID');
  const allocation = BigInt(value.allocationMicro), previous = BigInt(value.reply.previousTotalMicro), next = BigInt(value.reply.newTotalMicro);
  requireThat(allocation >= BigInt(PROBE.minAllocationMicro) && allocation <= BigInt(PROBE.maxAllocationMicro)
    && previous - allocation === next && BigInt(value.readBack.monthlyAllowanceMicro) === next
    && BigInt(value.readBack.stylistMonthlyAllowanceMicro) <= next, 'RECEIPT_ARITHMETIC');
  return value;
}
/**
 * One canonical run record per hosted allocation transition: owner, UTC month and the before/after totals. A second
 * receipt for the same transition (a copy, another directory, another process) maps to the same record and is refused.
 */
export function allocationId(receipt) {
  return jsonDigest({ domain: 'st-op-allocation-v1', ownerRef: receipt.ownerRef, month: receipt.allocatedAt.slice(0, 7),
    previous: receipt.reply.previousTotalMicro, allocation: receipt.allocationMicro, next: receipt.reply.newTotalMicro }).slice(0, 32);
}

// ---- Private operator root and the append-only record. ----
/** The fixed private operator root. Tests pass their own root; the CLI always uses this one. */
export const operatorRoot = () => path.join(os.homedir(), '.stillroom-operator', 'stylist-probe');
async function privateDirectory(filename) {
  requireThat(typeof filename === 'string' && path.isAbsolute(filename), 'PRIVATE_PATH_INVALID');
  const stat = await lstat(filename).catch(() => null);
  requireThat(stat !== null && !stat.isSymbolicLink() && stat.isDirectory(), 'PRIVATE_PATH_INVALID');
  const resolved = await realpath(filename);
  const rel = path.relative(await realpath(REPO), resolved);
  requireThat(rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)), 'PRIVATE_PATH_IN_REPOSITORY');
  requireThat(!/(^|[\\/])\.copilot[\\/]session-state([\\/]|$)/i.test(resolved), 'PRIVATE_PATH_IN_AGENT_SESSION');
  return resolved;
}
async function boundedFile(filename, limit) {
  const stat = await lstat(filename).catch(() => null);
  requireThat(stat !== null && !stat.isSymbolicLink() && stat.isFile(), 'PRIVATE_PATH_INVALID');
  const handle = await open(filename, 'r');
  try {
    requireThat((await handle.stat()).size <= limit, 'FILE_BOUND');
    const data = Buffer.alloc(limit + 1);
    let used = 0;
    while (used <= limit) {
      const { bytesRead } = await handle.read(data, used, data.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    requireThat(used <= limit, 'FILE_BOUND');
    return data.subarray(0, used);
  } finally { await handle.close(); }
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ProbeError('INVALID_JSON'); }
}
async function locked(directory, operation) {
  const lock = path.join(directory, LOCK);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    throw new ProbeError(error?.code === 'EEXIST' ? 'LOCKED_NO_AUTOMATIC_RECOVERY' : 'LOCK_FAILED');
  }
  let result, failed = false, primary, retain = false;
  try { result = await operation(); }
  catch (error) {
    // A failed sync or close is not evidence either way; the lock stays until the operator checks the record.
    retain = !(error instanceof ProbeError) || error.code === 'LEDGER_WRITE_UNCERTAIN';
    failed = true;
    primary = error;
  }
  if (!retain) {
    try { await rmdir(lock); }
    catch {
      throw primary instanceof ProbeError ? new ProbeError(primary.code, 'LOCK_RELEASE_FAILED') : new ProbeError('LOCK_RELEASE_FAILED');
    }
  }
  if (failed) throw primary;
  return result;
}
async function writeSynced(fs, filename, flags, text) {
  let handle, ok = true;
  try {
    handle = await fs.open(filename, flags, 0o600);
    if (text !== null) await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch { ok = false; }
  if (handle) {
    try { await handle.close(); } catch { ok = false; }
  }
  return ok;
}
/**
 * The pending marker is synced before the ledger line and removed only after that line is synced and closed. A failed
 * sync or close therefore leaves the marker, so the record stays UNRESOLVED even if the lock is removed by hand; only
 * `recover` clears it.
 */
async function append(directory, event, initial = false, fs = { open }) {
  const marker = path.join(directory, PENDING);
  const pending = `${JSON.stringify({ type: event.type, slot: event.slot ?? null })}\n`;
  if (!await writeSynced(fs, marker, 'wx', pending)) throw new ProbeError('LEDGER_WRITE_UNCERTAIN');
  const flags = initial ? 'wx' : constants.O_WRONLY | constants.O_APPEND;
  if (!await writeSynced(fs, path.join(directory, LEDGER), flags, `${JSON.stringify(event)}\n`)) throw new ProbeError('LEDGER_WRITE_UNCERTAIN');
  try { await (fs.unlink ?? unlink)(marker); } catch { throw new ProbeError('LEDGER_WRITE_UNCERTAIN'); }
}
const present = async (filename) => (await lstat(filename).catch(() => null)) !== null;
async function persistenceState(directory) {
  const marker = await pendingMarker(directory);
  requireThat(marker?.type !== 'init', 'ALLOCATION_UNUSABLE');
  return { pending: marker !== null, locked: await present(path.join(directory, LOCK)) };
}
/** The pending marker's recorded event, `{ unknown: true }` if it is unreadable, or null if there is none. */
async function pendingMarker(directory) {
  const filename = path.join(directory, PENDING);
  if (!await present(filename)) return null;
  try {
    const value = parseJson(await boundedFile(filename, PENDING_LIMIT));
    if (exact(value, ['type', 'slot']) && ['init', 'intent', 'result', 'reconcile', 'recover'].includes(value.type)
      && (value.slot === null || SLOTS.includes(value.slot))) return value;
  } catch { /* unreadable below */ }
  return { unknown: true };
}

/** The checkout's commit; every probe source file must be tracked and unmodified. */
export function gitSource(repo = REPO) {
  const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  let commit, changes;
  try {
    commit = run(['rev-parse', 'HEAD']);
    changes = run(['status', '--porcelain', '--', ...SOURCE_PATHS]);
  } catch { throw new ProbeError('SOURCE_UNKNOWN'); }
  requireThat(/^[a-f0-9]{40}$/.test(commit), 'SOURCE_UNKNOWN');
  requireThat(changes === '', 'SOURCE_DIRTY');
  return commit;
}
function allocationOpen(receipt, now) {
  requireThat(now < STYLIST_REVIEW_EXPIRES, 'REVIEW_EXPIRED');
  requireThat(utcMonth(now) === receipt.allocatedAt.slice(0, 7), 'ALLOCATION_MONTH_ENDED');
}

/** Records the allocation in its canonical run record. Sends nothing. */
export async function initialize({ root, receipt, now = Date.now, source = gitSource }) {
  validateReceipt(receipt);
  const time = now();
  requireThat(Date.parse(receipt.allocatedAt) <= time, 'RECEIPT_INVALID');
  allocationOpen(receipt, time);
  const controls = controlsDigest();
  const commit = source();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await privateDirectory(root);
  const id = allocationId(receipt);
  const directory = path.join(base, id);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { throw new ProbeError(error?.code === 'EEXIST' ? 'ALLOCATION_ALREADY_RECORDED' : 'LOCAL_IO_FAILURE'); }
  await locked(directory, () => append(directory, {
    type: 'init', allocationId: id, receipt, controls, source: { commit, node: process.versions.node },
    manifestId: STYLIST_MANIFEST, settingsDigest: settingsDigest(), bodies: { min: bodyDigest('min'), max: bodyDigest('max') },
    time: new Date(time).toISOString(),
  }, true));
  return id;
}

const STATES = ['OK', 'FAILED', 'HALTED', 'NOT_SENT'];
const REASONS = {
  OK: ['OK'], FAILED: ['FILTERED', 'RESPONSE_FAILED', 'REPLY_INVALID'],
  HALTED: ['NETWORK_UNCERTAIN', 'RESPONSE_UNUSABLE', 'USAGE_INVALID', 'MODEL_ANOMALY', 'CONTROL_ANOMALY', 'INPUT_ENVELOPE', 'OUTPUT_ENVELOPE'],
  NOT_SENT: ['ALLOCATION_MONTH_ENDED', 'REVIEW_EXPIRED'],
};
const OBSERVATION_KEYS = ['state', 'reason', 'httpStatus', 'code', 'usage', 'reply', 'messagesBytes', 'included', 'omitted',
  'startedAt', 'finishedAt', 'elapsedMs', 'estimateMicro'];
const USAGE_KEYS = ['modelObservation', 'controlObservation', 'input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite'];
function validObservation(o) {
  if (!exact(o, OBSERVATION_KEYS) || !STATES.includes(o.state) || !REASONS[o.state].includes(o.reason)) return false;
  const sent = o.state !== 'NOT_SENT';
  if (!sent) return o.httpStatus === null && o.code === null && o.usage === null && o.reply === null && o.startedAt === null
    && o.finishedAt === null && o.elapsedMs === null && o.estimateMicro === null && uint(o.messagesBytes);
  return (o.httpStatus === null || (uint(o.httpStatus) && o.httpStatus >= 100 && o.httpStatus <= 599))
    && (o.code === null || ['OK', 'FAILED', 'FILTERED'].includes(o.code))
    && (o.usage === null || (exact(o.usage, USAGE_KEYS) && USAGE_KEYS.slice(2).every((key) => o.usage[key] === null || uint(o.usage[key]))))
    && (o.reply === null || (exact(o.reply, ['bytes', 'sha256', 'valid', 'outfits', 'dropped']) && uint(o.reply.bytes)
      && hex64(o.reply.sha256) && typeof o.reply.valid === 'boolean' && uint(o.reply.outfits) && uint(o.reply.dropped)))
    && uint(o.messagesBytes) && uint(o.included) && uint(o.omitted) && isoTime(o.startedAt) && isoTime(o.finishedAt) && uint(o.elapsedMs)
    && (o.estimateMicro === null || micro(o.estimateMicro))
    && (o.state !== 'OK' || (o.code === 'OK' && o.reply?.valid === true && o.estimateMicro !== null));
}
/** Reads and checks the whole record. Any unexpected event, digest or order refuses. */
export async function readRecord({ root, id, source = gitSource, readLedger = boundedFile }) {
  requireThat(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), 'USAGE');
  const directory = await privateDirectory(path.join(await privateDirectory(root), id));
  // Persistence is checked on both sides of the ledger read, so a write that overlaps it can't look confirmed.
  const before = await persistenceState(directory);
  const raw = await readLedger(path.join(directory, LEDGER), LEDGER_LIMIT);
  const after = await persistenceState(directory);
  const persistence = { pending: before.pending || after.pending, locked: before.locked || after.locked };
  requireThat(raw.length > 0 && raw.at(-1) === 10, persistence.pending ? 'PERSISTENCE_UNCERTAIN' : 'LEDGER_TORN');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(raw).slice(0, -1).split('\n');
  requireThat(lines.length >= 1 && lines.length <= 9, 'LEDGER_INVALID');
  const events = lines.map((line) => parseJson(Buffer.from(line)));
  const init = events[0];
  requireThat(exact(init, ['type', 'allocationId', 'receipt', 'controls', 'source', 'manifestId', 'settingsDigest', 'bodies', 'time'])
    && init.type === 'init' && init.allocationId === id && exact(init.source, ['commit', 'node']) && isoTime(init.time), 'LEDGER_INVALID');
  validateReceipt(init.receipt);
  requireThat(allocationId(init.receipt) === id, 'LEDGER_INVALID');
  requireThat(init.controls === controlsDigest() && init.manifestId === STYLIST_MANIFEST && init.settingsDigest === settingsDigest()
    && exact(init.bodies, SLOTS) && init.bodies.min === bodyDigest('min') && init.bodies.max === bodyDigest('max'), 'LEDGER_CONFIG_CHANGED');
  requireThat(source() === init.source.commit, 'SOURCE_CHANGED');
  const allocation = Number(init.receipt.allocationMicro);
  const slots = { min: null, max: null };
  let cumulative = 0;
  for (const event of events.slice(1)) {
    requireThat(object(event) && SLOTS.includes(event.slot), 'LEDGER_INVALID');
    const slot = slots[event.slot];
    if (event.type === 'intent') {
      requireThat(exact(event, ['type', 'slot', 'bodyDigest', 'valuationMicro', 'cumulativeMicro', 'time']) && slot === null
        && event.bodyDigest === init.bodies[event.slot] && event.valuationMicro === PROBE.valuationMicro
        && event.cumulativeMicro === cumulative + PROBE.valuationMicro && event.cumulativeMicro <= allocation && isoTime(event.time)
        && (event.slot === 'min' ? slots.max === null : slotState(slots.min) === 'OK'), 'LEDGER_INVALID');
      cumulative = event.cumulativeMicro;
      slots[event.slot] = { intent: event, result: null, reconciled: false, recovered: false };
    } else if (event.type === 'result') {
      requireThat(exact(event, ['type', 'slot', 'observation', 'time']) && slot && !slot.result && !slot.reconciled && !slot.recovered
        && validObservation(event.observation) && isoTime(event.time), 'LEDGER_INVALID');
      slot.result = event.observation;
    } else if (event.type === 'recover') {
      requireThat(exact(event, ['type', 'slot', 'time']) && isoTime(event.time) && !slot?.recovered, 'LEDGER_INVALID');
      if (slot) slot.recovered = true;
      else {
        // The intent line may never have reached the ledger; the slot is still consumed at the full valuation.
        requireThat(cumulative + PROBE.valuationMicro <= allocation, 'LEDGER_INVALID');
        cumulative += PROBE.valuationMicro;
        slots[event.slot] = { intent: null, result: null, reconciled: false, recovered: true };
      }
    } else {
      requireThat(event.type === 'reconcile' && exact(event, ['type', 'slot', 'resolution', 'time']) && event.resolution === 'counted'
        && slot && !slot.result && !slot.reconciled && !slot.recovered && isoTime(event.time), 'LEDGER_INVALID');
      slot.reconciled = true;
    }
  }
  return { directory, init, slots, cumulative, persistence };
}

/** A recovered slot is counted whatever its visible result says: a result written under a failed sync is untrusted. */
const slotState = (slot) => !slot ? 'UNUSED' : slot.recovered ? 'COUNTED' : slot.result ? slot.result.state
  : slot.reconciled ? 'COUNTED' : 'UNCERTAIN_INTENT';
/**
 * PASS only when both calls returned valid, in-envelope results, every write was confirmed, and the maximum request
 * used at most 20,000 input tokens. Reconciliation and recovery never create a success.
 */
export function verdict(record) {
  if (record.persistence.pending || record.persistence.locked) return 'UNRESOLVED';
  const min = slotState(record.slots.min), max = slotState(record.slots.max);
  if (min === 'UNCERTAIN_INTENT' || max === 'UNCERTAIN_INTENT') return 'UNRESOLVED';
  if (min === 'OK' && max === 'OK') return record.slots.max.result.usage.input <= PROBE.calibrationInputTokens ? 'PASS' : 'REVISE_ENVELOPE';
  if (min === 'UNUSED' || (min === 'OK' && max === 'UNUSED')) return 'INCOMPLETE';
  return 'HALTED';
}
export function summary(record) {
  return {
    probe: PROBE.id, allocationId: record.init.allocationId, manifestId: record.init.manifestId,
    sourceCommit: record.init.source.commit, runtime: `node ${record.init.source.node}`,
    allocationMicro: record.init.receipt.allocationMicro, allocationMonth: record.init.receipt.allocatedAt.slice(0, 7),
    consumedMicro: String(record.cumulative),
    persistence: { ...record.persistence },
    observedEstimateMicro: String(SLOTS.reduce((sum, name) => sum + Number(record.slots[name]?.result?.estimateMicro ?? 0), 0)),
    slots: Object.fromEntries(SLOTS.map((name) => {
      const slot = record.slots[name];
      return [name, { ...(slot?.result ?? {}), state: slotState(slot), recovered: slot?.recovered ?? false,
        bodyDigest: record.init.bodies[name], intentAt: slot?.intent?.time ?? null }];
    })),
    verdict: verdict(record),
    notes: {
      allocation: 'USD operational allocation at the conservative LongCo valuation; not the Azure budget, which is in billing currency.',
      hosted: 'This script cannot verify the hosted allocation; the coordinator read-back is the gate.',
      meaning: 'Route, schema and control observations and token calibration at two synthetic sizes only. Not a token-bound proof, '
        + 'a quality evaluation, an RLS test or a hosted Edge test.',
      record: 'Cooperative local record, not tamper-proof.',
      persistence: 'UNRESOLVED while a write is unconfirmed (pending marker) or the lock is held; run recover, which counts the slot.',
    },
  };
}

function estimate(usage) {
  return String(Math.ceil((usage.input * PROBE.shortCoInputRate + usage.output * PROBE.shortCoOutputRate) / 100));
}
/** Classification order: transport and metering first, then model and control, then the envelope, then the reply. */
export function observe({ outcome, httpStatus, built, startedAt, finishedAt, elapsedMs }) {
  const base = { httpStatus, code: outcome?.code ?? null, usage: outcome ? { ...outcome.usage } : null, reply: null,
    messagesBytes: built.messagesBytes, included: built.included, omitted: built.omitted, startedAt, finishedAt, elapsedMs, estimateMicro: null };
  const halt = (reason) => ({ state: 'HALTED', reason, ...base });
  if (!outcome) return halt('NETWORK_UNCERTAIN');
  if (outcome.unusable) return halt('RESPONSE_UNUSABLE');
  const usage = outcome.usage;
  if (!validAzureUsage(usage)) return halt('USAGE_INVALID');
  base.estimateMicro = estimate(usage);
  if (!ACCEPTED_MODELS.includes(usage.modelObservation)) return halt('MODEL_ANOMALY');
  if (usage.controlObservation !== 'ordinary' || usage.cacheRead !== 0 || usage.cacheWrite !== 0) return halt('CONTROL_ANOMALY');
  if (usage.input > STYLIST_LIMITS.inputTokens) return halt('INPUT_ENVELOPE');
  if (usage.output > STYLIST_LIMITS.outputTokens) return halt('OUTPUT_ENVELOPE');
  if (outcome.code === 'FILTERED') return { state: 'FAILED', reason: 'FILTERED', ...base };
  if (outcome.code !== 'OK') return { state: 'FAILED', reason: 'RESPONSE_FAILED', ...base };
  const parsed = validateStylistReply(outcome.content, built.aliases);
  base.reply = { bytes: utf8Bytes(outcome.content), sha256: digest(outcome.content), valid: parsed !== null,
    outfits: parsed?.outfits.length ?? 0, dropped: parsed?.dropped ?? 0 };
  return parsed ? { state: 'OK', reason: 'OK', ...base } : { state: 'FAILED', reason: 'REPLY_INVALID', ...base };
}
const notSent = (reason, built) => ({ state: 'NOT_SENT', reason, httpStatus: null, code: null, usage: null, reply: null,
  messagesBytes: built.messagesBytes, included: built.included, omitted: built.omitted, startedAt: null, finishedAt: null,
  elapsedMs: null, estimateMicro: null });

/**
 * One slot. Every refusal before the intent spends nothing. The intent is synced before the provider call and
 * consumes the slot for good; the month and review are checked again after it is durable, and a failure there is
 * recorded as NOT_SENT by this code path, the only affirmative not-sent evidence.
 */
export async function executeSlot({ root, id, slot, key, fetchImpl = fetch, now = Date.now, source = gitSource,
  requestMs = STYLIST_LIMITS.requestMs, fs = { open } }) {
  requireThat(SLOTS.includes(slot), 'INVALID_SLOT');
  requireThat(typeof key === 'string' && /^[\x21-\x7e]{16,512}$/.test(key), 'PRIVATE_KEY_REQUIRED');
  const record = await readRecord({ root, id, source });
  requireThat(!record.persistence.pending, 'PERSISTENCE_UNCERTAIN');
  return locked(record.directory, async () => {
    const { init, slots, cumulative, persistence } = await readRecord({ root, id, source });
    requireThat(!persistence.pending, 'PERSISTENCE_UNCERTAIN');
    requireThat(SLOTS.every((name) => slotState(slots[name]) !== 'UNCERTAIN_INTENT'), 'PRIOR_UNCERTAINTY');
    requireThat(slots[slot] === null, 'SLOT_CONSUMED');
    requireThat(slot === 'min' ? slots.max === null : slotState(slots.min) === 'OK', 'VALID_MIN_REQUIRED');
    allocationOpen(init.receipt, now());
    requireThat(cumulative + PROBE.valuationMicro <= Number(init.receipt.allocationMicro), 'ALLOCATION_EXCEEDED');
    const { built } = fixture(slot);
    requireThat(jsonDigest(built.body) === init.bodies[slot], 'LEDGER_CONFIG_CHANGED');
    await append(record.directory, { type: 'intent', slot, bodyDigest: init.bodies[slot], valuationMicro: PROBE.valuationMicro,
      cumulativeMicro: cumulative + PROBE.valuationMicro, time: new Date(now()).toISOString() }, false, fs);
    let observation;
    try { allocationOpen(init.receipt, now()); }
    catch (error) { observation = notSent(error.code, built); }
    if (!observation) {
      let httpStatus = null;
      const transport = async (url, request) => {
        requireThat(url === STYLIST_ENDPOINT && request.method === 'POST' && request.redirect === 'error', 'TRANSPORT_CONTRACT');
        const response = await fetchImpl(url, request);
        httpStatus = response.status;
        return response;
      };
      const started = now(), clock = performance.now();
      let outcome;
      try { outcome = await callStylist({ apiKey: key }, built.body, AbortSignal.timeout(requestMs), transport); }
      catch { outcome = null; }
      observation = observe({ outcome, httpStatus, built, startedAt: new Date(started).toISOString(),
        finishedAt: new Date(now()).toISOString(), elapsedMs: Math.max(0, Math.ceil(performance.now() - clock)) });
    }
    await append(record.directory, { type: 'result', slot, observation, time: new Date(now()).toISOString() }, false, fs);
    return observation;
  });
}

/** An intent without a result is always counted: a crash, timeout or reset is not proof that nothing was sent. */
export async function reconcile({ root, id, slot, now = Date.now, source = gitSource }) {
  requireThat(SLOTS.includes(slot), 'INVALID_SLOT');
  const record = await readRecord({ root, id, source });
  requireThat(!record.persistence.pending, 'PERSISTENCE_UNCERTAIN');
  return locked(record.directory, async () => {
    const { slots, persistence } = await readRecord({ root, id, source });
    requireThat(!persistence.pending, 'PERSISTENCE_UNCERTAIN');
    requireThat(slotState(slots[slot]) === 'UNCERTAIN_INTENT', 'NOTHING_TO_RECONCILE');
    await append(record.directory, { type: 'reconcile', slot, resolution: 'counted', time: new Date(now()).toISOString() });
  });
}

/**
 * Explicit recovery after a failed sync or close, run only when no probe process is running. The affected slot is
 * counted at the full valuation and any result visible for it is untrusted, so recovery never creates a success. It
 * adopts the retained lock (or retakes one removed by hand), drops a torn final line, appends `recover` (or re-syncs a
 * recover line that is already visible), and only then clears the pending marker and the lock.
 */
export async function recover({ root, id, slot, now = Date.now, source = gitSource, fs = { open } }) {
  requireThat(SLOTS.includes(slot), 'INVALID_SLOT');
  requireThat(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), 'USAGE');
  const directory = await privateDirectory(path.join(await privateDirectory(root), id));
  const marker = await pendingMarker(directory);
  requireThat(marker !== null, 'NOTHING_TO_RECOVER');
  requireThat(marker.type !== 'init', 'ALLOCATION_UNUSABLE');
  requireThat(marker.unknown || marker.slot === slot, 'RECOVERY_SLOT_MISMATCH');
  const lock = path.join(directory, LOCK);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { requireThat(error?.code === 'EEXIST', 'LOCK_FAILED'); }
  const ledger = path.join(directory, LEDGER);
  const raw = await boundedFile(ledger, LEDGER_LIMIT);
  if (raw.at(-1) !== 10) {
    const keep = raw.lastIndexOf(10) + 1;
    requireThat(keep > 0, 'ALLOCATION_UNUSABLE');
    let handle, ok = true;
    try { handle = await fs.open(ledger, 'r+'); await handle.truncate(keep); await handle.sync(); } catch { ok = false; }
    if (handle) { try { await handle.close(); } catch { ok = false; } }
    requireThat(ok, 'LEDGER_WRITE_UNCERTAIN');
  }
  const { slots } = await readRecord({ root, id, source });
  const synced = slots[slot]?.recovered
    ? await writeSynced(fs, ledger, 'r+', null)
    : await writeSynced(fs, ledger, constants.O_WRONLY | constants.O_APPEND, `${JSON.stringify({ type: 'recover', slot, time: new Date(now()).toISOString() })}\n`);
  requireThat(synced, 'LEDGER_WRITE_UNCERTAIN');
  requireThat((await readRecord({ root, id, source })).slots[slot]?.recovered === true, 'LEDGER_INVALID');
  try { await (fs.unlink ?? unlink)(path.join(directory, PENDING)); } catch { throw new ProbeError('LEDGER_WRITE_UNCERTAIN'); }
  try { await rmdir(lock); } catch { throw new ProbeError('LOCK_RELEASE_FAILED'); }
}

export function parseArguments(args) {
  const [command, first, second, ...rest] = args;
  requireThat(rest.length === 0, 'USAGE');
  if (command === 'init') requireThat(typeof first === 'string' && second === undefined, 'USAGE');
  else if (command === 'status') requireThat(typeof first === 'string' && /^[a-f0-9]{32}$/.test(first) && second === undefined, 'USAGE');
  else requireThat(['send', 'reconcile', 'recover'].includes(command) && typeof first === 'string' && /^[a-f0-9]{32}$/.test(first)
    && SLOTS.includes(second), 'USAGE');
  return { command, first, second };
}
/** Refuses CI and the unpinned runtime first, before any file, key or network access. */
export async function main(args, { env = process.env, log = console.log, runtime = {}, root = operatorRoot(), fetchImpl = fetch } = {}) {
  assertRuntime({ env, ...runtime });
  const { command, first, second } = parseArguments(args);
  let id = first;
  if (command === 'init') {
    requireThat(path.isAbsolute(first), 'PRIVATE_PATH_INVALID');
    await privateDirectory(path.dirname(first));
    id = await initialize({ root, receipt: parseJson(await boundedFile(first, RECEIPT_LIMIT)) });
  } else if (command === 'send') {
    const key = env[PROBE.keyVariable];
    delete env[PROBE.keyVariable];
    const observation = await executeSlot({ root, id, slot: second, key, fetchImpl });
    if (observation.state !== 'OK') process.exitCode = 1;
  } else if (command === 'reconcile') {
    await reconcile({ root, id, slot: second });
  } else if (command === 'recover') {
    await recover({ root, id, slot: second });
  }
  log(JSON.stringify(summary(await readRecord({ root, id })), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof ProbeError ? [error.code, error.cleanupCode].filter(Boolean).join('; ') : 'LOCAL_IO_FAILURE');
    process.exitCode = 1;
  });
}
