#!/usr/bin/env node
// VTO-1 operator probe (plan rev4 §11.1, ADR28). Run only by the coordinator, inside a separately approved probe window,
// against the approved hosted project, with the owner's own prepared photo and explicit probe consent. At most 5 paid
// calls, in the one order that fits the five-call authorisation (#117/#119): P1 steps 1-3, the single-item P3 disconnect
// test, then the single-item P2 filter challenge. PROBE_ONLY=P2 (VTO-3b) sends only the P2 filter challenge, at most one
// paid call, under its own one-call authorisation; it never sends P1 or P3. An unpaid refusal proven to come before a claim may be tried again; nothing that may follow a claim is
// ever re-sent, and there is no 6th call; a failed call still counts. Input refusals happen before any network call.
// The report is text only: codes, numbers, lengths and request IDs. It never contains hashes, result IDs, tokens, JWTs,
// headers, image bytes or base64. The final P1 picture is the only file written, to the owner's empty PROBE_OUTPUT folder.
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
export const REFUSED_FOR_MS = 180_000;
export const SETTLE_POLL_MS = 10_000;
export const SETTLE_FOR_MS = 180_000;
export const P2_ONLY_CALLS = 1;
// The approved deletion deadline for the owner's probe photo and pictures (#84 G7 c5905974664), in the owner's timezone.
export const APPROVED_DELETE_BY = '2026-10-07';
export const DELETE_BY_ZONE = 'Europe/Helsinki';
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
const realDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === value;
};
/** The calendar date in Helsinki at the given wall-clock time, as YYYY-MM-DD. */
export function helsinkiDate(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: DELETE_BY_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit' }).formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Every check that needs no network: environment, the owner's photo and the output folder. Returns the run inputs. */
export async function prepareProbe(env, deps) {
  if (env.ALLOW_TRYON_PROBE !== '1') refuse('notAllowed');
  if (env.PROBE_PROJECT_URL !== HOSTED_URL) refuse('project');
  if (!UUID.test(env.PROBE_AUTHORISATION_ID ?? '')) refuse('authorisation');
  const jwt = env.PROBE_ACCESS_TOKEN, token = env.TRYON_PROBE_TOKEN, key = env.PROBE_PUBLISHABLE_KEY;
  if (typeof jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) refuse('accessToken');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) refuse('probeToken');
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{8,128}$/.test(key)) refuse('publishableKey');
  // Unset runs the full probe; P2 is the only other value. Anything else, including empty, is refused: no fallback.
  const only = env.PROBE_ONLY;
  if (only !== undefined && only !== 'P2') refuse('only');
  let outfits;
  if (only === 'P2') {
    if (env.PROBE_OUTFIT_P1 !== undefined || env.PROBE_OUTFIT_P3 !== undefined || !UUID.test(env.PROBE_OUTFIT_P2 ?? '')) refuse('outfits');
    outfits = { P2: env.PROBE_OUTFIT_P2 };
    if (env.PROBE_OUTPUT !== undefined) refuse('output');
    if (typeof env.PROBE_PERSON !== 'string') refuse('folders');
    if (!realDate(env.PROBE_DELETE_BY) || env.PROBE_DELETE_BY !== APPROVED_DELETE_BY) refuse('delete_by');
    if (helsinkiDate((deps.wallNow ?? Date.now)()) > APPROVED_DELETE_BY) refuse('deadline_passed');
  } else {
    outfits = { P1: env.PROBE_OUTFIT_P1, P3: env.PROBE_OUTFIT_P3, P2: env.PROBE_OUTFIT_P2 };
    if (!Object.values(outfits).every((id) => UUID.test(id ?? '')) || new Set(Object.values(outfits)).size !== 3) refuse('outfits');
    if (typeof env.PROBE_PERSON !== 'string' || typeof env.PROBE_OUTPUT !== 'string') refuse('folders');
  }
  let person;
  try { person = new Uint8Array(await deps.readFile(resolve(env.PROBE_PERSON))); } catch { refuse('person'); }
  // The owner prepares the photo; the script only verifies it with the server's byte rules (the shared photo-input
  // profile at 1024x1280, without metadata) and never re-encodes it.
  if (person.byteLength < 1 || person.byteLength > PERSON_BYTES) refuse('person');
  let usable;
  try { usable = deps.personInput(person) === true; } catch { usable = false; }
  if (!usable) refuse('person');
  const base = { url: HOSTED_URL, authorisation: env.PROBE_AUTHORISATION_ID, jwt, token, key, outfits, person, personSha256: sha256(person) };
  if (only === 'P2') return { ...base, only, output: null };
  const output = resolve(env.PROBE_OUTPUT);
  let existing;
  try { existing = await deps.readdir(output); } catch { refuse('output'); }
  if (existing.length !== 0) refuse('output');
  return { ...base, only: null, output };
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
    headers: { apikey: run.key, Authorization: 'Bearer '.concat(run.jwt), Accept: 'application/json', 'Content-Type': 'application/json',
      'X-Stillroom-AI-Budget-Contract': '2' },
    body: JSON.stringify(body),
  });
  const value = await readJson(response, limit);
  return response.status === 200 && record(value) && typeof value.code === 'string' ? value : null;
}

