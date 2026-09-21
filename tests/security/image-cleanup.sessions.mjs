import { reportError, fail } from '../../scripts/backend/local.mjs';
import { isMain } from '../../scripts/quality/files.mjs';
import {
  CLEANUP_RPCS, cleanupClient, withCleanupOwners, requireCleanup, newCleanupFixture,
  createCleanupFixture, destroyCleanupFixture, checkCleanupStatus, cleanupRpc, readCleanupPages,
} from '../integration/image-cleanup.sessions.mjs';

export async function runCleanupSecurity() {
  await withCleanupOwners(async ([owner, peer]) => {
    const value = newCleanupFixture(owner.uid);
    let primary;
    let failed = false;
    let teardownFailed = false;
    try {
      await createCleanupFixture(owner, value);
      const anonymous = cleanupClient(process.env);
      for (const [name, args] of CLEANUP_RPCS) {
        const result = await anonymous.rpc(name, args);
        requireCleanup([401, 403].includes(result.status) && result.error?.code === '42501', 'anonymous-rpc');
      }
      for (const actor of [owner, peer, { client: anonymous }]) {
        for (const table of ['image_cleanup_claims', 'image_cleanup_delete_context']) {
          const result = await actor.client.schema('private').from(table).select('*');
          requireCleanup(result.status === 406 && result.error?.code === 'PGRST106', 'private-table-denial');
        }
        const helper = await actor.client.schema('private').rpc('image_cleanup_old_enough', {
          p_kind: 'pending', p_time: '2000-01-01T00:00:00Z', p_now: '2026-01-01T00:00:00Z',
        });
        requireCleanup(helper.status === 406 && helper.error?.code === 'PGRST106', 'private-helper-denial');
      }
      const peerStatus = checkCleanupStatus(await cleanupRpc(peer, 'image_cleanup_status', {
        p_request_id: value.requestId,
      }), peer.uid, value.requestId);
      requireCleanup(peerStatus.state === 'not_started', 'peer-request-isolation');
      requireCleanup(!(await readCleanupPages(peer)).some((c) => c.image_id === value.imageId), 'peer-candidate-isolation');
      requireCleanup((await peer.client.rpc('begin_image_cleanup', {
        p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
        p_manifest_sha256: '0'.repeat(64),
      })).error?.code === '22023', 'peer-begin');
      requireCleanup((await peer.client.rpc('finish_image_cleanup', {
        p_request_id: value.requestId,
      })).error?.code === '22023', 'peer-finish');
      requireCleanup((await owner.client.rpc('begin_image_cleanup', {
        p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
        p_manifest_sha256: 'A'.repeat(64),
      })).error?.code === '22023', 'noncanonical-hash');
      for (const actor of [peer, { client: anonymous }]) {
        for (const path of [value.main, value.thumb]) {
          requireCleanup([400, 403, 404].includes((await actor.client.storage.from('wardrobe').download(path)).error?.status), 'foreign-bytes');
          requireCleanup([400, 403, 404].includes((await actor.client.storage.from('wardrobe').createSignedUrl(path, 60)).error?.status), 'foreign-sign');
        }
      }
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      try { await destroyCleanupFixture(owner, value); } catch { teardownFailed = true; }
    }
    if (failed && teardownFailed) fail('FAIL: image cleanup security and fixture teardown.', 1);
    if (teardownFailed) fail('FAIL: image cleanup security fixture teardown.', 1);
    if (failed) throw primary;
  });
  console.log('PASS: image cleanup ordinary peer/anonymous boundaries; disabled-owner assertions belong to the guarded rehearsal.');
}

if (isMain(import.meta.url)) runCleanupSecurity().catch(reportError);
