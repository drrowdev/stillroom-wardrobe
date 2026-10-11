// TRYON-PHOTO1: the owner's one saved reference photo against the real schema. Invoked only by the CI-only preservation owner,
// after the frozen checks ran at the exact prior inventory (20261011090000). Every owner read, save, removal, consent change
// and isolation assertion uses the ordinary A/B sessions; privileged SQL only sets up controls and counts rows. Try-on is
// opened for the fictional owners only inside these probes and restored in finally. No provider calls.
//   photoUpgradeSeed / photoUpgradeVerify: cutover. At the prior inventory both owners are configured at notice revision 1 and
//     have consented at revision 1; after the migration their configured notice is 2, their consent is still 1 (never
//     written), activation and the other settings are unchanged, there is no photo, and a revision-1 consent cannot save one.
//   tryonPhotoProbes: the new contract at the full inventory.
import { createHash } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures.ts';
import { exifSegment } from '../fixtures/jpeg-helpers.ts';
import { photoLayoutPositives, photoTableNegatives } from '../fixtures/photo-jpeg-variants.ts';

const MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
const RESERVED = 360000;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PHOTO = { width: 1024, height: 1280 };
const photos = {
  mine: flatJpeg({ ...PHOTO }),
  other: flatJpeg({ ...PHOTO, colour: [20, 90, 200] }),
  restart: flatJpeg({ ...PHOTO, mode: 'restart', restartInterval: 8 }),
};
const FUNCTIONS = ['tryon_person_photo_status_v1', 'tryon_person_photo_get_v1', 'tryon_person_photo_put_v1', 'tryon_person_photo_delete_v1'];

function helpers(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = (owner, name, body) => client.rpc(owner, name, body);
  const status = (owner) => rpc(owner, 'tryon_person_photo_status_v1', {});
  const get = (owner) => rpc(owner, 'tryon_person_photo_get_v1', {});
  const put = (owner, bytes, hash = sha(bytes)) => rpc(owner, 'tryon_person_photo_put_v1', { p_jpeg_base64: b64(bytes), p_sha256: hash });
  const remove = (owner) => rpc(owner, 'tryon_person_photo_delete_v1', {});
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const rows = async (owner) => Number(await scalar(`select count(*) from private.tryon_person_photos where owner_id=${literal(owner.uid)};`));
  const digest = async (owner) => (await scalar(`select coalesce((select sha256 from private.tryon_person_photos where owner_id=${literal(owner.uid)}),'none');`));
  const setRevisions = (owner, notice, consent) => sql(`update private.ai_controls set tryon_notice_revision=${notice},
    tryon_consent_revision=${consent === null ? 'null' : consent},tryon_consented_at=${consent === null ? 'null' : 'clock_timestamp()'},
    updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);
  // Both owners configured at `notice` and consenting at `consent`; the control rows are restored by `close`.
  const open = async (notice) => {
    const before = { a: await controls(a), b: await controls(b) };
    requireEvidence(before.a.tryon_activated === false && before.b.tryon_activated === false);
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) {
      equal((await one(`select public.tryon_bootstrap(${literal(owner.uid)},${literal(MANIFEST)},${notice},${RESERVED},5000000,1000);`)).code, 'OK');
    }
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) equal((await rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: notice })).code, 'OK');
    return before;
  };
  const close = async (before) => {
    await sql(`delete from private.tryon_person_photos where owner_id in (${literal(a.uid)},${literal(b.uid)});
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.a.monthly_allowance_micro},
        updated_at=clock_timestamp() where owner_id=${literal(a.uid)};
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.b.monthly_allowance_micro},
        updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
  };
  return { a, b, client, one, scalar, rpc, status, get, put, remove, controls, rows, digest, setRevisions, open, close };
}

export async function photoUpgradeSeed(snapshot, sql) {
  const h = helpers(snapshot, sql);
  // The prior inventory: no photo table and none of the four functions.
  equal(await h.one(`select jsonb_build_array(to_regclass('private.tryon_person_photos') is null,
    to_regprocedure('public.tryon_person_photo_put_v1(text,text)') is null,
    to_regprocedure('public.tryon_person_photo_status_v1()') is null);`), [true, true, true]);
  const before = await h.open(1);
  try {
    const seeded = { a: await h.controls(h.a), b: await h.controls(h.b) };
    for (const c of [seeded.a, seeded.b]) {
      requireEvidence(c.tryon_activated === true && c.tryon_notice_revision === 1 && c.tryon_consent_revision === 1
        && c.tryon_consented_at !== null);
    }
    return { h, before, seeded };
  } catch (error) {
    await h.close(before).catch(() => {});
    throw error;
  }
}

