import {
  OUTFITGEN_LIMITS, OUTFITGEN_MANIFEST, OUTFITGEN_MODEL, OUTFITGEN_RESERVATION_MICRO, buildOutfitGenRequest, isSuggestion,
  parseOutfitGenBody, parseOutfitGenItem, validateOutfitGenReply, type OutfitGenItem, type OutfitGenMode,
} from '../../../src/domain/outfitgen.ts';
import { buildBatch, setKey, type CandidateBans, type CandidateItem } from '../../../src/domain/outfit-candidates.ts';
import { AI_BUDGET_CONTRACT, AI_BUDGET_CONTRACT_HEADER, parseAiBudget } from '../../../src/domain/ai-budget.ts';
import { azureConfigured, type AzureConfig, type AzureTransport } from '../analyze-clothing/azure-openai.ts';
import { UUID, object, ProtocolError, readBounded, readJson, sha256, validAccounting, type JsonObject } from '../analyze-clothing/protocol.ts';
import { callOutfitGen } from './azure.ts';

export type OutfitGenConfig = { supabaseUrl: string; publicKey: string; serviceKey: string; azure: AzureConfig };
export type OutfitGenRegistrar = (work: Promise<unknown>) => void;
export const OUTFITGEN_RPCS = ['outfitgen_status', 'outfitgen_plan', 'outfitgen_assess', 'outfitgen_claim', 'outfitgen_finish'] as const;
const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, UNAVAILABLE: 403, CONSENT_REQUIRED: 403, TERMINAL: 409, CONFLICT: 409, PENDING_FULL: 409,
  TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, FILTERED: 422, ALLOWANCE: 429, RATE_LIMIT: 429, COOLDOWN: 429,
  FAILED: 502, UNCONFIGURED: 503, INACTIVE: 503, CONFIG_CHANGED: 503, BUSY: 503, TIMEOUT: 504,
};
const finishCodes: Record<string, string> = {
  EXPIRED: 'TIMEOUT', NOT_DISPATCHED: 'FAILED', INVALID_USAGE: 'FAILED', USAGE_ANOMALY: 'FAILED', USAGE_CONFLICT: 'FAILED',
};
const allowedHeaders = ['authorization', 'apikey', 'content-type', 'x-client-info', AI_BUDGET_CONTRACT_HEADER.toLowerCase()];
const HEX64 = /^[0-9a-f]{64}$/;
const microText = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const count = (value: unknown, max = 1_000_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const timeoutFailure = (failure: unknown) => failure instanceof DOMException && ['TimeoutError', 'AbortError'].includes(failure.name);
const stage = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

function closedCode(value: unknown): string {
  const code = typeof value === 'string' && Object.hasOwn(finishCodes, value) ? finishCodes[value] : value;
  return typeof code === 'string' && Object.hasOwn(statusCodes, code) ? code : 'FAILED';
}
function allowedOrigin(origin: string | null, url: string): boolean {
  if (origin === null || origin === 'https://stillroom-wardrobe.pages.dev') return true;
  return /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(url)
    && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin);
}
function serverConfig(config: OutfitGenConfig): boolean {
  return (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl)
    || /^http:\/\/(?:127\.0\.0\.1:54321|kong:8000)$/.test(config.supabaseUrl))
    && typeof config.publicKey === 'string' && config.publicKey.length > 0 && config.publicKey.length <= 8192
    && typeof config.serviceKey === 'string' && config.serviceKey.length > 0 && config.serviceKey.length <= 8192;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

type Plan = { items: OutfitGenItem[]; pairs: Set<string>; disliked: Set<string>; known: Set<string> };
function parsePlan(value: JsonObject): Plan | null {
  if (!Array.isArray(value.items) || value.items.length > OUTFITGEN_LIMITS.items || !Array.isArray(value.pairs)
    || !Array.isArray(value.disliked) || !Array.isArray(value.known)) return null;
  const items: OutfitGenItem[] = [];
  for (const entry of value.items) {
    const item = parseOutfitGenItem(entry);
    if (!item) return null;
    items.push(item);
  }
  const pairs = new Set<string>(), disliked = new Set<string>(), known = new Set<string>();
  for (const pair of value.pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((id) => typeof id === 'string' && UUID.test(id))) return null;
    pairs.add(setKey(pair as string[]));
  }
  for (const set of value.disliked) {
    if (!Array.isArray(set) || set.length < 1 || set.length > 12 || !set.every((id) => typeof id === 'string' && UUID.test(id))) return null;
    disliked.add(setKey(set as string[]));
  }
  for (const signature of value.known) {
    if (typeof signature !== 'string' || !HEX64.test(signature)) return null;
    known.add(signature);
  }
  return { items, pairs, disliked, known };
}

