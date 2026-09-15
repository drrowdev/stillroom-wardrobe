import { test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import type { Database } from '../../src/data/database.types';
import type { AppClient } from '../../src/data/client';
import type { OwnerScope } from '../../src/auth/session';
import { loadWardrobe } from '../../src/data/items';
import { loadWearHistory, wearProjection } from '../../src/data/wear-history';
import { newGarmentDraft, editGarmentField } from '../../src/domain/garment-fields';
import { newSaveAttempt, saveItem, type SaveAttempt } from '../../src/images/upload';
import { ItemLifecycleClient } from '../../src/data/item-lifecycle';
import { deletionIntent } from '../../src/domain/item-lifecycle';
import { deleteWardrobeObject, type DeleteRequest, type ObjectDeletion } from '../../src/data/storage-delete';

const failure = new Error('Normal-owner wardrobe query gate failed.');
function check(value: unknown): asserts value { if (!value) throw failure; }
type Stage = 'setup.configuration' | 'setup.photo' | 'setup.client'
  | 'sign-in.A' | 'sign-in.B' | 'sign-in.verify' | 'fixture.draft' | 'fixture.save'
  | 'fixture.pending' | 'fixture.history' | 'fixture.deleted-history'
  | 'fixture.interrupted-draft' | 'fixture.interrupted-save' | 'fixture.interrupted-metadata' | 'fixture.interrupted-objects'
  | 'query.owners' | 'query.metadata' | 'query.history' | 'query.peer-items'
  | 'query.peer-history' | 'query.peer-unchanged' | 'query.anonymous-items'
  | 'query.anonymous-history' | 'query.shape'
  | 'cleanup.events' | 'cleanup.image-state' | 'cleanup.lifecycle-status'
  | 'cleanup.trash' | 'cleanup.deletion' | 'cleanup.pending-bytes'
  | 'cleanup.pending-prefix' | 'cleanup.pending-metadata'
  | 'cleanup.forget-image' | 'cleanup.item' | 'cleanup.item-absent'
  | 'cleanup.pending-item' | 'cleanup.events-absent' | 'cleanup.session' | 'cleanup.sign-out';
const report = 'Normal-owner wardrobe query or cleanup failed.';
const stageFailure = (kind: 'primary' | 'cleanup', stage: Stage) => new Error(`Normal-owner wardrobe query ${kind} failed at ${stage}.`);
async function setup<T>(stage: Stage, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new AggregateError([stageFailure('primary', stage)], report); }
}
test('real ordinary A/B metadata, composite history read and denial with isolated fixture cleanup', async () => {
  const { base, key } = await setup('setup.configuration', () => {
    validateSessionEnvironment(process.env);
    return { base: assertLocalApi(process.env.SUPABASE_URL!), key: process.env.SUPABASE_PUBLISHABLE_KEY! };
  });
  const start = Date.now(), end = start + 110_000;
  let deadline = end - 35_000;
  const observed: URL[] = [];
  const clients: AppClient[] = [];
  type Fixture = {
    client: AppClient; scope: OwnerScope; attempts: SaveAttempt[]; completed: SaveAttempt[];
    interrupted: SaveAttempt | null; preparedPair: boolean; events: string[]; pending: string;
  };
  const fixtures: Fixture[] = [];
  const photo = await setup('setup.photo', async () => {
    const image = new Uint8Array(await readFile(new URL('../security/fixture.jpg', import.meta.url)));
    const hash = createHash('sha256').update(image).digest('hex');
    return { main: new Blob([image], { type: 'image/jpeg' }), thumb: new Blob([image], { type: 'image/jpeg' }),
      mainSha256: hash, thumbSha256: hash, width: 2, height: 2 };
  });
  const progress: { stage: Stage } = { stage: 'setup.client' };
  async function transport(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    check(url.origin === base && !url.username && !url.password && !url.hash);
    check(url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/storage/v1/'));
    const remaining = deadline - Date.now(); check(remaining > 0);
    observed.push(url);
    return fetch(input, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(Math.min(5000, remaining)), ...(init.signal ? [init.signal] : [])]) });
  }
  function deletionRequest(client: AppClient, scope: OwnerScope): DeleteRequest {
    return async (route, options) => {
      const current = await client.auth.getSession();
      check(!current.error && current.data.session && current.data.session.user.id === scope.ownerId);
      const response = await transport(`${base}${route}`, {
        ...options,
        headers: { apikey: key, Authorization: `Bearer ${current.data.session.access_token}` },
      });
      const data: unknown = await response.json();
      return { status: response.status, ok: response.ok, data };
    };
  }
  function makeClient() {
    const client = createClient<Database>(base, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `wardrobe-query-${randomUUID()}`, debug: false },
      global: { fetch: transport },
    });
    clients.push(client);
    return client;
  }
  async function fixture(label: 'A' | 'B') {
    progress.stage = 'setup.client';
    const client = makeClient();
    progress.stage = label === 'A' ? 'sign-in.A' : 'sign-in.B';
    const login = await client.auth.signInWithPassword({ email: process.env[`TEST_${label}_EMAIL`]!, password: process.env[`TEST_${label}_PASSWORD`]! });
    check(!login.error && login.data.user && login.data.session);
    progress.stage = 'sign-in.verify';
    const verified = await client.auth.getUser(); check(!verified.error && verified.data.user?.id === login.data.user.id);
    const scope = { ownerId: login.data.user.id, epoch: 1, signal: new AbortController().signal };
    const value: Fixture = { client, scope, attempts: [], completed: [], interrupted: null, preparedPair: false, events: [], pending: randomUUID() };
    fixtures.push(value);
    for (let n = 0; n < 2; n++) {
      progress.stage = 'fixture.draft';
      let draft = newGarmentDraft(n === 0 ? 'EUR' : 'USD', 'en');
      draft = editGarmentField(draft, 'title', `Fictional query ${label} ${n}`, 'en');
      draft = editGarmentField(draft, 'category', 'top', 'en');
      draft = editGarmentField(draft, 'brand', 'Fictional brand', 'en');
      draft = editGarmentField(draft, 'tags', ['synthetic'], 'en');
      if (n === 0) draft = editGarmentField(draft, 'purchase_price', '0', 'en');
      const attempt = newSaveAttempt(draft, 'Synthetic query fixture', photo, scope);
      value.attempts.push(attempt);
      progress.stage = 'fixture.save';
      await saveItem(client, scope, attempt, () => {});
      value.completed.push(attempt);
    }
    progress.stage = 'fixture.interrupted-draft';
    let interruptedDraft = newGarmentDraft('EUR', 'en');
    interruptedDraft = editGarmentField(interruptedDraft, 'title', `Fictional interrupted query ${label}`, 'en');
    interruptedDraft = editGarmentField(interruptedDraft, 'category', 'top', 'en');
    const interrupted = newSaveAttempt(interruptedDraft, 'Synthetic pending query fixture', photo, scope);
    value.interrupted = interrupted;
    value.attempts.push(interrupted);
    const interruption = new Error('Expected fixture interruption before finalization.');
    progress.stage = 'fixture.interrupted-save';
    let stopped = false;
    try {
      await saveItem(client, scope, interrupted, stage => {
        if (stage === 'capture.finishing') {
          value.preparedPair = true;
          throw interruption;
        }
      });
    } catch (problem) {
      if (problem !== interruption) throw problem;
      stopped = true;
    }
    check(stopped && value.preparedPair);
    progress.stage = 'fixture.interrupted-metadata';
    const pendingImage = await client.from('item_images').select('id,owner_id,item_id,state')
      .eq('owner_id', scope.ownerId).eq('id', interrupted.imageId).single();
    check(!pendingImage.error && pendingImage.data?.id === interrupted.imageId && pendingImage.data.owner_id === scope.ownerId
      && pendingImage.data.item_id === interrupted.itemId && pendingImage.data.state === 'pending');
    progress.stage = 'fixture.interrupted-objects';
    const prefix = `${scope.ownerId}/${interrupted.itemId}/${interrupted.imageId}`;
    const listed = await client.storage.from('wardrobe').list(prefix, { limit: 3, sortBy: { column: 'name', order: 'asc' } });
    check(!listed.error && listed.data?.length === 2 && listed.data[0]?.name === 'main.jpg' && listed.data[1]?.name === 'thumb.jpg'
      && listed.data.every(object => typeof object.id === 'string' && object.id.length > 0));
    progress.stage = 'fixture.pending';
    check(!(await client.from('items').insert({ id: value.pending, owner_id: scope.ownerId, title: 'Unfinished query fixture', category: 'top' })).error);
    const event = async (item: string, day: string, state: 'worn' | 'planned', deleted = false) => {
      progress.stage = 'fixture.history';
      const id = randomUUID(); value.events.push(id);
      check(!(await client.rpc('save_wear_event', { p_id: id, p_local_date: day, p_timezone: 'Europe/Helsinki', p_state: state,
        p_label: 'Synthetic query history', p_outfit_id: null, p_item_ids: [item] })).error);
      if (deleted) {
        progress.stage = 'fixture.deleted-history';
        check(!(await client.from('wear_events').update({ deleted_at: '2026-09-03T00:00:00Z' }).eq('owner_id', scope.ownerId).eq('id', id)).error);
      }
    };
    await event(value.completed[0]!.itemId, '2026-09-01', 'worn');
    await event(value.completed[0]!.itemId, '2026-09-01', 'worn');
    await event(value.completed[0]!.itemId, '2026-09-02', 'worn');
    await event(value.completed[1]!.itemId, '2026-09-02', 'planned');
    await event(value.completed[1]!.itemId, '2026-09-02', 'worn', true);
    await event(interrupted.itemId, '2026-09-02', 'worn');
    await event(value.pending, '2026-09-02', 'worn');
    return value;
  }
  let primaryFailure: Stage | null = null;
  const cleanupFailures = new Set<Stage>();
  try {
    const a = await fixture('A'), b = await fixture('B');
    progress.stage = 'query.owners';
    check(a.scope.ownerId !== b.scope.ownerId);
    for (const [own, peer] of [[a, b], [b, a]] as const) {
      progress.stage = 'query.metadata';
      const items = await loadWardrobe(own.client, own.scope);
      check(items.every(item => item.ownerId === own.scope.ownerId));
      check(own.interrupted !== null && own.completed.length === 2);
      check(!items.some(item => item.id === own.pending || item.id === own.interrupted?.itemId || peer.attempts.some(attempt => attempt.itemId === item.id)));
      const zero = items.find(item => item.id === own.completed[0]!.itemId);
      check(zero?.purchasePrice === '0.00' && zero.brand === 'Fictional brand' && zero.tags[0] === 'synthetic'
        && zero.colours.length === 0 && zero.seasons.length === 0 && zero.formality === null && zero.currency === 'EUR');
      check(items.find(item => item.id === own.completed[1]!.itemId)?.purchasePrice === null);
      progress.stage = 'query.history';
      const history = await loadWearHistory(own.client, own.scope, items);
      check(history.items.get(own.completed[0]!.itemId)?.count === 2 && history.items.get(own.completed[0]!.itemId)?.lastWorn === '2026-09-02');
      check(history.items.get(own.completed[1]!.itemId)?.count === 0 && !history.items.has(own.pending) && !history.items.has(own.interrupted.itemId));
      progress.stage = 'query.peer-items';
      const deniedItems = await own.client.from('items').select('id,owner_id,brand,tags,colours,seasons,formality,purchase_price,currency').eq('owner_id', peer.scope.ownerId);
      check(!deniedItems.error && deniedItems.data?.length === 0);
      progress.stage = 'query.peer-history';
      const deniedHistory = await own.client.from('wear_event_items').select(wearProjection)
        .eq('owner_id', peer.scope.ownerId).eq('event.owner_id', peer.scope.ownerId)
        .eq('event.state', 'worn').is('event.deleted_at', null).not('item_id', 'is', null);
      check(!deniedHistory.error && deniedHistory.data?.length === 0);
      progress.stage = 'query.peer-unchanged';
      check(peer.interrupted !== null && peer.completed.length === 2);
      const expectedIds = [...peer.completed.map(attempt => attempt.itemId), peer.interrupted.itemId].sort();
      const unchanged = await peer.client.from('items').select('id').eq('owner_id', peer.scope.ownerId).in('id', expectedIds).order('id');
      check(!unchanged.error && unchanged.data?.length === 3 && unchanged.data.every((item, index) => item.id === expectedIds[index]));
    }
    progress.stage = 'setup.client';
    const anonymous = makeClient();
    for (const table of ['items', 'wear_event_items'] as const) {
      progress.stage = table === 'items' ? 'query.anonymous-items' : 'query.anonymous-history';
      const result = await anonymous.from(table).select(table === 'items' ? 'id,owner_id' : wearProjection).eq('owner_id', a.scope.ownerId);
      check(result.error && (result.status === 401 || result.status === 403));
    }
    progress.stage = 'query.shape';
    check(observed.some(url => url.pathname.endsWith('/wear_event_items') && url.searchParams.get('select') === wearProjection
      && url.searchParams.get('event.state') === 'eq.worn' && url.searchParams.get('limit') === '500'));
  } catch { primaryFailure = progress.stage; }
  finally {
    deadline = end;
    for (const value of fixtures) {
      const { client, scope } = value;
      for (const event of value.events) {
        progress.stage = 'cleanup.events';
        try { check(!(await client.from('wear_events').delete().eq('owner_id', scope.ownerId).eq('id', event)).error); }
        catch { cleanupFailures.add(progress.stage); }
      }
      for (const attempt of value.attempts) {
        try {
          progress.stage = 'cleanup.image-state';
          const state = await client.from('item_images').select('id,state').eq('owner_id', scope.ownerId).eq('id', attempt.imageId).maybeSingle();
          check(!state.error);
          const prepared = value.preparedPair && attempt === value.interrupted;
          if (prepared) check(state.data?.id === attempt.imageId && state.data.state === 'pending');
          if (state.data?.state === 'ready') {
            progress.stage = 'cleanup.lifecycle-status';
            const lifecycle = new ItemLifecycleClient(client, { url: base, publishableKey: key, version: 'local-query-test' }, scope);
            let status = await lifecycle.statusOf(attempt.itemId);
            if (!status.deleted_at) {
              progress.stage = 'cleanup.trash';
              await lifecycle.change(attempt.itemId, true, status.version, () => {});
            }
            progress.stage = 'cleanup.lifecycle-status';
            status = await lifecycle.statusOf(attempt.itemId);
            progress.stage = 'cleanup.deletion';
            const outcome = await lifecycle.delete(deletionIntent(status, scope.epoch), true, () => {});
            check(outcome.removed === 2 && outcome.missing === 0);
          } else {
            if (state.data) {
              progress.stage = 'cleanup.pending-bytes';
              const prefix = `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}`;
              const outcomes: ObjectDeletion[] = [];
              const request = deletionRequest(client, scope);
              for (const variant of ['main', 'thumb']) {
                try { outcomes.push(await deleteWardrobeObject(request, scope.ownerId, `${prefix}/${variant}.jpg`)); }
                catch { cleanupFailures.add(progress.stage); }
              }
              check(outcomes.length === 2);
              if (prepared) check(outcomes.every(outcome => outcome === 'removed'));
              progress.stage = 'cleanup.pending-prefix';
              const remainingObjects = await client.storage.from('wardrobe').list(prefix, { limit: 3 });
              check(!remainingObjects.error && remainingObjects.data?.length === 0);
              progress.stage = 'cleanup.pending-metadata';
              const retained = await client.from('item_images').select('id,state').eq('owner_id', scope.ownerId).eq('id', attempt.imageId).single();
              check(!retained.error && retained.data?.id === attempt.imageId && retained.data.state === state.data.state);
              progress.stage = 'cleanup.forget-image';
              check(!(await client.rpc('forget_image', { p_image_id: attempt.imageId })).error);
            }
            progress.stage = 'cleanup.item';
            check(!(await client.from('items').delete().eq('owner_id', scope.ownerId).eq('id', attempt.itemId)).error);
          }
          progress.stage = 'cleanup.item-absent';
          const absent = await client.from('items').select('id').eq('owner_id', scope.ownerId).eq('id', attempt.itemId);
          check(!absent.error && absent.data?.length === 0);
        } catch { cleanupFailures.add(progress.stage); }
      }
      try {
        progress.stage = 'cleanup.pending-item';
        check(!(await client.from('items').delete().eq('owner_id', scope.ownerId).eq('id', value.pending)).error);
        progress.stage = 'cleanup.events-absent';
        const remaining = await client.from('wear_events').select('id').eq('owner_id', scope.ownerId).in('id', value.events);
        check(!remaining.error && remaining.data?.length === 0);
      } catch { cleanupFailures.add(progress.stage); }
    }
    for (const client of clients) {
      try {
        progress.stage = 'cleanup.session';
        const session = await client.auth.getSession();
        check(!session.error);
        if (session.data.session) {
          progress.stage = 'cleanup.sign-out';
          check(!(await client.auth.signOut({ scope: 'local' })).error);
        }
      } catch { cleanupFailures.add(progress.stage); }
    }
  }
  const failures = [];
  if (primaryFailure !== null) failures.push(stageFailure('primary', primaryFailure));
  for (const stage of cleanupFailures) failures.push(stageFailure('cleanup', stage));
  if (failures.length) throw new AggregateError(failures, report);
});