/** The owner's own status, with the probe's preflight checks (the handler and SQL repeat them). */
async function status(run, deps) {
  const value = await rpc(run, deps, 'tryon_status', {});
  if (!value || !record(value.policy)) return { ok: false, code: 'statusUnreadable' };
  // The closed shared-budget reply (BUDGET1). Any other shape, including the retired usage/allowance one, is unreadable.
  const b = value.budget, p = value.policy;
  const closed = record(b) && Object.keys(b).length === 4 && ['monthlyAllowanceMicro', 'usedMicro', 'remainingMicro'].every((key) => typeof b[key] === 'string' && MICRO.test(b[key]))
    && typeof b.warning === 'boolean' && typeof p.maxRequestMicro === 'string' && MICRO.test(p.maxRequestMicro);
  if (!closed) return { ok: false, code: 'statusUnreadable' };
  const usage = { usedMicro: b.usedMicro, remainingMicro: b.remainingMicro };
  // Ordinary try-on must be off (not activated) for the whole window.
  if (value.code !== 'INACTIVE' || p.activated !== false) return { ok: false, code: 'activated', usage };
  if (p.manifestId !== MANIFEST || p.modelId !== MODEL || p.providerAvailable !== true) return { ok: false, code: 'policy', usage };
  if (BigInt(b.remainingMicro) < BigInt(p.maxRequestMicro)) return { ok: false, code: 'allowance', usage };
  return { ok: true, usage };
}

// Only these refusals are returned before a claim and nowhere after one, so only they are unpaid. Of those, BUSY (the
// shared deployment's physical capacity) may clear, so it is tried again (the handler maps a post-claim BUSY to FAILED). Every other code, and any
// transport failure, may follow a claim: it counts, is never retried and its request ID is kept for reconciliation.
// INACTIVE, CONSENT_REQUIRED, UNCONFIGURED and UNAVAILABLE also come from the mark's and finish's permission checks (a probe
// authorisation stopped or expired while the provider ran), and CHAIN_MISMATCH from the mark for a stale chain.
export const RETRY_BEFORE_CLAIM = Object.freeze(['BUSY']);
// TOO_LARGE is left out as well: the handler maps an oversized post-claim reply to FAILED, but its body can't prove ingress.
export const REFUSED_BEFORE_CLAIM = Object.freeze([...RETRY_BEFORE_CLAIM, 'ALLOWANCE', 'RESULTS_FULL', 'NO_GARMENTS',
  'UNAUTHENTICATED', 'UNSUPPORTED_MEDIA']);
