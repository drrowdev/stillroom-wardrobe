import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import {
  parsePersonPhoto, parsePersonPhotoSave, parsePersonPhotoStatus, TryOnClient, TryOnError,
} from '../../src/data/tryon';
import { loadPersonPhoto, readPersonPhoto, removePersonPhoto, saveConfirmed, savePersonPhoto, startPersonPhotoSave } from '../../src/features/settings/tryon-photo';
import { readTryOnStatus, TryOnStore } from '../../src/features/settings/tryon-store';
import { isUsableBodyPhoto } from '../../src/images/body-photo-profile';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';
import { testAccessToken } from './test-token';

const owner = '10000000-0000-4000-8000-0000000000aa';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_test_only', version: 'test' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const PHOTO = flatJpeg({ width: 1024, height: 1280 });
const OTHER = flatJpeg({ width: 1024, height: 1280, colour: [20, 90, 200] });
const SAVED_AT = Date.parse('2026-10-11T10:00:00Z');
const reply = (bytes: Uint8Array = PHOTO, over: Record<string, unknown> = {}) => ({
  code: 'OK', jpegBase64: b64(bytes), sha256: sha(bytes), bytes: bytes.length, savedAtMs: SAVED_AT, ...over,
});

function supabase() {
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const session: Session = { access_token: testAccessToken(owner), refresh_token: 'fictional-unit-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  return client;
}
const scope = () => ({ ownerId: owner, epoch: 1, signal: new AbortController().signal });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('closed saved-photo replies (TRYON-PHOTO1)', () => {
  it('parses the status strictly', () => {
    expect(parsePersonPhotoStatus({ code: 'OK', saved: false })).toEqual({ kind: 'none' });
    expect(parsePersonPhotoStatus({ code: 'OK', saved: true, bytes: 10, savedAtMs: 1 })).toEqual({ kind: 'saved', bytes: 10, savedAtMs: 1 });
    expect(parsePersonPhotoStatus({ code: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
    for (const bad of [{ code: 'OK' }, { code: 'OK', saved: true }, { code: 'OK', saved: true, bytes: 0, savedAtMs: 1 },
      { code: 'OK', saved: true, bytes: 512_001, savedAtMs: 1 }, { code: 'OK', saved: false, bytes: 1 }, { code: 'NOPE' },
      { code: 'OK', saved: true, bytes: 10, savedAtMs: 1, extra: 1 }, null, []]) expect(parsePersonPhotoStatus(bad), JSON.stringify(bad)).toBeNull();
  });
  it('parses the photo only when its length, JPEG start and hash form are right', () => {
    expect(parsePersonPhoto(reply())).toMatchObject({ kind: 'photo', sha256: sha(PHOTO), savedAtMs: SAVED_AT });
    expect(parsePersonPhoto({ code: 'NOT_FOUND' })).toEqual({ kind: 'code', code: 'NOT_FOUND' });
    expect(parsePersonPhoto({ code: 'UNAVAILABLE' })).toEqual({ kind: 'code', code: 'UNAVAILABLE' });
    for (const bad of [reply(PHOTO, { bytes: PHOTO.length + 1 }), reply(PHOTO, { sha256: 'A'.repeat(64) }), reply(PHOTO, { sha256: 'a' }),
      reply(PHOTO, { jpegBase64: 'not base64!' }), reply(new TextEncoder().encode('GIF89a-and-more')), { ...reply(), extra: true },
      { code: 'OK' }, { code: 'OTHER' }]) expect(parsePersonPhoto(bad)).toBeNull();
  });
  it('parses a save reply: a closed refusal code or the saved state', () => {
    expect(parsePersonPhotoSave({ code: 'OK', saved: true, bytes: 5, savedAtMs: 2 })).toEqual({ kind: 'saved', bytes: 5, savedAtMs: 2 });
    for (const code of ['CONSENT_REQUIRED', 'INACTIVE', 'UNCONFIGURED', 'UNAVAILABLE', 'INVALID_INPUT']) {
      expect(parsePersonPhotoSave({ code })).toEqual({ kind: 'refused', code });
    }
    for (const bad of [{ code: 'NOT_FOUND' }, { code: 'OK' }, { code: 'OK', saved: false, bytes: 5, savedAtMs: 2 }, { code: 'INVALID_INPUT', saved: true }]) {
      expect(parsePersonPhotoSave(bad)).toBeNull();
    }
  });
  it('accepts for use only the app\'s own 1024x1280 shape', () => {
    expect(isUsableBodyPhoto(PHOTO)).toBe(true);
    expect(isUsableBodyPhoto(flatJpeg({ width: 1024, height: 1024 }))).toBe(false);
    expect(isUsableBodyPhoto(Uint8Array.from([...PHOTO, 0]))).toBe(false);
    expect(isUsableBodyPhoto(new Uint8Array(0))).toBe(false);
  });
});

describe('the saved-photo client', () => {
  it('reads the state without the results contract header, and treats only a missing function as no photo', async () => {
    const client = new TryOnClient(supabase(), config, scope());
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', saved: false }));
    await expect(client.personPhotoStatus()).resolves.toEqual({ kind: 'none' });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'PGRST202' }, { status: 404 }));
    await expect(client.personPhotoStatus()).resolves.toBe('missing');
    fetcher.mockResolvedValueOnce(Response.json({ message: 'nope' }, { status: 404 }));
    await expect(client.personPhotoStatus()).rejects.toThrow(TryOnError);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'UNAVAILABLE' }));
    await expect(client.personPhotoStatus()).rejects.toThrow(TryOnError);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${config.url}/rest/v1/rpc/tryon_person_photo_status_v1`);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(new Headers(init?.headers).get('X-Stillroom-TryOn-Results-Contract')).toBeNull();
  });
  it('returns the photo only when its bytes match the server hash', async () => {
    const client = new TryOnClient(supabase(), config, scope());
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json(reply()));
    const photo = await client.personPhoto();
    expect(photo).toMatchObject({ kind: 'photo', sha256: sha(PHOTO) });
    if (photo.kind === 'photo') expect(Buffer.from(photo.bytes).equals(Buffer.from(PHOTO))).toBe(true);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'NOT_FOUND' }));
    await expect(client.personPhoto()).resolves.toEqual({ kind: 'code', code: 'NOT_FOUND' });
    // The same bytes under another hash, a tampered byte and a malformed reply are all refused.
    fetcher.mockResolvedValueOnce(Response.json(reply(PHOTO, { sha256: sha(OTHER) })));
    await expect(client.personPhoto()).rejects.toThrow(TryOnError);
    const tampered = Uint8Array.from(PHOTO); tampered[100] = (tampered[100] ?? 0) ^ 1;
    fetcher.mockResolvedValueOnce(Response.json({ ...reply(), jpegBase64: b64(tampered) }));
    await expect(client.personPhoto()).rejects.toThrow(TryOnError);
    fetcher.mockResolvedValueOnce(Response.json({ ...reply(), extra: 1 }));
    await expect(client.personPhoto()).rejects.toThrow(TryOnError);
  });
  it('drops a reply that outlives the session while its hash was being computed', async () => {
    const outer = new AbortController();
    const client = new TryOnClient(supabase(), config, { ownerId: owner, epoch: 1, signal: outer.signal });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(reply())));
    const subtle = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { const result = await subtle(...args); outer.abort(); return result; });
    await expect(client.personPhoto()).rejects.toThrow(TryOnError);
  });
  it('sends the save as base64 with its hash, and the removal with no argument', async () => {
    const client = new TryOnClient(supabase(), config, scope());
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', saved: true, bytes: PHOTO.length, savedAtMs: SAVED_AT }));
    await expect(client.savePersonPhoto({ bytes: PHOTO, sha256: sha(PHOTO) })).resolves.toEqual({ kind: 'saved', bytes: PHOTO.length, savedAtMs: SAVED_AT });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ p_jpeg_base64: b64(PHOTO), p_sha256: sha(PHOTO) });
    fetcher.mockResolvedValueOnce(Response.json({ code: 'CONSENT_REQUIRED' }));
    await expect(client.savePersonPhoto({ bytes: PHOTO, sha256: sha(PHOTO) })).resolves.toEqual({ kind: 'refused', code: 'CONSENT_REQUIRED' });
    await expect(client.savePersonPhoto({ bytes: PHOTO, sha256: 'xyz' })).rejects.toThrow(TryOnError);
    await expect(client.savePersonPhoto({ bytes: new Uint8Array(512_001), sha256: sha(PHOTO) })).rejects.toThrow(TryOnError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'OK', saved: false }));
    await expect(client.removePersonPhoto()).resolves.toBeUndefined();
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({});
    fetcher.mockResolvedValueOnce(Response.json({ code: 'UNAVAILABLE' }));
    await expect(client.removePersonPhoto()).rejects.toThrow(TryOnError);
    fetcher.mockResolvedValueOnce(Response.json({ message: 'down' }, { status: 503 }));
    await expect(client.removePersonPhoto()).rejects.toThrow(TryOnError);
  });
});

// A fake server: one saved photo (or none), replies that can be held, and a log of the calls.
function server(initial: Uint8Array | null = PHOTO) {
  let photo = initial;
  let savedAt = SAVED_AT;
  const holds: Promise<void>[] = [];
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const name = String(url).split('/').pop()!;
    calls.push(name);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (name === 'tryon_person_photo_get_v1') { const hold = holds.shift(); if (hold) await hold; }
    if (name === 'tryon_person_photo_status_v1') return Response.json(photo ? { code: 'OK', saved: true, bytes: photo.length, savedAtMs: savedAt } : { code: 'OK', saved: false });
    if (name === 'tryon_person_photo_get_v1') return Response.json(photo ? reply(photo, { savedAtMs: savedAt }) : { code: 'NOT_FOUND' });
    if (name === 'tryon_person_photo_delete_v1') { photo = null; return Response.json({ code: 'OK', saved: false }); }
    if (name === 'tryon_person_photo_put_v1') {
      photo = Buffer.from(body.p_jpeg_base64!, 'base64'); savedAt += 1000;
      return Response.json({ code: 'OK', saved: true, bytes: photo.length, savedAtMs: savedAt });
    }
    throw new Error(`unexpected ${name}`);
  }));
  return { calls, hold: () => { let release = () => {}; holds.push(new Promise<void>((resolve) => { release = resolve; })); return release; },
    current: () => photo };
}
const newStore = () => new TryOnStore(supabase(), config, scope());

describe('the saved-photo store (ordering and stale bytes)', () => {
  it('reads, saves, replaces and removes through one queue and keeps only the state, never the bytes', async () => {
    const fake = server(null);
    const store = newStore();
    await readPersonPhoto(store);
    expect(store.getPhoto()).toMatchObject({ read: 'ready', saved: null });
    await expect(savePersonPhoto(store, { bytes: PHOTO, sha256: sha(PHOTO) })).resolves.toBe('saved');
    expect(store.getPhoto()).toMatchObject({ read: 'ready', saved: { bytes: PHOTO.length }, busy: null, error: null });
    expect(JSON.stringify(store.getPhoto())).not.toContain(b64(PHOTO).slice(0, 40));
    await expect(savePersonPhoto(store, { bytes: OTHER, sha256: sha(OTHER) })).resolves.toBe('saved');
    expect(Buffer.from(fake.current()!).equals(Buffer.from(OTHER))).toBe(true);
    await expect(removePersonPhoto(store)).resolves.toBe(true);
    expect(store.getPhoto()).toMatchObject({ saved: null, error: null });
    store.dispose();
  });
  it('reads the state again after a lost save or removal and shows a failure, never an assumption', async () => {
    const fake = server(PHOTO);
    const store = newStore();
    await readPersonPhoto(store);
    const original = globalThis.fetch;
    let failNext = true;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      if (failNext && String(url).endsWith('tryon_person_photo_delete_v1')) { failNext = false; return Response.json({ message: 'down' }, { status: 503 }); }
      return original(url, init);
    }));
    await expect(removePersonPhoto(store)).resolves.toBe(false);
    expect(store.getPhoto()).toMatchObject({ error: 'remove', busy: null, read: 'ready', saved: { bytes: PHOTO.length } });
    await expect(removePersonPhoto(store)).resolves.toBe(true);
    expect(store.getPhoto()).toMatchObject({ error: null, saved: null });
    expect(fake.calls.filter((name) => name.endsWith('delete_v1'))).toHaveLength(1);
    store.dispose();
  });
  it('drops a fetch that was in flight when the photo was removed, replaced, withdrawn or the scope ended', async () => {
    const fake = server(PHOTO);
    const store = newStore();
    await readPersonPhoto(store);
    const run = async (change: () => Promise<unknown> | void) => {
      const release = fake.hold();
      const loading = loadPersonPhoto(store, new AbortController().signal);
      await vi.waitFor(() => expect(fake.calls.at(-1)).toBe('tryon_person_photo_get_v1'));
      await change();
      release();
      return loading;
    };
    expect(await run(() => removePersonPhoto(store))).toEqual({ kind: 'stale' });
    await savePersonPhoto(store, { bytes: PHOTO, sha256: sha(PHOTO) });
    expect(await run(() => savePersonPhoto(store, { bytes: OTHER, sha256: sha(OTHER) }))).toEqual({ kind: 'stale' });
    // A consent write bumps the generation (the server removes the photo on withdrawal).
    expect(await run(() => { store.photoGeneration += 1; })).toEqual({ kind: 'stale' });
    expect(await run(() => { store.dispose(); })).toEqual({ kind: 'stale' });
  });
  it('does not report an accepted save as saved when a removal or consent write moved the state before the reply', async () => {
    const fake = server(null);
    const store = newStore();
    await readPersonPhoto(store);
    const original = globalThis.fetch;
    let release = () => {};
    const late = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const reply = await original(url, init);
      if (String(url).endsWith('tryon_person_photo_put_v1')) await late;
      return reply;
    }));
    const saving = savePersonPhoto(store, { bytes: PHOTO, sha256: sha(PHOTO) });
    await vi.waitFor(() => expect(fake.calls).toContain('tryon_person_photo_put_v1'));
    // Turn off moves the generation (and the server removes the photo) while the accepted reply is still on its way.
    store.photoGeneration += 1;
    release();
    await expect(saving).resolves.toBe('stale');
    expect(store.getPhoto()).toMatchObject({ busy: null, error: null });
    expect(fake.calls.at(-1)).toBe('tryon_person_photo_status_v1');
    store.dispose();
  });
  it('never stamps an earlier successful save with a later generation: a withdrawal landing after the store check blocks the confirmation', async () => {
    server(null);
    const store = newStore();
    await readPersonPhoto(store);
    const attempt = startPersonPhotoSave(store, { bytes: PHOTO, sha256: sha(PHOTO) });
    expect(attempt.generation).toBe(store.photoGeneration);
    // The consent withdrawal completes in the interval between the store accepting the reply and the consumer continuing.
    const stop = store.subscribePhoto(() => { if (store.getPhoto().saved) { stop(); store.photoGeneration += 1; } });
    // The state read that follows fails, so the retained metadata alone cannot tell the withdrawal happened.
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('tryon_person_photo_status_v1')
      ? Response.json({ message: 'down' }, { status: 503 }) : original(url, init)));
    const result = await attempt.result;
    expect(result).toBe('saved');
    expect(store.photoGeneration).toBeGreaterThan(attempt.generation);
    expect(saveConfirmed(store, attempt, result)).toBe(false);
    store.dispose();
  });
  it('confirms a save only while its own generation is current', async () => {
    server(null);
    const store = newStore();
    await readPersonPhoto(store);
    const attempt = startPersonPhotoSave(store, { bytes: PHOTO, sha256: sha(PHOTO) });
    const result = await attempt.result;
    expect(saveConfirmed(store, attempt, result)).toBe(true);
    expect(saveConfirmed(store, attempt, 'failed')).toBe(false);
    store.photoGeneration += 1;
    expect(saveConfirmed(store, attempt, result)).toBe(false);
    store.dispose();
  });
  it('drops a fetch whose caller went away, and returns usable bytes otherwise', async () => {
    server(PHOTO);
    const store = newStore();
    const aborted = new AbortController();
    const result = loadPersonPhoto(store, aborted.signal);
    aborted.abort();
    expect(await result).toEqual({ kind: 'stale' });
    const loaded = await loadPersonPhoto(store, new AbortController().signal);
    expect(loaded).toMatchObject({ kind: 'ready', sha256: sha(PHOTO), savedAtMs: SAVED_AT });
    store.dispose();
  });
  it('names a missing, unusable or unreadable saved photo instead of using it', async () => {
    const none = server(null);
    const store = newStore();
    expect(await loadPersonPhoto(store, new AbortController().signal)).toEqual({ kind: 'none' });
    expect(none.calls).toContain('tryon_person_photo_get_v1');
    store.dispose();
    server(flatJpeg({ width: 1024, height: 1024 }));
    const second = newStore();
    expect(await loadPersonPhoto(second, new AbortController().signal)).toEqual({ kind: 'unusable' });
    second.dispose();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ message: 'down' }, { status: 503 })));
    const third = newStore();
    expect(await loadPersonPhoto(third, new AbortController().signal)).toEqual({ kind: 'failed' });
    third.dispose();
  });
  it('clears the photo state with the scope and reads it again after a consent write', async () => {
    server(PHOTO);
    const store = newStore();
    await readPersonPhoto(store);
    expect(store.getPhoto().saved).not.toBeNull();
    store.dispose();
    expect(store.getPhoto()).toMatchObject({ read: 'unknown', saved: null, busy: null, error: null });
    // After disposal nothing is read, saved or removed.
    const fake = server(PHOTO);
    await readPersonPhoto(store);
    await expect(savePersonPhoto(store, { bytes: PHOTO, sha256: sha(PHOTO) })).resolves.toBe('failed');
    await expect(removePersonPhoto(store)).resolves.toBe(false);
    expect(fake.calls).toEqual([]);
  });
  it('keeps the status read independent: a failed photo read leaves the try-on status untouched', async () => {
    const store = newStore();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => String(url).endsWith('tryon_status')
      ? Response.json({ code: 'UNAVAILABLE' }) : Response.json({ message: 'down' }, { status: 503 })));
    await readPersonPhoto(store);
    expect(store.getPhoto().read).toBe('failed');
    await readTryOnStatus(store, 'active');
    expect(store.get().read.kind).toBe('ready');
    store.dispose();
  });
});
