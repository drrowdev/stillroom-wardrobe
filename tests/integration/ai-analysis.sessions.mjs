import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertLoopbackUrl } from '../../scripts/backend/local.mjs';
import { isMain } from '../../scripts/quality/files.mjs';
import { readJson } from '../../supabase/functions/analyze-clothing/protocol.ts';
import { jpegHeaderFixture, joinBytes, exifSegment } from '../fixtures/jpeg-helpers.ts';
import { aiClients, aiStatus, aiControl, requireReady, AI_IDS, beginArgs } from './ai-controls.sessions.mjs';
import { requireEvidence } from './preservation.sessions.mjs';

export const analysisId = (label, n) => {
  requireEvidence(['A', 'B'].includes(label) && Number.isInteger(n) && n >= 1 && n <= 32);
  return `b129${label.toLowerCase()}000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
export const analysisFacts = { outcome: 'ready', fields: { category: 'top', colours: ['green'], formality: 0 } };
export const analysisUsage = { modelVersion: 'gemini-3.8-flash', trafficType: 'ON_DEMAND',
  promptTokenCount: 100, totalTokenCount: 130, candidatesTokenCount: 10, thoughtsTokenCount: 20 };
export const analysisStatus = (client, owner, id) => client.rpc(owner, 'ai_analysis_status', { p_request_id: id });
export const equal = (a, b) => requireEvidence(isDeepStrictEqual(a, b));
export const analysisHash = createHash('sha256').update(jpegHeaderFixture()).digest('hex');
export async function analysisRequest(origin, env, owner, n, options = {}) {
  const base = assertLoopbackUrl(origin);
  requireEvidence(new URL(base).hostname === '127.0.0.1');
  const id = analysisId(owner.label, n);
  const signal = AbortSignal.timeout(20_000);
  const response = await fetch(`${base}/functions/v1/analyze-clothing${options.suffix ?? ''}`, {
    method: options.method ?? 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { Authorization: 'Bearer '.concat(owner.token), apikey: env.SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'image/jpeg', 'X-Stillroom-Request-Id': id, 'X-Stillroom-Draft-Id': id,
      'X-Stillroom-Generation': '1', ...options.headers },
    ...(['GET', 'OPTIONS'].includes(options.method) ? {} : { body: options.body ?? jpegHeaderFixture() }),
  });
  requireEvidence(response.headers.get('Cache-Control') === 'no-store'
    && response.headers.get('X-Content-Type-Options') === 'nosniff');
  const data = await readJson(response, 32768, signal);
  return { status: response.status, data };
}
export async function baseline(client, owners) {
  const ready = await requireReady(client, owners);
  for (const owner of owners) {
    equal(await analysisStatus(client, owner, AI_IDS[owner.label].ready), { code: 'UNAVAILABLE' });
    const status = await aiStatus(client, owner);
    requireEvidence(status.usage.accountedMicro === (owner.label === 'A' ? '16001' : '0'));
    requireEvidence(owner.label === 'A' ? status.usage.warning === true : status.usage.requestsLastHour === 3);
  }
  return ready;
}
async function consent(client, owner, enabled) {
  const before = (await client.rows(owner, 'profiles'))[0];
  const args = { p_enabled: enabled, p_notice_revision: enabled ? 1 : null, p_expected_version: before.version };
  equal(await client.rpc(owner, 'ai_set_consent', args), { code: 'OK', profileVersion: String(before.version + 1) });
  equal(await client.rpc(owner, 'ai_set_consent', args), { code: 'CONFLICT' });
  const after = (await client.rows(owner, 'profiles'))[0];
  requireEvidence(after.version === before.version + 1 && after.ai_enabled === enabled);
  const omit = ({ version, updated_at, ai_enabled, ai_notice_revision, ai_consented_at, ...rest }) => {
    void version; void updated_at; void ai_enabled; void ai_notice_revision; void ai_consented_at; return rest;
  };
  equal(omit(before), omit(after));
}
const stages = ['served', 'validation', 'ready', 'concurrent', 'legacy', 'lost', 'failed', 'unknown',
  'zero', 'discard', 'withdraw', 'restore', 'expired', 'config', 'overrun', 'http-failed'];
export async function runAnalysisStage(stage, origin, env) {
  requireEvidence(stages.includes(stage));
  const { client, owners } = await aiClients(env);
  for (const [index, owner] of owners.entries()) {
    const call = (n, options) => analysisRequest(origin, env, owner, n, options);
    if (stage === 'served') {
      equal(await call(1), { status: 503, data: { code: 'UNCONFIGURED' } });
    } else if (stage === 'validation') {
      for (const options of [
        { suffix: '?provider=other' }, { suffix: '/extra' }, { headers: { 'X-Stillroom-Generation': '0' } },
        { headers: { 'X-Stillroom-Request-Id': 'not-uuid' } }, { headers: { 'X-Stillroom-Generation': '2147483648' } },
        { body: jpegHeaderFixture(1601) }, { body: new Uint8Array([1, 2]) },
        { body: joinBytes(jpegHeaderFixture(), new Uint8Array([0])) },
        { body: joinBytes(new Uint8Array([255, 216]), exifSegment(1), jpegHeaderFixture().slice(2)) },
      ]) equal(await call(32, options), { status: 400, data: { code: 'INVALID_INPUT' } });
      equal(await call(32, { headers: { 'Content-Type': 'application/json' } }), { status: 415, data: { code: 'UNSUPPORTED_MEDIA' } });
      equal(await call(32, { headers: { 'Content-Encoding': 'gzip' } }), { status: 415, data: { code: 'UNSUPPORTED_MEDIA' } });
      equal(await call(32, { body: new Uint8Array(512001) }), { status: 413, data: { code: 'TOO_LARGE' } });
      equal(await call(32, { headers: { Authorization: '******' } }), { status: 401, data: { code: 'UNAUTHENTICATED' } });
      equal(await call(32, { headers: { Origin: 'null' } }), { status: 403, data: { code: 'UNAVAILABLE' } });
    } else if (stage === 'ready' || stage === 'concurrent') {
      const n = stage === 'ready' ? 1 : 2;
      const replies = stage === 'ready' ? [await call(n)] : await Promise.all([call(n), call(n)]);
      requireEvidence(replies.every((r) => [200, 202].includes(r.status)) && replies.some((r) => r.status === 200));
      const persisted = await analysisStatus(client, owner, analysisId(owner.label, n));
      equal((await call(n)).data, persisted);
      requireEvidence(persisted.status === 'ready' && persisted.result.imageSha256 === analysisHash
        && persisted.result.requestId === analysisId(owner.label, n) && persisted.result.modelId === 'gemini-3.8-flash');
      equal(persisted.result.facts, analysisFacts);
      equal(persisted.accounting, { basis: 'estimated', amountMicro: '413', currency: 'USD' });
      equal(await analysisStatus(client, owners[1 - index], analysisId(owner.label, n)), { code: 'UNAVAILABLE' });
      equal(await analysisStatus(client, owners[1 - index], analysisId(owner.label, 32)), { code: 'UNAVAILABLE' });
      equal(await call(n, { body: jpegHeaderFixture(121) }), { status: 409, data: { code: 'CONFLICT' } });
    } else if (stage === 'legacy') {
      equal(await client.rpc(owner, 'ai_begin_request', beginArgs(analysisId(owner.label, 3))),
        { code: 'OK', status: 'reserved', replayed: false });
      equal(await call(3), { status: 409, data: { code: 'CONFLICT' } });
      equal(await analysisStatus(client, owner, analysisId(owner.label, 3)), { code: 'UNAVAILABLE' });
      equal(await aiControl(client, owner, analysisId(owner.label, 3), 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
    } else if (stage === 'lost') {
      const response = await call(4);
      requireEvidence(response.status === 202 && response.data.status === 'dispatched' && response.data.result === null);
      equal(response.data.accounting, { basis: 'held', amountMicro: '2270823', currency: 'USD' });
      equal(await call(16, { headers: { 'X-Stillroom-Draft-Id': analysisId(owner.label, 4) } }),
        { status: 409, data: { code: 'ACTIVE_DRAFT' } });
    } else if (['failed', 'http-failed'].includes(stage)) {
      equal(await call(stage === 'failed' ? 5 : 20), { status: 502, data: { code: 'ANALYSIS_FAILED' } });
    } else if (['unknown', 'zero'].includes(stage)) {
      const response = await call(stage === 'unknown' ? 6 : 7);
      requireEvidence(response.status === 200 && response.data.status === 'ready');
      equal(response.data.accounting, { basis: stage === 'unknown' ? 'held' : 'estimated',
        amountMicro: stage === 'unknown' ? '2270823' : '0', currency: 'USD' });
    } else if (stage === 'discard') {
      equal(await aiControl(client, owner, analysisId(owner.label, 8), 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
      equal(await call(8), { status: 409, data: { code: 'TERMINAL' } });
    } else if (stage === 'withdraw') {
      await consent(client, owner, false);
      equal(await call(9), { status: 403, data: { code: 'CONSENT_REQUIRED' } });
      const status = await analysisStatus(client, owner, analysisId(owner.label, 9));
      requireEvidence(!Object.hasOwn(status, 'result') && status.code !== 'OK');
    } else if (stage === 'restore') {
      await consent(client, owner, true);
      const terminal = await analysisStatus(client, owner, analysisId(owner.label, 9));
      requireEvidence(terminal.code === 'TERMINAL' && !Object.hasOwn(terminal, 'result'));
    } else if (stage === 'expired') {
      equal(await analysisStatus(client, owner, analysisId(owner.label, 10)), { code: 'TERMINAL', reason: 'EXPIRED' });
    } else if (stage === 'config') {
      equal(await analysisStatus(client, owner, analysisId(owner.label, 17)), { code: 'CONFIG_CHANGED' });
    } else if (stage === 'overrun') {
      equal(await call(15), { status: 503, data: { code: 'INACTIVE' } });
      const status = await analysisStatus(client, owner, analysisId(owner.label, 15));
      requireEvidence(!Object.hasOwn(status, 'result') && status.code === 'TERMINAL');
    }
  }
}
async function main() {
  let stage = 'baseline';
  try {
    const args = process.argv.slice(2);
    requireEvidence(args.length === 0 || args.length === 2 && stages.includes(args[0]));
    if (args.length) { stage = args[0]; await runAnalysisStage(stage, args[1], process.env); }
    else { const { client, owners } = await aiClients(process.env); await baseline(client, owners); }
    console.log(`PASS: B1 ordinary-session ${stage}; owners=2; no provider or hosted transport`);
  } catch {
    console.error(`FAIL: B1 ordinary-session ${stage}; private evidence withheld; state preserved`);
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
