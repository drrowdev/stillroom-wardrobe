import { randomUUID } from 'node:crypto';
import {
  assertNoServiceSecrets, assertProjectConfig, requireLocalContainer, readCredentialCache,
  normalSessionEnvironment, validateSessionEnvironment, privilegedLocalSql, fail, reportError,
  withAnalyzedSaveFixtureLock,
} from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { assertRehearsalEnvironment, withLifecycleLateUpload } from './preservation-rehearsal.mjs';
import {
  CLEANUP_RPCS, CLEANUP_IMAGE_HASH, withCleanupOwners, requireCleanup, newCleanupFixture,
  createCleanupFixture, destroyCleanupFixture, cleanupRpc, checkCleanupStatus, checkCleanupPage,
  readCleanupPages, removeCleanupObject, resumeCleanupFixture,
  cleanupImageRow,
} from '../tests/integration/image-cleanup.sessions.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOTAL_MS = 480_000;
const TEARDOWN_MS = 120_000;

export function assertImageCleanupRehearsal(env, args) {
  requireCleanup(Array.isArray(args) && args.length === 0
    && env.ALLOW_IMAGE_CLEANUP_REHEARSAL === '1'
    && env.CI === 'true' && env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_REPOSITORY === 'drrowdev/stillroom-wardrobe' && env.GITHUB_JOB === 'database', 'rehearsal-admission');
  assertNoServiceSecrets(env);
  assertRehearsalEnvironment(env, args);
}

function identity(value) {
  requireCleanup(typeof value === 'string' && UUID.test(value), 'control-identity');
  return `'${value}'::uuid`;
}

function target(value) {
  return `owner_id=${identity(value.ownerId)} and item_id=${identity(value.itemId)} and id=${identity(value.imageId)}`;
}

function storageTarget(value) {
  for (const id of [value.ownerId, value.itemId, value.imageId]) identity(id);
  return `bucket_id='wardrobe' and name in('${value.main}','${value.thumb}')`;
}

function budget(deadline, teardown = false) {
  requireCleanup(performance.now() + (teardown ? 0 : TEARDOWN_MS) < deadline, 'rehearsal-deadline');
}

async function control(sql, deadline, teardown = false) {
  budget(deadline, teardown);
  const result = await privilegedLocalSql(`begin;
set local statement_timeout='8s';
set local lock_timeout='2s';
set local idle_in_transaction_session_timeout='10s';
${sql}
commit;
select 'I10A_CONTROL_OK';`);
  requireCleanup(result === 'I10A_CONTROL_OK', 'fixture-control');
  budget(deadline, teardown);
}

async function ageFixture(value, kind, deadline) {
  requireCleanup(['pending', 'retired', 'orphan'].includes(kind), 'fixture-kind');
  const rows = kind === 'pending'
    ? `update public.item_images set created_at=clock_timestamp()-interval '25 hours' where ${target(value)};`
    : kind === 'retired'
      ? `update public.item_images set state='retired',retired_at=clock_timestamp()-interval '8 days' where ${target(value)};`
      : '';
  await control(`${rows}
update storage.objects set created_at=clock_timestamp()-interval '8 days' where ${storageTarget(value)};`, deadline);
}

async function requireAbsentBytes(owner, value) {
  for (const path of [value.main, value.thumb]) {
    const download = await owner.client.storage.from('wardrobe').download(path);
    const signed = await owner.client.storage.from('wardrobe').createSignedUrl(path, 60);
    requireCleanup([400, 403, 404].includes(download.error?.status), 'removed-download');
    requireCleanup([400, 403, 404].includes(signed.error?.status), 'removed-sign');
  }
  const list = await owner.client.storage.from('wardrobe').list(`${owner.uid}/${value.itemId}/${value.imageId}`);
  requireCleanup(!list.error && Array.isArray(list.data) && list.data.length === 0, 'removed-list');
}

async function candidateFor(owner, value) {
  const candidates = await readCleanupPages(owner);
  const candidate = candidates.find((entry) => entry.item_id === value.itemId && entry.image_id === value.imageId);
  requireCleanup(candidate, 'fixture-candidate');
  return candidate;
}

async function beginFixture(owner, value, candidate = undefined) {
  const selected = candidate ?? await candidateFor(owner, value);
  const status = checkCleanupStatus(await cleanupRpc(owner, 'begin_image_cleanup', {
    p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
    p_manifest_sha256: selected.manifest_sha256,
  }), owner.uid, value.requestId);
  requireCleanup(status.state === 'active' && status.item_id === value.itemId
    && status.image_id === value.imageId, 'begin-identity');
  return status;
}

