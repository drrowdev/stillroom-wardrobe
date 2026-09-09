import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalSessionEnvironment } from '../../scripts/backend/local.mjs';
import { isMain } from '../../scripts/quality/files.mjs';
import { normalClient, requireEvidence, TABLES, canonicalRows } from './preservation.sessions.mjs';

export const AI_POLICY = Object.freeze({
  model: 'fictional:controls/v1', prompt: 1, notice: 1, maximum: '5000', ttl: 3600,
  A: { allowance: '15000', rate: 20 }, B: { allowance: '100000', rate: 3 },
});
const fixed = (n) => `a129e000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const AI_IDS = Object.freeze({
  A: { ready: fixed(1), expiring: fixed(2), race: [fixed(3), fixed(4)] },
  B: { ready: fixed(11), spare: fixed(12), race: [fixed(13), fixed(14)] },
  withdraw: fixed(21), failure: fixed(22), expiry: fixed(23), purge: fixed(24),
  held: fixed(25), discard: fixed(26), delayed: fixed(27), overrun: fixed(28), missing: fixed(99),
});
export const AI_FACTS = Object.freeze({
  A: { outcome: 'ready', fields: { category: 'top', colours: ['green'], formality: 0, brand: 'Fictional A' } },
  B: { outcome: 'ready', fields: { category: 'bottom', colours: ['blue'], upper_coverage: 0, brand: 'Fictional B' } },
});
export const AI_FACT_VECTORS = Object.freeze([
  [{ outcome: 'ready', fields: {} }, true],
  [{ outcome: 'unclear', fields: { category: null, colours: [], formality: null, style_tags: [] } }, true],
  [{ outcome: 'ready', fields: { category: 'top', subcategory: '🌿'.repeat(60), colours: ['black', 'white', 'green'],
    pattern: 'solid', sleeve_length: 'long', garment_length: 'regular', brand: '🌿'.repeat(100),
    size_label: '🌿'.repeat(50), upper_coverage: 0, lower_coverage: 2, material: '🌿'.repeat(200),
    seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 4, style_tags: ['🌿'.repeat(40)] } }, true],
  ...['title', 'warmth', 'rain_rating', 'windproof', 'owner_id', 'modelId', 'confidence', '__proto__']
    .map((key) => [{ outcome: 'ready', fields: { [key]: null } }, false]),
  ...[
    { category: 'invalid' }, { colours: ['unknown'] }, { colours: null }, { colours: ['black', 'black'] },
    { colours: ['black', 'white', 'green', 'red'] }, { seasons: ['monsoon'] }, { seasons: ['spring', 'spring'] },
    { style_tags: ['same', 'same'] }, { style_tags: ['🌿'.repeat(41)] }, { style_tags: [' \t\n\u00a0\ufeff'] },
    { formality: 0.5 }, { formality: 5 }, { upper_coverage: -1 }, { lower_coverage: '0' },
    { subcategory: '🌿'.repeat(61) }, { brand: '🌿'.repeat(101) }, { size_label: '🌿'.repeat(51) },
    { material: '🌿'.repeat(201) }, { brand: '\u2000\u202f' },
  ].map((fields) => [{ outcome: 'ready', fields }, false]),
  [{ outcome: 'unclear', fields: { formality: 0 } }, false],
  [{ outcome: 'ready', fields: {}, extra: null }, false],
  [{ outcome: 'ready', fields: [] }, false],
  [{ outcome: 'other', fields: {} }, false],
  [null, false],
]);
export const AI_PHASES = Object.freeze([
  'P1', 'P3', 'S4-release-races', 'S4-withdraw', 'S4-restore',
  'S4-failure', 'S4-expiry', 'S4-purge', 'S4-held', 'S4-discard-reserve',
  'S4-discard', 'S4-delayed', 'S4-delayed-close', 'S4-overrun', 'P5', 'full',
]);
export function beginArgs(id, label = 'A') {
  return { p_request_id: id, p_draft_id: id, p_generation: 1, p_image_sha256: (label === 'A' ? 'a' : 'b').repeat(64) };
}
export const aiControl = (client, owner, id, action = 'status') =>
  client.rpc(owner, 'ai_request_control', { p_request_id: id, p_action: action });
export const aiStatus = (client, owner) => client.rpc(owner, 'ai_status', {});
const eq = (a, b) => requireEvidence(isDeepStrictEqual(a, b));
const oldProfile = ({ ai_enabled, ai_notice_revision, ai_consented_at, version, updated_at, ...rest }) => {
  void ai_enabled; void ai_notice_revision; void ai_consented_at; void version; void updated_at;
  return rest;
};

export async function aiClients(env) {
  // Also reject extra inherited environment values, not just known secret names.
  const stripped = normalSessionEnvironment(env, env);
  eq(Object.keys(env).sort(), Object.keys(stripped).sort());
  const client = normalClient(env);
  const owners = [await client.signIn('A'), await client.signIn('B')];
  requireEvidence(owners[0].uid !== owners[1].uid && owners[0].token !== owners[1].token);
  return { client, owners };
}

async function consent(client, owner, enabled) {
  const before = (await client.rows(owner, 'profiles'))[0];
  const args = { p_enabled: enabled, p_notice_revision: enabled ? AI_POLICY.notice : null, p_expected_version: before.version };
  eq(await client.rpc(owner, 'ai_set_consent', args), { code: 'OK', profileVersion: String(before.version + 1) });
  const after = (await client.rows(owner, 'profiles'))[0];
  eq(oldProfile(after), oldProfile(before));
  requireEvidence(after.ai_enabled === enabled && after.ai_notice_revision === args.p_notice_revision);
  requireEvidence(enabled ? typeof after.ai_consented_at === 'string' : after.ai_consented_at === null);
  eq(await client.rpc(owner, 'ai_set_consent', args), { code: 'CONFLICT' });
  eq((await client.rows(owner, 'profiles'))[0], after);
}

async function snapshot(client, owners) {
  const data = [];
  for (const owner of owners) {
    const tables = {};
    for (const table of TABLES) tables[table] = await client.rows(owner, table);
    tables.profiles = tables.profiles.map(oldProfile);
    const bytes = [];
    for (const image of tables.item_images) for (const variant of ['main', 'thumb']) {
      const downloaded = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${image[`${variant}_path`]}`);
      requireEvidence(downloaded.ok && Buffer.isBuffer(downloaded.data));
      bytes.push(createHash('sha256').update(downloaded.data).digest('hex'));
    }
    data.push({ tables, bytes });
  }
  return data;
}

