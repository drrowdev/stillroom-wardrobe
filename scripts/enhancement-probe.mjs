#!/usr/bin/env node
// BG2b-2 operator probe (plan rev2 §7.3, amendment A1), on the cleanup-v1 manifest since BG2c-1 (plan rev4 §11). Run only
// by the coordinator, inside a separately approved probe window, against the approved hosted project with non-personal
// samples prepared by `scripts/cleanup-probe-harness.mjs`. At most 6 paid calls: 5 visual and 1 disconnect (F4). There are
// no retries and no 7th call; a failed call, including RATE_LIMIT, still counts and stops the run. Calls are paced against
// the real slot lifetime (R4). Every refusal happens before any network call. The report is text only: codes, numbers,
// hashes and IDs. It never contains tokens, JWTs, headers, image bytes or base64.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOSTED_URL } from './hosted-smoke.mjs';

export const PROBE_CALLS = 6;
export const VISUAL_CALLS = 5;
export const SAMPLE_BYTES = 512_000;
export const OUTPUT_BYTES = 512_000;
export const JSON_BYTES = 32_768;
export const CALL_TIMEOUT_MS = 95_000;
export const DISCONNECT_AFTER_MS = 5_000;
export const POLL_EVERY_MS = 10_000;
export const POLL_FOR_MS = 180_000;
/** R4: a claim holds its slot for claim + 5 s + the 60 s window; 2 slots per window. Pacing keeps a 1 s margin. */
export const SLOT_MS = 65_000;
export const SLOT_MARGIN_MS = 1_000;
export const DISPATCH_SPACING_MS = 33_000;
export const REFERENCE_BYTES = 256 * 320;
const MANIFEST = 'azure-global-image25-sunburst-cleanup-v1';
const MODEL = 'gpt-image-2.5-sunburst';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jpe?g$/;
const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.bin$/;
const JSON_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BINDING_KEYS = 'ambiguous,commit,crop,frame,h0,modelSha256,reference,sampleSha256,version';

export class ProbeRefusal extends Error {
  constructor(code) { super(code); this.name = 'ProbeRefusal'; this.code = code; }
}
const refuse = (code) => { throw new ProbeRefusal(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every check that needs no network: environment, samples and output folder. Returns the validated run inputs. */
export async function prepareProbe(env, deps) {
  if (env.ALLOW_ENHANCEMENT_PROBE !== '1') refuse('notAllowed');
  if (env.PROBE_PROJECT_URL !== HOSTED_URL) refuse('project');
  if (!UUID.test(env.PROBE_AUTHORISATION_ID ?? '')) refuse('authorisation');
  const jwt = env.PROBE_ACCESS_TOKEN, token = env.ENHANCE_PROBE_TOKEN, key = env.PROBE_PUBLISHABLE_KEY;
  if (typeof jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) refuse('accessToken');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) refuse('probeToken');
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{8,128}$/.test(key)) refuse('publishableKey');
  if (typeof env.PROBE_SAMPLES !== 'string' || typeof env.PROBE_OUTPUT !== 'string') refuse('folders');
  if (typeof deps.monotonic !== 'function' || typeof deps.now !== 'function') refuse('clock');
  const folder = resolve(env.PROBE_SAMPLES), output = resolve(env.PROBE_OUTPUT);
  let listing;
  try { listing = JSON.parse(await deps.readFile(join(folder, 'samples.json'), 'utf8')); } catch { refuse('samples'); }
  if (!Array.isArray(listing) || listing.length !== PROBE_CALLS) refuse('samples');
  const samples = [];
  for (const [index, entry] of listing.entries()) {
    if (!record(entry) || Object.keys(entry).sort().join() !== 'binding,file,reference,role,sha256' || !FILE.test(entry.file)
      || !BIN.test(entry.reference) || !JSON_FILE.test(entry.binding)
      || [entry.file, entry.reference, entry.binding].some((name) => basename(name) !== name)
      || !HASH.test(entry.sha256) || entry.role !== (index < VISUAL_CALLS ? 'visual' : 'disconnect')) refuse('samples');
    let bytes;
    try { bytes = new Uint8Array(await deps.readFile(join(folder, entry.file))); } catch { refuse('sample'); }
    if (bytes.byteLength < 1 || bytes.byteLength > SAMPLE_BYTES || sha256(bytes) !== entry.sha256) refuse('sample');
    let size;
    try {
      size = deps.readHeader(bytes);
      if (Math.max(size.width, size.height) > 1600 || size.width * 5 !== size.height * 4 || deps.accepts(bytes, size.width, size.height) !== true) {
        refuse('sample');
      }
    } catch (error) { if (error instanceof ProbeRefusal) throw error; refuse('sample'); }
    samples.push({ role: entry.role, sha256: entry.sha256, bytes, binding: await verifyBinding(folder, entry, bytes, size, deps) });
  }
  // One harness build for the whole run: the same commit and BG1 model in every binding.
  if (new Set(samples.map((sample) => `${sample.binding.commit}:${sample.binding.modelSha256}`)).size !== 1) refuse('binding');
  const switchOn = wallTime(env.PROBE_SWITCH_ON_AT, deps);
  if (switchOn === null) refuse('switchOnTime');
  const lastUse = env.PROBE_LAST_KEY_USE_AT === undefined ? switchOn : wallTime(env.PROBE_LAST_KEY_USE_AT, deps);
  if (lastUse === null) refuse('lastKeyUse');
  let existing;
  try { existing = await deps.readdir(output); } catch { refuse('output'); }
  if (existing.length !== 0) refuse('output');
  // Wall time: the only use of the wall clock for pacing. runProbe converts it once to a monotonic deadline.
  return { url: HOSTED_URL, authorisation: env.PROBE_AUTHORISATION_ID, jwt, token, key, samples, output,
    notBeforeWall: Math.max(switchOn, lastUse) + SLOT_MS + SLOT_MARGIN_MS };
}