async function requireLateState(owner, value, deadline) {
  const status = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {
    p_request_id: value.requestId,
  }), owner.uid, value.requestId);
  requireCleanup(status.state === 'active' && status.paths.every((p) => !p.present), 'late-active-claim');
  await control(`do $late$
begin
  if not exists(select 1 from public.item_images where ${target(value)} and state='pending')
    or not exists(select 1 from public.items where owner_id=${identity(owner.uid)}
      and id=${identity(value.itemId)} and deleted_at is null)
    or exists(select 1 from private.item_deletion_claims where owner_id=${identity(owner.uid)}
      and item_id=${identity(value.itemId)})
    or exists(select 1 from private.ai_item_save_attempts where owner_id=${identity(owner.uid)}
      and item_id=${identity(value.itemId)} and cancelled)
    or exists(select 1 from storage.objects where bucket_id='wardrobe'
      and starts_with(name,'${owner.uid}/${value.itemId}/')) then raise exception 'I10A_LATE_STATE'; end if;
end;
$late$;`, deadline);
}

async function latePublication(owner, value, deadline) {
  await createCleanupFixture(owner, value, { upload: false });
  await ageFixture(value, 'pending', deadline);
  const parentBefore = await owner.client.from('items').select('*').eq('id', value.itemId).single();
  requireCleanup(!parentBefore.error, 'late-parent-baseline');
  const candidate = await candidateFor(owner, value);
  const intent = Object.freeze({
    p_item: Object.freeze({ id: value.itemId }), p_image: Object.freeze({ id: value.imageId }),
  });
  const frozen = JSON.stringify(intent);
  await withLifecycleLateUpload(owner, intent, async () => {
    await beginFixture(owner, value, candidate);
    // Leave the pending image, parent and active image claim intact through native settlement.
    const image = await owner.client.from('item_images').select('id,state').eq('id', value.imageId).single();
    const parent = await owner.client.from('items').select('id,deleted_at').eq('id', value.itemId).single();
    requireCleanup(!image.error && image.data.state === 'pending'
      && !parent.error && parent.data.deleted_at === null, 'late-callback-state');
  });
  requireCleanup(JSON.stringify(intent) === frozen, 'late-intent-preserved');
  await requireLateState(owner, value, deadline);
  await requireAbsentBytes(owner, value);
  for (const path of [value.main, value.thumb]) {
    requireCleanup(await removeCleanupObject(owner, path) === 'missing', 'late-canonical-missing');
  }
  await resumeCleanupFixture(owner, value);
  const parentAfter = await owner.client.from('items').select('*').eq('id', value.itemId).single();
  requireCleanup(!parentAfter.error && JSON.stringify(parentAfter.data) === JSON.stringify(parentBefore.data), 'late-parent-preserved');
  console.log('PASS: admitted native slow upload denied with pending/live/active cleanup state; no paired unclaimed control or precise guard trace.');
}

async function housekeeping(owner, ready, pending, deadline) {
  await withAnalyzedSaveFixtureLock(owner.uid, pending.itemId, pending.imageId, 'profile', async () => {
    const read = await owner.client.storage.from('wardrobe').download(ready.main);
    requireCleanup(!read.error && read.data.size === 4, 'profile-lock-photo-read');
    await control(`update storage.objects set updated_at=updated_at where ${storageTarget(ready)};`, deadline);
  });
  await control(`do $identity$
begin
  begin
    update storage.objects set version=coalesce(version,'') || '-changed' where ${storageTarget(ready)};
    raise exception 'I10A_VERSION_ACCEPTED';
  exception when unique_violation then null; end;
  begin
    update storage.objects set id=gen_random_uuid() where ${storageTarget(ready)};
    raise exception 'I10A_IDENTITY_ACCEPTED';
  exception when insufficient_privilege then null; end;
end;
$identity$;`, deadline);
}

