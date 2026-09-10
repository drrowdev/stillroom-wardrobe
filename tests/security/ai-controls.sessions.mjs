import { isDeepStrictEqual } from 'node:util';
import { isMain } from '../../scripts/quality/files.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';
import { AI_IDS, AI_POLICY, AI_FACTS, aiClients, aiControl, requireReady, beginArgs } from '../integration/ai-controls.sessions.mjs';

const eq = (a, b) => requireEvidence(isDeepStrictEqual(a, b));
async function main() {
  try {
    requireEvidence(process.argv.length === 2);
    const { client, owners } = await aiClients(process.env);
    const ready = await requireReady(client, owners);
    for (const [index, owner] of owners.entries()) {
      const peer = owners[1 - index], id = AI_IDS[peer.label].ready;
      const profile = (await client.rows(owner, 'profiles'))[0];
      for (const body of [
        { ai_enabled: true }, { ai_notice_revision: AI_POLICY.notice }, { ai_consented_at: profile.ai_consented_at },
        { ai_enabled: false, display_name: profile.display_name },
      ]) {
        const denied = await client.patch(owner, 'profiles', profile, body);
        requireEvidence(!denied.ok && denied.status === 403 && denied.data.code === '42501');
        eq((await client.rows(owner, 'profiles'))[0], profile);
      }
      for (const action of ['status', 'discard']) {
        eq(await aiControl(client, owner, id, action), { code: 'UNAVAILABLE' });
        eq(await aiControl(client, owner, AI_IDS.missing, action), { code: 'UNAVAILABLE' });
      }
      for (const [rpc, body] of [
        ['ai_mark_dispatched', { p_owner_id: peer.uid, p_request_id: id }],
        ['ai_settle_request', { p_owner_id: peer.uid, p_request_id: id, p_facts: AI_FACTS[peer.label], p_billed_micro: 0, p_code: 'SUCCESS' }],
        ['ai_purge_expired', { p_limit: 1 }],
      ]) {
        const denied = await client.request(owner.token, `/rest/v1/rpc/${rpc}`, { method: 'POST', body });
        requireEvidence(!denied.ok && denied.status === 403 && denied.data.code === '42501');
      }
      for (const table of ['ai_controls', 'ai_usage', 'ai_requests']) {
        const hidden = await client.request(owner.token, `/rest/v1/${table}?select=*`, { headers: { 'Accept-Profile': 'private' } });
        requireEvidence(!hidden.ok && hidden.status === 406 && hidden.data.code === 'PGRST106');
      }
      const stale = await client.rpc(owner, 'ai_set_consent', {
        p_enabled: false, p_notice_revision: null, p_expected_version: profile.version - 1,
      });
      eq(stale, { code: 'CONFLICT' });
      eq((await client.rows(owner, 'profiles'))[0], profile);
    }
    for (const [name, body] of [
      ['ai_status', {}],
      ['ai_set_consent', { p_enabled: true, p_notice_revision: 1, p_expected_version: 1 }],
      ['ai_begin_request', beginArgs(AI_IDS.A.ready)],
      ['ai_request_control', { p_request_id: AI_IDS.A.ready, p_action: 'status' }],
      ['ai_request_control', { p_request_id: AI_IDS.B.ready, p_action: 'discard' }],
      ['ai_mark_dispatched', { p_owner_id: owners[0].uid, p_request_id: AI_IDS.A.ready }],
      ['ai_settle_request', { p_owner_id: owners[0].uid, p_request_id: AI_IDS.A.ready, p_facts: AI_FACTS.A, p_billed_micro: 0, p_code: 'SUCCESS' }],
      ['ai_purge_expired', { p_limit: 1 }],
    ]) {
      const denied = await client.request(null, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      requireEvidence(!denied.ok && denied.status === 401 && denied.data.code === '42501');
    }
    eq(await requireReady(client, owners), ready);
    console.log('PASS: AI controls security; normal owners=2 anonymous=1; Data API refusal, not SQL metadata proof');
  } catch {
    console.error('FAIL: AI controls security evidence; reset disposable fixtures with npm run db:reset; no self-repair');
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