/** An ISO time in the past (the operator's record of the kill switch or an earlier use), as epoch ms; null if invalid. */
function wallTime(value, deps) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= deps.now() ? time : null;
}

/**
 * The harness `prepare` binding (plan rev4 §11.2): the H0 hashes, size and admission, R's length and hash, and that the
 * ambiguity rule held. An ambiguous or unverifiable sample is never dispatched.
 */
async function verifyBinding(folder, entry, bytes, size, deps) {
  let binding, reference;
  try {
    binding = JSON.parse(await deps.readFile(join(folder, entry.binding), 'utf8'));
    reference = new Uint8Array(await deps.readFile(join(folder, entry.reference)));
  } catch { refuse('binding'); }
  if (!record(binding) || Object.keys(binding).sort().join() !== BINDING_KEYS || binding.version !== 1
    || !COMMIT.test(binding.commit ?? '') || !HASH.test(binding.modelSha256 ?? '') || !HASH.test(binding.sampleSha256 ?? '')
    || !record(binding.h0) || !record(binding.reference) || !record(binding.frame) || !record(binding.crop)) refuse('binding');
  if (binding.ambiguous !== false) refuse('ambiguous');
  const { h0 } = binding;
  if (h0.sha256 !== entry.sha256 || h0.bytes !== bytes.byteLength || h0.width !== size.width || h0.height !== size.height) refuse('binding');
  if (reference.byteLength !== REFERENCE_BYTES || binding.reference.bytes !== REFERENCE_BYTES
    || binding.reference.sha256 !== sha256(reference) || reference.some((value) => value > 1)) refuse('binding');
  return { commit: binding.commit, modelSha256: binding.modelSha256, referenceSha256: binding.reference.sha256 };
}

/**
 * R4 slot-window pacing, on the monotonic clock only. Call k starts only when at least 33 s have passed since the
 * previous dispatch started AND at most one of this run's own slots can still be live: the slot of call k-2 ended no
 * later than its observed response plus 65 s (the claim precedes the reply). The first call waits out the switch-on
 * time and any known earlier use, converted once from wall time to a monotonic deadline (`run.notBefore`).
 */
export function earliestStart(run, starts, observed) {
  const k = starts.length;
  return Math.max(run.notBefore, k >= 1 ? starts[k - 1] + DISPATCH_SPACING_MS : -Infinity,
    k >= 2 ? observed[k - 2] + SLOT_MS + SLOT_MARGIN_MS : -Infinity);
}