async function activeIdentity(value, deadline) {
  await control(`do $accepted$
declare claim private.image_cleanup_claims; modified private.image_cleanup_claims; checked jsonb;
begin
  select * into strict claim from private.image_cleanup_claims where owner_id=${identity(value.ownerId)}
    and request_id=${identity(value.requestId)} and state='active';
  begin
    update storage.objects set updated_at=updated_at where ${storageTarget(value)};
    raise exception 'I10A_ACTIVE_UPDATE_ACCEPTED';
  exception when insufficient_privilege then null; end;
  checked := private.image_cleanup_checked_status(claim);
  if checked->>'state'<>'active' then raise exception 'I10A_ACTIVE_STATUS'; end if;
  modified := claim;
  select jsonb_agg(o || jsonb_build_object('created_at','2000-01-01T00:00:00+00:00') order by o->>'name')
    into modified.objects from jsonb_array_elements(claim.objects) o;
  modified.manifest_sha256 := private.image_cleanup_manifest(modified.owner_id,modified.item_id,modified.image_id,
    modified.kind,private.image_cleanup_image(modified.owner_id,modified.item_id,modified.image_id),modified.objects);
  if private.image_cleanup_checked_status(modified)->>'state'<>'active' then raise exception 'I10A_FROZEN_TIME'; end if;
  modified := claim;
  modified.objects := jsonb_set(modified.objects,'{0,id}',to_jsonb(gen_random_uuid()));
  modified.manifest_sha256 := private.image_cleanup_manifest(modified.owner_id,modified.item_id,modified.image_id,
    modified.kind,private.image_cleanup_image(modified.owner_id,modified.item_id,modified.image_id),modified.objects);
  begin
    perform private.image_cleanup_checked_status(modified);
    raise exception 'I10A_CHANGED_OBJECT_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  modified := claim;
  modified.objects := '[]'::jsonb;
  modified.manifest_sha256 := private.image_cleanup_manifest(modified.owner_id,modified.item_id,modified.image_id,
    modified.kind,private.image_cleanup_image(modified.owner_id,modified.item_id,modified.image_id),modified.objects);
  begin
    perform private.image_cleanup_checked_status(modified);
    raise exception 'I10A_NEW_OBJECT_ACCEPTED';
  exception when invalid_parameter_value then null; end;
end;
$accepted$;`, deadline);
}

