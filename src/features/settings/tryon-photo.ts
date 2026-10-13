// TRYON-PHOTO1: the owner's one saved reference photo, as the try-on store handles it. Every read, save and removal is queued
// behind the previous one, so a late reply can never overwrite a newer state. `store.photoGeneration` moves on any save,
// removal, consent write or disposal: bytes fetched under an older generation are dropped unread, so a late fetch cannot
// bring a removed, replaced or withdrawn photo back. The bytes are returned to the caller for one try-on and are never held
// by the store, a cache or storage.
import { TryOnError, type PersonPhotoRefusal } from '../../data/tryon';
import { isUsableBodyPhoto } from '../../images/body-photo-profile';
import type { TryOnStore } from './tryon-store';

function enqueue<T>(store: TryOnStore, work: () => Promise<T>): Promise<T> {
  const run = store.photoChain.then(work, work);
  store.photoChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Reads the saved-photo state. Needs only an approved owner, so it works while try-on is off, paused or past review. */
export function readPersonPhoto(store: TryOnStore): Promise<void> {
  if (store.disposed) return Promise.resolve();
  return enqueue(store, async () => { if (!store.disposed) await readAgain(store); });
}

export type SavePhotoResult = 'saved' | PersonPhotoRefusal | 'failed' | 'stale';
/**
 * Saves or replaces the one photo. An unknown outcome (thrown) is read again before anything is claimed. A save that the
 * server accepted is only reported as `saved` while nothing else changed meanwhile (a removal, a newer save, a consent write
 * such as Turn off, or disposal): otherwise the reply says nothing about what is stored now, so the state is read again
 * and the result is `stale`.
 */
export function savePersonPhoto(store: TryOnStore, photo: { bytes: Uint8Array<ArrayBuffer>; sha256: string }): Promise<SavePhotoResult> {
  store.photoGeneration += 1;
  const generation = store.photoGeneration;
  return enqueue(store, async (): Promise<SavePhotoResult> => {
    if (store.disposed) return 'failed';
    store.updatePhoto({ busy: 'save', error: null });
    try {
      const reply = await store.api.savePersonPhoto(photo);
      if (store.disposed) return 'failed';
      if (reply.kind === 'saved') {
        if (store.photoGeneration !== generation) { store.updatePhoto({ busy: null }); await readAgain(store); return 'stale'; }
        store.updatePhoto({ busy: null, read: 'ready', saved: { bytes: reply.bytes, savedAtMs: reply.savedAtMs } });
        return 'saved';
      }
      store.updatePhoto({ busy: null, error: 'save' });
      return reply.code;
    } catch (error) {
      if (store.disposed) return 'failed';
      store.updatePhoto({ busy: null, error: 'save' });
      if (!(error instanceof TryOnError) || error.code !== 'INVALID_INPUT') await readAgain(store);
      return 'failed';
    }
  });
}

/** Removes the photo. Always allowed for an approved owner. Resolves true once the server confirmed it is gone. */
export function removePersonPhoto(store: TryOnStore): Promise<boolean> {
  store.photoGeneration += 1;
  return enqueue(store, async () => {
    if (store.disposed) return false;
    store.updatePhoto({ busy: 'remove', error: null });
    try {
      await store.api.removePersonPhoto();
      if (store.disposed) return false;
      store.updatePhoto({ busy: null, read: 'ready', saved: null });
      return true;
    } catch {
      if (store.disposed) return false;
      store.updatePhoto({ busy: null, error: 'remove' });
      await readAgain(store);
      return false;
    }
  });
}

// Runs inside the queue. A failed read keeps what was known, so Remove stays offered for a photo already known to exist.
async function readAgain(store: TryOnStore): Promise<void> {
  try {
    const state = await store.api.personPhotoStatus();
    if (store.disposed) return;
    if (state === 'missing') store.updatePhoto({ read: 'missing', saved: null });
    else store.updatePhoto({ read: 'ready', saved: state.kind === 'saved' ? { bytes: state.bytes, savedAtMs: state.savedAtMs } : null });
  } catch {
    store.updatePhoto({ read: 'failed' });
  }
}

export type LoadedPersonPhoto =
  | { kind: 'ready'; bytes: Uint8Array<ArrayBuffer>; sha256: string; savedAtMs: number }
  | { kind: 'none' | 'unusable' | 'failed' | 'stale' };
/**
 * Fetches the saved photo for one explicit try-on, after any queued change. `stale` means a save, removal, consent write,
 * sign-out or owner change happened meanwhile (or `signal` aborted): the bytes are dropped and must not be shown or sent.
 */
export async function loadPersonPhoto(store: TryOnStore, signal: AbortSignal): Promise<LoadedPersonPhoto> {
  const generation = store.photoGeneration;
  await store.photoChain;
  const stale = () => store.disposed || signal.aborted || store.photoGeneration !== generation || !store.api.current();
  if (stale()) return { kind: 'stale' };
  try {
    const photo = await store.api.personPhoto(signal);
    if (stale()) return { kind: 'stale' };
    if (photo.kind === 'code') return { kind: photo.code === 'NOT_FOUND' ? 'none' : 'failed' };
    if (!isUsableBodyPhoto(photo.bytes)) return { kind: 'unusable' };
    return { kind: 'ready', bytes: photo.bytes, sha256: photo.sha256, savedAtMs: photo.savedAtMs };
  } catch {
    return stale() ? { kind: 'stale' } : { kind: 'failed' };
  }
}