// The numeric metrics `cleanupCheck` reports for each verdict (src/images/fidelity.ts). `size` and `nonFinite` carry
// none that a reviewer can use, so they leave the call's evidence incomplete.
const BASE_METRICS = ['ringDeltaE', 'ringP95', 'workingBytes'];
const PLACED_METRICS = [...BASE_METRICS, 'largestShare', 'containment', 'retention', 'centroid.x', 'centroid.y'];
const SUPPORTED_METRICS = [...PLACED_METRICS, 'support'];
const MEASURED_METRICS = [...SUPPORTED_METRICS, 'meanDeltaE', 'p95DeltaE', 'ssim', 'windows'];
export const REASON_METRICS = Object.freeze({
  background: BASE_METRICS, emptyMask: BASE_METRICS, tinyMask: BASE_METRICS, ambiguousMask: BASE_METRICS, pieces: BASE_METRICS,
  containment: PLACED_METRICS, retention: PLACED_METRICS, centre: PLACED_METRICS, support: SUPPORTED_METRICS,
  colour: MEASURED_METRICS, structure: MEASURED_METRICS, accepted: MEASURED_METRICS,
});
const metricAt = (metrics, path) => path.split('.').reduce((value, key) => (record(value) ? value[key] : undefined), metrics);

/** One harness `measure` entry, bound to this call's request, input, output, reference and build, with its metrics. */
function measuredFor(entry, measured) {
  const binding = entry.binding;
  if (!record(measured) || !record(binding) || measured.call !== entry.call || measured.commit !== binding.commit
    || measured.modelSha256 !== binding.modelSha256 || measured.referenceSha256 !== binding.referenceSha256
    || measured.h0Sha256 !== entry.inputSha256 || !HASH.test(entry.outputSha256 ?? '') || measured.h2Sha256 !== entry.outputSha256) return false;
  const required = Object.hasOwn(REASON_METRICS, measured.reason) ? REASON_METRICS[measured.reason] : null;
  return required !== null && record(measured.metrics)
    && required.every((path) => { const value = metricAt(measured.metrics, path); return typeof value === 'number' && Number.isFinite(value); });
}

/**
 * Acceptance is never "passed" here: the paired visual review decides (plan rev4 §11.3). This only says whether the
 * evidence is complete enough for that review.
 * - A visual call needs OK and a harness `measure` entry keyed by its request ID, bound to its input, output,
 *   reference and build, with every numeric metric its verdict reports.
 * - The disconnect call (F4) needs an actual DISCONNECTED outcome; a reply received before the disconnect leaves F4
 *   pending. It also needs the operator's read-back of that request's own usage row, settled from observed usage:
 *   dispatched, `charge_state` estimated, `enhance_settlement_origin` observed, no anomaly, an accounted amount and the
 *   settlement digest. A provisional expiry, another request's row or a merely terminal row is not enough.
 */
export function evidenceState(calls, metrics = {}, settlement = null) {
  const missing = [];
  if (calls.length !== PROBE_CALLS) missing.push('calls');
  for (const entry of calls) {
    if (entry.role === 'visual') {
      if (entry.code !== 'OK') missing.push(`call-${entry.call}`);
      else if (!record(metrics) || !measuredFor(entry, metrics[entry.requestId])) missing.push(`metrics-${entry.call}`);
    }
  }
  const disconnect = calls.find((entry) => entry.role === 'disconnect');
  if (disconnect) {
    if (disconnect.code !== 'DISCONNECTED') missing.push('disconnect-outcome');
    if (!(record(settlement) && settlement.requestId === disconnect.requestId && settlement.dispatched === true
      && settlement.chargeState === 'estimated' && settlement.settlementOrigin === 'observed' && settlement.anomaly === false
      && typeof settlement.accountedMicro === 'string' && MICRO.test(settlement.accountedMicro)
      && HASH.test(settlement.settlementDigest ?? ''))) missing.push('disconnect-settlement');
  }
  return missing.length ? { state: 'pending', missing } : { state: 'ready-for-paired-review', missing };
}