/**
 * Outfit judging (OUTFITGEN1a, INACTIVE until the owner's switch and consent). One request is one batch and one provider call.
 * Order: closed body (no RPC on invalid input), verified /auth/v1/user, owner status preflight, service plan, deterministic
 * candidate batch, the batch's photos read with the OWNER's JWT (no hold yet, so a failed read costs nothing), service claim
 * (one live batch per owner, frozen signatures, reservation held), then the claimed work, which is registered with the runtime so
 * it always finishes even if the browser is gone: one provider call, strict one-verdict-per-candidate validation, finish.
 * The model only judges server-built candidates by ref; its output is plain data and never calls any write RPC.
 */
export function createOutfitGenHandler(config: OutfitGenConfig, registrar: OutfitGenRegistrar | null, azureTransport: AzureTransport = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const reply = (body: JsonObject, status: number) => Response.json(body, { status, headers });
    const error = (code: string) => reply({ code: closedCode(code) }, statusCodes[closedCode(code)]!);
    if (!allowedOrigin(origin, config.supabaseUrl)) return error('UNAVAILABLE');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(OUTFITGEN_LIMITS.handlerMs)]);
    try {
      const url = new URL(request.url);
      if (url.search || !['/outfit-generate', '/functions/v1/outfit-generate'].includes(url.pathname)) return error('INVALID_INPUT');
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'POST'
          || (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').some((value) =>
            value.trim() !== '' && !allowedHeaders.includes(value.trim().toLowerCase()))) return error('INVALID_INPUT');
        headers.set('Access-Control-Allow-Methods', 'POST');
        headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'POST') return error('INVALID_INPUT');
      const bearer = request.headers.get('Authorization') ?? '';
      if (!bearer.startsWith('Bearer ') || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(bearer.slice(7))) return error('UNAUTHENTICATED');
      if (!serverConfig(config)) return error('UNCONFIGURED');
      if (request.headers.get(AI_BUDGET_CONTRACT_HEADER) !== AI_BUDGET_CONTRACT) return error('UNAVAILABLE');
      if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || request.headers.has('Content-Encoding')) return error('UNSUPPORTED_MEDIA');
      const length = request.headers.get('Content-Length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > OUTFITGEN_LIMITS.bodyBytes)) return error('TOO_LARGE');
      const raw = await readBounded(request.body, OUTFITGEN_LIMITS.bodyBytes, signal);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return error('INVALID_INPUT'); }
      const input = parseOutfitGenBody(parsed);
      if (!input) return error('INVALID_INPUT');

      const authSignal = stage(signal, 5000);
      const auth = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal: authSignal,
      });
      const user = await readJson(auth, 65536, authSignal);
      if (!auth.ok || !object(user) || typeof user.id !== 'string' || !UUID.test(user.id)
        || user.role !== 'authenticated' || user.is_anonymous !== false) return error('UNAUTHENTICATED');
      const owner = user.id;
      const rpc = async (name: (typeof OUTFITGEN_RPCS)[number], body: JsonObject, service = false, limit = 32768, ms = 5000): Promise<JsonObject> => {
        const dbSignal = stage(signal, ms);
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: dbSignal,
          headers: { Authorization: service ? 'Bearer '.concat(config.serviceKey) : bearer,
            apikey: service ? config.serviceKey : config.publicKey, 'Content-Type': 'application/json',
            [AI_BUDGET_CONTRACT_HEADER]: AI_BUDGET_CONTRACT },
          body: JSON.stringify(body),
        });
        const result = await readJson(response, limit, dbSignal);
        if (!response.ok || !object(result) || typeof result.code !== 'string') throw new ProtocolError('FAILED');
        return result;
      };

      const preflight = await rpc('outfitgen_status', {});
      if (preflight.code !== 'OK') return error(closedCode(preflight.code));
      // A database that ignored the contract header answers in the old shape: refused before any claim.
      if (parseAiBudget(preflight.budget) === null) return error('UNAVAILABLE');
      const policy = preflight.policy, consent = preflight.consent;
      if (!object(policy) || policy.activated !== true) return error('INACTIVE');
      if (!object(consent) || consent.enabled !== true || consent.noticeRevision !== policy.noticeRevision) return error('CONSENT_REQUIRED');
      if (policy.noticeRevision !== 1 || policy.manifestId !== OUTFITGEN_MANIFEST || policy.modelId !== OUTFITGEN_MODEL
        || !microText(policy.maxRequestMicro) || BigInt(policy.maxRequestMicro as string) < BigInt(OUTFITGEN_RESERVATION_MICRO)
        || !azureConfigured(config.azure) || !count(preflight.pending, 100) || !count(preflight.autoCallsLeft, 3)
        || !count(preflight.autoUnassessed, 1_000_000) || typeof preflight.live !== 'boolean' || !count(preflight.serverTimeMs, 2 ** 53)
        || !(preflight.cooldownUntilMs === undefined || preflight.cooldownUntilMs === null || count(preflight.cooldownUntilMs, 2 ** 53))) return error('UNCONFIGURED');
      // W1: without a way to keep the claimed work alive, nothing is claimed.
      if (registrar === null) return error('UNCONFIGURED');
      if (preflight.live) return error('BUSY');
      if (preflight.pending >= OUTFITGEN_LIMITS.pending) return error('PENDING_FULL');
      if (input.mode === 'auto') {
        if (preflight.autoCallsLeft === 0 || (typeof preflight.cooldownUntilMs === 'number' && preflight.cooldownUntilMs > preflight.serverTimeMs)) return error('COOLDOWN');
        if (preflight.autoUnassessed === 0) return reply({ code: 'OK', suggested: 0, judged: 0, remaining: false }, 200);
      }

      const planned = await rpc('outfitgen_plan', { p_owner_id: owner }, true, 2 * 1024 * 1024, 10000);
      if (planned.code !== 'OK') return error(closedCode(planned.code));
      const plan = parsePlan(planned);
      if (!plan) throw new ProtocolError('FAILED');
      const byId = new Map(plan.items.map((item) => [item.id, item]));
      const unassessed = new Set(plan.items.filter((item) => item.unassessed).map((item) => item.id));
      const anchors = anchorOrder(plan.items, input.mode);
      const candidateItems: (CandidateItem & { imageBytes: number })[] = plan.items.map((item) => ({ id: item.id, category: item.category,
        colours: item.colours, pattern: item.pattern, seasons: item.seasons, formality: item.formality, favourite: item.favourite,
        imageBytes: item.image.bytes }));
      const bans: CandidateBans = { pairs: plan.pairs, disliked: plan.disliked };
      const batch = await buildBatch({ items: candidateItems, anchors, known: plan.known, bans });
      const assessable = batch.covered.filter((id) => unassessed.has(id));
      const remaining = batch.uncovered.some((id) => unassessed.has(id));
      if (batch.sets.length === 0) {
        if (assessable.length) {
          const marked = await rpc('outfitgen_assess', { p_owner_id: owner, p_items: assessable }, true);
          if (marked.code !== 'OK') return error(closedCode(marked.code));
        }
        return reply({ code: 'OK', suggested: 0, judged: 0, remaining }, 200);
      }

      const garments = batch.garments.map((id) => byId.get(id)!);
      const images: string[] = [];
      for (const garment of garments) {
        if (!garment.image.path.startsWith(`${owner}/`)) throw new ProtocolError('FAILED');
        const bytes = await downloadGarment(config, bearer, garment, stage(signal, OUTFITGEN_LIMITS.downloadMs));
        if (bytes === null) return error('FAILED');
        images.push(base64(bytes));
      }
      const built = buildOutfitGenRequest(input.language, garments, images, batch.sets.map((set) => set.ids));
      const claim = await rpc('outfitgen_claim', { p_owner_id: owner, p_request_id: input.requestId, p_manifest_id: OUTFITGEN_MANIFEST,
        p_auto: input.mode === 'auto', p_signatures: batch.sets.map((set) => set.signature), p_targets: assessable }, true);
      if (claim.code !== 'OK' || claim.claimed !== true) return error(closedCode(claim.code));
      if (claim.manifestId !== OUTFITGEN_MANIFEST || typeof claim.dispatchBeforeMs !== 'number' || !Number.isSafeInteger(claim.dispatchBeforeMs)) {
        // The held row expires by the expiry job; nothing was dispatched.
        throw new ProtocolError('FAILED');
      }

      let accept!: (registered: boolean) => void;
      const registration = new Promise<boolean>((resolve) => { accept = resolve; });
      const work = runClaimed({ config, owner, requestId: input.requestId, built, sets: batch.sets.map((set) => set.ids),
        assessable, remaining, dispatchBeforeMs: claim.dispatchBeforeMs, registration, azureTransport });
      try { registrar(work); accept(true); } catch { accept(false); }
      const outcome = await work;
      // Delivery only: the settlement has already run whether or not the browser is still there.
      if (request.signal.aborted) return error('TIMEOUT');
      if (outcome.code !== 'OK') return error(outcome.code);
      return reply({ code: 'OK', suggested: outcome.suggested, judged: outcome.judged, remaining: outcome.remaining }, 200);
    } catch (failure) {
      return error(signal.aborted || timeoutFailure(failure) ? 'TIMEOUT' : failure instanceof ProtocolError ? failure.code : 'FAILED');
    }
  };
}

