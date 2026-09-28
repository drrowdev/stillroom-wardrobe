#!/usr/bin/env node
// VTO-1 operator probe (plan rev4 §11.1, ADR28). Run only by the coordinator, inside a separately approved probe window,
// against the approved hosted project, with the owner's own prepared photo and explicit probe consent. At most 5 paid
// calls, in the one order that fits the five-call authorisation: P1 steps 1-3, the P3 disconnect test, then the P2
// filter challenge. No retries after a claim and no 6th call; a failed call still counts. Every refusal happens before
// any network call. The report is text only: codes, numbers, hashes and IDs. It never contains tokens, JWTs, headers,
// image bytes or base64. The final P1 picture is the only file written, to the owner's empty PROBE_OUTPUT folder.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOSTED_URL } from './hosted-smoke.mjs';

export const PROBE_CALLS = 5;
export const PERSON_BYTES = 512_000;
export const OUTPUT_BYTES = 512_000;
export const JSON_BYTES = 32_768;
export const RESULT_JSON_BYTES = 800_000;
export const CALL_TIMEOUT_MS = 100_000;
export const DISCONNECT_AFTER_MS = 20_000;
export const DISPATCH_SPACING_MS = 65_000;
export const REFUSED_POLL_MS = 15_000;
export const REFUSED_FOR_MS = 180_000;
export const SETTLE_POLL_MS = 10_000;
export const SETTLE_FOR_MS = 180_000;
const MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
const MODEL = 'gpt-image-2.5-sunburst';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MICRO = /^(0|[1-9][0-9]{0,18})$/;
const CODE = /^[A-Z_]{1,32}$/;