async function populatedAdmissionProof(client, owners, action) {
  const bytes = await readFile(new URL('../security/fixture.jpg', import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex');
  requireEvidence(bytes.length === 632);
  const fixtures = [];
  try {
    for (const owner of owners) {
      const id = AI_IDS[owner.label].ready, paths = ['main', 'thumb'].map((v) => `${owner.uid}/${id}/${id}/${v}.jpg`);
      fixtures.push({ owner, id, paths });
      await client.insert(owner, 'items', { id, title: 'Fictional controls preservation', category: 'top' });
      await client.insert(owner, 'item_images', { id, item_id: id, main_bytes: bytes.length, thumb_bytes: bytes.length,
        main_sha256: hash, thumb_sha256: hash, width: 2, height: 2, alt_text: 'Fictional controls preservation' });
      for (const objectPath of paths) requireEvidence((await client.request(owner.token, `/storage/v1/object/wardrobe/${objectPath}`, {
        method: 'POST', body: bytes, binary: true, headers: { 'Cache-Control': 'max-age=0', 'x-upsert': 'false' },
      })).ok);
      await client.rpc(owner, 'commit_image', { p_image_id: id });
      await client.rpc(owner, 'save_outfit', { p_id: id, p_title: 'Fictional controls outfit', p_occasion: 'everyday',
        p_notes: '', p_favourite: false, p_item_ids: [id], p_expected_version: null });
      await client.rpc(owner, 'save_wear_event', { p_id: id, p_local_date: '2024-02-29', p_timezone: 'Europe/Stockholm',
        p_state: 'planned', p_label: 'Fictional controls history', p_outfit_id: id, p_item_ids: [id], p_expected_version: null });
    }
    const before = await snapshot(client, owners);
    requireEvidence(before.every((data) => data.bytes.length >= 2 && data.tables.wear_event_items.length >= 1));
    await action();
    eq(await snapshot(client, owners), before);
  } finally {
    for (const { owner, id, paths } of fixtures) {
      requireEvidence((await client.request(owner.token, '/storage/v1/object/wardrobe', {
        method: 'DELETE', body: { prefixes: paths },
      })).ok);
      requireEvidence((await client.request(owner.token, '/rest/v1/rpc/forget_image', {
        method: 'POST', body: { p_image_id: id },
      })).ok);
      for (const table of ['wear_events', 'outfits', 'items']) {
        requireEvidence((await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok);
      }
    }
  }
}

async function reserve(client, owner, id) {
  eq(await client.rpc(owner, 'ai_begin_request', beginArgs(id, owner.label)),
    { code: 'OK', status: 'reserved', replayed: false });
}

async function race(client, owner, expected) {
  const before = await aiStatus(client, owner);
  const replies = await Promise.all(AI_IDS[owner.label].race.map((id) => client.rpc(owner, 'ai_begin_request', beginArgs(id, owner.label))));
  eq(replies.map((r) => r.code).sort(), ['OK', expected].sort());
  const after = await aiStatus(client, owner);
  requireEvidence(before.period === after.period && after.usage.requestsLastHour === before.usage.requestsLastHour + 1);
  requireEvidence(BigInt(after.usage.accountedMicro) === BigInt(before.usage.accountedMicro) + 5000n);
  for (const [index, id] of AI_IDS[owner.label].race.entries()) {
    const result = await aiControl(client, owner, id);
    requireEvidence(replies[index].code === 'OK' ? result.status === 'reserved' : result.code === 'UNAVAILABLE');
  }
}

export async function requireReady(client, owners) {
  const results = [];
  for (const owner of owners) {
    const status = await aiStatus(client, owner);
    requireEvidence(status.code === 'OK' && status.consent.enabled === true
      && status.consent.noticeRevision === AI_POLICY.notice
      && status.policy.modelId === AI_POLICY.model && status.policy.promptVersion === AI_POLICY.prompt
      && status.policy.noticeRevision === AI_POLICY.notice && status.policy.activated === true);
    eq(status.policy, { activated: true, noticeRevision: AI_POLICY.notice, modelId: AI_POLICY.model,
      promptVersion: AI_POLICY.prompt, maxRequestMicro: AI_POLICY.maximum,
      monthlyAllowanceMicro: AI_POLICY[owner.label].allowance, maxRequestsPerHour: AI_POLICY[owner.label].rate,
      resultTtlSeconds: AI_POLICY.ttl });
    const ready = await aiControl(client, owner, AI_IDS[owner.label].ready);
    requireEvidence(ready.code === 'OK' && ready.status === 'ready');
    const result = ready.result;
    eq(Object.keys(result).sort(), ['schemaVersion', 'requestId', 'draftId', 'generation', 'imageSha256',
      'modelId', 'promptVersion', 'createdAtMs', 'expiresAtMs', 'facts'].sort());
    eq(result.facts, AI_FACTS[owner.label]);
    const args = beginArgs(AI_IDS[owner.label].ready, owner.label);
    requireEvidence(result.schemaVersion === 1 && result.requestId === args.p_request_id && result.draftId === args.p_draft_id
      && result.generation === 1 && result.imageSha256 === args.p_image_sha256
      && result.modelId === AI_POLICY.model && result.promptVersion === AI_POLICY.prompt
      && Number.isSafeInteger(result.createdAtMs) && Number.isSafeInteger(result.expiresAtMs)
      && result.expiresAtMs > status.serverTimeMs && result.expiresAtMs - result.createdAtMs === AI_POLICY.ttl * 1000
      && Buffer.byteLength(JSON.stringify(result)) <= 8192);
    results.push(ready);
  }
  requireEvidence(!isDeepStrictEqual(results[0].result.facts, results[1].result.facts));
  return results;
}

async function full(client, owners) {
  const ready = await requireReady(client, owners);
  for (const [index, owner] of owners.entries()) {
    const own = AI_IDS[owner.label].ready, foreign = AI_IDS[owners[1 - index].label].ready;
    const before = await aiStatus(client, owner);
    requireEvidence(owner.label === 'A'
      ? before.usage.accountedMicro === '16001' && before.usage.warning === true && before.usage.requestsLastHour < AI_POLICY.A.rate
      : before.usage.accountedMicro === '0' && before.usage.requestsLastHour === AI_POLICY.B.rate);
    eq(await client.rpc(owner, 'ai_begin_request', beginArgs(own, owner.label)), { code: 'OK', status: 'ready', replayed: true });
    for (const change of [{ p_draft_id: AI_IDS.missing }, { p_generation: 2 }, { p_image_sha256: 'c'.repeat(64) }]) {
      eq(await client.rpc(owner, 'ai_begin_request', { ...beginArgs(own, owner.label), ...change }), { code: 'CONFLICT' });
    }
    for (const action of ['status', 'discard']) {
      eq(await aiControl(client, owner, foreign, action), { code: 'UNAVAILABLE' });
      eq(await aiControl(client, owner, AI_IDS.missing, action), { code: 'UNAVAILABLE' });
    }
    eq(await aiControl(client, owner, own), ready[index]);
    const profile = (await client.rows(owner, 'profiles'))[0];
    eq(await client.rpc(owner, 'ai_set_consent', {
      p_enabled: false, p_notice_revision: null, p_expected_version: profile.version - 1,
    }), { code: 'CONFLICT' });
    eq((await client.rows(owner, 'profiles'))[0], profile);
    const after = await aiStatus(client, owner);
    requireEvidence(before.period === after.period);
    eq(after.usage, before.usage);
    eq(await client.rpc(owner, 'ai_begin_request', beginArgs(AI_IDS.missing, owner.label)),
      { code: owner.label === 'A' ? 'ALLOWANCE' : 'RATE_LIMIT' });
    for (const args of [
      { ...beginArgs(own, owner.label), p_generation: 0 },
      { ...beginArgs(own, owner.label), p_image_sha256: 'invalid' },
    ]) eq(await client.rpc(owner, 'ai_begin_request', args), { code: 'INVALID_INPUT' });
    const manifest = await client.rpc(owner, 'export_manifest', { p_export_id: AI_IDS.missing });
    eq(Object.keys(manifest.tables).sort(), [...TABLES].sort());
    for (const table of TABLES) {
      const rows = await client.rows(owner, table);
      if (table === 'profiles') {
        const { ai_enabled, ai_notice_revision, ai_consented_at, ...exported } = rows[0];
        void ai_enabled; void ai_notice_revision; void ai_consented_at;
        eq(manifest.tables.profiles, [exported]);
      } else eq(canonicalRows(table, manifest.tables[table]), rows);
    }
    requireEvidence(manifest.schema_version === 2);
  }
  eq(await aiControl(client, owners[0], AI_IDS.A.expiring), { code: 'TERMINAL', reason: 'EXPIRED' });
  for (const name of ['withdraw', 'failure', 'expiry', 'purge', 'held', 'discard', 'delayed', 'overrun']) {
    const terminal = await aiControl(client, owners[0], AI_IDS[name]);
    requireEvidence(terminal.code === 'TERMINAL' && typeof terminal.reason === 'string' && !Object.hasOwn(terminal, 'result'));
    eq(await client.rpc(owners[0], 'ai_begin_request', beginArgs(AI_IDS[name])), { code: 'TERMINAL' });
  }
  eq(await requireReady(client, owners), ready);
}

export async function runAiPhase(phase, client, owners) {
  requireEvidence(AI_PHASES.includes(phase));
  const [a, b] = owners;
  if (phase === 'P1') {
    for (const owner of owners) {
      const before = (await client.rows(owner, 'profiles'))[0];
      requireEvidence(before.ai_enabled === false && before.ai_notice_revision === null && before.ai_consented_at === null);
      const status = await aiStatus(client, owner);
      requireEvidence(status.code === 'UNCONFIGURED' && status.policy === null);
      eq(status.usage, { accountedMicro: '0', requestsLastHour: 0, warning: false });
      eq(await client.rpc(owner, 'ai_set_consent', {
        p_enabled: true, p_notice_revision: 1, p_expected_version: before.version,
      }), { code: 'UNCONFIGURED' });
      eq((await client.rows(owner, 'profiles'))[0], before);
      eq(await client.rpc(owner, 'ai_begin_request', beginArgs(AI_IDS[owner.label].ready, owner.label)), { code: 'UNCONFIGURED' });
      await consent(client, owner, false);
    }
  } else if (phase === 'P3') {
    for (const owner of owners) {
      const before = (await client.rows(owner, 'profiles'))[0];
      const changed = await client.patch(owner, 'profiles', before, {
        ...oldProfile(before), created_at: '2000-01-01T00:00:00Z',
        updated_at: '2000-01-01T00:00:00Z', version: 9000,
      });
      requireEvidence(changed.ok && changed.data.length === 1);
      eq(oldProfile(changed.data[0]), oldProfile(before));
      requireEvidence(changed.data[0].version === before.version + 1
        && changed.data[0].ai_enabled === before.ai_enabled && changed.data[0].ai_notice_revision === before.ai_notice_revision
        && changed.data[0].ai_consented_at === before.ai_consented_at);
      await consent(client, owner, true);
    }
    await reserve(client, a, AI_IDS.A.ready);
    await reserve(client, a, AI_IDS.A.expiring);
    await reserve(client, b, AI_IDS.B.ready);
    await reserve(client, b, AI_IDS.B.spare);
    for (const owner of owners) {
      const id = AI_IDS[owner.label].ready, before = await aiStatus(client, owner);
      eq(await client.rpc(owner, 'ai_begin_request', beginArgs(id, owner.label)), { code: 'OK', status: 'reserved', replayed: true });
      for (const change of [{ p_draft_id: AI_IDS.missing }, { p_generation: 2 }, { p_image_sha256: 'c'.repeat(64) }]) {
        eq(await client.rpc(owner, 'ai_begin_request', { ...beginArgs(id, owner.label), ...change }), { code: 'CONFLICT' });
      }
      eq(await client.rpc(owner, 'ai_begin_request', { ...beginArgs(id, owner.label), p_request_id: AI_IDS.missing }), { code: 'ACTIVE_DRAFT' });
      eq((await aiStatus(client, owner)).usage, before.usage);
      eq(await aiControl(client, owner, AI_IDS.missing), { code: 'UNAVAILABLE' });
    }
    await race(client, a, 'ALLOWANCE');
    await race(client, b, 'RATE_LIMIT');
  } else if (phase === 'S4-release-races') {
    for (const owner of owners) {
      const before = await aiStatus(client, owner);
      for (const id of AI_IDS[owner.label].race) {
        const result = await aiControl(client, owner, id);
        if (result.code === 'OK') eq(await aiControl(client, owner, id, 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
        else eq(result, { code: 'UNAVAILABLE' });
      }
      const after = await aiStatus(client, owner);
      requireEvidence(after.period === before.period && after.usage.requestsLastHour === before.usage.requestsLastHour
        && BigInt(after.usage.accountedMicro) === BigInt(before.usage.accountedMicro) - 5000n);
    }
    eq(await aiControl(client, b, AI_IDS.B.spare, 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
  } else if (phase === 'S4-withdraw') {
    await reserve(client, a, AI_IDS.withdraw);
    await consent(client, a, false);
    eq(await aiControl(client, a, AI_IDS.withdraw), { code: 'CONSENT_REQUIRED' });
  } else if (phase === 'S4-restore') {
    eq(await aiControl(client, a, AI_IDS.withdraw, 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
    await consent(client, a, true);
  } else if (phase === 'S4-discard') {
    await consent(client, a, false);
    eq(await aiControl(client, a, AI_IDS.discard), { code: 'CONSENT_REQUIRED' });
    eq(await aiControl(client, a, AI_IDS.discard, 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
  } else if (phase === 'S4-delayed-close') {
    const result = await aiControl(client, a, AI_IDS.delayed);
    requireEvidence(result.code === 'OK' && result.status === 'ready');
    eq(result.result.facts, AI_FACTS.A);
    requireEvidence(result.result.expiresAtMs - result.result.createdAtMs === AI_POLICY.ttl * 1000);
    eq(await aiControl(client, a, AI_IDS.delayed, 'discard'), { code: 'TERMINAL', reason: 'DISCARDED' });
  } else if (phase === 'P5') {
    eq(await aiControl(client, a, AI_IDS.A.expiring), { code: 'TERMINAL', reason: 'EXPIRED' });
    await full(client, owners);
  } else if (phase === 'full') await full(client, owners);
  else {
    const name = { 'S4-failure': 'failure', 'S4-expiry': 'expiry', 'S4-purge': 'purge',
      'S4-held': 'held', 'S4-discard-reserve': 'discard', 'S4-delayed': 'delayed', 'S4-overrun': 'overrun' }[phase];
    requireEvidence(typeof name === 'string');
    if (phase === 'S4-delayed') await consent(client, a, true);
    await reserve(client, a, AI_IDS[name]);
  }
}

async function main() {
  const args = process.argv.slice(2), phase = args[0] ?? 'full';
  try {
    requireEvidence(args.length <= 1 && AI_PHASES.includes(phase));
    const { client, owners } = await aiClients(process.env);
    const before = await snapshot(client, owners);
    if (phase === 'P3') await populatedAdmissionProof(client, owners, () => runAiPhase(phase, client, owners));
    else await runAiPhase(phase, client, owners);
    eq(await snapshot(client, owners), before);
    console.log(`PASS: AI controls ${phase}; normal owners=2`);
  } catch {
    console.error('FAIL: AI controls normal-session evidence; reset disposable fixtures with npm run db:reset; no self-repair');
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