const CHAIN_STATES = ['running', 'complete', 'cancelled', 'withdrawn', 'expired', 'stale'];
// The report carries codes, numbers, lengths and request IDs only: never hashes, result IDs, tokens or image data.
const reportable = (outcome) => ({ outfit: outcome.outfit, step: outcome.step, requestId: outcome.requestId, status: outcome.status,
  code: outcome.code, latencyMs: outcome.latencyMs, outputBytes: outcome.outputBytes });

/** One step request, sent once. Nothing is re-sent here; the caller decides whether an unpaid refusal is tried again. */
async function step(run, deps, plan) {
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
        'X-Stillroom-Probe-Token': run.token, 'X-Stillroom-AI-Budget-Contract': '2' },
    });
    result.status = response.status;
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (response.status === 200 && type === 'image/jpeg') {
      const bytes = await readCapped(response, OUTPUT_BYTES);
      result.latencyMs = Math.round(deps.now() - sentAt);
      if (!bytes) return { ...result, code: 'OUTPUT_REJECTED', paid: true };
      result.outputBytes = bytes.byteLength;
      // The hash check is transient: the hash itself never enters the report.
      if (response.headers.get('x-stillroom-tryon-sha256') !== sha256(bytes)) return { ...result, code: 'EVIDENCE_MISMATCH', paid: true };
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
    return { ...result, code, paid: response.status === 200 || !REFUSED_BEFORE_CLAIM.includes(code) };
  } catch {
    result.latencyMs = Math.round(deps.now() - sentAt);
    if (plan.disconnect && controller.signal.aborted) return { ...result, code: 'DISCONNECTED', paid: true };
    return { ...result, code: controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'TRANSPORT', paid: true };
  } finally { (deps.clearTimeout ?? clearTimeout)(timer); }
}

// Stop (and, for a completed chain, delete its picture) so nothing of the probe stays on the server. Never throws.
async function tidy(run, deps, chain, lines) {
  try {
    const cancelled = await rpc(run, deps, 'tryon_cancel', { p_chain_id: chain.id });
    let removed = null;
    if (cancelled?.code === 'COMPLETED' && typeof cancelled.resultId === 'string') {
      removed = (await rpc(run, deps, 'tryon_delete_result', { p_result_id: cancelled.resultId }))?.code ?? 'UNREADABLE';
    }
    const stop = typeof cancelled?.code === 'string' && CODE.test(cancelled.code) ? cancelled.code : 'UNREADABLE';
    const deleted = removed === null || CODE.test(removed) ? removed : 'UNREADABLE';
    lines.push(`${chain.label} chain: ${JSON.stringify({ stop, resultDeleted: deleted })}`);
  } catch { lines.push(`${chain.label} chain: tidy failed; try-on cleanup removes it.`); }
}

// The confirmed tidy before the next outfit, checked against the state already observed: a chain seen running must
// answer CANCELLED; a chain seen complete with a result must answer COMPLETED with that same result, which must then be
// deleted (OK). Any other reply leaves it unconfirmed. Never throws.
async function confirmTidy(run, deps, chain, lines, expected) {
  let cancelled, removed = null;
  try { cancelled = await rpc(run, deps, 'tryon_cancel', { p_chain_id: chain.id }); } catch { cancelled = null; }
  const stop = typeof cancelled?.code === 'string' && CODE.test(cancelled.code) ? cancelled.code : 'UNREADABLE';
  let confirmed = expected.state === 'running' && stop === 'CANCELLED';
  if (stop === 'COMPLETED' && typeof cancelled.resultId === 'string' && UUID.test(cancelled.resultId)) {
    let reply;
    try { reply = await rpc(run, deps, 'tryon_delete_result', { p_result_id: cancelled.resultId }); } catch { reply = null; }
    removed = typeof reply?.code === 'string' && CODE.test(reply.code) ? reply.code : 'UNREADABLE';
    confirmed = expected.state === 'complete' && cancelled.resultId === expected.resultId && removed === 'OK';
  }
  lines.push(`${chain.label} chain: ${JSON.stringify({ stop, resultDeleted: removed })}`);
  return confirmed;
}