async function reverseItemClaim(owner, value, deadline) {
  await createCleanupFixture(owner, value, { ready: true });
  const parent = await owner.client.from('items').select('version').eq('id', value.itemId).single();
  requireCleanup(!parent.error, 'item-first-parent');
  const trashed = await cleanupRpc(owner, 'set_item_trashed', {
    p_item_id: value.itemId, p_expected_version: parent.data.version, p_trashed: true,
  });
  await ageFixture(value, 'retired', deadline);
  const candidate = await candidateFor(owner, value);
  const before = await cleanupRpc(owner, 'item_deletion_status', { p_item_ids: [value.itemId] });
  const itemRequest = randomUUID();
  const args = {
    p_item_id: value.itemId, p_expected_version: trashed[0].version, p_request_id: itemRequest,
    p_image_manifest_sha256: before[0].image_manifest_sha256,
  };
  await cleanupRpc(owner, 'begin_item_deletion', args);
  let primary;
  let failed = false;
  let cleanupFailed = false;
  try {
    requireCleanup((await owner.client.rpc('begin_image_cleanup', {
      p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
      p_manifest_sha256: candidate.manifest_sha256,
    })).error?.code === '22023', 'cleanup-after-item-claim');
    requireCleanup((await cleanupRpc(owner, 'begin_item_deletion', args))[0].request_id === itemRequest, 'existing-item-resume');
  } catch (error) { primary = error; failed = true; }
  finally {
    try {
      for (const path of [value.main, value.thumb]) requireCleanup(await removeCleanupObject(owner, path) === 'removed', 'item-first-removal');
      const finished = await cleanupRpc(owner, 'finish_item_deletion', { p_item_id: value.itemId, p_request_id: itemRequest });
      requireCleanup(finished[0].state === 'completed', 'item-first-finish');
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) fail(failed ? 'FAIL: image cleanup item-first primary and teardown.' : 'FAIL: image cleanup item-first teardown.', 1);
  if (failed) throw primary;
}

async function orphanInsertionOrder(owner, value, first, deadline) {
  await createCleanupFixture(owner, value);
  requireCleanup(!(await owner.client.from('items').delete().eq('owner_id', owner.uid).eq('id', value.itemId)).error, 'insertion-orphan');
  await ageFixture(value, 'orphan', deadline);
  await control(`delete from private.item_image_used_ids where owner_id=${identity(owner.uid)}
    and image_id=${identity(value.imageId)};`, deadline);
  requireCleanup(!(await owner.client.from('items').insert({
    id: value.itemId, owner_id: owner.uid, title: 'Cleanup insertion fixture', category: 'top',
  })).error, 'insertion-parent');
  const candidate = await candidateFor(owner, value);
  const args = {
    p_request_id: value.requestId, p_item_id: value.itemId, p_image_id: value.imageId,
    p_manifest_sha256: candidate.manifest_sha256,
  };
  if (first === 'metadata') {
    requireCleanup(!(await owner.client.from('item_images').insert(cleanupImageRow(value))).error, 'metadata-first');
    requireCleanup((await owner.client.rpc('begin_image_cleanup', args)).error?.code === '22023', 'metadata-first-claim-refused');
    requireCleanup((await cleanupRpc(owner, 'image_cleanup_status', { p_request_id: value.requestId })).state === 'not_started', 'metadata-first-no-claim');
  } else if (first === 'cleanup') {
    await beginFixture(owner, value, candidate);
    requireCleanup((await owner.client.from('item_images').insert(cleanupImageRow(value))).error?.code === '22023', 'cleanup-first-metadata-refused');
    await resumeCleanupFixture(owner, value);
    requireCleanup((await owner.client.from('item_images').insert(cleanupImageRow(value))).error?.code === '22023', 'completed-reburn-refusal');
  } else {
    // Join both ordinary requests even on failure; no losing mutation is detached.
    const [inserted, begun] = await Promise.allSettled([
      owner.client.from('item_images').insert(cleanupImageRow(value)),
      owner.client.rpc('begin_image_cleanup', args),
    ]);
    requireCleanup(inserted.status === 'fulfilled' && begun.status === 'fulfilled', 'insertion-race-transport');
    requireCleanup(inserted.value.error || begun.value.error, 'no-dual-insertion-winner');
    if (!begun.value.error) {
      requireCleanup(inserted.value.error?.code === '22023', 'insertion-race-insert-conflict');
      checkCleanupStatus(begun.value.data, owner.uid, value.requestId);
      await resumeCleanupFixture(owner, value);
    } else {
      requireCleanup(begun.value.error.code === '22023', 'insertion-race-claim-conflict');
      if (inserted.value.error) requireCleanup(inserted.value.error.code === '22023', 'insertion-race-bounded-contention');
    }
  }
}

async function ageBoundaries(deadline) {
  await control(`do $boundary$
declare instant timestamptz := '2026-09-16 00:00:00+00'; kind text; duration interval;
begin
  foreach kind in array array['pending','retired','orphan'] loop
    duration := case kind when 'pending' then interval '24 hours' else interval '7 days' end;
    if private.image_cleanup_old_enough(kind,instant-duration,instant)
      or not private.image_cleanup_old_enough(kind,instant-duration-interval '1 microsecond',instant)
      or private.image_cleanup_old_enough(kind,instant+interval '1 microsecond',instant)
      or private.image_cleanup_old_enough(kind,null,instant)
      or private.image_cleanup_old_enough(kind,'infinity',instant)
      or private.image_cleanup_old_enough(kind,'-infinity',instant)
      or private.image_cleanup_old_enough(kind,instant,null) then raise exception 'I10A_BOUNDARY'; end if;
  end loop;
  if private.image_cleanup_old_enough('ready',instant-interval '10 days',instant) then
    raise exception 'I10A_BOUNDARY';
  end if;
end;
$boundary$;`, deadline);
}

async function seedRetention(pending, retired, deadline) {
  for (const [value, state] of [[pending, 'reserved'], [retired, 'completed']]) {
    const completed = state === 'completed' ? "'2026-09-16 00:00:01+00'::timestamptz" : 'null';
    await control(`insert into private.item_save_attempts(owner_id,item_id,image_id,fingerprint,state,created_at,completed_at)
values(${identity(value.ownerId)},${identity(value.itemId)},${identity(value.imageId)},repeat('a',64),'${state}',
  '2026-09-16 00:00:00+00'::timestamptz,${completed});
insert into private.ai_item_save_attempts(owner_id,item_id,fields)
values(${identity(value.ownerId)},${identity(value.itemId)},'{}');
insert into private.item_save_used_ids(owner_id,item_id,image_id)
values(${identity(value.ownerId)},${identity(value.itemId)},${identity(value.imageId)});
insert into private.ai_save_used_receipts(owner_id,request_id,item_id,image_id)
values(${identity(value.ownerId)},${identity(value.requestId)},${identity(value.itemId)},${identity(value.imageId)});
${state === 'completed' ? `insert into private.item_attribution_history(owner_id,item_id,source_image_id,image_sha256,model_id,prompt_version,fields)
values(${identity(value.ownerId)},${identity(value.itemId)},${identity(value.imageId)},'${CLEANUP_IMAGE_HASH}','cleanup-structural-fixture',1,'{}');` : ''}`, deadline);
  }
}

async function checkRetention(value, completedAttempt, deadline) {
  await control(`do $retention$
begin
  if not exists(select 1 from private.item_save_attempts s join private.ai_item_save_attempts a
    on a.owner_id=s.owner_id and a.item_id=s.item_id
    where s.owner_id=${identity(value.ownerId)} and s.item_id=${identity(value.itemId)}
      and s.image_id is null and s.fingerprint=repeat('a',64)
      and s.state='${completedAttempt ? 'completed' : 'reserved'}'
      and s.created_at='2026-09-16 00:00:00+00'::timestamptz
      and s.completed_at is not distinct from ${completedAttempt ? "'2026-09-16 00:00:01+00'::timestamptz" : 'null::timestamptz'}
      and a.cancelled=${completedAttempt ? 'false' : 'true'} and a.fields='{}'::jsonb)
    or not exists(select 1 from private.item_save_used_ids where owner_id=${identity(value.ownerId)}
      and item_id=${identity(value.itemId)} and image_id=${identity(value.imageId)})
    or not exists(select 1 from private.ai_save_used_receipts where owner_id=${identity(value.ownerId)}
      and request_id=${identity(value.requestId)} and item_id=${identity(value.itemId)} and image_id=${identity(value.imageId)})
    or not exists(select 1 from private.item_image_used_ids where owner_id=${identity(value.ownerId)}
      and image_id=${identity(value.imageId)})
    ${completedAttempt ? `or not exists(select 1 from private.item_attribution_history where owner_id=${identity(value.ownerId)}
      and item_id=${identity(value.itemId)} and source_image_id is null and fields='{}'::jsonb
      and image_sha256='${CLEANUP_IMAGE_HASH}' and model_id='cleanup-structural-fixture' and prompt_version=1)` : ''}
    then raise exception 'I10A_RETENTION'; end if;
end;
$retention$;`, deadline);
}

async function disabledOwner(owner, deadline) {
  let disabled = false;
  let primary;
  let failed = false;
  let restored = false;
  try {
    disabled = true;
    await control(`do $enabled$
begin
  if not exists(select 1 from private.approved_accounts where user_id=${identity(owner.uid)} and enabled) then
    raise exception 'I10A_ENABLED_BASELINE';
  end if;
  update private.approved_accounts set enabled=false where user_id=${identity(owner.uid)};
end;
$enabled$;`, deadline);
    for (const [name, args] of CLEANUP_RPCS) {
      const result = await owner.client.rpc(name, args);
      requireCleanup(result.error?.code === '42501', 'disabled-owner');
    }
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    if (disabled) {
      try {
        await control(`update private.approved_accounts set enabled=true where user_id=${identity(owner.uid)};
do $restored$
begin
  if not exists(select 1 from private.approved_accounts where user_id=${identity(owner.uid)} and enabled) then
    raise exception 'I10A_ENABLED_RESTORE';
  end if;
end;
$restored$;`, deadline, true);
        restored = true;
      } catch {
        restored = false;
      }
    } else restored = true;
  }
  if (failed && !restored) fail('FAIL: image cleanup disabled-owner assertion and restoration.', 1);
  if (!restored) fail('FAIL: image cleanup disabled-owner restoration.', 1);
  if (failed) throw primary;
}

export async function withImageCleanupFixtures(operation) {
  assertImageCleanupRehearsal(process.env, []);
  requireCleanup(typeof operation === 'function', 'fixture-callback');
  const started = performance.now();
  const deadline = started + TOTAL_MS;
  await assertProjectConfig();
  await requireLocalContainer();
  const env = normalSessionEnvironment(process.env, await readCredentialCache());
  validateSessionEnvironment(env);
  assertNoServiceSecrets(env);
  requireCleanup(['ALLOW_IMAGE_CLEANUP_REHEARSAL', 'ALLOW_PRESERVATION_REHEARSAL', 'ALLOW_CI_STORAGE_GUARD_INSTALL']
    .every((key) => !(key in env)), 'ordinary-environment');
  await withCleanupOwners(async ([owner, peer]) => {
    const fixtures = [];
    const historical = [];
    const track = (actor, options) => {
      const value = newCleanupFixture(actor.uid, options);
      fixtures.push({ actor, value });
      return value;
    };
    let primary;
    let failed = false;
    let teardownFailed = false;
    let retainedClaims = 0;
    try {
      await ageBoundaries(deadline);
      const ready = track(owner);
      const retired = track(owner, { itemId: ready.itemId });
      const empty = track(owner);
      const pending = track(owner);
      const orphan = track(owner);
      const unmarked = track(owner);
      const mixed = track(owner);
      const historicalA = track(owner);
      const historicalB = track(owner, { imageId: historicalA.imageId });
      const rebound = track(owner, { imageId: historicalA.imageId });
      const peerReady = track(peer);
      const lateA = track(owner, { itemId: `1080${randomUUID().slice(4)}` });
      const lateB = track(peer, { itemId: `1080${randomUUID().slice(4)}` });
      const itemFirst = track(owner);
      const insertFirst = track(owner);
      const cleanupFirst = track(owner);
      const concurrentInsert = track(owner);
      const pagination = Array.from({ length: 21 }, () => track(owner, { itemId: empty.itemId }));
      for (const [actor, value, options] of [
        [owner, ready, { ready: true }], [owner, retired, { newItem: false }],
        [owner, empty, { upload: false }], [owner, pending, {}],
        [owner, orphan, {}], [owner, unmarked, {}], [owner, mixed, {}], [peer, peerReady, { ready: true }],
      ]) {
        budget(deadline);
        await createCleanupFixture(actor, value, options);
      }
      for (const value of [orphan, unmarked, mixed]) {
        requireCleanup(!(await owner.client.from('items').delete().eq('owner_id', owner.uid).eq('id', value.itemId)).error, 'orphan-setup');
        await ageFixture(value, 'orphan', deadline);
      }
      requireCleanup(await removeCleanupObject(owner, unmarked.thumb) === 'removed', 'single-member-orphan');
      historical.push(unmarked);
      await control(`delete from private.item_image_used_ids where owner_id=${identity(owner.uid)}
        and image_id=${identity(unmarked.imageId)};`, deadline);
      for (const value of [historicalA, historicalB]) {
        await createCleanupFixture(owner, value);
        requireCleanup(!(await owner.client.from('items').delete().eq('owner_id', owner.uid).eq('id', value.itemId)).error, 'historical-orphan');
        historical.push(value);
        await control(`delete from private.item_image_used_ids where owner_id=${identity(owner.uid)}
          and image_id=${identity(value.imageId)};`, deadline);
        await ageFixture(value, 'orphan', deadline);
      }
      // A currently registered third prefix must not hide either distinct historical orphan.
      await createCleanupFixture(owner, rebound, { ready: true });
      await ageFixture(empty, 'pending', deadline);
      await ageFixture(pending, 'pending', deadline);
      await ageFixture(retired, 'retired', deadline);
      await seedRetention(pending, retired, deadline);
      await control(`update storage.objects set created_at=clock_timestamp()-interval '1 day'
        where ${storageTarget(mixed)} and name='${mixed.thumb}';`, deadline);
      await disabledOwner(peer, deadline);
      await housekeeping(owner, ready, empty, deadline);
      for (const value of pagination) {
        budget(deadline);
        await createCleanupFixture(owner, value, { newItem: false, upload: false });
        await ageFixture(value, 'pending', deadline);
      }
      const expected = [empty, pending, retired, orphan, unmarked, historicalA, historicalB, ...pagination];
      const candidates = await readCleanupPages(owner);
      requireCleanup(candidates.length === expected.length && expected.every((v) =>
        candidates.some((c) => c.item_id === v.itemId && c.image_id === v.imageId)), 'exact-fixture-candidate-set');
      requireCleanup(candidates.find((c) => c.image_id === unmarked.imageId)?.object_count === 1, 'single-member-candidate');
      requireCleanup(!(await readCleanupPages(peer)).some((c) => expected.some((v) => v.imageId === c.image_id)), 'aged-peer-isolation');
      const readyBefore = await owner.client.from('items').select('*').eq('id', ready.itemId).single();
      const imageBefore = await owner.client.from('item_images').select('*').eq('id', ready.imageId).single();
      const peerBefore = await peer.client.from('item_images').select('*').eq('id', peerReady.imageId).single();
      requireCleanup(!readyBefore.error && !imageBefore.error && !peerBefore.error, 'preservation-baseline');

      const oldPreview = await candidateFor(owner, orphan);
      await control(`update storage.objects set created_at=clock_timestamp()-interval '9 days'
        where ${storageTarget(orphan)};`, deadline);
      requireCleanup((await owner.client.rpc('begin_image_cleanup', {
        p_request_id: orphan.requestId, p_item_id: orphan.itemId, p_image_id: orphan.imageId,
        p_manifest_sha256: oldPreview.manifest_sha256,
      })).error?.code === '22023', 'stale-age-manifest');
      const preview = await candidateFor(owner, orphan);
      await control(`update storage.objects set metadata=coalesce(metadata,'{}'::jsonb) || '{"i10a":true}'::jsonb
        where ${storageTarget(orphan)};`, deadline);
      requireCleanup((await candidateFor(owner, orphan)).manifest_sha256 === preview.manifest_sha256, 'incidental-metadata-manifest');
      const active = await beginFixture(owner, orphan, preview);
      await activeIdentity(orphan, deadline);
      requireCleanup((await owner.client.rpc('finish_image_cleanup', { p_request_id: orphan.requestId })).error?.code === '22023', 'bytes-first');
      requireCleanup(await removeCleanupObject(owner, active.paths[0].path) === 'removed', 'partial-removal');
      const listed = await cleanupRpc(owner, 'image_cleanup_claims');
      requireCleanup(listed.claims.some((c) => c.request_id === orphan.requestId
        && Object.keys(c).sort().join(',') === 'image_id,item_id,kind,request_id,state'), 'restart-discovery');
      requireCleanup((await cleanupRpc(peer, 'image_cleanup_status', { p_request_id: orphan.requestId })).state === 'not_started', 'active-peer-isolation');
      await beginFixture(owner, orphan, preview);
      await resumeCleanupFixture(owner, orphan);
      await requireAbsentBytes(owner, orphan);
      requireCleanup((await cleanupRpc(owner, 'finish_image_cleanup', { p_request_id: orphan.requestId })).state === 'completed', 'completion-replay');

      for (const value of [empty, pending, retired, unmarked, historicalA, historicalB]) {
        budget(deadline);
        await beginFixture(owner, value);
        if ([empty, pending, retired].includes(value)) {
          requireCleanup((await owner.client.rpc('commit_image', { p_image_id: value.imageId })).error?.code === '22023', 'claimed-adoption-refusal');
        }
        if (value === pending) {
          requireCleanup((await owner.client.rpc('finalize_item_save', {
            p_item_id: value.itemId, p_image_id: value.imageId, p_fingerprint: 'a'.repeat(64),
          })).error?.code === '22023', 'claimed-manual-finalize-refusal');
          requireCleanup((await owner.client.rpc('analyzed_item_save_preflight', {
            p_item_id: value.itemId, p_image_id: value.imageId, p_fingerprint: 'a'.repeat(64),
          })).error?.code === '22023', 'claimed-analyzed-preflight-refusal');
          requireCleanup((await owner.client.from('item_images').update({ alt_text: 'Refused fixture edit' })
            .eq('id', value.imageId).eq('owner_id', owner.uid)).error?.code === '22023', 'claimed-image-edit-refusal');
          requireCleanup((await owner.client.from('item_images').delete()
            .eq('id', value.imageId).eq('owner_id', owner.uid)).error?.code === '22023', 'claimed-image-delete-refusal');
        }
        if (value === retired) {
          const changed = await owner.client.from('items').update({ notes: 'Cleanup fixture edit' })
            .eq('owner_id', owner.uid).eq('id', ready.itemId).select('*').single();
          requireCleanup(!changed.error && changed.data.notes === 'Cleanup fixture edit', 'unrelated-field-edit');
          const restored = await owner.client.from('items').update({ notes: readyBefore.data.notes })
            .eq('owner_id', owner.uid).eq('id', ready.itemId).select('*').single();
          requireCleanup(!restored.error, 'fixture-field-restore');
          readyBefore.data = restored.data;
          const trashed = await cleanupRpc(owner, 'set_item_trashed', {
            p_item_id: ready.itemId, p_expected_version: restored.data.version, p_trashed: true,
          });
          requireCleanup(Array.isArray(trashed) && trashed.length === 1, 'trash-during-cleanup');
          const deletion = await cleanupRpc(owner, 'item_deletion_status', { p_item_ids: [ready.itemId] });
          requireCleanup((await owner.client.rpc('begin_item_deletion', {
            p_item_id: ready.itemId, p_expected_version: deletion[0].version,
            p_request_id: randomUUID(), p_image_manifest_sha256: deletion[0].image_manifest_sha256,
          })).error?.code === '22023', 'item-begin-during-cleanup');
          await cleanupRpc(owner, 'set_item_trashed', {
            p_item_id: ready.itemId, p_expected_version: trashed[0].version, p_trashed: false,
          });
          readyBefore.data = (await owner.client.from('items').select('*').eq('id', ready.itemId).single()).data;
        }
        await resumeCleanupFixture(owner, value);
        await requireAbsentBytes(owner, value);
        if (value === pending || value === retired) await checkRetention(value, value === retired, deadline);
      }
      for (const value of pagination) await beginFixture(owner, value);
      const claimPage = await cleanupRpc(owner, 'image_cleanup_claims');
      requireCleanup(claimPage.claims.length === 20 && UUID.test(claimPage.next), 'claim-page-lookahead');
      const claimTail = await cleanupRpc(owner, 'image_cleanup_claims', { p_after_request_id: claimPage.next });
      requireCleanup(claimTail.claims.length === 1 && claimTail.next === null
        && new Set([...claimPage.claims, ...claimTail.claims].map((c) => c.request_id)).size === 21, 'claim-page-keyset');
      for (const value of pagination) await resumeCleanupFixture(owner, value);
      const readyAfter = await owner.client.from('items').select('*').eq('id', ready.itemId).single();
      const imageAfter = await owner.client.from('item_images').select('*').eq('id', ready.imageId).single();
      const peerAfter = await peer.client.from('item_images').select('*').eq('id', peerReady.imageId).single();
      requireCleanup(!readyAfter.error && !imageAfter.error && !peerAfter.error
        && JSON.stringify(readyAfter.data) === JSON.stringify(readyBefore.data)
        && JSON.stringify(imageAfter.data) === JSON.stringify(imageBefore.data)
        && JSON.stringify(peerAfter.data) === JSON.stringify(peerBefore.data), 'ready-peer-preservation');
      for (const value of [ready, rebound, peerReady]) {
        const actor = value === peerReady ? peer : owner;
        const bytes = await actor.client.storage.from('wardrobe').download(value.main);
        requireCleanup(!bytes.error && bytes.data.size === 4, 'retained-current-bytes');
      }
      const mixedBefore = await owner.client.storage.from('wardrobe').remove([mixed.main, mixed.thumb]);
      requireCleanup(!mixedBefore.error && Array.isArray(mixedBefore.data) && mixedBefore.data.length === 0, 'bulk-not-removal');
      await control(`do $mixed$
begin
  if (select count(*) from storage.objects where ${storageTarget(mixed)})<>2 then raise exception 'I10A_MIXED_PAIR'; end if;
end;
$mixed$;`, deadline);
      const malformed = await owner.client.storage.from('wardrobe').upload(
        `${owner.uid}/${ready.itemId}/${ready.imageId}/unsupported.jpg`, new Uint8Array(4),
        { contentType: 'image/jpeg', upsert: false });
      requireCleanup([400, 403].includes(malformed.error?.status), 'unsupported-upload');
      checkCleanupPage(await cleanupRpc(owner, 'image_cleanup_page'), owner.uid);
      for (const [actor, value] of [[owner, lateA], [peer, lateB]]) {
        budget(deadline);
        await latePublication(actor, value, deadline);
      }
      await reverseItemClaim(owner, itemFirst, deadline);
      for (const [value, first] of [[insertFirst, 'metadata'], [cleanupFirst, 'cleanup'], [concurrentInsert, 'concurrent']]) {
        historical.push(value);
        budget(deadline);
        await orphanInsertionOrder(owner, value, first, deadline);
      }
      budget(deadline);
      retainedClaims = fixtures.length ? Number(await privilegedLocalSql(`select count(*) from private.image_cleanup_claims
        where owner_id in(${identity(owner.uid)},${identity(peer.uid)}) and state='completed'
          and item_id in(${fixtures.map(({ value }) => identity(value.itemId)).join(',')});`)) : 0;
      requireCleanup(Number.isSafeInteger(retainedClaims) && retainedClaims >= expected.length, 'completed-fixture-count');
      await operation(Object.freeze({
        ownerId: owner.uid, peerOwnerId: peer.uid,
        fixtures: Object.freeze(fixtures.map(({ value }) => value)),
        completedClaims: retainedClaims, deadline,
      }));
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      for (const value of historical) {
        try {
          await control(`insert into private.item_image_used_ids(owner_id,image_id)
            values(${identity(value.ownerId)},${identity(value.imageId)}) on conflict do nothing;`, deadline, true);
        } catch { teardownFailed = true; }
      }
      for (const { actor, value } of [...fixtures].reverse()) {
        try {
          budget(deadline, true);
          await destroyCleanupFixture(actor, value);
        } catch { teardownFailed = true; }
      }
      try {
        const ownerIds = [owner.uid, peer.uid].map(identity).join(',');
        const itemIds = fixtures.map(({ value }) => identity(value.itemId)).join(',');
        if (fixtures.length) await control(`do $teardown$
begin
  if exists(select 1 from public.items where owner_id in(${ownerIds}) and id in(${itemIds}))
    or exists(select 1 from private.image_cleanup_claims where owner_id in(${ownerIds})
      and item_id in(${itemIds}) and state='active')
    or exists(select 1 from private.image_cleanup_delete_context where owner_id in(${ownerIds})
      and item_id in(${itemIds})) then raise exception 'I10A_TEARDOWN'; end if;
end;
$teardown$;`, deadline, true);
      } catch { teardownFailed = true; }
    }
    if (failed && teardownFailed) fail('FAIL: image cleanup rehearsal primary and fixture teardown.', 1);
    if (teardownFailed) fail('FAIL: image cleanup rehearsal fixture teardown.', 1);
    if (failed) throw primary;
    console.log(`PASS: image cleanup fixture teardown; ${retainedClaims} minimal completed claims and generated used identities retained by production lifetime.`);
  }, env);
  requireCleanup(performance.now() <= deadline, 'whole-rehearsal-deadline');
  console.log(`PASS: image cleanup stage1 rehearsal ${Math.ceil(performance.now() - started)}ms; browser journey is not implemented in this source stage.`);
}

export async function runImageCleanupRehearsal() {
  assertImageCleanupRehearsal(process.env, process.argv.slice(2));
  await withImageCleanupFixtures(async (manifest) => {
    requireCleanup(manifest.completedClaims > 20 && manifest.ownerId !== manifest.peerOwnerId, 'rehearsal-summary');
  });
}

if (isMain(import.meta.url)) runImageCleanupRehearsal().catch(reportError);