export class ProbeRefusal extends Error {
  constructor(code) { super(code); this.name = 'ProbeRefusal'; this.code = code; }
}
const refuse = (code) => { throw new ProbeRefusal(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every check that needs no network: environment, the owner's photo and the output folder. Returns the run inputs. */
export async function prepareProbe(env, deps) {
  if (env.ALLOW_TRYON_PROBE !== '1') refuse('notAllowed');
  if (env.PROBE_PROJECT_URL !== HOSTED_URL) refuse('project');
  if (!UUID.test(env.PROBE_AUTHORISATION_ID ?? '')) refuse('authorisation');
  const jwt = env.PROBE_ACCESS_TOKEN, token = env.TRYON_PROBE_TOKEN, key = env.PROBE_PUBLISHABLE_KEY;
  if (typeof jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) refuse('accessToken');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) refuse('probeToken');
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{8,128}$/.test(key)) refuse('publishableKey');
  const outfits = { P1: env.PROBE_OUTFIT_P1, P3: env.PROBE_OUTFIT_P3, P2: env.PROBE_OUTFIT_P2 };
  if (!Object.values(outfits).every((id) => UUID.test(id ?? '')) || new Set(Object.values(outfits)).size !== 3) refuse('outfits');
  if (typeof env.PROBE_PERSON !== 'string' || typeof env.PROBE_OUTPUT !== 'string') refuse('folders');
  let person;
  try { person = new Uint8Array(await deps.readFile(resolve(env.PROBE_PERSON))); } catch { refuse('person'); }
  // The owner prepares the photo; the script only verifies it with the server's byte rules and never re-encodes it.
  if (person.byteLength < 1 || person.byteLength > PERSON_BYTES) refuse('person');
  try {
    const admitted = deps.admit(person);
    if (admitted.stripped || admitted.width !== 1024 || admitted.height !== 1280 || sha256(admitted.bytes) !== sha256(person)) refuse('person');
  } catch (error) { if (error instanceof ProbeRefusal) throw error; refuse('person'); }
  const output = resolve(env.PROBE_OUTPUT);
  let existing;
  try { existing = await deps.readdir(output); } catch { refuse('output'); }
  if (existing.length !== 0) refuse('output');
  return { url: HOSTED_URL, authorisation: env.PROBE_AUTHORISATION_ID, jwt, token, key, outfits, person, personSha256: sha256(person), output };
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
async function readJson(response, limit = JSON_BYTES) {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  const bytes = await readCapped(response, limit);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
}
async function rpc(run, deps, name, body, limit = JSON_BYTES) {
  const response = await deps.fetch(`${run.url}/rest/v1/rpc/${name}`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { apikey: run.key, Authorization: 'Bearer '.concat(run.jwt), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await readJson(response, limit);
  return response.status === 200 && record(value) && typeof value.code === 'string' ? value : null;
}

/** The owner's own status, with the probe's preflight checks (the handler and SQL repeat them). */
async function status(run, deps) {
  const value = await rpc(run, deps, 'tryon_status', {});
  if (!value || !record(value.policy) || !record(value.usage)) return { ok: false, code: 'statusUnreadable' };
  const p = value.policy, u = value.usage;
  if (![p.maxRequestMicro, p.tryOnAllowanceMicro, p.totalAllowanceMicro, u.tryOnMicro, u.totalMicro].every((v) => typeof v === 'string' && MICRO.test(v))) {
    return { ok: false, code: 'statusUnreadable' };
  }
  const usage = { tryOnMicro: u.tryOnMicro, totalMicro: u.totalMicro, tryOnLastHour: Number(u.tryOnLastHour) };
  // Ordinary try-on must be off (not activated) for the whole window.
  if (value.code !== 'INACTIVE' || p.activated !== false) return { ok: false, code: 'activated', usage };
  if (p.manifestId !== MANIFEST || p.modelId !== MODEL || p.providerAvailable !== true) return { ok: false, code: 'policy', usage };
  const reservation = BigInt(p.maxRequestMicro);
  if (BigInt(p.tryOnAllowanceMicro) - BigInt(u.tryOnMicro) < reservation || BigInt(p.totalAllowanceMicro) - BigInt(u.totalMicro) < reservation) {
    return { ok: false, code: 'allowance', usage };
  }
  return { ok: true, usage };
}

/** One step request. A claim refused as RATE_LIMIT or BUSY is unpaid and is re-polled; nothing is re-sent after a claim. */
async function step(run, deps, plan) {
  const started = deps.now();
  for (;;) {
    const requestId = (deps.newId ?? randomUUID)();
    const body = new FormData();
    body.append('chainId', plan.chainId);
    body.append('step', String(plan.step));
    body.append('requestId', requestId);
    body.append('manifestId', MANIFEST);
    if (plan.step === 1) body.append('outfitId', plan.outfitId);
    body.append('person', new Blob([plan.person], { type: 'image/jpeg' }), 'person.jpg');
    const controller = new AbortController();
    const sentAt = deps.now();
    const timer = (deps.setTimeout ?? setTimeout)(() => controller.abort(), plan.disconnect ? DISCONNECT_AFTER_MS : CALL_TIMEOUT_MS);
    const result = { outfit: plan.outfit, step: plan.step, requestId };
    try {
      const response = await deps.fetch(`${run.url}/functions/v1/try-on`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal, body,
        headers: { apikey: run.key, Authorization: 'Bearer '.concat(run.jwt), 'X-Stillroom-Probe-Authorisation': run.authorisation,
          'X-Stillroom-Probe-Token': run.token },
      });
      result.status = response.status;
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.status === 200 && type === 'image/jpeg') {
        const bytes = await readCapped(response, OUTPUT_BYTES);
        result.latencyMs = Math.round(deps.now() - sentAt);
        if (!bytes) return { ...result, code: 'OUTPUT_REJECTED', paid: true };
        result.outputSha256 = sha256(bytes); result.outputBytes = bytes.byteLength;
        if (response.headers.get('x-stillroom-tryon-sha256') !== result.outputSha256) return { ...result, code: 'EVIDENCE_MISMATCH', paid: true };
        let admitted;
        try { admitted = deps.admit(bytes); } catch { return { ...result, code: 'ADMISSION_REJECTED', paid: true }; }
        if (admitted.stripped || admitted.width !== 1024 || admitted.height !== 1280) return { ...result, code: 'ADMISSION_REJECTED', paid: true };
        return { ...result, code: 'OK', last: false, paid: true, image: bytes };
      }
      const value = await readJson(response);
      result.latencyMs = Math.round(deps.now() - sentAt);
      const code = record(value) && typeof value.code === 'string' && CODE.test(value.code) ? value.code : 'UNREADABLE';
      if (response.status === 200 && code === 'OK' && typeof value.resultId === 'string' && UUID.test(value.resultId)) {
        return { ...result, code: 'OK', last: true, paid: true, resultId: value.resultId };
      }
      if ((code === 'RATE_LIMIT' || code === 'BUSY') && deps.now() - started + REFUSED_POLL_MS <= REFUSED_FOR_MS) {
        (deps.clearTimeout ?? clearTimeout)(timer);
        await deps.sleep(REFUSED_POLL_MS);
        continue;
      }
      // A claim refusal is unpaid; anything after a claim counts.
      const paid = !['RATE_LIMIT', 'BUSY', 'ALLOWANCE', 'RESULTS_FULL', 'NO_GARMENTS', 'NOT_FOUND', 'CHAIN_MISMATCH', 'CONFLICT',
        'UNAVAILABLE', 'INACTIVE', 'UNCONFIGURED', 'INVALID_INPUT', 'UNAUTHENTICATED', 'CONFIG_CHANGED'].includes(code);
      return { ...result, code, paid };
    } catch {
      result.latencyMs = Math.round(deps.now() - sentAt);
      if (plan.disconnect && controller.signal.aborted) return { ...result, code: 'DISCONNECTED', paid: true };
      return { ...result, code: controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'TRANSPORT', paid: true };
    } finally { (deps.clearTimeout ?? clearTimeout)(timer); }
  }
}

// Stop (and, for a completed chain, delete its picture) so nothing of the probe stays on the server.
async function tidy(run, deps, chainId, lines) {
  try {
    const cancelled = await rpc(run, deps, 'tryon_cancel', { p_chain_id: chainId });
    let removed = null;
    if (cancelled?.code === 'COMPLETED' && typeof cancelled.resultId === 'string') {
      removed = (await rpc(run, deps, 'tryon_delete_result', { p_result_id: cancelled.resultId }))?.code ?? 'UNREADABLE';
    }
    lines.push(`Chain ${chainId}: ${JSON.stringify({ stop: cancelled?.code ?? 'UNREADABLE', resultDeleted: removed })}`);
  } catch { lines.push(`Chain ${chainId}: tidy failed; try-on cleanup removes it.`); }
}

/** Runs the probe. Returns the text-only report lines; never throws after the first network call. */
export async function runProbe(env, deps) {
  const run = await prepareProbe(env, deps);
  const lines = [], calls = [];
  let lastStart = null;
  const send = async (plan) => {
    let pre;
    try { pre = await status(run, deps); } catch { pre = { ok: false, code: 'statusUnreadable' }; }
    if (!pre.ok) { lines.push(`Stopped before ${plan.outfit} step ${plan.step}: ${pre.code}.`); return null; }
    if (lastStart !== null) {
      const wait = DISPATCH_SPACING_MS - (deps.now() - lastStart);
      if (wait > 0) await deps.sleep(wait);
    }
    lastStart = deps.now();
    const outcome = await step(run, deps, plan);
    if (outcome.paid) calls.push(outcome);
    lines.push(`Call ${calls.length} (${plan.outfit} step ${plan.step}): ${JSON.stringify({ ...outcome, image: undefined, paid: undefined })}`);
    return outcome;
  };
  let complete = false;
  // Calls 1-3: P1, three steps. Intermediates stay in memory; only the final picture is written.
  const p1 = (deps.newId ?? randomUUID)();
  let person = run.person;
  for (let index = 1; index <= 3; index++) {
    const outcome = await send({ outfit: 'P1', outfitId: run.outfits.P1, chainId: p1, step: index, person, disconnect: false });
    if (!outcome) break;
    if (outcome.code !== 'OK' || outcome.last !== (index === 3)) {
      lines.push(`Stopped after P1 step ${index}: ${outcome.code === 'OK' ? 'P1_NOT_THREE_STEPS' : outcome.code}.`);
      break;
    }
    if (index < 3) { person = outcome.image; continue; }
    const image = await rpc(run, deps, 'tryon_result_image_v1', { p_result_id: outcome.resultId }, RESULT_JSON_BYTES);
    const bytes = image?.code === 'OK' && typeof image.jpegBase64 === 'string' ? new Uint8Array(Buffer.from(image.jpegBase64, 'base64')) : null;
    let admitted;
    try { admitted = bytes && bytes.byteLength <= OUTPUT_BYTES ? deps.admit(bytes) : null; } catch { admitted = null; }
    if (!admitted || admitted.stripped || admitted.width !== 1024 || admitted.height !== 1280) {
      lines.push('Stopped after P1 step 3: RESULT_UNREADABLE.');
      break;
    }
    await deps.writeFile(join(run.output, 'p1-final.jpg'), bytes, { flag: 'wx' });
    lines.push(`P1 final picture: ${JSON.stringify({ resultId: outcome.resultId, sha256: sha256(bytes), bytes: bytes.byteLength })}`);
    complete = true;
  }
  await tidy(run, deps, p1, lines);
  // Call 4: P3, one step, disconnected 20 s after the request is sent. The evidence alone decides the outcome.
  if (complete) {
    complete = false;
    const p3 = (deps.newId ?? randomUUID)();
    const outcome = await send({ outfit: 'P3', outfitId: run.outfits.P3, chainId: p3, step: 1, person: run.person, disconnect: true });
    if (outcome) {
      if (outcome.code === 'DISCONNECTED' || outcome.code === 'OK') {
        if (outcome.code === 'OK') lines.push('P3 responded before the disconnect: call 4 is incomplete.');
        for (let waited = 0; waited <= SETTLE_FOR_MS; waited += SETTLE_POLL_MS) {
          if (waited > 0) await deps.sleep(SETTLE_POLL_MS);
          let seen;
          try { seen = await rpc(run, deps, 'tryon_chain_status', { p_chain_id: p3 }); } catch { seen = null; }
          lines.push(`P3 chain after ${waited / 1000} s: ${JSON.stringify(seen ? { state: seen.state, activeAttempt: seen.activeAttempt }
            : { code: 'statusUnreadable' })}`);
          if (seen && seen.activeAttempt === false) break;
        }
        complete = true;
      } else {
        lines.push(`Stopped after P3: ${outcome.code}.`);
      }
    }
    await tidy(run, deps, p3, lines);
  }
  // Call 5: P2, the filter challenge. OK and FILTERED are both evidence; it is last because a filter without usage
  // stops the authorisation.
  if (complete) {
    const p2 = (deps.newId ?? randomUUID)();
    const outcome = await send({ outfit: 'P2', outfitId: run.outfits.P2, chainId: p2, step: 1, person: run.person, disconnect: false });
    if (outcome) lines.push(`P2 filter challenge: ${outcome.code === 'OK' || outcome.code === 'FILTERED' ? outcome.code : `${outcome.code} (recorded)`}.`);
    await tidy(run, deps, p2, lines);
  }
  lines.push(`Request IDs: ${calls.map((entry) => entry.requestId).join(' ')}`);
  lines.push(`Paid calls sent: ${calls.length} of at most ${PROBE_CALLS}.`);
  lines.push('Delete the photo and the final picture from PROBE_OUTPUT no later than 7 days after today, reviewed or not.');
  return { lines, calls: calls.map((entry) => ({ ...entry, image: undefined })) };
}

async function main() {
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { admitProviderJpeg } = await import('../src/images/provider-jpeg.ts');
  try {
    const { lines } = await runProbe(process.env, {
      fetch, readFile, readdir, writeFile, now: () => performance.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      admit: admitProviderJpeg,
    });
    for (const line of lines) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`Probe refused (${error instanceof ProbeRefusal ? error.code : 'unexpected'}). Nothing was sent.\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
