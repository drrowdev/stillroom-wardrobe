import { isMain } from '../../scripts/quality/files.mjs';
import { normalClient, requireEvidence } from '../integration/preservation.sessions.mjs';

// P6c: an ordinary or anonymous session can never drive account deletion for itself or the other owner.
// The Edge boundary (owner only from the verified session, body limited to the password) is covered by the
// handler unit tests and the isolated deletion rehearsal; this suite never deletes anything.
async function main() {
  try {
    requireEvidence(process.argv.length === 2);
    const client = normalClient(process.env);
    const owners = [await client.signIn('A'), await client.signIn('B')];
    requireEvidence(owners[0].uid !== owners[1].uid);
    const items = async (owner) => {
      const result = await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&select=id,version&order=id`);
      requireEvidence(result.ok && Array.isArray(result.data));
      return JSON.stringify(result.data);
    };
    const before = await Promise.all(owners.map(items));
    for (const token of [owners[0].token, owners[1].token, null]) {
      for (const target of owners) {
        for (const action of ['begin', 'resume', 'storage_removed', 'auth_removed', 'grant', 'reconcile', 'status']) {
          const denied = await client.request(token, '/rest/v1/rpc/deletion_control', { method: 'POST',
            body: { p_owner_id: target.uid, p_action: action, p_op: '00000000-0000-4000-8000-000000000001' } });
          requireEvidence(!denied.ok && denied.status === (token ? 403 : 401) && denied.data?.code === '42501');
        }
      }
      const purge = await client.request(token, '/rest/v1/rpc/purge_deletion_receipts', { method: 'POST', body: {} });
      requireEvidence(!purge.ok && purge.status === (token ? 403 : 401) && purge.data?.code === '42501');
      for (const name of ['deletion_receipt', 'deletion_owner_rows_absent', 'release_deleted_admission']) {
        const hidden = await client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body: {}, headers: { 'Content-Profile': 'private' } });
        requireEvidence(!hidden.ok && hidden.status === 406 && hidden.data?.code === 'PGRST106');
      }
    }
    requireEvidence(JSON.stringify(await Promise.all(owners.map(items))) === JSON.stringify(before));
    for (const owner of owners) requireEvidence((await client.signIn(owner.label)).uid === owner.uid);
    console.log('PASS: P6c ordinary/anonymous deletion-control and receipt-purge refusals; both owners unchanged');
  } catch {
    console.error('FAIL: P6c deletion security evidence; private details withheld; state preserved');
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