/**
 * Runs the probe. Refusals before any network call throw ProbeRefusal; after that it never throws. Every chain it
 * started is stopped in `finally`, and the report always ends with every request ID sent, the paid count and the
 * outcome. COMPLETE means all five calls ran as planned; call 4 PASS is still decided only from the SQL evidence.
 */
export async function runProbe(env, deps) {
  const run = await prepareProbe(env, deps);
  const lines = [], calls = [], sent = [], chains = [];
  let lastStart = null, complete = false, stage = 'P1';
  const chain = (label) => {
    const entry = { label, id: (deps.newId ?? randomUUID)(), tidied: false };
    chains.push(entry);
    return entry;
  };
  const tidyChain = async (entry) => {
    if (entry.tidied) return;
    entry.tidied = true;
    await tidy(run, deps, entry, lines);
  };
  const confirmChain = async (entry, expected) => {
    const confirmed = await confirmTidy(run, deps, entry, lines, expected);
    if (confirmed) entry.tidied = true;
    return confirmed;
  };
  // Every attempt, including a retried unpaid refusal, starts at least 65 s after the previous attempt actually started,
  // with a fresh status preflight immediately before it. A P2-only run also rechecks the Helsinki deadline after the
  // pacing wait and again after the preflight, so nothing is sent once 7 October has ended; cleanup still runs.
  const pastDeadline = () => run.only === 'P2' && helsinkiDate((deps.wallNow ?? Date.now)()) > APPROVED_DELETE_BY;
  const send = async (plan) => {
    const first = deps.now();
    for (;;) {
      if (lastStart !== null) {
        const wait = DISPATCH_SPACING_MS - (deps.now() - lastStart);
        if (wait > 0) await deps.sleep(wait);
      }
      if (pastDeadline()) { lines.push(`Stopped before ${plan.outfit} step ${plan.step}: deadline_passed.`); return null; }
      let pre;
      try { pre = await status(run, deps); } catch { pre = { ok: false, code: 'statusUnreadable' }; }
      if (!pre.ok) { lines.push(`Stopped before ${plan.outfit} step ${plan.step}: ${pre.code}.`); return null; }
      if (pastDeadline()) { lines.push(`Stopped before ${plan.outfit} step ${plan.step}: deadline_passed.`); return null; }
      lastStart = deps.now();
      const outcome = await step(run, deps, plan);
      sent.push(outcome);
      if (outcome.paid) calls.push(outcome);
      lines.push(`${outcome.paid ? `Call ${calls.length}` : 'Refused before a claim'} (${plan.outfit} step ${plan.step}): `
        .concat(JSON.stringify(reportable(outcome))));
      if (!outcome.paid && RETRY_BEFORE_CLAIM.includes(outcome.code)
        && deps.now() - first + DISPATCH_SPACING_MS <= REFUSED_FOR_MS) continue;
      return outcome;
    }
  };
  try {
    probe: {
      if (run.only === 'P2') {
        // PROBE_ONLY=P2: the missing filter challenge only. One step, at most one paid call; P1 and P3 are never sent.
        stage = 'P2';
        const p2 = chain('P2');
        const outcome = await send({ outfit: 'P2', outfitId: run.outfits.P2, chainId: p2.id, step: 1, person: run.person, disconnect: false });
        if (outcome) {
          // Evidence is FILTERED, or a validated final result (last, with a result ID) whose picture is then deleted.
          // A malformed OK or an intermediate picture stays incomplete; it is only cleaned up, and no further step is sent.
          const final = outcome.code === 'OK' && outcome.last === true && typeof outcome.resultId === 'string' && UUID.test(outcome.resultId);
          const evidence = final || outcome.code === 'FILTERED';
          const label = final ? 'OK' : outcome.code === 'OK' ? 'OK_NOT_FINAL' : outcome.code;
          lines.push(`P2 filter challenge: ${evidence ? label : `${label} (recorded)`}.`);
          stage = 'P2 tidy';
          const confirmed = await confirmChain(p2, final ? { state: 'complete', resultId: outcome.resultId } : { state: 'running' });
          if (evidence && !confirmed) lines.push('Stopped after P2: P2_TIDY_UNCONFIRMED.');
          complete = evidence && confirmed;
        }
        break probe;
      }
      // Calls 1-3: P1, three steps. Intermediates stay in memory; only the final picture is written.
      const p1 = chain('P1');
      let person = run.person, p1Done = false;
      for (let index = 1; index <= 3; index++) {
        stage = `P1 step ${index}`;
        const outcome = await send({ outfit: 'P1', outfitId: run.outfits.P1, chainId: p1.id, step: index, person, disconnect: false });
        if (!outcome) break;
        if (outcome.code !== 'OK' || outcome.last !== (index === 3)) {
          lines.push(`Stopped after P1 step ${index}: ${outcome.code === 'OK' ? 'P1_NOT_THREE_STEPS' : outcome.code}.`);
          break;
        }
        if (index < 3) { person = outcome.image; continue; }
        stage = 'P1 result';
        let image;
        try { image = await rpc(run, deps, 'tryon_result_image_v1', { p_result_id: outcome.resultId }, RESULT_JSON_BYTES); } catch { image = null; }
        const bytes = image?.code === 'OK' && typeof image.jpegBase64 === 'string' ? new Uint8Array(Buffer.from(image.jpegBase64, 'base64')) : null;
        let admitted;
        try { admitted = bytes && bytes.byteLength <= OUTPUT_BYTES ? deps.admit(bytes) : null; } catch { admitted = null; }
        if (!admitted || admitted.stripped || admitted.width !== 1024 || admitted.height !== 1280) {
          lines.push('Stopped after P1 step 3: RESULT_UNREADABLE.');
          break;
        }
        stage = 'P1 write';
        try { await deps.writeFile(join(run.output, 'p1-final.jpg'), bytes, { flag: 'wx' }); } catch {
          lines.push('Stopped after P1 step 3: WRITE_FAILED.');
          break;
        }
        lines.push(`P1 final picture: ${JSON.stringify({ bytes: bytes.byteLength })}`);
        p1Done = true;
      }
      stage = 'P1 tidy';
      await tidyChain(p1);
      // Call 4: P3, one single-item step, disconnected 20 s after the request is sent. It settles only when the owner's
      // status shows no active attempt and either the step accepted (running, nextStep 2) or the chain complete with a
      // result. The chain must then be confirmed cancelled, or its picture deleted, before P2. No second P3 step is sent.
      let p3Done = false;
      if (p1Done) {
        stage = 'P3';
        const p3 = chain('P3');
        const outcome = await send({ outfit: 'P3', outfitId: run.outfits.P3, chainId: p3.id, step: 1, person: run.person, disconnect: true });
        if (outcome && (outcome.code === 'DISCONNECTED' || outcome.code === 'OK')) {
          if (outcome.code === 'OK') lines.push('P3 responded before the disconnect: call 4 acceptance is incomplete.');
          let settled = 'SETTLE_TIMEOUT', observed = null;
          for (let waited = 0; waited <= SETTLE_FOR_MS; waited += SETTLE_POLL_MS) {
            if (waited > 0) await deps.sleep(SETTLE_POLL_MS);
            let seen;
            try { seen = await rpc(run, deps, 'tryon_chain_status', { p_chain_id: p3.id }); } catch { seen = null; }
            const state = seen?.code === 'OK' && CHAIN_STATES.includes(seen.state) ? seen.state : null;
            const active = typeof seen?.activeAttempt === 'boolean' ? seen.activeAttempt : null;
            const next = Number.isSafeInteger(seen?.nextStep) ? seen.nextStep : null;
            lines.push(`P3 chain after ${waited / 1000} s: ${JSON.stringify(state && active !== null
              ? { state, activeAttempt: active, nextStep: next } : { code: 'statusUnreadable' })}`);
            if (state === null || active === null) { settled = 'STATUS_UNREADABLE'; break; }
            // An active attempt is never settled, whatever the state says.
            if ((state === 'running' || state === 'complete') && active) continue;
            if (state === 'running') {
              settled = next === 2 ? 'ACCEPTED' : 'P3_STEP_NOT_ACCEPTED';
              if (settled === 'ACCEPTED') observed = { state: 'running' };
            } else if (state === 'complete') {
              const valid = typeof seen.resultId === 'string' && UUID.test(seen.resultId);
              settled = valid ? 'COMPLETE' : 'P3_COMPLETE';
              if (valid) observed = { state: 'complete', resultId: seen.resultId };
            } else settled = `P3_${state.toUpperCase()}`;
            break;
          }
          if (observed) {
            lines.push(`P3 settled: ${settled}.`);
            stage = 'P3 tidy';
            if (await confirmChain(p3, observed)) p3Done = true;
            else lines.push('Stopped after P3: P3_TIDY_UNCONFIRMED; call 4 acceptance is incomplete.');
          } else lines.push(`Stopped after P3: ${settled}; call 4 acceptance is incomplete.`);
        } else if (outcome) {
          lines.push(`Stopped after P3: ${outcome.code}.`);
        }
        stage = 'P3 tidy';
        await tidyChain(p3);
      }
      // Call 5: P2, the filter challenge. OK and FILTERED are both evidence; it is last because a filter without usage
      // stops the authorisation.
      if (p3Done) {
        stage = 'P2';
        const p2 = chain('P2');
        const outcome = await send({ outfit: 'P2', outfitId: run.outfits.P2, chainId: p2.id, step: 1, person: run.person, disconnect: false });
        if (outcome) {
          const evidence = outcome.code === 'OK' || outcome.code === 'FILTERED';
          lines.push(`P2 filter challenge: ${evidence ? outcome.code : `${outcome.code} (recorded)`}.`);
          complete = evidence;
        }
        stage = 'P2 tidy';
        await tidyChain(p2);
      }
    }
  } catch {
    lines.push(`Stopped: unexpected failure during ${stage}; treat every request below as possibly paid.`);
    complete = false;
  } finally {
    for (const entry of chains) await tidyChain(entry);
  }
  lines.push(`Request IDs sent: ${sent.map((entry) => `${entry.requestId}${entry.paid ? '' : ' (refused before a claim)'}`).join(', ') || 'none'}`);
  lines.push(`Paid calls sent: ${calls.length} of at most ${run.only === 'P2' ? P2_ONLY_CALLS : PROBE_CALLS}.`);
  lines.push(`Outcome: ${complete ? 'COMPLETE' : 'INCOMPLETE'}. Call 4 PASS is decided from the SQL evidence only.`);
  lines.push(run.only === 'P2'
    ? `Delete by: ${APPROVED_DELETE_BY} (${DELETE_BY_ZONE}). Delete the photo by then, reviewed or not.`
    : 'Delete the photo and the final picture from PROBE_OUTPUT no later than 7 days after today, reviewed or not.');
  return { lines, complete, calls: calls.map((entry) => ({ ...entry, image: undefined })) };
}

async function main() {
  const { registerSourceLoader } = await import('./src-loader.mjs');
  registerSourceLoader();
  const { admitProviderJpeg } = await import('../src/images/provider-jpeg.ts');
  const { isPhotoInputJpeg } = await import('../src/images/restore-jpeg.ts');
  let result;
  try {
    result = await runProbe(process.env, {
      fetch, readFile, readdir, writeFile, now: () => performance.now(), wallNow: () => Date.now(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      admit: admitProviderJpeg,
      personInput: (bytes) => isPhotoInputJpeg(bytes, 1024, 1280, { bytes: PERSON_BYTES, side: 1280 }),
    });
  } catch (error) {
    if (error instanceof ProbeRefusal) {
      process.stderr.write(`Probe refused (${error.code}). Nothing was sent.\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write('Probe stopped unexpectedly. Reconcile any try-on usage for this owner from the SQL evidence.\n');
      process.exitCode = 3;
    }
    return;
  }
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (!result.complete) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