const settings = (c) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'updated_at' && key !== 'tryon_notice_revision'));

export async function photoUpgradeVerify(seed, mark = () => {}) {
  const { h, before, seeded } = seed;
  const { a, b } = h;
  try {
    mark('structure');
    equal(await h.one(`select jsonb_build_array(to_regclass('private.tryon_person_photos') is not null,
      (select relrowsecurity from pg_class where oid='private.tryon_person_photos'::regclass),
      has_table_privilege('authenticated','private.tryon_person_photos','SELECT'),
      has_table_privilege('service_role','private.tryon_person_photos','SELECT'),
      (select count(*) from private.tryon_person_photos));`), [true, true, false, false, 0]);
    mark('notice-moved');
    // Only the configured notice moved (1 -> 2). Consent was never written: it is still 1 and now mismatches; activation, the
    // manifest, limits and every other setting are exactly as seeded.
    for (const [owner, was] of [[a, seeded.a], [b, seeded.b]]) {
      const now = await h.controls(owner);
      requireEvidence(now.tryon_notice_revision === 2 && now.tryon_consent_revision === 1 && now.tryon_consented_at === was.tryon_consented_at);
      equal(settings(now), settings(was));
    }
    mark('revision-one-consent');
    // Ordinary permission would be refused here already (consent differs from the configured notice); the photo is refused too.
    equal((await h.put(a, photos.mine)).code, 'CONSENT_REQUIRED');
    equal(await h.status(a), { code: 'OK', saved: false });
    equal(await h.rows(a), 0);
    // Turning try-on on again moves consent to 2, and only then may a photo be saved.
    equal((await h.rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'CONFIG_CHANGED');
    equal((await h.rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).consent.noticeRevision, 2);
    equal((await h.put(a, photos.mine)).code, 'OK');
    equal(await h.digest(a), sha(photos.mine));
    equal(await h.rows(b), 0);
  } finally {
    await h.close(before);
  }
}

export async function tryonPhotoProbes(snapshot, sql, mark) {
  const h = helpers(snapshot, sql);
  const { a, b, client, rpc, status, get, put, remove, controls, rows, digest, setRevisions, one } = h;
  const before = await h.open(2);
  try {
    mark('structure');
    equal(await one(`select jsonb_build_object('functions',(select jsonb_agg(p.proname order by p.proname) from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proname like 'tryon_person_photo_%'),
      'definers',(select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
        where p.pronamespace='public'::regnamespace and p.proname like 'tryon_person_photo_%'),
      'apiCallable',(select bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('service_role',p.oid,'EXECUTE')) from pg_proc p
        where p.pronamespace='public'::regnamespace and p.proname like 'tryon_person_photo_%'),
      'privateClosed',(select bool_and(not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('service_role',p.oid,'EXECUTE')) from pg_proc p
        where p.pronamespace='private'::regnamespace and p.proname in ('tryon_person_photo_admit','tryon_person_photo_guard')),
      'realtime',(select count(*) from pg_publication_tables where schemaname='private' and tablename='tryon_person_photos'));`),
    { functions: [...FUNCTIONS].sort().map((name) => name), definers: true, apiCallable: true, privateClosed: true, realtime: 0 });

    mark('anonymous');
    // No session: every function is refused and nothing is written.
    for (const name of FUNCTIONS) {
      const denied = await client.request(null, `/rest/v1/rpc/${name}`, { method: 'POST', body: name.includes('put')
        ? { p_jpeg_base64: b64(photos.mine), p_sha256: sha(photos.mine) } : {} });
      requireEvidence(!denied.ok);
    }
    equal(await rows(a) + await rows(b), 0);

    mark('save-read');
    equal(await status(a), { code: 'OK', saved: false });
    equal(await get(a), { code: 'NOT_FOUND' });
    const saved = await put(a, photos.mine);
    requireEvidence(saved.code === 'OK' && saved.saved === true && saved.bytes === photos.mine.length && Number.isSafeInteger(saved.savedAtMs));
    const listed = await status(a);
    requireEvidence(listed.code === 'OK' && listed.saved === true && listed.bytes === photos.mine.length);
    const fetched = await get(a);
    requireEvidence(fetched.code === 'OK' && fetched.sha256 === sha(photos.mine) && fetched.bytes === photos.mine.length
      && Buffer.from(fetched.jpegBase64, 'base64').equals(Buffer.from(photos.mine)));
    // Replacing keeps one row; a restart-bearing app JPEG is admitted too.
    equal((await put(a, photos.restart)).code, 'OK');
    equal(await rows(a), 1);
    equal(await digest(a), sha(photos.restart));
    equal((await put(a, photos.mine)).code, 'OK');

    mark('per-account');
    // The other owner sees nothing, saves their own, and neither can read, replace or remove the other's.
    equal(await status(b), { code: 'OK', saved: false });
    equal(await get(b), { code: 'NOT_FOUND' });
    equal((await remove(b)), { code: 'OK', saved: false });
    equal(await digest(a), sha(photos.mine));
    equal((await put(b, photos.other)).code, 'OK');
    equal(await digest(a), sha(photos.mine));
    equal(await digest(b), sha(photos.other));
    equal((await get(a)).sha256, sha(photos.mine));
    equal((await get(b)).sha256, sha(photos.other));
    // The table itself is not reachable with an ordinary session.
    const direct = await client.request(a.token, '/rest/v1/tryon_person_photos?select=*');
    requireEvidence(!direct.ok);

    mark('admission');
    // Each refusal is a fixed code, writes nothing and leaves the saved photo as it was.
    const sos = photos.mine.findIndex((value, at) => value === 0xff && photos.mine[at + 1] === 0xda);
    const bad = [
      ['hash', photos.mine, 'f'.repeat(64)],
      ['trailing byte', Uint8Array.from([...photos.mine, 0])],
      ['truncated', photos.mine.subarray(0, photos.mine.length - 2)],
      ['too short', photos.mine.subarray(0, 100)],
      ['wrong size', flatJpeg({ width: 1024, height: 1024 })],
      ['wrong orientation', flatJpeg({ width: 1280, height: 1024 })],
      ['progressive', flatJpeg({ ...PHOTO, mode: 'progressive' })],
      ['exif', flatJpeg({ ...PHOTO, segments: [exifSegment(1)] })],
      ['comment', flatJpeg({ ...PHOTO, segments: [Uint8Array.from([0xff, 0xfe, 0, 4, 1, 2])] })],
      ['thumbnail-bearing app1', flatJpeg({ ...PHOTO, segments: [Uint8Array.from([0xff, 0xe1, 0, 10, 69, 120, 105, 102, 0, 0, 255, 216])] })],
      ['unstuffed marker in the scan', Uint8Array.from([...photos.mine.subarray(0, sos + 14), 1, 0xff, 1, 3, 0xff, 0xd9])],
      ['restart without an interval', Uint8Array.from([...photos.mine.subarray(0, sos + 14), 1, 0xff, 0xd0, 3, 0xff, 0xd9])],
    ];
    for (const [label, bytes, hash] of bad) {
      equal((await put(a, bytes, hash)).code, 'INVALID_INPUT', label);
      equal(await digest(a), sha(photos.mine), label);
    }
    for (const body of [{ p_jpeg_base64: '!!!!!!!!', p_sha256: 'a'.repeat(64) }, { p_jpeg_base64: null, p_sha256: null },
      { p_jpeg_base64: b64(photos.mine), p_sha256: 'A'.repeat(64) }, { p_jpeg_base64: 'A'.repeat(682_672), p_sha256: 'a'.repeat(64) },
      { p_jpeg_base64: b64(photos.mine) + '\n', p_sha256: sha(photos.mine) }]) {
      equal((await rpc(a, 'tryon_person_photo_put_v1', body)).code, 'INVALID_INPUT');
    }
    equal(await digest(a), sha(photos.mine));

    mark('table-validation');
    // Missing, malformed or mismatched tables and references are refused with the same fixed code and write nothing; other
    // legal layouts (Safari-style single-table segments with restarts, several tables per segment) are admitted.
    for (const [label, bytes] of photoTableNegatives(PHOTO.width, PHOTO.height)) {
      equal((await put(a, bytes)).code, 'INVALID_INPUT', label);
      equal(await digest(a), sha(photos.mine), label);
    }
    for (const [label, bytes] of photoLayoutPositives(PHOTO.width, PHOTO.height)) {
      equal((await put(a, bytes)).code, 'OK', label);
      equal(await digest(a), sha(bytes), label);
    }
    equal((await put(a, photos.mine)).code, 'OK');

    mark('consent');
    // Consent at another revision than 2 removes the photo in the same statement (the trigger) and refuses a new one, even
    // when ordinary permission is OK (configured notice 1, consent 1).
    await setRevisions(a, 2, 1);
    equal(await rows(a), 0);
    equal(await digest(b), sha(photos.other));
    equal((await put(a, photos.mine)).code, 'CONSENT_REQUIRED');
    await setRevisions(a, 1, 1);
    equal((await put(a, photos.mine)).code, 'CONSENT_REQUIRED');
    await setRevisions(a, 3, 3);
    equal((await put(a, photos.mine)).code, 'CONSENT_REQUIRED');
    await setRevisions(a, 2, 2);
    equal((await put(a, photos.mine)).code, 'OK');
    // A notice change removes it.
    await setRevisions(a, 3, 2);
    equal(await rows(a), 0);
    await setRevisions(a, 2, 2);
    // An administrator reset that clears the notice, the consent and the activation in one statement removes it as well: no
    // row remains and nothing can be read back.
    equal((await put(a, photos.mine)).code, 'OK');
    await sql(`update private.ai_controls set tryon_activated=false,tryon_notice_revision=null,tryon_consent_revision=null,
      tryon_consented_at=null,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);
    equal(await rows(a), 0);
    equal(await get(a), { code: 'NOT_FOUND' });
    equal(await digest(b), sha(photos.other));
    await setRevisions(a, 2, 2);
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);
    // Withdrawing through the owner's own call removes it; a later save is refused until try-on is on again.
    equal((await put(a, photos.mine)).code, 'OK');
    requireEvidence((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).consent.enabled === false);
    equal(await rows(a), 0);
    equal(await get(a), { code: 'NOT_FOUND' });
    equal((await put(a, photos.mine)).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).consent.noticeRevision, 2);
    equal((await put(a, photos.mine)).code, 'OK');
    equal(await digest(b), sha(photos.other));

    mark('readable-when-paused');
    // Reading and removing need only an approved owner: the photo stays reachable while try-on is inactive; a save does not.
    await sql(`update private.ai_controls set tryon_activated=false,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);
    equal((await put(a, photos.other)).code, 'INACTIVE');
    equal((await status(a)).saved, true);
    equal((await get(a)).sha256, sha(photos.mine));
    equal(await remove(a), { code: 'OK', saved: false });
    equal(await remove(a), { code: 'OK', saved: false });
    equal(await rows(a), 0);
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);

    mark('race');
    // A save racing a withdrawal, in both start orders: whichever commits first, no photo survives the withdrawal.
    for (let round = 0; round < 8; round += 1) {
      equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).consent.noticeRevision, 2);
      const save = () => put(a, photos.mine);
      const withdraw = () => rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null });
      const results = round % 2 ? await Promise.all([withdraw(), save()]) : await Promise.all([save(), withdraw()]);
      requireEvidence(results.length === 2);
      equal(await rows(a), 0);
      equal((await controls(a)).tryon_consent_revision, null);
    }
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).consent.noticeRevision, 2);

    mark('platform-restore-and-deletion');
    // The platform-restore step removes every saved photo (a restore must not bring back a removed one) and the deletion check
    // sees the table; both run in a block that is rolled back, so no other try-on row of the rehearsal is touched.
    equal((await put(a, photos.mine)).code, 'OK');
    equal((await put(b, photos.other)).code, 'OK');
    const rolled = await one(`create or replace function pg_temp.photo1_discard() returns jsonb language plpgsql as $$
      declare res jsonb;
      begin
        begin
          res := jsonb_build_object('absentBefore',private.deletion_owner_rows_absent(${literal(a.uid)}::uuid),
            'discard',public.tryon_discard_transient(),'left',(select count(*) from private.tryon_person_photos));
          raise exception 'PHOTO1_ROLLBACK';
        exception when others then
          if sqlerrm<>'PHOTO1_ROLLBACK' then raise; end if;
        end;
        return res;
      end $$;
      select pg_temp.photo1_discard();`);
    requireEvidence(rolled.absentBefore === false && rolled.left === 0 && rolled.discard.code === 'OK' && rolled.discard.photosDeleted >= 2);
    // Rolled back: both photos are still there. The account cascade is the foreign key pinned in the schema test and is
    // exercised by the deletion rehearsal.
    equal(await digest(a), sha(photos.mine));
    equal(await digest(b), sha(photos.other));
  } finally {
    await h.close(before);
  }
}
