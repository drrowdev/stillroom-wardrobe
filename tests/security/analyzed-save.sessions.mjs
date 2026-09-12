import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { analyzedHarness, analyzedIntent } from '../integration/analyzed-save.sessions.mjs';
import { intent, saveClients, denied, eq } from '../integration/item-save.sessions.mjs';
import { requireEvidence } from '../integration/preservation.sessions.mjs';

async function main() {
  const harnesses = [];
  const [phase = 'baseline', ...extra] = process.argv.slice(2);
  try {
    requireEvidence(extra.length === 0 && ['baseline', 'full'].includes(phase));
    const { client, owners } = await saveClients(process.env);
    harnesses.push(...owners.map((owner) => analyzedHarness(client, owner, process.env)));
    for (const [index, owner] of owners.entries()) {
      const h = harnesses[index], peer = harnesses[1 - index];
      const value = phase === 'full' ? analyzedIntent(owner, 30) : h.track({ ...intent(), p_claim: null });
      const row = await h.reserve(value);
      const args = h.finalizeArgs(value, row);
      for (const name of ['analyzed_item_save_preflight', 'cancel_analyzed_item_save']) {
        denied(await peer.call(name, args));
        const anonymous = await h.call(name, args, null);
        requireEvidence(!anonymous.ok && anonymous.status === 401 && anonymous.data.code === '42501');
      }
      for (const token of [owner.token, owners[1 - index].token, null]) {
        const service = await h.call('complete_analyzed_item_save', { ...args, p_owner_id: owner.uid, p_objects: {} }, token);
        requireEvidence(!service.ok && [401, 403].includes(service.status) && service.data.code === '42501');
      }
      for (const table of ['ai_save_used_receipts', 'ai_item_save_attempts', 'ai_item_save_context', 'item_attribution_history']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          const result = await client.request(owner.token, `/rest/v1/${table}`, {
            method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
            headers: { 'Accept-Profile': 'private', 'Content-Profile': 'private' },
          });
          requireEvidence(!result.ok && result.status === 406 && result.data.code === 'PGRST106');
        }
      }
      for (const kind of ['ai_observed', 'ai_estimated']) {
        const imported = { ...intent().p_item, owner_id: owner.uid,
          field_provenance: { title: { kind, revision: 1 } } };
        const inserted = await client.request(owner.token, '/rest/v1/items', { method: 'POST', body: imported });
        denied(inserted, 'Invalid input');
        const patch = await client.request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${value.p_item.id}`,
          { method: 'PATCH', body: { field_provenance: {
            ...row.item.field_provenance, title: { kind, revision: 2 },
          } } });
        denied(patch, 'Invalid input');
      }
      eq((await h.read('items', value.p_item.id))[0], row.item);
      const foreign = await peer.call('item_attribution_history', { p_item_id: value.p_item.id });
      requireEvidence(!foreign.ok && foreign.data.code === '42501');
      if (phase === 'full') {
        for (const [token, extras, status] of [
          [owners[1 - index].token, {}, 409], [owner.token, { ownerId: owner.uid }, 400],
          [owner.token, { url: 'https://example.test' }, 400], ['invalid.jwt.token', {}, 401],
        ]) requireEvidence((await h.endpoint(value, row, token, extras)).status === status);
        const other = structuredClone(value);
        other.p_item.id = randomUUID(); other.p_image.id = randomUUID();
        denied(await h.call('reserve_analyzed_item_save', other));
        await h.finalize(value, row);
      }
    }
    console.log(`PASS: B2 security ${phase}; two normal owners and anonymous; raw/import/update/service/private barriers`);
  } catch {
    console.error(`FAIL: B2 security ${phase}; private details withheld`);
    process.exitCode = 1;
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: B2 security cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
