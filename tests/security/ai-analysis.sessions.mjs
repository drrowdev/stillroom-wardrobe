import { isMain } from '../../scripts/quality/files.mjs';
import { aiClients, AI_IDS, requireReady } from '../integration/ai-controls.sessions.mjs';
import { analysisId, analysisFacts, analysisUsage, analysisStatus, equal } from '../integration/ai-analysis.sessions.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';

async function main() {
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await aiClients(process.env);
    const ready = await requireReady(client, owners);
    for (const owner of owners) {
      const id = analysisId(owner.label, 32);
      const calls = [
        ['ai_claim_analysis', { p_owner_id: owner.uid, p_request_id: id, p_draft_id: id, p_generation: 1,
          p_image_sha256: 'a'.repeat(64), p_byte_count: 1, p_width: 1, p_height: 1, p_manifest_id: 'google-eu-3.8-v1' }],
        ['ai_finish_analysis', { p_owner_id: owner.uid, p_request_id: id, p_manifest_id: 'google-eu-3.8-v1',
          p_facts: analysisFacts, p_usage: analysisUsage, p_code: 'SUCCESS' }],
      ];
      for (const token of [owner.token, null]) {
        for (const [name, body] of calls) {
          const denied = await client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
          requireEvidence(!denied.ok && denied.status === (token ? 403 : 401) && denied.data.code === '42501');
        }
        for (const table of ['ai_usage_evidence', 'ai_analysis_attestations', 'ai_execution_manifests']) {
          const denied = await client.request(token, `/rest/v1/${table}?select=*`, { headers: { 'Accept-Profile': 'private' } });
          requireEvidence(!denied.ok && denied.status === 406 && denied.data.code === 'PGRST106');
        }
        for (const name of ['ai_begin_owner', 'ai_settle_core', 'ai_normal_usage', 'ai_analysis_permitted', 'ai_accounting']) {
          const denied = await client.request(token, `/rest/v1/rpc/${name}`, {
            method: 'POST', body: {}, headers: { 'Content-Profile': 'private' },
          });
          requireEvidence(!denied.ok && denied.status === 406 && denied.data.code === 'PGRST106');
        }
      }
      for (const target of [AI_IDS.A.ready, AI_IDS.B.ready, id])
        equal(await analysisStatus(client, owner, target), { code: 'UNAVAILABLE' });
      const denied = await client.request(null, '/rest/v1/rpc/ai_analysis_status', { method: 'POST', body: { p_request_id: id } });
      requireEvidence(!denied.ok && denied.status === 401 && denied.data.code === '42501');
    }
    equal(await requireReady(client, owners), ready);
    console.log('PASS: B1 ordinary/anonymous RPC and private-schema refusals; legacy envelopes preserved');
  } catch {
    console.error('FAIL: B1 security evidence; private details withheld; state preserved');
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