/** Auto: items added since consent that are not assessed. Manual: every unassessed item, else the least-covered ones. */
function anchorOrder(items: readonly OutfitGenItem[], mode: OutfitGenMode): string[] {
  const byId = (a: OutfitGenItem, b: OutfitGenItem) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (mode === 'auto') return items.filter((item) => item.auto).sort(byId).map((item) => item.id);
  const fresh = items.filter((item) => item.unassessed).sort(byId);
  if (fresh.length) return fresh.map((item) => item.id);
  return [...items].sort((a, b) => a.coverage - b.coverage || byId(a, b)).slice(0, 8).map((item) => item.id);
}

// The stored main photo, read with the owner's own JWT (never the service role), with the plan's length and hash.
async function downloadGarment(config: OutfitGenConfig, bearer: string, item: OutfitGenItem, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const path = item.image.path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/wardrobe/${path}`, {
    headers: { Authorization: bearer, apikey: config.publicKey }, redirect: 'error', cache: 'no-store', signal,
  });
  if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'image/jpeg') {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readBounded(response.body, item.image.bytes, signal); } catch (failure) {
    if (failure instanceof ProtocolError) return null;
    throw failure;
  }
  return bytes.length === item.image.bytes && bytes[0] === 0xff && bytes[1] === 0xd8 && await sha256(bytes) === item.image.sha256 ? bytes : null;
}

type Claimed = {
  config: OutfitGenConfig; owner: string; requestId: string; built: ReturnType<typeof buildOutfitGenRequest>; sets: string[][];
  assessable: string[]; remaining: boolean; dispatchBeforeMs: number; registration: Promise<boolean>; azureTransport: AzureTransport;
};
type ClaimedOutcome = { code: string; suggested: number; judged: number; remaining: boolean };

// The claimed work has its own lifetime: it never rejects and is not tied to the browser. A provider call or finish that
// misses its deadline is left held for the expiry job; any other failure after the claim is FAILED and never a pre-claim code.
function runClaimed(work: Claimed): Promise<ClaimedOutcome> {
  return (async (): Promise<ClaimedOutcome> => {
    const fail = (code: string): ClaimedOutcome => ({ code, suggested: 0, judged: 0, remaining: work.remaining });
    const server = AbortSignal.timeout(OUTFITGEN_LIMITS.handlerMs);
    const finish = async (code: 'OK' | 'FAILED' | 'FILTERED' | 'NOT_DISPATCHED', usage: unknown, results: unknown, assessed: string[] | null) => {
      const response = await fetch(`${work.config.supabaseUrl}/rest/v1/rpc/outfitgen_finish`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: stage(server, 10000),
        headers: { Authorization: 'Bearer '.concat(work.config.serviceKey), apikey: work.config.serviceKey, 'Content-Type': 'application/json',
          [AI_BUDGET_CONTRACT_HEADER]: AI_BUDGET_CONTRACT },
        body: JSON.stringify({ p_owner_id: work.owner, p_request_id: work.requestId, p_code: code, p_usage: usage ?? null,
          p_results: results ?? null, p_assessed: assessed }),
      });
      const result = await readJson(response, 32768, server);
      if (!response.ok || !object(result) || typeof result.code !== 'string') throw new ProtocolError('FAILED');
      if (result.code !== 'BUSY' && !validAccounting(result.accounting)) throw new ProtocolError('FAILED');
      return result;
    };
    try {
      // No dispatch until the runtime has accepted this promise. A refused registration spends nothing.
      if (!await work.registration || Date.now() >= work.dispatchBeforeMs) {
        await finish('NOT_DISPATCHED', null, null, null);
        return fail('UNCONFIGURED');
      }
      const outcome = await callOutfitGen(work.config.azure, work.built.body, stage(server, OUTFITGEN_LIMITS.requestMs), work.azureTransport);
      const verdicts = outcome.code === 'OK' ? validateOutfitGenReply(outcome.content, work.built.candidateRefs) : null;
      const code = outcome.code === 'OK' && !verdicts ? 'FAILED' : outcome.code;
      const results = verdicts ? verdicts.map((verdict, index) => ({ items: work.sets[index]!,
        decision: isSuggestion(verdict) ? 'suggested' : 'declined', score: verdict.score, occasion: verdict.occasion,
        title: isSuggestion(verdict) ? verdict.title : null, reason: isSuggestion(verdict) ? verdict.reason : null })) : null;
      const finished = await finish(code, outcome.usage, results, results ? work.assessable : null);
      if (finished.code !== 'OK' || code !== 'OK' || !results) return fail(closedCode(finished.code === 'OK' ? code : String(finished.code)));
      const recorded = object(finished.recorded) ? finished.recorded : null;
      return { code: 'OK', suggested: count(recorded?.suggested, 100) ? recorded.suggested : 0, judged: results.length, remaining: work.remaining };
    } catch (failure) {
      return fail(server.aborted || timeoutFailure(failure) ? 'TIMEOUT' : 'FAILED');
    }
  })();
}