async function readCapped(response, limit) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) return null;
      parts.push(part.value);
    }
  } finally { try { await reader.cancel(); } catch { /* closed */ } }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
async function readJson(response) {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  const bytes = await readCapped(response, JSON_BYTES);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
}

/** The owner's own status, with the probe's preflight checks (the handler repeats them). */
async function status(run, deps) {
  const response = await deps.fetch(`${run.url}/rest/v1/rpc/enhance_status`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { apikey: run.key, Authorization: `Bearer ${run.jwt}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
  });
  const value = await readJson(response);
  if (response.status !== 200 || !record(value) || !record(value.policy) || !record(value.usage)) return { ok: false, code: 'statusUnreadable' };
  const p = value.policy, u = value.usage;
  if (![p.maxRequestMicro, p.enhanceAllowanceMicro, p.totalAllowanceMicro, u.enhanceMicro, u.totalMicro].every(v => typeof v === 'string' && MICRO.test(v))) {
    return { ok: false, code: 'statusUnreadable' };
  }
  const usage = { enhanceMicro: u.enhanceMicro, totalMicro: u.totalMicro, enhanceLastHour: Number(u.enhanceLastHour) };
  // A1: ordinary enhancement must be off (not activated), whatever the consent state.
  if (value.code !== 'INACTIVE' || p.activated !== false) return { ok: false, code: 'activated', usage };
  if (p.manifestId !== MANIFEST || p.modelId !== MODEL || p.providerAvailable !== true) return { ok: false, code: 'policy', usage };
  const reservation = BigInt(p.maxRequestMicro);
  if (BigInt(p.enhanceAllowanceMicro) - BigInt(u.enhanceMicro) < reservation || BigInt(p.totalAllowanceMicro) - BigInt(u.totalMicro) < reservation) {
    return { ok: false, code: 'allowance', usage };
  }
  return { ok: true, usage };
}

async function call(run, deps, sample, index, disconnect, started) {
  const requestId = (deps.newId ?? randomUUID)();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), disconnect ? DISCONNECT_AFTER_MS : CALL_TIMEOUT_MS);
  const result = { call: index + 1, role: sample.role, requestId, inputSha256: sample.sha256 };
  try {
    const response = await deps.fetch(`${run.url}/functions/v1/enhance-photo`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal, body: sample.bytes,
      headers: { apikey: run.key, Authorization: `Bearer ${run.jwt}`, 'Content-Type': 'image/jpeg', 'X-Stillroom-Request-Id': requestId,
        'X-Stillroom-Probe-Authorisation': run.authorisation, 'X-Stillroom-Probe-Token': run.token },
    });
    result.status = response.status;
    if (disconnect) {
      // F4 needs the connection dropped before a reply; a reply this early is recorded, and the call still counts.
      try { await response.body?.cancel(); } catch { /* closed */ }
      result.code = 'RESPONDED_BEFORE_DISCONNECT';
      return { ...result, latencyMs: Math.round(deps.monotonic() - started), stop: false };
    }
    if (response.status !== 200) {
      const value = await readJson(response);
      result.code = record(value) && typeof value.code === 'string' && /^[A-Z_]{1,32}$/.test(value.code) ? value.code : 'UNREADABLE';
      return { ...result, latencyMs: Math.round(deps.monotonic() - started), stop: true };
    }
    const headerHash = response.headers.get('x-stillroom-enhancement-sha256');
    const headerLength = Number(response.headers.get('content-length'));
    const body = response.headers.get('content-type') === 'image/jpeg' ? await readCapped(response, OUTPUT_BYTES) : null;
    result.latencyMs = Math.round(deps.monotonic() - started);
    if (!body) return { ...result, code: 'OUTPUT_REJECTED', stop: true };
    result.outputSha256 = sha256(body); result.outputBytes = body.byteLength;
    if (headerHash !== result.outputSha256 || headerLength !== body.byteLength) return { ...result, code: 'EVIDENCE_MISMATCH', stop: true };
    let admitted;
    try { admitted = deps.admit(body); } catch { return { ...result, code: 'ADMISSION_REJECTED', stop: true }; }
    if (admitted.stripped || admitted.width !== 1024 || admitted.height !== 1280 || sha256(admitted.bytes) !== result.outputSha256) {
      return { ...result, code: 'ADMISSION_REJECTED', stop: true };
    }
    result.code = 'OK'; result.width = admitted.width; result.height = admitted.height;
    result.metrics = deps.measure ? await deps.measure(sample.bytes, body) : 'not measured';
    await deps.writeFile(join(run.output, `call-${index + 1}.jpg`), body, { flag: 'wx' });
    return { ...result, stop: false };
  } catch {
    result.latencyMs = Math.round(deps.monotonic() - started);
    if (disconnect && controller.signal.aborted) return { ...result, code: 'DISCONNECTED', stop: false };
    return { ...result, code: controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'TRANSPORT', stop: true };
  } finally { clearTimeout(timer); }
}

/** Runs the probe. Returns the text-only report lines; never throws after the first network call. */
export async function runProbe(env, deps) {
  const run = await prepareProbe(env, deps);
  const lines = [];
  const calls = [];
  const starts = [], observed = [];
  // The one wall-to-monotonic conversion: after this, a wall-clock jump can neither shorten nor stretch any wait.
  const pace = { notBefore: deps.monotonic() + Math.max(0, run.notBeforeWall - deps.now()) };
  for (const [index, sample] of run.samples.entries()) {
    if (calls.length >= PROBE_CALLS) break;
    const wait = earliestStart(pace, starts, observed) - deps.monotonic();
    if (wait > 0) await deps.sleep(wait);
    let pre;
    try { pre = await status(run, deps); } catch { pre = { ok: false, code: 'statusUnreadable' }; }
    if (!pre.ok) { lines.push(`Stopped before call ${index + 1}: ${pre.code}.`); break; }
    const started = deps.monotonic();
    if (started < earliestStart(pace, starts, observed)) { lines.push(`Stopped before call ${index + 1}: clock.`); break; }
    starts.push(started);
    const outcome = { ...await call(run, deps, sample, index, sample.role === 'disconnect', started), binding: sample.binding };
    observed.push(deps.monotonic());
    calls.push(outcome);
    const entry = { ...outcome, stop: undefined };
    lines.push(`Call ${outcome.call} (${outcome.role}): ${JSON.stringify(entry)}`);
    try {
      await deps.writeFile(join(run.output, `call-${index + 1}.json`), `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
    } catch { lines.push(`Record for call ${outcome.call} not written.`); }
    if (outcome.stop) { lines.push(`Stopped after call ${outcome.call}: ${outcome.code}.`); break; }
  }
  const last = calls.at(-1);
  if (last?.role === 'disconnect') {
    for (let waited = 0; waited <= POLL_FOR_MS; waited += POLL_EVERY_MS) {
      if (waited > 0) await deps.sleep(POLL_EVERY_MS);
      let seen;
      try { seen = await status(run, deps); } catch { seen = { code: 'statusUnreadable' }; }
      lines.push(`Ledger after ${waited / 1000} s: ${JSON.stringify(seen.usage ?? { code: seen.code })}`);
    }
  }
  lines.push(`Request IDs: ${calls.map(entry => entry.requestId).join(' ')}`);
  lines.push(`Paid calls sent: ${calls.length} of at most ${PROBE_CALLS}.`);
  lines.push(`Evidence: ${JSON.stringify(evidenceState(calls))} (metrics come from the harness measure step; the disconnect settlement from the operator read-back).`);
  return { lines, calls };
}

async function main() {
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { readJpegHeader } = await import('../src/images/jpeg.ts');
  const { isPhotoInputJpeg } = await import('../src/images/restore-jpeg.ts');
  const { admitProviderJpeg } = await import('../src/images/provider-jpeg.ts');
  try {
    const { lines } = await runProbe(process.env, {
      fetch, readFile, readdir, writeFile, mkdir, now: () => Date.now(), monotonic: () => performance.now(), sleep: (ms) => new Promise(done => setTimeout(done, ms)),
      readHeader: readJpegHeader, accepts: isPhotoInputJpeg, admit: admitProviderJpeg,
    });
    for (const line of lines) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`Probe refused (${error instanceof ProbeRefusal ? error.code : 'unexpected'}). Nothing was sent.\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
