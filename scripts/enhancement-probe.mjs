#!/usr/bin/env node
// BG2b-2 operator probe (plan rev2 §7.3, amendment A1). Run only by the coordinator, inside a separately approved probe
// window, against the approved hosted project with non-personal samples. At most 6 paid calls: 5 visual and 1 disconnect
// (F4). There are no retries and no 7th call; a failed call still counts. Every refusal happens before any network call.
// The report is text only: codes, numbers, hashes and IDs. It never contains tokens, JWTs, headers, image bytes or base64.
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
const MANIFEST = 'azure-global-image25-sunburst-enhance-v1';
const MODEL = 'gpt-image-2.5-sunburst';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jpe?g$/;
const MICRO = /^(0|[1-9][0-9]{0,18})$/;

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
  const folder = resolve(env.PROBE_SAMPLES), output = resolve(env.PROBE_OUTPUT);
  let listing;
  try { listing = JSON.parse(await deps.readFile(join(folder, 'samples.json'), 'utf8')); } catch { refuse('samples'); }
  if (!Array.isArray(listing) || listing.length !== PROBE_CALLS) refuse('samples');
  const samples = [];
  for (const [index, entry] of listing.entries()) {
    if (!record(entry) || Object.keys(entry).sort().join() !== 'file,role,sha256' || !FILE.test(entry.file) || basename(entry.file) !== entry.file
      || !HASH.test(entry.sha256) || entry.role !== (index < VISUAL_CALLS ? 'visual' : 'disconnect')) refuse('samples');
    let bytes;
    try { bytes = new Uint8Array(await deps.readFile(join(folder, entry.file))); } catch { refuse('sample'); }
    if (bytes.byteLength < 1 || bytes.byteLength > SAMPLE_BYTES || sha256(bytes) !== entry.sha256) refuse('sample');
    try {
      const { width, height } = deps.readHeader(bytes);
      if (Math.max(width, height) > 1600 || deps.inspect(bytes, width, height).kind !== 'preserve') refuse('sample');
    } catch (error) { if (error instanceof ProbeRefusal) throw error; refuse('sample'); }
    samples.push({ role: entry.role, sha256: entry.sha256, bytes });
  }
  let existing;
  try { existing = await deps.readdir(output); } catch { refuse('output'); }
  if (existing.length !== 0) refuse('output');
  return { url: HOSTED_URL, authorisation: env.PROBE_AUTHORISATION_ID, jwt, token, key, samples, output };
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

async function call(run, deps, sample, index, disconnect) {
  const requestId = (deps.newId ?? randomUUID)();
  const controller = new AbortController();
  const started = deps.now();
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
      return { ...result, latencyMs: Math.round(deps.now() - started), stop: false };
    }
    if (response.status !== 200) {
      const value = await readJson(response);
      result.code = record(value) && typeof value.code === 'string' && /^[A-Z_]{1,32}$/.test(value.code) ? value.code : 'UNREADABLE';
      return { ...result, latencyMs: Math.round(deps.now() - started), stop: true };
    }
    const headerHash = response.headers.get('x-stillroom-enhancement-sha256');
    const headerLength = Number(response.headers.get('content-length'));
    const body = response.headers.get('content-type') === 'image/jpeg' ? await readCapped(response, OUTPUT_BYTES) : null;
    result.latencyMs = Math.round(deps.now() - started);
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
    result.latencyMs = Math.round(deps.now() - started);
    if (disconnect && controller.signal.aborted) return { ...result, code: 'DISCONNECTED', stop: false };
    return { ...result, code: controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'TRANSPORT', stop: true };
  } finally { clearTimeout(timer); }
}

/** Runs the probe. Returns the text-only report lines; never throws after the first network call. */
export async function runProbe(env, deps) {
  const run = await prepareProbe(env, deps);
  const lines = [];
  const calls = [];
  for (const [index, sample] of run.samples.entries()) {
    if (calls.length >= PROBE_CALLS) break;
    let pre;
    try { pre = await status(run, deps); } catch { pre = { ok: false, code: 'statusUnreadable' }; }
    if (!pre.ok) { lines.push(`Stopped before call ${index + 1}: ${pre.code}.`); break; }
    const outcome = await call(run, deps, sample, index, sample.role === 'disconnect');
    calls.push(outcome);
    lines.push(`Call ${outcome.call} (${outcome.role}): ${JSON.stringify({ ...outcome, stop: undefined })}`);
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
  return { lines, calls };
}

async function main() {
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { readJpegHeader } = await import('../src/images/jpeg.ts');
  const { inspectRestoreJpeg } = await import('../src/images/restore-jpeg.ts');
  const { admitProviderJpeg } = await import('../src/images/provider-jpeg.ts');
  try {
    const { lines } = await runProbe(process.env, {
      fetch, readFile, readdir, writeFile, mkdir, now: () => performance.now(), sleep: (ms) => new Promise(done => setTimeout(done, ms)),
      readHeader: readJpegHeader, inspect: inspectRestoreJpeg, admit: admitProviderJpeg,
    });
    for (const line of lines) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`Probe refused (${error instanceof ProbeRefusal ? error.code : 'unexpected'}). Nothing was sent.\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
